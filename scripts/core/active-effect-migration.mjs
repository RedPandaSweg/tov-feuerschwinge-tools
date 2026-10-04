import { updateExistingEmbeddedDocuments } from "./document-operations.mjs?v=3.7.8-safe-documents-1";

export function migrateActiveEffectSource(source) {
  if (!source || typeof source !== "object") return source;
  const migrated = CONFIG.ActiveEffect.documentClass.migrateData(source) ?? source;
  if (migrated !== source) Object.assign(source, migrated);
  if (source.type === "standard") source.type = "base";
  return source;
}

export function migrateNestedActiveEffectSources(root) {
  const visit = value => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    const effects = sourceArray(value.effects);
    for (const effect of effects) migrateActiveEffectSource(effect);
    for (const child of Object.values(value)) visit(child);
  };
  visit(root);
  return root;
}

function sourceArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function addParentEffects(entries, parent, rawParent, source) {
  for (const rawEffect of sourceArray(rawParent?.effects)) {
    if (rawEffect?.type !== "standard") continue;
    const effectId = rawEffect._id ?? rawEffect.id;
    entries.push({
      ...source,
      kind: "embedded",
      parent,
      effectId,
      parentUuid: parent?.uuid ?? source.parentUuid,
      parentName: parent?.name ?? rawParent?.name ?? "",
      effectName: rawEffect.name ?? "Active Effect"
    });
  }
}

function addRawActorEffects(entries, actor, rawActor, source) {
  addParentEffects(entries, actor, rawActor, source);
  for (const rawItem of sourceArray(rawActor?.items)) {
    const itemId = rawItem._id ?? rawItem.id;
    addParentEffects(entries, actor?.items?.get?.(itemId), rawItem, {
      ...source,
      parentUuid: actor ? `${actor.uuid}.Item.${itemId}` : `${source.parentUuid}.Item.${itemId}`
    });
  }
}

function addActorEffects(entries, actor, source) {
  addRawActorEffects(entries, actor, actor?._source, source);
}

function addDocumentEffects(entries, document, source) {
  if (document.documentName === "Actor") addActorEffects(entries, document, source);
  else if (document.documentName === "Item") addParentEffects(entries, document, document._source, source);
  else if (document.documentName === "ActiveEffect" && document._source?.type === "standard") {
    entries.push({ ...source, kind: "document", document, effectId: document.id,
      parentUuid: document.uuid, parentName: document.name, effectName: document.name });
  }
}

function canRepairDocument(document) {
  return document?.isOwner === true;
}

export async function previewLegacyActiveEffects() {
  const entries = [];
  for (const actor of game.actors) {
    addActorEffects(entries, actor, {
      repairable: canRepairDocument(actor), sourceKey: "world", sourceLabel: "Weltdokumente"
    });
  }
  for (const item of game.items) {
    addDocumentEffects(entries, item, {
      repairable: canRepairDocument(item), sourceKey: "world", sourceLabel: "Weltdokumente"
    });
  }

  for (const pack of game.packs) {
    if (!["Actor", "Item", "ActiveEffect"].includes(pack.documentName)) continue;
    const type = pack.metadata?.packageType ?? (pack.collection.startsWith("world.") ? "world" : "module");
    const source = {
      repairable: type === "world" && !pack.locked
        && pack.testUserPermission?.(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER) === true,
      sourceKey: `pack:${pack.collection}`,
      sourceLabel: pack.metadata?.label ?? pack.title ?? pack.collection,
      pack,
      packType: type
    };
    try {
      const index = await pack.getIndex({ fields: ["name", "type", "effects", "items.name", "items.effects"] });
      for (const rawDocument of index) {
        const documentId = rawDocument._id ?? rawDocument.id;
        const document = source.repairable ? await pack.getDocument(documentId) : null;
        const packSource = { ...source, parentUuid: `Compendium.${pack.collection}.${pack.documentName}.${documentId}` };
        if (pack.documentName === "Actor") addRawActorEffects(entries, document, rawDocument, packSource);
        else if (pack.documentName === "Item") addParentEffects(entries, document, rawDocument, packSource);
        else if (rawDocument.type === "standard") {
          entries.push({ ...packSource, kind: "document", document, effectId: documentId,
            parentName: rawDocument.name, effectName: rawDocument.name });
        }
      }
    } catch (error) {
      console.warn(`tov-feuerschwinge-tools | Kompendium konnte nicht auf veraltete Active Effects geprueft werden: ${pack.collection}`, error);
    }
  }
  return entries;
}

export async function migrateLegacyWorldActiveEffects() {
  const entries = (await previewLegacyActiveEffects()).filter(entry => entry.repairable);
  const groups = new Map();
  const documents = [];
  for (const entry of entries) {
    if (entry.kind === "document") {
      documents.push(entry.document);
      continue;
    }
    if (!entry.parent) continue;
    if (!groups.has(entry.parent)) groups.set(entry.parent, []);
    groups.get(entry.parent).push({ _id: entry.effectId, type: "base" });
  }
  let migrated = 0;
  for (const [parent, updates] of groups) {
    const result = await updateExistingEmbeddedDocuments(parent, "ActiveEffect", updates);
    migrated += result.updated.length;
  }
  for (const document of documents) {
    await document.update({ type: "base" });
    migrated += 1;
  }
  return { migrated, remaining: await previewLegacyActiveEffects() };
}
