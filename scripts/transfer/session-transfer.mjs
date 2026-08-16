import {
  MODULE_ID,
  TRANSFER_FORMAT_VERSION,
  WORLD_ROLES
} from "../core/constants.mjs";
import { SETTINGS } from "../downtime/constants.mjs";
import {
  createCompendiumBundle,
  exportCompendiumFolder,
  importCompendiumBundle,
  importCompendiumFolder
} from "./compendium-transfer.mjs";

const SESSION_FORMAT = "tov-feuerschwinge-session";
const RESULT_FORMAT = "tov-feuerschwinge-session-result";
const ROLE_SETTING = "worldRole";
const WEAPON_SETTING = "weaponDefinitions";
const TRANSFER_FLAG = "transfer";

function role() {
  return game.settings.get(MODULE_ID, ROLE_SETTING);
}

function assertGm() {
  if (!game.user.isGM) throw new Error(game.i18n.localize("TOVF.Session.Error.GMOnly"));
}

function removeProperty(object, path) {
  const remove = foundry.utils.deleteProperty ?? foundry.utils.unsetProperty;
  if (remove) return remove(object, path);
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.reduce((value, part) => value?.[part], object);
  if (parent && key) delete parent[key];
}

function filenamePart(value) {
  return String(value ?? "session")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function cleanForHash(value) {
  const data = foundry.utils.deepClone(value);
  delete data._id;
  delete data.folder;
  delete data.ownership;
  removeProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}`);
  const clean = entry => {
    if (Array.isArray(entry)) return entry.map(clean);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(Object.entries(entry)
      .filter(([key]) => key !== "_stats")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, clean(child)]));
  };
  return clean(data);
}

function normalizeLegacyActiveEffects(actorData) {
  const collections = [
    actorData.effects,
    ...(actorData.items ?? []).map(item => item.effects)
  ];
  for (const effects of collections) {
    if (!Array.isArray(effects)) continue;
    for (const effect of effects) {
      if (effect?.type === "standard") effect.type = "base";
    }
  }
  return actorData;
}

async function persistMigratedActiveEffectTypes(actor) {
  const persist = async parent => {
    const updates = parent.effects
      .filter(effect => effect.type === "base")
      .map(effect => ({ _id: effect.id, type: "base" }));
    if (updates.length) {
      await parent.updateEmbeddedDocuments("ActiveEffect", updates, {
        diff: false,
        recursive: false
      });
    }
  };

  await persist(actor);
  for (const item of actor.items) await persist(item);
}

async function hashDocument(data) {
  const bytes = new TextEncoder().encode(JSON.stringify(cleanForHash(data)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function actorTransferId(actor) {
  return actor.getFlag(MODULE_ID, TRANSFER_FLAG)?.id
    ?? `world:${game.world.id}:Actor:${actor.id}`;
}

function folderParentId(folder) {
  return typeof folder?.folder === "string" ? folder.folder : folder?.folder?.id ?? null;
}

function configuredActorRootId() {
  const configured = game.settings.get(MODULE_ID, SETTINGS.PLAYER_ACTOR_FOLDERS) ?? {};
  return String(configured.folderId ?? configured.folderIds?.[0] ?? "");
}

function actorFolderTransferId(folder) {
  return folder.getFlag(MODULE_ID, TRANSFER_FLAG)?.id
    ?? `world:${game.world.id}:ActorFolder:${folder.id}`;
}

function descendantsOf(rootIds) {
  const included = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of game.folders.filter(folder => folder.type === "Actor")) {
      if (included.has(folder.id) || !included.has(folderParentId(folder))) continue;
      included.add(folder.id);
      changed = true;
    }
  }
  return included;
}

function personalFolderFor(actor, rootId) {
  if (!rootId || !actor.folder) return null;
  let folder = actor.folder;
  const visited = new Set();
  while (folder && !visited.has(folder.id)) {
    visited.add(folder.id);
    const parentId = folderParentId(folder);
    if (parentId === rootId) return folder;
    if (folder.id === rootId) return null;
    folder = parentId ? game.folders.get(parentId) : null;
  }
  return null;
}

function actorIsWithinRoot(actor, rootId) {
  if (!rootId) return true;
  let folder = actor.folder;
  const visited = new Set();
  while (folder && !visited.has(folder.id)) {
    if (folder.id === rootId) return true;
    visited.add(folder.id);
    folder = game.folders.get(folderParentId(folder));
  }
  return false;
}

function resolveActorScope(selectedActors, rootId, {
  includeFolders = true,
  includeFolderActors = true,
  selectedFolderIds = null
} = {}) {
  const personalRoots = includeFolders && selectedFolderIds === null
    ? new Set(selectedActors.map(actor => personalFolderFor(actor, rootId)?.id).filter(Boolean))
    : new Set();
  const folderIds = selectedFolderIds === null
    ? descendantsOf(personalRoots)
    : new Set(selectedFolderIds);
  if (selectedFolderIds === null && includeFolders && game.folders.get(rootId)?.type === "Actor" && selectedActors.some(actor => (
    actor.folder?.id === rootId || personalFolderFor(actor, rootId)
  ))) folderIds.add(rootId);
  const actors = new Map(selectedActors.map(actor => [actor.id, actor]));
  if (includeFolderActors) {
    for (const actor of game.actors) {
      if (actor.folder && folderIds.has(actor.folder.id)) actors.set(actor.id, actor);
    }
  }
  return { actors: [...actors.values()], folderIds };
}

function resolveExportPreviewScope(selectedActors, includeFolders) {
  const actors = new Map(selectedActors.map(actor => [actor.id, actor]));
  if (!includeFolders) return { actors: [...actors.values()], folderIds: new Set() };

  const parentFolderIds = new Set(selectedActors.map(actor => actor.folder?.id).filter(Boolean));
  const folderIds = descendantsOf(parentFolderIds);
  for (const parentId of parentFolderIds) folderIds.delete(parentId);
  for (const actor of game.actors) {
    if (actor.folder && folderIds.has(actor.folder.id)) actors.set(actor.id, actor);
  }
  return { actors: [...actors.values()], folderIds };
}

function actorFolderPath(folder) {
  const names = [];
  const visited = new Set();
  while (folder && !visited.has(folder.id)) {
    names.unshift(folder.name);
    visited.add(folder.id);
    folder = game.folders.get(folderParentId(folder));
  }
  return names.join(" / ");
}

async function chooseExportActors(actors, folderIds, selectedActorIds) {
  const selectedIds = new Set(selectedActorIds);
  const rows = actors
    .filter(actor => selectedIds.has(actor.id))
    .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
  const folders = [...folderIds]
    .map(id => game.folders.get(id))
    .filter(Boolean)
    .sort((left, right) => actorFolderPath(left).localeCompare(actorFolderPath(right), game.i18n.lang));
  const content = `<p>${game.i18n.localize("TOVF.Session.ExportPreviewHint")}</p>
    <div class="tovf-actor-list">${rows.map(actor => `
      <label>
        <input type="checkbox" name="actors" value="${foundry.utils.escapeHTML(actor.id)}" checked>
        <img src="${foundry.utils.escapeHTML(actor.img ?? "icons/svg/mystery-man.svg")}" alt="">
        <span>${foundry.utils.escapeHTML(actor.name)}</span>
      </label>`).join("")}</div>
    ${folders.length ? `<h3>${game.i18n.localize("TOVF.Session.ExportFolders")}</h3>
      <div class="tovf-actor-list">${folders.map(folder => `
        <label>
          <input type="checkbox" name="folders" value="${foundry.utils.escapeHTML(folder.id)}" checked>
          <i class="fa-solid fa-folder" inert></i>
          <span>${foundry.utils.escapeHTML(actorFolderPath(folder))}</span>
        </label>`).join("")}</div>` : ""}`;
  return foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("TOVF.Session.ExportPreviewTitle") },
    position: { width: 680 },
    content,
    buttons: [{
      action: "export",
      label: game.i18n.localize("TOVF.Session.Primary.ExportAction"),
      icon: "fa-solid fa-download",
      default: true,
      callback: (_event, button) => ({
        actorIds: Array.from(button.form.querySelectorAll('[name="actors"]:checked'), input => input.value),
        folderIds: Array.from(button.form.querySelectorAll('[name="folders"]:checked'), input => input.value)
      })
    }, {
      action: "cancel",
      label: game.i18n.localize("Cancel"),
      callback: () => null
    }],
    rejectClose: false
  });
}

function exportActorFolders(folderIds) {
  return [...folderIds].map(id => game.folders.get(id)).filter(Boolean).map(folder => ({
    sourceId: folder.id,
    transferId: actorFolderTransferId(folder),
    parentId: folderIds.has(folderParentId(folder)) ? folderParentId(folder) : null,
    data: {
      name: folder.name,
      color: folder.color,
      sorting: folder.sorting,
      sort: folder.sort
    }
  }));
}

function findMacroReferences(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const entry of value) findMacroReferences(entry, result);
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "macroUuid" && typeof entry === "string" && entry.trim()) result.add(entry.trim());
    else findMacroReferences(entry, result);
  }
  return result;
}

function replaceReferences(value, replacements) {
  if (Array.isArray(value)) return value.map(entry => replaceReferences(entry, replacements));
  if (!value || typeof value !== "object") return replacements.get(value) ?? value;
  for (const [key, entry] of Object.entries(value)) value[key] = replaceReferences(entry, replacements);
  return value;
}

async function exportReferencedMacros(actors, definitions) {
  const references = findMacroReferences(definitions);
  for (const actor of actors) findMacroReferences(actor.toObject(), references);
  const byUuid = new Map();
  for (const reference of references) {
    const macro = await fromUuid(reference).catch(() => null)
      ?? game.macros.get(reference);
    if (!(macro instanceof Macro)) continue;
    let entry = byUuid.get(macro.uuid);
    if (!entry) {
      const data = macro.toObject();
      foundry.utils.setProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}`, {
        id: `Macro:${macro.uuid}`
      });
      entry = { sourceUuid: macro.uuid, sourceReferences: [], data };
      byUuid.set(macro.uuid, entry);
    }
    entry.sourceReferences.push(reference);
  }
  return [...byUuid.values()];
}

async function importMacros(entries = []) {
  const replacements = new Map();
  const existing = new Map(game.macros.map(macro => [
    macro.getFlag(MODULE_ID, TRANSFER_FLAG)?.id,
    macro
  ]).filter(([id]) => id));
  for (const entry of entries) {
    const data = foundry.utils.deepClone(entry.data);
    delete data._stats;
    data.folder = null;
    const id = foundry.utils.getProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}.id`);
    let macro = existing.get(id);
    if (macro) {
      data._id = macro.id;
      await macro.update(data, { diff: false, recursive: false });
    } else {
      delete data._id;
      macro = await Macro.create(data);
    }
    replacements.set(entry.sourceUuid, macro.uuid);
    for (const reference of entry.sourceReferences ?? []) replacements.set(reference, macro.uuid);
  }
  return replacements;
}

function baseMetadata() {
  return {
    exportedAt: new Date().toISOString(),
    sourceWorld: game.world.id,
    system: game.system.id,
    systemVersion: game.system.version,
    foundryVersion: game.version,
    moduleVersion: game.modules.get(MODULE_ID)?.version
  };
}

function validatePackage(bundle, expectedFormat) {
  if (bundle?.format !== expectedFormat || bundle.formatVersion !== TRANSFER_FORMAT_VERSION) {
    throw new Error(game.i18n.localize("TOVF.Session.Error.Format"));
  }
  if (bundle.metadata?.system !== game.system.id) {
    throw new Error(game.i18n.format("TOVF.Session.Error.System", { system: bundle.metadata?.system }));
  }
  if (!Array.isArray(bundle.actors)) throw new Error(game.i18n.localize("TOVF.Session.Error.Content"));
}

export async function exportSession(actorIds, {
  actorRootId = configuredActorRootId(),
  compendiumFolderId = null,
  includeFolders = true
} = {}) {
  assertGm();
  if (role() !== WORLD_ROLES.PRIMARY) throw new Error(game.i18n.localize("TOVF.Session.Error.PrimaryOnly"));
  const selectedActors = [...new Set(actorIds)].map(id => game.actors.get(id)).filter(actor => actor?.type === "pc");
  if (!selectedActors.length) throw new Error(game.i18n.localize("TOVF.Session.Error.NoActors"));
  const previewScope = resolveExportPreviewScope(selectedActors, includeFolders);
  const selection = await chooseExportActors(
    previewScope.actors, previewScope.folderIds, selectedActors.map(actor => actor.id)
  );
  if (!selection) return;
  const chosenActors = selection.actorIds.map(id => game.actors.get(id)).filter(actor => actor?.type === "pc");
  if (!chosenActors.length) throw new Error(game.i18n.localize("TOVF.Session.Error.NoActors"));
  const { actors, folderIds } = resolveActorScope(chosenActors, actorRootId, {
    includeFolders,
    includeFolderActors: includeFolders,
    selectedFolderIds: includeFolders ? selection.folderIds : []
  });

  const definitions = foundry.utils.deepClone(game.settings.get(MODULE_ID, WEAPON_SETTING));
  const actorEntries = [];
  for (const actor of actors) {
    const data = actor.toObject();
    const baselineHash = await hashDocument(data);
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}`, {
      id: actorTransferId(actor),
      baselineHash,
      sourceWorld: game.world.id
    });
    actorEntries.push({
      transferId: actorTransferId(actor),
      baselineHash,
      sourceFolderId: folderIds.has(actor.folder?.id) ? actor.folder.id : null,
      selected: true,
      data
    });
  }
  const macros = await exportReferencedMacros(actors, definitions);
  const actorFolders = exportActorFolders(folderIds);
  const compendiums = compendiumFolderId ? await createCompendiumBundle(compendiumFolderId) : null;
  const bundle = {
    format: SESSION_FORMAT,
    formatVersion: TRANSFER_FORMAT_VERSION,
    metadata: baseMetadata(),
    configuration: { weaponDefinitions: definitions },
    macros,
    actorFolders,
    actors: actorEntries,
    compendiums
  };
  foundry.utils.saveDataToFile(
    JSON.stringify(bundle, null, 2),
    "application/json",
    `tov-feuerschwinge-session-${filenamePart(game.world.title)}-${bundle.metadata.exportedAt.slice(0, 10)}.json`
  );
  ui.notifications.info(game.i18n.format("TOVF.Session.ExportComplete", { count: actors.length }));
}

async function synchronizeActorFolders(entries = []) {
  const byTransferId = new Map(game.folders.filter(folder => folder.type === "Actor").map(folder => [
    folder.getFlag(MODULE_ID, TRANSFER_FLAG)?.id,
    folder
  ]).filter(([id]) => id));
  const mapping = new Map();
  const pending = [...entries];
  while (pending.length) {
    const index = pending.findIndex(entry => !entry.parentId || mapping.has(entry.parentId));
    if (index < 0) throw new Error(game.i18n.localize("TOVF.Session.Error.FolderTree"));
    const entry = pending.splice(index, 1)[0];
    const parent = entry.parentId ? mapping.get(entry.parentId) : null;
    let folder = byTransferId.get(entry.transferId);
    folder ??= game.folders.find(candidate => candidate.type === "Actor"
      && candidate.name === entry.data.name
      && folderParentId(candidate) === parent);
    const data = {
      ...foundry.utils.deepClone(entry.data),
      type: "Actor",
      folder: parent,
      flags: { [MODULE_ID]: { [TRANSFER_FLAG]: { id: entry.transferId } } }
    };
    if (folder) await folder.update(data);
    else folder = await foundry.documents.Folder.implementation.create(data);
    mapping.set(entry.sourceId, folder.id);
  }
  return mapping;
}

async function updateOrCreateActor(entry, replacements, folderMapping = new Map()) {
  const data = normalizeLegacyActiveEffects(
    replaceReferences(foundry.utils.deepClone(entry.data), replacements)
  );
  data.folder = folderMapping.get(entry.sourceFolderId) ?? null;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}.baselineHash`, entry.baselineHash);
  const target = game.actors.find(actor =>
    actor.getFlag(MODULE_ID, TRANSFER_FLAG)?.id === entry.transferId
  );
  if (target) {
    await persistMigratedActiveEffectTypes(target);
    await target.importFromJSON(JSON.stringify(data));
    return "update";
  }
  delete data._id;
  await Actor.create(data);
  return "create";
}

export async function importSession(file) {
  assertGm();
  if (role() !== WORLD_ROLES.SESSION) throw new Error(game.i18n.localize("TOVF.Session.Error.SessionOnly"));
  if (!file) throw new Error(game.i18n.localize("TOVF.Session.Error.FileMissing"));
  const bundle = JSON.parse(await foundry.utils.readTextFromFile(file));
  validatePackage(bundle, SESSION_FORMAT);

  const accepted = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("TOVF.Session.ImportConfirmTitle") },
    content: `<p>${game.i18n.format("TOVF.Session.ImportPreview", {
      count: bundle.actors.length,
      source: foundry.utils.escapeHTML(bundle.metadata.sourceWorld)
    })}</p>`,
    yes: { label: game.i18n.localize("TOVF.Session.ImportAction") },
    no: { label: game.i18n.localize("Cancel") }
  });
  if (!accepted) return;

  await game.settings.set(MODULE_ID, WEAPON_SETTING, bundle.configuration?.weaponDefinitions ?? {
    properties: [],
    options: []
  });
  const replacements = await importMacros(bundle.macros);
  const folderMapping = await synchronizeActorFolders(bundle.actorFolders);
  const counts = { create: 0, update: 0 };
  for (const entry of bundle.actors) counts[await updateOrCreateActor(entry, replacements, folderMapping)]++;
  if (bundle.compendiums) await importCompendiumBundle(bundle.compendiums, null, { confirm: false });
  ui.notifications.info(game.i18n.format("TOVF.Session.ImportComplete", counts));
  SettingsConfig.reloadConfirm({ world: true });
}

function managedSessionActors() {
  return game.actors.filter(actor => {
    const transfer = actor.getFlag(MODULE_ID, TRANSFER_FLAG);
    return transfer?.id && transfer?.baselineHash;
  });
}

export async function exportSessionResult() {
  assertGm();
  if (role() !== WORLD_ROLES.SESSION) throw new Error(game.i18n.localize("TOVF.Session.Error.SessionOnly"));
  const actors = managedSessionActors();
  if (!actors.length) throw new Error(game.i18n.localize("TOVF.Session.Error.NoManagedActors"));
  const entries = actors.map(actor => {
    const transfer = actor.getFlag(MODULE_ID, TRANSFER_FLAG);
    return {
      transferId: transfer.id,
      baselineHash: transfer.baselineHash,
      data: actor.toObject()
    };
  });
  const bundle = {
    format: RESULT_FORMAT,
    formatVersion: TRANSFER_FORMAT_VERSION,
    metadata: baseMetadata(),
    actors: entries
  };
  foundry.utils.saveDataToFile(
    JSON.stringify(bundle, null, 2),
    "application/json",
    `tov-feuerschwinge-result-${filenamePart(game.world.title)}-${bundle.metadata.exportedAt.slice(0, 10)}.json`
  );
  ui.notifications.info(game.i18n.format("TOVF.Session.ResultExportComplete", { count: actors.length }));
}

async function chooseResultActors(rows) {
  const content = `<p>${game.i18n.localize("TOVF.Session.ResultHint")}</p>
    <div class="tovf-result-list">${rows.map(row => `
      <label class="${row.conflict ? "warning" : ""}">
        <input type="checkbox" name="actors" value="${foundry.utils.escapeHTML(row.transferId)}" ${row.conflict ? "" : "checked"}>
        <span>${foundry.utils.escapeHTML(row.name)}</span>
        <small>${game.i18n.localize(row.conflict ? "TOVF.Session.Conflict" : "TOVF.Session.Unchanged")}</small>
      </label>`).join("")}</div>`;
  return foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.localize("TOVF.Session.ResultImportTitle") },
    content,
    buttons: [{
      action: "apply",
      label: game.i18n.localize("TOVF.Session.ResultImportAction"),
      icon: "fa-solid fa-check",
      default: true,
      callback: (_event, button) => Array.from(button.form.querySelectorAll('[name="actors"]:checked'))
        .map(input => input.value)
    }, {
      action: "cancel",
      label: game.i18n.localize("Cancel"),
      callback: () => null
    }],
    rejectClose: false
  });
}

export async function importSessionResult(file) {
  assertGm();
  if (role() !== WORLD_ROLES.PRIMARY) throw new Error(game.i18n.localize("TOVF.Session.Error.PrimaryOnly"));
  if (!file) throw new Error(game.i18n.localize("TOVF.Session.Error.FileMissing"));
  const bundle = JSON.parse(await foundry.utils.readTextFromFile(file));
  validatePackage(bundle, RESULT_FORMAT);

  const candidates = new Map(game.actors.map(actor => [actorTransferId(actor), actor]));
  const rows = [];
  for (const entry of bundle.actors) {
    const actor = candidates.get(entry.transferId);
    if (!actor) continue;
    rows.push({
      transferId: entry.transferId,
      actor,
      entry,
      name: actor.name,
      conflict: await hashDocument(actor.toObject()) !== entry.baselineHash
    });
  }
  if (!rows.length) throw new Error(game.i18n.localize("TOVF.Session.Error.NoMatchingActors"));
  const selected = await chooseResultActors(rows);
  if (!selected) return;
  const accepted = new Set(selected);
  let count = 0;
  for (const row of rows.filter(row => accepted.has(row.transferId))) {
    const data = normalizeLegacyActiveEffects(foundry.utils.deepClone(row.entry.data));
    data.folder = row.actor.folder?.id ?? null;
    removeProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}.baselineHash`);
    await persistMigratedActiveEffectTypes(row.actor);
    await row.actor.importFromJSON(JSON.stringify(data));
    count++;
  }
  Hooks.callAll("tovFeuerschwinge.sessionResultImported", {
    actorIds: rows.filter(row => accepted.has(row.transferId)).map(row => row.actor.id)
  });
  ui.notifications.info(game.i18n.format("TOVF.Session.ResultImportComplete", { count }));
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class SessionTransferConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tov-feuerschwinge-session-transfer",
    tag: "form",
    classes: ["standard-form", "tovf-session-transfer"],
    position: { width: 720, height: 780 },
    window: { title: "TOVF.Session.Title", resizable: true },
    actions: {
      selectActors: this.#selectActors,
      exportSession: this.#exportSession,
      importSession: this.#importSession,
      exportResult: this.#exportResult,
      importResult: this.#importResult,
      saveActorRoot: this.#saveActorRoot,
      exportCompendiums: this.#exportCompendiums,
      importCompendiums: this.#importCompendiums
    }
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_ID}/templates/session-transfer.hbs`,
      scrollable: [""]
    }
  };

  async _prepareContext(options) {
    const currentRole = role();
    const configuredRootId = configuredActorRootId();
    const selectedRootId = this._actorRootId ?? configuredRootId;
    const actorFolders = game.folders.filter(folder => folder.type === "Actor");
    const folderPath = actorFolderPath;
    const actors = game.actors
      .filter(actor => actor.type === "pc" && actorIsWithinRoot(actor, selectedRootId))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      .map(actor => ({
        id: actor.id,
        name: actor.name,
        img: actor.img,
        folder: actor.folder ? folderPath(actor.folder) : game.i18n.localize("TOVF.Transfer.Root"),
        transferFolder: actor.folder
          ? folderPath(actor.folder)
          : game.i18n.localize("TOVF.Session.OnlyActor"),
        searchText: `${actor.name} ${actor.folder ? folderPath(actor.folder) : ""}`.toLocaleLowerCase(),
        connected: game.users.some(user => (
          user.active
          && !user.isGM
          && actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
        ))
      }));
    const actorIds = new Set(actors.map(actor => actor.id));
    const players = game.users.filter(user => !user.isGM).map(user => {
      const owned = game.actors.filter(actor => actorIds.has(actor.id) && (
        (user.character?.id ?? user.character) === actor.id
        || actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
      ));
      return {
        id: user.id,
        name: user.name,
        active: user.active,
        actorIds: owned.map(actor => actor.id).join(","),
        characters: owned.map(actor => actor.name).join(", "),
        searchText: `${user.name} ${owned.map(actor => actor.name).join(" ")}`.toLocaleLowerCase()
      };
    }).filter(player => player.actorIds);
    return {
      ...(await super._prepareContext(options)),
      isPrimary: currentRole === WORLD_ROLES.PRIMARY,
      isSession: currentRole === WORLD_ROLES.SESSION,
      connectedActors: actors.filter(actor => actor.connected),
      otherActors: actors.filter(actor => !actor.connected),
      selectionMode: this._selectionMode ?? "character",
      selectByCharacter: (this._selectionMode ?? "character") === "character",
      selectByPlayer: this._selectionMode === "player",
      connectedPlayers: players.filter(player => player.active),
      otherPlayers: players.filter(player => !player.active),
      managedCount: managedSessionActors().length,
      actorFolders: [
        { id: "", name: game.i18n.localize("TOVF.Transfer.Root") },
        ...actorFolders.map(folder => ({
          id: folder.id,
          name: folderPath(folder)
        })).sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
      ],
      selectedActorRootId: selectedRootId,
      compendiumFolders: game.packs._formatFolderSelectOptions(),
      compendiumDestinations: [
        { id: "", name: game.i18n.localize("TOVF.Transfer.Root") },
        ...game.packs._formatFolderSelectOptions()
      ]
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector('[name="actorRoot"]')?.addEventListener("change", event => {
      this._actorRootId = event.currentTarget.value;
      this.render();
    });
    this.element.querySelector('[name="selectionMode"]')?.addEventListener("change", event => {
      this._selectionMode = event.currentTarget.value;
      this.render();
    });
    this.element.querySelector("[data-session-transfer-search]")?.addEventListener("input", event => {
      const query = event.currentTarget.value.trim().toLocaleLowerCase();
      for (const row of this.element.querySelectorAll("[data-session-transfer-entry]")) {
        row.hidden = Boolean(query && !row.dataset.search.includes(query));
      }
    });
  }

  static #selectActors(_event, target) {
    const mode = target.dataset.mode;
    for (const input of this.element.querySelectorAll('[name="actors"], [name="players"]')) {
      if (input.closest("[data-session-transfer-entry]")?.hidden) continue;
      input.checked = mode === "all" || (mode === "connected" && input.dataset.connected === "true");
    }
  }

  static async #exportSession() {
    return this.constructor.#run(async () => {
      const ids = Array.from(this.element.querySelectorAll('[name="actors"]:checked'), input => input.value);
      for (const input of this.element.querySelectorAll('[name="players"]:checked')) {
        ids.push(...String(input.dataset.actorIds ?? "").split(",").filter(Boolean));
      }
      const includeCompendiums = this.element.querySelector('[name="includeCompendiums"]')?.checked;
      await exportSession(ids, {
        actorRootId: this.element.querySelector('[name="actorRoot"]')?.value || "",
        includeFolders: this.element.querySelector('[name="includeActorFolders"]')?.checked ?? true,
        compendiumFolderId: includeCompendiums
          ? this.element.querySelector('[name="compendiumFolder"]')?.value || null
          : null
      });
    });
  }

  static async #importSession() {
    return this.constructor.#run(() => importSession(this.element.querySelector('[name="sessionFile"]').files[0]));
  }

  static async #exportResult() {
    return this.constructor.#run(exportSessionResult);
  }

  static async #importResult() {
    return this.constructor.#run(() => importSessionResult(this.element.querySelector('[name="resultFile"]').files[0]));
  }

  static async #saveActorRoot() {
    return this.constructor.#run(async () => {
      const folderId = this.element.querySelector('[name="actorRoot"]')?.value || "";
      await game.settings.set(MODULE_ID, SETTINGS.PLAYER_ACTOR_FOLDERS, { folderId });
      this._actorRootId = folderId;
      ui.notifications.info(game.i18n.localize("TOVF.Session.ActorRootSaved"));
    });
  }

  static async #exportCompendiums() {
    return this.constructor.#run(() => exportCompendiumFolder(
      this.element.querySelector('[name="standaloneCompendiumFolder"]')?.value
    ));
  }

  static async #importCompendiums() {
    return this.constructor.#run(() => importCompendiumFolder(
      this.element.querySelector('[name="compendiumFile"]')?.files[0],
      this.element.querySelector('[name="compendiumDestination"]')?.value || null
    ));
  }

  static async #run(action) {
    try {
      await action();
    } catch (error) {
      console.error(`${MODULE_ID} | Session transfer failed`, error);
      ui.notifications.error(error.message);
    }
  }
}

export function registerSessionTransfer() {
  game.settings.register(MODULE_ID, ROLE_SETTING, {
    name: "TOVF.Session.Role.Name",
    hint: "TOVF.Session.Role.Hint",
    scope: "world",
    config: true,
    type: String,
    choices: {
      [WORLD_ROLES.PRIMARY]: "TOVF.Session.Role.Primary",
      [WORLD_ROLES.SESSION]: "TOVF.Session.Role.Session"
    },
    default: WORLD_ROLES.SESSION,
    restricted: true,
    requiresReload: true
  });
  game.settings.registerMenu(MODULE_ID, "sessionTransfer", {
    name: "TOVF.Session.Settings.Name",
    label: "TOVF.Session.Settings.Label",
    hint: "TOVF.Session.Settings.Hint",
    icon: "fa-solid fa-people-arrows",
    type: SessionTransferConfig,
    restricted: true
  });
}

export function sessionTransferApi() {
  return {
    exportSession,
    importSession,
    exportSessionResult,
    importSessionResultFile: importSessionResult
  };
}
