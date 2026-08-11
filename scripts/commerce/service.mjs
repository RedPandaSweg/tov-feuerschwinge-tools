import { MODULE_ID } from "../core/constants.mjs";
import { balanceInCopper, changeCurrency, formatCopper, itemQuantity, priceInCopper, quantityForPrice, validateCurrencyChange } from "./currency.mjs";
import { addItem, cleanTransferredItem, exchange, removeItem, transferItem } from "./transactions.mjs";

export const COMMERCE_SETTING = "commerceState";
export const MERCHANT_FLAG = "merchant";
export const AUCTION_HOUSE_FLAG = "auctionHouse";
const DEFAULT_STATE = Object.freeze({ version: 1, auctions: [], requests: [], trades: [] });
let operationQueue = Promise.resolve();
const TRADEABLE_TYPES = new Set(["ammunition", "armor", "consumable", "container", "gear", "sundry", "tool", "weapon"]);

function isTradeableItem(item) {
  return !!item && item.type !== "currency" && TRADEABLE_TYPES.has(item.type);
}

function itemDiscount(item) {
  return Math.clamp(Number(item?.getFlag?.(MODULE_ID, "merchantItem")?.discountPercent) || 0, 0, 100);
}

function itemPriceDenomination(item) {
  const id = String(item?.system?.price?.denomination ?? "gp").toLowerCase();
  return id === "pp" ? "gp" : id;
}

function purchaseCardContent(data) {
  const esc = foundry.utils.escapeHTML;
  const rows = data.entries.map(entry => `<li><img src="${esc(entry.img)}" alt=""><span><strong>${entry.quantity}× ${esc(entry.name)}</strong><small>${formatCopper(entry.totalCopper)}</small></span></li>`).join("");
  return `<div class="tovf-merchant-chat-card"><header><img src="${esc(data.merchantImg)}" alt=""><span><strong>${esc(data.merchantName)}</strong><small>Einkauf von ${esc(data.buyerName)}</small></span></header><ul>${rows}</ul><footer><span>Gesamt</span><strong>${formatCopper(data.totalCopper)}</strong></footer></div>`;
}

async function recordMerchantPurchase({ sessionId, shop, buyer, item, quantity, copper, userId }) {
  if (!sessionId) return;
  const existing = game.messages.find(message => {
    const data = message.getFlag(MODULE_ID, "merchantPurchase");
    return data?.sessionId === sessionId && data?.merchantId === shop.id && data?.buyerId === buyer.id && data?.userId === userId;
  });
  const stored = foundry.utils.deepClone(existing?.getFlag(MODULE_ID, "merchantPurchase") ?? {
    sessionId, merchantId: shop.id, merchantName: shop.name, merchantImg: shop.img,
    buyerId: buyer.id, buyerName: buyer.name, userId, entries: [], totalCopper: 0
  });
  const unitCopper = Math.round(copper / quantity);
  const entry = stored.entries.find(row => row.itemId === item.id && row.unitCopper === unitCopper);
  if (entry) { entry.quantity += quantity; entry.totalCopper += copper; }
  else stored.entries.push({ itemId: item.id, name: item.name, img: item.img, quantity, unitCopper, totalCopper: copper });
  stored.totalCopper += copper;
  const content = purchaseCardContent(stored);
  if (existing) await existing.update({ content, [`flags.${MODULE_ID}.merchantPurchase`]: stored });
  else await ChatMessage.create({ user: userId, speaker: ChatMessage.getSpeaker({ actor: buyer }), content,
    flags: { [MODULE_ID]: { merchantPurchase: stored } } });
}

function descriptionValue(value) {
  if (typeof value === "string") return value === "[object Object]" ? "" : value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["value", "html", "content", "description"]) {
    const result = descriptionValue(value[key]);
    if (result) return result;
  }
  return "";
}

function cleanStrings(values, maximum = 100) {
  return Array.isArray(values)
    ? [...new Set(values.map(value => String(value ?? "").trim()).filter(Boolean))].slice(0, maximum)
    : [];
}

function cleanRequiredItem(source) {
  if (!source || typeof source !== "object") return null;
  const item = {
    uuid: String(source.uuid ?? "").trim(),
    type: String(source.type ?? "").trim(),
    identifier: String(source.identifier ?? "").trim(),
    name: String(source.name ?? "").trim(),
    img: String(source.img ?? "").trim()
  };
  return item.uuid || item.name ? item : null;
}

function serialize(operation) {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.catch(() => {});
  return result;
}

export function cleanState(source = {}) {
  return {
    version: 1,
    auctions: Array.isArray(source.auctions) ? source.auctions.slice(0, 1000) : [],
    requests: Array.isArray(source.requests) ? source.requests.slice(0, 1000) : [],
    trades: Array.isArray(source.trades) ? source.trades.slice(0, 500) : []
  };
}

export function commerceState() {
  return cleanState(game.settings.get(MODULE_ID, COMMERCE_SETTING));
}

async function saveState(state) {
  await game.settings.set(MODULE_ID, COMMERCE_SETTING, cleanState(state));
}

export function merchantConfig(actor) {
  const source = actor?.getFlag(MODULE_ID, MERCHANT_FLAG) ?? {};
  const description = descriptionValue(source.description)
    || descriptionValue(actor?.system?.description)
    || descriptionValue(actor?.system?.details?.description);
  return {
    enabled: source.enabled === true,
    buyModifier: Math.max(0, Number(source.buyModifier ?? 1) || 0),
    sellModifier: Math.max(0, Number(source.sellModifier ?? 0.5) || 0),
    infiniteStock: source.infiniteStock !== false,
    infiniteCurrency: source.infiniteCurrency !== false,
    purchaseOnly: source.purchaseOnly === true,
    keepSoldItems: source.keepSoldItems === true,
    hideNewItems: source.hideNewItems !== false,
    displayQuantity: source.displayQuantity !== false,
    showZeroQuantity: source.showZeroQuantity === true,
    requireInteractionRange: source.requireInteractionRange !== false,
    interactionRange: Math.max(1, Math.floor(Number(source.interactionRange) || 1)),
    allowedActorIds: cleanStrings(source.allowedActorIds),
    requiredLanguages: cleanStrings(source.requiredLanguages),
    requiredProficiencies: cleanStrings(source.requiredProficiencies),
    requiredItem: cleanRequiredItem(source.requiredItem),
    accessDeniedMessage: descriptionValue(source.accessDeniedMessage),
    description,
    merchantImage: String(source.merchantImage ?? "")
  };
}

export function isAuctionHouse(actor) {
  return actor?.getFlag(MODULE_ID, AUCTION_HOUSE_FLAG)?.enabled === true;
}

export function ownedCharacters(user = game.user) {
  return game.actors.filter(actor => actor.type === "pc" && actor.testUserPermission(user, "OWNER"));
}

function hasProficiency(actor, encoded) {
  const [type, ...keyParts] = String(encoded).split(":");
  const key = keyParts.join(":");
  if (!key) return false;
  if (type === "skill" || type === "tool") {
    return Number(actor.system?.proficiencies?.[`${type}s`]?.[key]?.proficiency?.multiplier ?? 0) >= 1;
  }
  if (type === "weapon" || type === "armor") {
    const data = actor.system?.proficiencies?.[`${type}s`];
    return new Set([...(data?.value ?? []), ...(data?.categories ?? [])]).has(key);
  }
  return false;
}

function itemIdentifier(item) {
  return String(item?.system?.identifier?.value ?? item?.system?.identifier ?? item?.identifier ?? "").trim();
}

function hasRequiredItem(actor, required) {
  if (!required) return true;
  const requiredName = required.name.toLocaleLowerCase();
  return actor.items.some(item => {
    const sourceId = String(item.getFlag?.("core", "sourceId") ?? "");
    if (required.uuid && (item.uuid === required.uuid || sourceId === required.uuid)) return true;
    if (required.type && item.type !== required.type) return false;
    if (required.identifier) return itemIdentifier(item) === required.identifier;
    return !!requiredName && item.name.trim().toLocaleLowerCase() === requiredName;
  });
}

function tokenAxisDistance(leftStart, leftSize, rightStart, rightSize, gridSize) {
  const leftEnd = leftStart + leftSize * gridSize;
  const rightEnd = rightStart + rightSize * gridSize;
  if (leftEnd <= rightStart) return (rightStart - leftEnd) / gridSize + 1;
  if (rightEnd <= leftStart) return (leftStart - rightEnd) / gridSize + 1;
  return 0;
}

function tokenDistanceInFields(left, right, scene) {
  const gridSize = Number(scene.grid?.size) || 100;
  const horizontal = tokenAxisDistance(Number(left.x), Number(left.width || 1), Number(right.x), Number(right.width || 1), gridSize);
  const vertical = tokenAxisDistance(Number(left.y), Number(left.height || 1), Number(right.y), Number(right.height || 1), gridSize);
  return Math.max(horizontal, vertical);
}

function actorInMerchantRange(shop, actor, sceneId, range) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return false;
  const shopTokens = [...scene.tokens].filter(token => token.actorId === shop?.id);
  const actorTokens = [...scene.tokens].filter(token => token.actorId === actor?.id);
  return shopTokens.some(shopToken => actorTokens.some(actorToken => tokenDistanceInFields(shopToken, actorToken, scene) <= range));
}

export function merchantAccess(shop, actor, user = game.user, { sceneId = null } = {}) {
  if (user?.isGM) return { allowed: true, reasons: [] };
  const config = merchantConfig(shop);
  const reasons = [];
  if (!actor) reasons.push("character");
  else {
    if (config.allowedActorIds.length && !config.allowedActorIds.includes(actor.id)) reasons.push("character");
    const languages = new Set(actor.system?.proficiencies?.languages?.value ?? []);
    if (config.requiredLanguages.some(language => !languages.has(language))) reasons.push("language");
    if (config.requiredProficiencies.some(proficiency => !hasProficiency(actor, proficiency))) reasons.push("proficiency");
    if (!hasRequiredItem(actor, config.requiredItem)) reasons.push("item");
    if (config.requireInteractionRange && !actorInMerchantRange(shop, actor, sceneId, config.interactionRange)) reasons.push("distance");
  }
  return { allowed: reasons.length === 0, reasons };
}

export function merchantAllowsActor(shop, actor, user = game.user, options = {}) {
  return merchantAccess(shop, actor, user, options).allowed;
}

export function merchantAvailableToUser(shop, user = game.user, options = {}) {
  if (user?.isGM) return true;
  return ownedCharacters(user).some(actor => merchantAllowsActor(shop, actor, user, options));
}

function actorOwnedBy(actor, userId) {
  const user = game.users.get(userId);
  return !!actor?.testUserPermission(user, "OWNER") || user?.character?.id === actor?.id;
}

function actor(id, label = "Charakter") {
  const document = game.actors.get(id);
  if (!document) throw new Error(`${label} wurde nicht gefunden.`);
  return document;
}

function merchant(id) {
  const document = actor(id, "Händler");
  if (!merchantConfig(document).enabled) throw new Error("Dieser Actor ist nicht als Händler eingerichtet.");
  return document;
}

async function merchantBuy(payload, userId) {
  const shop = merchant(payload.merchantId);
  const buyer = actor(payload.actorId);
  if (!actorOwnedBy(buyer, userId)) throw new Error("Du besitzt diesen Charakter nicht.");
  if (!merchantAllowsActor(shop, buyer, game.users.get(userId), { sceneId: payload.sceneId })) throw new Error("Dieser Charakter darf bei diesem Händler nicht handeln.");
  const item = shop.items.get(payload.itemId);
  if (!isTradeableItem(item)) throw new Error("Dieser Gegenstand kann nicht gehandelt werden.");
  const priceUnits = Math.max(1, Math.floor(Number(payload.quantity) || 1));
  const quantity = priceUnits * quantityForPrice(item);
  const config = merchantConfig(shop);
  if (!config.infiniteStock && itemQuantity(item) < quantity) throw new Error("Der Händler hat nicht genug davon auf Lager.");
  const unitCopper = Math.round(priceInCopper(item, config.buyModifier) * (1 - itemDiscount(item) / 100));
  const copper = unitCopper * priceUnits;
  const denomination = itemPriceDenomination(item);
  validateCurrencyChange(buyer, -copper);
  if (!config.infiniteCurrency) validateCurrencyChange(shop, copper, { denomination });
  await changeCurrency(buyer, -copper);
  try {
    if (!config.infiniteCurrency) await changeCurrency(shop, copper, { denomination });
    await transferItem({ source: shop, target: buyer, itemId: item.id, quantity, keepSource: config.infiniteStock });
  } catch (error) {
    await changeCurrency(buyer, copper).catch(() => {});
    if (!config.infiniteCurrency) await changeCurrency(shop, -copper).catch(() => {});
    throw error;
  }
  await recordMerchantPurchase({ sessionId: payload.sessionId, shop, buyer, item, quantity, copper, userId })
    .catch(error => console.error(`${MODULE_ID} | Merchant chat card failed`, error));
  return { message: `${buyer.name} kauft ${quantity}× ${item.name} für ${formatCopper(copper)}.` };
}

async function merchantSell(payload, userId) {
  const shop = merchant(payload.merchantId);
  const seller = actor(payload.actorId);
  if (!actorOwnedBy(seller, userId)) throw new Error("Du besitzt diesen Charakter nicht.");
  if (!merchantAllowsActor(shop, seller, game.users.get(userId), { sceneId: payload.sceneId })) throw new Error("Dieser Charakter darf bei diesem Händler nicht handeln.");
  const item = seller.items.get(payload.itemId);
  if (!isTradeableItem(item)) throw new Error("Dieser Gegenstand kann nicht gehandelt werden.");
  const priceUnits = Math.max(1, Math.floor(Number(payload.quantity) || 1));
  const quantity = priceUnits * quantityForPrice(item);
  if (itemQuantity(item) < quantity) throw new Error("Du besitzt nicht genug davon.");
  const config = merchantConfig(shop);
  if (config.purchaseOnly) throw new Error("Dieser Händler kauft keine Gegenstände an.");
  const copper = priceInCopper(item, config.sellModifier) * priceUnits;
  validateCurrencyChange(seller, copper);
  if (!config.infiniteCurrency) validateCurrencyChange(shop, -copper);
  if (!config.infiniteCurrency) await changeCurrency(shop, -copper);
  try {
    await changeCurrency(seller, copper);
    if (config.keepSoldItems) {
      const transferred = await transferItem({ source: seller, target: shop, itemId: item.id, quantity });
      if (config.hideNewItems && transferred) await transferred.setFlag(MODULE_ID, "merchantItem", { hidden: true });
    } else await removeItem(seller, item, quantity);
  } catch (error) {
    if (!config.infiniteCurrency) await changeCurrency(shop, copper).catch(() => {});
    await changeCurrency(seller, -copper).catch(() => {});
    throw error;
  }
  return { message: `${seller.name} verkauft ${quantity}× ${item.name} für ${formatCopper(copper)}.` };
}

async function createAuction(payload, userId) {
  const seller = actor(payload.actorId);
  if (!actorOwnedBy(seller, userId)) throw new Error("Du besitzt diesen Charakter nicht.");
  const item = seller.items.get(payload.itemId);
  const quantity = Math.max(1, Math.floor(Number(payload.quantity) || 1));
  if (!isTradeableItem(item) || itemQuantity(item) < quantity) throw new Error("Der Gegenstand ist nicht verfügbar oder nicht handelbar.");
  const startCopper = Math.max(1, Math.round(Number(payload.startCopper) || 0));
  const buyoutCopper = Math.max(0, Math.round(Number(payload.buyoutCopper) || 0));
  if (buyoutCopper && buyoutCopper < startCopper) throw new Error("Der Sofortkaufpreis darf nicht unter dem Startpreis liegen.");
  const durationMs = Math.clamp(Number(payload.durationMs) || 86400000, 60000, 2592000000);
  const data = cleanTransferredItem(item, quantity);
  await removeItem(seller, item, quantity);
  const state = commerceState();
  const auction = {
    id: foundry.utils.randomID(), status: "active", sellerActorId: seller.id, sellerUserId: userId,
    itemData: data, itemName: item.name, itemImg: item.img, quantity, startCopper, buyoutCopper,
    highestBid: 0, highestBidderActorId: null, createdAt: Date.now(), endsAt: Date.now() + durationMs
  };
  state.auctions.push(auction);
  try { await saveState(state); }
  catch (error) { await addItem(seller, data, quantity).catch(() => {}); throw error; }
  return { auction, message: `${item.name} wurde zur Auktion eingestellt.` };
}

async function bidAuction(payload, userId) {
  const bidder = actor(payload.actorId);
  if (!actorOwnedBy(bidder, userId)) throw new Error("Du besitzt diesen Charakter nicht.");
  const state = commerceState();
  const auction = state.auctions.find(entry => entry.id === payload.auctionId && entry.status === "active");
  if (!auction || auction.endsAt <= Date.now()) throw new Error("Diese Auktion ist beendet.");
  if (auction.sellerActorId === bidder.id) throw new Error("Du kannst nicht auf deine eigene Auktion bieten.");
  const minimum = Math.max(auction.startCopper, auction.highestBid + 1);
  const copper = Math.round(Number(payload.copper) || 0);
  if (copper < minimum) throw new Error(`Das Mindestgebot beträgt ${formatCopper(minimum)}.`);
  if (auction.buyoutCopper && copper >= auction.buyoutCopper) {
    throw new Error(`Für ${formatCopper(auction.buyoutCopper)} kann die Auktion sofort gekauft werden.`);
  }
  validateCurrencyChange(bidder, -copper);
  const previous = auction.highestBidderActorId ? game.actors.get(auction.highestBidderActorId) : null;
  if (previous) validateCurrencyChange(previous, auction.highestBid);
  const previousBid = auction.highestBid;
  await changeCurrency(bidder, -copper);
  try {
    if (previous) await changeCurrency(previous, previousBid);
    auction.highestBid = copper;
    auction.highestBidderActorId = bidder.id;
    auction.highestBidderUserId = userId;
    await saveState(state);
  } catch (error) {
    await changeCurrency(bidder, copper).catch(() => {});
    if (previous) await changeCurrency(previous, -previousBid).catch(() => {});
    throw error;
  }
  return { message: `${bidder.name} bietet ${formatCopper(copper)}.` };
}

async function settleAuctionEntry(state, auction) {
  if (auction.status !== "active") return;
  const seller = game.actors.get(auction.sellerActorId);
  const winner = game.actors.get(auction.highestBidderActorId);
  if (!seller) throw new Error("Der Verkäufer der Auktion wurde nicht gefunden.");
  if (winner && auction.highestBid > 0) {
    validateCurrencyChange(seller, auction.highestBid);
    await addItem(winner, auction.itemData, auction.quantity);
    await changeCurrency(seller, auction.highestBid);
    auction.status = "sold";
  } else {
    await addItem(seller, auction.itemData, auction.quantity);
    auction.status = "expired";
  }
  auction.settledAt = Date.now();
  await saveState(state);
}

async function buyoutAuction(payload, userId) {
  const state = commerceState();
  const auction = state.auctions.find(entry => entry.id === payload.auctionId && entry.status === "active");
  if (!auction?.buyoutCopper) throw new Error("Diese Auktion hat keinen Sofortkaufpreis.");
  const buyer = actor(payload.actorId);
  if (!actorOwnedBy(buyer, userId)) throw new Error("Du besitzt diesen Charakter nicht.");
  if (auction.sellerActorId === buyer.id) throw new Error("Du kannst deine eigene Auktion nicht kaufen.");
  validateCurrencyChange(buyer, -auction.buyoutCopper);
  const previous = auction.highestBidderActorId ? game.actors.get(auction.highestBidderActorId) : null;
  if (previous) validateCurrencyChange(previous, auction.highestBid);
  await changeCurrency(buyer, -auction.buyoutCopper);
  if (previous) await changeCurrency(previous, auction.highestBid);
  auction.highestBid = auction.buyoutCopper;
  auction.highestBidderActorId = buyer.id;
  auction.highestBidderUserId = userId;
  const updated = auction;
  updated.endsAt = Date.now();
  await settleAuctionEntry(state, updated);
  return { message: `${updated.itemName} wurde sofort gekauft.` };
}

async function cancelAuction(payload, userId) {
  const state = commerceState();
  const auction = state.auctions.find(entry => entry.id === payload.auctionId && entry.status === "active");
  if (!auction) throw new Error("Diese Auktion ist nicht mehr verfügbar.");
  const seller = actor(auction.sellerActorId);
  if (!game.users.get(userId)?.isGM && !actorOwnedBy(seller, userId)) throw new Error("Du darfst diese Auktion nicht zurückziehen.");
  const bidder = auction.highestBidderActorId ? actor(auction.highestBidderActorId) : null;
  if (bidder && auction.highestBid > 0) validateCurrencyChange(bidder, auction.highestBid);
  await addItem(seller, auction.itemData, auction.quantity);
  if (bidder && auction.highestBid > 0) await changeCurrency(bidder, auction.highestBid);
  auction.status = "cancelled"; auction.cancelledAt = Date.now(); auction.cancelledByUserId = userId;
  await saveState(state);
  return { message: `${auction.itemName} wurde aus dem Auktionshaus genommen.` };
}

async function createRequest(payload, userId) {
  const requester = actor(payload.actorId);
  if (!actorOwnedBy(requester, userId)) throw new Error("Du besitzt diesen Charakter nicht.");
  const wanted = payload.wantedItem;
  if (!wanted || !TRADEABLE_TYPES.has(wanted.type) || !String(wanted.name ?? "").trim()) {
    throw new Error("Der gesuchte Gegenstand ist ungültig oder nicht handelbar.");
  }
  const wantedQuantity = Math.max(1, Math.floor(Number(payload.wantedQuantity) || 1));
  const offeredCopper = Math.max(0, Math.round(Number(payload.offeredCopper) || 0));
  const offeredItems = [];
  for (const entry of (Array.isArray(payload.offeredItems) ? payload.offeredItems : [])) {
    const item = requester.items.get(entry.itemId);
    const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
    if (!isTradeableItem(item) || itemQuantity(item) < quantity) throw new Error("Ein angebotener Gegenstand ist nicht mehr verfügbar.");
    offeredItems.push({ itemId: item.id, name: item.name, img: item.img, quantity, itemData: cleanTransferredItem(item, quantity) });
  }
  if (!offeredCopper && !offeredItems.length) throw new Error("Das Handelsgesuch benötigt eine Gegenleistung.");
  validateCurrencyChange(requester, -offeredCopper);
  const totals = new Map();
  for (const entry of offeredItems) totals.set(entry.itemId, (totals.get(entry.itemId) ?? 0) + entry.quantity);
  for (const [itemId, quantity] of totals) {
    if (itemQuantity(requester.items.get(itemId)) < quantity) throw new Error("Ein angebotener Gegenstand ist nicht in ausreichender Menge vorhanden.");
  }
  await changeCurrency(requester, -offeredCopper);
  const removed = [];
  try {
    for (const entry of offeredItems) {
      await removeItem(requester, requester.items.get(entry.itemId), entry.quantity);
      removed.push(entry);
    }
    const state = commerceState();
    const request = {
      id: foundry.utils.randomID(), status: "active", requesterActorId: requester.id, requesterUserId: userId,
      wantedItem: foundry.utils.deepClone(wanted), wantedQuantity, offeredCopper, offeredItems,
      createdAt: Date.now()
    };
    state.requests.push(request);
    await saveState(state);
    return { request, message: `Handelsgesuch für ${wantedQuantity}× ${wanted.name} erstellt.` };
  } catch (error) {
    await changeCurrency(requester, offeredCopper).catch(() => {});
    for (const entry of removed) await addItem(requester, entry.itemData, entry.quantity).catch(() => {});
    throw error;
  }
}

async function fulfillRequest(payload, userId) {
  const state = commerceState();
  const request = state.requests.find(entry => entry.id === payload.requestId && entry.status === "active");
  if (!request) throw new Error("Dieses Handelsgesuch ist nicht mehr verfügbar.");
  const seller = actor(payload.actorId);
  const requester = actor(request.requesterActorId);
  if (!actorOwnedBy(seller, userId)) throw new Error("Du besitzt diesen Charakter nicht.");
  if (seller.id === requester.id) throw new Error("Du kannst dein eigenes Handelsgesuch nicht erfüllen.");
  const soldItem = seller.items.get(payload.itemId);
  const sameItem = isTradeableItem(soldItem)
    && soldItem.type === request.wantedItem.type
    && soldItem.name.trim().toLocaleLowerCase() === request.wantedItem.name.trim().toLocaleLowerCase();
  if (!sameItem || itemQuantity(soldItem) < request.wantedQuantity) throw new Error("Der ausgewählte Gegenstand entspricht nicht dem Handelsgesuch.");
  validateCurrencyChange(seller, request.offeredCopper);
  const soldData = cleanTransferredItem(soldItem, request.wantedQuantity);
  await removeItem(seller, soldItem, request.wantedQuantity);
  try {
    await addItem(requester, soldData, request.wantedQuantity);
    for (const entry of request.offeredItems) await addItem(seller, entry.itemData, entry.quantity);
    await changeCurrency(seller, request.offeredCopper);
    request.status = "fulfilled";
    request.fulfilledByActorId = seller.id;
    request.fulfilledAt = Date.now();
    await saveState(state);
  } catch (error) {
    await addItem(seller, soldData, request.wantedQuantity).catch(() => {});
    throw error;
  }
  return { message: `${seller.name} erfüllt das Handelsgesuch für ${request.wantedQuantity}× ${request.wantedItem.name}.` };
}

async function cancelRequest(payload, userId) {
  const state = commerceState();
  const request = state.requests.find(entry => entry.id === payload.requestId && entry.status === "active");
  if (!request) throw new Error("Dieses Handelsgesuch ist nicht mehr verfügbar.");
  const requester = actor(request.requesterActorId);
  if (!game.users.get(userId)?.isGM && !actorOwnedBy(requester, userId)) throw new Error("Du darfst dieses Handelsgesuch nicht zurückziehen.");
  validateCurrencyChange(requester, request.offeredCopper);
  for (const entry of request.offeredItems) await addItem(requester, entry.itemData, entry.quantity);
  await changeCurrency(requester, request.offeredCopper);
  request.status = "cancelled";
  request.cancelledAt = Date.now();
  await saveState(state);
  return { message: "Das Handelsgesuch wurde zurückgezogen." };
}

function tradeSync(trade) {
  return { kind: "trade", tradeId: trade.id, status: trade.status, fromActorId: trade.fromActorId, toActorId: trade.toActorId };
}

function cleanTradeItems(entries, owner) {
  const totals = new Map();
  for (const entry of (Array.isArray(entries) ? entries : []).slice(0, 30)) {
    const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
    totals.set(entry.itemId, (totals.get(entry.itemId) ?? 0) + quantity);
  }
  return [...totals].map(([itemId, quantity]) => {
    const item = owner.items.get(itemId);
    if (!isTradeableItem(item) || itemQuantity(item) < quantity) throw new Error("Ein Handelsgegenstand ist nicht verfügbar oder nicht handelbar.");
    return { itemId, name: item.name, img: item.img, quantity };
  });
}

async function finalizeTrade(payload, userId) {
  const submitted = payload?.trade;
  if (!submitted?.id || submitted.status !== "finalizing" || submitted.confirmations?.from !== true || submitted.confirmations?.to !== true) {
    throw new Error("Der Handel wurde nicht von beiden Seiten bestätigt.");
  }
  const state = commerceState();
  const existing = state.trades.find(entry => entry.id === submitted.id && entry.status === "accepted");
  if (existing) return { trade: existing, sync: tradeSync(existing), message: "Der Handel wurde bereits abgeschlossen." };
  const fromActor = actor(submitted.fromActorId), toActor = actor(submitted.toActorId);
  if (!actorOwnedBy(fromActor, userId) && !actorOwnedBy(toActor, userId)) throw new Error("Du bist nicht an diesem Handel beteiligt.");
  if (fromActor.id === toActor.id) throw new Error("Ein Charakter kann nicht mit sich selbst handeln.");
  const trade = { id: submitted.id, status: "accepted", fromActorId: fromActor.id, toActorId: toActor.id,
    fromItems: cleanTradeItems(submitted.fromItems, fromActor), toItems: cleanTradeItems(submitted.toItems, toActor),
    fromCopper: Math.max(0, Math.round(Number(submitted.fromCopper) || 0)), toCopper: Math.max(0, Math.round(Number(submitted.toCopper) || 0)),
    confirmations: { from: true, to: true }, completedAt: Date.now() };
  validateCurrencyChange(fromActor, -trade.fromCopper);
  validateCurrencyChange(toActor, -trade.toCopper);
  await exchange({ fromActor, toActor, fromCopper: trade.fromCopper, toCopper: trade.toCopper,
    fromItems: trade.fromItems, toItems: trade.toItems });
  state.trades.push(trade);
  state.trades = state.trades.slice(-500);
  await saveState(state);
  return { trade, sync: tradeSync(trade), message: "Der Handel wurde abgeschlossen." };
}

async function ownerDeleteActor(payload, userId) {
  const document = actor(payload.actorId);
  if (!actorOwnedBy(document, userId)) throw new Error("Du besitzt diesen Actor nicht.");
  if (merchantConfig(document).enabled || isAuctionHouse(document)) throw new Error("Händler und Auktionshäuser können nur durch eine Spielleitung gelöscht werden.");
  const state = commerceState();
  const inAuction = state.auctions.some(entry => entry.status === "active"
    && [entry.sellerActorId, entry.highestBidderActorId].includes(document.id));
  const inRequest = state.requests.some(entry => entry.status === "active" && entry.requesterActorId === document.id);
  const inTrade = state.trades.some(entry => ["pending", "active"].includes(entry.status)
    && [entry.fromActorId, entry.toActorId].includes(document.id));
  if (inAuction || inRequest || inTrade) throw new Error("Dieser Actor ist noch an einem offenen Handel beteiligt. Beende ihn zuerst.");
  const name = document.name;
  await document.delete();
  return { message: `${name} wurde gelöscht.` };
}

export async function settleExpiredAuctions() {
  if (!game.user.isGM) return;
  return serialize(async () => {
    const state = commerceState();
    for (const auction of state.auctions.filter(entry => entry.status === "active" && entry.endsAt <= Date.now())) {
      await settleAuctionEntry(state, auction);
    }
  });
}

export async function executeCommerceAction(action, payload, userId = game.user.id) {
  if (!game.user.isGM) throw new Error("Diese Handelsaktion muss durch eine Spielleitung ausgeführt werden.");
  return serialize(async () => {
    if (action === "merchantBuy") return merchantBuy(payload, userId);
    if (action === "merchantSell") return merchantSell(payload, userId);
    if (action === "auctionCreate") return createAuction(payload, userId);
    if (action === "auctionBid") return bidAuction(payload, userId);
    if (action === "auctionBuyout") return buyoutAuction(payload, userId);
    if (action === "auctionCancel") return cancelAuction(payload, userId);
    if (action === "requestCreate") return createRequest(payload, userId);
    if (action === "requestFulfill") return fulfillRequest(payload, userId);
    if (action === "requestCancel") return cancelRequest(payload, userId);
    if (action === "tradeFinalize") return finalizeTrade(payload, userId);
    if (action === "ownerDeleteActor") return ownerDeleteActor(payload, userId);
    throw new Error(`Unbekannte Handelsaktion: ${action}`);
  });
}

export function commerceSummary() {
  return { merchants: game.actors.filter(entry => merchantConfig(entry).enabled).length,
    auctions: commerceState().auctions.filter(entry => entry.status === "active").length,
    requests: commerceState().requests.filter(entry => entry.status === "active").length,
    trades: commerceState().trades.filter(entry => ["pending", "active"].includes(entry.status)).length };
}
