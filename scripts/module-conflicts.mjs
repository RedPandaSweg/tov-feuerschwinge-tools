import { MODULE_ID } from "./core/constants.mjs";
import { isOperationalGM } from "./core/permissions.mjs";

let checked = false;

function booleanSetting(namespace, key, fallback = false) {
  if (!game.settings.settings.has(`${namespace}.${key}`)) return fallback;
  return game.settings.get(namespace, key) === true;
}

function bfQolConcentrationEnabled() {
  return ["autoConcentration", "saveConcentration"].some(key => (
    booleanSetting("bf-qol", key)
  ));
}

function conflictIsSuppressed(id) {
  if (id === "instant-range") {
    return !booleanSetting(MODULE_ID, "tokenDistanceDisplay", true);
  }
  if (id === "bf-qol") {
    return !booleanSetting(MODULE_ID, "automaticConcentration", true)
      || bfQolConcentrationEnabled();
  }
  return false;
}

function configuredConflictIds() {
  const relationships = game.modules.get(MODULE_ID)?.relationships;
  return new Set([...relationships?.conflicts ?? []].map(conflict => conflict.id).filter(Boolean));
}

function activeConflicts() {
  return [...configuredConflictIds()]
    .map(id => game.modules.get(id))
    .filter(module => module?.active && !conflictIsSuppressed(module.id));
}

export function activateModuleConflictWarning() {
  if (checked || !isOperationalGM()) return;
  checked = true;
  const conflicts = activeConflicts();
  if (!conflicts.length) return;

  const names = conflicts
    .map(module => module.title ?? module.id)
    .sort((left, right) => left.localeCompare(right, game.i18n.lang));
  ui.notifications.warn(game.i18n.format("TOVF.ModuleConflicts.Warning", {
    modules: names.join(", ")
  }), { permanent: true });
}
