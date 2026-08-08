import { FLAGS, MODULE_ID, PROJECT_TEMPLATES } from "./constants.mjs";
import { createRecipeFromBaseItem, openRecipeEditor } from "./recipe-service.mjs";
import { getStationData, isRecipeItem, isStation, recipeData } from "./utils.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ProjectLibraryApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-project-library",
    classes: ["downtime-manager", "project-library"],
    position: { width: 760, height: 720 },
    window: { title: "DOWNTIME_MANAGER.ProjectLibrary.Title", resizable: true },
    actions: {
      createProject: ProjectLibraryApp.#createProject,
      createTemplate: ProjectLibraryApp.#createTemplate,
      editProject: ProjectLibraryApp.#editProject,
      deleteProject: ProjectLibraryApp.#deleteProject,
      refresh: ProjectLibraryApp.#refresh
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/project-library.hbs" }
  };

  constructor(options = {}) {
    super(options);
    this._hooks = ["createItem", "updateItem", "deleteItem", "updateActor"].map(hook =>
      [hook, Hooks.on(hook, () => { if (this.rendered) this.render(); })]
    );
  }

  async close(options = {}) {
    for (const [hook, id] of this._hooks) Hooks.off(hook, id);
    return super.close(options);
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const stations = Array.from(game.actors).filter(isStation).map(actor => ({
      actor,
      data: getStationData(actor)
    }));
    const projects = Array.from(game.items).filter(isRecipeItem).map(item => {
      const definition = recipeData(item, { sourceUuid: item.uuid });
      const assigned = stations.filter(station => station.data.recipes.includes(item.uuid));
      const progressCount = Array.from(game.actors).reduce((count, actor) => {
        const states = actor.getFlag(MODULE_ID, FLAGS.PROJECTS);
        return count + (Array.isArray(states) ? states.filter(state => (state.projectUuid ?? state.recipeUuid) === item.uuid).length : 0);
      }, 0);
      return {
        uuid: item.uuid,
        name: String(item.name ?? ""),
        img: item.img || "icons/svg/item-bag.svg",
        requiredProgress: definition.requiredProgress,
        repeatable: definition.repeatable,
        rewardCount: definition.rewards?.length ?? 0,
        stations: assigned.map(({ actor }) => getStationData(actor).displayName || actor.name),
        progressCount
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...context,
      projects,
      templates: PROJECT_TEMPLATES.map(template => ({ id: template.id, name: game.i18n.localize(template.nameKey) }))
    };
  }

  static async #createProject() {
    try { await createRecipeFromBaseItem(); }
    catch (error) { ui.notifications.error(error.message); }
  }

  static async #createTemplate() {
    const templateId = this.element.querySelector("[data-project-template]")?.value;
    if (!templateId) return;
    try { await createRecipeFromBaseItem(templateId); }
    catch (error) { ui.notifications.error(error.message); }
  }

  static async #editProject(event, target) {
    const item = await fromUuid(target.dataset.uuid);
    if (item) openRecipeEditor(item);
  }

  static async #deleteProject(event, target) {
    const item = await fromUuid(target.dataset.uuid);
    if (!item || !isRecipeItem(item)) return;
    const stations = Array.from(game.actors).filter(actor => {
      if (!isStation(actor)) return false;
      const shared = actor.getFlag(MODULE_ID, FLAGS.SHARED_PROJECTS);
      return getStationData(actor).recipes.includes(item.uuid) || (Array.isArray(shared) && shared.some(state => state.projectUuid === item.uuid));
    });
    const affectedActors = Array.from(game.actors).filter(actor => {
      const states = actor.getFlag(MODULE_ID, FLAGS.PROJECTS);
      return Array.isArray(states) && states.some(state => (state.projectUuid ?? state.recipeUuid) === item.uuid);
    });
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.ProjectLibrary.Delete") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.ProjectLibrary.DeleteConfirm", {
        project: foundry.utils.escapeHTML(item.name ?? ""),
        stations: stations.length,
        actors: affectedActors.length
      })}</p>`
    });
    if (!confirmed) return;
    await item.delete();
    for (const stationActor of stations) {
      const station = getStationData(stationActor);
      station.recipes = station.recipes.filter(uuid => uuid !== item.uuid);
      await stationActor.setFlag(MODULE_ID, FLAGS.STATION, station);
      const shared = stationActor.getFlag(MODULE_ID, FLAGS.SHARED_PROJECTS);
      if (Array.isArray(shared)) await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, shared.filter(state => state.projectUuid !== item.uuid));
    }
    for (const actor of affectedActors) {
      const states = actor.getFlag(MODULE_ID, FLAGS.PROJECTS) ?? [];
      await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states.filter(state => (state.projectUuid ?? state.recipeUuid) !== item.uuid));
    }
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.ProjectLibrary.Deleted"));
    this.render();
  }

  static #refresh() { this.render(); }
}
