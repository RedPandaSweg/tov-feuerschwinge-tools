import { uiText } from "../core/localization.mjs";
export function normalizeOfferAccess(source = {}) {
  const value = source.minimumLevel;
  return {
    minimumLevel: value == null || value === "" ? null : Math.max(1, Math.min(20, Math.floor(Number(value) || 1))),
    purchaseLocked: source.purchaseLocked === true,
    purchaseNote: String(source.purchaseNote ?? "").trim()
  };
}

export function offerPurchaseAccess(source, defaultLevel, actorLevel = null) {
  const config = normalizeOfferAccess(source);
  const minimumLevel = config.minimumLevel ?? defaultLevel;
  const levelLocked = actorLevel !== null && actorLevel < minimumLevel;
  const purchaseBlocked = config.purchaseLocked || actorLevel === null || levelLocked;
  const purchaseMessage = config.purchaseLocked ? config.purchaseNote || uiText("TOVF.Interface.NotYetReleasedForPurchase_3cdc43", "Noch nicht zum Kauf freigegeben.")
    : levelLocked ? uiText("TOVF.Interface.PurchaseFromLevelP0_0400db", "Kauf ab Level {p0}", { p0: (minimumLevel) }) : actorLevel === null ? uiText("TOVF.Interface.PleaseSelectACharacter_f4bbbc", "Bitte einen Charakter auswählen") : "";
  return { minimumLevel, levelLocked, purchaseBlocked, purchaseMessage };
}
