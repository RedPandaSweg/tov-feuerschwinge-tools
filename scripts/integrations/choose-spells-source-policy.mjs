import { blockedPlayerSpellSource, isPlayerSelectableSpell } from "../core/spell-source-policy.mjs";

const PATCH_FLAG = "__tovfChooseSpellsSourcePolicy";

function blockedSourceError(item) {
  const reason = blockedPlayerSpellSource(item);
  const key = reason === "dnd5e" ? "Dnd5e" : "KoboldPressOgl";
  return new Error(game.i18n.localize(`TOVF.SpellSourcePolicy.${key}`));
}

export function installChooseSpellsSourcePolicy() {
  const Advancement = CONFIG.Advancement?.types?.chooseSpells?.documentClass;
  const prototype = Advancement?.prototype;
  const originalValidateItemType = prototype?._validateItemType;
  const originalChoices = prototype?.choices;
  const originalApply = prototype?.apply;

  const missing = [];
  if (typeof originalValidateItemType !== "function") missing.push("ChooseSpellsAdvancement._validateItemType");
  if (typeof originalChoices !== "function") missing.push("ChooseSpellsAdvancement.choices");
  if (typeof originalApply !== "function") missing.push("ChooseSpellsAdvancement.apply");
  if (missing.length) {
    return { status: "incompatible", reason: `Missing Black Flag APIs: ${missing.join(", ")}.` };
  }
  if (originalValidateItemType[PATCH_FLAG]) return { status: "already-installed" };

  const validateItemType = function(item, options = {}) {
    const valid = originalValidateItemType.call(this, item, options);
    if (valid === false || isPlayerSelectableSpell(item)) return valid;
    if (options.strict !== false) throw blockedSourceError(item);
    return false;
  };
  Object.defineProperty(validateItemType, PATCH_FLAG, { value: true });
  prototype._validateItemType = validateItemType;

  prototype.choices = async function(...args) {
    return (await originalChoices.apply(this, args)).filter(isPlayerSelectableSpell);
  };

  prototype.apply = async function(levels, data, options = {}) {
    if (!options.initial) {
      for (const uuid of data?.choices ?? []) {
        const item = await fromUuid(uuid);
        if (item && !isPlayerSelectableSpell(item)) throw blockedSourceError(item);
      }
    }
    return originalApply.call(this, levels, data, options);
  };

  return { status: "completed" };
}
