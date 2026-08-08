import { MODULE_ID } from "./core/constants.mjs";
import { HelpApp } from "./downtime/help-app.mjs";

export function registerHelp() {
  game.settings.registerMenu(MODULE_ID, "help", {
    name: "TOVF.Help.Name",
    label: "TOVF.Help.Label",
    hint: "TOVF.Help.Hint",
    icon: "fa-solid fa-circle-question",
    type: HelpApp,
    restricted: false
  });
}
