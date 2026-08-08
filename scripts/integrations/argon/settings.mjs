import { MODULE_ID } from "../../core/constants.mjs";
import { setExplodeItemActivities } from "./adapter.mjs";

export const getSetting = key => game.settings.get(MODULE_ID, key);

export function registerArgonSettings() {
  const definitions = {
    showWeaponsItems: { type: Boolean, default: true, requiresReload: true },
    showClassActions: { type: Boolean, default: true, requiresReload: true },
    condenseClassActions: { type: Boolean, default: true },
    explodeItemActivities: {
      type: String,
      default: "only-weapons",
      choices: {
        "only-weapons": "TOVF.Argon.Settings.Explode.OnlyWeapons",
        always: "TOVF.Argon.Settings.Explode.Always",
        never: "TOVF.Argon.Settings.Explode.Never"
      },
      onChange: () => setExplodeItemActivities()
    },
    macroPanel: { type: Boolean, default: false, requiresReload: true },
    switchEquip: { type: Boolean, default: false },
    showSpecialActions: { type: Boolean, default: true }
  };
  for (const [key, definition] of Object.entries(definitions)) {
    game.settings.register(MODULE_ID, key, {
      name: `TOVF.Argon.Settings.${key}.Name`,
      hint: `TOVF.Argon.Settings.${key}.Hint`,
      scope: "world",
      config: true,
      ...definition,
      onChange: value => {
        definition.onChange?.(value);
        ui.ARGON?.refresh?.();
      }
    });
  }
}
