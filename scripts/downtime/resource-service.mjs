import { getQuantity, itemIdentifier, quantityUpdate, round, sourceUuid } from "./utils.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";

export class ResourceService {
  static async #currencyValue(ingredient) {
    const adapter = getSystemAdapter();
    let item = ingredient;
    if (!adapter.isCurrencyItem(item) && ingredient.uuid) item = await fromUuid(ingredient.uuid);
    return adapter.isCurrencyItem(item) ? adapter.getCurrencyValue(item) : 0;
  }

  static async currencyCost(ingredients, multiplier = 1) {
    let total = 0;
    for (const ingredient of ingredients ?? []) {
      const value = await this.#currencyValue(ingredient);
      if (value) total += value * Number(ingredient.quantity ?? 0) * multiplier;
    }
    return round(total, 6);
  }

  static findMatches(actor, ingredient) {
    const wantedUuid = String(ingredient.uuid ?? "").toLowerCase();
    const wantedName = String(ingredient.name ?? "").trim().toLowerCase();
    const wantedIdentifier = String(ingredient.identifier ?? "").trim().toLowerCase();
    return actor.items.filter(item => {
      const source = String(sourceUuid(item)).toLowerCase();
      return Boolean(
        (wantedUuid && source === wantedUuid) ||
        (wantedIdentifier && itemIdentifier(item) === wantedIdentifier) ||
        (wantedName && String(item.name ?? "").trim().toLowerCase() === wantedName)
      );
    });
  }

  static available(actor, ingredient) {
    return this.findMatches(actor, ingredient).reduce((sum, item) => sum + getQuantity(item), 0);
  }

  static async has(actor, ingredients, multiplier = 1) {
    const adapter = getSystemAdapter();
    let currencyCost = 0;
    for (const ingredient of ingredients) {
      const value = await this.#currencyValue(ingredient);
      if (value) currencyCost += value * Number(ingredient.quantity) * multiplier;
      else if (this.available(actor, ingredient) + 1e-9 < Number(ingredient.quantity) * multiplier) return false;
    }
    return !currencyCost || adapter.getGold(actor) + 1e-9 >= currencyCost;
  }

  static async spend(actor, ingredients, multiplier = 1) {
    if (!(await this.has(actor, ingredients, multiplier))) return false;
    const adapter = getSystemAdapter();
    const updates = [];
    let currencyCost = 0;
    for (const ingredient of ingredients) {
      const currencyValue = await this.#currencyValue(ingredient);
      if (currencyValue) {
        currencyCost += currencyValue * Number(ingredient.quantity) * multiplier;
        continue;
      }
      let remaining = round(Number(ingredient.quantity) * multiplier, 4);
      for (const item of this.findMatches(actor, ingredient)) {
        if (remaining <= 0) break;
        const current = getQuantity(item);
        const used = Math.min(current, remaining);
        remaining = round(remaining - used, 4);
        updates.push({_id: item.id, ...quantityUpdate(item, round(current - used, 4))});
      }
    }
    if (currencyCost && !(await adapter.spendGold(actor, currencyCost))) return false;
    if (updates.length) await actor.updateEmbeddedDocuments("Item", updates);
    return true;
  }
}
