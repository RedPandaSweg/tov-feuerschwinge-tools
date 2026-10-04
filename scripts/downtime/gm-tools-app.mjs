import { uiText } from "../core/localization.mjs";
import { isOperationalGM, isProjectAdministrator } from "../core/permissions.mjs?v=3.7.8-permissions-1";
import { startupReport } from "../core/startup.mjs?v=3.7.8-lifecycle-phases-1";
import { compatibilityReport } from "../integrations/compatibility-layer.mjs?v=3.7.8-argon-module-check-2";
import { schedulerReport } from "../core/scheduler.mjs?v=3.7.8-central-scheduler-1";
import { FLAGS, MODULE_ID } from "./constants.mjs";
import { DowntimeDashboardApp } from "./dashboard-app.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { evidenceKey, milestoneEvidence } from "../campaign/milestone-evidence.mjs";
import { GMToolsService } from "./gm-tools-service.mjs?v=3.8.0-unresolved-advancement-formulas-1";
import { isActiveCharacter, milestoneEntries, actorLevel, highestMilestoneProgress, isoWeekKey, levelFromMilestones, monthKey, passiveDowntimeConfig, SessionService, sessionProgress, tierOfPlay } from "./session-service.mjs";
import { openVoidTaintConfig } from "../void-taint/config-app.mjs";
import { applyActorSpellMigration, previewActorSpellMigration } from "../spell-actor-migration.mjs?v=3.5.0-actor-spell-migration-10";
import { applyWorkingEffectMigration, previewWorkingEffectMigration } from "../effect-pack-migration.mjs?v=3.7.8-working-effects-2";
import { migrateLegacyWorldActiveEffects, previewLegacyActiveEffects } from "../core/active-effect-migration.mjs?v=3.8.0-legacy-effect-repair-1";
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
    position: { width: 980, height: "auto" },
    window: { title: "DOWNTIME_MANAGER.GMTools.Title", resizable: true },
    actions: {
      openStation: DowntimeDashboardApp.openStation,
      openProjectLibrary: DowntimeDashboardApp.openProjectLibrary,
      openStationPresets: DowntimeDashboardApp.openStationPresets,
      openSessions: DowntimeDashboardApp.openSessions,
      removeDashboardProject: DowntimeDashboardApp.removeProject,
      grantSelectedDowntime: DowntimeDashboardApp.grantSelectedDowntime,
      grantAllDowntime: DowntimeDashboardApp.grantAllDowntime,
      toggleInactiveDowntime: DowntimeDashboardApp.toggleInactiveDowntime,
      saveDowntime: GMToolsApp.#saveDowntime,
      addMilestoneRow: GMToolsApp.#addMilestoneRow,
      removeMilestoneRow: GMToolsApp.#removeMilestoneRow,
      moveMilestoneRow: GMToolsApp.#moveMilestoneRow,
      selectTab: GMToolsApp.#selectTab,
      saveCharacter: GMToolsApp.#saveCharacter,
      saveActivity: GMToolsApp.#saveActivity,
      settlePassiveDowntime: GMToolsApp.#settlePassiveDowntime,
      correctHistoricalSession: GMToolsApp.#correctHistoricalSession,
      saveProject: GMToolsApp.#saveProject,
      removeProject: GMToolsApp.#removeProject,
      unlockSession: GMToolsApp.#unlockSession,
      resetSession: GMToolsApp.#resetSession,
      repairSafe: GMToolsApp.#repairSafe,
      deleteExpiredEffects: GMToolsApp.#deleteExpiredEffects,
      migrateWorkingEffects: GMToolsApp.#migrateWorkingEffects,
      migrateLegacyActiveEffects: GMToolsApp.#migrateLegacyActiveEffects,
      repairLegacyActiveEffect: GMToolsApp.#repairLegacyActiveEffect,
      migrateActorSpells: GMToolsApp.#migrateActorSpells,
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
    this.effectCleanupResult = null;
    this.effectPackMigrationResult = null;
    this.legacyActiveEffectResult = null;
    this._milestoneAuditInitialized = false;
    this._updateHook = Hooks.on("updateActor", actor => {
      if (this.rendered && (["projects", "downtime"].includes(this.tab) || !this.actorUuid || actor.uuid === this.actorUuid)) this.render();
    });
  }

  async close(options = {}) {
    if (this._updateHook) Hooks.off("updateActor", this._updateHook);
    return super.close(options);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const actor = game.actors.find(a => a.uuid === this.actorUuid);
    this._milestoneSignature = actor ? JSON.stringify(milestoneEntries(actor)) : "";
    this._milestoneEvidence = actor ? milestoneEvidence(actor.uuid) : [];
    this._downtimeSignature = actor ? JSON.stringify({ downtime: DowntimeService.get(actor), passiveDowntime: sessionProgress(actor).passiveDowntime ?? {} }) : "";
    this.element.classList.toggle("tovf-gm-character-view", this.tab === "characters");
    this.#numberMilestones();
    if (!this._milestoneAuditInitialized) {
      const audit = this.element.querySelector(".tovf-gm-milestone-audit");
      if (audit) {
        audit.open = false;
        this._milestoneAuditInitialized = true;
      }
    }
    if (this.element?.isConnected && this.element.parentElement) {
      this.setPosition({ height: this.tab === "characters" ? "auto" : 760 });
    }
    this.element.querySelector(".tovf-gm-milestone-audit")?.addEventListener("toggle", () => {
      if (this.tab === "characters" && this.element?.isConnected && this.element.parentElement) this.setPosition({ height: "auto" });
    });
    this.element.querySelectorAll("select[data-character-select]").forEach(select => {
      select.addEventListener("change", event => {
        this.actorUuid = String(event.currentTarget.value ?? "");
        this.render();
      });
    });
    const activitySort = this.element.querySelector("[data-activity-sort]");
    const activityLogin = this.element.querySelector("[data-activity-login]");
    const updateActivityTable = () => {
      const sort = activitySort?.value ?? "session";
      const login = activityLogin?.value ?? "all";
      for (const body of this.element.querySelectorAll("[data-activity-body]")) {
        const rows = [...body.querySelectorAll("[data-activity-row]")];
        for (const row of rows) row.hidden = login !== "all" && row.dataset.loginGroup !== login;
        rows.sort((left, right) => {
          if (sort === "name") return left.dataset.name.localeCompare(right.dataset.name, game.i18n.lang);
          const key = sort === "login" ? "loginAt" : "sessionAt";
          return Number(right.dataset[key]) - Number(left.dataset[key]) || left.dataset.name.localeCompare(right.dataset.name, game.i18n.lang);
        });
        for (const row of rows) body.append(row);
      }
    };
    activitySort?.addEventListener("change", updateActivityTable);
    activityLogin?.addEventListener("change", updateActivityTable);
    updateActivityTable();
    const sessionSearch = this.element.querySelector("[data-session-history-search]");
    sessionSearch?.addEventListener("input", event => {
      const query = event.currentTarget.value.trim().toLocaleLowerCase();
      for (const row of this.element.querySelectorAll("[data-session-history-row]")) row.hidden = Boolean(query) && !row.dataset.search.includes(query);
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
    const legacyEffectFormulas = this.tab === "diagnostics" ? GMToolsService.legacyEffectFormulaSummary() : null;
    const expiredTemporaryEffects = this.tab === "diagnostics" ? GMToolsService.expiredTemporaryEffectSummary() : null;
    const effectCleanup = expiredTemporaryEffects ? {
      ...expiredTemporaryEffects,
      title: uiText("TOVF.EffectCleanup.Title", "Abgelaufene temporäre Effects"),
      summary: uiText("TOVF.EffectCleanup.Summary", "{count} eindeutig abgelaufene temporäre Active Effects auf {actors} Actors gefunden.", expiredTemporaryEffects),
      scope: uiText("TOVF.EffectCleanup.Scope", "Gelöscht werden nur Effects, die direkt auf einem Actor liegen, eine temporäre Dauer besitzen und von Foundry bereits als abgelaufen markiert wurden. Aktive, lediglich deaktivierte, dauerhafte und in Items eingebettete Effects bleiben erhalten."),
      action: uiText("TOVF.EffectCleanup.Action", "Abgelaufene Effects löschen"),
      result: this.effectCleanupResult
    } : null;
    const effectPackMigration = this.tab === "diagnostics" ? {
      available: isProjectAdministrator() && game.packs.has("world.funktioniere-effekte"),
      result: this.effectPackMigrationResult
    } : null;
    let legacyActiveEffects = null;
    if (this.tab === "diagnostics") {
      const available = isOperationalGM();
      const entries = available ? await previewLegacyActiveEffects() : [];
      const sources = new Map();
      for (const entry of entries) {
        const current = sources.get(entry.sourceKey) ?? { label: entry.sourceLabel, count: 0, repairable: entry.repairable };
        current.count += 1;
        sources.set(entry.sourceKey, current);
      }
      legacyActiveEffects = {
        available,
        count: entries.length,
        repairable: entries.filter(entry => entry.repairable).length,
        readOnly: entries.filter(entry => !entry.repairable).length,
        sources: Array.from(sources.values()).sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
        result: this.legacyActiveEffectResult
      };
    }
    let technicalDiagnostics = null;
    if (this.tab === "diagnostics") {
      const statusEntry = entry => ({
        ...entry,
        statusClass: ["failed", "incompatible"].includes(entry.status) ? "error"
          : ["pending", "inactive", "skipped"].includes(entry.status) ? "warning" : "ok",
        detail: entry.error?.message ?? entry.reason ?? "",
        duration: Number.isFinite(entry.durationMs) ? `${entry.durationMs} ms` : ""
      });
      const scheduler = schedulerReport();
      const startup = startupReport().map(statusEntry);
      const compatibility = compatibilityReport().integrations.map(statusEntry);
      const formatTechnicalDate = timestamp => timestamp
        ? new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp))
        : game.i18n.localize("DOWNTIME_MANAGER.GMTools.Activity.Unknown");
      technicalDiagnostics = {
        startup,
        startupSummary: `${startup.filter(entry => entry.status === "completed").length}/${startup.length}`,
        startupClass: startup.some(entry => entry.statusClass === "error") ? "error" : startup.some(entry => entry.statusClass === "warning") ? "warning" : "ok",
        compatibility,
        compatibilitySummary: `${compatibility.filter(entry => ["completed", "inactive", "already-installed"].includes(entry.status)).length}/${compatibility.length}`,
        compatibilityClass: compatibility.some(entry => entry.statusClass === "error") ? "error" : compatibility.some(entry => entry.statusClass === "warning") ? "warning" : "ok",
        scheduler: {
          active: scheduler.active,
          statusClass: scheduler.tasks.some(task => task.lastError) ? "error" : scheduler.active ? "ok" : "warning",
          responsibleGM: game.users.get(scheduler.responsibleGM)?.name ?? game.i18n.localize("DOWNTIME_MANAGER.Common.None"),
          tasks: scheduler.tasks.map(task => ({ ...task,
            statusClass: task.lastError ? "error" : task.running ? "warning" : "ok",
            lastRun: formatTechnicalDate(task.lastFinishedAt),
            nextRun: formatTechnicalDate(task.nextCheckAt),
            error: task.lastError?.message ?? ""
          }))
        }
      };
    }
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
    const sessionHistory = SessionService.historyEntries();
    const formatDate = timestamp => timestamp
      ? new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp))
      : game.i18n.localize("DOWNTIME_MANAGER.GMTools.Activity.Unknown");
    const relativeLogin = timestamp => {
      if (!timestamp) return { label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Activity.Unknown"), group: "unknown" };
      const weeks = Math.floor(Math.max(0, Date.now() - timestamp) / 604800000);
      return weeks < 1
        ? { label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Activity.WithinWeek"), group: "recent" }
        : { label: weeks === 1 ? game.i18n.localize("DOWNTIME_MANAGER.GMTools.Activity.OverOneWeek")
          : game.i18n.format("DOWNTIME_MANAGER.GMTools.Activity.OverWeeks", { weeks }), group: "older" };
    };
    const activityActors = actors.map(actor => {
      const lastSession = sessionHistory.filter(record => (record.participants ?? []).some(participant => participant.actorUuid === actor.uuid))
        .sort((left, right) => Number(right.awardedAt ?? right.correctedAt ?? 0) - Number(left.awardedAt ?? left.correctedAt ?? 0))[0];
      const owners = game.users.filter(user => !user.isGM && ((user.character?.id ?? user.character) === actor.id
        || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)));
      const lastLoginAt = Math.max(0, ...owners.map(user => Number(user.getFlag(MODULE_ID, FLAGS.LAST_LOGIN_AT)) || 0));
      const sessionAt = Number(lastSession?.awardedAt ?? lastSession?.correctedAt) || 0;
      const login = relativeLogin(lastLoginAt);
      return { uuid: actor.uuid, name: actor.name, img: actor.img, active: isActiveCharacter(actor),
        sortName: actor.name.toLocaleLowerCase(game.i18n.lang), sessionAt, lastLoginAt, loginGroup: login.group,
        lastSessionTitle: lastSession?.title || game.i18n.localize("DOWNTIME_MANAGER.GMTools.Activity.Never"),
        lastSessionDate: sessionAt ? formatDate(sessionAt) : "", lastLogin: login.label };
    });
    activityActors.sort((left, right) => right.sessionAt - left.sessionAt || left.name.localeCompare(right.name, game.i18n.lang));
    const highestProgress = highestMilestoneProgress();
    let guildOverview = null;
    if (this.tab === "guild") {
      const activeActors = actors.filter(isActiveCharacter);
      const levels = activeActors.map(actorLevel).sort((a, b) => a - b);
      const downtime = activeActors.map(actor => Number(DowntimeService.get(actor)) || 0).sort((a, b) => a - b);
      const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      const median = values => values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.ceil((values.length - 1) / 2)]) / 2 : 0;
      const bars = entries => {
        const maximum = Math.max(1, ...entries.map(entry => entry.count));
        return entries.map(entry => ({ ...entry, percent: Math.round(entry.count / maximum * 100) }));
      };
      const tierCounts = [1, 2, 3, 4].map(tier => ({ label: `Tier ${tier}`, count: levels.filter(level => tierOfPlay(level) === tier).length }));
      const classCounts = new Map();
      for (const actor of activeActors) {
        const progression = Object.values(actor.system?.progression?.classes ?? {});
        const names = progression.length ? progression.map(entry => entry.document?.name ?? entry.name).filter(Boolean)
          : actor.items.filter(item => item.type === "class").map(item => item.name);
        for (const name of new Set(names)) classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
      }
      const activeUuids = new Set(activeActors.map(actor => actor.uuid));
      const weeks = Array.from({ length: 8 }, (_entry, index) => {
        const date = new Date(); date.setDate(date.getDate() - (7 - index) * 7);
        const key = isoWeekKey(date);
        const records = sessionHistory.filter(record => record.week === key);
        return { label: key.replace("-W", " · KW "), count: records.reduce((sum, record) => sum + (record.participants ?? []).filter(participant => activeUuids.has(participant.actorUuid)).length, 0), sessions: records.length };
      });
      guildOverview = {
        activeCount: activeActors.length, inactiveCount: actors.length - activeActors.length,
        averageLevel: average(levels).toFixed(1), medianLevel: median(levels).toFixed(1),
        averageDowntime: average(downtime).toFixed(1), medianDowntime: median(downtime).toFixed(1),
        highestLevel: highestProgress.level, highestTier: highestProgress.tier,
        highestCharacterName: highestProgress.leaders[0]?.actor.name ?? "",
        highestCharacterImg: highestProgress.leaders[0]?.actor.img ?? "icons/svg/mystery-man.svg",
        tierBars: bars(tierCounts), classBars: bars([...classCounts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, game.i18n.lang))),
        sessionBars: bars(weeks)
      };
    }
    const milestoneMismatches = actors.map(actor => {
      const milestones = Math.max(0, Math.floor(Number(sessionProgress(actor).milestones) || 0));
      const actualLevel = actorLevel(actor);
      const expectedLevel = levelFromMilestones(milestones);
      return { uuid: actor.uuid, name: actor.name, img: actor.img, milestones, actualLevel, expectedLevel };
    }).filter(entry => entry.actualLevel !== entry.expectedLevel);
    const undo = GMToolsService.undoData();
    const undoTab = undo.tab ?? (undo.kind === "flags" ? "database" : undo.kind === "setting" ? "session" : undo.before?.projects ? "projects" : "diagnostics");
    return {
      ...context,
      tab: this.tab,
      dashboard: ["projects", "downtime"].includes(this.tab) ? await DowntimeDashboardApp.prototype._prepareContext.call(this) : null,
      tabs: ["characters", "activity", "projects", "downtime", "guild", "session", "voidTaint", "database", "diagnostics"].map(id => ({
        id,
        active: this.tab === id,
        label: id === "characters" ? uiText("TOVF.Interface.Milestones_a38757", "Meilensteine") : id === "projects" ? uiText("TOVF.Interface.ProjectOverview_b340e1", "Projektübersicht") : id === "downtime" ? "Downtime" : game.i18n.localize(`DOWNTIME_MANAGER.GMTools.Tabs.${id}`)
      })),
      actors: actors.map(actor => ({ uuid: actor.uuid, name: actor.name, img: actor.img, selected: actor.uuid === this.actorUuid })),
      guildOverview,
      selected: selected ? {
        uuid: selected.actor.uuid,
        name: selected.actor.name,
        img: selected.actor.img,
        downtime: selected.downtime,
        milestones: selected.progress.milestones,
        milestoneLevel: levelFromMilestones(selected.progress.milestones),
        milestoneEntries: milestoneEntries(selected.actor).map((entry, index) => ({ ...entry, evidenceKey: evidenceKey(entry), number: index + 1, originalIndex: index })),
        sessionsPlayed: selected.progress.sessionsPlayed,
        lastMilestoneWeek: selected.progress.lastMilestoneWeek ?? "",
        passiveDowntime: JSON.stringify(selected.progress.passiveDowntime ?? {}, null, 2),
        active: isActiveCharacter(selected.actor),
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
      sessionHistory: sessionHistory.slice().reverse().map(record => ({
        id: String(record.id ?? ""), title: record.title || game.i18n.localize("DOWNTIME_MANAGER.Session.Untitled"),
        date: formatDate(record.awardedAt ?? record.correctedAt), gmName: game.users.get(record.gmUserId)?.name ?? game.i18n.localize("DOWNTIME_MANAGER.Common.None"),
        participantCount: record.participants?.length ?? 0, passiveCount: (record.passiveRecipients ?? []).filter(entry => Number(entry.awarded) > 0).length,
        corrected: Boolean(record.correctedAt),
        search: `${record.title ?? ""} ${game.users.get(record.gmUserId)?.name ?? ""} ${(record.participants ?? []).map(entry => entry.actorName).join(" ")}`.toLocaleLowerCase()
      })),
      activityActiveActors: activityActors.filter(actor => actor.active),
      activityInactiveActors: activityActors.filter(actor => !actor.active),
      settlement: {
        period: passiveDowntimeConfig().period,
        periodKey: passiveDowntimeConfig().period === "week" ? isoWeekKey() : monthKey()
      },
      canSettlePassiveDowntime: game.settings.get(MODULE_ID, "worldRole") === "primary"
        && isProjectAdministrator(),
      highestProgress: {
        ...highestProgress,
        names: highestProgress.leaders.map(entry => entry.actor.name).join(", ") || game.i18n.localize("DOWNTIME_MANAGER.Common.None")
      },
      milestoneMismatches,
      diagnostics,
      legacyEffectFormulas,
      expiredTemporaryEffects,
      effectCleanup,
      effectPackMigration,
      legacyActiveEffects,
      technicalDiagnostics,
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
      undo: undo.kind && undoTab === this.tab ? {
        available: true,
        subject: undo.actorUuid ? `Letzte Korrektur: ${game.actors.find(a => a.uuid === undo.actorUuid)?.name ?? uiText("TOVF.Interface.Character_19365b", "Charakter")}` : uiText("TOVF.Interface.LastCorrectionInThisSection_2d30bd", "Letzte Korrektur in diesem Bereich"),
        date: new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(undo.timestamp))
      } : { available: false }
    };
  }

  static #selectTab(event, target) {
    event.preventDefault();
    this.tab = String(target.dataset.tab ?? "characters");
    this.render();
  }

  static #addMilestoneRow(event) {
    event.preventDefault();
    const template = this.element.querySelector('template[data-milestone-template]');
    const list = this.element.querySelector('[data-milestone-changes]');
    list.append(template.content.cloneNode(true));
    this.#numberMilestones();
    list.lastElementChild.querySelector('select')?.focus();
  }

  #bindMilestoneEvidence() {
    for (const row of this.element.querySelectorAll('[data-milestone-row]')) {
      const select = row.querySelector('[name="milestoneEvidence"]');
      if (!select || select.dataset.bound) continue;
      select.dataset.bound = "true";
      const source = row.querySelector('[name="milestoneSource"]');
      const fill = key => {
        select.replaceChildren(new Option(uiText("TOVF.Interface.NoLinkExistingNote_80f15c", "Ohne Verknüpfung / bestehende Notiz"), ""));
        const options = (this._milestoneEvidence ?? []).filter(c => c.source === source.value);
        for (const c of options) select.add(new Option(c.label, c.key));
        const match = options.find(c => c.key === key || c.aliases?.includes(key));
        if (key && !match) select.add(new Option(uiText("TOVF.Interface.ExistingEvidenceSourceDataMissing_c62a03", "Bestehender Nachweis (Quelldaten fehlen)"), key));
        select.value = match?.key ?? key ?? "";
      };
      fill(select.dataset.evidenceKey);
      source.addEventListener("change", () => { fill(""); this.#refreshEvidenceUsage(); });
      select.addEventListener("change", () => {
        const match = this._milestoneEvidence.find(c => c.key === select.value);
        if (match) {
          const note = row.querySelector('[name="milestoneNote"]');
          if (!note.value) note.value = match.fields.note;
          row.querySelector('[name="milestoneWeek"]').value = match.fields.week || "";
        }
        this.#refreshEvidenceUsage();
      });
    }
  }

  #refreshEvidenceUsage() {
    const selects = [...this.element.querySelectorAll('[data-milestone-row] [name="milestoneEvidence"]')];
    for (const select of selects) for (const option of select.options) {
      const evidence = this._milestoneEvidence?.find(c => c.key === option.value);
      if (!evidence) continue;
      const used = selects.filter(other => other !== select && other.value === option.value).length;
      option.disabled = used >= evidence.capacity && select.value !== option.value;
      option.textContent = evidence.label + (option.disabled ? uiText("TOVF.Interface.AlreadyAssigned_085eed", " · bereits zugeordnet") : "");
    }
  }

  #numberMilestones() {
    this.#bindMilestoneEvidence();
    this.#refreshEvidenceUsage();
    const rows = Array.from(this.element.querySelectorAll('[data-milestone-row]'));
    rows.forEach((row, index) => {
      row.querySelector('[data-milestone-number]').textContent = String(index + 1);
      row.querySelector('[data-direction="up"]').disabled = index === 0;
      row.querySelector('[data-direction="down"]').disabled = index === rows.length - 1;
    });
    const total = this.element.querySelector('[data-milestone-total]');
    if (total) total.textContent = String(rows.length);
    const level = this.element.querySelector('[data-milestone-level]');
    if (level) level.textContent = String(levelFromMilestones(rows.length));
    if (this.tab === "characters" && this.element?.isConnected && this.element.parentElement) this.setPosition({ height: "auto" });
  }

  static #removeMilestoneRow(event, target) {
    event.preventDefault();
    target.closest('[data-milestone-row]')?.remove();
    this.#numberMilestones();
  }

  static #moveMilestoneRow(event, target) {
    event.preventDefault();
    const row = target.closest('[data-milestone-row]');
    if (target.dataset.direction === 'up' && row.previousElementSibling) row.previousElementSibling.before(row);
    else if (target.dataset.direction === 'down' && row.nextElementSibling) row.nextElementSibling.after(row);
    this.#numberMilestones();
  }

  static async #saveDowntime(event) {
    event.preventDefault();
    const root = this.element.querySelector('[data-downtime-editor]');
    if (!root || !this.actorUuid) return;
    const values = { downtime: root.querySelector('[name="downtime"]').value, passiveDowntime: root.querySelector('[name="passiveDowntime"]').value, signature: this._downtimeSignature };
    if (!await foundry.applications.api.DialogV2.confirm({ window: { title: uiText("TOVF.Interface.CorrectDowntime_4d226f", "Downtime korrigieren") }, content: `<p>${uiText("TOVF.Interface.SetDowntimeToP0AndApplyPassive_91fd9d", "Downtime auf {p0} setzen und die passive Downtime übernehmen?", { p0: (foundry.utils.escapeHTML(values.downtime)) })}</p>`, rejectClose: false })) return;
    await this.#execute(() => GMToolsService.updateDowntime(this.actorUuid, values), "DOWNTIME_MANAGER.GMTools.Notifications.CharacterSaved");
  }

  static async #saveCharacter(event) {
    event.preventDefault();
    const root = this.element.querySelector("[data-character-editor]");
    if (!root || !this.actorUuid) return;
    const current = await GMToolsService.characterData(this.actorUuid);
    const values = {
      milestoneSignature: this._milestoneSignature,
      downtime: undefined,
      milestoneEntries: Array.from(root.querySelectorAll('[data-milestone-row]'), row => ({
        originalIndex: row.dataset.originalIndex,
        source: row.querySelector('[name="milestoneSource"]').value,
        evidenceKey: row.querySelector('[name="milestoneEvidence"]')?.value ?? "",
        note: row.querySelector('[name="milestoneNote"]').value,
        week: row.querySelector('[name="milestoneWeek"]').value
      })),
      sessionsPlayed: root.querySelector('[name="sessionsPlayed"]')?.value,
      lastMilestoneWeek: root.querySelector('[name="lastMilestoneWeek"]')?.value,
      active: root.querySelector('[name="characterActive"]')?.checked !== false,
      passiveDowntime: undefined
    };
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.ConfirmChange") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.ConfirmChangeHint")}</p>
        <table><tr><th></th><th>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Before")}</th><th>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.After")}</th></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.Milestones")}</td><td>${current.progress.milestones}</td><td>${foundry.utils.escapeHTML(String(values.milestoneEntries.length))}</td></tr>
        <tr><td>${game.i18n.localize("DOWNTIME_MANAGER.GMTools.SessionsPlayed")}</td><td>${current.progress.sessionsPlayed}</td><td>${foundry.utils.escapeHTML(String(values.sessionsPlayed))}</td></tr></table>`
    });
    if (!confirmed) return;
    await this.#execute(
      () => GMToolsService.updateCharacter(this.actorUuid, values),
      "DOWNTIME_MANAGER.GMTools.Notifications.CharacterSaved"
    );
  }

  static async #saveActivity(event) {
    event.preventDefault();
    const entries = Array.from(this.element.querySelectorAll('[name="characterActivity"]'), input => ({
      actorUuid: input.value,
      active: input.checked
    }));
    await this.#execute(
      () => GMToolsService.updateActivity(entries),
      "DOWNTIME_MANAGER.GMTools.Activity.Saved"
    );
  }

  static async #settlePassiveDowntime(event) {
    event.preventDefault();
    if (game.settings.get(MODULE_ID, "worldRole") !== "primary" || !isProjectAdministrator()) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.SettlementAdminOnly"));
    }
    const config = passiveDowntimeConfig();
    const period = this.element.querySelector('[name="settlementPeriod"]')?.value
      || (config.period === "week" ? isoWeekKey() : monthKey());
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Session.Settle") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Session.SettleConfirm", { month: period })}</p>`
    });
    if (!confirmed) return;
    await this.#execute(async () => {
      const record = await SessionService.settle(period);
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Session.Settled", { count: record.recipients.length }));
    });
  }

  static async #correctHistoricalSession(event, target) {
    event.preventDefault();
    const recordId = target.dataset.recordId;
    if (!recordId) return;
    try {
      const correction = await SessionService.correctionDefaults(recordId);
      const rows = correction.actors.map(actor => `<label class="sc-session-correction-row"><input type="checkbox" name="actors" value="${foundry.utils.escapeHTML(actor.actorUuid)}" ${actor.selected ? "checked" : ""}><strong>${foundry.utils.escapeHTML(actor.actorName)}</strong><span>${game.i18n.localize("DOWNTIME_MANAGER.Currency.GP")}</span><input type="number" name="gold.${foundry.utils.escapeHTML(actor.actorUuid)}" value="${actor.gold}" min="0" step="any"></label>`).join("");
      const result = await foundry.applications.api.DialogV2.prompt({
        classes: ["downtime-manager", "sc-session-correction-dialog"],
        window: { title: game.i18n.format("DOWNTIME_MANAGER.Session.Correction.EditTitle", { title: correction.record.title }) },
        position: { width: 620, height: 700 },
        content: `<div class="standard-form"><p class="notes">${game.i18n.localize("DOWNTIME_MANAGER.Session.Correction.Hint")}</p><div class="sc-session-correction-list">${rows}</div></div>`,
        ok: { label: game.i18n.localize("DOWNTIME_MANAGER.Session.Correction.Apply"), callback: (_dialogEvent, button) => {
          const data = new FormData(button.form);
          return { actorUuids: data.getAll("actors"), goldByActor: Object.fromEntries(correction.actors.map(actor => [actor.actorUuid, data.get(`gold.${actor.actorUuid}`)])) };
        } }, rejectClose: false
      });
      if (!result || !await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("DOWNTIME_MANAGER.Session.Correction.Title") },
        content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.Session.Correction.Confirm")}</p>`
      })) return;
      await SessionService.correctSession({ recordId, ...result });
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Session.Correction.Complete"));
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Historical session correction failed`, error);
      ui.notifications.error(error.message);
    }
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

  static async #deleteExpiredEffects(event) {
    event.preventDefault();
    const summary = GMToolsService.expiredTemporaryEffectSummary();
    if (!summary.count) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: uiText("TOVF.EffectCleanup.Title", "Abgelaufene temporäre Effects") },
      content: `<p>${uiText("TOVF.EffectCleanup.Confirm", "{count} abgelaufene temporäre Active Effects auf {actors} Actors löschen?", summary)}</p><p class="notes">${uiText("TOVF.EffectCleanup.Scope", "Gelöscht werden nur Effects, die direkt auf einem Actor liegen, eine temporäre Dauer besitzen und von Foundry bereits als abgelaufen markiert wurden. Aktive, lediglich deaktivierte, dauerhafte und in Items eingebettete Effects bleiben erhalten.")}</p>`
    });
    if (!confirmed) return;
    await this.#execute(async () => {
      const count = await GMToolsService.deleteExpiredTemporaryEffects();
      if (count) {
        this.effectCleanupResult = uiText("TOVF.EffectCleanup.Result", "{count} abgelaufene temporäre Active Effects wurden gelöscht. Die Änderung kann oben über Rückgängig wiederhergestellt werden.", { count });
        ui.notifications.info(uiText("TOVF.EffectCleanup.Deleted", "{count} abgelaufene temporäre Active Effects wurden gelöscht.", { count }));
      } else {
        this.effectCleanupResult = uiText("TOVF.EffectCleanup.NothingDeleted", "Es wurde nichts gelöscht. Seit der Vorschau waren keine passenden Effects mehr vorhanden.");
        ui.notifications.warn(this.effectCleanupResult);
      }
    });
  }

  static async #migrateWorkingEffects(event) {
    event.preventDefault();
    await this.#execute(async () => {
      ui.notifications.info("Verwendungen der sieben Ersatz-Effekte werden gesucht …");
      const preview = await previewWorkingEffectMigration();
      if (!preview.available) {
        ui.notifications.warn("Das Kompendium Funktioniere Effekte ist nicht mehr vorhanden.");
        return;
      }
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Funktionierende Effekte ersetzen" },
        content: `<p><strong>${preview.effects} Effekte</strong>: ${preview.references} Referenzen in ${preview.documents} Dokumenten werden durch die Black-Flag-Originale ersetzt.</p><p class="notes">Danach wird erneut geprüft. Das Weltkompendium wird nur gelöscht, wenn keine alte Referenz mehr vorhanden ist.</p>`
      });
      if (!confirmed) return;
      const result = await applyWorkingEffectMigration();
      this.effectPackMigrationResult = `${result.references} Referenzen in ${result.documents} Dokumenten ersetzt; das Kompendium wurde gelöscht.`;
      ui.notifications.info(this.effectPackMigrationResult, { permanent: true });
    });
  }

  static async #migrateLegacyActiveEffects(event) {
    event.preventDefault();
    if (!isOperationalGM()) throw new Error("Diese Migration erfordert eine Spielleitung.");
    const entries = await previewLegacyActiveEffects();
    const repairable = entries.filter(entry => entry.repairable);
    if (!repairable.length) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Veraltete Active Effects migrieren" },
      content: `<p><strong>${repairable.length}</strong> Active Effects mit dem ungültigen Rohdatentyp <code>standard</code> auf <strong>${new Set(repairable.map(entry => entry.parentUuid)).size}</strong> Dokumenten zu <code>base</code> migrieren?</p><p class="notes">Geändert werden Weltdokumente und nicht gesperrte Weltkompendien. System-, Black-Flag- und Modulkompendien bleiben unverändert.</p>`
    });
    if (!confirmed) return;
    await this.#execute(async () => {
      const result = await migrateLegacyWorldActiveEffects();
      const remainingRepairable = result.remaining.filter(entry => entry.repairable).length;
      const readOnly = result.remaining.length - remainingRepairable;
      this.legacyActiveEffectResult = `${result.migrated} Effects migriert; ${remainingRepairable} reparierbare und ${readOnly} schreibgeschützte Quellen verbleiben.`;
      if (remainingRepairable) ui.notifications.warn(this.legacyActiveEffectResult);
      else ui.notifications.info(this.legacyActiveEffectResult);
    });
  }

  static async #repairLegacyActiveEffect(event) {
    event.preventDefault();
    if (!isOperationalGM()) throw new Error("Diese Reparatur erfordert eine Spielleitung.");
    const uuid = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Active Effect reparieren" },
      content: '<div class="form-group stacked"><label>Effect-UUID</label><input name="uuid" type="text" required autofocus><p class="notes">Die UUID aus der Foundry-Fehlermeldung einfügen.</p></div>',
      ok: { label: "Zu base migrieren", callback: (_dialogEvent, button) => button.form.elements.uuid.value.trim() },
      rejectClose: false
    });
    if (!uuid) return;
    const effect = await fromUuid(uuid).catch(() => null);
    if (effect?.documentName !== "ActiveEffect") throw new Error("Die UUID verweist nicht auf einen Active Effect.");
    if (effect.parent?.isOwner !== true && effect.isOwner !== true) {
      throw new Error("Für den zugehörigen Actor oder das Item fehlt der Schreibzugriff.");
    }
    await effect.update({ type: "base" });
    this.legacyActiveEffectResult = `Active Effect „${effect.name}“ wurde zu base migriert.`;
    ui.notifications.info(this.legacyActiveEffectResult);
    await this.render({ force: true });
  }

  static async #migrateActorSpells(event) {
    event.preventDefault();
    await this.#execute(async () => {
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Scanning"));
      const preview = await previewActorSpellMigration();
      const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
      const rows = entries => {
        const grouped = new Map();
        for (const { actor, item } of entries) {
          const key = `${actor.id}\u0000${item.name}`;
          const current = grouped.get(key) ?? { actor: actor.name, item: item.name, count: 0 };
          current.count += 1;
          grouped.set(key, current);
        }
        return Array.from(grouped.values(), entry => `<li><strong>${escape(entry.actor)}</strong>: ${escape(entry.item)}${entry.count > 1 ? ` <small>×${entry.count}</small>` : ""}</li>`).join("");
      };
      const content = `<p>${game.i18n.format("DOWNTIME_MANAGER.GMTools.SpellMigration.Preview", {
        items: preview.matches.length,
        actors: preview.actors.size,
        missing: preview.missing.length,
        ambiguous: preview.ambiguous.length
      })}</p>
        <p class="notes">${game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Scope")}</p>
        ${preview.missing.length ? `<details><summary>${game.i18n.format("DOWNTIME_MANAGER.GMTools.SpellMigration.Missing", { count: preview.missing.length })}</summary><ul>${rows(preview.missing)}</ul></details>` : ""}
        ${preview.ambiguous.length ? `<details><summary>${game.i18n.format("DOWNTIME_MANAGER.GMTools.SpellMigration.Ambiguous", { count: preview.ambiguous.length })}</summary><ul>${rows(preview.ambiguous)}</ul></details>` : ""}`;
      if (!preview.matches.length) {
        await foundry.applications.api.DialogV2.prompt({
          window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Title") },
          content,
          ok: { label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Close") }
        });
        return;
      }
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Title") },
        position: { width: 680 },
        content: `${content}<p class="notification warning">${game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Warning")}</p>`,
        yes: { label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Apply") },
        no: { label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Cancel") }
      });
      if (!confirmed) return;
      const result = await applyActorSpellMigration(preview);
      const failed = result.failures.length
        ? `<details><summary>${game.i18n.format("DOWNTIME_MANAGER.GMTools.SpellMigration.Failed", { count: result.failures.length })}</summary><ul>${result.failures.map(entry => `<li><strong>${escape(entry.actor)}</strong>: ${escape(entry.item)} – ${escape(entry.message)}</li>`).join("")}</ul></details>`
        : "";
      await foundry.applications.api.DialogV2.prompt({
        window: { title: game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Title") },
        content: `<p>${game.i18n.format("DOWNTIME_MANAGER.GMTools.SpellMigration.Complete", result)}</p>${failed}`,
        ok: { label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.Close") }
      });
    });
  }

  static async #undo(event) {
    event.preventDefault();
    await this.#execute(async () => {
      const changed = await GMToolsService.undo();
      if (changed) this.effectCleanupResult = null;
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
