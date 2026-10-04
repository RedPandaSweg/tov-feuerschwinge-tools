import { isProjectAdministrator } from "./core/permissions.mjs?v=3.7.8-permissions-1";

const CUSTOM_PACK = "world.funktioniere-effekte";
const ORIGINAL_PACK = "black-flag.effects";

function requireAdministrator() {
  if (!isProjectAdministrator()) throw new Error("Nur ein Spielleiter kann dieses Weltkompendium ersetzen.");
}

async function effectMapping() {
  const customPack = game.packs.get(CUSTOM_PACK);
  const originalPack = game.packs.get(ORIGINAL_PACK);
  if (!customPack) return { customPack: null, mapping: new Map(), effects: [] };
  if (!originalPack) throw new Error(`Das Originalkompendium ${ORIGINAL_PACK} ist nicht verfügbar.`);
  const [custom, originals] = await Promise.all([customPack.getDocuments(), originalPack.getDocuments()]);
  const mapping = new Map();
  for (const effect of custom) {
    const matches = originals.filter(original => original.name === effect.name);
    if (matches.length !== 1) {
      throw new Error(`${effect.name}: ${matches.length} eindeutige Originaleffekte gefunden; es wurden keine Daten geändert.`);
    }
    mapping.set(effect.uuid, matches[0].uuid);
  }
  return { customPack, mapping, effects: custom };
}

function replaceReferences(value, mapping) {
  let changed = false;
  const visit = current => {
    if (typeof current === "string") {
      let result = current;
      for (const [legacy, original] of mapping) result = result.replaceAll(legacy, original);
      if (result !== current) changed = true;
      return result;
    }
    if (Array.isArray(current)) return current.map(visit);
    if (!foundry.utils.isPlainObject(current)) return current;
    return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, visit(entry)]));
  };
  return { value: visit(value), changed };
}

function embeddedTypes(document) {
  return Object.entries(document.constructor.metadata?.embedded ?? {});
}

function documentUpdate(document, mapping) {
  const source = document.toObject();
  for (const [, field] of embeddedTypes(document)) delete source[field];
  const update = {};
  let references = 0;
  for (const [key, value] of Object.entries(source)) {
    if (["_id", "_stats"].includes(key)) continue;
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") continue;
    const count = [...mapping.keys()].reduce((sum, uuid) => sum + serialized.split(uuid).length - 1, 0);
    if (!count) continue;
    const replaced = replaceReferences(value, mapping);
    if (replaced.changed) {
      update[key] = replaced.value;
      references += count;
    }
  }
  return { update, references };
}

async function collectDocuments() {
  const documents = [];
  const seen = new Set();
  const add = document => {
    if (!document?.uuid || seen.has(document.uuid)) return;
    seen.add(document.uuid);
    documents.push(document);
    for (const [documentName] of embeddedTypes(document)) {
      let collection;
      try { collection = document.getEmbeddedCollection(documentName); } catch (_error) { continue; }
      for (const embedded of collection ?? []) add(embedded);
    }
  };
  for (const collection of game.collections.values()) for (const document of collection) add(document);
  for (const pack of game.packs) {
    if (pack.collection === CUSTOM_PACK || pack.metadata.package !== "world") continue;
    for (const document of await pack.getDocuments()) add(document);
  }
  return documents;
}

async function scan(mapping) {
  const matches = [];
  for (const document of await collectDocuments()) {
    const result = documentUpdate(document, mapping);
    if (result.references) matches.push({ document, ...result });
  }
  return matches;
}

export async function previewWorkingEffectMigration() {
  requireAdministrator();
  const { customPack, mapping, effects } = await effectMapping();
  if (!customPack) return { available: false, effects: 0, documents: 0, references: 0 };
  const matches = await scan(mapping);
  return { available: true, effects: effects.length, documents: matches.length,
    references: matches.reduce((sum, match) => sum + match.references, 0) };
}

export async function applyWorkingEffectMigration() {
  requireAdministrator();
  const { customPack, mapping, effects } = await effectMapping();
  if (!customPack) return { effects: 0, documents: 0, references: 0, deleted: false };
  const matches = await scan(mapping);
  const blocked = matches.filter(({ document }) => {
    const pack = document.pack ? game.packs.get(document.pack) : null;
    return pack?.locked || !document.canUserModify(game.user, "update");
  });
  if (blocked.length) {
    throw new Error(`${blocked.length} betroffene Dokumente sind gesperrt oder nicht bearbeitbar. Es wurden keine Daten geändert.`);
  }
  for (const { document, update } of matches) await document.update(update);
  const remaining = await scan(mapping);
  if (remaining.length) throw new Error(`${remaining.length} Dokumente enthalten weiterhin Referenzen. Das Kompendium wurde nicht gelöscht.`);
  await customPack.deleteCompendium();
  return { effects: effects.length, documents: matches.length,
    references: matches.reduce((sum, match) => sum + match.references, 0), deleted: true };
}
