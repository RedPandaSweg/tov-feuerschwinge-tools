const TEMPLE_SWORD_BASE = "templeSword";

/** Register the Labyrinth Worldbook's Temple Sword base without requiring that module. */
export function installTempleSwordProficiency() {
  if (game.system.id !== "black-flag") {
    return { status: "inactive", reason: "Requires the black-flag system." };
  }

  const martialWeapons = CONFIG.BlackFlag?.weapons?.martial?.children;
  if (!martialWeapons || typeof martialWeapons !== "object") {
    return {
      status: "incompatible",
      reason: "CONFIG.BlackFlag.weapons.martial.children is unavailable."
    };
  }

  // The Labyrinth Worldbook registers this same key. Preserve its definition,
  // including the Compendium link, whenever it has already run.
  if (Object.hasOwn(martialWeapons, TEMPLE_SWORD_BASE)) {
    return {
      status: "already-installed",
      reason: "The Temple Sword weapon base is already registered."
    };
  }
  if (!Object.isExtensible(martialWeapons)) {
    return {
      status: "incompatible",
      reason: "The martial weapon configuration cannot be extended."
    };
  }

  martialWeapons[TEMPLE_SWORD_BASE] = {
    label: "Temple Sword",
    type: "melee"
  };
  return { status: "completed" };
}
