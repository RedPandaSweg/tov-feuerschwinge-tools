import { MODULE_ID } from "./constants.mjs";

const SOCKET_SCOPE = "module-events";
let activated = false;

function hookName(type) {
  return `${MODULE_ID}.event.${type}`;
}

export function subscribeModuleEvent(type, callback) {
  return Hooks.on(hookName(type), callback);
}

export function unsubscribeModuleEvent(type, hookId) {
  Hooks.off(hookName(type), hookId);
}

export function emitModuleEvent(type, payload = {}, { broadcast = true } = {}) {
  const event = {
    type: String(type),
    payload: foundry.utils.deepClone(payload),
    senderId: game.user.id,
    emittedAt: Date.now()
  };
  Hooks.callAll(hookName(event.type), event.payload, event);
  if (broadcast) game.socket.emit(`module.${MODULE_ID}`, { scope: SOCKET_SCOPE, ...event });
  return event;
}

export function activateModuleEvents() {
  if (activated) return;
  activated = true;
  game.socket.on(`module.${MODULE_ID}`, event => {
    if (event?.scope !== SOCKET_SCOPE || !event.type || event.senderId === game.user.id) return;
    Hooks.callAll(hookName(event.type), event.payload ?? {}, event);
  });
}
