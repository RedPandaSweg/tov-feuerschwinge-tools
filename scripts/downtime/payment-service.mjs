import { ResourceService } from "./resource-service.mjs";
import { getQuantity, quantityUpdate, round } from "./utils.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";

function requestedQuantities(selection = []) {
  const quantities = new Map();
  for (const entry of Array.isArray(selection) ? selection : []) {
    const uuid = String(entry?.uuid ?? "");
    const quantity = Number(entry?.quantity ?? 0);
    if (!uuid || !Number.isInteger(quantity) || quantity < 0) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.InvalidPayment"));
    }
    if (quantities.has(uuid)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.InvalidPayment"));
    quantities.set(uuid, quantity);
  }
  return quantities;
}

export class PaymentService {
  static #remainingQuantities(actor, reservedCosts = [], multiplier = 1) {
    const remaining = new Map(actor.items.map(item => [item.id, getQuantity(item)]));
    for (const cost of reservedCosts) {
      let required = Math.max(0, Number(cost.quantity) || 0) * multiplier;
      for (const item of ResourceService.findMatches(actor, cost)) {
        if (required <= 0) break;
        const available = Math.max(0, Number(remaining.get(item.id)) || 0);
        const used = Math.min(available, required);
        remaining.set(item.id, round(available - used, 6));
        required = round(required - used, 6);
      }
    }
    return remaining;
  }

  static options(actor, station, reservedCosts = [], multiplier = 1) {
    const remaining = this.#remainingQuantities(actor, reservedCosts, multiplier);
    return (station.paymentItems ?? []).map(entry => ({
      ...entry,
      available: Math.max(0, Math.floor(ResourceService.findMatches(actor, entry)
        .reduce((sum, item) => sum + (remaining.get(item.id) ?? 0), 0))),
      goldValue: round(Math.max(0.000001, Number(entry.goldValue) || 1), 6)
    })).filter(entry => entry.available > 0);
  }

  static quote(actor, station, cost, selection = [], { reservedCosts = [], multiplier = 1 } = {}) {
    const totalCost = round(Math.max(0, Number(cost) || 0), 6);
    const configured = new Map((station.paymentItems ?? []).map(entry => [String(entry.uuid), entry]));
    const quantities = requestedQuantities(selection);
    for (const uuid of quantities.keys()) {
      if (!configured.has(uuid)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.PaymentItemUnavailable"));
    }

    const allocations = [];
    const remainingByItem = this.#remainingQuantities(actor, reservedCosts, multiplier);
    let replacementValue = 0;
    for (const [uuid, quantity] of quantities) {
      if (!quantity) continue;
      const configuredItem = configured.get(uuid);
      let remaining = quantity;
      for (const item of ResourceService.findMatches(actor, configuredItem)) {
        if (remaining <= 0) break;
        const available = Math.max(0, Number(remainingByItem.get(item.id)) || 0);
        const used = Math.min(available, remaining);
        if (used <= 0) continue;
        remaining = round(remaining - used, 6);
        remainingByItem.set(item.id, round(available - used, 6));
        allocations.push({ item, quantity: used });
      }
      if (remaining > 1e-9) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.PaymentItemMissing"));
      replacementValue += quantity * Math.max(0.000001, Number(configuredItem.goldValue) || 1);
    }

    replacementValue = round(replacementValue, 6);
    const gold = round(Math.max(0, totalCost - replacementValue), 6);
    return {
      cost: totalCost,
      replacementValue,
      gold,
      overpayment: round(Math.max(0, replacementValue - totalCost), 6),
      allocations
    };
  }

  static canPay(actor, station, cost, reservedCosts = [], multiplier = 1) {
    const total = getSystemAdapter().getGold(actor) + this.options(actor, station, reservedCosts, multiplier)
      .reduce((sum, entry) => sum + entry.available * entry.goldValue, 0);
    return total + 1e-9 >= Math.max(0, Number(cost) || 0);
  }

  static async spend(actor, station, cost, selection = [], options = {}) {
    const adapter = getSystemAdapter();
    const quote = this.quote(actor, station, cost, selection, options);
    if (adapter.getGold(actor) + 1e-9 < quote.gold) return false;
    if (quote.gold > 0 && !(await adapter.spendGold(actor, quote.gold))) return false;
    if (quote.allocations.length) {
      const quantities = new Map();
      for (const { item, quantity } of quote.allocations) {
        quantities.set(item.id, round((quantities.get(item.id) ?? getQuantity(item)) - quantity, 6));
      }
      await actor.updateEmbeddedDocuments("Item", Array.from(quantities, ([id, quantity]) => {
        const item = actor.items.get(id);
        return { _id: id, ...quantityUpdate(item, quantity) };
      }));
    }
    return quote;
  }
}
