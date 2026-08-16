import { MODULE_ID } from "../core/constants.mjs";
import { registerCommerceControls, openCommerce } from "./app.mjs?v=3.2.7-rolltable-stock-2";
import { activateCommerceSocket, commerceRequest } from "./socket.mjs";
import { COMMERCE_SETTING, commerceState, commerceSummary, settleExpiredAuctions } from "./service.mjs";
import { migrateItemPilesMerchants } from "./migration.mjs";

let settlementTimer;

export function registerCommerce() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, COMMERCE_SETTING, {
      scope: "world", config: false, type: Object,
      default: { version: 1, auctions: [], requests: [], trades: [] }
    });
  });
  registerCommerceControls();
}

export function activateCommerce() {
  activateCommerceSocket();
  if (game.user.isGM) {
    void settleExpiredAuctions().catch(error => console.error(`${MODULE_ID} | Auction settlement failed`, error));
    clearInterval(settlementTimer);
    settlementTimer = setInterval(() => void settleExpiredAuctions().catch(error =>
      console.error(`${MODULE_ID} | Auction settlement failed`, error)), 60000);
  }
  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.commerce = { open: openCommerce, request: commerceRequest, state: commerceState,
    summary: commerceSummary, migrateItemPilesMerchants };
}
