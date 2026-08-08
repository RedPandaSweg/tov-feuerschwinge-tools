import { createDefaultSessionRewards, DEFAULT_PASSIVE_DOWNTIME, MODULE_ID, SETTINGS } from "./constants.mjs";
import { normalizeSessionRewards, passiveDowntimeConfig, sessionRewards } from "./session-service.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SessionRewardConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-session-rewards", tag: "form",
    classes: ["downtime-manager", "session-reward-config"],
    position: { width: 680, height: 820 },
    window: { title: "DOWNTIME_MANAGER.Session.ConfigTitle", icon: "fa-solid fa-gift", resizable: true },
    actions: { save: this.#save, reset: this.#reset, removeItem: this.#removeItem }
  };
  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/session-rewards.hbs" } };

  async _prepareContext() {
    const levels = [];
    for (const [index, level] of sessionRewards().levels.entries()) {
      const items = [];
      for (const [itemIndex, item] of level.items.entries()) {
        const document = await fromUuid(item.uuid).catch(() => null);
        items.push({ ...item, itemIndex, name: document?.name ?? item.uuid, img: document?.img ?? "icons/svg/mystery-man.svg" });
      }
      levels.push({ ...level, index, items });
    }
    const passive = passiveDowntimeConfig();
    return { levels, passive: { ...passive, ratePercent: passive.rate * 100 } };
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    this.element.addEventListener("dragover", event => { if (event.target.closest("[data-item-zone]")) event.preventDefault(); });
    this.element.addEventListener("drop", event => this.#drop(event));
  }

  #read() {
    const form = new FormData(this.element);
    return normalizeSessionRewards({ levels: sessionRewards().levels.map((level, index) => ({
      level: level.level,
      items: level.items.map((item, itemIndex) => ({ uuid: item.uuid, quantity: form.get(`levels.${index}.items.${itemIndex}.quantity`) }))
    })) });
  }

  async #drop(event) {
    const zone = event.target.closest("[data-item-zone]");
    if (!zone) return;
    event.preventDefault();
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    const item = data.type === "Item" && data.uuid ? await fromUuid(data.uuid).catch(() => null) : null;
    if (!item) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.ItemRequired"));
    const config = this.#read();
    config.levels[Number(zone.dataset.levelIndex)]?.items.push({ uuid: item.uuid, quantity: 1 });
    await game.settings.set(MODULE_ID, SETTINGS.SESSION_REWARDS, config);
    await this.render({ force: true });
  }

  static async #save(event) {
    event.preventDefault();
    const ratePercent = Math.max(0, Number(this.element.querySelector('[name="passive.rate"]')?.value) || 0);
    const capMultiplier = Math.max(0, Number(this.element.querySelector('[name="passive.capMultiplier"]')?.value) || 0);
    await game.settings.set(MODULE_ID, SETTINGS.SESSION_REWARDS, this.#read());
    await game.settings.set(MODULE_ID, SETTINGS.PASSIVE_DOWNTIME, { enabled: Boolean(this.element.querySelector('[name="passive.enabled"]')?.checked), period: this.element.querySelector('[name="passive.period"]')?.value === "week" ? "week" : "month", rate: ratePercent / 100, capMultiplier });
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Session.ConfigSaved"));
  }
  static async #removeItem(event, target) { event.preventDefault(); const config = this.#read(); config.levels[Number(target.dataset.levelIndex)]?.items.splice(Number(target.dataset.itemIndex), 1); await game.settings.set(MODULE_ID, SETTINGS.SESSION_REWARDS, config); await this.render({ force: true }); }
  static async #reset(event) { event.preventDefault(); const yes = await foundry.applications.api.DialogV2.confirm({ window: { title: game.i18n.localize("DOWNTIME_MANAGER.Session.Reset") }, content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.Session.ResetConfirm")}</p>` }); if (!yes) return; await game.settings.set(MODULE_ID, SETTINGS.SESSION_REWARDS, createDefaultSessionRewards(getSystemAdapter().getDefaultGoldItemUuid())); await game.settings.set(MODULE_ID, SETTINGS.PASSIVE_DOWNTIME, foundry.utils.deepClone(DEFAULT_PASSIVE_DOWNTIME)); await this.render({ force: true }); }
}
