import { MODULE_ID } from "../core/constants.mjs";
import { emitModuleEvent } from "../core/events.mjs?v=3.7.8-module-events-1";
import { deleteExistingEmbeddedDocuments } from "../core/document-operations.mjs?v=3.7.8-safe-documents-1";
import { merchantConfig } from "./service.mjs?v=3.7.8-runtime-audit-1";
import { addItem, cleanTransferredItem, findStackableItem } from "./transactions.mjs?v=3.7.8-runtime-audit-1";
import { addMerchantSpellScrollOffer, merchantSpellScrollOffers, saveMerchantSpellScrollOffers } from "../spell-scrolls.mjs?v=3.7.8-clearance-label-1";

const TRADEABLE_TYPES = new Set(["ammunition", "armor", "consumable", "container", "gear", "sundry", "tool", "weapon"]);
const running = new Set();

function refreshMerchantShop(actor) {
  emitModuleEvent("merchantStockChanged", { actorId: actor.id });
}

export function addCalendarInterval(timestamp, value, unit) {
  const date = new Date(timestamp);
  const amount = Math.max(0, Number(value) || 0);
  if (unit === "months") date.setMonth(date.getMonth() + amount);
  else date.setTime(date.getTime() + amount * ({ minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 }[unit] ?? 0));
  return date.getTime();
}

function nextScheduledRun(rule, now) {
  const value = Math.max(0, Number(rule.intervalValue) || 0);
  const scheduledAt = Number(rule.nextRunAt) || Number(rule.startAt) || now;
  if (!value) return now;

  let nextRunAt = addCalendarInterval(scheduledAt, value, rule.intervalUnit);
  if (nextRunAt > now) return nextRunAt;

  const fixedUnitMs = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000 }[rule.intervalUnit];
  if (fixedUnitMs) {
    const intervalMs = value * fixedUnitMs;
    return scheduledAt + (Math.floor((now - scheduledAt) / intervalMs) + 1) * intervalMs;
  }

  // Calendar months have variable lengths. Advance from the previous target,
  // never from the delayed execution time, until the next target is future.
  while (nextRunAt <= now) nextRunAt = addCalendarInterval(nextRunAt, value, rule.intervalUnit);
  return nextRunAt;
}

async function drawItems(table, actor, count, minimum, maximum) {
  const items = new Map();
  const spellUuids = new Set(merchantSpellScrollOffers(actor).map(offer => offer.spellUuid));
  // Draw against an in-memory replacement copy. Rejected duplicate results must not
  // consume a non-replacement world table or leave its results marked as drawn.
  const rollingTable = table.clone({ replacement: true }, { save: false });
  const maximumAttempts = Math.min(1000, Math.max(count * 50, Number(table.results?.size ?? 0) * 10, 50));
  for (let attempt = 0; attempt < maximumAttempts && items.size < count; attempt++) {
    const draw = await rollingTable.drawMany(1, { displayChat: false });
    const result = draw.results?.[0];
    if (!result) break;
    const uuid = result.documentUuid ?? (result.documentCollection && result.documentId ? `${result.documentCollection}.${result.documentId}` : "");
    const document = uuid ? await fromUuid(uuid) : null;
    if (document?.documentName !== "Item" || !(TRADEABLE_TYPES.has(document.type) || document.type === "spell")) continue;
    if (items.has(document.uuid)) continue;
    if (document.type === "spell") {
      if (spellUuids.has(document.uuid)) continue;
    } else {
      const candidate = cleanTransferredItem(document, 1);
      candidate.flags ??= {};
      candidate.flags[MODULE_ID] ??= {};
      candidate.flags[MODULE_ID].merchantItem = { sourceUuid: document.uuid };
      if (findStackableItem(actor, candidate, { stackWeapons: true, merchantStock: true })) continue;
    }
    const quantity = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
    items.set(document.uuid, { document, quantity });
  }
  return [...items.values()];
}

export async function maintainMerchantStock(actor, now = Date.now()) {
  const deletions = [];
  let merchantChanged = false;
  for (const item of actor.items) {
    const state = item.getFlag(MODULE_ID, "merchantItem") ?? {};
    if (state.removeAt > 0 && state.removeAt <= now) { deletions.push(item.id); merchantChanged = true; continue; }
    if (state.discountAt > 0 && state.discountAt <= now && Number(state.automaticDiscountPercent) > 0)
      { await item.setFlag(MODULE_ID, "merchantItem", { ...state, discountPercent: state.automaticDiscountPercent, discountAt: 0, discountSource: "clearance" }); merchantChanged = true; }
  }
  if (deletions.length) await deleteExistingEmbeddedDocuments(actor, "Item", deletions);
  const offers = merchantSpellScrollOffers(actor);
  let changed = false;
  const kept = [];
  for (const offer of offers) {
    if (offer.removeAt > 0 && offer.removeAt <= now) { changed = true; continue; }
    if (offer.discountAt > 0 && offer.discountAt <= now && offer.automaticDiscountPercent > 0) {
      offer.discountPercent = offer.automaticDiscountPercent; offer.discountAt = 0; offer.discountSource = "clearance"; changed = true;
    }
    kept.push(offer);
  }
  if (changed) { await saveMerchantSpellScrollOffers(actor, kept); merchantChanged = true; }
  const config = merchantConfig(actor);
  let historyChanged = false;
  for (const rule of config.restock.rules) {
    const deliveries = (rule.deliveries ?? []).map(delivery => {
      const items = delivery.items.filter(item => !(item.removeAt > 0 && item.removeAt <= now));
      if (items.length !== delivery.items.length) historyChanged = true;
      return { ...delivery, items };
    }).filter(delivery => {
      if (delivery.items.length) return true;
      historyChanged = true;
      return false;
    });
    rule.deliveries = deliveries;
  }
  if (historyChanged) { await actor.setFlag(MODULE_ID, "merchant", { ...config, restock: config.restock }); merchantChanged = true; }
  if (merchantChanged) refreshMerchantShop(actor);
}

export async function restockMerchant(actor, { force = false, now = Date.now() } = {}) {
  if (!actor || running.has(actor.id)) return false;
  let config = merchantConfig(actor), restock = config.restock;
  let dueRules = restock.rules.filter(rule => rule.enabled && rule.tableId && (force || ((!rule.startAt || rule.startAt <= now) && (!rule.nextRunAt || rule.nextRunAt <= now))));
  if ((!restock.enabled && !force) || !dueRules.length) return false;
  running.add(actor.id);
  try {
    await maintainMerchantStock(actor, now);
    config = merchantConfig(actor); restock = config.restock;
    dueRules = restock.rules.filter(rule => rule.enabled && rule.tableId && (force || ((!rule.startAt || rule.startAt <= now) && (!rule.nextRunAt || rule.nextRunAt <= now))));
    for (const item of actor.items) {
      const state = item.getFlag(MODULE_ID, "merchantItem") ?? {};
      if (state.newArrival) await item.setFlag(MODULE_ID, "merchantItem", { ...state, newArrival: false });
    }
    const offers = merchantSpellScrollOffers(actor);
    if (offers.some(offer => offer.newArrival)) {
      for (const offer of offers) offer.newArrival = false;
      await saveMerchantSpellScrollOffers(actor, offers);
    }
    for (const rule of dueRules) {
      const table = game.tables.get(rule.tableId);
      if (!table) throw new Error(`RollTable für ${actor.name} wurde nicht gefunden.`);
      const drawn = await drawItems(table, actor, rule.rolls, rule.quantityMin, Math.max(rule.quantityMin, rule.quantityMax));
      const discountAt = rule.discountValue ? addCalendarInterval(now, rule.discountValue, rule.discountUnit) : 0;
      const removeAt = rule.removeValue ? addCalendarInterval(now, rule.removeValue, rule.removeUnit) : 0;
      const deliveryItems = [];
      for (const { document, quantity } of drawn) {
        if (document.type === "spell") {
          const offer = await addMerchantSpellScrollOffer(actor, document, quantity);
          const current = merchantSpellScrollOffers(actor);
          const stored = current.find(entry => entry.id === offer.id);
          Object.assign(stored, { newArrival: true, arrivedAt: now, discountAt, removeAt, automaticDiscountPercent: rule.discountPercent });
          await saveMerchantSpellScrollOffers(actor, current);
          deliveryItems.push({ uuid: document.uuid, stockId: offer.id, name: `Spell Scroll: ${document.name}`,
            img: document.img, quantity, spell: true, discountAt, removeAt });
        } else {
          const itemData = cleanTransferredItem(document, quantity);
          itemData.flags ??= {};
          itemData.flags[MODULE_ID] ??= {};
          itemData.flags[MODULE_ID].merchantItem = { sourceUuid: document.uuid };
          const item = await addItem(actor, itemData, quantity, { stackWeapons: true, merchantStock: true });
          const state = item.getFlag(MODULE_ID, "merchantItem") ?? {};
          await item.setFlag(MODULE_ID, "merchantItem", { ...state, newArrival: true, arrivedAt: now, discountAt, removeAt, automaticDiscountPercent: rule.discountPercent });
          deliveryItems.push({ uuid: document.uuid, stockId: item.id, name: document.name,
            img: document.img, quantity, spell: false, discountAt, removeAt });
        }
      }
      rule.lastDelivery = deliveryItems;
      rule.deliveries = [...(rule.deliveries ?? []), { at: now, items: rule.lastDelivery }].slice(-100);
      rule.lastRunAt = now;
      rule.nextRunAt = nextScheduledRun(rule, now);
    }
    await actor.setFlag(MODULE_ID, "merchant", { ...config, restock: { ...restock, rules: restock.rules } });
    refreshMerchantShop(actor);
    return true;
  } finally { running.delete(actor.id); }
}

export async function runAutomaticRestocks(now = Date.now()) {
  if (!game.user.isGM) return;
  const responsible = game.users.filter(user => user.active && user.isGM).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (responsible?.id !== game.user.id) return;
  for (const actor of game.actors.filter(entry => merchantConfig(entry).enabled)) {
    await maintainMerchantStock(actor, now);
    const config = merchantConfig(actor);
    if (config.restock.enabled && config.restock.rules.some(rule => rule.enabled && (!rule.startAt || rule.startAt <= now) && (!rule.nextRunAt || rule.nextRunAt <= now))) await restockMerchant(actor, { now });
  }
}
