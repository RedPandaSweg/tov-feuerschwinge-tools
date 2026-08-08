import { MODULE_ID } from "./constants.mjs";
import { GMToolsService } from "./gm-tools-service.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class GMToolsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-gm-tools",
    classes: ["downtime-manager", "tovf-gm-tools"],
    position: { width: 980, height: 760 },
    window: { title: "DOWNTIME_MANAGER.GMTools.Title", resizable: true },
    actions: {
      selectTab: GMToolsApp.#selectTab,
      saveCharacter: GMToolsApp.#saveCharacter,
      saveProject: GMToolsApp.#saveProject,
      removeProject: GMToolsApp.#removeProject,
      unlockSession: GMToolsApp.#unlockSession,
      resetSession: GMToolsApp.#resetSession,
      repairSafe: GMToolsApp.#repairSafe,
      undo: GMToolsApp.#undo,
      exportCharacter: GMToolsApp.#exportCharacter,
      openDocument: GMToolsApp.#openDocument,
      refresh: GMToolsApp.#refresh
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/gm-tools.hbs" }
  };

  constructor(options = {}) {
    super(options);
    this.tab = "characters";
    this.actorUuid = null;
    this._updateHook = Hooks.on("updateActor", actor => {
      if (this.rendered && (!this.actorUuid || actor.uuid === this.actorUuid)) this.render();
    });
  }

  async close(options = {}) {
    if (this._updateHook) Hooks.off("updateActor", this._updateHook);
    return super.close(options);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelectorAll("select[data-character-select]").forEach(select => {
      select.addEventListener("change", event => {
        this.actorUuid = String(event.currentTarget.value ?? "");
        this.render();
      });
    });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const actors = GMToolsService.characters();
    if (!this.actorUuid || !actors.some(actor => actor.uuid === this.actorUuid)) {
      this.actorUuid = actors[0]?.uuid ?? null;
    }
    const selected = this.actorUuid ? await GMToolsService.characterData(this.actorUuid) : null;
    const diagnostics = this.tab === "diagnostics" ? await GMToolsService.diagnostics() : [];
    const activeSession = GMToolsService.activeSession();
    const undo = GMToolsService.undoData();
    return {
      ...context,
      tab: this.tab,
      tabs: ["characters", "projects", "session", "diagnostics"].map(id => ({
        id,
        active: this.tab === id,
        label: game.i18n.localize(`DOWNTIME_MANAGER.GMTools.Tabs.${id}`)
      })),
      actors: actors.map(actor => ({ uuid: actor.uuid, name: actor.name, img: actor.img, selected: actor.uuid === this.actorUuid })),
      selected: selected ? {
        uuid: selected.actor.uuid,
        name: selected.actor.name,
        img: selected.actor.img,
        downtime: selected.downtime,
        milestones: selected.progress.milestones,
        sessionsPlayed: selected.progress.sessionsPlayed,
        lastMilestoneWeek: selected.progress.lastMilestoneWeek ?? "",
        passiveDowntime: JSON.stringify(selected.progress.passiveDowntime ?? {}, null, 2),
        projects: selected.projects.map(state => ({
          ...state,
          projectUuid: state.projectUuid ?? state.recipeUuid ?? "",
          progress: Number(state.progress ?? 0),
          requiredProgress: Number(state.requiredProgress ?? 0),
          intervalProgress: Number(state.intervalProgress ?? 0),
          activeChecked: state.active !== false,
          completedChecked: state.completed === true,
          pendingRollChecked: state.pendingRoll === true,
          awaitingCompletionCheckChecked: state.awaitingCompletionCheck === true
        }))
      } : null,
      activeSession: {
        ...activeSession,
        empty: !Object.keys(activeSession).length,
        json: JSON.stringify(activeSession, null, 2)
      },
      diagnostics,
      hasDiagnostics: diagnostics.length > 0,
      undo: undo.kind ? {
        available: true,
        date: new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(undo.timestamp))
      } : { available: false }
    };
  }

  static #selectTab(event, target) {
    event.preventDefault();
    this.tab = String(target.dataset.tab ?? "characters");
    this.render();
  }

  static async #saveCharacter(event) {
    event.preventDefault();
    const root = this.element.querySelector("[data-character-editor]");
    if (!root || !this.actorUuid) return;
    const current = await GMToolsService.characterData(this.actorUuid);
    const values = {
      downtime: root.querySelector('[name="downtime"]')?.value,
      milestones: root.querySelector('[name="milestones"]')?.value,
      sessionsPlayed: root.querySelector('[name="sessionsPlayed"]')?.value,
      lastMilestoneWeek: root.querySelector('[name="lastMilestoneWeek"]')?.value,
      passiveDowntime: root.querySelector('[name="passiveDowntime"]')?.value
    };
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.ConfirmChange") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.ConfirmChangeHint")}</p>
        <table><tr><th></th><th>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Before")}</th><th>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.After")}</th></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Downtime")}</td><td>${current.downtime}</td><td>${foundry.utils.escapeHTML(String(values.downtime))}</td></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Milestones")}</td><td>${current.progress.milestones}</td><td>${foundry.utils.escapeHTML(String(values.milestones))}</td></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.SessionsPlayed")}</td><td>${current.progress.sessionsPlayed}</td><td>${foundry.utils.escapeHTML(String(values.sessionsPlayed))}</td></tr></table>`
    });
    if (!confirmed) return;
    await this.#execute(
      () => GMToolsService.updateCharacter(this.actorUuid, values),
      "DOWNTIME_MANAGER.GMTools.Notifications.CharacterSaved"
    );
  }

  static async #saveProject(event, target) {
    event.preventDefault();
    const row = target.closest("[data-project-row]");
    if (!row || !this.actorUuid) return;
    const values = {
      progress: row.querySelector('[name="progress"]')?.value,
      requiredProgress: row.querySelector('[name="requiredProgress"]')?.value,
      intervalProgress: row.querySelector('[name="intervalProgress"]')?.value,
      active: row.querySelector('[name="active"]')?.checked,
      completed: row.querySelector('[name="completed"]')?.checked,
      pendingRoll: row.querySelector('[name="pendingRoll"]')?.checked,
      awaitingCompletionCheck: row.querySelector('[name="awaitingCompletionCheck"]')?.checked
    };
    const current = (await GMToolsService.characterData(this.actorUuid)).projects.find(state => String(state.id ?? "") === String(target.dataset.stateId ?? ""));
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.ConfirmChange") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.ConfirmChangeHint")}</p>
        <table><tr><th></th><th>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Before")}</th><th>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.After")}</th></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Progress")}</td><td>${Number(current?.progress ?? 0)}</td><td>${foundry.utils.escapeHTML(String(values.progress))}</td></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.RequiredProgress")}</td><td>${Number(current?.requiredProgress ?? 0)}</td><td>${foundry.utils.escapeHTML(String(values.requiredProgress))}</td></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.IntervalProgress")}</td><td>${Number(current?.intervalProgress ?? 0)}</td><td>${foundry.utils.escapeHTML(String(values.intervalProgress))}</td></tr></table>`
    });
    if (!confirmed) return;
    await this.#execute(
      () => GMToolsService.updateProject(this.actorUuid, target.dataset.stateId, values),
      "DOWNTIME_MANAGER.GMTools.Notifications.ProjectSaved"
    );
  }

  static async #removeProject(event, target) {
    event.preventDefault();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.RemoveProject") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.RemoveProjectConfirm")}</p>`
    });
    if (!confirmed) return;
    await this.#execute(
      () => GMToolsService.removeProject(this.actorUuid, target.dataset.stateId),
      "DOWNTIME_MANAGER.GMTools.Notifications.ProjectRemoved"
    );
  }

  static async #unlockSession(event) {
    event.preventDefault();
    await this.#execute(() => GMToolsService.unlockSession(), "DOWNTIME_MANAGER.GMTools.Notifications.SessionUnlocked");
  }

  static async #resetSession(event) {
    event.preventDefault();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.ResetSession") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.ResetSessionConfirm")}</p>`
    });
    if (!confirmed) return;
    await this.#execute(() => GMToolsService.resetSession(), "DOWNTIME_MANAGER.GMTools.Notifications.SessionReset");
  }

  static async #repairSafe(event) {
    event.preventDefault();
    await this.#execute(async () => {
      const count = await GMToolsService.repairSafeProblems();
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.GMTools.Notifications.Repaired", { count }));
    });
  }

  static async #undo(event) {
    event.preventDefault();
    await this.#execute(async () => {
      const changed = await GMToolsService.undo();
      ui.notifications[changed ? "info" : "warn"](game.i18n.localize(changed
        ? "DOWNTIME_MANAGER.GMTools.Notifications.Undone"
        : "DOWNTIME_MANAGER.GMTools.Notifications.NothingToUndo"));
    });
  }

  static async #exportCharacter(event) {
    event.preventDefault();
    if (!this.actorUuid) return;
    const data = await GMToolsService.characterData(this.actorUuid);
    const payload = {
      module: MODULE_ID,
      exportedAt: new Date().toISOString(),
      actor: { uuid: data.actor.uuid, name: data.actor.name },
      downtime: data.downtime,
      sessionProgress: data.progress,
      projects: data.projects
    };
    const filename = `feuerschwinge-${data.actor.name.slugify({ strict: true }) || "character"}-backup.json`;
    foundry.utils.saveDataToFile(JSON.stringify(payload, null, 2), "application/json", filename);
  }

  static async #openDocument(event, target) {
    event.preventDefault();
    const document = await fromUuid(target.dataset.uuid).catch(() => null);
    document?.sheet?.render(true);
  }

  static #refresh(event) {
    event?.preventDefault();
    this.render();
  }

  async #execute(operation, successKey = null) {
    try {
      await operation();
      if (successKey) ui.notifications.info(game.i18n.localize(successKey));
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | GM tools operation failed`, error);
      ui.notifications.error(error.message);
    }
  }
}
