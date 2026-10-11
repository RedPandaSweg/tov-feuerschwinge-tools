const GEMSTONE_BASE = "gemstone";

/** Register Gemstone as a Wondrous Item base before Item sheets prepare their options. */
export function installGearCategories() {
  if (game.system.id !== "black-flag") return { status: "inactive", reason: "Requires the black-flag system." };

  const bases = CONFIG.BlackFlag?.gearCategories?.wondrousItem?.children;
  if (!bases || typeof bases !== "object") {
    return { status: "incompatible", reason: "CONFIG.BlackFlag.gearCategories.wondrousItem.children is unavailable." };
  }
  if (bases[GEMSTONE_BASE]?.label === "Gemstone") return { status: "already-installed" };
  if (!bases[GEMSTONE_BASE] && !Object.isExtensible(bases)) {
    return { status: "incompatible", reason: "The Wondrous Item base configuration cannot be extended." };
  }

  bases[GEMSTONE_BASE] = { ...bases[GEMSTONE_BASE], label: "Gemstone" };
  return { status: "completed" };
}
