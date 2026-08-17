import { MODULE_ID } from "../core/constants.mjs";
import { VOID_EXPOSURES, VOID_TAINT_SETTINGS } from "./constants.mjs";
import { ensureVoidTaintTables, voidTaintTableOptions } from "./service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class VoidTaintConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-void-taint-config",
    classes: ["tovf-void-taint-config"],
    position: { width: 700, height: 690 },
    window: { title: "TOVF.VoidTaint.Config.Title", resizable: true },
    actions: {
      save: VoidTaintConfigApp.#save,
      recreateTables: VoidTaintConfigApp.#recreateTables,
      openTable: VoidTaintConfigApp.#openTable
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/void-taint/config.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const tables = await voidTaintTableOptions();
    return {
      ...context,
      enabled: game.settings.get(MODULE_ID, VOID_TAINT_SETTINGS.ENABLED),
      minimumThreshold: game.settings.get(MODULE_ID, VOID_TAINT_SETTINGS.MINIMUM_THRESHOLD),
      tables,
      exposures: VOID_EXPOSURES.map(([source, dc]) => ({ source, dc }))
    };
  }

  static async #save(event) {
    event.preventDefault();
    const form = this.element.querySelector("form");
    const data = new foundry.applications.ux.FormDataExtended(form).object;
    await game.settings.set(MODULE_ID, VOID_TAINT_SETTINGS.ENABLED, Boolean(data.enabled));
    await game.settings.set(MODULE_ID, VOID_TAINT_SETTINGS.MINIMUM_THRESHOLD, Math.max(0, Math.floor(Number(data.minimumThreshold) || 0)));
    await game.settings.set(MODULE_ID, VOID_TAINT_SETTINGS.DREAD_TABLE, String(data.dreadTable ?? ""));
    await game.settings.set(MODULE_ID, VOID_TAINT_SETTINGS.FLESH_WARP_TABLE, String(data.fleshWarpTable ?? ""));
    ui.notifications.info(game.i18n.localize("TOVF.VoidTaint.Config.Saved"));
    this.render({ force: true });
  }

  static async #recreateTables(event) {
    event.preventDefault();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("TOVF.VoidTaint.Config.Recreate") },
      content: `<p>${game.i18n.localize("TOVF.VoidTaint.Config.RecreateHint")}</p>`
    });
    if (!confirmed) return;
    await ensureVoidTaintTables({ recreate: true });
    this.render({ force: true });
  }

  static async #openTable(event, target) {
    event.preventDefault();
    const select = this.element.querySelector(`[name="${target.dataset.table}"]`);
    const table = select?.value ? await fromUuid(select.value).catch(() => null) : null;
    table?.sheet.render(true);
  }
}

export function openVoidTaintConfig() {
  new VoidTaintConfigApp().render(true);
}
