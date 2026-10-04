import { MODULE_ID } from "../core/constants.mjs";
import { initConfig } from "./argon/adapter.mjs?v=3.3.1-follow-up-filter-2";
import { registerArgonSettings } from "./argon/settings.mjs?v=3.4.2-popup-1";

const ARGON_CORE_ID = "enhancedcombathud";
const LEGACY_ADAPTER_ID = "enhancedcombathud-black-flag";
let installed = false;
let restoreNotificationError = null;

function suppressMissingSystemAdapterNotification() {
  if (restoreNotificationError || typeof ui?.notifications?.error !== "function") return;
  const notifications = ui.notifications;
  const original = notifications.error;
  const filteredError = function(message, options) {
    const text = String(message ?? "");
    const isArgonAdapterWarning = text.includes("enhancedcombathud-black-flag")
      || (text.includes("Argon - Combat HUD") && text.includes("BLACK-FLAG"));
    if (isArgonAdapterWarning) return null;
    return original.call(this, message, options);
  };
  notifications.error = filteredError;
  restoreNotificationError = () => {
    if (notifications.error === filteredError) notifications.error = original;
    restoreNotificationError = null;
  };
  Hooks.once("argonInit", () => restoreNotificationError?.());
  Hooks.once("ready", () => setTimeout(() => restoreNotificationError?.(), 0));
}

function suppressMissingSystemAdapterWarning(CoreHud) {
  if (!CoreHud?.prototype || CoreHud.prototype.__tovfModuleCheck) return false;
  Object.defineProperty(CoreHud.prototype, "performModuleCheck", {
    value() {},
    configurable: true,
    writable: true
  });
  Object.defineProperty(CoreHud.prototype, "__tovfModuleCheck", { value: true });
  return true;
}

/** Register Feuerschwinge as the Black Flag system adapter for Argon Core. */
export function installArgonBlackFlagCompatibility() {
  if (installed) return { status: "already-installed" };
  installed = true;
  registerArgonSettings();

  if (game.modules.get(LEGACY_ADAPTER_ID)?.active) {
    console.error(`${MODULE_ID} | The legacy Argon Black Flag adapter must be disabled.`);
    Hooks.once("ready", () => ui.notifications.error(
      game.i18n.localize("TOVF.Argon.LegacyAdapterActive"),
      { permanent: true }
    ));
    return { status: "incompatible", reason: `Conflicting module ${LEGACY_ADAPTER_ID} is active.` };
  }
  if (!game.modules.get(ARGON_CORE_ID)?.active) {
    return { status: "inactive", reason: `Optional module ${ARGON_CORE_ID} is not active.` };
  }

  // CoreHud performs its legacy name-based module check before firing
  // argonInit. Suppress only that known false positive while the HUD is
  // constructed; the built-in adapter is registered immediately afterwards.
  suppressMissingSystemAdapterNotification();

  // Argon Core currently checks only for a module whose ID follows
  // `enhancedcombathud-${systemId}`. Feuerschwinge supplies the adapter via
  // argonInit instead, so that name-based warning is not applicable.
  const patched = suppressMissingSystemAdapterWarning(CONFIG.ARGON?.CORE?.CoreHud);
  if (!patched) {
    void import("/modules/enhancedcombathud/scripts/app/CoreHud.js")
      .then(({ CoreHud }) => suppressMissingSystemAdapterWarning(CoreHud))
      .catch(error => console.warn(`${MODULE_ID} | Could not suppress Argon's external adapter warning.`, error));
  }
  Hooks.once("argonInit", CoreHud => suppressMissingSystemAdapterWarning(CoreHud));

  initConfig();
  console.log(`${MODULE_ID} | Installed the Feuerschwinge Black Flag adapter for Argon Core.`);
  return { status: "completed" };
}
