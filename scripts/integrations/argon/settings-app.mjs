import { MODULE_ID } from "../../core/constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const DEFINITIONS = [
  { key: "showWeaponsItems", type: "boolean", reload: true },
  { key: "showClassActions", type: "boolean", reload: true },
  { key: "condenseClassActions", type: "boolean" },
  { key: "explodeItemActivities", type: "select", choices: ["only-weapons", "always", "never"] },
  { key: "macroPanel", type: "boolean", reload: true },
  { key: "switchEquip", type: "boolean" },
  { key: "showSpecialActions", type: "boolean" }
];

export class ArgonSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-argon-settings",
    classes: ["tovf-argon-settings"],
    tag: "form",
    position: { width: 600, height: "auto" },
    window: { title: "TOVF.Argon.Settings.Menu.Title", resizable: true },
    form: { handler: ArgonSettingsApp.#submit, closeOnSubmit: true }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/argon-settings.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      settings: DEFINITIONS.map(definition => ({
        ...definition,
        name: game.i18n.localize(`TOVF.Argon.Settings.${definition.key}.Name`),
        hint: game.i18n.localize(`TOVF.Argon.Settings.${definition.key}.Hint`),
        value: game.settings.get(MODULE_ID, definition.key),
        choices: definition.choices?.map(value => ({
          value,
          selected: game.settings.get(MODULE_ID, definition.key) === value,
          label: game.i18n.localize(`TOVF.Argon.Settings.Explode.${value === "only-weapons" ? "OnlyWeapons" : value === "always" ? "Always" : "Never"}`)
        })) ?? []
      }))
    };
  }

  static async #submit(_event, form, formData) {
    const values = formData.object;
    let requiresReload = false;
    for (const definition of DEFINITIONS) {
      const oldValue = game.settings.get(MODULE_ID, definition.key);
      const newValue = definition.type === "boolean"
        ? values[definition.key] === true
        : String(values[definition.key] ?? "");
      if (oldValue === newValue) continue;
      await game.settings.set(MODULE_ID, definition.key, newValue);
      requiresReload ||= definition.reload === true;
    }
    ui.ARGON?.refresh?.();
    ui.notifications.info(game.i18n.localize("TOVF.Argon.Settings.Menu.Saved"));
    if (requiresReload) SettingsConfig.reloadConfirm({ world: true });
  }
}
