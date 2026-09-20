import { MODULE_ID } from "./constants.mjs";
import { levelFromMilestones, sessionProgress } from "./session-service.mjs";

export async function craftingAccess(actor, item, definition) {
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
  const level = actor ? levelFromMilestones(sessionProgress(actor).milestones) : 0;
  return { minimum, blocked: level < minimum,
    message: game.i18n.format("TOVF.CraftingLevel.Locked", { level: minimum }) };
}

export async function assertCraftingAccess(actor, item, definition) {
  const access = await craftingAccess(actor, item, definition);
  if (access.blocked) throw new Error(access.message);
}
