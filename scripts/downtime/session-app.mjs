import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { actorLevel, highestMilestoneProgress, isoWeekKey, milestoneCatchUpEnabled, monthKey, passiveDowntimeConfig, playerCharacters, rewardForLevel, sessionRewardDetails, sessionRewards, SessionService, sessionProgress } from "./session-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SessionApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-session",
    tag: "form",
    classes: ["downtime-manager", "downtime-session"],
    position: { width: 780, height: 820 },
    window: { title: "DOWNTIME_MANAGER.Session.Title", icon: "fa-solid fa-campground", resizable: true },
    actions: {
      selectConnected: this.#selectConnected,
      selectTokens: this.#selectTokens,
      save: this.#save,
      award: this.#award,
      settle: this.#settle,
      history: this.#history,
      configureRewards: this.#configureRewards,
      newSession: this.#newSession
    }
  };

  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/session.hbs" } };

  _onRender(context, options) {
    super._onRender(context, options);
    const search = this.element.querySelector("[data-actor-search]");
    const applySearch = () => {
      this._actorSearch = String(search?.value ?? "").trim().toLocaleLowerCase();
      for (const row of this.element.querySelectorAll("[data-actor-search-text]")) {
        row.hidden = Boolean(this._actorSearch && !row.dataset.actorSearchText.toLocaleLowerCase().includes(this._actorSearch));
      }
    };
    if (search) {
      search.value = this._actorSearch ?? "";
      search.addEventListener("input", applySearch);
      applySearch();
    }
  }

  async _prepareContext() {
    const active = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
    const selected = new Set(active.actorUuids ?? []);
    const passiveConfig = passiveDowntimeConfig();
    const periodKey = passiveConfig.period === "week" ? isoWeekKey() : monthKey();
    const rewardConfig = sessionRewards();
    const columnCount = Math.max(0, ...rewardConfig.levels.map(level => level.items.length));
    const selectedColumns = new Set(Array.isArray(active.rewardColumns) ? active.rewardColumns.map(Number) : Array.from({ length: columnCount }, (_, index) => index));
    const rewardColumns = [];
    for (let index = 0; index < columnCount; index++) {
      const entries = rewardConfig.levels.map(level => level.items[index]).filter(Boolean);
      const documents = [];
      for (const entry of entries) {
        const document = await fromUuid(entry.uuid).catch(() => null);
        if (document && !documents.some(existing => existing.uuid === document.uuid)) documents.push(document);
      }
      rewardColumns.push({ index, selected: selectedColumns.has(index), name: documents.map(document => document.name).join(" / ") || game.i18n.format("DOWNTIME_MANAGER.Session.RewardColumn", { column: index + 1 }), img: documents[0]?.img ?? "icons/svg/mystery-man.svg" });
    }
    const actors = [];
    const guildActors = playerCharacters();
    const highestProgress = highestMilestoneProgress(guildActors);
    for (const actor of guildActors) {
      const level = actorLevel(actor);
      const reward = rewardForLevel(level);
      const details = await sessionRewardDetails(reward, Number(active.multiplier ?? 1));
      const progress = sessionProgress(actor);
      actors.push({
        uuid: actor.uuid, name: actor.name, img: actor.img, level,
        selected: selected.has(actor.uuid), downtime: DowntimeService.get(actor),
        rewardItems: details.items.map(item => ({ ...item, selected: selectedColumns.has(item.columnIndex) })),
        milestones: progress.milestones,
        passive: Number(progress.passiveDowntime?.[periodKey] ?? 0)
      });
    }
    return {
      active,
      periodKey,
      passiveWeekly: passiveConfig.period === "week",
      historyEnabled: game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY_ENABLED),
      awarded: active.status === "awarded",
      actors,
      rewardColumns,
      awardMilestones: active.awardMilestones !== false,
      milestoneCatchUp: milestoneCatchUpEnabled(),
      highestProgress: {
        ...highestProgress,
        names: highestProgress.leaders.map(entry => entry.actor.name).join(", ") || game.i18n.localize("DOWNTIME_MANAGER.Common.None")
      },
      multipliers: [1, 1.5, 2].map(value => ({ value, selected: Number(active.multiplier ?? 1) === value }))
    };
  }

  #formState() {
    return {
      title: this.element.querySelector('[name="title"]')?.value.trim() ?? "",
      summary: this.element.querySelector('[name="summary"]')?.value.trim() ?? "",
      multiplier: Number(this.element.querySelector('[name="multiplier"]')?.value ?? 1),
      actorUuids: Array.from(this.element.querySelectorAll('[name="actors"]:checked')).map(input => input.value),
      rewardColumns: Array.from(this.element.querySelectorAll('[name="rewardColumns"]:checked')).map(input => Number(input.value)),
      awardMilestones: Boolean(this.element.querySelector('[name="awardMilestones"]')?.checked)
    };
  }

  static #selectConnected(event) {
    event.preventDefault();
    const selected = new Set(game.users.filter(user => user.active && !user.isGM).map(user => user.character?.uuid).filter(Boolean));
    this.element.querySelectorAll('[name="actors"]').forEach(input => input.checked = selected.has(input.value));
  }

  static #selectTokens(event) {
    event.preventDefault();
    const selected = new Set((canvas?.tokens?.controlled ?? []).map(token => token.actor?.uuid).filter(Boolean));
    this.element.querySelectorAll('[name="actors"]').forEach(input => input.checked = selected.has(input.value));
  }

  static async #save(event) {
    event.preventDefault();
    const state = this.#formState();
    if (!state.actorUuids.length || !state.title) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Required"));
    const previous = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
    if (previous.status === "awarded") return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.StartNew"));
    await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, { ...state, id: previous.id ?? foundry.utils.randomID(), startedAt: previous.startedAt ?? Date.now(), status: "draft" });
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Session.Saved"));
    await this.render({ force: true });
  }

  static async #award(event) {
    event.preventDefault();
    const form = this.#formState();
    const stored = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
    if (!form.actorUuids.length || !form.title) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Required"));
    const active = { ...stored, ...form, id: stored.id ?? foundry.utils.randomID(), title: form.title || game.i18n.localize("DOWNTIME_MANAGER.Session.Untitled") };
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Session.Award") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Session.AwardConfirm", { count: form.actorUuids.length })}</p>`
    });
    if (!confirmed) return;
    try {
      await SessionService.award({ active, actorUuids: form.actorUuids, multiplier: form.multiplier, rewardColumns: form.rewardColumns, awardMilestones: form.awardMilestones });
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Session.Awarded"));
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Session reward failed`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #settle(event) {
    event.preventDefault();
    const period = this.element.querySelector('[name="period"]')?.value || (passiveDowntimeConfig().period === "week" ? isoWeekKey() : monthKey());
    const confirmed = await foundry.applications.api.DialogV2.confirm({ window: { title: game.i18n.localize("DOWNTIME_MANAGER.Session.Settle") }, content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Session.SettleConfirm", { month: period })}</p>` });
    if (!confirmed) return;
    try {
      const record = await SessionService.settle(period);
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Session.Settled", { count: record.recipients.length }));
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Passive downtime settlement failed`, error);
      ui.notifications.error(error.message);
    }
  }

  static #history(event) { event.preventDefault(); return SessionService.openHistory(); }
  static async #configureRewards(event) { event.preventDefault(); const { SessionRewardConfigApp } = await import("./session-reward-config-app.mjs"); new SessionRewardConfigApp().render(true); }
  static async #newSession(event) { event.preventDefault(); await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, {}); await this.render({ force: true }); }
}
