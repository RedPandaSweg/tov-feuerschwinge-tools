import { changeCurrency, itemQuantity, quantityUpdate, validateCurrencyChange } from "./currency.mjs";

const locks = new Map();

async function locked(keys, operation) {
  const ordered = [...new Set(keys)].sort();
  while (ordered.some(key => locks.has(key))) {
    await Promise.race(ordered.map(key => locks.get(key)).filter(Boolean));
  }
  let release;
  const promise = new Promise(resolve => release = resolve);
  for (const key of ordered) locks.set(key, promise);
  try { return await operation(); }
  finally {
    for (const key of ordered) if (locks.get(key) === promise) locks.delete(key);
    release();
  }
}

export function cleanTransferredItem(item, quantity) {
  const data = item.toObject();
  delete data._id;
  delete data._stats;
  data.system.quantity = quantity;
  data.system.container = null;
  foundry.utils.deleteProperty(data, "flags.core.sourceId");
  if (data.flags?.["black-flag"]?.relationship?.attuned) data.flags["black-flag"].relationship.attuned = false;
  const aliases = { platinum: "pp", gold: "gp", silver: "sp", copper: "cp" };
  const denomination = String(data.system?.price?.denomination ?? "").toLowerCase();
  if (data.system?.price && aliases[denomination]) data.system.price.denomination = aliases[denomination];
  return data;
}

function stackSignature(item) {
  const data = item?.toObject ? item.toObject() : foundry.utils.deepClone(item);
  delete data._id;
  delete data._stats;
  delete data.sort;
  foundry.utils.deleteProperty(data, "system.quantity");
  foundry.utils.deleteProperty(data, "system.container");
  foundry.utils.deleteProperty(data, "flags.core.sourceId");
  return JSON.stringify(data);
}

export async function addItem(actor, itemData, quantity, { stackWeapons = false } = {}) {
  const signature = stackSignature(itemData);
  const existing = itemData.type === "weapon" && !stackWeapons ? null : actor.items.find(item => stackSignature(item) === signature);
  if (existing) {
    await existing.update({ "system.quantity": itemQuantity(existing) + quantity });
    return existing;
  }
  const data = foundry.utils.deepClone(itemData);
  foundry.utils.setProperty(data, "system.quantity", quantity);
  const [created] = await actor.createEmbeddedDocuments("Item", [data]);
  return created;
}

export async function removeItem(actor, item, quantity) {
  const current = itemQuantity(item);
  if (!(quantity > 0) || current < quantity) throw new Error(`${item.name} ist nicht in ausreichender Menge vorhanden.`);
  if (current === quantity) await actor.deleteEmbeddedDocuments("Item", [item.id]);
  else await actor.updateEmbeddedDocuments("Item", [quantityUpdate(item, current - quantity)]);
}

async function transferItemUnlocked({ source, target, itemId, quantity = 1, keepSource = false }) {
  quantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const item = source.items.get(itemId);
  if (!item) throw new Error("Der Gegenstand wurde nicht gefunden.");
  if (item.type === "currency") throw new Error("Währung wird über den Geldbetrag übertragen.");
  if (itemQuantity(item) < quantity && !keepSource) throw new Error("Der Bestand reicht nicht aus.");
  const data = cleanTransferredItem(item, quantity);
  if (!keepSource) await removeItem(source, item, quantity);
  try { return await addItem(target, data, quantity); }
  catch (error) {
    if (!keepSource) await addItem(source, data, quantity).catch(() => {});
    throw error;
  }
}

export async function transferItem(options) {
  return locked([options.source.uuid, options.target.uuid], () => transferItemUnlocked(options));
}

export async function exchange({ fromActor, toActor, fromCopper = 0, toCopper = 0, fromItems = [], toItems = [] }) {
  return locked([fromActor.uuid, toActor.uuid], async () => {
    validateCurrencyChange(fromActor, -fromCopper + toCopper);
    validateCurrencyChange(toActor, -toCopper + fromCopper);
    for (const entry of fromItems) {
      const item = fromActor.items.get(entry.itemId);
      if (!item || itemQuantity(item) < entry.quantity) throw new Error("Ein angebotener Gegenstand ist nicht mehr verfügbar.");
    }
    for (const entry of toItems) {
      const item = toActor.items.get(entry.itemId);
      if (!item || itemQuantity(item) < entry.quantity) throw new Error("Ein angeforderter Gegenstand ist nicht mehr verfügbar.");
    }
    if (fromCopper !== toCopper) {
      await changeCurrency(fromActor, -fromCopper + toCopper);
      try { await changeCurrency(toActor, -toCopper + fromCopper); }
      catch (error) {
        await changeCurrency(fromActor, fromCopper - toCopper).catch(() => {});
        throw error;
      }
    }
    for (const entry of fromItems) await transferItemUnlocked({ source: fromActor, target: toActor, ...entry });
    for (const entry of toItems) await transferItemUnlocked({ source: toActor, target: fromActor, ...entry });
    return true;
  });
}
