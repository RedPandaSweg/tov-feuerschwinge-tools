import { MODULE_ID } from "./constants.mjs";
import { milestoneLevelForActor, sessionProgress } from "./session-service.mjs";

export async function craftingAccess(actor, item, definition) {
  if (definition.spellScroll) {
    const spell = definition.resultUuid ? await fromUuid(definition.resultUuid).catch(() => null) : null;
    const circle = Number(spell?.system?.circle?.base ?? spell?.system?.circle?.value ?? -1);
    if (circle < 1) return { minimum: 1, blocked: true,
      message: game.i18n.localize("DOWNTIME_MANAGER.Errors.SpellScrollCantrip") };
    const wizardLevel = Number(actor?.system?.progression?.classes?.wizard?.levels ?? 0);
    if (wizardLevel < 1) return { minimum: 1, blocked: true,
      message: game.i18n.localize("DOWNTIME_MANAGER.Errors.SpellScrollWizardRequired") };
    const allowedSources = new Set(["arcane"]);
    const boons = {
      "rite-of-the-source-master-divine": "divine",
      "rite-of-the-source-master-primordial": "primordial",
      "rite-of-the-source-master-wyrd": "wyrd"
    };
    for (const feature of wizardLevel >= 10 ? (actor.items ?? []) : []) {
      if (feature.type !== "feature") continue;
      const identifier = String(feature.identifier ?? feature.system?.identifier?.value ?? feature.system?.identifier ?? "").trim().toLowerCase();
      const name = String(feature.name ?? "").trim().toLowerCase();
      for (const [boon, source] of Object.entries(boons)) {
        if (identifier === boon || name === `rite of the source master (${source})`) allowedSources.add(source);
      }
    }
    const sources = new Set(Array.from(spell?.system?.source ?? [], value => String(value).trim().toLowerCase()));
    if (![...sources].some(source => allowedSources.has(source))) {
      return { minimum: 1, blocked: true,
        message: game.i18n.localize("DOWNTIME_MANAGER.Errors.SpellScrollSourceUnavailable") };
    }
  }
  if (definition.spellScrollScribing) {
    if (!actor?.system?.spellcasting?.hasSpellcastingAdvancement) {
      return { minimum: 1, blocked: true,
        message: game.i18n.localize("DOWNTIME_MANAGER.Errors.SpellScrollScribingSpellcastingRequired") };
    }
    const proficiency = (group, key) => Number(actor.system?.proficiencies?.[group]?.[key]?.proficiency?.multiplier ?? 0) > 0;
    const rawSources = item?.system?.source;
    const sourceEntries = typeof rawSources === "string" ? [rawSources] : Array.from(rawSources ?? []);
    const sources = new Set(sourceEntries.map(value => String(value).trim().toLowerCase()).filter(Boolean));
    const allowedSources = new Set();
    if (proficiency("tools", "artist")) allowedSources.add("*");
    if (proficiency("skills", "arcana")) {
      allowedSources.add("arcane");
      allowedSources.add("wyrd");
    }
    if (proficiency("skills", "nature")) allowedSources.add("primordial");
    if (proficiency("skills", "religion")) allowedSources.add("divine");
    if (!allowedSources.has("*") && ![...sources].some(source => allowedSources.has(source))) {
      return { minimum: 1, blocked: true,
        message: game.i18n.localize("DOWNTIME_MANAGER.Errors.SpellScrollScribingProficiencyRequired") };
    }
  }
  const override = definition.minimumCraftingLevel;
  let minimum = 1;
  if (override !== undefined && override !== null && override !== "") {
    minimum = Math.max(1, Math.min(20, Math.floor(Number(override) || 1)));
  } else {
    const levels = game.settings.get(MODULE_ID, "commerceRarityLevels") ?? {};
    const outputs = definition.isCustom
      ? await Promise.all([...new Set([definition.resultUuid, ...(definition.rewards ?? []).map(r => r.uuid)].filter(Boolean))].map(uuid => fromUuid(uuid)))
      : [item];
    for (const output of outputs) {
      minimum = Math.max(minimum, Math.min(20, Math.floor(Number(levels[String(output?.system?.rarity ?? "").trim()]) || 1)));
    }
  }
  const level = actor ? milestoneLevelForActor(actor, sessionProgress(actor)) : 0;
  return { minimum, blocked: level < minimum,
    message: game.i18n.format("TOVF.CraftingLevel.Locked", { level: minimum }) };
}

export async function assertCraftingAccess(actor, item, definition) {
  const access = await craftingAccess(actor, item, definition);
  if (access.blocked) throw new Error(access.message);
}
