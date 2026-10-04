import { MODULE_ID } from "../core/constants.mjs";

const DEFINITIONS = Object.freeze({
  core: [
    ["characterCreation", "./character-creation-overrides.mjs", "installCharacterCreationOverrides"],
    ["weaponOptionActivities", "./weapon-option-activities.mjs?v=3.2.4-tooltip-links-2", "installWeaponOptionActivities"],
    ["activityChaining", "../activity-chaining.mjs?v=3.3.1-follow-up-filter-2", "installActivityChaining"],
    ["toolAbility", "./tool-ability.mjs", "installToolAbilitySelection"],
    ["theurgeSpellcasting", "./theurge-spellcasting.mjs?v=3.7.7-theurge-replacement-2", "installTheurgeSpellcasting"]
  ],
  documentUi: [
    ["customBackground", "./custom-background.mjs?v=3.3.1-custom-background-16", "installCustomBackground"],
    ["activeEffectChangesUi", "../active-effect-changes-ui.mjs?v=3.7.8-actor-effect-delete-3", "installActiveEffectChangesUi"]
  ],
  optionalModules: [
    ["argon", "./argon-black-flag-compatibility.mjs?v=3.7.8-argon-module-check-2", "installArgonBlackFlagCompatibility"]
  ],
  ready: [
    ["summon", "../summon-compat.mjs?v=3.6.2-character-summon-folder-1", "activateSummonCompatibility"]
  ]
});

const statuses = new Map(Object.entries(DEFINITIONS).flatMap(([phase, definitions]) => (
  definitions.map(([id]) => [id, { id, phase, status: "pending" }])
)));
const installers = new Map();
const installedPhases = new Set();
const notifiedFailures = new Set();
let failureNotificationRegistered = false;

function serializeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error ?? "Unknown error")
  };
}

function notifyFailuresOnReady() {
  if (failureNotificationRegistered) return;
  failureNotificationRegistered = true;
  Hooks.once("ready", notifyCompatibilityFailures);
}

await Promise.all(Object.entries(DEFINITIONS).flatMap(([phase, definitions]) => (
  definitions.map(async ([id, path, exportName]) => {
    const startedAt = Date.now();
    try {
      const module = await import(path);
      const installer = module?.[exportName];
      if (typeof installer !== "function") throw new Error(`Missing export ${exportName}.`);
      installers.set(id, installer);
      statuses.set(id, { id, phase, status: "loaded", durationMs: Date.now() - startedAt });
    } catch (error) {
      statuses.set(id, {
        id,
        phase,
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: serializeError(error)
      });
      console.error(`${MODULE_ID} | Compatibility integration "${id}" failed to load.`, error);
      notifyFailuresOnReady();
    }
  })
)));

export function notifyCompatibilityFailures() {
  const failed = [...statuses.values()].filter(entry => (
    ["failed", "incompatible"].includes(entry.status) && !notifiedFailures.has(entry.id)
  ));
  if (!failed.length) return;
  for (const entry of failed) notifiedFailures.add(entry.id);
  ui.notifications.error(game.i18n.format("TOVF.Compatibility.InstallFailed", {
    integrations: failed.map(entry => entry.id).join(", ")
  }), { permanent: true });
}

function installIntegration(id, phase, installer) {
  const startedAt = Date.now();
  try {
    const result = installer();
    const outcome = result && typeof result === "object"
      ? result
      : { status: result === false ? "skipped" : "completed" };
    statuses.set(id, {
      id,
      phase,
      ...outcome,
      status: outcome.status ?? "completed",
      durationMs: Date.now() - startedAt
    });
    if (outcome.status === "incompatible") {
      console.error(`${MODULE_ID} | Compatibility integration "${id}" is incompatible: ${outcome.reason ?? "required API missing"}.`);
      notifyFailuresOnReady();
    }
  } catch (error) {
    statuses.set(id, {
      id,
      phase,
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: serializeError(error)
    });
    console.error(`${MODULE_ID} | Compatibility integration "${id}" failed to install.`, error);
    notifyFailuresOnReady();
  }
}

/** Install one compatibility phase without allowing a broken integration to block the rest. */
export function installCompatibilityPhase(phase) {
  if (installedPhases.has(phase) || game.system.id !== "black-flag") return;
  const definitions = DEFINITIONS[phase];
  if (!definitions) throw new Error(`Unknown compatibility phase: ${phase}`);
  installedPhases.add(phase);
  for (const [id] of definitions) {
    const installer = installers.get(id);
    if (installer) installIntegration(id, phase, installer);
  }
}

/** Activate compatibility work which requires initialized World data. */
export function activateCompatibilityLayer() {
  installCompatibilityPhase("ready");
}

/** Serializable diagnostic snapshot for support and console inspection. */
export function compatibilityReport() {
  return {
    foundryVersion: game.version,
    system: { id: game.system.id, version: game.system.version },
    moduleVersion: game.modules.get(MODULE_ID)?.version ?? "",
    integrations: [...statuses.values()].map(entry => foundry.utils.deepClone(entry))
  };
}

export const compatibilityApi = Object.freeze({ report: compatibilityReport });
