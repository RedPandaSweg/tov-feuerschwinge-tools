import { MODULE_ID, SETTINGS } from "./constants.mjs";
import { WORLD_ROLES } from "../core/constants.mjs";
import { cleanupSessionImport, exportSession, exportSessionResult, importSession, importSessionResult } from "../transfer/session-transfer.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { isoWeekKey, levelFromMilestones, monthKey, passiveDowntimeConfig, playerCharacters, rewardForLevel, sessionRewardDetails, sessionRewards, SessionService, sessionProgress } from "./session-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class SessionApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-session",
    tag: "form",
    classes: ["downtime-manager", "downtime-session"],
    position: { width: 780, height: 820 },
    window: { title: "DOWNTIME_MANAGER.Session.Title", icon: "fa-solid fa-scroll", resizable: true },
    actions: {
      selectConnected: this.#selectConnected,
      selectTokens: this.#selectTokens,
      selectAll: this.#selectAll,
      selectNone: this.#selectNone,
      save: this.#save,
      award: this.#award,
      settle: this.#settle,
      history: this.#history,
      configureRewards: this.#configureRewards,
      workflowExportSession: this.#workflowExportSession,
      workflowImportSession: this.#workflowImportSession,
      workflowExportResult: this.#workflowExportResult,
      workflowImportResult: this.#workflowImportResult,
      workflowCleanup: this.#workflowCleanup,
      workflowReset: this.#workflowReset,
      newSession: this.#newSession
    }
  };

  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/session.hbs" } };

  _onRender(context, options) {
    super._onRender(context, options);
    if (!this._sessionWorldSized && game.settings.get(MODULE_ID, "worldRole") === WORLD_ROLES.SESSION) {
      this._sessionWorldSized = true;
      this.setPosition({ width: 780, height: "auto" });
    }
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
    const mode = this.element.querySelector('[name="selectionMode"]');
    const applyMode = () => {
      const playerMode = mode?.value === "player";
      this.element.querySelector("[data-character-selection]")?.toggleAttribute("hidden", playerMode);
      this.element.querySelector("[data-player-selection]")?.toggleAttribute("hidden", !playerMode);
    };
    mode?.addEventListener("change", applyMode);
    applyMode();
    for (const input of this.element.querySelectorAll('[name="players"]')) {
      input.addEventListener("change", () => {
        const uuids = String(input.dataset.actorUuids ?? "").split(",").filter(Boolean);
        for (const uuid of uuids) {
          const actorInput = this.element.querySelector(`[name="actors"][value="${CSS.escape(uuid)}"]`);
          if (actorInput) actorInput.checked = input.checked;
        }
      });
    }
    for (const input of this.element.querySelectorAll('[name="actors"]')) input.addEventListener("change", () => this.#syncPlayerSelection());
    for (const [fileName, action] of [
      ["workflowResultFile", "workflowImportResult"],
      ["workflowSessionFile", "workflowImportSession"]
    ]) {
      const fileInput = this.element.querySelector(`[name="${fileName}"]`);
      const button = this.element.querySelector(`[data-action="${action}"]`);
      if (!fileInput || !button) continue;
      const updateButton = () => button.disabled = !fileInput.files?.length;
      fileInput.addEventListener("change", updateButton);
      updateButton();
    }
  }

  async _prepareContext() {
    const active = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
    const worldRole = game.settings.get(MODULE_ID, "worldRole");
    const workflowStatusKey = ["draft", "exported", "imported", "played", "returned", "awarded"].includes(active.status)
      ? active.status
      : "empty";
    const selected = new Set(active.actorUuids ?? []);
    const selectedTransferIds = new Set(active.participantTransferIds ?? []);
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
    for (const actor of guildActors) {
      const progress = sessionProgress(actor);
      const level = levelFromMilestones(progress.milestones);
      const reward = rewardForLevel(level);
      const details = await sessionRewardDetails(reward, Number(active.multiplier ?? 1));
      const transferId = actor.getFlag(MODULE_ID, "transfer")?.id
        ?? `world:${game.world.id}:Actor:${actor.id}`;
      actors.push({
        uuid: actor.uuid, name: actor.name, img: actor.img, level,
        folder: actor.folder ? SessionApp.#folderPath(actor.folder) : game.i18n.localize("TOVF.Transfer.Root"),
        selected: selected.has(actor.uuid) || selectedTransferIds.has(transferId), downtime: DowntimeService.get(actor),
        rewardItems: details.items.map(item => ({ ...item, selected: selectedColumns.has(item.columnIndex) })),
        milestones: progress.milestones,
        passive: Number(progress.passiveDowntime?.[periodKey] ?? 0)
      });
    }
    const actorUuids = new Set(actors.map(actor => actor.uuid));
    const selectedActorUuids = new Set(actors.filter(actor => actor.selected).map(actor => actor.uuid));
    const players = game.users.filter(user => !user.isGM).map(user => {
      const owned = guildActors.filter(actor => actorUuids.has(actor.uuid) && (
        (user.character?.id ?? user.character) === actor.id
        || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
      ));
      return {
        id: user.id,
        name: user.name,
        active: user.active,
        actorUuids: owned.map(actor => actor.uuid).join(","),
        characters: owned.map(actor => actor.name).join(", "),
        selected: owned.length > 0 && owned.every(actor => selectedActorUuids.has(actor.uuid)),
        searchText: `${user.name} ${owned.map(actor => actor.name).join(" ")}`
      };
    }).filter(player => player.actorUuids);
    return {
      active,
      isPrimaryWorld: worldRole === WORLD_ROLES.PRIMARY,
      isSessionWorld: worldRole === WORLD_ROLES.SESSION,
      workflowStatus: game.i18n.localize(`DOWNTIME_MANAGER.Session.Workflow.Statuses.${workflowStatusKey}`),
      workflowReturned: active.status === "returned",
      workflowHasSession: Boolean(active.id),
      workflowCanExportSession: worldRole === WORLD_ROLES.PRIMARY && !["returned", "awarded"].includes(active.status),
      workflowCanImportResult: worldRole === WORLD_ROLES.PRIMARY,
      workflowCanImportSession: worldRole === WORLD_ROLES.SESSION,
      workflowCanExportResult: worldRole === WORLD_ROLES.SESSION && ["imported", "played"].includes(active.status),
      workflowCanCleanup: worldRole === WORLD_ROLES.SESSION && Boolean(active.id),
      canSaveSession: worldRole === WORLD_ROLES.PRIMARY && !["exported", "returned", "awarded"].includes(active.status),
      canAwardSession: worldRole === WORLD_ROLES.PRIMARY && !["exported", "awarded"].includes(active.status),
      canStartConcurrentSession: worldRole === WORLD_ROLES.PRIMARY && active.status === "exported",
      periodKey,
      passiveWeekly: passiveConfig.period === "week",
      historyEnabled: game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY_ENABLED),
      awarded: active.status === "awarded",
      actors,
      connectedPlayers: players.filter(player => player.active),
      otherPlayers: players.filter(player => !player.active),
      rewardColumns,
      awardMilestones: active.awardMilestones !== false,
      multipliers: [1, 1.5, 2].map(value => ({ value, selected: Number(active.multiplier ?? 1) === value }))
    };
  }

  static #folderPath(folder) {
    const names = [];
    for (let current = folder; current; current = current.folder) names.unshift(current.name);
    return names.join(" / ");
  }

  #syncPlayerSelection() {
    for (const input of this.element.querySelectorAll('[name="players"]')) {
      const uuids = String(input.dataset.actorUuids ?? "").split(",").filter(Boolean);
      input.checked = uuids.length > 0 && uuids.every(uuid => this.element.querySelector(`[name="actors"][value="${CSS.escape(uuid)}"]`)?.checked);
    }
  }

  #setVisibleSelection(checked) {
    const playerMode = this.element.querySelector('[name="selectionMode"]')?.value === "player";
    const inputs = this.element.querySelectorAll(playerMode ? '[name="players"]' : '[name="actors"]');
    for (const input of inputs) {
      if (input.closest("[data-actor-search-text]")?.hidden) continue;
      input.checked = checked;
      if (playerMode) {
        for (const uuid of String(input.dataset.actorUuids ?? "").split(",").filter(Boolean)) {
          const actorInput = this.element.querySelector(`[name="actors"][value="${CSS.escape(uuid)}"]`);
          if (actorInput) actorInput.checked = checked;
        }
      }
    }
    this.#syncPlayerSelection();
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
    const connected = game.users.filter(user => user.active && !user.isGM);
    const selected = new Set(game.actors.filter(actor => connected.some(user => (
      (user.character?.id ?? user.character) === actor.id
      || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
    ))).map(actor => actor.uuid));
    this.element.querySelectorAll('[name="actors"]').forEach(input => input.checked = selected.has(input.value));
    this.#syncPlayerSelection();
  }

  static #selectTokens(event) {
    event.preventDefault();
    const selected = new Set((canvas?.tokens?.controlled ?? []).map(token => token.actor?.uuid).filter(Boolean));
    this.element.querySelectorAll('[name="actors"]').forEach(input => input.checked = selected.has(input.value));
    this.#syncPlayerSelection();
  }

  static #selectAll(event) { event.preventDefault(); this.#setVisibleSelection(true); }
  static #selectNone(event) { event.preventDefault(); this.#setVisibleSelection(false); }

  static async #save(event) {
    event.preventDefault();
    const state = this.#formState();
    if (!state.actorUuids.length || !state.title) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Required"));
    const previous = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
    if (["exported", "returned"].includes(previous.status)) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Workflow.Locked"));
    if (previous.status === "awarded") return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.StartNew"));
    await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, { ...state, id: previous.id ?? foundry.utils.randomID(), startedAt: previous.startedAt ?? Date.now(), status: "draft" });
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Session.Saved"));
    await this.render({ force: true });
  }

  static async #workflowExportSession(event) {
    event.preventDefault();
    const state = this.#formState();
    if (!state.actorUuids.length || !state.title) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Required"));
    const previous = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
    const active = {
      ...previous,
      ...state,
      id: previous.id ?? foundry.utils.randomID(),
      startedAt: previous.startedAt ?? Date.now(),
      status: "draft"
    };
    await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, active);
    const actorIds = state.actorUuids.map(uuid => fromUuidSync(uuid)?.id).filter(Boolean);
    const bundle = await exportSession(actorIds, { session: active });
    if (!bundle) return;
    const participantTransferIds = new Set(bundle.session?.participantTransferIds ?? []);
    const participantUuids = game.actors
      .filter(actor => participantTransferIds.has(actor.getFlag(MODULE_ID, "transfer")?.id
        ?? `world:${game.world.id}:Actor:${actor.id}`))
      .map(actor => actor.uuid);
    await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, {
      ...active,
      actorUuids: participantUuids,
      participantTransferIds: [...participantTransferIds],
      status: "exported",
      exportedAt: Date.now()
    });
    await this.render({ force: true });
  }

  static async #workflowImportSession(event) {
    event.preventDefault();
    const file = this.element.querySelector('[name="workflowSessionFile"]')?.files?.[0];
    try {
      await importSession(file);
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Guided session import failed`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #workflowExportResult(event) {
    event.preventDefault();
    try {
      await exportSessionResult();
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Guided session result export failed`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #workflowImportResult(event) {
    event.preventDefault();
    const file = this.element.querySelector('[name="workflowResultFile"]')?.files?.[0];
    try {
      await importSessionResult(file);
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Guided session result import failed`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #workflowCleanup(event) {
    event.preventDefault();
    try {
      if (await cleanupSessionImport()) await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Session cleanup failed`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #workflowReset(event) {
    event.preventDefault();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Session.Workflow.NewSession") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.Session.Workflow.ResetConfirm")}</p>`
    });
    if (!confirmed) return;
    await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, {});
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Session.Workflow.ResetComplete"));
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
