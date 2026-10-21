import { MODULE_ID, modulePath } from "./core/constants.mjs";

const ACTIVITY_TYPE = "tovContest";
const SHOVE_CHAT_FLAG = "argonContestedShove";
let registered = false;

function activateShoveChatActions(message, html, ActivityClass) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  const payload = message.getFlag(MODULE_ID, SHOVE_CHAT_FLAG);
  if (!(root instanceof HTMLElement) || !payload) return;

  root.addEventListener("click", event => {
    const target = event.target.closest('[data-action="rollContestAttacker"], [data-action="rollContestDefender"]');
    if (!target || !root.contains(target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    target.disabled = true;
    void (async () => {
      try {
        const actor = await fromUuid(payload.actorUuid);
        if (!actor || !payload.itemData || !payload.activityId) {
          throw new Error("The temporary Shove activity could not be restored.");
        }
        const item = new Item.implementation(payload.itemData, { parent: actor });
        const activity = item.system.activities.get(payload.activityId);
        const handler = ActivityClass.metadata.usage.actions[target.dataset.action];
        if (!activity || typeof handler !== "function") {
          throw new Error("The temporary Shove activity action is unavailable.");
        }
        await handler.call(activity, event, target, message);
      } catch (error) {
        console.error(`${MODULE_ID} | Shove chat action failed`, error);
        ui.notifications.error(error.message);
      } finally {
        target.disabled = false;
      }
    })();
  }, { capture: true });
}

function firstRoll(result) {
  if (Array.isArray(result)) return result[0] ?? null;
  return result?.contents?.[0] ?? result?.first?.() ?? result ?? null;
}

function checkLabel(selection) {
  const [type, key] = String(selection ?? "").split(":");
  if (type === "skill") return CONFIG.BlackFlag.skills.localized[key] ?? key;
  if (type === "tool") return CONFIG.BlackFlag.tools.localized[key] ?? key;
  return CONFIG.BlackFlag.abilities.localized[key] ?? key;
}

function checkSelections(value) {
  if (value instanceof Set) return Array.from(value);
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value ? [value] : [];
}

async function rollCheck(actor, selection, event, originatingMessageId) {
  const [type, key] = String(selection ?? "").split(":");
  let result;
  const dialogConfig = {};
  const messageConfig = {
    data: {
      speaker: ChatMessage.getSpeaker({ actor }),
      flags: { [game.system.id]: { originatingMessage: originatingMessageId } }
    }
  };
  if (type === "skill") {
    const ability = CONFIG.BlackFlag.skills[key]?.ability;
    result = await actor.rollSkill({ skill: key, ability, event }, dialogConfig, messageConfig);
  }
  else if (type === "tool") result = await actor.rollTool({ tool: key, event }, dialogConfig, messageConfig);
  else if (type === "ability") result = await actor.rollAbilityCheck({ ability: key, event }, dialogConfig, messageConfig);
  else throw new Error(game.i18n.localize("TOV.ContestedActivity.Error.CheckMissing"));
  const roll = firstRoll(result);
  if (!roll || !Number.isFinite(Number(roll.total))) return null;
  const dice3d = game.dice3d;
  if (roll.message?.id && typeof dice3d?.waitFor3DAnimationByMessageID === "function") {
    await dice3d.waitFor3DAnimationByMessageID(roll.message.id);
  }
  return { roll, total: Number(roll.total) };
}

function selectedDefender(attacker) {
  const selected = (canvas.tokens?.controlled ?? []).filter(token => token.actor);
  if (selected.length !== 1 || selected[0].actor.uuid === attacker?.uuid) return null;
  return { actor: selected[0].actor, token: selected[0] };
}

function actorTokenImage(actor, token = actor.getActiveTokens?.()[0]) {
  return token?.document?.texture?.src
    ?? token?.texture?.src
    ?? actor.prototypeToken?.texture?.src
    ?? actor.img
    ?? "icons/svg/mystery-man.svg";
}

function resultContent(activity, state) {
  const attackerWins = state.attackerWins === true;
  const attackerClass = attackerWins ? "is-winner" : "";
  const defenderClass = attackerWins ? "" : "is-winner";
  const attackerName = foundry.utils.escapeHTML(state.attacker.name);
  const defenderName = foundry.utils.escapeHTML(state.defender.name);
  const attackerImg = foundry.utils.escapeHTML(state.attacker.img ?? "icons/svg/mystery-man.svg");
  const defenderImg = foundry.utils.escapeHTML(state.defender.img ?? "icons/svg/mystery-man.svg");
  return `<section class="tov-contested-result ${attackerWins ? "success" : "failure"}">
    <h4>${foundry.utils.escapeHTML(activity.name)} Contest</h4>
    <div class="tov-contested-matchup">
      <article class="tov-contested-side ${attackerClass}">
        <strong>${attackerName}</strong>
        <img src="${attackerImg}" alt="${attackerName}">
        <span>${game.i18n.localize("TOV.ContestedActivity.Sides.Attacker")}</span>
      </article>
      <div class="tov-contested-score">
        <div class="tov-contested-roll ${attackerClass}"><strong>${state.attacker.total}</strong><span>${foundry.utils.escapeHTML(state.attacker.checkLabel)}</span></div>
        <strong class="tov-contested-versus">VS</strong>
        <div class="tov-contested-roll ${defenderClass}"><strong>${state.defender.total}</strong><span>${foundry.utils.escapeHTML(state.defender.checkLabel)}</span></div>
      </div>
      <article class="tov-contested-side defender ${defenderClass}">
        <strong>${defenderName}</strong>
        <img src="${defenderImg}" alt="${defenderName}">
        <span>${game.i18n.localize("TOV.ContestedActivity.Sides.Defender")}</span>
      </article>
    </div>
  </section>`;
}

async function storeRoll(activity, message, role, actor, result, selection, token) {
  const state = foundry.utils.deepClone(message.getFlag(MODULE_ID, "contestedCheck") ?? {});
  state[role] = {
    actorUuid: actor.uuid,
    name: actor.name,
    img: actorTokenImage(actor, token),
    check: selection,
    checkLabel: checkLabel(selection),
    total: result.total,
    rollMessageId: result.roll?.message?.id ?? null
  };
  if (state.attacker && state.defender) {
    state.tied = state.attacker.total === state.defender.total;
    state.attackerWins = state.attacker.total > state.defender.total
      || (state.tied && activity.system.contest.ties === "attacker");
    const content = resultContent(activity, state);
    const existing = state.resultMessageId ? game.messages.get(state.resultMessageId) : null;
    if (existing) await existing.update({ content });
    else {
      const resultMessage = await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor: activity.actor }),
        content,
        flags: { [MODULE_ID]: { contestedResultFor: message.id } }
      });
      state.resultMessageId = resultMessage.id;
    }
  } else {
    delete state.attackerWins;
    delete state.tied;
  }
  await message.setFlag(MODULE_ID, "contestedCheck", state);
  return state;
}

function checkOptions() {
  return [
    ...CONFIG.BlackFlag.abilities.localizedOptions.map(option => ({
      value: `ability:${option.value}`,
      label: option.label,
      group: game.i18n.localize("BF.Ability.Label[other]")
    })),
    ...CONFIG.BlackFlag.skills.localizedOptions.map(option => ({
      value: `skill:${option.value}`,
      label: option.label,
      group: game.i18n.localize("BF.Skill.Label[other]")
    })),
    ...CONFIG.BlackFlag.tools.localizedOptions.map(option => ({
      value: `tool:${option.value}`,
      label: option.label,
      group: game.i18n.localize("BF.Tool.Label[other]")
    }))
  ];
}

export function registerContestedActivity() {
  if (registered) return { status: "already-installed" };
  if (game.system.id !== "black-flag") return { status: "inactive", reason: "Black Flag is not active." };

  const DamageActivity = BlackFlag?.documents?.activity?.DamageActivity;
  const DamageData = DamageActivity?.metadata?.dataModel;
  const DamageSheet = CONFIG.Activity?.types?.damage?.sheetClasses?.config;
  if (!DamageActivity || !DamageData || !DamageSheet) {
    throw new Error("Black Flag's damage Activity API is unavailable.");
  }
  const { SchemaField, SetField, StringField } = foundry.data.fields;

  class ContestedActivityData extends DamageData {
    static LOCALIZATION_PREFIXES = ["BF.DAMAGE", "TOV.ContestedActivity"];

    static defineSchema() {
      return {
        ...super.defineSchema(),
        contest: new SchemaField({
          attacker: new SetField(new StringField({ required: true, blank: false }), { initial: ["skill:athletics"] }),
          defender: new SetField(new StringField({ required: true, blank: false }), { initial: ["skill:athletics"] }),
          ties: new StringField({ required: true, blank: false, initial: "defender", choices: ["attacker", "defender"] })
        })
      };
    }

    static migrateData(source) {
      if (typeof source?.contest?.attacker === "string") source.contest.attacker = [source.contest.attacker];
      if (typeof source?.contest?.defender === "string") source.contest.defender = [source.contest.defender];
      return super.migrateData(source);
    }
  }

  class ContestedActivity extends DamageActivity {
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      type: ACTIVITY_TYPE,
      dataModel: ContestedActivityData,
      icon: "systems/black-flag/artwork/advancement/scale-value.svg",
      title: "TOV.ContestedActivity.Title",
      hint: "TOV.ContestedActivity.Hint",
      usage: {
        actions: {
          rollContestAttacker: ContestedActivity.rollAttacker,
          rollContestDefender: ContestedActivity.rollDefender,
          rollContestDamage: ContestedActivity.rollContestDamage
        }
      }
    }, { inplace: false }));

    get challengeColumn() {
      const attacker = checkSelections(this.system.contest.attacker).map(checkLabel).join(", ");
      const defender = checkSelections(this.system.contest.defender).map(checkLabel).join(", ");
      return `${attacker} / ${defender}`;
    }

    _activationChatButtons(message) {
      const buttons = checkSelections(this.system.contest.attacker).map(selection => ({
        label: game.i18n.format("TOV.ContestedActivity.RollAttacker", { check: checkLabel(selection) }),
        icon: '<i class="fa-solid fa-dice-d20" inert></i>',
        dataset: { action: "rollContestAttacker", selection }
      }));
      buttons.push(...checkSelections(this.system.contest.defender).map(selection => ({
        label: game.i18n.format("TOV.ContestedActivity.RollDefender", { check: checkLabel(selection) }),
        icon: '<i class="fa-solid fa-shield" inert></i>',
        dataset: { action: "rollContestDefender", selection }
      })));
      if (this.hasDamage) buttons.push({
        label: game.i18n.localize("BF.DAMAGE.Label"),
        icon: '<i class="fa-solid fa-burst" inert></i>',
        dataset: { action: "rollContestDamage" }
      });
      return buttons.concat(super._activationChatButtons(message).filter(button => button.dataset?.action !== "rollDamage"));
    }

    async _triggerSubsequentActions() {}

    static async rollAttacker(event, target, message) {
      try {
        const selection = target.dataset.selection;
        if (!checkSelections(this.system.contest.attacker).includes(selection)) throw new Error(game.i18n.localize("TOV.ContestedActivity.Error.CheckMissing"));
        const result = await rollCheck(this.actor, selection, event, message.id);
        if (result) await storeRoll(this, message, "attacker", this.actor, result, selection);
      } catch (error) {
        console.error(`${MODULE_ID} | Contested activity failed`, error);
        ui.notifications.error(error.message);
      }
    }

    static async rollDefender(event, target, message) {
      try {
        const selection = target.dataset.selection;
        if (!checkSelections(this.system.contest.defender).includes(selection)) throw new Error(game.i18n.localize("TOV.ContestedActivity.Error.CheckMissing"));
        const defender = selectedDefender(this.actor);
        if (!defender) return ui.notifications.warn(game.i18n.localize("TOV.ContestedActivity.Error.SelectOneToken"));
        const result = await rollCheck(defender.actor, selection, event, message.id);
        if (result) await storeRoll(this, message, "defender", defender.actor, result, selection, defender.token);
      } catch (error) {
        console.error(`${MODULE_ID} | Contested activity failed`, error);
        ui.notifications.error(error.message);
      }
    }

    static async rollContestDamage(event, target, message) {
      const state = message.getFlag(MODULE_ID, "contestedCheck") ?? {};
      if (state.attackerWins !== true) {
        return ui.notifications.warn(game.i18n.localize("TOV.ContestedActivity.Error.DamageLocked"));
      }
      return this.rollDamage(
        { event },
        {},
        { data: { "flags.black-flag.originatingMessage": message.id } }
      );
    }
  }

  class ContestedActivitySheet extends DamageSheet {
    static DEFAULT_OPTIONS = {
      classes: ["damage-activity", "tov-contested-activity"]
    };

    static PARTS = {
      ...super.PARTS,
      effect: {
        template: modulePath("templates/contested-effect.hbs"),
        templates: [...super.PARTS.effect.templates]
      }
    };

    async _prepareEffectContext(context, options) {
      context = await super._prepareEffectContext(context, options);
      context.contestCheckOptions = checkOptions();
      context.contestTieOptions = [
        { value: "defender", label: game.i18n.localize("TOV.ContestedActivity.Ties.Defender") },
        { value: "attacker", label: game.i18n.localize("TOV.ContestedActivity.Ties.Attacker") }
      ];
      return context;
    }
  }

  CONFIG.Activity.types[ACTIVITY_TYPE] = {
    documentClass: ContestedActivity,
    sheetClasses: { config: ContestedActivitySheet }
  };
  ContestedActivity.localize();
  BlackFlag.modules[MODULE_ID] ??= {};
  Object.assign(BlackFlag.modules[MODULE_ID], { ContestedActivity, ContestedActivityData, ContestedActivitySheet });
  Hooks.on("renderChatMessageHTML", (message, html) => activateShoveChatActions(message, html, ContestedActivity));
  registered = true;
  return { status: "completed" };
}
