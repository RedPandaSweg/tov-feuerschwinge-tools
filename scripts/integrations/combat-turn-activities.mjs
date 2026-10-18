let installed = false;

function hasEntries(value) {
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function actorsWithPossibleEffects(combatant) {
  const actors = new Map();
  const add = actor => {
    if (actor?.uuid) actors.set(actor.uuid, actor);
  };

  for (const actor of game.actors ?? []) add(actor);
  for (const entry of combatant?.parent?.combatants ?? []) add(entry.actor);
  for (const token of canvas?.tokens?.placeables ?? []) add(token.actor);
  return actors.values();
}

function activeEffects(actor) {
  const appliedItemEffects = [...(actor?.items ?? [])]
    .flatMap(item => [...(item.effects ?? [])])
    .filter(effect => effect.system?.applied === true || effect.isAppliedEnchantment === true);
  return [
    ...(actor?.effects ?? []),
    ...appliedItemEffects
  ].filter(effect => !effect.disabled && !effect.isSuppressed);
}

function effectBelongsToItem(effect, item) {
  const references = [
    effect.origin,
    effect.getFlag?.(game.system.id, "dependentOn")
  ].filter(reference => typeof reference === "string");
  return references.some(reference => reference === item.uuid || reference.startsWith(`${item.uuid}.`));
}

function hasActiveEffectForItem(item, combatant) {
  for (const actor of actorsWithPossibleEffects(combatant)) {
    if (activeEffects(actor).some(effect => effectBelongsToItem(effect, item))) return true;
  }
  return false;
}

function isRelevantPcActivity(uuid, actor, combatant) {
  const activity = fromUuidSync(uuid, { relative: actor, strict: false });
  const item = activity?.item;
  if (!item) return false;
  if (item.type !== "spell") return true;
  return item.system?.prepared !== false && hasActiveEffectForItem(item, combatant);
}

/**
 * Keep Black Flag combat messages focused on state which is currently
 * relevant. PC spell follow-ups require a live effect from that spell; NPC
 * activity suggestions are omitted while actual recovery and recharge deltas
 * remain untouched.
 */
export function installCombatTurnActivities() {
  if (installed) return { status: "already-installed" };
  if (typeof fromUuidSync !== "function") {
    return { status: "incompatible", reason: "Foundry's synchronous UUID resolver is unavailable." };
  }

  Hooks.on("blackFlag.preCreateCombatMessage", (combatant, messageConfig) => {
    const system = messageConfig?.data?.system;
    const activations = system?.activations;
    const actor = combatant?.actor;
    if (!Array.isArray(activations) || !actor) return;

    system.activations = actor.type === "pc"
      ? activations.filter(uuid => isRelevantPcActivity(uuid, actor, combatant))
      : [];

    if (!hasEntries(system.activations)
      && !hasEntries(system.deltas?.actor)
      && !hasEntries(system.deltas?.item)) {
      messageConfig.create = false;
    }
  });

  installed = true;
  return { status: "completed" };
}
