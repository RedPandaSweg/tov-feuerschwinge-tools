import { LEGACY_MODULE_ID, LEGACY_MODULE_SCOPE, MODULE_ID, modulePath } from "./core/constants.mjs";

const FLAG = "activityChain";
const CHILD_FLAG = "activityChainChild";
const WORKFLOW_FLAG = "activityWorkflow";
const MAX_DEPTH = 20;
const activeTransitions = new Set();
let installed = false;

const TRIGGERS = Object.freeze([
  "activation", "attackHit", "attackMiss", "attackCritical",
  "checkSuccess", "checkFailure", "saveSuccess", "saveFailure", "damageRolled"
]);
const EXECUTIONS = Object.freeze(["automatic", "prompt"]);
const TARGET_MODES = Object.freeze(["inherit", "successful", "failed", "self", "current"]);

function parseRules(activity) {
  const stored = [MODULE_ID, LEGACY_MODULE_SCOPE, LEGACY_MODULE_ID]
    .map(scope => foundry.utils.getProperty(activity, `flags.${scope}.${FLAG}`))
    .find(value => Array.isArray(value) || (typeof value === "string" && value.trim()));
  if (Array.isArray(stored)) return stored;
  if (typeof stored !== "string" || !stored.trim()) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

export function activityChainRules(activity) {
  return parseRules(activity).map(rule => ({
    trigger: "activation",
    activityId: String(rule?.activityId ?? ""),
    execution: EXECUTIONS.includes(rule?.execution) ? rule.execution : "automatic",
    targets: TARGET_MODES.includes(rule?.targets) ? rule.targets : "inherit"
  })).filter(rule => rule.activityId && rule.activityId !== activity.id);
}

export function isFollowUpActivity(activity) {
  return [MODULE_ID, LEGACY_MODULE_SCOPE, LEGACY_MODULE_ID]
    .some(scope => foundry.utils.getProperty(activity, `flags.${scope}.${CHILD_FLAG}`) === true);
}

function liveActivity(activity) {
  const liveItem = activity?.actor?.items?.get(activity.item?.id) ?? activity?.item;
  return liveItem?.system?.activities?.get(activity.id) ?? activity;
}

function option(value, key) {
  return { value, label: game.i18n.localize(`TOV.ActivityChain.${key}.${value}`) };
}

function activityOptions(activity) {
  return [
    { value: "", label: game.i18n.localize("TOV.ActivityChain.ActivityNone") },
    ...[...(activity.item?.system?.activities ?? [])]
      .filter(candidate => candidate.id !== activity.id)
      .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang))
      .map(candidate => ({ value: candidate.id, label: `${candidate.name} (${candidate.type})` }))
  ];
}

async function chooseActivityType(item) {
  const options = Object.entries(CONFIG.Activity.types)
    .filter(([type, configuration]) => type !== CONST.BASE_DOCUMENT_TYPE && configuration?.documentClass)
    .map(([type, configuration]) => {
      const label = game.i18n.localize(configuration.documentClass.metadata.title);
      return { type, label };
    })
    .sort((left, right) => left.label.localeCompare(right.label, game.i18n.lang));
  return foundry.applications.api.DialogV2.prompt({
    window: { title: game.i18n.localize("TOV.ActivityChain.Create") },
    content: `<div class="standard-form"><label>${game.i18n.localize("TOV.ActivityChain.Activity")}<select name="type">${options
      .map(option => `<option value="${foundry.utils.escapeHTML(option.type)}">${foundry.utils.escapeHTML(option.label)}</option>`)
      .join("")}</select></label></div>`,
    ok: {
      label: game.i18n.localize("TOV.ActivityChain.Create"),
      callback: (_event, button) => new FormData(button.form).get("type")
    },
    rejectClose: false
  });
}

function workflowFromMessage(message) {
  return message?.getFlag?.(MODULE_ID, WORKFLOW_FLAG) ?? null;
}

function workflowFor(activity, message, inherited = null) {
  const existing = inherited ?? workflowFromMessage(message);
  if (existing) return foundry.utils.deepClone(existing);
  return {
    id: foundry.utils.randomID(),
    root: activity.uuid,
    depth: 0,
    history: [],
    targets: message?.getFlag?.(game.system.id, "targets") ?? []
  };
}

function rollMessage(rolls) {
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  return roll?.message ?? (roll?.messageId ? game.messages.get(roll.messageId) : null);
}

function originatingMessage(rolls) {
  const message = rollMessage(rolls);
  const originId = message?.getFlag?.(game.system.id, "originatingMessage");
  return originId ? game.messages.get(originId) : message;
}

async function activityFromMessage(message) {
  const uuid = message?.getFlag?.(game.system.id, "activity.uuid");
  return uuid ? fromUuid(uuid) : null;
}

function rollOutcome(rolls) {
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!roll) return { success: null, critical: false };
  const success = typeof roll.isSuccess === "boolean"
    ? roll.isSuccess
    : typeof roll.options?.success === "boolean"
      ? roll.options.success
      : Number.isFinite(Number(roll.options?.target))
        ? Number(roll.total) >= Number(roll.options.target)
        : null;
  const critical = Boolean(roll.isCritical || roll.isCriticalSuccess);
  return { success, critical };
}

async function handleAttackRoll(activity, rolls) {
  if (!activity) return;
  const message = originatingMessage(rolls);
  const workflow = workflowFor(activity, message);
  const roll = Array.isArray(rolls) ? rolls[0] : rolls;
  if (!roll) return;
  const targets = workflow.targets ?? [];
  if (!targets.length) return;
  const criticalSuccess = Boolean(roll.isCriticalSuccess);
  const criticalFailure = Boolean(roll.isCriticalFailure);
  workflow.successfulTargets = targets.filter(target => (
    criticalSuccess || (!criticalFailure && Number.isFinite(Number(target.ac)) && Number(roll.total) >= Number(target.ac))
  ));
  workflow.failedTargets = targets.filter(target => !workflow.successfulTargets.some(hit => hit.uuid === target.uuid));
  if (criticalSuccess && workflow.successfulTargets.length) {
    await runTransitions(activity, "attackCritical", { message, workflow });
  }
  if (workflow.successfulTargets.length) await runTransitions(activity, "attackHit", { message, workflow });
  if (workflow.failedTargets.length) await runTransitions(activity, "attackMiss", { message, workflow });
}

function targetDescriptors(activity, workflow, mode) {
  if (mode === "current") return undefined;
  if (mode === "self") {
    const token = activity.getUsageToken?.();
    return token ? [{ uuid: token.uuid, actorUuid: activity.actor?.uuid }] : [];
  }
  if (mode === "successful") return workflow.successfulTargets ?? workflow.targets ?? [];
  if (mode === "failed") return workflow.failedTargets ?? workflow.targets ?? [];
  return workflow.targets ?? [];
}

async function confirmTransition(source, target) {
  return foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("TOV.ActivityChain.PromptTitle") },
    content: `<p>${game.i18n.format("TOV.ActivityChain.Prompt", {
      source: foundry.utils.escapeHTML(source.name),
      target: foundry.utils.escapeHTML(target.name)
    })}</p>`
  });
}

async function runTransitions(activity, trigger, { message = null, workflow = null } = {}) {
  activity = liveActivity(activity);
  const rules = activityChainRules(activity).filter(rule => rule.trigger === trigger);
  if (!rules.length) return;
  workflow = workflowFor(activity, message, workflow);
  if (workflow.depth >= MAX_DEPTH) {
    ui.notifications.error(game.i18n.localize("TOV.ActivityChain.MaxDepth"));
    return;
  }

  for (const rule of rules) {
    const target = activity.item.system.activities.get(rule.activityId);
    if (!target) {
      ui.notifications.warn(game.i18n.format("TOV.ActivityChain.Missing", { activity: rule.activityId }));
      continue;
    }
    const edge = `${workflow.id}:${activity.uuid}:${trigger}:${target.uuid}`;
    if (activeTransitions.has(edge) || workflow.history.includes(target.uuid)) {
      ui.notifications.warn(game.i18n.localize("TOV.ActivityChain.Cycle"));
      continue;
    }
    if (rule.execution === "prompt" && !await confirmTransition(activity, target)) continue;

    const next = foundry.utils.deepClone(workflow);
    next.depth += 1;
    next.history.push(activity.uuid);
    activeTransitions.add(edge);
    try {
      const targets = targetDescriptors(activity, next, rule.targets);
      await target.activate({
        cause: { activity: activity.relativeUUID },
        consume: { action: false, resources: true, spellSlot: true },
        targets,
        [WORKFLOW_FLAG]: next
      }, {}, {
        data: { flags: { [MODULE_ID]: { [WORKFLOW_FLAG]: next } } }
      });
    } finally {
      activeTransitions.delete(edge);
    }
  }
}

async function handleRoll(activity, rolls, successTrigger, failureTrigger, {
  resultActor = null
} = {}) {
  if (!activity) return;
  const message = originatingMessage(rolls);
  const workflow = workflowFor(activity, message);
  const outcome = rollOutcome(rolls);
  const resultTargets = resultActor
    ? (workflow.targets ?? []).filter(target => (
      target.uuid === resultActor.uuid || target.actorUuid === resultActor.uuid || target.actor?.uuid === resultActor.uuid
    ))
    : workflow.targets ?? [];
  if (outcome.success === true) workflow.successfulTargets = resultTargets;
  if (outcome.success === false) workflow.failedTargets = resultTargets;
  if (outcome.success === true) await runTransitions(activity, successTrigger, { message, workflow });
  else if (outcome.success === false) await runTransitions(activity, failureTrigger, { message, workflow });
}

function installSheetPart() {
  const prepared = new Set();
  for (const configuration of Object.values(CONFIG.Activity.types)) {
    const Original = configuration.sheetClasses?.config;
    if (!Original || prepared.has(Original)) continue;
    prepared.add(Original);
    class ChainedActivitySheet extends Original {
      static PARTS = {
        ...Original.PARTS,
        chain: { template: modulePath("templates/activity-chain.hbs") }
      };

      _getTabs() {
        const tabs = super._getTabs();
        tabs.chain = {
          id: "chain",
          group: "sheet",
          icon: "fa-solid fa-link",
          label: "TOV.ActivityChain.Title",
          active: this.tabGroups.sheet === "chain",
          cssClass: this.tabGroups.sheet === "chain" ? "active" : ""
        };
        return tabs;
      }

      async _preparePartContext(partId, context, options) {
        context = await super._preparePartContext(partId, context, options);
        if (partId !== "chain") return context;
        context.tab = context.tabs.chain;
        context.chainRules = activityChainRules(this.activity);
        context.chainJson = JSON.stringify(context.chainRules);
        context.chainEditorRules = context.chainRules.length ? context.chainRules : [{}];
        context.chainActivityOptions = activityOptions(this.activity);
        context.chainExecutionOptions = EXECUTIONS.map(value => option(value, "Execution"));
        context.chainTargetOptions = TARGET_MODES.map(value => option(value, "Targets"));
        return context;
      }

      _onRender(context, options) {
        super._onRender(context, options);
        const editor = this.element.querySelector("[data-tov-chain-editor]");
        if (!editor) return;
        let pendingSave = Promise.resolve();
        const appendEmptyRow = () => {
          const list = editor.querySelector("[data-tov-chain-rules]");
          const row = list.querySelector("[data-chain-index]")?.cloneNode(true);
          if (!row) return null;
          row.querySelectorAll("select").forEach(select => { select.selectedIndex = 0; });
          list.append(row);
          return row;
        };
        const sync = ({ persist = false } = {}) => {
          const rules = [...editor.querySelectorAll("[data-chain-index]")].map(row => Object.fromEntries(
            [...row.querySelectorAll("[data-chain-field]")].map(input => [input.dataset.chainField, input.value])
          )).filter(rule => rule.activityId);
          editor.querySelector("[data-tov-chain-value]").value = JSON.stringify(rules);
          if (persist) {
            pendingSave = pendingSave
              .catch(() => {})
              .then(async () => {
                const followUps = rules
                  .map(rule => this.activity.item.system.activities.get(rule.activityId))
                  .filter(activity => activity && !isFollowUpActivity(activity));
                await Promise.all(followUps.map(activity => activity.update({
                  [`flags.${MODULE_ID}.${CHILD_FLAG}`]: true
                })));
                await this.activity.update({
                  [`flags.${MODULE_ID}.${FLAG}`]: JSON.stringify(rules)
                });
              })
              .catch(error => {
                console.error(`${MODULE_ID} | Failed to save Activity Chain.`, error);
                ui.notifications.error("Die Folge-Activity konnte nicht gespeichert werden.");
              });
          }
          return pendingSave;
        };
        editor.addEventListener("change", event => {
          event.stopPropagation();
          sync({ persist: true });
        });
        editor.addEventListener("click", async event => {
          const button = event.target.closest("[data-action]");
          if (!button) return;
          event.preventDefault();
          event.stopPropagation();
          const row = button.closest("[data-chain-index]");
          const select = row?.querySelector('[data-chain-field="activityId"]');
          const followUp = select?.value ? this.activity.item.system.activities.get(select.value) : null;
          if (button.dataset.action === "deleteChainRule") {
            row?.remove();
            await sync({ persist: true });
          } else if (button.dataset.action === "addChainRule") {
            if (!appendEmptyRow()) {
              ui.notifications.info(game.i18n.localize("TOV.ActivityChain.SaveThenAdd"));
            }
          } else if (button.dataset.action === "editChainActivity") {
            followUp?.sheet?.render(true);
          } else if (button.dataset.action === "createChainActivity") {
            const type = await chooseActivityType(this.activity.item);
            if (!type) return;
            const ActivityClass = CONFIG.Activity.types[type]?.documentClass;
            const name = ActivityClass ? game.i18n.localize(ActivityClass.metadata.title) : type;
            const targetRow = select?.value ? appendEmptyRow() : row;
            const targetSelect = targetRow?.querySelector('[data-chain-field="activityId"]');
            const [created] = await this.activity.item.createEmbeddedDocuments("Activity", [{
              type,
              name,
              flags: { [MODULE_ID]: { [CHILD_FLAG]: true } }
            }], { render: false });
            if (!created || !targetSelect) return;
            targetSelect.append(new Option(`${created.name} (${created.type})`, created.id, true, true));
            targetSelect.value = created.id;
            await sync({ persist: true });
            created.sheet?.render(true);
          } else if (button.dataset.action === "deleteChainActivity") {
            if (!followUp) return;
            const confirmed = await foundry.applications.api.DialogV2.confirm({
              window: { title: game.i18n.localize("TOV.ActivityChain.DeleteActivity") },
              content: `<p>${game.i18n.format("TOV.ActivityChain.DeleteActivityConfirm", {
                activity: foundry.utils.escapeHTML(followUp.name)
              })}</p>`
            });
            if (!confirmed) return;
            row?.remove();
            await sync({ persist: true });
            await this.activity.item.deleteEmbeddedDocuments("Activity", [followUp.id]);
          }
        });
      }
    }
    for (const candidate of Object.values(CONFIG.Activity.types)) {
      if (candidate.sheetClasses?.config === Original) candidate.sheetClasses.config = ChainedActivitySheet;
    }
  }
}

function installItemSheetFilter() {
  const prototype = BlackFlag?.applications?.item?.BaseItemSheet?.prototype;
  if (!prototype || prototype.__tovfActivityChainFilter) return;
  const original = prototype._prepareDetailsContext;
  prototype._prepareDetailsContext = async function(context, options) {
    context = await original.call(this, context, options);
    if (Array.isArray(context.activities)) {
      context.activities = context.activities.filter(entry => {
        const activity = this.item.system.activities.get(entry.id) ?? entry.activity ?? entry;
        return !isFollowUpActivity(activity);
      });
    }
    return context;
  };
  Object.defineProperty(prototype, "__tovfActivityChainFilter", { value: true });
}

export function installActivityChaining() {
  if (installed || game.system.id !== "black-flag") return;
  installed = true;
  queueMicrotask(installSheetPart);
  installItemSheetFilter();

  Hooks.on("blackFlag.postActivateActivity", (activity, config, results) => {
    const inherited = config?.[WORKFLOW_FLAG] ?? workflowFromMessage(results?.message);
    void runTransitions(activity, "activation", { message: results?.message, workflow: inherited });
  });
  Hooks.on("blackFlag.postRollAttack", (rolls, { subject } = {}) => {
    void handleAttackRoll(subject, rolls);
  });
  Hooks.on("blackFlag.postRollDamage", (rolls, { subject } = {}) => {
    void runTransitions(subject, "damageRolled", { message: originatingMessage(rolls) });
  });
  for (const hook of ["blackFlag.postRollAbilityCheck", "blackFlag.postRollSkill", "blackFlag.postRollTool"]) {
    Hooks.on(hook, rolls => void (async () => {
      const message = originatingMessage(rolls);
      await handleRoll(await activityFromMessage(message), rolls, "checkSuccess", "checkFailure");
    })());
  }
  Hooks.on("blackFlag.postRollAbilitySave", (rolls, { subject } = {}) => void (async () => {
    const message = originatingMessage(rolls);
    await handleRoll(await activityFromMessage(message), rolls, "saveSuccess", "saveFailure", {
      resultActor: subject
    });
  })());
}

export const activityChainingApi = { runTransitions };
