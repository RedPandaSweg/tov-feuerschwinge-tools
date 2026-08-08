import { FLAGS, MODULE_ID } from "./constants.mjs";
import { downtimeItemData, DowntimeItemService, updateDowntimeItemDescription } from "./downtime-item-service.mjs";
import { configureAsRecipe } from "./recipe-service.mjs";
import { isRecipeItem } from "./utils.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DowntimeItemApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-item-config", tag: "form",
    classes: ["downtime-manager", "downtime-item-config"],
    position: { width: 460, height: "auto" },
    window: { title: "DOWNTIME_MANAGER.DowntimeItem.Title", icon: "fa-solid fa-hourglass", resizable: true },
    actions: { makeProject: this.#makeProject, makeDowntimeItem: this.#makeDowntimeItem, save: this.#save, redeem: this.#redeem, remove: this.#remove }
  };
  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/downtime-item-config.hbs" } };

  constructor(item, options = {}) { super(options); this.item = item; }

  async _prepareContext() {
    const config = downtimeItemData(this.item);
    return {
      item: this.item,
      config: config ?? { amount: 1, consume: true, chatMessage: true },
      configured: Boolean(config),
      project: isRecipeItem(this.item),
      canConfigure: game.user.isGM,
      canRedeem: Boolean(config && !getSystemAdapter().capabilities.downtimeItems && (this.item.actor || this.item.parent?.documentName === "Actor") && this.item.isOwner),
      nativeUse: Boolean(config && getSystemAdapter().capabilities.downtimeItems)
    };
  }

  static async #makeProject(event) {
    event.preventDefault();
    if (!game.user.isGM) return;
    await this.item.unsetFlag(MODULE_ID, FLAGS.DOWNTIME_ITEM);
    await updateDowntimeItemDescription(this.item, null);
    await configureAsRecipe(this.item);
    await this.close();
  }

  static async #makeDowntimeItem(event) {
    event.preventDefault();
    if (!game.user.isGM) return;
    if (isRecipeItem(this.item)) await this.item.unsetFlag(MODULE_ID, FLAGS.RECIPE);
    await this.item.setFlag(MODULE_ID, FLAGS.DOWNTIME_ITEM, { enabled: true, amount: 1, consume: true, chatMessage: true });
    await updateDowntimeItemDescription(this.item, 1);
    await this.render({ force: true });
  }

  static async #save(event) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const amount = Number(this.element.querySelector('[name="amount"]')?.value);
    if (!Number.isFinite(amount) || amount < 0) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Errors.Amount"));
    await this.item.setFlag(MODULE_ID, FLAGS.DOWNTIME_ITEM, {
      enabled: true, amount,
      consume: Boolean(this.element.querySelector('[name="consume"]')?.checked),
      chatMessage: Boolean(this.element.querySelector('[name="chatMessage"]')?.checked)
    });
    await updateDowntimeItemDescription(this.item, amount);
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Saved"));
    await this.render({ force: true });
  }

  static async #redeem(event) {
    event.preventDefault();
    try { await DowntimeItemService.redeem(this.item); await this.render({ force: true }); }
    catch (error) { console.error(`${MODULE_ID} | Downtime item redemption failed`, error); ui.notifications.error(error.message); }
  }

  static async #remove(event) {
    event.preventDefault();
    if (!game.user.isGM) return;
    const yes = await foundry.applications.api.DialogV2.confirm({ window: { title: game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Remove") }, content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.RemoveConfirm")}</p>` });
    if (!yes) return;
    await this.item.unsetFlag(MODULE_ID, FLAGS.DOWNTIME_ITEM);
    await updateDowntimeItemDescription(this.item, null);
    await this.close();
  }
}
