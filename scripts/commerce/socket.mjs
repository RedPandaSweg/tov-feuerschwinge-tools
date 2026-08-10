import { MODULE_ID } from "../core/constants.mjs";
import { executeCommerceAction } from "./service.mjs";

const SCOPE = "commerce";
const pending = new Map();

export function broadcastPeerTrade(event, trade, side = null) {
  const message = { scope: SCOPE, type: "peerTrade", event, side, senderId: game.user.id, trade: foundry.utils.deepClone(trade) };
  game.socket.emit(`module.${MODULE_ID}`, message);
}

function activeGM() {
  const connected = game.users.filter(user => user.active && user.isGM);
  const isBot = user => /\[bot\]/i.test(String(user.name ?? "")) || user.getFlag?.(MODULE_ID, "serviceBot") === true;
  return connected.find(user => !isBot(user) && user.viewedScene)
    ?? connected.find(user => !isBot(user))
    ?? connected.find(user => user.viewedScene)
    ?? connected[0]
    ?? null;
}

function broadcastSync(result) {
  if (!result?.sync) return;
  game.socket.emit(`module.${MODULE_ID}`, { scope: SCOPE, type: "sync", sync: result.sync });
  Hooks.callAll(`${MODULE_ID}.commerceSync`, result.sync);
}

export async function commerceRequest(action, payload = {}) {
  if (game.user.isGM) {
    const result = await executeCommerceAction(action, payload, game.user.id); broadcastSync(result); return result;
  }
  const gm = activeGM();
  if (!gm) throw new Error("Für diese Handelsaktion muss Seraphius oder eine Spielleitung verbunden sein.");
  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${gm.name} hat die Handelsanfrage nicht beantwortet.`));
    }, 12000);
    pending.set(requestId, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(`module.${MODULE_ID}`, {
    scope: SCOPE, type: "request", requestId, userId: game.user.id,
    targetGMId: gm.id, action, payload
  });
  return promise;
}

export function activateCommerceSocket() {
  game.socket.on(`module.${MODULE_ID}`, message => {
    if (message?.scope !== SCOPE) return;
    if (message.type === "peerTrade") { Hooks.callAll(`${MODULE_ID}.peerTrade`, message); return; }
    if (message.type === "response") {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      if (message.error) entry.reject(new Error(message.error));
      else { entry.resolve(message.result); broadcastSync(message.result); }
      return;
    }
    if (message.type === "sync") { Hooks.callAll(`${MODULE_ID}.commerceSync`, message.sync); return; }
    if (message.type !== "request" || !game.user.isGM || message.targetGMId !== game.user.id) return;
    executeCommerceAction(message.action, message.payload, message.userId)
      .then(result => {
        game.socket.emit(`module.${MODULE_ID}`, { scope: SCOPE, type: "response", requestId: message.requestId,
          targetUserId: message.userId, result });
        if (result?.sync) game.socket.emit(`module.${MODULE_ID}`, { scope: SCOPE, type: "sync", sync: result.sync });
      })
      .catch(error => game.socket.emit(`module.${MODULE_ID}`, {
        scope: SCOPE, type: "response", requestId: message.requestId,
        targetUserId: message.userId, error: error.message
      }));
  });
}
