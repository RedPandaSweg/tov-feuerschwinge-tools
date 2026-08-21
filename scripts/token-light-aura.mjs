import { MODULE_ID } from "./core/constants.mjs";

const SOCKET_SCOPE = "token-light-aura";
const ORIGINAL_LIGHT_FLAG = "lightAuraOriginal";
const pending = new Map();

function activeGM() {
  return game.users.activeGM ?? game.users.find(user => user.active && user.isGM);
}

function auraLight(current = {}) {
  const technique = CONST.LIGHTING_TECHNIQUES?.ADAPTIVE_LUMINANCE
    ?? CONST.LIGHTING_TECHNIQUES?.LUMINANCE
    ?? 0;
  return foundry.utils.mergeObject(current, {
    dim: 15,
    bright: 0,
    angle: 360,
    color: null,
    alpha: 0.5,
    animation: { type: "vortex", speed: 5, intensity: 1, reverse: false },
    coloration: technique,
    luminosity: 0,
    attenuation: 0.4,
    saturation: 0.05,
    contrast: 0.6,
    shadows: 0
  }, { inplace: false, overwrite: true });
}

async function toggleForUser(tokenUuid, userId) {
  const user = game.users.get(userId);
  const token = await fromUuid(tokenUuid);
  if (!user?.active) throw new Error("Der anfragende Spieler ist nicht verbunden.");
  if (token?.documentName !== "Token") throw new Error("Der Token wurde nicht gefunden.");
  if (!user.isGM && !token.actor?.testUserPermission?.(user, "OWNER")) {
    throw new Error("Du besitzt den Character dieses Tokens nicht.");
  }

  const original = token.getFlag(MODULE_ID, ORIGINAL_LIGHT_FLAG);
  if (original !== undefined) {
    await token.update({
      light: original,
      [`flags.${MODULE_ID}.-=${ORIGINAL_LIGHT_FLAG}`]: null
    });
    return { active: false };
  }

  const current = token.light?.toObject?.() ?? foundry.utils.deepClone(token.light ?? {});
  await token.update({
    light: auraLight(current),
    [`flags.${MODULE_ID}.${ORIGINAL_LIGHT_FLAG}`]: current
  });
  return { active: true };
}

export async function toggleTokenLightAura({ tokenUuid } = {}) {
  if (!tokenUuid) throw new Error("Es wurde kein Token übergeben.");
  if (game.user.isGM) return toggleForUser(tokenUuid, game.user.id);

  const gm = activeGM();
  if (!gm) throw new Error("Zum Ändern der Lichtaura muss eine Spielleitung verbunden sein.");
  const requestId = foundry.utils.randomID();
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Die Spielleitung hat nicht auf die Lichtaura-Anfrage geantwortet."));
    }, 8000);
    pending.set(requestId, {
      resolve: result => { clearTimeout(timeout); resolve(result); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(`module.${MODULE_ID}`, {
    scope: SOCKET_SCOPE,
    type: "request",
    requestId,
    userId: game.user.id,
    targetGMId: gm.id,
    tokenUuid
  });
  return response;
}

export function activateTokenLightAuraSocket() {
  game.socket.on(`module.${MODULE_ID}`, message => {
    if (message?.scope !== SOCKET_SCOPE) return;

    if (message.type === "response" && message.targetUserId === game.user.id) {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
      return;
    }

    if (message.type !== "request" || !game.user.isGM || message.targetGMId !== game.user.id) return;
    toggleForUser(message.tokenUuid, message.userId)
      .then(result => game.socket.emit(`module.${MODULE_ID}`, {
        scope: SOCKET_SCOPE,
        type: "response",
        requestId: message.requestId,
        targetUserId: message.userId,
        result
      }))
      .catch(error => game.socket.emit(`module.${MODULE_ID}`, {
        scope: SOCKET_SCOPE,
        type: "response",
        requestId: message.requestId,
        targetUserId: message.userId,
        error: error.message
      }));
  });
}
