import { MODULE_ID, modulePath } from "./core/constants.mjs";

const ACTIVITY_TYPE = "tovContest";

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
  if (type === "skill") result = await actor.rollSkill({ skill: key, event }, dialogConfig, messageConfig);
  else if (type === "tool") result = await actor.rollTool({ tool: key, event }, dialogConfig, messageConfig);
  else if (type === "ability") result = await actor.rollAbilityCheck({ ability: key, event }, dialogConfig, messageConfig);
  else throw new Error(game.i18n.localize("TOV.ContestedActivity.Error.CheckMissing"));
  const roll = firstRoll(result);
  return roll && Number.isFinite(Number(roll.total)) ? { roll, total: Number(roll.total) } : null;
}

function selectedDefender(attacker) {
  const selected = (canvas.tokens?.controlled ?? []).filter(token => token.actor);
  if (selected.length !== 1 || selected[0].actor.uuid === attacker?.uuid) return null;
  return selected[0].actor;
}

function resultContent(activity, state) {
  const attackerWins = Boolean(state.attackerWins);
  const resultKey = attackerWins ? "AttackerWins" : "DefenderWins";
  return `<section class="tov-contested-result ${attackerWins ? "success" : "failure"}">
    <h3>${foundry.utils.escapeHTML(activity.name)}</h3>
    <p>${game.i18n.format(`TOV.ContestedActivity.Result.${resultKey}`, {
      attacker: foundry.utils.escapeHTML(state.attacker.name),
      attackerCheck: foundry.utils.escapeHTML(state.attacker.checkLabel),
      attackerTotal: state.attacker.total,
      defender: foundry.utils.escapeHTML(state.defender.name),
      defenderCheck: foundry.utils.escapeHTML(state.defender.checkLabel),
      defenderTotal: state.defender.total
    })}</p>
  </section>`;
}

async function storeRoll(activity, message, role, actor, result, selection) {
  const state = foundry.utils.deepClone(message.getFlag(MODULE_ID, "contestedCheck") ?? {});
  state[role] = {
    actorUuid: actor.uuid,
    name: actor.name,
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

Hooks.once("init", () => {
  if (game.system.id !== "black-flag") return;

  const DamageActivity = BlackFlag.documents.activity.DamageActivity;
  const DamageData = DamageActivity.metadata.dataModel;
  const DamageSheet = CONFIG.Activity.types.damage.sheetClasses.config;
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
        const result = await rollCheck(defender, selection, event, message.id);
        if (result) await storeRoll(this, message, "defender", defender, result, selection);
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
});
