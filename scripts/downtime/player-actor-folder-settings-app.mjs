import { MODULE_ID, SETTINGS } from "./constants.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function actorFolderOptions(selectedId) {
  const folders = Array.from(game.folders).filter(folder => folder.type === "Actor");
  const byId = new Map(folders.map(folder => [String(folder.id), folder]));
  const pathFor = folder => {
    const names = [];
    const visited = new Set();
    let current = folder;
    while (current && !visited.has(current.id)) {
      names.unshift(String(current.name ?? ""));
      visited.add(current.id);
      const parent = current.folder;
      current = typeof parent === "string" ? byId.get(parent) : parent;
    }
    return names.filter(Boolean).join(" / ");
  };
  return folders
    .map(folder => ({ id: String(folder.id), name: pathFor(folder), selected: selectedId === String(folder.id) }))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

export class PlayerActorFolderSettingsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-player-actor-folders",
    classes: ["downtime-manager", "player-actor-folder-settings"],
    tag: "form",
    position: { width: 560, height: "auto" },
    window: { title: "DOWNTIME_MANAGER.Settings.PlayerActorFolders.Title", resizable: true },
    form: { handler: PlayerActorFolderSettingsApp.#submit, closeOnSubmit: false }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/player-actor-folder-settings.hbs" }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const configured = game.settings.get(MODULE_ID, SETTINGS.PLAYER_ACTOR_FOLDERS) ?? {};
    const selectedId = String(configured.folderId ?? configured.folderIds?.[0] ?? "");
    const actorFolders = actorFolderOptions(selectedId);
    return {
      ...context,
      actorFolders,
      selectedActorFolderName: actorFolders.find(folder => folder.selected)?.name ?? "",
      selectedActorFolderId: actorFolders.find(folder => folder.selected)?.id ?? ""
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const folderSearch = this.element.querySelector('[name="playerActorFolderSearch"]');
    const folderId = this.element.querySelector('[name="playerActorFolderId"]');
    folderSearch?.addEventListener("input", () => {
      const option = Array.from(this.element.querySelectorAll("#downtime-manager-actor-folders option"))
        .find(candidate => candidate.value === folderSearch.value);
      if (folderId) folderId.value = option?.dataset.folderId ?? "";
    });
  }

  static async #submit() {
    const folderSearch = String(this.element.querySelector('[name="playerActorFolderSearch"]')?.value ?? "").trim();
    const folderId = String(this.element.querySelector('[name="playerActorFolderId"]')?.value ?? "");
    if (folderSearch && !folderId) {
      return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Settings.PlayerActorFolders.Invalid"));
    }
    await game.settings.set(MODULE_ID, SETTINGS.PLAYER_ACTOR_FOLDERS, { folderId });
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Settings.PlayerActorFolders.Saved"));
    await this.close();
  }
}
