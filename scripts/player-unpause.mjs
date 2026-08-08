import { MODULE_ID } from "./core/constants.mjs";

const SETTING = "unpauseWithoutGM";

function settingEnabled() {
  return game.settings.get(MODULE_ID, SETTING);
}

function hasActiveGM() {
  return game.users.some(user => user.active && user.isGM);
}

function wasPausedByGM(options = {}) {
  return options.userId && game.users.get(options.userId)?.isGM;
}

function unpauseAutomatic({ allowWithGM = false, pauseOptions = {} } = {}) {
  if (!settingEnabled() || !game.paused) return false;
  if (wasPausedByGM(pauseOptions)) return false;
  if (!allowWithGM && hasActiveGM()) return false;

  // Foundry v14 permits every client to change its local pause state. The
  // server only accepts broadcast pause changes from a GM. Explicit pauses
  // broadcast by a GM are preserved; stale and automatic pauses are local.
  game.togglePause(false, { broadcast: false });
  return true;
}

export function registerPlayerUnpause() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "TOVF.Pause.Setting.Name",
    hint: "TOVF.Pause.Setting.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true,
    restricted: true
  });

  Hooks.on("pauseGame", (paused, options) => {
    if (paused) unpauseAutomatic({ allowWithGM: true, pauseOptions: options });
  });
}

export function activatePlayerUnpause() {
  // Covers a world which was already paused before this client connected,
  // including the GM client.
  unpauseAutomatic({ allowWithGM: true });

  // Core updates the active user state before module socket listeners run.
  // Recheck after a GM disconnects while the game is paused.
  game.socket.on("userActivity", () => queueMicrotask(() => unpauseAutomatic()));
}
