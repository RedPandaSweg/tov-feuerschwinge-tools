import { MODULE_ID } from "../core/constants.mjs";
import { subscribeModuleEvent, unsubscribeModuleEvent } from "../core/events.mjs?v=3.7.8-module-events-1";
import { merchantConfig, merchantStockQuantity } from "./service.mjs?v=3.7.8-runtime-audit-1";
import { restockMerchant } from "./restock.mjs?v=3.7.8-safe-documents-1";
import { merchantSpellScrollOffers } from "../spell-scrolls.mjs?v=3.7.8-clearance-label-1";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const UNITS = ["minutes", "hours", "days", "weeks", "months"];

function freshRule() {
  return { id: foundry.utils.randomID(), enabled: true, tableId: "", rolls: 1, quantityMin: 1, quantityMax: 1,
    intervalValue: 1, intervalUnit: "weeks", discountValue: 0, discountUnit: "weeks", discountPercent: 0,
    removeValue: 0, removeUnit: "weeks", startAt: 0, lastRunAt: 0, nextRunAt: 0, lastDelivery: [], deliveries: [] };
}

export class RestockConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = { id: "tovf-restock-config", classes: ["tovf-restock-config"], position: { width: 850, height: 720 },
    window: { title: "TOVF.Interface.Restock.Title", icon: "fa-solid fa-truck", resizable: true }, actions: {
      addRule: this.addRule, removeRule: this.removeRule, save: this.save, run: this.run
    } };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/restock-config.hbs` } };
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
    this.enabled = merchantConfig(actor).restock.enabled;
    this.rules = foundry.utils.deepClone(merchantConfig(actor).restock.rules);
    this._stockChangedHook = subscribeModuleEvent("merchantStockChanged", ({ actorId }) => {
      if (actorId !== this.actor.id || !this.element) return;
      this._readForm();
      const currentRules = new Map(this.rules.map(rule => [rule.id, rule]));
      const stored = merchantConfig(this.actor).restock;
      this.rules = foundry.utils.deepClone(stored.rules).map(rule => ({
        ...(currentRules.get(rule.id) ?? rule),
        lastRunAt: rule.lastRunAt,
        nextRunAt: rule.nextRunAt,
        lastDelivery: rule.lastDelivery,
        deliveries: rule.deliveries
      }));
      this._restoreView = {
        scrollTop: this.element.querySelector(".tovf-restock-root")?.parentElement?.scrollTop ?? 0,
        openRules: [...this.element.querySelectorAll("[data-restock-rule] details[open]")]
          .map(details => details.closest("[data-restock-rule]")?.dataset.ruleId).filter(Boolean)
      };
      void this.render({ force: true });
    });
  }
  _onRender(context, options) {
    super._onRender(context, options);
    for (const row of this.element.querySelectorAll("[data-restock-rule]")) {
      row.querySelector('[name="startDate"]')?.addEventListener("input", event => {
        const timestamp = event.currentTarget.value ? new Date(event.currentTarget.value).getTime() : 0;
        const output = row.querySelector("[data-next-run]");
        if (output) output.textContent = timestamp && Number.isFinite(timestamp)
          ? new Date(timestamp).toLocaleString(game.i18n.lang)
          : game.i18n.localize("TOVF.Interface.Restock.NotScheduled");
      });
    }
    if (this._restoreView) {
      const { scrollTop, openRules } = this._restoreView;
      this._restoreView = null;
      for (const ruleId of openRules) this.element.querySelector(`[data-restock-rule][data-rule-id="${ruleId}"] details`)?.setAttribute("open", "");
      const scroller = this.element.querySelector(".tovf-restock-root")?.parentElement;
      if (scroller) scroller.scrollTop = scrollTop;
    }
  }
  _onClose(options) {
    unsubscribeModuleEvent("merchantStockChanged", this._stockChangedHook);
    return super._onClose(options);
  }
  _readForm() {
    this.enabled = this.element.querySelector('[name="enabled"]')?.checked === true;
    this.rules = [...this.element.querySelectorAll("[data-restock-rule]")].map(row => {
      const old = this.rules.find(rule => rule.id === row.dataset.ruleId) ?? freshRule();
      const value = name => row.querySelector(`[name="${name}"]`)?.value;
      const startDate = value("startDate");
      const startAt = startDate ? new Date(startDate).getTime() : 0;
      const startChanged = Math.floor(startAt / 60000) !== Math.floor(Number(old.startAt || 0) / 60000);
      return { ...old, id: row.dataset.ruleId, enabled: row.querySelector('[name="ruleEnabled"]')?.checked === true,
        tableId: value("tableId") ?? "", rolls: Math.max(1, Number(value("rolls")) || 1), quantityMin: Math.max(1, Number(value("quantityMin")) || 1), quantityMax: Math.max(1, Number(value("quantityMax")) || 1),
        intervalValue: Math.max(1, Number(value("intervalValue")) || 1), intervalUnit: value("intervalUnit"), discountValue: Math.max(0, Number(value("discountValue")) || 0),
        discountUnit: value("discountUnit"), discountPercent: Math.clamp(Number(value("discountPercent")) || 0, 0, 100), removeValue: Math.max(0, Number(value("removeValue")) || 0), removeUnit: value("removeUnit"),
        startAt: startChanged ? startAt : old.startAt, nextRunAt: startChanged ? startAt : old.nextRunAt };
    });
  }
  async _prepareContext() {
    const dateTime = timestamp => timestamp ? new Date(timestamp).toLocaleString(game.i18n.lang) : "";
    const never = game.i18n.localize("TOVF.Interface.Restock.Never");
    const offers = merchantSpellScrollOffers(this.actor);
    const stockState = item => {
      if (item.spell) {
        const offer = offers.find(entry => entry.id === item.stockId) ?? (!item.stockId ? offers.find(entry => entry.spellUuid === item.uuid) : null);
        return !offer || offer.quantity <= 0;
      }
      const stock = this.actor.items.get(item.stockId) ?? (!item.stockId
        ? this.actor.items.find(entry => entry.getFlag(MODULE_ID, "merchantItem")?.sourceUuid === item.uuid)
          ?? this.actor.items.find(entry => entry.name.localeCompare(item.name, undefined, { sensitivity: "base" }) === 0)
        : null);
      return !stock || merchantStockQuantity(stock) <= 0;
    };
    return { actorName: this.actor.name, enabled: this.enabled, rules: this.rules.map(rule => ({ ...rule,
    tableOptions: game.tables.map(table => ({ id: table.id, name: table.name, selected: table.id === rule.tableId })),
    units: UNITS.map(id => ({ id, label: game.i18n.localize(`TOVF.Interface.Restock.Units.${id}`) })),
    nextRun: rule.nextRunAt ? dateTime(rule.nextRunAt) : game.i18n.localize("TOVF.Interface.Restock.NotScheduled"),
    hasDeliveries: rule.deliveries?.length > 0,
    deliveries: [...(rule.deliveries ?? [])].reverse().map(delivery => ({ ...delivery, deliveredAt: dateTime(delivery.at),
      items: delivery.items.map(item => ({ ...item, sold: stockState(item), discountLabel: item.discountAt ? dateTime(item.discountAt) : never, removeLabel: item.removeAt ? dateTime(item.removeAt) : never })) })),
    startDate: rule.startAt ? (() => { const date = new Date(rule.startAt); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}T${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`; })() : "" })) }; }
  async _persist() { this._readForm(); const config = merchantConfig(this.actor); await this.actor.setFlag(MODULE_ID, "merchant", { ...config, restock: { enabled: this.enabled, rules: this.rules } }); }
  static async addRule() { this._readForm(); this.rules.push(freshRule()); await this.render({ force: true }); }
  static async removeRule(_event, target) { this._readForm(); this.rules = this.rules.filter(rule => rule.id !== target.dataset.ruleId); await this.render({ force: true }); }
  static async save() { await this._persist(); this.rules = foundry.utils.deepClone(merchantConfig(this.actor).restock.rules); ui.notifications.info(game.i18n.localize("TOVF.Interface.Restock.Saved")); await this.render({ force: true }); }
  static async run() { await this._persist(); await restockMerchant(this.actor, { force: true }); this.rules = foundry.utils.deepClone(merchantConfig(this.actor).restock.rules); ui.notifications.info(game.i18n.localize("TOVF.Interface.Restock.Complete")); await this.render({ force: true }); }
}
