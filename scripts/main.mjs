import { MODULE_ID } from "./core/constants.mjs";
import { registerMigrationSettings, runMigrations } from "./core/migrations.mjs";
import {
  installLegacyNamespaceGuard,
  migrateToolNamespace,
  registerNamespaceMigration
} from "./core/namespace-migration.mjs";
import { exposeTransferApi } from "./transfer/compendium-transfer.mjs";
import { registerSessionTransfer, sessionTransferApi } from "./transfer/session-transfer.mjs";
import { installBlackFlagCompatibility } from "./integrations/black-flag-compatibility.mjs";
import {
  characterCreationOverridesApi,
  installCharacterCreationOverrides
} from "./integrations/character-creation-overrides.mjs";
import {
  installWeaponOptionActivities,
  weaponOptionActivitiesApi
} from "./integrations/weapon-option-activities.mjs";
import { installArgonBlackFlagCompatibility } from "./integrations/argon-black-flag-compatibility.mjs";
import { activatePlayerUnpause, registerPlayerUnpause } from "./player-unpause.mjs";
import { registerCompendiumLibrary } from "./compendium-library.mjs";
import { activateChallengeManager, registerChallengeManager } from "./challenge-manager.mjs";
import { registerLinkTools } from "./link-tools-config.mjs";
import { registerHelp } from "./help-config.mjs";
import {
  activateFeaturePoolIntegration,
  registerFeaturePoolIntegration
} from "./feature-pool-integration.mjs";
import { registerTokenSizeSync } from "./token-size-sync.mjs";
import { creatureBuilderApi, registerCreatureBuilder } from "./creature-builder.mjs";
import { registerSettingsCategories } from "./settings-categories.mjs";
import { activityChainingApi, installActivityChaining } from "./activity-chaining.mjs";
import { installToolAbilitySelection } from "./integrations/tool-ability.mjs";
import { installCompendiumUsability } from "./compendium-usability.mjs";
import "./downtime/main.mjs";
import "./contested-activity.mjs";

const MODULE_MENU_ORDER = new Map([
  ["help", 0],
  ["creatureBuilder", 10],
  ["sessionTransfer", 20],
  ["characterLinkTools", 40],
  ["weaponCustomization", 50],
  ["itemDefaults", 60],
  ["projectLibrary", 70],
  ["stationPresets", 80]
]);

const MODULE_SETTING_ORDER = new Map([
  ["worldRole", 0],
  ["automaticTokenSizing", 10],
  ["unpauseWithoutGM", 20],
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
    if (!ownKeys.has(entry[0])) {
      ordered.push(entry);
      continue;
    }
    if (!inserted) ordered.push(...own);
    inserted = true;
  }
  registry.clear();
  for (const [key, value] of ordered) registry.set(key, value);
}

function orderModuleMenus() {
  reorderModuleEntries(game.settings.menus, MODULE_MENU_ORDER);
  reorderModuleEntries(game.settings.settings, MODULE_SETTING_ORDER, { configuredOnly: true });
}

Hooks.once("init", () => {
  if (game.system.id !== "black-flag") return;
  registerHelp();
  installBlackFlagCompatibility();
  installCharacterCreationOverrides();
  installWeaponOptionActivities();
  installActivityChaining();
  installToolAbilitySelection();
  installCompendiumUsability();
  installArgonBlackFlagCompatibility();
  registerPlayerUnpause();
  registerCompendiumLibrary();
  registerChallengeManager();
  registerFeaturePoolIntegration();
  registerTokenSizeSync();
  registerCreatureBuilder();
  registerSettingsCategories();
  registerNamespaceMigration();
  registerMigrationSettings();
  registerSessionTransfer();
  queueMicrotask(registerLinkTools);
});

Hooks.once("ready", async () => {
  if (game.system.id !== "black-flag") return;
  let namespaceMigrationSucceeded = true;
  try {
    await migrateToolNamespace();
  } catch (error) {
    namespaceMigrationSucceeded = false;
    console.error(`${MODULE_ID} | Namespace migration failed`, error);
    ui.notifications.error(`Feuerschwinge-Tools: Die Übernahme alter Einstellungen und Flags ist fehlgeschlagen: ${error.message}`, { permanent: true });
  }
  installLegacyNamespaceGuard();
  orderModuleMenus();
  activatePlayerUnpause();
  activateChallengeManager();
  await activateFeaturePoolIntegration();
  exposeTransferApi();
  Object.assign(game.modules.get(MODULE_ID).api, sessionTransferApi());
  Object.assign(game.modules.get(MODULE_ID).api, creatureBuilderApi());
  Object.assign(game.modules.get(MODULE_ID).api, {
    activityChaining: activityChainingApi,
    characterCreationOverrides: characterCreationOverridesApi,
    weaponOptionActivities: weaponOptionActivitiesApi
  });
  if (namespaceMigrationSucceeded) {
    try {
      await runMigrations();
    } catch (error) {
      console.error(`${MODULE_ID} | Migration failed`, error);
      ui.notifications.error(game.i18n.format("TOVF.Migration.Error", { message: error.message }));
    }
  }
});
