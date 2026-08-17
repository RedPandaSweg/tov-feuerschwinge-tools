import { MODULE_ID } from "./constants.mjs";
import { GMToolsService } from "./gm-tools-service.mjs?v=3.2.7-flag-database-2";
import { openVoidTaintConfig } from "../void-taint/config-app.mjs";
import {
  addVoidTaint,
  drawVoidTaintEffect,
  setVoidTaint,
  voidTaintEnabled,
  voidTaintThreshold,
  voidTaintValue
} from "../void-taint/service.mjs";

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
      selectDatabaseDocument: GMToolsApp.#selectDatabaseDocument,
      selectFlag: GMToolsApp.#selectFlag,
      selectVisibleDocuments: GMToolsApp.#selectVisibleDocuments,
      clearDocumentSelection: GMToolsApp.#clearDocumentSelection,
      saveFlag: GMToolsApp.#saveFlag,
      deleteFlag: GMToolsApp.#deleteFlag,
      createFlag: GMToolsApp.#createFlag,
      exportFlags: GMToolsApp.#exportFlags,
      changeVoidTaint: GMToolsApp.#changeVoidTaint,
      setVoidTaint: GMToolsApp.#setVoidTaint,
      drawVoidEffect: GMToolsApp.#drawVoidEffect,
      openVoidTaintConfig: GMToolsApp.#openVoidTaintConfig,
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
    this.databaseType = "ActorPC";
    this.databaseQuery = "";
    this.databaseNamespace = "";
    this.databaseOnlyFlagged = true;
    this.databaseDocumentUuid = null;
    this.databaseFlagAddress = "";
    this.databaseSelectedUuids = new Set();
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
    const databaseType = this.element.querySelector("[data-database-type]");
    databaseType?.addEventListener("change", event => {
      this.databaseType = event.currentTarget.value;
      this.databaseDocumentUuid = null;
      this.databaseFlagAddress = "";
      this.databaseSelectedUuids.clear();
      this.render();
    });
    this.element.querySelector("[data-database-namespace]")?.addEventListener("change", event => {
      this.databaseNamespace = event.currentTarget.value;
      this.render();
    });
    this.element.querySelector("[data-database-only-flagged]")?.addEventListener("change", event => {
      this.databaseOnlyFlagged = event.currentTarget.checked;
      this.render();
    });
    this.element.querySelector("[data-database-query]")?.addEventListener("input", event => {
      this.databaseQuery = event.currentTarget.value;
      clearTimeout(this._databaseSearchTimer);
      this._databaseSearchTimer = setTimeout(() => this.render(), 250);
    });
    for (const checkbox of this.element.querySelectorAll("[data-database-document-check]")) {
      checkbox.addEventListener("change", event => {
        if (event.currentTarget.checked) this.databaseSelectedUuids.add(event.currentTarget.value);
        else this.databaseSelectedUuids.delete(event.currentTarget.value);
        const count = this.element.querySelector("[data-database-selection-count]");
        if (count) count.textContent = String(this.databaseSelectedUuids.size);
      });
    }
    this.element.querySelector("[data-flag-type]")?.addEventListener("change", event => {
      const editor = this.element.querySelector("[data-flag-value]");
      if (!editor) return;
      const type = event.currentTarget.value;
      if (type === "null") editor.value = "null";
      else if (type === "boolean" && !["true", "false"].includes(editor.value.trim())) editor.value = "false";
      else if (type === "object" && !editor.value.trim()) editor.value = "{}";
      else if (type === "array" && !editor.value.trim()) editor.value = "[]";
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
    let database = null;
    if (this.tab === "database") {
      const documents = GMToolsService.flagDocuments(this.databaseType, {
        query: this.databaseQuery,
        namespace: this.databaseNamespace,
        onlyFlagged: this.databaseOnlyFlagged
      });
      if (!this.databaseDocumentUuid || !documents.some(document => document.uuid === this.databaseDocumentUuid)) {
        this.databaseDocumentUuid = documents[0]?.uuid ?? null;
        this.databaseFlagAddress = "";
      }
      const detail = this.databaseDocumentUuid
        ? await GMToolsService.flagDocumentData(this.databaseDocumentUuid, this.databaseFlagAddress)
        : null;
      if (detail && this.databaseFlagAddress && !detail.selected) this.databaseFlagAddress = "";
      database = {
        types: GMToolsService.flagDocumentTypes().map(type => ({ ...type, selected: type.id === this.databaseType, label: game.i18n.localize(`DOWNTIME_MANAGER.GMTools.Database.Types.${type.id}`) })),
        namespaces: GMToolsService.flagNamespaces(this.databaseType).map(entry => ({ ...entry, selected: entry.id === this.databaseNamespace })),
        query: this.databaseQuery,
        namespace: this.databaseNamespace,
        onlyFlagged: this.databaseOnlyFlagged,
        documents: documents.map(document => ({ ...document, selected: document.uuid === this.databaseDocumentUuid, checked: this.databaseSelectedUuids.has(document.uuid) })),
        selectedCount: this.databaseSelectedUuids.size,
        detail: detail ? {
          uuid: detail.document.uuid,
          name: detail.document.name,
          documentName: detail.document.documentName,
          groups: detail.groups,
          selected: detail.selected ? {
            ...detail.selected,
            typeOptions: ["string", "number", "boolean", "null", "object", "array"].map(type => ({ value: type, label: type, selected: type === detail.selected.type }))
          } : null
        } : null
      };
    }
    const activeSession = GMToolsService.activeSession();
    const undo = GMToolsService.undoData();
    return {
      ...context,
      tab: this.tab,
      tabs: ["characters", "projects", "session", "voidTaint", "database", "diagnostics"].map(id => ({
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
      voidTaintEnabled: voidTaintEnabled(),
      voidTaint: this.tab === "voidTaint" ? game.actors.filter(actor => actor.type === "pc").map(actor => ({
        uuid: actor.uuid,
        name: actor.name,
        img: actor.img,
        value: voidTaintValue(actor),
        threshold: voidTaintThreshold(actor)
      })) : [],
      hasDiagnostics: diagnostics.length > 0,
      database,
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

  static async #chooseVoidEffect({ actor, value, threshold }) {
    return foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("TOVF.VoidTaint.Threshold.Title") },
      content: `<p>${game.i18n.format("TOVF.VoidTaint.Threshold.Message", {
        actor: foundry.utils.escapeHTML(actor.name), value, threshold
      })}</p>`,
      buttons: [
        { action: "dread", label: game.i18n.localize("TOVF.VoidTaint.Threshold.Dread"), icon: "fa-solid fa-brain", callback: () => "dread" },
        { action: "fleshWarp", label: game.i18n.localize("TOVF.VoidTaint.Threshold.FleshWarp"), icon: "fa-solid fa-dna", callback: () => "fleshWarp" }
      ],
      rejectClose: false
    });
  }

  static async #changeVoidTaint(event, target) {
    event.preventDefault();
    const actor = await fromUuid(target.dataset.uuid).catch(() => null);
    if (!actor) return;
    const amount = Number(target.dataset.amount) || 0;
    await this.#execute(async () => {
      if (amount < 0) await setVoidTaint(actor, Math.max(0, voidTaintValue(actor) + amount));
      else await addVoidTaint(actor, amount, { chooseEffect: data => GMToolsApp.#chooseVoidEffect(data) });
    });
  }

  static async #setVoidTaint(event, target) {
    event.preventDefault();
    const row = target.closest("[data-void-taint-row]");
    const actor = await fromUuid(target.dataset.uuid).catch(() => null);
    if (!actor || !row) return;
    const requested = Math.max(0, Math.floor(Number(row.querySelector('[name="voidTaint"]')?.value) || 0));
    const current = voidTaintValue(actor);
    await this.#execute(async () => {
      if (requested > current) {
        await addVoidTaint(actor, requested - current, { chooseEffect: data => GMToolsApp.#chooseVoidEffect(data) });
      } else await setVoidTaint(actor, requested);
    });
  }

  static async #drawVoidEffect(event, target) {
    event.preventDefault();
    await this.#execute(() => drawVoidTaintEffect(target.dataset.kind));
  }

  static #openVoidTaintConfig(event) {
    event.preventDefault();
    openVoidTaintConfig();
  }

  static #selectDatabaseDocument(event, target) {
    event.preventDefault();
    this.databaseDocumentUuid = target.dataset.uuid;
    this.databaseFlagAddress = "";
    this.render();
  }

  static #selectFlag(event, target) {
    event.preventDefault();
    this.databaseFlagAddress = target.dataset.address ?? "";
    this.render();
  }

  static #selectVisibleDocuments(event) {
    event.preventDefault();
    for (const checkbox of this.element.querySelectorAll("[data-database-document-check]")) {
      checkbox.checked = true;
      this.databaseSelectedUuids.add(checkbox.value);
    }
    const count = this.element.querySelector("[data-database-selection-count]");
    if (count) count.textContent = String(this.databaseSelectedUuids.size);
  }

  static #clearDocumentSelection(event) {
    event.preventDefault();
    this.databaseSelectedUuids.clear();
    for (const checkbox of this.element.querySelectorAll("[data-database-document-check]")) checkbox.checked = false;
    const count = this.element.querySelector("[data-database-selection-count]");
    if (count) count.textContent = "0";
  }

  #databaseTargets() {
    return this.databaseSelectedUuids.size ? [...this.databaseSelectedUuids] : [this.databaseDocumentUuid].filter(Boolean);
  }

  static async #saveFlag(event) {
    event.preventDefault();
    try {
      const editor = this.element.querySelector("[data-flag-editor]");
    if (!editor || !this.databaseFlagAddress) return;
    const [namespace, ...parts] = this.databaseFlagAddress.split(".");
    const path = parts.join(".");
    const type = editor.querySelector("[data-flag-type]")?.value;
    const rawValue = editor.querySelector("[data-flag-value]")?.value;
    const value = GMToolsService.parseFlagValue(type, rawValue);
    const targets = this.#databaseTargets();
    const current = await GMToolsService.flagDocumentData(this.databaseDocumentUuid, this.databaseFlagAddress);
    const confirmed = await this.#confirmFlagChange({
      title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Database.Save"),
      path: this.databaseFlagAddress,
      before: current.selected?.value ?? "—",
      after: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      count: targets.length
    });
    if (!confirmed) return;
    await this.#execute(() => GMToolsService.setFlags(targets, namespace, path, type, rawValue), "DOWNTIME_MANAGER.GMTools.Notifications.FlagsSaved");
    } catch (error) {
      this.#reportDatabaseError(error);
    }
  }

  static async #deleteFlag(event) {
    event.preventDefault();
    try {
      if (!this.databaseFlagAddress) return;
    const [namespace, ...parts] = this.databaseFlagAddress.split(".");
    const path = parts.join(".");
    const targets = this.#databaseTargets();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Database.Delete") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.GMTools.Database.DeleteConfirm", { path: foundry.utils.escapeHTML(this.databaseFlagAddress), count: targets.length })}</p>`
    });
    if (!confirmed) return;
    this.databaseFlagAddress = "";
    await this.#execute(() => GMToolsService.deleteFlags(targets, namespace, path), "DOWNTIME_MANAGER.GMTools.Notifications.FlagsDeleted");
    } catch (error) {
      this.#reportDatabaseError(error);
    }
  }

  static async #createFlag(event) {
    event.preventDefault();
    try {
      const root = this.element.querySelector("[data-create-flag]");
    if (!root) return;
    const namespace = root.querySelector('[name="namespace"]')?.value;
    const path = root.querySelector('[name="path"]')?.value;
    const type = root.querySelector('[name="type"]')?.value;
    const rawValue = root.querySelector('[name="value"]')?.value;
    const targets = this.#databaseTargets();
    if (!String(path ?? "").trim()) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidFlagPath"));
    GMToolsService.parseFlagValue(type, rawValue);
    const confirmed = await this.#confirmFlagChange({
      title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Database.Create"),
      path: `${namespace}.${path}`,
      before: "—",
      after: rawValue,
      count: targets.length
    });
    if (!confirmed) return;
    this.databaseFlagAddress = `${namespace}.${path}`;
    await this.#execute(() => GMToolsService.setFlags(targets, namespace, path, type, rawValue), "DOWNTIME_MANAGER.GMTools.Notifications.FlagsSaved");
    } catch (error) {
      this.#reportDatabaseError(error);
    }
  }

  static async #exportFlags(event) {
    event.preventDefault();
    try {
      const targets = this.#databaseTargets();
    if (!targets.length) return;
    const payload = await GMToolsService.exportFlags(targets);
    foundry.utils.saveDataToFile(JSON.stringify(payload, null, 2), "application/json", `feuerschwinge-flags-${new Date().toISOString().slice(0, 10)}.json`);
    } catch (error) {
      this.#reportDatabaseError(error);
    }
  }

  #reportDatabaseError(error) {
    console.error(`${MODULE_ID} | Flag database operation failed`, error);
    ui.notifications.error(error.message);
  }

  async #confirmFlagChange({ title, path, before, after, count }) {
    const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
    return foundry.applications.api.DialogV2.confirm({
      window: { title },
      position: { width: 720 },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.GMTools.Database.ChangeTargets", { count })}</p><p><code>${escape(path)}</code></p>
        <div class="tovf-gm-flag-diff"><div><strong>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Before")}</strong><pre>${escape(before)}</pre></div><div><strong>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.After")}</strong><pre>${escape(after)}</pre></div></div>`
    });
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
