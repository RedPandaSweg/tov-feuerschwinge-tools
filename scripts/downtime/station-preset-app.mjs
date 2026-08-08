import { FLAGS, MODULE_ID, SETTINGS } from "./constants.mjs";
import { createRecipeDocumentFromTemplate } from "./recipe-service.mjs";
import { STATION_PRESETS, stationPresetDescriptionKey, stationPresetNameKey } from "./station-presets.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";
import { configuredCategories, defaultStationData } from "./utils.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function actorType() {
  const types = Object.keys(CONFIG.Actor?.dataModels ?? CONFIG.Actor?.typeLabels ?? {});
  return types.includes("npc") ? "npc" : types[0];
}

async function getStationFolder() {
  let folder = game.folders.find(candidate =>
    candidate.type === "Actor" &&
    candidate.getFlag?.(MODULE_ID, FLAGS.STATION_FOLDER)
  );
  if (folder) return folder;
  folder = await Folder.create({
    name: game.i18n.localize("DOWNTIME_MANAGER.StationPresets.FolderName"),
    type: "Actor",
    folder: null,
    flags: {
      [MODULE_ID]: {
        [FLAGS.STATION_FOLDER]: true
      }
    }
  });
  if (!folder) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.StationFolderFailed"));
  return folder;
}

export class StationPresetApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-station-presets",
    classes: ["downtime-manager", "station-preset-app"],
    position: { width: 720, height: 720 },
    window: { title: "DOWNTIME_MANAGER.StationPresets.Title", resizable: true },
    actions: { importPreset: StationPresetApp.#importPreset }
  };

  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/station-presets.hbs" } };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      presets: STATION_PRESETS.map(preset => ({
        ...preset,
        name: game.i18n.localize(stationPresetNameKey(preset.id)),
        description: game.i18n.localize(stationPresetDescriptionKey(preset.id)),
        imported: Array.from(game.actors).some(actor => actor.getFlag?.(MODULE_ID, "preset")?.stationId === preset.id)
      }))
    };
  }

  static async #importPreset(event, target) {
    const preset = STATION_PRESETS.find(entry => entry.id === target.dataset.presetId);
    if (!preset) return;
    target.disabled = true;
    try {
      const includeProject = Boolean(this.element.querySelector(`[data-project-for="${CSS.escape(preset.id)}"]`)?.checked);
      const categories = configuredCategories();
      if (!categories.some(category => category.id === preset.category)) {
        await game.settings.set(MODULE_ID, SETTINGS.STATION_CATEGORIES, {
          entries: [...categories, {
            id: preset.category,
            label: preset.category.replace(/(^|-)(\p{L})/gu, (_match, separator, letter) => `${separator ? " " : ""}${letter.toUpperCase()}`)
          }]
        });
      }
      const station = foundry.utils.mergeObject(defaultStationData(), preset.stationConfig ?? {}, { inplace: false, recursive: true });
      if (preset.allChecks) {
        station.allowedChecks = getSystemAdapter().getCheckDefinitions().map(({ type, key }) => ({ type, key }));
      } else if (preset.stationConfig?.allowedChecks) station.allowedChecks = foundry.utils.deepClone(preset.stationConfig.allowedChecks);
      if (preset.stationConfig?.rollTable) station.rollTable = foundry.utils.deepClone(preset.stationConfig.rollTable);
      if (preset.stationConfig?.requiredTool !== undefined) station.requiredTool = foundry.utils.deepClone(preset.stationConfig.requiredTool);
      if (preset.stationConfig?.actorValue) {
        station.actorValue = foundry.utils.mergeObject(station.actorValue, preset.stationConfig.actorValue, { inplace: false, recursive: true });
        if (preset.stationConfig.actorValue.tiers) station.actorValue.tiers = foundry.utils.deepClone(preset.stationConfig.actorValue.tiers);
      }
      if (preset.stationConfig?.progressSources) station.progressSources = foundry.utils.mergeObject(station.progressSources, preset.stationConfig.progressSources, { inplace: false, recursive: true });
      if (preset.stationConfig?.baseProgress !== undefined) station.baseProgress = preset.stationConfig.baseProgress;
      if (preset.stationConfig?.rollInterval !== undefined) station.rollInterval = preset.stationConfig.rollInterval;
      if (preset.stationConfig?.requiresRoll !== undefined) station.requiresRoll = preset.stationConfig.requiresRoll;
      station.displayName = game.i18n.localize(stationPresetNameKey(preset.id));
      station.description = game.i18n.localize(stationPresetDescriptionKey(preset.id));
      station.categories = [preset.category];
      if (includeProject) {
        const project = await createRecipeDocumentFromTemplate(preset.projectTemplate, {
          name: game.i18n.format("DOWNTIME_MANAGER.StationPresets.ProjectName", { station: station.displayName }),
          categories: [preset.category],
          presetProjectId: `${preset.id}:default`
        });
        station.recipes = [project.uuid];
      }
      const folder = await getStationFolder();
      const actor = await Actor.create({
        name: station.displayName,
        type: actorType(),
        img: preset.img,
        folder: folder.id,
        flags: {
          [MODULE_ID]: {
            [FLAGS.STATION]: station,
            preset: { type: "station", stationId: preset.id, version: 1 }
          }
        }
      }, { renderSheet: false });
      if (!actor) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.StationPresetCreateFailed"));
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.StationPresets.Imported", { station: actor.name }));
      this.render();
    } catch (error) {
      ui.notifications.error(error.message);
      target.disabled = false;
    }
  }
}
