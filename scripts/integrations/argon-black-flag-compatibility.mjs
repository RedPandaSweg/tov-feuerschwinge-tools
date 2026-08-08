import { MODULE_ID } from "../core/constants.mjs";
import { initConfig } from "./argon/adapter.mjs";
import { registerArgonSettings } from "./argon/settings.mjs";

const ARGON_CORE_ID = "enhancedcombathud";
const LEGACY_ADAPTER_ID = "enhancedcombathud-black-flag";
let installed = false;

/** Register Feuerschwinge as the Black Flag system adapter for Argon Core. */
export function installArgonBlackFlagCompatibility() {
  if (installed) return;
  installed = true;
  registerArgonSettings();

  if (game.modules.get(LEGACY_ADAPTER_ID)?.active) {
    console.error(`${MODULE_ID} | The legacy Argon Black Flag adapter must be disabled.`);
    Hooks.once("ready", () => ui.notifications.error(
      game.i18n.localize("TOVF.Argon.LegacyAdapterActive"),
      { permanent: true }
    ));
    return;
  }
  if (!game.modules.get(ARGON_CORE_ID)?.active) return;

  // Argon Core currently checks only for a module whose ID follows
  // `enhancedcombathud-${systemId}`. Feuerschwinge supplies the adapter via
  // argonInit instead, so that name-based warning is not applicable.
  const CoreHud = CONFIG.ARGON?.CORE?.CoreHud;
  if (CoreHud?.prototype && !CoreHud.prototype.__tovfModuleCheck) {
    Object.defineProperty(CoreHud.prototype, "performModuleCheck", {
      value() {},
      configurable: true,
      writable: true
    });
    Object.defineProperty(CoreHud.prototype, "__tovfModuleCheck", { value: true });
  }

  initConfig();
  console.log(`${MODULE_ID} | Installed the Feuerschwinge Black Flag adapter for Argon Core.`);
}
