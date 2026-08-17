import { MODULE_ID } from "./core/constants.mjs";
import { registerMigrationSettings, runMigrations } from "./core/migrations.mjs";
import {
  installLegacyNamespaceGuard,
  migrateToolNamespace,
  registerNamespaceMigration
} from "./core/namespace-migration.mjs";
import { exposeTransferApi } from "./transfer/compendium-transfer.mjs?v=3.1.2";
import { registerSessionTransfer, sessionTransferApi } from "./transfer/session-transfer.mjs";
import { installBlackFlagCompatibility } from "./integrations/black-flag-compatibility.mjs?v=3.3.0-spell-manager-tooltips-2";
import {
  characterCreationOverridesApi,
  installCharacterCreationOverrides
} from "./integrations/character-creation-overrides.mjs";
import {
  installWeaponOptionActivities,
  weaponOptionActivitiesApi
} from "./integrations/weapon-option-activities.mjs?v=3.2.4-tooltip-links-2";
import { installArgonBlackFlagCompatibility } from "./integrations/argon-black-flag-compatibility.mjs?v=3.2.7-movement-hud-1";
import { activatePlayerUnpause, registerPlayerUnpause } from "./player-unpause.mjs";
import { registerCompendiumLibrary } from "./compendium-library.mjs?v=3.2.7-void-spells-1";
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
import { activityChainingApi, installActivityChaining } from "./activity-chaining.mjs?v=3.2.4-follow-up-flags";
import { installToolAbilitySelection } from "./integrations/tool-ability.mjs";
import { installTheurgeSpellcasting } from "./integrations/theurge-spellcasting.mjs?v=3.3.0-manual-theurge-mode-1";
import { installCompendiumUsability } from "./compendium-usability.mjs";
import { installChatImagePopouts } from "./chat-image-popout.mjs";
import { registerChatMessageDeletion } from "./chat-message-deletion.mjs";
import { createMagicalDrinkWorldItems, effectGroupsApi, installEffectGroups } from "./effect-groups.mjs?v=3.2.5-effect-groups-7";
import { activateTokenPresetSocket, registerTokenPresets } from "./token-presets.mjs";
import { activateSimpleTileTriggers, registerSimpleTileTriggers } from "./simple-tile-triggers.mjs?v=3.2.2";
import { activateCommerce, registerCommerce } from "./commerce/main.mjs?v=3.2.7-rolltable-stock-2";
import "./downtime/main.mjs?v=3.3.0-void-taint-1";
import "./contested-activity.mjs";
import "./void-taint/main.mjs?v=3.3.0-void-taint-1";
import { registerTalentBackgrounds } from "./talent-backgrounds.mjs?v=3.3.0-talent-backgrounds-4";
import { installCustomBackground } from "./integrations/custom-background.mjs?v=3.3.1-custom-background-13";

// Keep tile triggers independent from the shared initialization chain so an
// unrelated tool cannot prevent their hooks and diagnostics from registering.
registerSimpleTileTriggers();
Hooks.once("ready", activateSimpleTileTriggers);
registerCommerce();
Hooks.once("ready", activateCommerce);

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
  installTheurgeSpellcasting();
  installCompendiumUsability();
  installChatImagePopouts();
  registerChatMessageDeletion();
  registerTalentBackgrounds();
  installCustomBackground();
  installEffectGroups();
  registerTokenPresets();
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
  activateTokenPresetSocket();
  await activateFeaturePoolIntegration();
  if (game.user.isGM) {
    try {
      await createMagicalDrinkWorldItems();
    } catch (error) {
      console.error(`${MODULE_ID} | Creating magical drink World Items failed.`, error);
      ui.notifications.error(`Magische Getränke konnten nicht angelegt werden: ${error.message}`);
    }
  }
  exposeTransferApi();
  Object.assign(game.modules.get(MODULE_ID).api, sessionTransferApi());
  Object.assign(game.modules.get(MODULE_ID).api, creatureBuilderApi());
  Object.assign(game.modules.get(MODULE_ID).api, {
    activityChaining: activityChainingApi,
    effectGroups: effectGroupsApi,
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
