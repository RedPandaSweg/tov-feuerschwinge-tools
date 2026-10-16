let installed = false;

function hasEntries(value) {
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value && typeof value === "object" && Object.keys(value).length > 0;
}

function isPreparedTurnActivity(uuid, actor) {
  const activity = fromUuidSync(uuid, { relative: actor, strict: false });
  const item = activity?.item;
  return item?.type !== "spell" || item.system?.prepared !== false;
}

/**
 * Black Flag currently includes turn-triggered Activities from every Spell on
 * a PC, even when that Spell is not prepared. Restrict only combat reminder
 * cards to Spells which the system itself considers prepared.
 */
export function installPreparedSpellTurnActivities() {
  if (installed) return { status: "already-installed" };
  if (typeof fromUuidSync !== "function") {
    return { status: "incompatible", reason: "Foundry's synchronous UUID resolver is unavailable." };
  }

  Hooks.on("blackFlag.preCreateCombatMessage", (combatant, messageConfig) => {
    const system = messageConfig?.data?.system;
    const activations = system?.activations;
    if (!Array.isArray(activations) || !combatant?.actor) return;

    system.activations = activations.filter(uuid => isPreparedTurnActivity(uuid, combatant.actor));
    if (!hasEntries(system.activations)
      && !hasEntries(system.deltas?.actor)
      && !hasEntries(system.deltas?.item)) {
      messageConfig.create = false;
    }
  });

  installed = true;
  return { status: "completed" };
}
