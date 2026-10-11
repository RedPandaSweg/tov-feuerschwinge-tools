import { MODULE_ID } from "./constants.mjs";
import { RaffleService } from "./raffle-service.mjs?v=3.8.5-raffle-packages-2";

const CHANNEL = `module.${MODULE_ID}`;
const SCOPE = "raffle";
const pending = new Map();
let registered = false;

function authority() {
  return game.users.filter(user => user.active && user.isGM).sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

export function registerRaffleSocket() {
  if (registered) return;
  registered = true;
  game.socket.on(CHANNEL, async message => {
    if (message?.scope !== SCOPE) return;
    if (message.type === "response") {
      if (message.targetUserId !== game.user.id) return;
      const request = pending.get(message.requestId);
      if (!request) return;
      pending.delete(message.requestId);
      return message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
    }
    if (message.type !== "request" || !game.user.isGM || message.targetGMId !== game.user.id) return;
    try {
      const actor = await fromUuid(message.actorUuid);
      const character = await fromUuid(message.characterUuid);
      const user = game.users.get(message.userId);
      const result = message.action === "join"
        ? await RaffleService.join(actor, character, user)
        : message.action === "leave"
          ? await RaffleService.leave(actor, character, user)
          : await RaffleService.buy(actor, character, message.quantity, user);
      game.socket.emit(CHANNEL, { scope: SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, result });
    } catch (error) {
      game.socket.emit(CHANNEL, { scope: SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, error: error.message });
    }
  });
}

function request(action, payload) {
  if (game.user.isGM) return action === "join"
    ? RaffleService.join(payload.actor, payload.character)
    : action === "leave"
      ? RaffleService.leave(payload.actor, payload.character)
      : RaffleService.buy(payload.actor, payload.character, payload.quantity);
  const gm = authority();
  if (!gm) return Promise.reject(new Error("Für die Teilnahme muss eine Spielleitung verbunden sein."));
  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${gm.name} hat die Teilnahme nicht beantwortet.`));
    }, 12000);
    pending.set(requestId, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(CHANNEL, { scope: SCOPE, type: "request", requestId, targetGMId: gm.id, userId: game.user.id, action, actorUuid: payload.actor.uuid, characterUuid: payload.character.uuid, quantity: payload.quantity });
  return promise;
}

export const raffleBuy = payload => request("buy", payload);
export const raffleJoin = payload => request("join", payload);
export const raffleLeave = payload => request("leave", payload);
