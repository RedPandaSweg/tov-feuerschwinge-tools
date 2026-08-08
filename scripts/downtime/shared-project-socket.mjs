import { MODULE_ID } from "./constants.mjs";
import { SharedProjectService } from "./shared-project-service.mjs";

const pending = new Map();
let requestQueue = Promise.resolve();
const actions = {
  start: payload => SharedProjectService.start(payload),
  join: payload => SharedProjectService.join(payload),
  leave: payload => SharedProjectService.leave(payload),
  cancel: payload => SharedProjectService.cancel(payload),
  invest: payload => SharedProjectService.invest(payload),
  resolveRoll: payload => SharedProjectService.resolveRoll(payload),
  completionRoll: payload => SharedProjectService.completionRoll(payload)
};

function activeGM() {
  return game.users.activeGM ?? game.users.find(user => user.active && user.isGM);
}

async function authorize(userId, payload, action) {
  const user = game.users.get(userId);
  const actor = payload.actorUuid || payload.leaderUuid ? await fromUuid(payload.actorUuid || payload.leaderUuid) : null;
  if (!user || (!user.isGM && (!actor || !(actor.testUserPermission?.(user, "OWNER") || user.character?.uuid === actor.uuid)))) {
    throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SharedProjectPermission"));
  }
  return { ...payload, isGM: user.isGM && action === "cancel" };
}

export function registerSharedProjectSocket() {
  game.socket.on(`module.${MODULE_ID}`, message => {
    if (message.type === "response") {
      const request = pending.get(message.requestId);
      if (!request || message.targetUserId !== game.user.id) return;
      pending.delete(message.requestId);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
      return;
    }
    if (message.type !== "request" || activeGM()?.id !== game.user.id) return;
    requestQueue = requestQueue.then(async () => {
    try {
      const payload = await authorize(message.userId, message.payload, message.action);
      const result = await actions[message.action]?.(payload);
      game.socket.emit(`module.${MODULE_ID}`, { type: "response", requestId: message.requestId, targetUserId: message.userId, result });
    } catch (error) {
      game.socket.emit(`module.${MODULE_ID}`, { type: "response", requestId: message.requestId, targetUserId: message.userId, error: error.message });
    }
    });
  });
}

export async function sharedProjectAction(action, payload) {
  if (!actions[action]) throw new Error(`Unknown shared project action: ${action}`);
  if (game.user.isGM) return actions[action]({ ...payload, isGM: action === "cancel" });
  if (!activeGM()) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActiveGMRequired"));
  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => pending.set(requestId, { resolve, reject }));
  game.socket.emit(`module.${MODULE_ID}`, { type: "request", requestId, userId: game.user.id, action, payload });
  return promise;
}
