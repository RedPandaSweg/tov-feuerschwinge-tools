import { MODULE_ID } from "../core/constants.mjs";
import { registerScheduledTask } from "../core/scheduler.mjs?v=3.7.8-central-scheduler-1";
import { registerCommerceControls, openCommerce } from "./app.mjs?v=3.7.8-runtime-audit-1";
import { activateCommerceSocket, commerceRequest } from "./socket.mjs?v=3.7.8-runtime-audit-1";
import { COMMERCE_RARITY_LEVELS_SETTING, COMMERCE_SETTING, commerceState, commerceSummary, enableMerchantViewerAccess, merchantConfig, settleExpiredAuctions } from "./service.mjs?v=3.7.8-runtime-audit-1";
import { migrateItemPilesMerchants } from "./migration.mjs";
import { runAutomaticRestocks } from "./restock.mjs?v=3.7.8-safe-documents-1";

let activated = false;

export function registerCommerce() {
  game.settings.register(MODULE_ID, COMMERCE_SETTING, {
    scope: "world", config: false, type: Object,
    default: { version: 1, auctions: [], requests: [], trades: [] }
  });
  game.settings.register(MODULE_ID, COMMERCE_RARITY_LEVELS_SETTING, {
    scope: "world", config: false, type: Object, default: {}
  });
  registerScheduledTask({
    id: "commerce.auctionSettlement",
    intervalMs: 60000,
    run: settleExpiredAuctions
  });
  registerScheduledTask({
    id: "commerce.restock",
    intervalMs: 30000,
    run: runAutomaticRestocks
  });
  registerCommerceControls();
}

export function activateCommerce() {
  if (activated) return;
  activated = true;
  activateCommerceSocket();
  if (game.user.isGM) {
    for (const merchant of game.actors.filter(actor => merchantConfig(actor).enabled)) {
      void enableMerchantViewerAccess(merchant).catch(error =>
        console.warn(`${MODULE_ID} | Could not grant viewer access to merchant ${merchant.uuid}.`, error));
    }
  }
  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.commerce = { open: openCommerce, request: commerceRequest, state: commerceState,
    summary: commerceSummary, migrateItemPilesMerchants };
}
