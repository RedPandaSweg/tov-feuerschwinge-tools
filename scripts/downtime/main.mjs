import {
  createDefaultSessionRewards,
  createDefaultStationCategories,
  DEFAULT_MILESTONE_CATCH_UP,
  DEFAULT_MILESTONE_LEVEL_BANDS,
  DEFAULT_PASSIVE_DOWNTIME,
  DEFAULT_RECIPE_BASE_ITEM_UUID,
  FLAGS,
  MODULE_ID,
  SETTINGS
} from "./constants.mjs";
import { StationApp } from "./station-app.mjs";
import { StationConfigApp } from "./station-config-app.mjs";
import { ModuleItemSettingsApp } from "./module-item-settings-app.mjs";
import { HelpApp } from "./help-app.mjs";
import { ProjectLibraryApp } from "./project-library-app.mjs";
import { DowntimeDashboardApp } from "./dashboard-app.mjs";
import { getSystemAdapter, registerSystemAdapter } from "./system-adapter.mjs";
import { SessionApp } from "./session-app.mjs";
import { DowntimeItemApp } from "./downtime-item-app.mjs";
import { StationPresetApp } from "./station-preset-app.mjs";
import { playerCharacters, sessionProgress, SessionService } from "./session-service.mjs";
import { registerSharedProjectSocket } from "./shared-project-socket.mjs";
import { downtimeItemData, DowntimeItemService } from "./downtime-item-service.mjs";
import { addHeaderControl, defaultStationData, isRecipeItem, isStation } from "./utils.mjs";
import {
  configureAsRecipe,
  createRecipeFromBaseItem,
  openRecipeEditor
} from "./recipe-service.mjs";
import { MIGRATION_SETTING, migrateIntegratedDowntime } from "./migration.mjs";
import { openChallengeManager } from "../challenge-manager.mjs";
import { openFeuerschwingeSettings } from "../settings-categories.mjs";
import { GMToolsApp } from "./gm-tools-app.mjs";
import { isCompendiumItem, synchronizeCompendiumItem } from "../item-compendium-sync.mjs";

function documentFromApp(app, documentName) {
  const document =
    app?.actor ??
    app?.item ??
    app?.document ??
    app?.object;

  return document?.documentName === documentName
    ? document
    : null;
}

function openStation(actor) {
  if (!isStation(actor)) {
    return ui.notifications.warn(
      game.i18n.localize("DOWNTIME_MANAGER.Errors.NotStation")
    );
  }

  new StationApp(actor).render(true);
}

function openDashboard() {
  if (game.user.isGM) new DowntimeDashboardApp().render(true);
}

function openSessionManager() {
  if (!game.user.isGM) return;
  if (game.settings.get(MODULE_ID, "worldRole") !== "primary") {
    return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.PrimaryOnly"));
  }
  new SessionApp().render(true);
}

function openProjectLibrary() {
  if (game.user.isGM) new ProjectLibraryApp().render(true);
}

function openGMTools() {
  if (game.user.isGM) new GMToolsApp().render(true);
}

async function configureStation(actor, app = null) {
  if (game.user.isGM) {
    if (!isStation(actor)) {
      await actor.setFlag(MODULE_ID, FLAGS.STATION, defaultStationData());
      app?.render?.();
    }
    new StationConfigApp(actor).render(true);
  }
}

function registerTokenDoubleClick() {
  const TokenClass = CONFIG.Token.objectClass;
  const prototype = TokenClass?.prototype;

  if (!prototype) {
    console.error(`${MODULE_ID} | Token class is unavailable.`);
    return;
  }

  if (prototype.__downtimeManagerDoubleClickPatched) return;

  const originalDoubleClick = prototype._onClickLeft2;
  const originalCanView = prototype._canView;

  if (typeof originalDoubleClick !== "function" || typeof originalCanView !== "function") {
    console.error(
      `${MODULE_ID} | Token interaction methods are unavailable.`
    );
    return;
  }

  Object.defineProperty(
    prototype,
    "__downtimeManagerDoubleClickPatched",
    {
      value: true,
      configurable: true
    }
  );

  // Foundry checks _canView before dispatching a token double-click. Station
  // Actors normally are not owned by players, so their double-click handler
  // would otherwise never run even though the station UI is player-facing.
  prototype._canView = function (user, event) {
    if (isStation(this.actor)) {
      if (!this.layer?.active) return false;
      if (canvas.regions?._placementContext) return false;
      if (this.layer._draggedToken) return false;
      if (canvas.controls?.ruler?.active) return false;
      if (CONFIG.Canvas.rulerClass.canMeasure && event?.type === "pointerdown") return false;
      return true;
    }

    return originalCanView.call(this, user, event);
  };

  prototype._onClickLeft2 = function (event) {
    if (isStation(this.actor)) {
      event?.stopPropagation?.();
      openStation(this.actor);
      return;
    }

    return originalDoubleClick.call(this, event);
  };

}

Hooks.once("init", async () => {
  if (game.system.id !== "black-flag") return;
  registerTokenDoubleClick();

  await loadTemplates();

  game.settings.register(MODULE_ID, SETTINGS.ACTIVE_SESSION, { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, SETTINGS.LAST_SESSION_RESULT, { scope: "world", config: false, type: Object, default: {} });
  game.settings.register(MODULE_ID, SETTINGS.SESSION_REWARDS, { scope: "world", config: false, type: Object, default: createDefaultSessionRewards(getSystemAdapter().getDefaultGoldItemUuid()) });
  game.settings.register(MODULE_ID, SETTINGS.SESSION_HISTORY_JOURNAL, { scope: "world", config: false, type: String, default: "" });
  game.settings.register(MODULE_ID, SETTINGS.SESSION_HISTORY, { scope: "world", config: false, type: Object, default: { schemaVersion: 1, entries: [] } });
  game.settings.register(MODULE_ID, SETTINGS.SESSION_HISTORY_ENABLED, {
    name: "DOWNTIME_MANAGER.Settings.SessionHistory.Name",
    hint: "DOWNTIME_MANAGER.Settings.SessionHistory.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true
  });
  game.settings.register(MODULE_ID, SETTINGS.STATION_CATEGORIES, {
    name: "DOWNTIME_MANAGER.Settings.StationCategories.Name",
    hint: "DOWNTIME_MANAGER.Settings.StationCategories.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: {
      entries: createDefaultStationCategories(getSystemAdapter().getCheckDefinitions().map(check => ({
        ...check,
        label: check.localized ? game.i18n.localize(check.label) : game.i18n.localize(check.label)
      })))
    }
  });
  game.settings.register(MODULE_ID, SETTINGS.PLAYER_ACTOR_FOLDERS, {
    name: "DOWNTIME_MANAGER.Settings.PlayerActorFolders.Name",
    hint: "DOWNTIME_MANAGER.Settings.PlayerActorFolders.Hint",
    scope: "world",
    config: false,
    type: Object,
    default: { folderId: "" }
  });
  game.settings.register(MODULE_ID, SETTINGS.PASSIVE_DOWNTIME, {
    scope: "world", config: false, type: Object,
    default: foundry.utils.deepClone(DEFAULT_PASSIVE_DOWNTIME)
  });
  game.settings.register(MODULE_ID, SETTINGS.MILESTONE_LEVEL_BANDS, {
    scope: "world", config: false, type: Object,
    default: { entries: foundry.utils.deepClone(DEFAULT_MILESTONE_LEVEL_BANDS) }
  });
  game.settings.register(MODULE_ID, SETTINGS.MILESTONE_CATCH_UP, {
    scope: "world", config: false, type: Object,
    default: foundry.utils.deepClone(DEFAULT_MILESTONE_CATCH_UP)
  });
  game.settings.register(MODULE_ID, SETTINGS.LAST_DIRECT_DOWNTIME_ALL, {
    scope: "world", config: false, type: Object, default: {}
  });
  game.settings.register(MODULE_ID, SETTINGS.GM_TOOL_UNDO, {
    scope: "world", config: false, type: Object, default: {}
  });
  game.settings.register(MODULE_ID, MIGRATION_SETTING, {
    scope: "world", config: false, type: Number, default: 0
  });

  game.settings.register(MODULE_ID, SETTINGS.RECIPE_BASE_ITEM_UUID, {
    name: "DOWNTIME_MANAGER.Settings.ProjectBaseItem.Name",
    hint: "DOWNTIME_MANAGER.Settings.ProjectBaseItem.Hint",
    scope: "world",
    config: false,
    type: String,
    default: DEFAULT_RECIPE_BASE_ITEM_UUID
  });

  game.settings.register(MODULE_ID, SETTINGS.DEFAULT_COST_ITEM_UUID, {
    name: "DOWNTIME_MANAGER.Settings.DefaultCostItem.Name",
    hint: "DOWNTIME_MANAGER.Settings.DefaultCostItem.Hint",
    scope: "world",
    config: false,
    type: String,
    default: getSystemAdapter().getDefaultGoldItemUuid()
  });

  game.settings.registerMenu(MODULE_ID, "itemDefaults", {
    name: "DOWNTIME_MANAGER.Settings.ModuleConfig.Name",
    label: "DOWNTIME_MANAGER.Settings.ModuleConfig.Label",
    hint: "DOWNTIME_MANAGER.Settings.ModuleConfig.Hint",
    icon: "fa-solid fa-box-open",
    type: ModuleItemSettingsApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "projectLibrary", {
    name: "DOWNTIME_MANAGER.ProjectLibrary.SettingName",
    label: "DOWNTIME_MANAGER.ProjectLibrary.SettingLabel",
    hint: "DOWNTIME_MANAGER.ProjectLibrary.SettingHint",
    icon: "fa-solid fa-scroll",
    type: ProjectLibraryApp,
    restricted: true
  });

  game.settings.registerMenu(MODULE_ID, "stationPresets", {
    name: "DOWNTIME_MANAGER.StationPresets.SettingName",
    label: "DOWNTIME_MANAGER.StationPresets.SettingLabel",
    hint: "DOWNTIME_MANAGER.StationPresets.SettingHint",
    icon: "fa-solid fa-shop",
    type: StationPresetApp,
    restricted: true
  });

});

Hooks.once("ready", async () => {
  if (game.system.id !== "black-flag") return;
  await migrateIntegratedDowntime();
  if (game.user.isGM && !game.settings.get(MODULE_ID, SETTINGS.RECIPE_BASE_ITEM_UUID)) {
    await game.settings.set(MODULE_ID, SETTINGS.RECIPE_BASE_ITEM_UUID, DEFAULT_RECIPE_BASE_ITEM_UUID);
  }
  const sessionRewards = game.settings.get(MODULE_ID, SETTINGS.SESSION_REWARDS);
  if (game.user.isGM && Number(sessionRewards?.schemaVersion ?? 0) < 2) {
    await game.settings.set(
      MODULE_ID,
      SETTINGS.SESSION_REWARDS,
      createDefaultSessionRewards(getSystemAdapter().getDefaultGoldItemUuid())
    );
  }
  registerSharedProjectSocket();
  const storedCategories = game.settings.get(MODULE_ID, SETTINGS.STATION_CATEGORIES);
  if (!Array.isArray(storedCategories?.entries) || storedCategories.entries.some(category => !category || typeof category !== "object")) {
    const checks = getSystemAdapter().getCheckDefinitions().map(check => ({
      ...check,
      label: check.localized ? check.label : game.i18n.localize(check.label)
    }));
    await game.settings.set(MODULE_ID, SETTINGS.STATION_CATEGORIES, { entries: createDefaultStationCategories(checks) });
  } else if (storedCategories.entries.some(category => String(category.id).startsWith("tool:"))) {
    const checks = getSystemAdapter().getCheckDefinitions();
    const semantic = createDefaultStationCategories(checks);
    const preserved = storedCategories.entries.filter(category => !String(category.id).startsWith("tool:"));
    const ids = new Set(preserved.map(category => category.id));
    await game.settings.set(MODULE_ID, SETTINGS.STATION_CATEGORIES, {
      entries: [...preserved, ...semantic.filter(category => !ids.has(category.id))]
    });
  }
  getSystemAdapter().registerHooks({
    redeemDowntimeItem: (item, options) => DowntimeItemService.redeem(item, options)
  });
  const api = {
    openStation,
    configureStation,
    openRecipeEditor,
    configureAsRecipe,
    createRecipeFromBaseItem,
    openDashboard,
    openSessionManager,
    openProjectLibrary,
    openGMTools,
    openStationPresets: () => game.user.isGM && new StationPresetApp().render(true),
    getSystemAdapter,
    registerSystemAdapter,
    getPlayerCharacters: () => playerCharacters(),
    getCharacterProgress: actor => foundry.utils.deepClone(sessionProgress(actor)),
    getActiveSession: () => foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {}),
    getLastSessionResult: () => foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.LAST_SESSION_RESULT) ?? {}),
    getSessionHistory: () => foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY) ?? { schemaVersion: 1, entries: [] }),
    importSessionResult: result => game.settings.set(MODULE_ID, SETTINGS.LAST_SESSION_RESULT, foundry.utils.deepClone(result ?? {})),
    SessionService
  };
  game.feuerschwinge = api;
  game.downtimeManager = api;
  const module = game.modules.get(MODULE_ID);
  if (module) Object.assign(module.api ??= {}, api);
});

async function loadTemplates() {
  return foundry.applications.handlebars.loadTemplates([
    "modules/tov-feuerschwinge-tools/templates/downtime/partials/item-list.hbs",
    "modules/tov-feuerschwinge-tools/templates/downtime/partials/category-picker.hbs",
  ]);
}

function actorHeaderControls(app, controls) {
  if (!game.user.isGM) return;

  const actor = documentFromApp(app, "Actor");
  if (!actor) return;

  addHeaderControl(controls, {
    action: "downtime-manager-configure-station",
    icon: "fa-solid fa-hammer",
    label: game.i18n.localize(isStation(actor)
      ? "DOWNTIME_MANAGER.Headers.ConfigureStation"
      : "DOWNTIME_MANAGER.Headers.MakeStation"),
    visible: true,
    onClick: () => configureStation(actor, app)
  });

  if (isStation(actor)) {
    addHeaderControl(controls, {
      action: "downtime-manager-open-station",
      icon: "fa-solid fa-screwdriver-wrench",
      label: game.i18n.localize("DOWNTIME_MANAGER.Headers.OpenStation"),
      visible: true,
      onClick: () => openStation(actor)
    });
  }
}

function itemHeaderControls(app, controls) {
  const item = documentFromApp(app, "Item");
  if (!item || !game.user.isGM) return;
  const isDowntimeItem = Boolean(downtimeItemData(item));

  addHeaderControl(controls, {
    action: "tov-feuerschwinge-item-actions",
    icon: "fa-solid fa-fire-flame-curved",
    label: game.i18n.localize("DOWNTIME_MANAGER.Headers.Feuerschwinge"),
    visible: true,
    onClick: async () => {
      try {
        const buttons = [{
          action: "downtime",
          icon: isRecipeItem(item) ? "fa-solid fa-scroll" : "fa-solid fa-hourglass-half",
          label: game.i18n.localize(
            isRecipeItem(item)
              ? "DOWNTIME_MANAGER.Headers.ConfigureProject"
              : isDowntimeItem
                ? "DOWNTIME_MANAGER.DowntimeItem.Configure"
                : "DOWNTIME_MANAGER.DowntimeItem.ConfigureGeneric"
          ),
          callback: () => "downtime"
        }];

        if (isCompendiumItem(item)) {
          buttons.push({
            action: "synchronize",
            icon: "fa-solid fa-arrows-rotate",
            label: game.i18n.localize("DOWNTIME_MANAGER.ItemSync.Action"),
            callback: () => "synchronize"
          });
        }

        const action = await foundry.applications.api.DialogV2.wait({
          window: {
            title: game.i18n.localize("DOWNTIME_MANAGER.Headers.Feuerschwinge")
          },
          buttons,
          rejectClose: false
        });

        if (action === "synchronize") {
          await synchronizeCompendiumItem(item);
        } else if (action === "downtime") {
          if (isRecipeItem(item)) openRecipeEditor(item);
          else new DowntimeItemApp(item).render(true);
        }
      } catch (error) {
        console.error(error);
        ui.notifications.error(error.message);
      }
    }
  });
}

Hooks.on("getHeaderControlsActorSheetV2", actorHeaderControls);
Hooks.on("getHeaderControlsItemSheetV2", itemHeaderControls);

Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  actorHeaderControls(app, controls);
  itemHeaderControls(app, controls);
});

Hooks.on("getSceneControlButtons", controls => {
  if (game.system.id !== "black-flag" || !game.user.isGM) return;

  controls.feuerschwinge = {
    name: "feuerschwinge",
    order: 999,
    title: "DOWNTIME_MANAGER.Controls.Title",
    icon: "fa-solid fa-fire-flame-curved",
    tools: {
      dashboard: {
        name: "dashboard",
        order: 1,
        title: "DOWNTIME_MANAGER.Controls.OpenDashboard",
        icon: "fa-solid fa-chart-simple",
        button: true,
        onChange: openDashboard
      },
      session: {
        name: "session",
        order: 2,
        title: "DOWNTIME_MANAGER.Controls.OpenSessionManager",
        icon: "fa-solid fa-campground",
        button: true,
        onChange: openSessionManager
      },
      challenge: {
        name: "challenge",
        order: 3,
        title: "TOVF.ChallengeManager.Open",
        icon: "fa-solid fa-skull-crossbones",
        button: true,
        onChange: openChallengeManager
      },
      gmTools: {
        name: "gmTools",
        order: 4,
        title: "DOWNTIME_MANAGER.GMTools.Open",
        icon: "fa-solid fa-screwdriver-wrench",
        button: true,
        onChange: openGMTools
      },
      settings: {
        name: "settings",
        order: 5,
        title: "TOVF.Controls.OpenSettings",
        icon: "fa-solid fa-gear",
        button: true,
        onChange: openFeuerschwingeSettings
      }
    },
    activeTool: null
  };
});
