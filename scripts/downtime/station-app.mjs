import { DowntimeService } from "./downtime-service.mjs";
import { GoldService } from "./gold-service.mjs";
import { ProjectService } from "./project-service.mjs";
import { ResourceService } from "./resource-service.mjs";
import { RewardService } from "./reward-service.mjs";
import { StationConfigApp } from "./station-config-app.mjs";
import { StationEngine } from "./station-engine.mjs";
import { SharedProjectService } from "./shared-project-service.mjs";
import { sharedProjectAction } from "./shared-project-socket.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";
import {
  actorKnowsSpell,
  getActiveCrafter,
  categoriesMatch,
  getStationData,
  hasRequiredTool,
  isRecipeItem,
  recipeData,
  round
} from "./utils.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function lastResultView(result, actorValueEnabled, actorValueLabel, showRewardSummary = true) {
  if (!result?.calculation) return null;
  const calculation = result.calculation;
  const parts = [];
  const addPart = (key, value, neutral, label) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number === neutral) return;
    parts.push({
      label: label ?? game.i18n.localize(`DOWNTIME_MANAGER.Calculation.${key}`),
      explanation: game.i18n.localize(`DOWNTIME_MANAGER.Calculation.${key}Help`),
      value: number,
      operation: neutral === 0 ? "add" : "multiply"
    });
  };
  addPart("BaseProgress", calculation.baseProgress, 0);
  addPart("RollAddition", calculation.rollAddition, 0);
  addPart("ActorValueAddition", calculation.flagAddition, 0, game.i18n.format(
    "DOWNTIME_MANAGER.Calculation.ActorValueAdditionLabel",
    { label: actorValueLabel }
  ));
  addPart("LevelAddition", calculation.levelAddition, 0);
  addPart("ProficiencyAddition", calculation.proficiencyAddition, 0);
  addPart("CheckProficiencyAddition", calculation.checkProficiencyAddition, 0);
  addPart("RollMultiplier", calculation.rollMultiplier, 1);
  addPart("ActorValueMultiplier", calculation.flagMultiplier, 1, game.i18n.format(
    "DOWNTIME_MANAGER.Calculation.ActorValueMultiplierLabel",
    { label: actorValueLabel }
  ));
  for (const modifier of calculation.modifierDetails ?? []) {
    const multiply = modifier.operation === "multiply";
    addPart(
      multiply ? "OtherMultipliers" : "Additional",
      modifier.value,
      multiply ? 1 : 0,
      modifier.label || game.i18n.localize(`DOWNTIME_MANAGER.Calculation.${multiply ? "OtherMultipliers" : "Additional"}`)
    );
  }
  const additions = parts.filter(part => part.operation === "add");
  const multipliers = parts.filter(part => part.operation === "multiply");
  const additiveFormula = additions.length
    ? additions.map((part, index) => {
      if (!index) return String(part.value);
      return part.value < 0 ? `− ${Math.abs(part.value)}` : `+ ${part.value}`;
    }).join(" ")
    : "0";
  const multiplierFormula = multipliers.map(part => ` × ${part.value}`).join("");
  const actorValueChange = Number(result.actorValueChange ?? 0);
  return {
    downtime: calculation.downtime,
    rollTotal: result.total,
    natural: result.natural,
    hasRoll: Number.isFinite(Number(result.total)),
    label: result.label,
    progress: calculation.progress,
    rewards: Array.isArray(result.rewards) ? result.rewards : [],
    formula: calculation.bonusOnly
      ? `${calculation.rollAddition} + ${calculation.intervalBaseProgress} × (${calculation.rollMultiplier} − 1) = ${calculation.progress}`
      : `${calculation.downtime} × (${additiveFormula})${multiplierFormula} = ${calculation.progress}`,
    parts,
    actorValueEnabled,
    hasActorValueResult: Number.isFinite(Number(result.actorValueAfter)),
    actorValueBefore: result.actorValueBefore,
    actorValueAfter: result.actorValueAfter,
    actorValueChange: actorValueChange > 0 ? `+${actorValueChange}` : actorValueChange,
    showRewardSummary
  };
}
function sharedPayload(app, target, actor) { return { stationUuid: app.stationActor.uuid, projectUuid: target.dataset.uuid, actorUuid: actor.uuid }; }

const KNOWN_ITEM_TYPES = new Set([
  "ammunition", "armor", "consumable", "container", "currency", "gear",
  "script", "siege", "sundry", "tool", "vehicle", "weapon"
]);
const KNOWN_ITEM_SUBTYPES = new Set(["food", "poison", "potion", "scroll"]);

function humanize(value) {
  const text = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return text ? text.replace(/\b\w/g, letter => letter.toUpperCase()) : "";
}

function configuredLabel(key, fallback) {
  const configured = CONFIG.Item?.typeLabels?.[key];
  if (configured) {
    const localized = game.i18n.localize(configured);
    if (localized && localized !== configured) return localized;
  }
  return fallback;
}

function projectClassification(item) {
  if (!item || item.documentName !== "Item") {
    return {
      type: "project",
      typeLabel: game.i18n.localize("DOWNTIME_MANAGER.Catalog.OtherProjects"),
      subtype: "",
      subtypeLabel: ""
    };
  }
  const type = String(item.type || "other");
  const typeFallback = KNOWN_ITEM_TYPES.has(type)
    ? game.i18n.localize(`DOWNTIME_MANAGER.Catalog.Types.${type}`)
    : humanize(type) || game.i18n.localize("DOWNTIME_MANAGER.Catalog.Types.sundry");
  const typeLabel = configuredLabel(type, typeFallback);
  const subtypeValues = [
    foundry.utils.getProperty(item, "system.type.base"),
    foundry.utils.getProperty(item, "system.type.category"),
    foundry.utils.getProperty(item, "system.type.value")
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  const subtype = subtypeValues[0] || "";
  return {
    type,
    typeLabel,
    subtype,
    subtypeLabel: KNOWN_ITEM_SUBTYPES.has(subtype)
      ? game.i18n.localize(`DOWNTIME_MANAGER.Catalog.Subtypes.${subtype}`)
      : humanize(subtype)
  };
}

export class StationApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-station-{id}",
    classes: ["downtime-manager", "station-app"],
    position: { width: 700, height: 800 },
    window: { title: "DOWNTIME_MANAGER.Station.Title", resizable: true },
    actions: {
      start: StationApp.#start,
      cancel: StationApp.#cancel,
      invest: StationApp.#invest,
      roll: StationApp.#roll,
      completionRoll: StationApp.#completionRoll,
      configure: StationApp.#configure,
      sharedStart: StationApp.#sharedStart,
      sharedJoin: StationApp.#sharedJoin,
      sharedLeave: StationApp.#sharedLeave,
      sharedCancel: StationApp.#sharedCancel,
      sharedInvest: StationApp.#sharedInvest,
      sharedRoll: StationApp.#sharedRoll,
      sharedCompletionRoll: StationApp.#sharedCompletionRoll
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/station.hbs" }
  };

  constructor(stationActor, options = {}) {
    super({ ...options, id: `downtime-manager-station-${stationActor.id}` });
    this.stationActor = stationActor;
    this._catalogState = { search: "", type: "", subtype: "", status: "all" };
    this._documentUpdateHooks = [
      ["updateActor", Hooks.on("updateActor", actor => {
        const crafter = getActiveCrafter();
        if (this.rendered && (actor.id === this.stationActor.id || actor.id === crafter?.id)) {
          this.render();
        }
      })],
      ...["createItem", "updateItem", "deleteItem"].map(hook => [
        hook,
        Hooks.on(hook, item => {
          const crafter = getActiveCrafter();
          if (this.rendered && item.parent?.id === crafter?.id) this.render();
        })
      ])
    ];
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const catalog = this.element.querySelector("[data-project-catalog]");
    if (!catalog) return;
    const search = catalog.querySelector('[data-project-filter="search"]');
    const type = catalog.querySelector('[data-project-filter="type"]');
    const subtype = catalog.querySelector('[data-project-filter="subtype"]');
    const status = catalog.querySelector('[data-project-filter="status"]');
    search.value = this._catalogState.search;
    type.value = this._catalogState.type;
    status.value = this._catalogState.status;

    const apply = ({ rebuildSubtypes = false, selectedSubtype = subtype.value } = {}) => {
      this._catalogState = {
        search: search.value.trim().toLocaleLowerCase(),
        type: type.value,
        subtype: selectedSubtype,
        status: status.value
      };
      if (rebuildSubtypes) {
        const allowedSubtypes = new Map();
        for (const project of catalog.querySelectorAll("[data-project-entry]")) {
          if (!type.value || project.dataset.projectType === type.value) {
            const key = project.dataset.projectSubtype;
            if (key) allowedSubtypes.set(key, project.dataset.projectSubtypeLabel);
          }
        }
        subtype.replaceChildren(new Option(game.i18n.localize("DOWNTIME_MANAGER.Catalog.AllSubtypes"), ""));
        for (const [value, label] of [...allowedSubtypes].sort((a, b) => a[1].localeCompare(b[1]))) {
          subtype.add(new Option(label, value));
        }
        subtype.value = allowedSubtypes.has(selectedSubtype) ? selectedSubtype : "";
        this._catalogState.subtype = subtype.value;
      }

      let visible = 0;
      for (const project of catalog.querySelectorAll("[data-project-entry]")) {
        const matchesSearch = !this._catalogState.search ||
          project.dataset.projectSearch.includes(this._catalogState.search);
        const matchesType = !this._catalogState.type ||
          project.dataset.projectType === this._catalogState.type;
        const matchesSubtype = !this._catalogState.subtype ||
          project.dataset.projectSubtype === this._catalogState.subtype;
        const matchesStatus = this._catalogState.status === "all" ||
          project.dataset.projectStatus === this._catalogState.status;
        project.hidden = !(matchesSearch && matchesType && matchesSubtype && matchesStatus);
        if (!project.hidden) visible++;
      }
      catalog.querySelector("[data-project-empty]").hidden = visible > 0;
    };
    search.addEventListener("input", apply);
    type.addEventListener("change", () => apply({ rebuildSubtypes: true, selectedSubtype: "" }));
    subtype.addEventListener("change", apply);
    status.addEventListener("change", apply);
    apply({ rebuildSubtypes: true, selectedSubtype: this._catalogState.subtype });
  }

  async close(options = {}) {
    for (const [hook, id] of this._documentUpdateHooks ?? []) {
      Hooks.off(hook, id);
    }
    this._documentUpdateHooks = [];
    return super.close(options);
  }

  async _prepareContext() {
    const actor = getActiveCrafter();
    const station = getStationData(this.stationActor);
    const adapter = getSystemAdapter();
    const base = {
      station,
      stationName: station.displayName || this.stationActor.name,
      stationDescription: station.description,
      isGM: game.user.isGM,
      disabled: !station.enabled
    };
    if (!actor) return { ...base, noActor: true };

    const sources = new Map();
    for (const uuid of station.recipes) sources.set(uuid, { uuid, personal: false });
    for (const item of actor.items.filter(isRecipeItem)) {
      if (sources.has(item.uuid)) continue;
      const definition = recipeData(item, { sourceUuid: item.uuid });
      if (!categoriesMatch(station.categories, definition.categories)) continue;
      sources.set(item.uuid, { uuid: item.uuid, item, personal: true });
    }

    const projects = [];
    for (const source of sources.values()) {
      const item = source.item ?? await fromUuid(source.uuid);
      if (!item || item.documentName !== "Item") continue;
      const definition = recipeData(item, { sourceUuid: source.uuid });
      const resultUuid = definition.resultUuid || definition.rewards?.[0]?.uuid || "";
      const resultItem = definition.isCustom && resultUuid
        ? await fromUuid(resultUuid).catch(() => null)
        : item;
      const knownSpell = actorKnowsSpell(actor, resultItem);
      const classification = projectClassification(resultItem);
      const description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        String(definition.description ?? ""),
        { async: true, secrets: item.isOwner, relativeTo: item }
      );
      const state = ProjectService.findState(actor, this.stationActor, source.uuid);
      const sharedState = definition.collaborative ? SharedProjectService.find(this.stationActor, source.uuid) : null;
      const rollInterval = Math.max(0.000001, Number(station.rollInterval) || 1);
      if (state?.pendingRoll && Number(state.intervalProgress ?? 0) < rollInterval - 1e-9) state.pendingRoll = false;
      if (sharedState?.pendingRoll && Number(sharedState.intervalProgress ?? 0) < rollInterval - 1e-9) sharedState.pendingRoll = false;
      const sharedJoined = Boolean(sharedState?.participantUuids?.includes(actor.uuid));
      const sharedParticipants = [];
      for (const uuid of sharedState?.participantUuids ?? []) {
        const participant = await fromUuid(uuid);
        sharedParticipants.push({ uuid, name: participant?.name ?? uuid, leader: uuid === sharedState.leaderUuid, contribution: sharedState.contributions?.[uuid] ?? { downtime: 0, progress: 0 } });
      }
      const checks = StationEngine.checkDefinitions(
        StationEngine.availableChecks(station, definition)
      );
      const checkSelectionRequired = Boolean(station.progressSources?.checkProficiency?.enabled);
      const stationToolOk = hasRequiredTool(actor, station.requiredTool);
      const projectToolsOk = (definition.requiredTools ?? []).every(tool => hasRequiredTool(actor, tool));
      const startItemsOk = await ResourceService.has(actor, definition.ingredients ?? []);
      const startGoldOk = !adapter.capabilities.currency || GoldService.getGold(actor) + 1e-9 >= Number(definition.goldCost ?? 0);
      const projectCurrencyCost = adapter.capabilities.currency
        ? await ResourceService.currencyCost(definition.ingredients ?? [])
        : 0;
      const displayedGoldCost = round(Number(definition.goldCost ?? 0) + projectCurrencyCost, 4);
      const progress = Number(state?.progress ?? 0);
      const requiredProgress = Number(state?.requiredProgress ?? definition.requiredProgress);
      const maxInvestment = state
        ? StationEngine.maxInvestment(station, state, DowntimeService.get(actor))
        : 0;
      const sharedMaxInvestment = sharedState && sharedJoined
        ? StationEngine.maxInvestment(station, sharedState, DowntimeService.get(actor))
        : 0;
      const active = Boolean(state && !state.completed && state.active !== false);
      const paused = Boolean(state && !state.completed && state.active === false);
      const projectStatus = active || paused || sharedState
        ? "active"
        : state?.completed ? "completed" : "available";
      projects.push({
        uuid: source.uuid,
        name: item.name,
        img: item.img,
        description,
        goldCost: displayedGoldCost,
        showGoldCost: adapter.capabilities.currency && displayedGoldCost > 0,
        personal: source.personal,
        repeatable: definition.repeatable,
        knownSpell,
        classification,
        projectStatus,
        expanded: projectStatus === "active",
        searchText: `${item.name} ${definition.description ?? ""} ${classification.typeLabel} ${classification.subtypeLabel}`.toLocaleLowerCase(),
        collaborative: Boolean(definition.collaborative),
        sharedState,
        sharedJoined,
        sharedLeader: sharedState?.leaderUuid === actor.uuid,
        sharedCanRoll: sharedState?.lastContributorUuid === actor.uuid,
        sharedParticipants,
        sharedMaxInvestment,
        sharedInvestmentDefault: Math.min(1, sharedMaxInvestment),
        sharedProgress: round(Number(sharedState?.progress ?? 0), 6),
        sharedRequiredProgress: round(Number(sharedState?.requiredProgress ?? definition.requiredProgress), 6),
        sharedPercent: Math.max(0, Math.min(100, Math.floor(Number(sharedState?.progress ?? 0) / Number(sharedState?.requiredProgress ?? definition.requiredProgress) * 100))),
        state,
        lastResult: lastResultView(
          state?.lastResult,
          Boolean(station.actorValue.enabled),
          station.actorValue.label || station.actorValue.key || game.i18n.localize("DOWNTIME_MANAGER.Station.ActorValue"),
          definition.isCustom
        ),
        active,
        paused,
        completed: Boolean(state?.completed),
        progress: round(progress, 6),
        requiredProgress: round(requiredProgress, 6),
        percent: requiredProgress > 0 ? Math.max(0, Math.min(100, Math.floor(progress / requiredProgress * 100))) : 100,
        intervalProgress: round(Number(state?.intervalProgress ?? 0), 6),
        rollInterval: station.rollInterval,
        pendingRoll: Boolean(state?.pendingRoll),
        awaitingCompletionCheck: Boolean(state?.awaitingCompletionCheck),
        completionDC: Number(definition.completionCheck?.dc ?? 10),
        completionRetryCost: state?.completionCheckFailed ? Number(definition.completionCheck?.retryDowntime ?? 1) : 0,
        completionCheckFailed: Boolean(state?.completionCheckFailed),
        lastCompletionCheck: state?.lastCompletionCheck ?? null,
        maxInvestment,
        investmentDefault: Math.min(1, maxInvestment),
        checks,
        requiresRoll: station.requiresRoll !== false,
        showCheckSelection: checkSelectionRequired,
        canStart: !knownSpell && station.enabled && stationToolOk && projectToolsOk &&
          Boolean(definition.rewards?.length || definition.characterRewards?.length) &&
          (paused || (startItemsOk && startGoldOk && (!state || (state.completed && definition.repeatable)))),
        canInvest: station.enabled && Boolean(active && !state.pendingRoll && !state.awaitingCompletionCheck && maxInvestment > 0 && (!checkSelectionRequired || checks.length)),
        canRoll: station.enabled && Boolean(active && state.pendingRoll && checks.length),
        canCompletionRoll: station.enabled && Boolean(active && state.awaitingCompletionCheck && checks.length && DowntimeService.get(actor) + 1e-9 >= (state.completionCheckFailed ? Number(definition.completionCheck?.retryDowntime ?? 1) : 0))
      });
    }
    projects.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
    const projectTypes = [...new Map(projects.map(project => [
      project.classification.type,
      project.classification.typeLabel
    ]))].map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      ...base,
      actorName: actor.name,
      downtime: DowntimeService.get(actor),
      gold: round(GoldService.getGold(actor), 2),
      showGold: adapter.capabilities.currency,
      actorValue: RewardService.getStationValue(actor, this.stationActor, station),
      actorValueLabel: station.actorValue.label || station.actorValue.key,
      actorValueEnabled: Boolean(station.actorValue.enabled),
      projectTypes,
      projects
    };
  }

  static #configure() {
    if (game.user.isGM) new StationConfigApp(this.stationActor).render(true);
  }

  static async #start(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    try {
      const quantity = this.element.querySelector(`[data-quantity-for="${CSS.escape(target.dataset.uuid)}"]`)?.value ?? 1;
      await ProjectService.start(actor, this.stationActor, target.dataset.uuid, quantity);
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.ProjectStarted"));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #invest(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    try {
      const input = this.element.querySelector(`[data-downtime-for="${CSS.escape(target.dataset.uuid)}"]`);
      const select = this.element.querySelector(`[data-check-for="${CSS.escape(target.dataset.uuid)}"]`);
      const [type, key] = String(select?.value ?? "").split(":");
      const result = await ProjectService.invest(actor, this.stationActor, target.dataset.uuid, input?.value, { type, key });
      ui.notifications.info(game.i18n.format(
        result.pendingRoll ? "DOWNTIME_MANAGER.Notifications.DowntimeInvestedRoll" : "DOWNTIME_MANAGER.Notifications.DowntimeInvested",
        { amount: result.used }
      ));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #cancel(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    try {
      const { item } = await ProjectService.project(target.dataset.uuid);
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("DOWNTIME_MANAGER.Dashboard.RemoveProject") },
        content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Dashboard.RemoveProjectConfirm", {
          project: foundry.utils.escapeHTML(item.name || ""),
          actor: foundry.utils.escapeHTML(actor.name || "")
        })}</p>`
      });
      if (!confirmed) return;
      await ProjectService.cancel(actor, this.stationActor, target.dataset.uuid);
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Dashboard.ProjectRemoved"));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #roll(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    const select = this.element.querySelector(`[data-check-for="${CSS.escape(target.dataset.uuid)}"]`);
    const [type, key] = String(select?.value ?? "").split(":");
    try {
      const result = await ProjectService.resolveRoll(actor, this.stationActor, target.dataset.uuid, { type, key });
      if (!result) return;
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Notifications.RollResolved", {
        result: result.row.label || result.rolled.total,
        progress: result.calculation.progress
      }));
      if (result.actorValueChange) {
        ui.notifications.info(game.i18n.format(
          "DOWNTIME_MANAGER.Notifications.ActorValueChanged",
          {
            label: getStationData(this.stationActor).actorValue?.label
              || game.i18n.localize("DOWNTIME_MANAGER.Station.ActorValue"),
            change: result.actorValueChange > 0
              ? `+${result.actorValueChange}`
              : result.actorValueChange,
            value: result.actorValueAfter
          }
        ));
      }
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #completionRoll(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    const select = this.element.querySelector(`[data-completion-check-for="${CSS.escape(target.dataset.uuid)}"]`);
    const [type, key] = String(select?.value ?? "").split(":");
    try {
      const result = await ProjectService.resolveCompletionCheck(actor, this.stationActor, target.dataset.uuid, { type, key });
      if (!result) return;
      ui.notifications.info(game.i18n.format(result.success
        ? "DOWNTIME_MANAGER.Notifications.CompletionCheckPassed"
        : "DOWNTIME_MANAGER.Notifications.CompletionCheckFailed", { total: result.rolled.total, dc: result.dc }));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #sharedStart(event, target) {
    const actor = getActiveCrafter(); if (!actor) return;
    try {
      const batches = this.element.querySelector(`[data-shared-quantity-for="${CSS.escape(target.dataset.uuid)}"]`)?.value ?? 1;
      await sharedProjectAction("start", { stationUuid: this.stationActor.uuid, projectUuid: target.dataset.uuid, leaderUuid: actor.uuid, batches });
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.SharedProjectStarted")); this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedJoin(event, target) { const actor = getActiveCrafter(); try { await sharedProjectAction("join", sharedPayload(this, target, actor)); this.render(); } catch (error) { ui.notifications.error(error.message); } }
  static async #sharedLeave(event, target) { const actor = getActiveCrafter(); try { await sharedProjectAction("leave", sharedPayload(this, target, actor)); this.render(); } catch (error) { ui.notifications.error(error.message); } }
  static async #sharedCancel(event, target) {
    const actor = getActiveCrafter();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Project.CancelShared") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.Project.CancelSharedConfirm")}</p>`
    });
    if (!confirmed) return;
    try { await sharedProjectAction("cancel", sharedPayload(this, target, actor)); this.render(); }
    catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedInvest(event, target) {
    const actor = getActiveCrafter();
    try {
      const amount = this.element.querySelector(`[data-shared-downtime-for="${CSS.escape(target.dataset.uuid)}"]`)?.value;
      const select = this.element.querySelector(`[data-shared-check-for="${CSS.escape(target.dataset.uuid)}"]`); const [type, key] = String(select?.value ?? "").split(":");
      await sharedProjectAction("invest", { ...sharedPayload(this, target, actor), amount, check: { type, key } }); this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedRoll(event, target) {
    const actor = getActiveCrafter(); const select = this.element.querySelector(`[data-shared-check-for="${CSS.escape(target.dataset.uuid)}"]`); const [type, key] = String(select?.value ?? "").split(":");
    try { const rolled = await StationEngine.roll(actor, { type, key }); if (!rolled) return; await sharedProjectAction("resolveRoll", { ...sharedPayload(this, target, actor), check: { type, key }, rolled: { total: rolled.total, natural: rolled.natural } }); this.render(); } catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedCompletionRoll(event, target) {
    const actor = getActiveCrafter(); const select = this.element.querySelector(`[data-shared-completion-check-for="${CSS.escape(target.dataset.uuid)}"]`); const [type, key] = String(select?.value ?? "").split(":");
    try { const rolled = await StationEngine.roll(actor, { type, key }); if (!rolled) return; await sharedProjectAction("completionRoll", { ...sharedPayload(this, target, actor), check: { type, key }, rolled: { total: rolled.total, natural: rolled.natural } }); this.render(); } catch (error) { ui.notifications.error(error.message); }
  }
}
