import { MODULE_ID } from "./core/constants.mjs";
import { uiText } from "./core/localization.mjs";
import { isOperationalGM } from "./core/permissions.mjs";
import {
  coinValues,
  currencyIdentifier,
  itemQuantity as systemItemQuantity,
  setItemQuantity
} from "./commerce/currency.mjs?v=3.5.0-item-quantity-1";

const FLAG = "sceneItemLoot";
const SOCKET_SCOPE = "scene-item-loot";
const LAYER_PATCH = Symbol.for(`${MODULE_ID}.sceneItemLootLayerPatch`);
const TOKEN_PATCH = Symbol.for(`${MODULE_ID}.sceneItemLootTokenPatch`);
const TOKEN_MASK = Symbol.for(`${MODULE_ID}.sceneItemLootTokenMask`);
const TOKEN_FRAME = Symbol.for(`${MODULE_ID}.sceneItemLootTokenFrame`);
const COMPOSITE_VERSION = 8;
const LOOT_GRID_SCALE = 0.5;
const UNSTACKABLE_ITEM_TYPES = new Set(["container", "armor", "weapon"]);
const PACKAGE_IMAGE = "icons/containers/chest/chest-elm-steel-brown.webp";
const CURRENCY_DENOMINATIONS = ["pp", "gp", "sp", "cp"];
const PARTY_ACTORS_SETTING = "doomSelectedActors";
const pending = new Map();
const lootOperationQueues = new Map();
const openLootDialogs = new Map();
let socketInstalled = false;

function enqueueLootOperation(lootUuid, operation) {
  const key = String(lootUuid ?? "");
  if (!key) return operation();
  const previous = lootOperationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  lootOperationQueues.set(key, current);
  void current.finally(() => {
    if (lootOperationQueues.get(key) === current) lootOperationQueues.delete(key);
  }).catch(() => {});
  return current;
}

function activeOperationalGM() {
  return game.users.find(user => user.active && isOperationalGM(user)) ?? null;
}

function lootData(document) {
  const data = (document?.document ?? document)?.getFlag(MODULE_ID, FLAG);
  if (data?.version === 2 && Array.isArray(data.entries)) return {
    ...data,
    currency: normalizeCurrency(data),
    currencyImages: normalizeCurrencyImages(data)
  };
  if (data?.version === 1 && data.item && typeof data.item === "object") {
    return {
      ...data,
      version: 2,
      name: data.item.name,
      img: data.item.img,
      entries: [{ id: data.item._id || "legacy", item: data.item }],
      currency: emptyCurrency(),
      currencyImages: {}
    };
  }
  return null;
}

function lootImage(loot) {
  if (loot?.package || (loot?.entries?.length ?? 0) > 1 || hasCurrency(loot?.currency)) return loot?.img || PACKAGE_IMAGE;
  return loot?.img || loot?.entries?.[0]?.item?.img || "icons/svg/item-bag.svg";
}

function lootStackQuantity(loot) {
  if (loot?.package || loot?.entries?.length !== 1 || hasCurrency(loot?.currency)) return 0;
  return Math.max(0, Math.floor(itemQuantity(loot.entries[0].item)));
}

function tokenAppearance(loot) {
  const source = lootImage(loot);
  const quantity = lootStackQuantity(loot);
  return {
    name: quantity > 1 ? `x${quantity}` : (loot.name || uiText("TOVF.SceneLoot.Package", "Loot-Paket")),
    displayName: quantity > 1 ? CONST.TOKEN_DISPLAY_MODES.ALWAYS : CONST.TOKEN_DISPLAY_MODES.NONE,
    texture: { src: source, fit: "contain" },
    ring: {
      enabled: false,
      subject: { texture: source, scale: 1 }
    }
  };
}

function isOwnedActorItem(item, user) {
  return item?.parent?.documentName === "Actor"
    && (isOperationalGM(user) || item.parent.testUserPermission(user, "OWNER"));
}

function cleanItemData(item, quantity = itemQuantity(item)) {
  const data = foundry.utils.deepClone(item.toObject());
  delete data._id;
  delete data.folder;
  delete data.sort;
  if (data.system) data.system.container = null;
  setItemQuantity(data, quantity);
  return data;
}

function hasItemQuantity(item) {
  return foundry.utils.hasProperty(item, "system.quantity")
    || foundry.utils.hasProperty(item, "system.quantity.value");
}

function itemQuantity(item) {
  return systemItemQuantity(item);
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

function currencyItem(actor, denomination) {
  return actor.items.find(item => currencyIdentifier(item) === denomination) ?? null;
}

function validateCurrencyGrant(actor, currency) {
  for (const denomination of CURRENCY_DENOMINATIONS) {
    if (Number(currency?.[denomination]) > 0 && !currencyItem(actor, denomination)) {
      throw new Error(uiText("TOVF.SceneLoot.Errors.MissingCurrencyItem", "{name} besitzt kein W\u00e4hrungsitem f\u00fcr {currency}.", {
        name: actor.name,
        currency: currencyLabel(denomination)
      }));
    }
  }
}

async function grantCurrency(actor, currency) {
  validateCurrencyGrant(actor, currency);
  const updates = CURRENCY_DENOMINATIONS.flatMap(denomination => {
    const quantity = Math.max(0, Math.floor(Number(currency?.[denomination]) || 0));
    if (!quantity) return [];
    const item = currencyItem(actor, denomination);
    return [{ _id: item.id, ...quantityUpdate(item, itemQuantity(item) + quantity) }];
  });
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}

function entryId() {
  return foundry.utils.randomID();
}

function emptyCurrency() {
  return Object.fromEntries(CURRENCY_DENOMINATIONS.map(denomination => [denomination, 0]));
}

function currencyFromCopper(copper) {
  let remaining = Math.max(0, Math.floor(Number(copper) || 0));
  const currency = emptyCurrency();
  const values = coinValues();
  for (const denomination of CURRENCY_DENOMINATIONS) {
    const value = Math.max(1, Math.floor(Number(values[denomination]) || 1));
    currency[denomination] = Math.floor(remaining / value);
    remaining %= value;
  }
  return currency;
}

function normalizeCurrency(source) {
  if (source?.currency && typeof source.currency === "object") {
    return Object.fromEntries(CURRENCY_DENOMINATIONS.map(denomination => [
      denomination,
      Math.max(0, Math.floor(Number(source.currency[denomination]) || 0))
    ]));
  }
  return currencyFromCopper(source?.currencyCopper);
}

function hasCurrency(currency) {
  return CURRENCY_DENOMINATIONS.some(denomination => Number(currency?.[denomination]) > 0);
}

function totalCurrencyCopper(currency) {
  const values = coinValues();
  return CURRENCY_DENOMINATIONS.reduce((total, denomination) => (
    total + Math.max(0, Math.floor(Number(currency?.[denomination]) || 0)) * (Number(values[denomination]) || 0)
  ), 0);
}

function addCurrency(left, right) {
  return Object.fromEntries(CURRENCY_DENOMINATIONS.map(denomination => [
    denomination,
    Math.max(0, Math.floor(Number(left?.[denomination]) || 0))
      + Math.max(0, Math.floor(Number(right?.[denomination]) || 0))
  ]));
}

function normalizeCurrencyImages(source) {
  return Object.fromEntries(CURRENCY_DENOMINATIONS.flatMap(denomination => {
    const image = String(source?.currencyImages?.[denomination] ?? "").trim();
    return image ? [[denomination, image]] : [];
  }));
}

function mergeCurrencyImages(left, right) {
  return { ...normalizeCurrencyImages(right), ...normalizeCurrencyImages(left) };
}

function currencyImage(source, denomination) {
  const stored = normalizeCurrencyImages(source)[denomination];
  if (stored) return stored;
  for (const actor of game.actors ?? []) {
    const item = currencyItem(actor, denomination);
    if (item?.img) return item.img;
  }
  return "icons/svg/coins.svg";
}

function currencyLabel(denomination) {
  const fallbacks = { pp: "Platin", gp: "Gold", sp: "Silber", cp: "Copper" };
  return uiText(`TOVF.SceneLoot.Currency.${denomination}`, fallbacks[denomination] ?? denomination);
}

function formatCurrencyExact(currency) {
  const parts = CURRENCY_DENOMINATIONS.flatMap(denomination => {
    const quantity = Math.max(0, Math.floor(Number(currency?.[denomination]) || 0));
    return quantity ? [`${quantity} ${currencyLabel(denomination)}`] : [];
  });
  return parts.join(", ") || `0 ${currencyLabel("cp")}`;
}

function packageContents(container) {
  if (container?.type !== "container" || container.parent?.documentName !== "Actor") return [];
  const found = [];
  const visit = parentId => {
    for (const item of container.parent.items.filter(entry => entry.system?.container === parentId)) {
      found.push(item);
      if (item.type === "container") visit(item.id);
    }
  };
  visit(container.id);
  return found;
}

function mergeLootEntries(entries) {
  const merged = [];
  for (const source of entries) {
    const item = foundry.utils.deepClone(source.item);
    const match = UNSTACKABLE_ITEM_TYPES.has(item.type) ? null : merged.find(entry => (
      entry.item.type === item.type
      && !UNSTACKABLE_ITEM_TYPES.has(entry.item.type)
      && String(entry.item.name ?? "").trim().toLocaleLowerCase() === String(item.name ?? "").trim().toLocaleLowerCase()
    ));
    if (match && hasItemQuantity(match.item) && hasItemQuantity(item)) {
      setItemQuantity(match.item, itemQuantity(match.item) + itemQuantity(item));
    } else merged.push({ id: source.id || entryId(), item });
  }
  return merged;
}

function lootFromItems(items, { name = "", img = "", placedBy = "", package: isPackage = false } = {}) {
  const currency = emptyCurrency();
  const currencyImages = {};
  const entries = [];
  for (const item of items) {
    if (item.type === "currency") {
      if (itemQuantity(item) < 1) throw new Error(uiText("TOVF.SceneLoot.Errors.EmptyStack", "Von diesem Item ist keine Menge verf\u00fcgbar."));
      const denomination = currencyIdentifier(item);
      if (!CURRENCY_DENOMINATIONS.includes(denomination)) throw new Error(uiText("TOVF.SceneLoot.Errors.UnsupportedCurrency", "Diese W\u00e4hrungsart wird nicht unterst\u00fctzt."));
      currency[denomination] += Math.max(0, Math.floor(itemQuantity(item)));
      if (item.img) currencyImages[denomination] = item.img;
    }
    else entries.push({ id: entryId(), item: cleanItemData(item) });
  }
  return {
    version: 2,
    compositeVersion: COMPOSITE_VERSION,
    name: name || entries[0]?.item?.name || uiText("TOVF.SceneLoot.Package", "Loot-Paket"),
    img: img || (entries.length === 1 && !hasCurrency(currency) ? entries[0].item.img : PACKAGE_IMAGE),
    package: isPackage,
    entries: mergeLootEntries(entries),
    currency,
    currencyImages,
    placedBy
  };
}

function combineLoot(current, added) {
  const entries = mergeLootEntries([...(current?.entries ?? []), ...(added?.entries ?? [])]);
  const currency = addCurrency(normalizeCurrency(current), normalizeCurrency(added));
  const packageLike = entries.length > 1 || hasCurrency(currency);
  const isPackage = packageLike || current?.package === true || added?.package === true;
  return {
    version: 2,
    compositeVersion: COMPOSITE_VERSION,
    name: packageLike ? uiText("TOVF.SceneLoot.Package", "Loot-Paket") : entries[0]?.item?.name,
    img: isPackage ? (current?.package ? current.img : PACKAGE_IMAGE) : (current?.img || entries[0]?.item?.img),
    package: isPackage,
    entries,
    currency,
    currencyImages: mergeCurrencyImages(current, added),
    placedBy: current?.placedBy || added?.placedBy
  };
}

async function removeDroppedItems(items) {
  const byActor = new Map();
  for (const item of items) {
    if (item.parent?.documentName !== "Actor") continue;
    if (!byActor.has(item.parent)) byActor.set(item.parent, []);
    byActor.get(item.parent).push(item.id);
  }
  for (const [actor, ids] of byActor) await actor.deleteEmbeddedDocuments("Item", ids);
}

async function removeDroppedQuantity(item, quantity) {
  if (item.parent?.documentName !== "Actor") return;
  const remaining = itemQuantity(item) - quantity;
  if (remaining > 0 || item.type === "currency") await item.update(quantityUpdate(item, remaining));
  else await item.delete();
}

function dropPosition(scene, data) {
  const size = scene.grid.size || 100;
  const x = Math.floor(Number(data.x) / size) * size;
  const y = Math.floor(Number(data.y) / size) * size;
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, size };
}

async function resolveDropItem(data) {
  if (data.type !== "Item") return null;
  if (data.uuid) return Item.implementation.fromDropData(data).catch(() => null);
  return null;
}

async function createLoot({ sceneId, itemUuid, x, y, quantity = 1, targetLootUuid = null }, userId) {
  const user = game.users.get(userId);
  const scene = game.scenes.get(sceneId);
  const item = await fromUuid(itemUuid).catch(() => null);
  if (!user?.active || !scene || item?.documentName !== "Item") throw new Error(uiText("TOVF.SceneLoot.Errors.InvalidDrop", "Das Item oder die Szene ist nicht mehr verfügbar."));
  if (!isOperationalGM(user) && !isOwnedActorItem(item, user)) throw new Error(uiText("TOVF.SceneLoot.Errors.NotOwner", "Du kannst nur Items aus einem eigenen Charakterinventar ablegen."));

  const consumesSource = item.parent?.documentName === "Actor";
  const available = Math.floor(itemQuantity(item));
  if (consumesSource && hasItemQuantity(item) && available < 1) throw new Error(uiText("TOVF.SceneLoot.Errors.EmptyStack", "Von diesem Item ist keine Menge verf\u00fcgbar."));
  const requestedQuantity = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(quantity) || 1)));
  const selectedQuantity = consumesSource ? Math.clamp(requestedQuantity, 1, available) : requestedQuantity;
  const contained = packageContents(item);
  const containedLoot = contained.filter(entry => entry.type !== "container");
  let added;
  if (containedLoot.length) {
    added = lootFromItems(containedLoot, { name: item.name, img: PACKAGE_IMAGE, placedBy: user.id, package: true });
  } else if (item.type === "currency") {
    const denomination = currencyIdentifier(item);
    if (!CURRENCY_DENOMINATIONS.includes(denomination)) throw new Error(uiText("TOVF.SceneLoot.Errors.UnsupportedCurrency", "Diese W\u00e4hrungsart wird nicht unterst\u00fctzt."));
    const currency = emptyCurrency();
    currency[denomination] = selectedQuantity;
    added = {
      version: 2,
      compositeVersion: COMPOSITE_VERSION,
      name: uiText("TOVF.SceneLoot.Package", "Loot-Paket"),
      img: PACKAGE_IMAGE,
      package: true,
      entries: [],
      currency,
      currencyImages: item.img ? { [denomination]: item.img } : {},
      placedBy: user.id
    };
  } else {
    added = {
      version: 2,
      compositeVersion: COMPOSITE_VERSION,
      name: item.name,
      img: item.img,
      package: false,
      entries: [{ id: entryId(), item: cleanItemData(item, selectedQuantity) }],
      currency: emptyCurrency(),
      currencyImages: {},
      placedBy: user.id
    };
  }

  const targetToken = targetLootUuid ? await fromUuid(targetLootUuid).catch(() => null) : null;
  const targetLoot = targetToken?.documentName === "Token" && targetToken.parent?.id === scene.id
    ? lootData(targetToken)
    : null;
  if (targetLoot) {
    const combined = combineLoot(targetLoot, added);
    await targetToken.update({
      ...tokenAppearance(combined),
      [`flags.${MODULE_ID}.${FLAG}`]: combined
    }, { sceneItemLootAppearance: true });
    if (containedLoot.length) await removeDroppedItems([...contained, item]);
    else await removeDroppedQuantity(item, selectedQuantity);
    return { lootUuid: targetToken.uuid, name: combined.name, package: combined.package };
  }

  const position = dropPosition(scene, { x, y });
  const lootOffset = Math.round(position.size * (1 - LOOT_GRID_SCALE) / 2);
  const [lootToken] = await scene.createEmbeddedDocuments("Token", [{
    x: position.x + lootOffset,
    y: position.y + lootOffset,
    width: LOOT_GRID_SCALE,
    height: LOOT_GRID_SCALE,
    actorId: null,
    actorLink: false,
    disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL,
    displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
    sight: { enabled: false },
    ...tokenAppearance(added),
    flags: {
      [MODULE_ID]: {
        [FLAG]: added
      }
    }
  }]);
  if (containedLoot.length) await removeDroppedItems([...contained, item]);
  else await removeDroppedQuantity(item, selectedQuantity);
  return { lootUuid: lootToken.uuid, name: added.name, package: added.entries.length > 1 || hasCurrency(added.currency) };
}

function recipientContext(user) {
  const token = canvas.tokens?.controlled
    ?.find(entry => entry.actor?.testUserPermission(user, "OWNER"));
  if (token) return { actor: token.actor, token: token.document };
  return null;
}

function isAdjacentToLoot(token, lootToken) {
  if (!token || token.parent?.id !== lootToken.parent?.id) return false;
  const gridSize = Number(lootToken.parent?.grid?.size) || 100;
  const tokenCenterX = Number(token.x) + Number(token.width) * gridSize / 2;
  const tokenCenterY = Number(token.y) + Number(token.height) * gridSize / 2;
  const lootCenterX = Number(lootToken.x) + Number(lootToken.width) * gridSize / 2;
  const lootCenterY = Number(lootToken.y) + Number(lootToken.height) * gridSize / 2;
  const tolerance = Math.max(2, gridSize * 0.05);
  const allowedX = (Number(token.width) + 1) * gridSize / 2 + tolerance;
  const allowedY = (Number(token.height) + 1) * gridSize / 2 + tolerance;
  return Math.abs(tokenCenterX - lootCenterX) <= allowedX
    && Math.abs(tokenCenterY - lootCenterY) <= allowedY;
}

function challengePartyActors() {
  const ids = new Set(game.settings.get(MODULE_ID, PARTY_ACTORS_SETTING) ?? []);
  return game.actors.filter(actor => actor.type === "pc" && ids.has(actor.id) && actor.getFlag(MODULE_ID, "active") !== false);
}

function hasLoot(loot) {
  return (loot.entries?.length ?? 0) > 0 || hasCurrency(loot.currency);
}

async function persistLoot(lootToken, loot) {
  if (!hasLoot(loot)) return lootToken.delete();
  delete loot.currencyCopper;
  loot.name = (loot.package || loot.entries.length > 1 || hasCurrency(loot.currency))
    ? uiText("TOVF.SceneLoot.Package", "Loot-Paket")
    : loot.entries[0].item.name;
  if (loot.package) loot.img ||= PACKAGE_IMAGE;
  else if (loot.entries.length > 1 || hasCurrency(loot.currency)) loot.img = PACKAGE_IMAGE;
  else loot.img ||= loot.entries[0].item.img;
  await lootToken.update({
    ...tokenAppearance(loot),
    [`flags.${MODULE_ID}.${FLAG}`]: loot
  }, { sceneItemLootAppearance: true });
}

function lootChatContent(data) {
  const escape = foundry.utils.escapeHTML;
  const rows = data.entries.map(entry => `<li><img src="${escape(entry.img || "icons/svg/item-bag.svg")}" alt=""><span><strong>${entry.quantity}&times; ${escape(entry.name)}</strong></span></li>`).join("");
  const currency = CURRENCY_DENOMINATIONS.map(denomination => {
    const quantity = Math.max(0, Math.floor(Number(data.currency?.[denomination]) || 0));
    return quantity > 0
      ? `<li><img src="${escape(currencyImage(data, denomination))}" alt=""><span><strong>${quantity}&times; ${currencyLabel(denomination)}</strong></span></li>`
      : "";
  }).join("");
  const currencyTotal = totalCurrencyCopper(data.currency);
  return `<div class="tovf-merchant-chat-card tovf-loot-chat-card"><header><img src="${escape(data.lootImg || PACKAGE_IMAGE)}" alt=""><span><strong>${escape(data.lootName)}</strong><small>${uiText("TOVF.SceneLoot.TakenBy", "Entnommen von {name}", { name: escape(data.actorName) })}</small></span></header><ul>${rows}${currency}</ul><footer><span>${uiText("TOVF.SceneLoot.ChatTotal", "Bisher entnommen")}</span><strong>${data.entries.reduce((sum, entry) => sum + entry.quantity, 0)} ${uiText("TOVF.SceneLoot.Items", "Items")}${currencyTotal > 0 ? ` + ${formatCurrencyExact(data.currency)}` : ""}</strong></footer></div>`;
}

async function recordLootPickup({ lootToken, loot, actor, userId, entries = [], currency = null, currencyImages = null }) {
  if (!actor || (!entries.length && !hasCurrency(currency))) return;
  const lootId = lootToken.uuid;
  const existing = game.messages.find(message => {
    const stored = message.getFlag(MODULE_ID, "sceneLootPickup");
    return stored?.lootId === lootId && stored?.actorId === actor.id;
  });
  const stored = foundry.utils.deepClone(existing?.getFlag(MODULE_ID, "sceneLootPickup") ?? {
    lootId,
    lootName: loot.name || uiText("TOVF.SceneLoot.Package", "Loot-Paket"),
    lootImg: loot.img || lootImage(loot),
    actorId: actor.id,
    actorName: actor.name,
    entries: [],
    currency: emptyCurrency(),
    currencyImages: {}
  });
  stored.currency = stored.currency ? normalizeCurrency(stored) : currencyFromCopper(stored.currencyCopper);
  stored.currencyImages = mergeCurrencyImages(stored, { currencyImages });
  delete stored.currencyCopper;
  for (const taken of entries) {
    const identity = `${taken.type}\u0000${String(taken.name).trim().toLocaleLowerCase()}`;
    const row = stored.entries.find(entry => entry.identity === identity);
    if (row) row.quantity += taken.quantity;
    else stored.entries.push({ identity, type: taken.type, name: taken.name, img: taken.img, quantity: taken.quantity });
  }
  stored.currency = addCurrency(stored.currency, currency);
  const content = lootChatContent(stored);
  if (existing) await existing.update({ content, [`flags.${MODULE_ID}.sceneLootPickup`]: stored });
  else await ChatMessage.create({
    user: userId,
    speaker: ChatMessage.getSpeaker({ actor }),
    content,
    flags: { [MODULE_ID]: { sceneLootPickup: stored } }
  });
}

async function pickUpLoot({ lootUuid, actorUuid, tokenUuid, selections = null }, userId) {
  const user = game.users.get(userId);
  const lootToken = await fromUuid(lootUuid).catch(() => null);
  const actor = await fromUuid(actorUuid).catch(() => null);
  const token = tokenUuid ? await fromUuid(tokenUuid).catch(() => null) : null;
  const loot = lootData(lootToken);
  if (!user?.active || actor?.documentName !== "Actor") throw new Error(uiText("TOVF.SceneLoot.Errors.Unavailable", "Dieses Item ist nicht mehr verf\u00fcgbar."));
  if (lootToken?.documentName !== "Token" || !loot) throw new Error(uiText("TOVF.SceneLoot.Errors.Gone", "Das gew\u00fcnschte Item ist nicht mehr vorhanden."));
  if (!isOperationalGM(user) && !actor.testUserPermission(user, "OWNER")) throw new Error(uiText("TOVF.SceneLoot.Errors.Recipient", "Du kannst dieses Item nur in einen eigenen Charakter aufnehmen."));
  if (!isOperationalGM(user)) {
    if (token?.documentName !== "Token" || token.actor?.uuid !== actor.uuid || !token.actor?.testUserPermission(user, "OWNER")) {
      throw new Error(uiText("TOVF.SceneLoot.Errors.NoCharacter", "Wähle einen eigenen Token aus, um das Item aufzunehmen."));
    }
    if (!isAdjacentToLoot(token, lootToken)) throw new Error(uiText("TOVF.SceneLoot.Errors.OutOfReach", "Das Item kann nur vom gleichen oder einem angrenzenden Feld aufgenommen werden."));
  }
  const wanted = Array.isArray(selections)
    ? selections
    : loot.entries.map(entry => ({ id: entry.id, quantity: itemQuantity(entry.item) }));
  if (!wanted.length) throw new Error(uiText("TOVF.SceneLoot.Errors.Selection", "W\u00e4hle mindestens ein Item aus."));
  const lootSource = { name: loot.name, img: loot.img, currencyImages: loot.currencyImages };
  const taken = [];
  for (const selection of wanted) {
    const entry = loot.entries.find(candidate => candidate.id === selection.id);
    if (!entry) continue;
    const available = Math.max(0, Math.floor(itemQuantity(entry.item)));
    const quantity = Math.clamp(Math.floor(Number(selection.quantity) || 0), 0, available);
    if (!quantity) continue;
    const data = foundry.utils.deepClone(entry.item);
    setItemQuantity(data, quantity);
    await grantLootItem(actor, data);
    taken.push({ type: entry.item.type, name: entry.item.name, img: entry.item.img, quantity });
    if (quantity >= available) loot.entries.splice(loot.entries.indexOf(entry), 1);
    else setItemQuantity(entry.item, available - quantity);
  }
  if (!taken.length) throw new Error(uiText("TOVF.SceneLoot.Errors.Gone", "Das gew\u00fcnschte Item ist nicht mehr vorhanden."));
  await persistLoot(lootToken, loot);
  await recordLootPickup({ lootToken, loot: lootSource, actor, userId, entries: taken }).catch(error => {
    console.error(`${MODULE_ID} | Could not record scene loot pickup chat card`, error);
  });
  return { name: taken.map(entry => `${entry.quantity}\u00d7 ${entry.name}`).join(", "), taken };
}

async function pickUpLootCurrency({ lootUuid, actorUuid, tokenUuid, denomination, quantity }, userId) {
  const user = game.users.get(userId);
  const lootToken = await fromUuid(lootUuid).catch(() => null);
  const actor = await fromUuid(actorUuid).catch(() => null);
  const token = tokenUuid ? await fromUuid(tokenUuid).catch(() => null) : null;
  const loot = lootData(lootToken);
  if (!user?.active || actor?.documentName !== "Actor") throw new Error(uiText("TOVF.SceneLoot.Errors.Unavailable", "Dieses Item ist nicht mehr verf\u00fcgbar."));
  if (lootToken?.documentName !== "Token" || !loot) throw new Error(uiText("TOVF.SceneLoot.Errors.CurrencyGone", "Die gew\u00fcnschte W\u00e4hrung ist nicht mehr vorhanden."));
  if (!isOperationalGM(user) && !actor.testUserPermission(user, "OWNER")) throw new Error(uiText("TOVF.SceneLoot.Errors.Recipient", "Du kannst dieses Item nur in einen eigenen Charakter aufnehmen."));
  if (!isOperationalGM(user)) {
    if (token?.documentName !== "Token" || token.actor?.uuid !== actor.uuid || !token.actor?.testUserPermission(user, "OWNER")) throw new Error(uiText("TOVF.SceneLoot.Errors.NoCharacter", "W\u00e4hle einen eigenen Token aus, um das Item aufzunehmen."));
    if (!isAdjacentToLoot(token, lootToken)) throw new Error(uiText("TOVF.SceneLoot.Errors.OutOfReach", "Das Item kann nur vom gleichen oder einem angrenzenden Feld aufgenommen werden."));
  }
  if (!CURRENCY_DENOMINATIONS.includes(denomination)) throw new Error(uiText("TOVF.SceneLoot.Errors.UnsupportedCurrency", "Diese W\u00e4hrungsart wird nicht unterst\u00fctzt."));
  const available = Math.max(0, Math.floor(Number(loot.currency[denomination]) || 0));
  const requested = Math.max(0, Math.floor(Number(quantity) || 0));
  const taken = Math.min(requested, available);
  if (!taken) throw new Error(uiText("TOVF.SceneLoot.Errors.CurrencyGone", "Die gew\u00fcnschte W\u00e4hrung ist nicht mehr vorhanden."));
  const takenCurrency = emptyCurrency();
  takenCurrency[denomination] = taken;
  validateCurrencyGrant(actor, takenCurrency);
  const lootSource = { name: loot.name, img: loot.img, currencyImages: loot.currencyImages };
  await grantCurrency(actor, takenCurrency);
  loot.currency[denomination] = available - taken;
  await persistLoot(lootToken, loot);
  await recordLootPickup({ lootToken, loot: lootSource, actor, userId, currency: takenCurrency, currencyImages: lootSource.currencyImages }).catch(error => {
    console.error(`${MODULE_ID} | Could not record scene loot currency chat card`, error);
  });
  return { amount: `${taken} ${currencyLabel(denomination)}`, denomination, quantity: taken };
}

async function distributeLootCurrency({ lootUuid, actorUuid, tokenUuid }, userId) {
  const user = game.users.get(userId);
  const lootToken = await fromUuid(lootUuid).catch(() => null);
  const actor = await fromUuid(actorUuid).catch(() => null);
  const token = tokenUuid ? await fromUuid(tokenUuid).catch(() => null) : null;
  const loot = lootData(lootToken);
  if (!user?.active || (!isOperationalGM(user) && actor?.documentName !== "Actor")) throw new Error(uiText("TOVF.SceneLoot.Errors.Unavailable", "Dieses Item ist nicht mehr verf\u00fcgbar."));
  if (lootToken?.documentName !== "Token" || !loot) throw new Error(uiText("TOVF.SceneLoot.Errors.CurrencyGone", "Die gew\u00fcnschte W\u00e4hrung ist nicht mehr vorhanden."));
  if (!isOperationalGM(user)) {
    if (!actor.testUserPermission(user, "OWNER")) throw new Error(uiText("TOVF.SceneLoot.Errors.Recipient", "Du kannst dieses Item nur in einen eigenen Charakter aufnehmen."));
    if (token?.documentName !== "Token" || token.actor?.uuid !== actor.uuid || !token.actor?.testUserPermission(user, "OWNER")) throw new Error(uiText("TOVF.SceneLoot.Errors.NoCharacter", "W\u00e4hle einen eigenen Token aus, um das Item aufzunehmen."));
    if (!isAdjacentToLoot(token, lootToken)) throw new Error(uiText("TOVF.SceneLoot.Errors.OutOfReach", "Das Item kann nur vom gleichen oder einem angrenzenden Feld aufgenommen werden."));
  }
  const party = challengePartyActors();
  if (!party.length) throw new Error(uiText("TOVF.SceneLoot.Errors.NoParty", "Im Challenge Manager ist keine Party ausgew\u00e4hlt."));
  const shareCurrency = Object.fromEntries(CURRENCY_DENOMINATIONS.map(denomination => [
    denomination,
    Math.floor(Math.max(0, Number(loot.currency[denomination]) || 0) / party.length)
  ]));
  if (!hasCurrency(shareCurrency)) throw new Error(uiText("TOVF.SceneLoot.Errors.CurrencyTooSmall", "Die vorhandenen M\u00fcnzen lassen sich nicht weiter gleichm\u00e4\u00dfig aufteilen."));
  for (const member of party) validateCurrencyGrant(member, shareCurrency);
  for (const member of party) await grantCurrency(member, shareCurrency);
  loot.currency = Object.fromEntries(CURRENCY_DENOMINATIONS.map(denomination => [
    denomination,
    loot.currency[denomination] - shareCurrency[denomination] * party.length
  ]));
  const lootSource = { name: loot.name, img: loot.img, currencyImages: loot.currencyImages };
  await persistLoot(lootToken, loot);
  for (const member of party) {
    await recordLootPickup({ lootToken, loot: lootSource, actor: member, userId, currency: shareCurrency, currencyImages: lootSource.currencyImages }).catch(error => {
      console.error(`${MODULE_ID} | Could not record distributed scene loot currency chat card`, error);
    });
  }
  return { amount: formatCurrencyExact(shareCurrency), count: party.length, remainder: formatCurrencyExact(loot.currency) };
}

async function configureLoot({ lootUuid, entries = {}, currency = {} }, userId) {
  const user = game.users.get(userId);
  const lootToken = await fromUuid(lootUuid).catch(() => null);
  const loot = lootData(lootToken);
  if (!user?.active || !isOperationalGM(user)) throw new Error(uiText("TOVF.SceneLoot.Errors.Configure", "Daf\u00fcr fehlt die Berechtigung."));
  if (lootToken?.documentName !== "Token" || !loot) throw new Error(uiText("TOVF.SceneLoot.Errors.Gone", "Das gew\u00fcnschte Loot ist nicht mehr vorhanden."));

  for (const entry of loot.entries) {
    if (!Object.hasOwn(entries, entry.id)) continue;
    setItemQuantity(entry.item, Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(entries[entry.id]) || 0))));
  }
  loot.entries = loot.entries.filter(entry => itemQuantity(entry.item) > 0);
  loot.currency = Object.fromEntries(CURRENCY_DENOMINATIONS.map(denomination => [
    denomination,
    Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(currency[denomination]) || 0)))
  ]));
  await persistLoot(lootToken, loot);
  return { name: loot.name || uiText("TOVF.SceneLoot.Package", "Loot-Paket") };
}

async function execute(action, payload, userId) {
  if (action === "drop") {
    if (payload.targetLootUuid) return enqueueLootOperation(payload.targetLootUuid, () => createLoot(payload, userId));
    return createLoot(payload, userId);
  }
  if (action === "pickup") return enqueueLootOperation(payload.lootUuid, () => pickUpLoot(payload, userId));
  if (action === "pickupCurrency") return enqueueLootOperation(payload.lootUuid, () => pickUpLootCurrency(payload, userId));
  if (action === "distributeCurrency") return enqueueLootOperation(payload.lootUuid, () => distributeLootCurrency(payload, userId));
  if (action === "configure") return enqueueLootOperation(payload.lootUuid, () => configureLoot(payload, userId));
  throw new Error("Unbekannte Szenenbeute-Aktion.");
}

async function request(action, payload) {
  if (isOperationalGM(game.user)) return execute(action, payload, game.user.id);
  const gm = activeOperationalGM();
  if (!gm) throw new Error(uiText("TOVF.SceneLoot.Errors.GM", "Zum Ablegen oder Aufnehmen von Szenen-Items muss eine Spielleitung verbunden sein."));
  const requestId = foundry.utils.randomID();
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(uiText("TOVF.SceneLoot.Errors.Timeout", "Die Spielleitung hat nicht auf die Szenen-Item-Anfrage reagiert.")));
    }, 30000);
    pending.set(requestId, {
      resolve: result => { clearTimeout(timeout); resolve(result); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(`module.${MODULE_ID}`, { scope: SOCKET_SCOPE, type: "request", requestId, targetGMId: gm.id, userId: game.user.id, action, payload });
  return response;
}

async function chooseDropQuantity(item) {
  const consumesSource = item.parent?.documentName === "Actor";
  const available = Math.max(1, Math.floor(itemQuantity(item)));
  if (packageContents(item).some(entry => entry.type !== "container")) return available;
  if (consumesSource && available <= 1) return available;
  const maximum = consumesSource ? ` max="${available}"` : "";
  return foundry.applications.api.DialogV2.prompt({
        classes: ["tovf-scene-loot-dialog"],
        window: { title: uiText("TOVF.SceneLoot.DropTitle", "Item ablegen") },
        content: `<div class="standard-form"><div class="form-group"><label>${uiText("TOVF.SceneLoot.Quantity", "Menge")}</label><input type="number" name="quantity" value="${available}" min="1"${maximum} step="1"></div></div>`,
        ok: {
          label: uiText("TOVF.SceneLoot.Place", "Ablegen"),
          callback: (_event, button) => Math.max(1, Math.floor(Number(new FormData(button.form).get("quantity")) || 1))
        },
        rejectClose: false
      });
}

async function handleCanvasDrop(canvas, data) {
  const item = await resolveDropItem(data);
  if (!item || canvas.scene?.id !== data.sceneId && data.sceneId) return;
  try {
    const quantity = await chooseDropQuantity(item);
    if (!quantity) return false;
    const target = lootTokenAt({ x: data.x, y: data.y });
    const result = await request("drop", {
      sceneId: canvas.scene.id,
      itemUuid: item.uuid,
      x: data.x,
      y: data.y,
      quantity,
      targetLootUuid: target?.uuid ?? null
    });
    ui.notifications.info(uiText("TOVF.SceneLoot.Placed", "{name} liegt jetzt auf der Szene. Doppelklick zum Aufnehmen.", result));
  } catch (error) {
    console.error(`${MODULE_ID} | Could not place scene item loot`, error);
    ui.notifications.error(error.message);
  }
  return false;
}

function lootTokenAt(point) {
  return canvas.tokens?.placeables
    ?.filter(token => lootData(token.document)
      && (!token.document.hidden || isOperationalGM(game.user))
      && token.bounds?.contains?.(point.x, point.y))
    .sort((left, right) => (right.document.elevation ?? 0) - (left.document.elevation ?? 0))[0]?.document ?? null;
}

function addOpenLootDialog(lootUuid, dialog) {
  if (!openLootDialogs.has(lootUuid)) openLootDialogs.set(lootUuid, new Set());
  openLootDialogs.get(lootUuid).add(dialog);
}

function removeOpenLootDialog(lootUuid, dialog) {
  const dialogs = openLootDialogs.get(lootUuid);
  dialogs?.delete(dialog);
  if (!dialogs?.size) openLootDialogs.delete(lootUuid);
}

function setLootDialogStatus(dialog, message, { error = false } = {}) {
  const status = dialog.element?.querySelector("[data-loot-live-status]");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", error);
}

function lootItemRow(entry, recipient) {
  const escape = foundry.utils.escapeHTML;
  const quantity = Math.max(0, Math.floor(itemQuantity(entry.item)));
  const takeOne = recipient
    ? `<button type="button" data-loot-take-one="${entry.id}" title="${uiText("TOVF.SceneLoot.TakeOne", "Genau 1 aufnehmen")}" aria-label="${uiText("TOVF.SceneLoot.TakeOne", "Genau 1 aufnehmen")}"><i class="fa-solid fa-hand" inert></i><b>1</b></button>`
    : "";
  return `<div class="tovf-scene-loot-row" data-loot-entry="${entry.id}"><input type="checkbox" data-loot-select="${entry.id}" checked><img src="${escape(entry.item.img || "icons/svg/item-bag.svg")}" alt=""><span><strong>${escape(entry.item.name)}</strong></span><label class="tovf-scene-loot-quantity"><input type="number" data-loot-quantity="${entry.id}" value="0" min="0" max="${quantity}" step="1"><small>/<b data-loot-available>${quantity}</b></small></label>${takeOne}</div>`;
}

function lootCurrencyRow(denomination, quantity, recipient, loot) {
  const escape = foundry.utils.escapeHTML;
  const take = recipient
    ? `<button type="button" data-loot-take-currency="${denomination}" title="${uiText("TOVF.SceneLoot.TakeCurrency", "M\u00fcnzen aufnehmen")}" disabled><i class="fa-solid fa-hand" inert></i></button>`
    : "";
  return `<div class="tovf-scene-loot-currency-row" data-loot-currency="${denomination}"><img src="${escape(currencyImage(loot, denomination))}" alt=""><span><strong>${currencyLabel(denomination)}</strong></span><label class="tovf-scene-loot-quantity"><input type="number" data-loot-currency-amount="${denomination}" value="0" min="0" max="${quantity}" step="1"><small>/<b data-loot-currency-available>${quantity}</b></small></label>${take}</div>`;
}

function refreshLootDialog(dialog, loot, { preserveStatus = false } = {}) {
  const root = dialog.element;
  if (!root) return;
  const recipient = dialog._tovfLootRecipient;
  const entries = new Map((loot?.entries ?? []).map(entry => [entry.id, Math.max(0, Math.floor(itemQuantity(entry.item)))]));
  const items = root.querySelector("[data-loot-items]");
  for (const entry of loot?.entries ?? []) {
    if (!root.querySelector(`[data-loot-entry="${entry.id}"]`)) items?.insertAdjacentHTML("beforeend", lootItemRow(entry, recipient));
  }
  for (const row of root.querySelectorAll("[data-loot-entry]")) {
    const available = entries.get(row.dataset.lootEntry) ?? 0;
    row.querySelector("[data-loot-available]").textContent = String(available);
    const quantity = row.querySelector("[data-loot-quantity]");
    if (quantity) quantity.max = String(available);
    row.classList.toggle("is-unavailable", available <= 0);
    for (const control of row.querySelectorAll("input[type='checkbox'], [data-loot-take-one]")) control.disabled = available <= 0;
  }
  const currencyBlock = root.querySelector("[data-loot-currency-block]");
  const currencyRows = root.querySelector("[data-loot-currency-rows]");
  const normalizedCurrency = normalizeCurrency(loot);
  for (const denomination of CURRENCY_DENOMINATIONS) {
    const available = normalizedCurrency[denomination];
    let row = root.querySelector(`[data-loot-currency="${denomination}"]`);
    if (!row && available > 0) {
      currencyRows?.insertAdjacentHTML("beforeend", lootCurrencyRow(denomination, available, recipient, loot));
      row = root.querySelector(`[data-loot-currency="${denomination}"]`);
    }
    if (!row) continue;
    const image = row.querySelector("img");
    if (image) image.src = currencyImage(loot, denomination);
    row.classList.toggle("is-unavailable", available <= 0);
    row.querySelector("[data-loot-currency-available]").textContent = String(available);
    const amount = row.querySelector("[data-loot-currency-amount]");
    if (amount) amount.max = String(available);
    const take = row.querySelector("[data-loot-take-currency]");
    if (take) take.disabled = available <= 0 || Math.floor(Number(amount?.value) || 0) <= 0;
  }
  if (currencyBlock) currencyBlock.hidden = !hasCurrency(normalizedCurrency) && !currencyRows?.children.length;
  const distribute = root.querySelector("[data-loot-distribute-currency]");
  if (distribute) {
    distribute.hidden = !hasCurrency(normalizedCurrency);
    distribute.disabled = !hasCurrency(normalizedCurrency);
  }
  const takeSelected = root.querySelector("[data-loot-take-selected]");
  if (takeSelected) {
    const hasItems = Boolean(loot?.entries?.some(entry => itemQuantity(entry.item) > 0));
    takeSelected.hidden = !hasItems;
    takeSelected.disabled = !hasItems;
  }
  if (!preserveStatus) {
    if (!loot || !hasLoot(loot)) setLootDialogStatus(dialog, uiText("TOVF.SceneLoot.Empty", "Das Paket ist leer."));
    else setLootDialogStatus(dialog, "");
  }
}

function refreshOpenLootDialogs(lootToken, { deleted = false } = {}) {
  const lootUuid = lootToken?.uuid;
  if (!lootUuid) return;
  const loot = deleted ? null : lootData(lootToken);
  for (const dialog of openLootDialogs.get(lootUuid) ?? []) refreshLootDialog(dialog, loot);
}

async function runLootDialogRequest(dialog, button, action, payload, successKey, successFallback) {
  button.disabled = true;
  try {
    const result = await request(action, payload);
    const message = uiText(successKey, successFallback, result);
    setLootDialogStatus(dialog, message);
    ui.notifications.info(message);
    return result;
  } catch (error) {
    console.error(`${MODULE_ID} | Could not complete scene loot dialog action`, error);
    setLootDialogStatus(dialog, error.message, { error: true });
    ui.notifications.warn(error.message);
    return null;
  } finally {
    button.disabled = false;
    const lootToken = payload.lootUuid ? await fromUuid(payload.lootUuid).catch(() => null) : null;
    refreshLootDialog(dialog, lootToken ? lootData(lootToken) : null, { preserveStatus: true });
  }
}

async function openLootConfiguration(lootToken) {
  if (!isOperationalGM(game.user)) return;
  const currentToken = await fromUuid(lootToken.uuid).catch(() => null);
  const loot = lootData(currentToken);
  if (!loot) {
    ui.notifications.warn(uiText("TOVF.SceneLoot.Errors.Gone", "Das gew\u00fcnschte Loot ist nicht mehr vorhanden."));
    return;
  }

  const escape = foundry.utils.escapeHTML;
  const itemRows = loot.entries.map(entry => `
    <label class="tovf-scene-loot-config-row">
      <img src="${escape(entry.item.img || "icons/svg/item-bag.svg")}" alt="">
      <span>${escape(entry.item.name)}</span>
      <input type="number" data-loot-config-entry="${entry.id}" value="${Math.max(0, Math.floor(itemQuantity(entry.item)))}" min="0" step="1">
    </label>`).join("");
  const normalizedCurrency = normalizeCurrency(loot);
  const currencyRows = CURRENCY_DENOMINATIONS.map(denomination => `
    <label class="tovf-scene-loot-config-row">
      <img src="${escape(currencyImage(loot, denomination))}" alt="">
      <span>${currencyLabel(denomination)}</span>
      <input type="number" data-loot-config-currency="${denomination}" value="${normalizedCurrency[denomination]}" min="0" step="1">
    </label>`).join("");

  const configured = await foundry.applications.api.DialogV2.wait({
    classes: ["tovf-scene-loot-dialog", "tovf-scene-loot-config-dialog"],
    window: { title: uiText("TOVF.SceneLoot.ConfigurationTitle", "Loot konfigurieren") },
    position: { width: 460 },
    content: `<div class="tovf-scene-loot-config"><p>${uiText("TOVF.SceneLoot.ConfigurationHint", "Mengen direkt bearbeiten. Ein Wert von 0 entfernt den jeweiligen Inhalt.")}</p><section><h3>${uiText("TOVF.SceneLoot.Items", "Items")}</h3>${itemRows || `<p>${uiText("TOVF.SceneLoot.NoItems", "Keine Items enthalten.")}</p>`}</section><section><h3>${uiText("TOVF.SceneLoot.Coins", "M\u00fcnzen")}</h3>${currencyRows}</section></div>`,
    buttons: [
      {
        action: "save",
        default: true,
        icon: "fa-solid fa-floppy-disk",
        label: uiText("TOVF.SceneLoot.SaveConfiguration", "Speichern"),
        callback: (_event, button) => ({
          entries: Object.fromEntries([...button.form.querySelectorAll("[data-loot-config-entry]")].map(input => [
            input.dataset.lootConfigEntry,
            Math.max(0, Math.floor(Number(input.value) || 0))
          ])),
          currency: Object.fromEntries([...button.form.querySelectorAll("[data-loot-config-currency]")].map(input => [
            input.dataset.lootConfigCurrency,
            Math.max(0, Math.floor(Number(input.value) || 0))
          ]))
        })
      },
      { action: "cancel", icon: "fa-solid fa-xmark", label: game.i18n.localize("Cancel"), callback: () => null }
    ],
    rejectClose: false
  });
  if (!configured) return;
  try {
    await request("configure", { lootUuid: currentToken.uuid, ...configured });
    ui.notifications.info(uiText("TOVF.SceneLoot.Configured", "Loot wurde aktualisiert."));
  } catch (error) {
    console.error(`${MODULE_ID} | Could not configure scene loot`, error);
    ui.notifications.error(error.message);
  }
}

async function openLootDialog({ lootToken, loot, recipient, base }) {
  const existing = [...(openLootDialogs.get(lootToken.uuid) ?? [])].find(dialog => dialog.rendered);
  if (existing) {
    existing.bringToFront();
    return;
  }

  const itemRows = loot.entries.map(entry => lootItemRow(entry, recipient)).join("");
  const normalizedCurrency = normalizeCurrency(loot);
  const currencyRows = CURRENCY_DENOMINATIONS.map(denomination => {
    const quantity = normalizedCurrency[denomination];
    return quantity > 0 ? lootCurrencyRow(denomination, quantity, recipient, loot) : "";
  }).join("");
  const currency = `<section class="tovf-scene-loot-currency" data-loot-currency-block${hasCurrency(normalizedCurrency) ? "" : " hidden"}><h3><i class="fa-solid fa-coins" inert></i>${uiText("TOVF.SceneLoot.Coins", "M\u00fcnzen")}</h3><div data-loot-currency-rows>${currencyRows}</div></section>`;
  const takeSelected = recipient
    ? `<button type="button" data-loot-take-selected${loot.entries.length ? "" : " hidden"}><i class="fa-solid fa-hand" inert></i>${uiText("TOVF.SceneLoot.TakeSelected", "Auswahl aufnehmen")}</button>`
    : "";
  const distribute = `<button type="button" data-loot-distribute-currency${hasCurrency(normalizedCurrency) ? "" : " hidden"}><i class="fa-solid fa-people-group" inert></i>${uiText("TOVF.SceneLoot.DistributeCurrency", "Alle M\u00fcnzen auf Party verteilen")}</button>`;
  const actions = `<div class="tovf-scene-loot-actions">${takeSelected}${distribute}</div>`;
  const configuration = isOperationalGM(game.user)
    ? `<div class="tovf-scene-loot-configuration"><button type="button" data-loot-configure><i class="fa-solid fa-gear" inert></i>${uiText("TOVF.SceneLoot.Configure", "Loot konfigurieren")}</button></div>`
    : "";

  await foundry.applications.api.DialogV2.wait({
    classes: ["tovf-scene-loot-dialog"],
    window: { title: loot.name || uiText("TOVF.SceneLoot.Package", "Loot-Paket") },
    position: { width: 520 },
    content: `<div class="tovf-scene-loot-form">${configuration}<div data-loot-items>${itemRows}</div>${currency}${actions}<p class="tovf-scene-loot-live-status" data-loot-live-status aria-live="polite"></p></div>`,
    render: (_event, dialog) => {
      dialog._tovfLootRecipient = recipient;
      addOpenLootDialog(lootToken.uuid, dialog);
      dialog.element.addEventListener("click", event => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.matches("[data-loot-configure]")) {
          void openLootConfiguration(lootToken);
          return;
        }
        if (button.matches("[data-loot-take-one]")) {
          void runLootDialogRequest(dialog, button, "pickup", {
            ...base,
            selections: [{ id: button.dataset.lootTakeOne, quantity: 1 }]
          }, "TOVF.SceneLoot.PickedUp", "{name} wurde aufgenommen.");
          return;
        }
        if (button.matches("[data-loot-take-selected]")) {
          const selections = [...dialog.element.querySelectorAll("[data-loot-select]:checked:not(:disabled)")]
            .map(input => ({
              id: input.dataset.lootSelect,
              quantity: Math.max(0, Math.floor(Number(dialog.element.querySelector(`[data-loot-quantity="${input.dataset.lootSelect}"]`)?.value) || 0))
            }))
            .filter(selection => selection.quantity > 0);
          if (selections.length) void runLootDialogRequest(dialog, button, "pickup", { ...base, selections }, "TOVF.SceneLoot.PickedUp", "{name} wurde aufgenommen.");
          return;
        }
        if (button.matches("[data-loot-take-currency]")) {
          const denomination = button.dataset.lootTakeCurrency;
          const quantity = Number(dialog.element.querySelector(`[data-loot-currency-amount="${denomination}"]`)?.value);
          if (!(quantity > 0)) return;
          void runLootDialogRequest(dialog, button, "pickupCurrency", { ...base, denomination, quantity }, "TOVF.SceneLoot.CurrencyPickedUp", "{amount} wurden aufgenommen.");
          return;
        }
        if (button.matches("[data-loot-distribute-currency]")) {
          void runLootDialogRequest(dialog, button, "distributeCurrency", base, "TOVF.SceneLoot.CurrencyDistributed", "{amount} wurden an {count} Partymitglieder verteilt.");
        }
      });
      dialog.element.addEventListener("input", event => {
        const input = event.target.closest("[data-loot-currency-amount]");
        if (!input) return;
        const row = input.closest("[data-loot-currency]");
        const take = row?.querySelector("[data-loot-take-currency]");
        const available = Number(row?.querySelector("[data-loot-currency-available]")?.textContent) || 0;
        if (take) take.disabled = available <= 0 || Math.floor(Number(input.value) || 0) <= 0;
      });
      dialog.element.addEventListener("dragover", event => event.preventDefault());
      dialog.element.addEventListener("drop", event => {
        event.preventDefault();
        event.stopPropagation();
        void (async () => {
          try {
            const raw = event.dataTransfer?.getData("text/plain");
            const data = raw ? JSON.parse(raw) : null;
            const item = data ? await resolveDropItem(data) : null;
            if (!item) return;
            const quantity = await chooseDropQuantity(item);
            if (!quantity) return;
            await request("drop", {
              sceneId: lootToken.parent.id,
              itemUuid: item.uuid,
              x: lootToken.x,
              y: lootToken.y,
              quantity,
              targetLootUuid: lootToken.uuid
            });
          } catch (error) {
            console.error(`${MODULE_ID} | Could not add dropped Item to open loot package`, error);
            setLootDialogStatus(dialog, error.message, { error: true });
            ui.notifications.warn(error.message);
          }
        })();
      });
      refreshLootDialog(dialog, lootData(lootToken));
    },
    close: (_event, dialog) => removeOpenLootDialog(lootToken.uuid, dialog),
    buttons: [{ action: "close", icon: "fa-solid fa-xmark", label: game.i18n.localize("Close") }],
    rejectClose: false
  });
}

async function pickUpLootToken(lootToken) {
  const loot = lootData(lootToken);
  if (!loot) return false;
  const recipient = recipientContext(game.user);
  if (!recipient && !isOperationalGM(game.user)) {
    ui.notifications.warn(uiText("TOVF.SceneLoot.Errors.NoCharacter", "Wähle einen eigenen Token aus, um das Item aufzunehmen."));
    return true;
  }
  if (!isOperationalGM(game.user) && !isAdjacentToLoot(recipient?.token, lootToken)) {
    ui.notifications.warn(uiText("TOVF.SceneLoot.Errors.OutOfReach", "Das Item kann nur vom gleichen oder einem angrenzenden Feld aufgenommen werden."));
    return true;
  }
  try {
    const base = { lootUuid: lootToken.uuid, actorUuid: recipient?.actor?.uuid, tokenUuid: recipient?.token?.uuid };
    const onlyEntryQuantity = loot.entries.length === 1 ? itemQuantity(loot.entries[0].item) : 0;
    if (recipient && !loot.package && loot.entries.length <= 1 && !hasCurrency(loot.currency) && onlyEntryQuantity <= 1) {
      const result = await request("pickup", base);
      ui.notifications.info(uiText("TOVF.SceneLoot.PickedUp", "{name} wurde aufgenommen.", result));
      return true;
    }

    await openLootDialog({ lootToken, loot, recipient, base });
  } catch (error) {
    console.error(`${MODULE_ID} | Could not pick up scene item loot`, error);
    ui.notifications.error(error.message);
  }
  return true;
}

async function pickUpAt(point) {
  const lootToken = lootTokenAt(point);
  return lootToken ? pickUpLootToken(lootToken) : false;
}

function installLayerPatch() {
  const prototype = foundry.canvas.layers.TokenLayer?.prototype;
  if (prototype && !Object.hasOwn(prototype, LAYER_PATCH)) {
    Object.defineProperty(prototype, LAYER_PATCH, { value: true });
    const original = prototype._onClickLeft2;
    prototype._onClickLeft2 = function(event, ...args) {
      const point = canvas.activeLayer?.toLocal?.(event);
      if (point && lootTokenAt(point)) {
        void pickUpAt(point);
        return;
      }
      return original.call(this, event, ...args);
    };
  }

  const tokenPrototype = foundry.canvas.placeables.Token?.prototype;
  if (!tokenPrototype || Object.hasOwn(tokenPrototype, TOKEN_PATCH)) return;
  Object.defineProperty(tokenPrototype, TOKEN_PATCH, { value: true });
  const originalTokenCanView = tokenPrototype._canView;
  const originalTokenDoubleClick = tokenPrototype._onClickLeft2;
  const originalTokenRightDoubleClick = tokenPrototype._onClickRight2;
  tokenPrototype._canView = function(user, event) {
    if (lootData(this.document)) return this.layer.active && !this.document.isSecret;
    return originalTokenCanView.call(this, user, event);
  };
  tokenPrototype._onClickLeft2 = function(event, ...args) {
    if (lootData(this.document)) {
      event.stopPropagation();
      void pickUpLootToken(this.document);
      return;
    }
    return originalTokenDoubleClick.call(this, event, ...args);
  };
  tokenPrototype._onClickRight2 = function(event, ...args) {
    if (lootData(this.document) && isOperationalGM(game.user)) {
      event.stopPropagation();
      void openLootConfiguration(this.document);
      return;
    }
    return originalTokenRightDoubleClick.call(this, event, ...args);
  };
}

async function applyConfiguredLootImage(lootToken, source) {
  return enqueueLootOperation(lootToken.uuid, async () => {
    const currentToken = await fromUuid(lootToken.uuid).catch(() => null);
    const loot = lootData(currentToken);
    if (!loot || !source) return;
    loot.img = source;
    await currentToken.update({
      ...tokenAppearance(loot),
      [`flags.${MODULE_ID}.${FLAG}`]: loot
    }, { sceneItemLootAppearance: true });
  });
}

function lootTokenGeometry(token) {
  const { width, height } = token.document.getSize();
  const diameter = Math.min(width, height);
  const outerWidth = Math.max(3, diameter * 0.09);
  const innerWidth = Math.max(1.5, diameter * 0.035);
  const maskInset = 0;
  const maskWidth = width;
  const maskHeight = height;
  const maskRadius = Math.max(outerWidth, diameter * 0.24);
  const frameInset = -outerWidth / 2;
  const frameWidth = width + outerWidth;
  const frameHeight = height + outerWidth;
  const frameRadius = maskRadius + outerWidth / 2;
  return {
    width,
    height,
    outerWidth,
    innerWidth,
    frameInset,
    frameWidth,
    frameHeight,
    frameRadius,
    maskInset,
    maskWidth,
    maskHeight,
    maskRadius
  };
}

function positionLootStackNameplate(token) {
  const loot = lootData(token.document);
  if (!loot || lootStackQuantity(loot) <= 1 || !token.nameplate) return;
  const geometry = lootTokenGeometry(token);
  const cornerOffset = geometry.frameRadius / Math.sqrt(2);
  const cornerCenterX = geometry.frameInset + geometry.frameWidth - geometry.frameRadius;
  const cornerCenterY = geometry.frameInset + geometry.frameHeight - geometry.frameRadius;
  token.nameplate.anchor.set(0.5, 0.5);
  token.nameplate.position.set(
    cornerCenterX + cornerOffset,
    cornerCenterY + cornerOffset
  );
  token.nameplate.zIndex = 20;
}

function removeLootTokenVisual(token) {
  const mask = token?.[TOKEN_MASK];
  if (token?.mesh?.mask === mask) token.mesh.mask = null;
  if (mask && !mask.destroyed) {
    mask.parent?.removeChild(mask);
    mask.destroy();
  }
  const frame = token?.[TOKEN_FRAME];
  if (frame && !frame.destroyed) {
    frame.parent?.removeChild(frame);
    frame.destroy();
  }
  if (token) {
    token[TOKEN_MASK] = null;
    token[TOKEN_FRAME] = null;
  }
}

function refreshLootTokenVisual(token) {
  if (!lootData(token?.document) || !token.mesh || !canvas.primary) {
    removeLootTokenVisual(token);
    return;
  }

  let mask = token[TOKEN_MASK];
  if (!mask || mask.destroyed || mask.parent !== canvas.primary) {
    if (mask && !mask.destroyed) mask.destroy();
    mask = canvas.primary.addChild(new PIXI.LegacyGraphics());
    mask.eventMode = "none";
    token[TOKEN_MASK] = mask;
  }

  let frame = token[TOKEN_FRAME];
  if (!frame || frame.destroyed || frame.parent !== token) {
    if (frame && !frame.destroyed) frame.destroy();
    frame = token.addChild(new PIXI.LegacyGraphics());
    frame.eventMode = "none";
    frame.zIndex = 10;
    token[TOKEN_FRAME] = frame;
  }

  const geometry = lootTokenGeometry(token);
  const center = token.center;

  mask.clear()
    .beginFill(0xFFFFFF, 1)
    .drawRoundedRect(
      center.x - geometry.width / 2 + geometry.maskInset,
      center.y - geometry.height / 2 + geometry.maskInset,
      geometry.maskWidth,
      geometry.maskHeight,
      geometry.maskRadius
    )
    .endFill();
  mask.elevation = token.document.elevation;
  mask.sort = token.document.sort;
  token.mesh.mask = mask;

  frame.clear()
    .lineStyle({ width: geometry.outerWidth, color: 0x5B2D0D, alpha: 0.98, alignment: 0.5 })
    .drawRoundedRect(
      geometry.frameInset,
      geometry.frameInset,
      geometry.frameWidth,
      geometry.frameHeight,
      geometry.frameRadius
    )
    .lineStyle({ width: geometry.innerWidth, color: 0xF7CA6B, alpha: 1, alignment: 0.5 })
    .drawRoundedRect(
      geometry.frameInset,
      geometry.frameInset,
      geometry.frameWidth,
      geometry.frameHeight,
      geometry.frameRadius
    );

  positionLootStackNameplate(token);
}

export function registerSceneItemLoot() {
  Hooks.on("dropCanvasData", handleCanvasDrop);
  Hooks.on("drawToken", refreshLootTokenVisual);
  Hooks.on("refreshToken", refreshLootTokenVisual);
  Hooks.on("updateToken", (lootToken, changes, options) => {
    refreshOpenLootDialogs(lootToken);
    const source = foundry.utils.getProperty(changes, "texture.src");
    const loot = lootData(lootToken);
    const requiresSync = source && loot && (loot.img !== source
      || lootToken.texture?.src !== source
      || lootToken.ring?.subject?.texture !== source);
    if (!options?.sceneItemLootAppearance && requiresSync && activeOperationalGM()?.id === game.user.id) {
      void applyConfiguredLootImage(lootToken, source).catch(error => {
        console.error(`${MODULE_ID} | Could not apply the configured scene loot image`, error);
        ui.notifications.error(error.message);
      });
    }
  });
  Hooks.on("canvasReady", installLayerPatch);
  Hooks.on("destroyToken", removeLootTokenVisual);
  Hooks.on("deleteToken", lootToken => refreshOpenLootDialogs(lootToken, { deleted: true }));
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
