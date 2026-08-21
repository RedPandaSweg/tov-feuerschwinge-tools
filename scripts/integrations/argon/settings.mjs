import { MODULE_ID } from "../../core/constants.mjs";
import { setExplodeItemActivities } from "./adapter.mjs?v=3.3.1-follow-up-filter-2";

export const getSetting = key => game.settings.get(MODULE_ID, key);

const EXPLODE_ACTIVITIES_MIGRATION = "explodeItemActivitiesMigrationVersion";
const EXPLODE_ACTIVITIES_MIGRATION_VERSION = 1;

async function applyExplodeActivitiesDefaultOnce() {
  if (!game.user.isGM) return;
  const migrated = game.settings.get(MODULE_ID, EXPLODE_ACTIVITIES_MIGRATION);
  if (migrated >= EXPLODE_ACTIVITIES_MIGRATION_VERSION) return;
  await game.settings.set(MODULE_ID, "explodeItemActivities", "always");
  await game.settings.set(MODULE_ID, EXPLODE_ACTIVITIES_MIGRATION, EXPLODE_ACTIVITIES_MIGRATION_VERSION);
}

export function registerArgonSettings() {
  const definitions = {
    showWeaponsItems: { type: Boolean, default: true, requiresReload: true },
    showClassActions: { type: Boolean, default: true, requiresReload: true },
    condenseClassActions: { type: Boolean, default: true },
    explodeItemActivities: {
      type: String,
      default: "always",
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
  game.settings.register(MODULE_ID, EXPLODE_ACTIVITIES_MIGRATION, {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
  Hooks.once("ready", () => applyExplodeActivitiesDefaultOnce().catch(error => {
    console.error(`${MODULE_ID} | Could not apply the one-time activity display default.`, error);
  }));
}
