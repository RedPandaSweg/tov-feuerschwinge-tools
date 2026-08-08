import { DEFAULT_MILESTONE_LEVEL_BANDS, MODULE_ID, SETTINGS } from "./constants.mjs";
import { configuredCategories } from "./utils.mjs";
import { normalizeMilestoneLevelBands } from "./session-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

async function resolveItem(uuid) {
  if (!uuid) return null;
  const item = await fromUuid(uuid);
  return item?.documentName === "Item" ? item : null;
}

export class ModuleItemSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-item-settings",
    classes: ["downtime-manager", "module-item-settings"],
    tag: "form",
    position: { width: 620, height: 760 },
    window: { title: "DOWNTIME_MANAGER.Settings.ModuleConfig.Title", resizable: true },
    form: { handler: ModuleItemSettingsApp.#submit, closeOnSubmit: false },
    actions: {
      clearItem: ModuleItemSettingsApp.#clearItem,
      addCategory: ModuleItemSettingsApp.#addCategory,
      removeCategory: ModuleItemSettingsApp.#removeCategory,
      addMilestoneBand: ModuleItemSettingsApp.#addMilestoneBand,
      removeMilestoneBand: ModuleItemSettingsApp.#removeMilestoneBand,
      resetMilestoneBands: ModuleItemSettingsApp.#resetMilestoneBands
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/module-item-settings.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    if (!this._draft) {
      this._draft = {
        recipeBaseItemUuid: String(game.settings.get(MODULE_ID, SETTINGS.RECIPE_BASE_ITEM_UUID) ?? ""),
        defaultCostItemUuid: String(game.settings.get(MODULE_ID, SETTINGS.DEFAULT_COST_ITEM_UUID) ?? ""),
        categories: configuredCategories(),
        milestoneCatchUp: game.settings.get(MODULE_ID, SETTINGS.MILESTONE_CATCH_UP)?.enabled !== false,
        milestoneBands: normalizeMilestoneLevelBands(game.settings.get(MODULE_ID, SETTINGS.MILESTONE_LEVEL_BANDS))
      };
    }
    const baseItem = await resolveItem(this._draft.recipeBaseItemUuid);
    const costItem = await resolveItem(this._draft.defaultCostItemUuid);
    return {
      ...context,
      categories: this._draft.categories,
      milestoneBands: this._draft.milestoneBands,
      milestoneCatchUp: this._draft.milestoneCatchUp,
      fields: [
        {
          setting: "recipeBaseItemUuid",
          label: game.i18n.localize("DOWNTIME_MANAGER.Settings.ProjectBaseItem.Name"),
          hint: game.i18n.localize("DOWNTIME_MANAGER.Settings.ProjectBaseItem.Hint"),
          uuid: this._draft.recipeBaseItemUuid,
          item: baseItem
        },
        {
          setting: "defaultCostItemUuid",
          label: game.i18n.localize("DOWNTIME_MANAGER.Settings.DefaultCostItem.Name"),
          hint: game.i18n.localize("DOWNTIME_MANAGER.Settings.DefaultCostItem.Hint"),
          uuid: this._draft.defaultCostItemUuid,
          item: costItem
        }
      ]
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const zone of this.element.querySelectorAll(".setting-item-drop")) {
      zone.addEventListener("dragover", event => event.preventDefault());
      zone.addEventListener("drop", event => this.#dropItem(event, zone.dataset.setting));
    }
  }

  async #dropItem(event, setting) {
    event.preventDefault();
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    const item = data.type === "Item" ? await Item.implementation.fromDropData(data) : null;
    if (!item?.uuid) {
      return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Errors.DropItem"));
    }
    this.#captureDraft();
    this._draft[setting] = item.uuid;
    this.render();
  }

  static #clearItem(event, target) {
    this.#captureDraft();
    this._draft[target.dataset.setting] = "";
    this.render();
  }

  static #addCategory() {
    this.#captureDraft();
    this._draft.categories.push({ id: "", label: "" });
    this.render();
  }

  static #removeCategory(event, target) {
    this.#captureDraft();
    this._draft.categories.splice(Number(target.dataset.index), 1);
    this.render();
  }

  static #addMilestoneBand() {
    this.#captureDraft();
    const previous = this._draft.milestoneBands.at(-1);
    const minLevel = Math.min(20, Number(previous?.maxLevel ?? 0) + 1);
    this._draft.milestoneBands.push({ minLevel, maxLevel: minLevel, sessions: 1 });
    this.render();
  }

  static #removeMilestoneBand(event, target) {
    this.#captureDraft();
    this._draft.milestoneBands.splice(Number(target.dataset.index), 1);
    this.render();
  }

  static #resetMilestoneBands() {
    this.#captureDraft();
    this._draft.milestoneBands = foundry.utils.deepClone(DEFAULT_MILESTONE_LEVEL_BANDS);
    this.render();
  }

  #captureCategories() {
    this._draft.categories = this._draft.categories.map((category, index) => ({
      id: String(this.element?.querySelector(`[name="categories.${index}.id"]`)?.value ?? category.id),
      label: String(this.element?.querySelector(`[name="categories.${index}.label"]`)?.value ?? category.label)
    }));
  }

  #captureDraft() {
    this.#captureCategories();
    this._draft.milestoneBands = this._draft.milestoneBands.map((band, index) => ({
      minLevel: Number(this.element?.querySelector(`[name="milestoneBands.${index}.minLevel"]`)?.value ?? band.minLevel),
      maxLevel: Number(this.element?.querySelector(`[name="milestoneBands.${index}.maxLevel"]`)?.value ?? band.maxLevel),
      sessions: Number(this.element?.querySelector(`[name="milestoneBands.${index}.sessions"]`)?.value ?? band.sessions)
    }));
    this._draft.milestoneCatchUp = Boolean(this.element?.querySelector('[name="milestoneCatchUp"]')?.checked);
  }

  static async #submit() {
    this.#captureDraft();
    const categories = this._draft.categories.map((category, index) => ({
      id: String(category.id ?? "").trim().toLowerCase(),
      label: String(category.label ?? "").trim()
    })).filter(category => category.id && category.label);
    const unique = categories.filter((category, index) => categories.findIndex(entry => entry.id === category.id) === index);
    const milestoneBands = normalizeMilestoneLevelBands({ entries: this._draft.milestoneBands });
    const submittedBands = this._draft.milestoneBands.map(entry => ({
      minLevel: Math.floor(Number(entry.minLevel)), maxLevel: Math.floor(Number(entry.maxLevel)), sessions: Math.floor(Number(entry.sessions))
    })).sort((a, b) => a.minLevel - b.minLevel);
    if (!foundry.utils.equals(milestoneBands, submittedBands)) {
      return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Settings.MilestoneLevels.Invalid"));
    }
    await game.settings.set(MODULE_ID, SETTINGS.RECIPE_BASE_ITEM_UUID, this._draft.recipeBaseItemUuid);
    await game.settings.set(MODULE_ID, SETTINGS.DEFAULT_COST_ITEM_UUID, this._draft.defaultCostItemUuid);
    await game.settings.set(MODULE_ID, SETTINGS.STATION_CATEGORIES, { entries: unique });
    await game.settings.set(MODULE_ID, SETTINGS.MILESTONE_LEVEL_BANDS, { entries: milestoneBands });
    await game.settings.set(MODULE_ID, SETTINGS.MILESTONE_CATCH_UP, { enabled: this._draft.milestoneCatchUp });
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.ItemSettingsSaved"));
    await this.close();
  }
}
