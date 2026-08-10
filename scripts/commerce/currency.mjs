const COIN_CP = Object.freeze({ pp: 1000, gp: 100, sp: 10, cp: 1 });
const COIN_ORDER = Object.freeze(["pp", "gp", "sp", "cp"]);

export function itemQuantity(item) { return Math.max(0, Number(item?.system?.quantity ?? 1) || 0); }
export function quantityForPrice(item) {
  const configured = foundry.utils.getProperty(item, "flags.tov-feuerschwinge-tools.commerce.quantityForPrice") ?? 1;
  return Math.max(1, Math.floor(Number(configured) || 1));
}
export function quantityUpdate(item, quantity) { return { _id: item.id, "system.quantity": Math.max(0, Number(quantity) || 0) }; }
export function currencyIdentifier(item) {
  if (item?.type !== "currency") return "";
  return String(item.system?.identifier?.value ?? item.system?.identifier ?? "").trim().toLowerCase();
}
export function priceInCopper(item, multiplier = 1) {
  const value = Number(item?.system?.price?.value ?? 0);
  const denomination = String(item?.system?.price?.denomination ?? "gp").toLowerCase();
  return Math.max(0, Math.round(value * (COIN_CP[denomination] ?? 100) * Number(multiplier || 0)));
}
export function purse(actor) {
  const coins = new Map();
  for (const item of actor?.items ?? []) {
    const id = currencyIdentifier(item);
    if (id in COIN_CP) coins.set(id, { item, quantity: itemQuantity(item) });
  }
  return coins;
}
export function balanceInCopper(actor) {
  let total = 0;
  for (const [id, entry] of purse(actor)) total += entry.quantity * COIN_CP[id];
  return total;
}
export function formatCopper(copper) {
  let remaining = Math.max(0, Math.round(Number(copper) || 0));
  const parts = [];
  for (const id of ["gp", "sp", "cp"]) {
    const quantity = Math.floor(remaining / COIN_CP[id]);
    if (quantity) parts.push(`${quantity} ${id}`);
    remaining -= quantity * COIN_CP[id];
  }
  return parts.join(" ") || "0 gp";
}

function distribute(entries, quantities, copper, order) {
  let remaining = copper;
  for (const id of order) {
    if (!entries.has(id)) continue;
    const quantity = Math.floor(remaining / COIN_CP[id]);
    if (quantity) quantities.set(id, (quantities.get(id) ?? 0) + quantity);
    remaining -= quantity * COIN_CP[id];
  }
  return remaining;
}

function resultingQuantities(actor, deltaCopper, { denomination = "" } = {}) {
  const entries = purse(actor);
  const delta = Math.round(Number(deltaCopper) || 0);
  if (balanceInCopper(actor) + delta < 0) throw new Error(`${actor.name} besitzt nicht genug Geld.`);
  if (!entries.size && balanceInCopper(actor) + delta) throw new Error(`${actor.name} besitzt keine unterstützten Währungsitems.`);
  const quantities = new Map([...entries].map(([id, entry]) => [id, entry.quantity]));

  if (delta >= 0) {
    let preferred = String(denomination ?? "").toLowerCase();
    if (preferred === "pp") preferred = "gp";
    const exact = [preferred, "gp", "sp", "cp", "pp"].find(id => id && entries.has(id) && delta % COIN_CP[id] === 0);
    if (exact) quantities.set(exact, (quantities.get(exact) ?? 0) + delta / COIN_CP[exact]);
    else if (distribute(entries, quantities, delta, COIN_ORDER)) throw new Error(`${actor.name} kann den Betrag nicht exakt darstellen.`);
    return { entries, quantities };
  }

  let remaining = -delta;
  for (const id of ["cp", "sp", "gp", "pp"]) {
    const available = quantities.get(id) ?? 0;
    const spend = Math.min(available, Math.floor(remaining / COIN_CP[id]));
    quantities.set(id, available - spend);
    remaining -= spend * COIN_CP[id];
  }
  if (remaining) {
    const breakId = ["sp", "gp", "pp"].find(id => entries.has(id) && (quantities.get(id) ?? 0) > 0 && COIN_CP[id] > remaining);
    if (!breakId) throw new Error(`${actor.name} kann den Betrag nicht exakt bezahlen.`);
    quantities.set(breakId, quantities.get(breakId) - 1);
    const change = COIN_CP[breakId] - remaining;
    const lower = ["gp", "sp", "cp"].filter(id => COIN_CP[id] < COIN_CP[breakId]);
    if (distribute(entries, quantities, change, lower)) throw new Error(`${actor.name} kann das Wechselgeld nicht darstellen.`);
  }
  return { entries, quantities };
}

export function validateCurrencyChange(actor, deltaCopper, options = {}) { resultingQuantities(actor, deltaCopper, options); return true; }
export async function changeCurrency(actor, deltaCopper, options = {}) {
  const { entries, quantities } = resultingQuantities(actor, deltaCopper, options);
  const updates = [];
  for (const [id, entry] of entries) {
    const quantity = quantities.get(id) ?? 0;
    if (quantity !== entry.quantity) updates.push(quantityUpdate(entry.item, quantity));
  }
  if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
}
export function coinValues() { return COIN_CP; }
