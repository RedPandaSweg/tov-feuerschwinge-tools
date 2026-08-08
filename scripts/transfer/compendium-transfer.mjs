import {
  MODULE_ID,
  TRANSFER_FORMAT,
  TRANSFER_FORMAT_VERSION
} from "../core/constants.mjs";

const TRANSFER_FLAG = "transfer";

function slugify(value) {
  return String(value ?? "compendium-bundle")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function folderParentId(folder) {
  return typeof folder.folder === "string" ? folder.folder : folder.folder?.id ?? null;
}

function bundleFolders(root) {
  const included = new Map([[root.id, root]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of game.packs.folders) {
      if (included.has(folder.id) || !included.has(folderParentId(folder))) continue;
      included.set(folder.id, folder);
      changed = true;
    }
  }
  return [...included.values()];
}

function transferIdFor(pack, document) {
  const existing = document.getFlag(MODULE_ID, TRANSFER_FLAG)?.id;
  if (existing) return existing;
  const packageName = pack.metadata.packageName ?? pack.metadata.package ?? "world";
  const source = packageName === "world" ? `world:${game.world.id}` : `package:${packageName}`;
  return `${source}:${pack.metadata.name ?? pack.collection}:${document.id}`;
}

function folderTransferId(sourceWorld, folderId) {
  return `CompendiumFolder:${sourceWorld}:${folderId}`;
}

async function shortHash(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

async function exportPack(pack) {
  const exportedAt = new Date().toISOString();
  const documents = (await pack.getDocuments()).map(document => {
    const data = document.toObject();
    foundry.utils.setProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}`, {
      id: transferIdFor(pack, document),
      exportedAt
    });
    return data;
  });
  const sourceId = `${pack.collection}:${game.world.id}`;
  return {
    sourceCollection: pack.collection,
    importName: `tovf-${slugify(pack.metadata.name ?? pack.title).slice(0, 32)}-${await shortHash(sourceId)}`,
    label: pack.title,
    documentType: pack.documentName,
    banner: pack.metadata.banner ?? null,
    folderId: pack.folder?.id ?? null,
    sort: pack.sort,
    ownership: foundry.utils.deepClone(pack.ownership),
    locked: pack.locked,
    folders: pack.folders.map(folder => folder.toObject()),
    documents
  };
}

function assertBundle(bundle) {
  if (bundle?.format !== TRANSFER_FORMAT || bundle.formatVersion !== TRANSFER_FORMAT_VERSION) {
    throw new Error(game.i18n.localize("TOVF.Transfer.Error.Format"));
  }
  if (bundle.source?.system !== game.system.id) {
    throw new Error(game.i18n.format("TOVF.Transfer.Error.System", { system: bundle.source?.system }));
  }
  if (!bundle.rootFolder || !Array.isArray(bundle.folders) || !Array.isArray(bundle.packs)) {
    throw new Error(game.i18n.localize("TOVF.Transfer.Error.Content"));
  }
}

export async function createCompendiumBundle(folderId) {
  const root = game.packs.folders.get(folderId);
  if (!root) throw new Error(game.i18n.localize("TOVF.Transfer.Error.FolderNotFound"));
  const folders = bundleFolders(root);
  const folderIds = new Set(folders.map(folder => folder.id));
  const packs = game.packs.filter(pack => folderIds.has(pack.folder?.id));
  const exportedPacks = [];
  for (const pack of packs) exportedPacks.push(await exportPack(pack));
  const exportedAt = new Date().toISOString();
  return {
    format: TRANSFER_FORMAT,
    formatVersion: TRANSFER_FORMAT_VERSION,
    exportedAt,
    source: {
      world: game.world.id,
      system: game.system.id,
      systemVersion: game.system.version,
      foundryVersion: game.version,
      moduleVersion: game.modules.get(MODULE_ID)?.version
    },
    rootFolder: root.id,
    folders: folders.map(folder => ({
      sourceId: folder.id,
      parentId: folderIds.has(folderParentId(folder)) ? folderParentId(folder) : null,
      name: folder.name,
      color: folder.color,
      sorting: folder.sorting,
      sort: folder.sort
    })),
    packs: exportedPacks
  };
}

export async function exportCompendiumFolder(folderId) {
  if (!game.user.isGM) throw new Error(game.i18n.localize("TOVF.Transfer.Error.GMOnly"));
  const bundle = await createCompendiumBundle(folderId);
  const root = game.packs.folders.get(folderId);
  const exportedAt = bundle.exportedAt;
  foundry.utils.saveDataToFile(
    JSON.stringify(bundle, null, 2),
    "application/json",
    `tov-feuerschwinge-compendien-${slugify(root.name)}-${exportedAt.slice(0, 10)}.json`
  );
  const documentCount = bundle.packs.reduce((total, pack) => total + pack.documents.length, 0);
  ui.notifications.info(game.i18n.format("TOVF.Transfer.Export.Complete", {
    folders: bundle.folders.length,
    packs: bundle.packs.length,
    documents: documentCount
  }));
}

async function synchronizeOuterFolders(bundle, destinationId) {
  const byTransferId = new Map(game.packs.folders.map(folder => [
    folder.getFlag(MODULE_ID, TRANSFER_FLAG)?.id,
    folder
  ]).filter(([id]) => id));
  const mapping = new Map();
  const pending = [...bundle.folders];
  while (pending.length) {
    const index = pending.findIndex(folder => !folder.parentId || mapping.has(folder.parentId));
    if (index < 0) throw new Error(game.i18n.localize("TOVF.Transfer.Error.FolderTree"));
    const source = pending.splice(index, 1)[0];
    const transferId = folderTransferId(bundle.source.world, source.sourceId);
    const parent = source.parentId ? mapping.get(source.parentId) : destinationId || null;
    let folder = byTransferId.get(transferId);
    folder ??= game.packs.folders.find(candidate => (
      candidate.name === source.name
      && folderParentId(candidate) === parent
    ));
    const data = {
      name: source.name,
      type: "Compendium",
      folder: parent,
      color: source.color,
      sorting: source.sorting,
      sort: source.sort,
      flags: { [MODULE_ID]: { [TRANSFER_FLAG]: { id: transferId } } }
    };
    if (folder) await folder.update(data);
    else folder = await foundry.documents.Folder.implementation.create(data);
    mapping.set(source.sourceId, folder.id);
  }
  return mapping;
}

async function synchronizeInternalFolders(pack, sourceFolders) {
  const existing = pack.folders;
  const updates = [];
  const creates = [];
  for (const source of sourceFolders ?? []) {
    const data = foundry.utils.deepClone(source);
    if (existing.has(data._id)) {
      delete data._stats;
      updates.push(data);
    }
    else creates.push(data);
  }
  const FolderClass = foundry.documents.Folder.implementation;
  if (updates.length) await FolderClass.updateDocuments(updates, { pack: pack.collection });
  if (creates.length) await FolderClass.createDocuments(creates, { pack: pack.collection, keepId: true });
}

function rewriteTransferredReferences(value, documentIds, collectionMapping) {
  if (typeof value === "string") {
    for (const [sourceCollection, targetCollection] of collectionMapping) {
      const prefix = `Compendium.${sourceCollection}.`;
      if (!value.startsWith(prefix)) continue;
      const parts = value.slice(prefix.length).split(".");
      if (parts.length < 2) return value;
      const sourceId = parts[1];
      parts[1] = documentIds.get(`${sourceCollection}\u0000${sourceId}`) ?? sourceId;
      return `Compendium.${targetCollection}.${parts.join(".")}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(entry => rewriteTransferredReferences(entry, documentIds, collectionMapping));
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      value[key] = rewriteTransferredReferences(entry, documentIds, collectionMapping);
    }
  }
  return value;
}

async function planDocumentSynchronization(pack, sourceDocuments, sourceCollection) {
  const existing = await pack.getDocuments();
  const byTransferId = new Map(existing.map(document => [
    document.getFlag(MODULE_ID, TRANSFER_FLAG)?.id,
    document
  ]).filter(([id]) => id));
  const byId = new Map(existing.map(document => [document.id, document]));
  const byIdentity = new Map();
  for (const document of existing) {
    const key = `${document.type ?? ""}\u0000${document.name}`;
    const matches = byIdentity.get(key) ?? [];
    matches.push(document);
    byIdentity.set(key, matches);
  }
  const plans = [];
  for (const source of sourceDocuments) {
    const data = foundry.utils.deepClone(source);
    const transferId = foundry.utils.getProperty(data, `flags.${MODULE_ID}.${TRANSFER_FLAG}.id`);
    if (!transferId) throw new Error(game.i18n.localize("TOVF.Transfer.Error.Identity"));
    const identity = `${data.type ?? ""}\u0000${data.name}`;
    const nameMatches = byIdentity.get(identity) ?? [];
    const target = byTransferId.get(transferId)
      ?? byId.get(data._id)
      ?? (nameMatches.length === 1 ? nameMatches[0] : null);
    plans.push({ data, targetId: target?.id ?? data._id, update: Boolean(target) });
  }
  return {
    plans,
    ids: plans.map(plan => [`${sourceCollection}\u0000${plan.data._id}`, plan.targetId])
  };
}

async function applyDocumentSynchronization(pack, plans, sourceCollection, documentIds, collectionMapping) {
  const create = [];
  const update = [];
  for (const plan of plans) {
    const data = rewriteTransferredReferences(
      foundry.utils.deepClone(plan.data), documentIds, collectionMapping
    );
    // Black Flag containers refer to their contents by the containing Item's
    // local ID rather than UUID. This ID can change when an import merges by
    // transfer identity or name.
    const containerId = foundry.utils.getProperty(data, "system.container");
    if (containerId) {
      foundry.utils.setProperty(data, "system.container",
        documentIds.get(`${sourceCollection}\u0000${containerId}`)
        ?? containerId
      );
    }
    if (plan.update) {
      delete data._stats;
      update.push({ ...data, _id: plan.targetId });
    }
    else create.push(data);
  }
  // Suppress intermediate Black Flag renders: while a batch is only partly
  // synchronized, a contained Item can temporarily point at a missing parent.
  if (update.length) await pack.documentClass.updateDocuments(update, { pack: pack.collection, render: false });
  if (create.length) await pack.documentClass.createDocuments(create, {
    pack: pack.collection,
    keepId: true,
    render: false
  });
  return { create: create.length, update: update.length };
}

async function preparePack(source, folderMapping) {
  const targetFolderId = folderMapping.get(source.folderId) ?? null;
  let pack = game.packs.get(`world.${source.importName}`);
  pack ??= game.packs.find(candidate => (
    (candidate.folder?.id ?? null) === targetFolderId
    && candidate.title === source.label
    && candidate.documentName === source.documentType
  ));
  if (pack && pack.documentName !== source.documentType) {
    throw new Error(game.i18n.format("TOVF.Transfer.Error.PackType", { pack: source.label }));
  }
  if (!pack) {
    pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
      name: source.importName,
      label: source.label,
      type: source.documentType,
      banner: source.banner
    });
  }
  const relock = source.locked;
  if (pack.locked) await pack.configure({ locked: false });
  try {
    await pack.setFolder(targetFolderId);
    await synchronizeInternalFolders(pack, source.folders);
    return { pack, relock };
  } catch (error) {
    if (pack.locked !== relock) await pack.configure({ locked: relock });
    throw error;
  }
}

async function confirmImport(bundle) {
  const documents = bundle.packs.reduce((total, pack) => total + pack.documents.length, 0);
  return foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("TOVF.Transfer.Import.ConfirmTitle") },
    content: `<p>${game.i18n.format("TOVF.Transfer.Import.Preview", {
      folders: bundle.folders.length,
      packs: bundle.packs.length,
      documents
    })}</p>`,
    yes: { label: game.i18n.localize("TOVF.Transfer.Import.Confirm") },
    no: { label: game.i18n.localize("Cancel") }
  });
}

export async function importCompendiumBundle(bundle, destinationId = null, { confirm = true } = {}) {
  assertBundle(bundle);
  if (confirm && !await confirmImport(bundle)) return;
  const folderMapping = await synchronizeOuterFolders(bundle, destinationId);
  const counts = { create: 0, update: 0 };
  const prepared = [];
  try {
    for (const source of bundle.packs) {
      prepared.push({ source, ...await preparePack(source, folderMapping) });
    }
    const collectionMapping = new Map(prepared.map(({ source, pack }) => [source.sourceCollection, pack.collection]));
    const documentIds = new Map();
    for (const entry of prepared) {
      entry.documentPlan = await planDocumentSynchronization(
        entry.pack, entry.source.documents, entry.source.sourceCollection
      );
      for (const mapping of entry.documentPlan.ids) documentIds.set(...mapping);
    }
    for (const { source, pack, documentPlan } of prepared) {
      const packCounts = await applyDocumentSynchronization(
        pack, documentPlan.plans, source.sourceCollection, documentIds, collectionMapping
      );
      counts.create += packCounts.create;
      counts.update += packCounts.update;
      await pack.configure({ sort: source.sort, ownership: source.ownership });
      pack.apps.forEach(app => app.render(false));
    }
  } finally {
    for (const { pack, relock } of prepared) {
      if (pack.locked !== relock) await pack.configure({ locked: relock });
    }
  }
  ui.notifications.info(game.i18n.format("TOVF.Transfer.Import.Complete", {
    packs: bundle.packs.length,
    create: counts.create,
    update: counts.update
  }));
  return counts;
}

export async function importCompendiumFolder(file, destinationId = null) {
  if (!game.user.isGM) throw new Error(game.i18n.localize("TOVF.Transfer.Error.GMOnly"));
  if (!file) throw new Error(game.i18n.localize("TOVF.Transfer.Error.FileMissing"));
  const bundle = JSON.parse(await foundry.utils.readTextFromFile(file));
  return importCompendiumBundle(bundle, destinationId);
}

export function exposeTransferApi() {
  const module = game.modules.get(MODULE_ID);
  if (module) module.api = {
    createCompendiumBundle,
    exportCompendiumFolder,
    importCompendiumBundle,
    importCompendiumFolder
  };
}
