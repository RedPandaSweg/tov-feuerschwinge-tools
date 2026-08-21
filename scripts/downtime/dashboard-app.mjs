import { FLAGS, MODULE_ID, SETTINGS } from "./constants.mjs";
import { StationApp } from "./station-app.mjs";
import { getStationData, isStation, round } from "./utils.mjs";
import { SessionApp } from "./session-app.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { playerCharacters, SessionService } from "./session-service.mjs";
import { ProjectLibraryApp } from "./project-library-app.mjs";
import { StationPresetApp } from "./station-preset-app.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DowntimeDashboardApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-dashboard",
    classes: ["downtime-manager", "downtime-dashboard"],
    position: { width: 900, height: 720 },
    window: { title: "DOWNTIME_MANAGER.Dashboard.Title", resizable: true },
    actions: {
      openStation: DowntimeDashboardApp.#openStation,
      removeProject: DowntimeDashboardApp.#removeProject,
      refresh: DowntimeDashboardApp.#refresh,
      openSessions: DowntimeDashboardApp.#openSessions,
      openProjectLibrary: DowntimeDashboardApp.#openProjectLibrary,
      openStationPresets: DowntimeDashboardApp.#openStationPresets,
      grantSelectedDowntime: DowntimeDashboardApp.#grantSelectedDowntime,
      grantAllDowntime: DowntimeDashboardApp.#grantAllDowntime
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/dashboard.hbs" }
  };

  constructor(options = {}) {
    super(options);
    this._updateHook = Hooks.on("updateActor", () => {
      if (this.rendered) this.render();
    });
  }

  async close(options = {}) {
    if (this._updateHook) Hooks.off("updateActor", this._updateHook);
    return super.close(options);
  }

  async _prepareContext() {
    const stations = Array.from(game.actors).filter(isStation);
    const stationByUuid = new Map(stations.map(actor => [actor.uuid, actor]));
    const rows = [];
    for (const actor of game.actors) {
      const states = actor.getFlag(MODULE_ID, FLAGS.PROJECTS);
      if (!Array.isArray(states)) continue;
      for (const state of states) {
        const stationActor = stationByUuid.get(state.stationUuid);
        const required = Number(state.requiredProgress ?? 0);
        const progress = Number(state.progress ?? 0);
        const status = state.completed
          ? "completed"
          : state.active === false
            ? "paused"
            : state.pendingRoll
              ? "roll"
              : "active";
        rows.push({
          actorName: String(actor.name || game.i18n.localize("DOWNTIME_MANAGER.Dashboard.UnknownCharacter")),
          actorUuid: actor.uuid,
          actorImg: actor.img,
          stationName: String(stationActor
            ? getStationData(stationActor).displayName || stationActor.name
            : state.stationName || state.stationUuid || game.i18n.localize("DOWNTIME_MANAGER.Dashboard.UnknownStation")),
          stationUuid: String(state.stationUuid || ""),
          stationAvailable: Boolean(stationActor),
          projectName: String(state.projectName || state.projectUuid || state.recipeUuid || game.i18n.localize("DOWNTIME_MANAGER.Dashboard.UnknownProject")),
          stateId: String(state.id || ""),
          projectUuid: String(state.projectUuid || state.recipeUuid || ""),
          progress: round(progress, 6),
          requiredProgress: round(required, 6),
          percent: required > 0 ? Math.max(0, Math.min(100, Math.floor(progress / required * 100))) : 100,
          status,
          statusLabel: game.i18n.localize(`DOWNTIME_MANAGER.Dashboard.Status.${status}`)
        });
      }
    }
    rows.sort((a, b) => String(a.stationName).localeCompare(String(b.stationName))
      || String(a.actorName).localeCompare(String(b.actorName))
      || String(a.projectName).localeCompare(String(b.projectName)));
    const lastDirectAll = game.settings.get(MODULE_ID, SETTINGS.LAST_DIRECT_DOWNTIME_ALL) ?? {};
    return {
      rows,
      stations: stations.map(actor => ({
        uuid: actor.uuid,
        name: String(getStationData(actor).displayName || actor.name || game.i18n.localize("DOWNTIME_MANAGER.Dashboard.UnknownStation")),
        enabled: getStationData(actor).enabled
      })).sort((a, b) => a.name.localeCompare(b.name)),
      activeCount: rows.filter(row => row.status === "active").length,
      rollCount: rows.filter(row => row.status === "roll").length,
      completedCount: rows.filter(row => row.status === "completed").length,
      characters: playerCharacters().map(actor => ({ uuid: actor.uuid, name: actor.name, img: actor.img, downtime: DowntimeService.get(actor) })),
      lastDirectAll: lastDirectAll.timestamp ? {
        ...lastDirectAll,
        date: new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(lastDirectAll.timestamp))
      } : null
    };
  }

  static async #openStation(event, target) {
    const actor = await fromUuid(target.dataset.uuid);
    if (actor) new StationApp(actor).render(true);
  }

  static async #removeProject(event, target) {
    const actor = await fromUuid(target.dataset.actorUuid);
    if (!actor) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Dashboard.RemoveProject") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Dashboard.RemoveProjectConfirm", {
        project: foundry.utils.escapeHTML(target.dataset.projectName || ""),
        actor: foundry.utils.escapeHTML(actor.name || "")
      })}</p>`
    });
    if (!confirmed) return;
    const states = actor.getFlag(MODULE_ID, FLAGS.PROJECTS);
    if (!Array.isArray(states)) return;
    const filtered = states.filter(state => {
      if (target.dataset.stateId) return String(state.id || "") !== target.dataset.stateId;
      const sameStation = String(state.stationUuid || "") === target.dataset.stationUuid;
      const sameProject = String(state.projectUuid || state.recipeUuid || "") === target.dataset.projectUuid;
      return !(sameStation && sameProject);
    });
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, filtered);
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Dashboard.ProjectRemoved"));
    this.render();
  }

  static #refresh() { this.render(); }
  static #openSessions() { new SessionApp().render(true); }
  static #openProjectLibrary() { new ProjectLibraryApp().render(true); }
  static #openStationPresets() { new StationPresetApp().render(true); }
  static async #grantSelectedDowntime(event) {
    event.preventDefault();
    const uuids = Array.from(this.element.querySelectorAll('[name="directDowntimeActors"]:checked')).map(input => input.value);
    await this.#grantDowntime(uuids, false);
  }
  static async #grantAllDowntime(event) {
    event.preventDefault();
    await this.#grantDowntime(playerCharacters().map(actor => actor.uuid), true);
  }
  async #grantDowntime(uuids, allCharacters) {
    const amount = Number(this.element.querySelector('[name="directDowntimeAmount"]')?.value);
    if (!uuids.length) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Dashboard.Errors.NoCharacters"));
    if (!Number.isFinite(amount) || amount <= 0) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Dashboard.Errors.InvalidDowntime"));
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Dashboard.GrantDowntime") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Dashboard.GrantDowntimeConfirm", { amount, count: uuids.length })}</p>`
    });
    if (!confirmed) return;
    try {
      const result = await SessionService.grantDirectDowntime(uuids, amount, { allCharacters });
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Dashboard.DowntimeGranted", { amount: result.amount, count: result.recipients.length }));
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Direct downtime grant failed`, error);
      ui.notifications.error(error.message);
    }
  }
}
