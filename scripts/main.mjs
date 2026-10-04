import { MODULE_ID } from "./core/constants.mjs";
import { activateDowntime, registerDowntime } from "./downtime/main.mjs?v=3.8.0-unresolved-advancement-formulas-1";
import { activateVoidTaint, registerVoidTaint } from "./void-taint/main.mjs?v=3.3.0-void-taint-1";
import { installBlackFlagCompatibility } from "./integrations/black-flag-compatibility.mjs?v=3.7.8-forward-consumption-1";
import {
  loadStartupModule,
  notifyStartupFailures,
  runStartupStep,
  runStartupStepAsync,
  runStartupSteps,
  startupApi
} from "./core/startup.mjs?v=3.8.0-isolated-feature-loads-1";

const BLACK_FLAG_FEATURE_MODULES = Object.freeze({
  events: "./core/events.mjs?v=3.7.8-module-events-1",
  scheduler: "./core/scheduler.mjs?v=3.7.8-central-scheduler-1",
  concentration: "./concentration.mjs?v=3.7.8-safe-documents-1",
  migrations: "./core/migrations.mjs",
  namespaceMigration: "./core/namespace-migration.mjs?v=3.8.0-storage-api-2",
  compendiumTransfer: "./transfer/compendium-transfer.mjs?v=3.6.2-transfer-integrity-9",
  sessionTransfer: "./transfer/session-transfer.mjs?v=3.7.8-safe-documents-1",
  characterCreation: "./integrations/character-creation-overrides.mjs",
  weaponOptions: "./integrations/weapon-option-activities.mjs?v=3.2.4-tooltip-links-2",
  playerUnpause: "./player-unpause.mjs",
  compendiumLibrary: "./compendium-library.mjs?v=3.8.0-kctg-library-source-1",
  dnd5eItemImporter: "./dnd5e-item-importer.mjs?v=3.8.0-import-spell-school-1",
  challengeManager: "./challenge-manager.mjs?v=3.8.0-standalone-combat-hud-23",
  linkTools: "./link-tools-config.mjs",
  featurePool: "./feature-pool-integration.mjs",
  tokenSizeSync: "./token-size-sync.mjs",
  creatureBuilder: "./creature-builder.mjs",
  actorDirectoryActivity: "./actor-directory-activity.mjs?v=3.8.0-inactive-markers-3",
  settingsCategories: "./settings-categories.mjs",
  help: "./help-config.mjs",
  activityChaining: "./activity-chaining.mjs?v=3.3.1-follow-up-filter-2",
  compatibility: "./integrations/compatibility-layer.mjs?v=3.8.0-isolated-feature-loads-1",
  compendiumUsability: "./compendium-usability.mjs",
  chatImagePopouts: "./chat-image-popout.mjs",
  chatMessageDeletion: "./chat-message-deletion.mjs",
  chatTimestamps: "./chat-timestamps.mjs",
  effectGroups: "./effect-groups.mjs?v=3.7.8-safe-documents-1",
  tokenPresets: "./token-presets.mjs?v=3.7.6-actor-presets-1",
  tokenLightAura: "./token-light-aura.mjs",
  simpleTileTriggers: "./simple-tile-triggers.mjs?v=3.2.2",
  commerce: "./commerce/main.mjs?v=3.7.8-runtime-audit-1",
  contestedActivity: "./contested-activity.mjs",
  talentBackgrounds: "./talent-backgrounds.mjs?v=3.3.1-talent-backgrounds-6",
  spellScrolls: "./spell-scrolls.mjs?v=3.7.8-clearance-label-1",
  spellNameMarkers: "./spell-name-markers.mjs?v=3.5.0-spell-markers-1",
  selectedTokenEffectsHud: "./selected-token-effects-hud.mjs?v=3.7.8-selected-token-effects-2",
  macroActivity: "./macro-activity.mjs",
  weaponCustomization: "./weapon-customization.mjs",
  weaponEnchantment: "./weapon-enchantment.mjs"
});
const DND5E_FEATURE_MODULES = Object.freeze({
  dnd5eBundleExporter: "./import/dnd5e-bundle-exporter.mjs?v=3.8.0-content-bundle-2"
});

function featureModulesForSystem(systemId) {
  if (systemId === "black-flag") return BLACK_FLAG_FEATURE_MODULES;
  if (systemId === "dnd5e") return DND5E_FEATURE_MODULES;
  return Object.freeze({});
}

function bootstrapSystemId() {
  const setupSystem = game.data?.system;
  return game.system?.id
    ?? setupSystem?.id
    ?? (typeof setupSystem === "string" ? setupSystem : null)
    ?? game.world?.system
    ?? null;
}

// Start loading immediately, but never await feature modules before the root
// lifecycle listeners have been registered. Foundry does not guarantee that
// a module entry point using top-level await finishes before it emits init.
// Each feature import remains isolated by loadStartupModule().
let features = new Map();
let loadedSystemId = null;
let featuresReady = Promise.resolve(features);

function loadFeatures(systemId) {
  if (!systemId || loadedSystemId === systemId) return featuresReady;
  loadedSystemId = systemId;
  const definitions = featureModulesForSystem(systemId);
  featuresReady = Promise.all(Object.entries(definitions).map(async ([id, path]) => (
    [id, await loadStartupModule(id, new URL(path, import.meta.url).href)]
  ))).then(loadedEntries => {
    features = new Map(loadedEntries);
    return features;
  });
  return featuresReady;
}

// Setup data is available before game.system in Foundry v14. Start imports as
// early as possible without assuming that the initialized System object exists.
void loadFeatures(bootstrapSystemId());

function featureExport(feature, name) {
  const callback = features.get(feature)?.[name];
  return typeof callback === "function" ? callback : null;
}

function step(id, feature, exportName) {
  const callback = featureExport(feature, exportName);
  return callback ? [id, callback] : null;
}

function compactSteps(steps) {
  return steps.filter(Boolean);
}

const MODULE_MENU_ORDER = new Map([
  ["help", 0], ["creatureBuilder", 10], ["compendiumTransfer", 20],
  ["characterLinkTools", 40], ["weaponCustomization", 50], ["argonCombatHud", 55], ["challengeHud", 56],
  ["itemDefaults", 60], ["playerActorFolders", 70], ["sessionRewards", 80]
]);
const MODULE_SETTING_ORDER = new Map([
  ["worldRole", 0], ["automaticTokenSizing", 10], ["unpauseWithoutGM", 20],
  ["sessionHistoryEnabled", 30]
]);

function localConfigurationKey(key, prefix) {
  return key.slice(prefix.length);
}

function localizedConfigurationName(registry, key) {
  return game.i18n.localize(registry.get(key)?.name ?? key);
}

function reorderModuleEntries(registry, order, { configuredOnly = false } = {}) {
  const prefix = `${MODULE_ID}.`;
  const own = [...registry].filter(([key, value]) => (
    key.startsWith(prefix) && (!configuredOnly || value.config === true)
  ));
  if (!own.length) return;
  own.sort(([left], [right]) => {
    const leftRank = order.get(localConfigurationKey(left, prefix)) ?? 1000;
    const rightRank = order.get(localConfigurationKey(right, prefix)) ?? 1000;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return localizedConfigurationName(registry, left)
      .localeCompare(localizedConfigurationName(registry, right), game.i18n.lang);
  });
  const ownKeys = new Set(own.map(([key]) => key));
  const ordered = [];
  let inserted = false;
  for (const entry of registry) {
    if (!ownKeys.has(entry[0])) ordered.push(entry);
    else if (!inserted) {
      ordered.push(...own);
      inserted = true;
    }
  }
  registry.clear();
  for (const [key, value] of ordered) registry.set(key, value);
}

function orderModuleMenus() {
  reorderModuleEntries(game.settings.menus, MODULE_MENU_ORDER);
  reorderModuleEntries(game.settings.settings, MODULE_SETTING_ORDER, { configuredOnly: true });
}

function foundationInitSteps() {
  return compactSteps([
    step("sessionTransfer", "sessionTransfer", "registerSessionTransfer")
  ]);
}

function initSteps() {
  return compactSteps([
    ["blackFlagCompatibility", installBlackFlagCompatibility],
    step("simpleTileTriggers", "simpleTileTriggers", "registerSimpleTileTriggers"),
    step("commerce", "commerce", "registerCommerce"),
    step("chatTimestamps", "chatTimestamps", "installChatTimestamps"),
    step("compendiumUsability", "compendiumUsability", "installCompendiumUsability"),
    step("chatImagePopouts", "chatImagePopouts", "installChatImagePopouts"),
    step("chatMessageDeletion", "chatMessageDeletion", "registerChatMessageDeletion"),
    step("talentBackgrounds", "talentBackgrounds", "registerTalentBackgrounds"),
    step("spellScrolls", "spellScrolls", "installSpellScrollTools"),
    step("spellNameMarkers", "spellNameMarkers", "installSpellNameMarkers"),
    step("concentration", "concentration", "installConcentration"),
    step("effectGroups", "effectGroups", "installEffectGroups"),
    step("tokenPresets", "tokenPresets", "registerTokenPresets"),
    step("playerUnpause", "playerUnpause", "registerPlayerUnpause"),
    step("compendiumLibrary", "compendiumLibrary", "registerCompendiumLibrary"),
    step("dnd5eItemImporter", "dnd5eItemImporter", "registerDnd5eItemImporter"),
    step("weaponCustomization", "weaponCustomization", "registerWeaponCustomization"),
    step("challengeManager", "challengeManager", "registerChallengeManager"),
    step("featurePool", "featurePool", "registerFeaturePoolIntegration"),
    step("tokenSizeSync", "tokenSizeSync", "registerTokenSizeSync"),
    step("creatureBuilder", "creatureBuilder", "registerCreatureBuilder"),
    step("actorDirectoryActivity", "actorDirectoryActivity", "registerActorDirectoryActivity"),
    step("help", "help", "registerHelp"),
    step("settingsCategories", "settingsCategories", "registerSettingsCategories"),
    step("namespaceMigration", "namespaceMigration", "registerNamespaceMigration"),
    step("migrationSettings", "migrations", "registerMigrationSettings"),
    ["downtime", registerDowntime],
    ["voidTaint", registerVoidTaint]
  ]);
}

function readyEarlySteps() {
  return compactSteps([
    step("compatibilityActivation", "compatibility", "activateCompatibilityLayer"),
    step("moduleEventsActivation", "events", "activateModuleEvents"),
    step("simpleTileTriggerActivation", "simpleTileTriggers", "activateSimpleTileTriggers"),
    step("commerceActivation", "commerce", "activateCommerce"),
    step("schedulerActivation", "scheduler", "activateScheduler"),
    step("playerUnpauseActivation", "playerUnpause", "activatePlayerUnpause"),
    step("legacyNamespaceGuard", "namespaceMigration", "installLegacyNamespaceGuard"),
    ["moduleMenuOrder", orderModuleMenus],
    step("challengeManagerActivation", "challengeManager", "activateChallengeManager"),
    step("actorDirectoryActivityActivation", "actorDirectoryActivity", "activateActorDirectoryActivity"),
    step("tokenPresetSocket", "tokenPresets", "activateTokenPresetSocket"),
    step("tokenLightAuraSocket", "tokenLightAura", "activateTokenLightAuraSocket"),
    step("selectedTokenEffectsHud", "selectedTokenEffectsHud", "activateSelectedTokenEffectsHud")
  ]);
}

let initialization = Promise.resolve();

async function initializeModule() {
  await loadFeatures(game.system.id);
  if (game.system.id === "dnd5e") {
    const registerExporter = featureExport("dnd5eBundleExporter", "registerDnd5eBundleExporter");
    if (registerExporter) runStartupStep("dnd5eBundleExporter", registerExporter);
    return;
  }
  if (game.system.id !== "black-flag") return;
  runStartupSteps(foundationInitSteps());
  const installPhase = featureExport("compatibility", "installCompatibilityPhase");
  if (installPhase) {
    for (const phase of ["core", "documentUi", "optionalModules"]) {
      runStartupStep(`compatibility:${phase}`, () => installPhase(phase));
    }
  }
  runStartupSteps(initSteps());
  const registerLinkTools = featureExport("linkTools", "registerLinkTools");
  if (registerLinkTools) queueMicrotask(() => runStartupStep("linkTools", registerLinkTools));
}

async function activateModule() {
  await initialization;
  if (game.system.id !== "black-flag") return;
  runStartupSteps(readyEarlySteps());

  const migrateToolNamespace = featureExport("namespaceMigration", "migrateToolNamespace");
  const namespaceMigrationSucceeded = migrateToolNamespace
    ? await runStartupStepAsync("namespaceMigrationRun", migrateToolNamespace)
    : false;
  await runStartupStepAsync("downtimeActivation", activateDowntime);
  await runStartupStepAsync("voidTaintActivation", activateVoidTaint);
  const activateFeaturePool = featureExport("featurePool", "activateFeaturePoolIntegration");
  if (activateFeaturePool) await runStartupStepAsync("featurePoolActivation", activateFeaturePool);
  const createDrinks = featureExport("effectGroups", "createMagicalDrinkWorldItems");
  if (game.user.isGM && createDrinks) await runStartupStepAsync("magicalDrinkWorldItems", createDrinks);

  const moduleApi = game.modules.get(MODULE_ID)?.api;
  runStartupStep("diagnosticApi", () => Object.assign(moduleApi, {
    compatibility: features.get("compatibility")?.compatibilityApi,
    scheduler: features.get("scheduler")?.schedulerApi,
    startup: startupApi
  }));
  const exposeTransferApi = featureExport("compendiumTransfer", "exposeTransferApi");
  if (exposeTransferApi) runStartupStep("compendiumTransferApi", exposeTransferApi);
  const sessionApi = featureExport("sessionTransfer", "sessionTransferApi");
  if (sessionApi) runStartupStep("sessionTransferApi", () => Object.assign(moduleApi, sessionApi()));
  const creatureApi = featureExport("creatureBuilder", "creatureBuilderApi");
  if (creatureApi) runStartupStep("creatureBuilderApi", () => Object.assign(moduleApi, creatureApi()));
  runStartupStep("moduleApi", () => Object.assign(moduleApi, {
    toggleTokenLightAura: featureExport("tokenLightAura", "toggleTokenLightAura"),
    activityChaining: features.get("activityChaining")?.activityChainingApi,
    effectGroups: features.get("effectGroups")?.effectGroupsApi,
    characterCreationOverrides: features.get("characterCreation")?.characterCreationOverridesApi,
    weaponOptionActivities: features.get("weaponOptions")?.weaponOptionActivitiesApi
  }));

  const runMigrations = featureExport("migrations", "runMigrations");
  if (namespaceMigrationSucceeded && runMigrations) await runStartupStepAsync("migrations", runMigrations);
  featureExport("compatibility", "notifyCompatibilityFailures")?.();
  notifyStartupFailures();
}

// These listeners must remain synchronous top-level registrations. Moving an
// await above them can make Foundry emit init/ready before this module listens.
Hooks.once("init", () => {
  initialization = initializeModule().catch(error => {
    console.error(`${MODULE_ID} | Root initialization failed.`, error);
  });
});

Hooks.once("ready", () => {
  void activateModule().catch(error => {
    console.error(`${MODULE_ID} | Root activation failed.`, error);
    notifyStartupFailures();
  });
});
