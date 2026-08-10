import { MODULE_ID } from "../core/constants.mjs";
import { MERCHANT_FLAG } from "./service.mjs";

function descriptionValue(value) {
  if (typeof value === "string") return value === "[object Object]" ? "" : value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["value", "html", "content", "description"]) {
    const result = descriptionValue(value[key]);
    if (result) return result;
  }
  return "";
}

function itemPilesData(document) {
  return document?.getFlag?.("item-piles", "data")
    ?? foundry.utils.getProperty(document, "flags.item-piles.data")
    ?? foundry.utils.getProperty(document, "delta.flags.item-piles.data")
    ?? null;
}

function merchantSource(document) {
  const data = itemPilesData(document);
  return data?.enabled && String(data?.type ?? "").toLowerCase() === "merchant" ? data : null;
}

function migrationSourceUuid({ actor, source, token }) {
  return token?.uuid ?? source?.uuid ?? actor?.uuid ?? null;
}

function migratedActor(sourceUuid) {
  return game.actors.find(actor => actor.getFlag(MODULE_ID, MERCHANT_FLAG)?.itemPilesSourceUuid === sourceUuid) ?? null;
}

export function findItemPilesMerchants() {
  const found = new Map();
  for (const actor of game.actors) {
    const data = merchantSource(actor);
    if (data) found.set(actor.uuid, { actor, source: actor, data, token: null });
  }
  for (const scene of game.scenes) {
    for (const token of scene.tokens) {
      const data = merchantSource(token) ?? merchantSource(token.actor);
      const actor = token.actor;
      if (!data || !actor) continue;
      const key = actor.uuid;
      if (!found.has(key)) found.set(key, { actor, source: token, data, token });
    }
  }
  return [...found.values()];
}

export async function migrateItemPilesMerchants() {
  if (!game.user.isGM) throw new Error("Nur die Spielleitung kann Händler importieren.");
  const entries = findItemPilesMerchants();
  const report = { found: entries.length, created: 0, updated: 0 };
  for (const entry of entries) {
    const { actor, data } = entry;
    const sourceUuid = migrationSourceUuid(entry);
    let target = migratedActor(sourceUuid) ?? actor;
    if (!game.actors.has(actor.id)) {
      if (!game.actors.has(target?.id)) {
        const source = actor.toObject();
        delete source._id;
        source.name = `${actor.name} (Händler)`;
        target = await Actor.create(source);
        report.created += 1;
      } else report.updated += 1;
    } else {
      report.updated += 1;
    }
    await target.setFlag(MODULE_ID, MERCHANT_FLAG, {
      enabled: true,
      buyModifier: Math.max(0, Number(data.buyPriceModifier ?? 1) || 0),
      sellModifier: Math.max(0, Number(data.sellPriceModifier ?? 0.5) || 0),
      infiniteStock: data.infiniteQuantity === true,
      infiniteCurrency: data.infiniteCurrencies !== false,
      purchaseOnly: data.purchaseOnly === true,
      keepSoldItems: true,
      hideNewItems: data.hideNewItems === true,
      displayQuantity: !["no", "alwaysno"].includes(String(data.displayQuantity ?? "yes").toLowerCase()),
      showZeroQuantity: data.keepZeroQuantity === true,
      description: descriptionValue(data.description)
        || descriptionValue(actor.system?.description)
        || descriptionValue(actor.system?.details?.description),
      merchantImage: String(data.merchantImage ?? ""),
      migratedFromItemPiles: true,
      itemPilesSourceUuid: sourceUuid
    });
  }
  return report;
}
