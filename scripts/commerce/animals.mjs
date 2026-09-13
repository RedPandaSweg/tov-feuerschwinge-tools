import { uiText } from "../core/localization.mjs";
import { MODULE_ID } from "../core/constants.mjs";
import { changeCurrency, quantityUpdate } from "./currency.mjs?v=3.5.0-item-quantity-1";

export function animalActorData(template, buyer, users) {
  if (template?.type !== "npc") throw new Error(uiText("TOVF.Interface.AnimalOffersRequireAnNPCActorTemplate_a16c3c", "Als Tierangebot wird eine NPC-Actor-Vorlage benötigt."));
  const data = structuredClone(template);
  delete data._id;
  delete data._stats;
  delete data.sort;
  data.folder = buyer.folder?.id ?? null;
  data.ownership = { default: 0 };
  for (const user of users) {
    if (user.isGM) continue;
    if (Number(buyer.ownership?.[user.id] ?? 0) >= 3 || (user.character?.id ?? user.character) === buyer.id) data.ownership[user.id] = 3;
  }
  if (!Object.keys(data.ownership).some(id => id !== "default")) throw new Error(uiText("TOVF.Interface.ThePurchasingCharacterHasNoAssignedPlayer_3b6ec7", "Dem kaufenden Charakter ist kein Spieler als Besitzer zugeordnet."));
  // Copies must not inherit merchant roles or transfer identities from a template.
  if (data.flags) {
    delete data.flags[MODULE_ID];
    delete data.flags["item-piles"];
    if (data.flags.core) delete data.flags.core.sourceId;
  }
  data.prototypeToken ??= {};
  delete data.prototypeToken._id;
  delete data.prototypeToken.actorId;
  data.prototypeToken.actorLink = true;
  data.flags ??= {};
  data.flags[MODULE_ID] = { purchasedAnimal: { characterId: buyer.id } };
  return data;
}

/** Compensate completed steps if actor creation or payment fails. */
export async function purchaseAnimals({ shop, buyer, item, template, users, quantity, copper, stock, config, denomination },
  { create = data => Actor.create(data, { renderSheet: false }), currency = changeCurrency } = {}) {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) throw new Error(uiText("TOVF.Interface.PleasePurchaseBetween1And100Animals_e77563", "Bitte zwischen 1 und 100 Tieren kaufen."));
  const data = animalActorData(template, buyer, users);
  const created = [];
  let debited = false, credited = false, stockChanged = false;
  try {
    await currency(buyer, -copper); debited = true;
    if (!config.infiniteCurrency) { await currency(shop, copper, { denomination }); credited = true; }
    if (!config.infiniteStock) {
      await shop.updateEmbeddedDocuments("Item", [quantityUpdate(item, stock - quantity)]);
      stockChanged = true;
    }
    for (let i = 0; i < quantity; i++) {
      const actor = await create(structuredClone(data));
      if (!actor) throw new Error(uiText("TOVF.Interface.TheAnimalActorCouldNotBeCreated_6db6ab", "Der Tier-Actor konnte nicht erstellt werden."));
      created.push(actor);
    }
    return created;
  } catch (error) {
    const failures = [];
    const undo = async operation => { try { await operation(); } catch (e) { failures.push(e); } };
    for (const actor of created.reverse()) await undo(() => actor.delete());
    if (stockChanged) await undo(() => shop.updateEmbeddedDocuments("Item", [quantityUpdate(item, stock)]));
    if (credited) await undo(() => currency(shop, -copper, { denomination }));
    if (debited) await undo(() => currency(buyer, copper));
    if (failures.length) throw new Error(uiText("TOVF.Interface.AnimalPurchaseInterruptedRollbackIncompleteAGM_54c220", "Tierkauf unterbrochen; Rückabwicklung unvollständig. Spielleitung muss Tiere, Gold und Bestand prüfen, bevor erneut gekauft wird."));
    throw error;
  }
}
