import { MODULE_ID } from "../core/constants.mjs";
import { registerScheduledTask } from "../core/scheduler.mjs?v=3.11.5-task-authority-1";
import { registerCommerceControls, openCommerce } from "./app.mjs?v=3.8.5-merchant-interactor-avatar-1";
import { activateCommerceSocket, commerceRequest } from "./socket.mjs?v=3.8.5-purchase-filters-1";
import { COMMERCE_RARITY_LEVELS_SETTING, COMMERCE_SETTING, commerceState, commerceSummary, enableMerchantViewerAccess, merchantConfig, settleExpiredAuctions } from "./service.mjs?v=3.8.5-purchase-filters-1";
import { migrateItemPilesMerchants } from "./migration.mjs";
import { runAutomaticRestocks } from "./restock.mjs?v=3.8.5-manual-new-tags-1";

let activated = false;
// Keep the established flag name so folders configured by earlier releases
// retain their visibility setting. The flag now applies to every Actor in the
// folder tree, not only to merchants.
const HIDE_ACTOR_FOLDER_FLAG = "hideMerchantsFromPlayers";

function actorDirectoryRoot(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function folderIsHiddenFromPlayers(folder) {
  let current = folder;
  while (current) {
    if (current.getFlag(MODULE_ID, HIDE_ACTOR_FOLDER_FLAG) === true) return true;
    current = current.folder?.id ? current.folder : game.folders.get(current.folder);
  }
  return false;
}

function folderEntries(root, folder) {
  const id = CSS.escape(folder.id);
  return root.querySelectorAll([
    `[data-folder-id="${id}"]`,
    `.folder[data-entry-id="${id}"]`,
    `.folder[data-document-id="${id}"]`
  ].join(","));
}

function hideActorFoldersFromPlayers(_application, element) {
  if (game.user.isGM) return;
  const root = actorDirectoryRoot(element);
  if (!root) return;
  for (const actor of game.actors) {
    if (!folderIsHiddenFromPlayers(actor.folder)) continue;
    const selectors = [
      `[data-entry-id="${CSS.escape(actor.id)}"]`,
      `[data-document-id="${CSS.escape(actor.id)}"]`,
      `[data-actor-id="${CSS.escape(actor.id)}"]`,
      `[data-entry-uuid="${CSS.escape(actor.uuid)}"]`
    ].join(",");
    root.querySelectorAll(selectors).forEach(entry => entry.remove());
  }
  for (const folder of game.folders.filter(entry => entry.type === "Actor" && folderIsHiddenFromPlayers(entry))) {
    folderEntries(root, folder).forEach(entry => entry.remove());
  }
}

function addActorFolderVisibilityConfig(application, element) {
  if (!game.user.isGM) return;
  const root = actorDirectoryRoot(element);
  const folder = application?.document ?? application?.object ?? application?.folder;
  if (!root || folder?.documentName !== "Folder" || folder.type !== "Actor") return;
  if (root.querySelector("[data-tovf-actor-folder-visibility]")) return;
  const form = root.matches("form") ? root : root.querySelector("form");
  if (!form) return;
  const field = document.createElement("div");
  field.className = "form-group tovf-actor-folder-visibility-setting";
  field.dataset.tovfActorFolderVisibility = "";
  field.innerHTML = `<label><input type="checkbox" name="flags.${MODULE_ID}.${HIDE_ACTOR_FOLDER_FLAG}" data-dtype="Boolean" ${folder.getFlag(MODULE_ID, HIDE_ACTOR_FOLDER_FLAG) === true ? "checked" : ""}> ${game.i18n.localize("TOVF.ActorDirectory.FolderVisibility.Label")}</label><p class="hint">${game.i18n.localize("TOVF.ActorDirectory.FolderVisibility.Hint")}</p>`;
  const footer = form.querySelector(":scope > footer, .form-footer");
  if (footer) footer.before(field);
  else (form.querySelector(".standard-form") ?? form).append(field);
}

function registerActorDirectoryVisibility() {
  Hooks.on("renderActorDirectory", hideActorFoldersFromPlayers);
  Hooks.on("renderFolderConfig", addActorFolderVisibilityConfig);
  Hooks.on("renderApplicationV2", (application, element) => {
    if (application?.constructor?.name === "ActorDirectory" || application?.tabName === "actors") hideActorFoldersFromPlayers(application, element);
    else addActorFolderVisibilityConfig(application, element);
  });
}

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
  registerActorDirectoryVisibility();
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
