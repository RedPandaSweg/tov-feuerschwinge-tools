import { MODULE_ID } from "./core/constants.mjs";
import { uiText } from "./core/localization.mjs";

const FLAG = "sceneItemLoot";
const SOCKET_SCOPE = "scene-item-loot";
const LAYER_PATCH = Symbol.for(`${MODULE_ID}.sceneItemLootLayerPatch`);
const COMPOSITE_VERSION = 2;
const LOOT_GRID_SCALE = 0.5;
const UNSTACKABLE_ITEM_TYPES = new Set(["container", "armor", "weapon"]);
const pending = new Map();
let socketInstalled = false;

function activeOperationalGM() {
  return game.users.find(user => user.active && user.isGM) ?? null;
}

function lootData(tile) {
  const data = (tile?.document ?? tile)?.getFlag(MODULE_ID, FLAG);
  return data?.version === 1 && data.item && typeof data.item === "object" ? data : null;
}

async function loadItemImage(source) {
  const url = new URL(source || "icons/svg/item-bag.svg", window.location.href);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Itembild konnte nicht geladen werden (${response.status}).`);
  return createImageBitmap(await response.blob());
}

async function createLootTexture(source) {
  const image = await loadItemImage(source);
  try {
    const size = 256;
    const center = size / 2;
    const imageBox = 190;
    const clipRadius = 101;
    const canvasElement = document.createElement("canvas");
    canvasElement.width = size;
    canvasElement.height = size;
    const context = canvasElement.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";

    context.save();
    context.beginPath();
    context.arc(center, center, clipRadius, 0, Math.PI * 2);
    context.clip();
    context.fillStyle = "#0d0a08";
    context.fillRect(0, 0, size, size);
    const scale = Math.min(imageBox / image.width, imageBox / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    context.drawImage(image, center - width / 2, center - height / 2, width, height);
    context.restore();

    context.save();
    context.beginPath();
    context.arc(center, center, 108, 0, Math.PI * 2);
    context.strokeStyle = "rgba(216, 138, 37, .7)";
    context.lineWidth = 12;
    context.shadowColor = "rgba(242, 174, 67, .72)";
    context.shadowBlur = 14;
    context.stroke();
    context.restore();

    context.beginPath();
    context.arc(center, center, 104, 0, Math.PI * 2);
    context.strokeStyle = "#f7ca6b";
    context.lineWidth = 5;
    context.stroke();
    context.beginPath();
    context.arc(center, center, 98, 0, Math.PI * 2);
    context.strokeStyle = "rgba(123, 69, 27, .9)";
    context.lineWidth = 3;
    context.stroke();

    return canvasElement.toDataURL("image/webp", 0.9);
  } finally {
    image.close?.();
  }
}

function isOwnedActorItem(item, user) {
  return item?.parent?.documentName === "Actor"
    && (user?.isGM || item.parent.testUserPermission(user, "OWNER"));
}

function cleanItemData(item) {
  const data = foundry.utils.deepClone(item.toObject());
  delete data._id;
  delete data.folder;
  delete data.sort;
  return data;
}

function hasItemQuantity(item) {
  return foundry.utils.hasProperty(item, "system.quantity")
    || foundry.utils.hasProperty(item, "system.quantity.value");
}

function itemQuantity(item) {
  const quantity = item?.system?.quantity;
  return Math.max(0, Number(quantity?.value ?? quantity ?? 1) || 0);
}

function quantityUpdate(item, quantity) {
  const path = item?.system?.quantity && typeof item.system.quantity === "object"
    ? "system.quantity.value"
    : "system.quantity";
  return { [path]: Math.max(0, Number(quantity) || 0) };
}

function stackTarget(actor, itemData) {
  if (UNSTACKABLE_ITEM_TYPES.has(itemData?.type) || !hasItemQuantity(itemData)) return null;
  const name = String(itemData.name ?? "").trim().toLocaleLowerCase();
  if (!name) return null;
  return actor.items.find(item => item.type === itemData.type
    && !UNSTACKABLE_ITEM_TYPES.has(item.type)
    && hasItemQuantity(item)
    && String(item.name ?? "").trim().toLocaleLowerCase() === name) ?? null;
}

async function grantLootItem(actor, itemData) {
  const existing = stackTarget(actor, itemData);
  if (existing) {
    await existing.update(quantityUpdate(existing, itemQuantity(existing) + itemQuantity(itemData)));
    return existing;
  }
  const [created] = await actor.createEmbeddedDocuments("Item", [foundry.utils.deepClone(itemData)]);
  return created;
}

function dropPosition(scene, data) {
  const size = scene.grid.size || 100;
  const x = Math.floor(Number(data.x) / size) * size;
  const y = Math.floor(Number(data.y) / size) * size;
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, size };
}

function lootTileSize(scene) {
  return Math.max(24, Math.round((Number(scene?.grid?.size) || 100) * LOOT_GRID_SCALE));
}

async function resolveDropItem(data) {
  if (data.type !== "Item") return null;
  if (data.uuid) return Item.implementation.fromDropData(data).catch(() => null);
  return null;
}

async function createLoot({ sceneId, itemUuid, x, y }, userId) {
  const user = game.users.get(userId);
  const scene = game.scenes.get(sceneId);
  const item = await fromUuid(itemUuid).catch(() => null);
  if (!user?.active || !scene || item?.documentName !== "Item") throw new Error(uiText("TOVF.SceneLoot.Errors.InvalidDrop", "Das Item oder die Szene ist nicht mehr verfügbar."));
  if (!user.isGM && !isOwnedActorItem(item, user)) throw new Error(uiText("TOVF.SceneLoot.Errors.NotOwner", "Du kannst nur Items aus einem eigenen Charakterinventar ablegen."));

  const position = dropPosition(scene, { x, y });
  const highestSort = Math.max(0, ...scene.tiles.map(tile => Number(tile.sort) || 0));
  const texture = await createLootTexture(item.img);
  const lootSize = lootTileSize(scene);
  const lootOffset = Math.round((position.size - lootSize) / 2);
  const [tile] = await scene.createEmbeddedDocuments("Tile", [{
    x: position.x + lootOffset,
    y: position.y + lootOffset,
    width: lootSize,
    height: lootSize,
    sort: highestSort + 1,
    texture: { src: texture, fit: "contain" },
    flags: {
      [MODULE_ID]: {
        [FLAG]: { version: 1, compositeVersion: COMPOSITE_VERSION, item: cleanItemData(item), placedBy: user.id }
      }
    }
  }]);
  if (item.parent?.documentName === "Actor") await item.delete();
  return { tileUuid: tile.uuid, name: item.name };
}

function recipientContext(user) {
  const token = canvas.tokens?.controlled
    ?.find(entry => entry.actor?.testUserPermission(user, "OWNER"));
  if (token) return { actor: token.actor, token: token.document };
  return user.isGM && user.character ? { actor: user.character, token: null } : null;
}

function isAdjacentToLoot(token, tile) {
  if (!token || token.parent?.id !== tile.parent?.id) return false;
  const gridSize = Number(tile.parent?.grid?.size) || 100;
  const tokenCenterX = Number(token.x) + Number(token.width) * gridSize / 2;
  const tokenCenterY = Number(token.y) + Number(token.height) * gridSize / 2;
  const lootCenterX = Number(tile.x) + Number(tile.width) / 2;
  const lootCenterY = Number(tile.y) + Number(tile.height) / 2;
  const tolerance = Math.max(2, gridSize * 0.05);
  const allowedX = (Number(token.width) + 1) * gridSize / 2 + tolerance;
  const allowedY = (Number(token.height) + 1) * gridSize / 2 + tolerance;
  return Math.abs(tokenCenterX - lootCenterX) <= allowedX
    && Math.abs(tokenCenterY - lootCenterY) <= allowedY;
}

async function pickUpLoot({ tileUuid, actorUuid, tokenUuid }, userId) {
  const user = game.users.get(userId);
  const tile = await fromUuid(tileUuid).catch(() => null);
  const actor = await fromUuid(actorUuid).catch(() => null);
  const token = tokenUuid ? await fromUuid(tokenUuid).catch(() => null) : null;
  const loot = lootData(tile);
  if (!user?.active || tile?.documentName !== "Tile" || !loot || actor?.documentName !== "Actor") throw new Error(uiText("TOVF.SceneLoot.Errors.Unavailable", "Dieses Item ist nicht mehr verfügbar."));
  if (!user.isGM && !actor.testUserPermission(user, "OWNER")) throw new Error(uiText("TOVF.SceneLoot.Errors.Recipient", "Du kannst dieses Item nur in einen eigenen Charakter aufnehmen."));
  if (!user.isGM) {
    if (token?.documentName !== "Token" || token.actor?.uuid !== actor.uuid || !token.actor?.testUserPermission(user, "OWNER")) {
      throw new Error(uiText("TOVF.SceneLoot.Errors.NoCharacter", "Wähle einen eigenen Token aus, um das Item aufzunehmen."));
    }
    if (!isAdjacentToLoot(token, tile)) throw new Error(uiText("TOVF.SceneLoot.Errors.OutOfReach", "Das Item kann nur vom gleichen oder einem angrenzenden Feld aufgenommen werden."));
  }
  await grantLootItem(actor, loot.item);
  await tile.delete();
  return { name: loot.item.name };
}

async function removeMarker(tile) {
  const markerId = lootData(tile)?.markerId;
  const marker = markerId ? tile.parent?.tiles?.get(markerId) : null;
  if (marker?.getFlag(MODULE_ID, FLAG)?.marker === true) await marker.delete();
}

async function upgradeVisibleLoot(scene = canvas.scene) {
  if (!scene || activeOperationalGM()?.id !== game.user.id) return;
  const updates = [];
  const legacyMarkerIds = [];
  for (const tile of scene.tiles) {
    const loot = lootData(tile);
    if (!loot || loot.compositeVersion === COMPOSITE_VERSION) continue;
    const lootSize = lootTileSize(scene);
    try {
      updates.push({
        _id: tile.id,
        x: Number(tile.x) + Number(tile.width) / 2 - lootSize / 2,
        y: Number(tile.y) + Number(tile.height) / 2 - lootSize / 2,
        width: lootSize,
        height: lootSize,
        texture: { src: await createLootTexture(loot.item.img), fit: "contain" },
        [`flags.${MODULE_ID}.${FLAG}.compositeVersion`]: COMPOSITE_VERSION,
        [`flags.${MODULE_ID}.${FLAG}.markerId`]: null,
        [`flags.${MODULE_ID}.${FLAG}.markerOffset`]: null
      });
      if (loot.markerId && scene.tiles.get(loot.markerId)?.getFlag(MODULE_ID, FLAG)?.marker) legacyMarkerIds.push(loot.markerId);
    } catch (error) {
      console.error(`${MODULE_ID} | Could not upgrade scene loot image for ${loot.item.name}`, error);
    }
  }
  if (updates.length) await scene.updateEmbeddedDocuments("Tile", updates);
  if (legacyMarkerIds.length) await scene.deleteEmbeddedDocuments("Tile", legacyMarkerIds);
}

async function execute(action, payload, userId) {
  if (action === "drop") return createLoot(payload, userId);
  if (action === "pickup") return pickUpLoot(payload, userId);
  throw new Error("Unbekannte Szenenbeute-Aktion.");
}

async function request(action, payload) {
  if (game.user.isGM) return execute(action, payload, game.user.id);
  const gm = activeOperationalGM();
  if (!gm) throw new Error(uiText("TOVF.SceneLoot.Errors.GM", "Zum Ablegen oder Aufnehmen von Szenen-Items muss eine Spielleitung verbunden sein."));
  const requestId = foundry.utils.randomID();
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(uiText("TOVF.SceneLoot.Errors.Timeout", "Die Spielleitung hat nicht auf die Szenen-Item-Anfrage reagiert.")));
    }, 8000);
    pending.set(requestId, {
      resolve: result => { clearTimeout(timeout); resolve(result); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(`module.${MODULE_ID}`, { scope: SOCKET_SCOPE, type: "request", requestId, targetGMId: gm.id, userId: game.user.id, action, payload });
  return response;
}

async function handleCanvasDrop(canvas, data) {
  const item = await resolveDropItem(data);
  if (!item || canvas.scene?.id !== data.sceneId && data.sceneId) return;
  try {
    const result = await request("drop", { sceneId: canvas.scene.id, itemUuid: item.uuid, x: data.x, y: data.y });
    ui.notifications.info(uiText("TOVF.SceneLoot.Placed", "{name} liegt jetzt auf der Szene. Doppelklick zum Aufnehmen.", result));
  } catch (error) {
    console.error(`${MODULE_ID} | Could not place scene item loot`, error);
    ui.notifications.error(error.message);
  }
}

function tileAt(point) {
  return canvas.scene?.tiles
    ?.filter(tile => lootData(tile) && (!tile.hidden || game.user.isGM) && tile.object?.bounds?.contains?.(point.x, point.y))
    .sort((left, right) => (right.sort ?? right.z ?? 0) - (left.sort ?? left.z ?? 0))[0] ?? null;
}

async function pickUpAt(point) {
  const tile = tileAt(point);
  if (!tile) return false;
  const recipient = recipientContext(game.user);
  if (!recipient) {
    ui.notifications.warn(uiText("TOVF.SceneLoot.Errors.NoCharacter", "Wähle einen eigenen Token aus, um das Item aufzunehmen."));
    return true;
  }
  if (!game.user.isGM && !isAdjacentToLoot(recipient.token, tile)) {
    ui.notifications.warn(uiText("TOVF.SceneLoot.Errors.OutOfReach", "Das Item kann nur vom gleichen oder einem angrenzenden Feld aufgenommen werden."));
    return true;
  }
  try {
    const result = await request("pickup", {
      tileUuid: tile.uuid,
      actorUuid: recipient.actor.uuid,
      tokenUuid: recipient.token?.uuid
    });
    ui.notifications.info(uiText("TOVF.SceneLoot.PickedUp", "{name} wurde aufgenommen.", result));
  } catch (error) {
    console.error(`${MODULE_ID} | Could not pick up scene item loot`, error);
    ui.notifications.error(error.message);
  }
  return true;
}

function installLayerPatch() {
  const prototype = foundry.canvas.layers.TokenLayer?.prototype;
  if (!prototype || Object.hasOwn(prototype, LAYER_PATCH)) return;
  Object.defineProperty(prototype, LAYER_PATCH, { value: true });
  const original = prototype._onClickLeft2;
  prototype._onClickLeft2 = function(event, ...args) {
    const point = canvas.activeLayer?.toLocal?.(event);
    if (point && tileAt(point)) {
      void pickUpAt(point);
      return;
    }
    return original.call(this, event, ...args);
  };
}

export function registerSceneItemLoot() {
  Hooks.on("dropCanvasData", handleCanvasDrop);
  Hooks.on("canvasReady", installLayerPatch);
  Hooks.on("canvasReady", () => void upgradeVisibleLoot(canvas.scene));
  Hooks.on("deleteTile", (tile, _options, userId) => {
    if (userId === game.user.id && lootData(tile)) void removeMarker(tile);
  });
  installLayerPatch();
}

export function activateSceneItemLoot() {
  if (!socketInstalled) {
    socketInstalled = true;
    game.socket.on(`module.${MODULE_ID}`, message => {
      if (message?.scope !== SOCKET_SCOPE) return;
      if (message.type === "response") {
        const entry = pending.get(message.requestId);
        if (!entry || message.targetUserId !== game.user.id) return;
        pending.delete(message.requestId);
        message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
        return;
      }
      if (message.type !== "request" || message.targetGMId !== game.user.id || activeOperationalGM()?.id !== game.user.id) return;
      execute(message.action, message.payload, message.userId)
        .then(result => game.socket.emit(`module.${MODULE_ID}`, { scope: SOCKET_SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, result }))
        .catch(error => game.socket.emit(`module.${MODULE_ID}`, { scope: SOCKET_SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, error: error.message }));
    });
  }
  installLayerPatch();
}
