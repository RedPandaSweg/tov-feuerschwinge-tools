import { MODULE_ID } from "../core/constants.mjs";
import { VoidTaintConfigApp } from "./config-app.mjs";
import { VOID_TAINT_SETTINGS } from "./constants.mjs";
import { ensureVoidTaintTables } from "./service.mjs";

Hooks.once("init", () => {
  if (game.system.id !== "black-flag") return;
  game.settings.register(MODULE_ID, VOID_TAINT_SETTINGS.ENABLED, {
    scope: "world", config: false, type: Boolean, default: true
  });
  game.settings.register(MODULE_ID, VOID_TAINT_SETTINGS.MINIMUM_THRESHOLD, {
    scope: "world", config: false, type: Number, default: 2
  });
  game.settings.register(MODULE_ID, VOID_TAINT_SETTINGS.DREAD_TABLE, {
    scope: "world", config: false, type: String, default: ""
  });
  game.settings.register(MODULE_ID, VOID_TAINT_SETTINGS.FLESH_WARP_TABLE, {
    scope: "world", config: false, type: String, default: ""
  });
  game.settings.registerMenu(MODULE_ID, "voidTaint", {
    name: "TOVF.VoidTaint.Config.MenuName",
    label: "TOVF.VoidTaint.Config.MenuLabel",
    hint: "TOVF.VoidTaint.Config.MenuHint",
    icon: "fa-solid fa-circle-radiation",
    type: VoidTaintConfigApp,
    restricted: true
  });
});

Hooks.once("ready", () => {
  if (game.system.id !== "black-flag" || !game.user.isGM) return;
  void ensureVoidTaintTables().catch(error => {
    console.error(`${MODULE_ID} | Failed to prepare Void Taint tables.`, error);
    ui.notifications.error(game.i18n.localize("TOVF.VoidTaint.Errors.Table"));
  });
});
