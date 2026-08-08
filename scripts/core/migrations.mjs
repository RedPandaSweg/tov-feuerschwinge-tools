import { CONTENT_MODULE_ID, LEGACY_MODULE_ID, MODULE_ID, SCHEMA_VERSION } from "./constants.mjs";
import {
  buildLegacyItemReplacements,
  replaceLegacyDocumentUuids
} from "../tcv-link-repair.mjs";

const VERSION_SETTING = "schemaVersion";
const WEAPON_SETTING = "weaponDefinitions";

function getStoredWorldSetting(namespace, key) {
  return game.settings.storage.get("world")?.get(`${namespace}.${key}`)?.value;
}

async function migrateWeaponDefinitions() {
  const current = game.settings.get(MODULE_ID, WEAPON_SETTING);
  if (Object.keys(current?.properties ?? {}).length || Object.keys(current?.options ?? {}).length) return;

  const legacy = getStoredWorldSetting(LEGACY_MODULE_ID, WEAPON_SETTING);
  if (legacy) await game.settings.set(MODULE_ID, WEAPON_SETTING, legacy);
}

async function migrateActorFlags() {
  const updates = [];
  for (const actor of game.actors) {
    for (const item of actor.items) {
      const effectUpdates = [];
      for (const effect of item.effects) {
        const legacy = effect.flags?.[LEGACY_MODULE_ID];
        if (!legacy || effect.flags?.[MODULE_ID]) continue;
        effectUpdates.push({ _id: effect.id, [`flags.${MODULE_ID}`]: foundry.utils.deepClone(legacy) });
      }
      if (effectUpdates.length) updates.push(item.updateEmbeddedDocuments("ActiveEffect", effectUpdates));
    }
  }
  await Promise.all(updates);
}

const PACK_FOLDER_ASSIGNMENTS = {
  "01 – Ausrüstung & Zauber": [
    "items",
    "spells"
  ],
  "02 – Charakteroptionen": [
    "lineages",
    "heritages",
    "backgrounds",
    "classes",
    "subclasses",
    "talents"
  ],
  "03 – Spielleitung": ["monsters"],
  "04 – Nachschlagewerke": ["players-guide", "rules"],
  "05 – Werkzeuge": ["macros"]
};

async function assignModulePackFolders() {
  let changed = 0;
  let parent = game.packs.folders.find(entry => !entry.folder && entry.name === "ToV Feuerschwinge");
  if (!parent) {
    parent = await Folder.create({
      name: "ToV Feuerschwinge",
      type: "Compendium",
      folder: null,
      sorting: "m",
      color: "#b33a2b"
    });
    changed++;
  }

  for (const [folderName, packNames] of Object.entries(PACK_FOLDER_ASSIGNMENTS)) {
    let folder = game.packs.folders.find(entry => (
      entry.name === folderName
      && entry.folder?.id === parent.id
    ));
    folder ??= game.packs.folders.find(entry => entry.name === folderName);
    if (!folder) {
      console.warn(`${MODULE_ID} | Compendium folder "${folderName}" was not created by Foundry.`);
      continue;
    }
    if (folder.folder?.id !== parent.id) {
      await folder.update({ folder: parent.id });
      changed++;
    }
    for (const packName of packNames) {
      const pack = game.packs.get(`${CONTENT_MODULE_ID}.${packName}`);
      if (!pack) {
        console.warn(`${MODULE_ID} | Compendium "${packName}" is not available.`);
        continue;
      }
      if (pack.folder?.id === folder.id) continue;
      // Use the same v14 API as manually dragging a pack into a folder.
      await pack.setFolder(folder.id);
      changed++;
    }
  }
  return changed;
}

const PLAYER_GUIDE_PACK = `${CONTENT_MODULE_ID}.players-guide`;
const CHARACTER_REFERENCE_PACKS = Object.freeze([
  {
    pack: "backgrounds",
    type: "background",
    journalId: "xbHHscFCEyd4pWRL",
    worldPackPattern: /Compendium\.world\.[\w-]*(?:background|hintergrund)[\w-]*\.Item\.[A-Za-z0-9]+/gi
  },
  {
    pack: "lineages",
    type: "lineage",
    worldPackPattern: /Compendium\.world\.[\w-]*(?:lineage|rasse|race)[\w-]*\.Item\.[A-Za-z0-9]+/gi
  },
  {
    pack: "heritages",
    type: "heritage",
    worldPackPattern: /Compendium\.world\.[\w-]*(?:heritage|lineage-and-heritage|kultur|culture)[\w-]*\.Item\.[A-Za-z0-9]+/gi
  }
]);
const OLD_JOURNAL_REFERENCE = /Compendium\.(?:(?:world|forge-vtt-shared-compendiums-tcv-gesammt)\.[\w-]+|tov-feuerschwinge\.players-guide)\.JournalEntry\.[A-Za-z0-9]+(?:\.JournalEntryPage\.[A-Za-z0-9]+)?/g;

function normalizedDocumentName(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase(game.i18n.lang)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function replaceStrings(value, replacer) {
  if (typeof value === "string") return replacer(value);
  if (Array.isArray(value)) return value.map(entry => replaceStrings(entry, replacer));
  if (!foundry.utils.isPlainObject(value)) return value;
  for (const [key, entry] of Object.entries(value)) value[key] = replaceStrings(entry, replacer);
  return value;
}

async function withWritablePack(pack, operation) {
  const wasLocked = pack.locked;
  if (wasLocked) await pack.configure({ locked: false });
  try {
    return await operation();
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
}

const WORLD_ITEM_REFERENCE = /Compendium\.world\.([\w-]+)\.Item\.([A-Za-z0-9]+)/g;

function replacementPacksForWorldPack(worldPack) {
  if (/equipment-and-magic-items|ausrustung|equipment/i.test(worldPack)) {
    return ["black-flag.items", "kp-tov-players-guide.equipment", `${CONTENT_MODULE_ID}.items`];
  }
  if (/background|hintergrund/i.test(worldPack)) return [`${CONTENT_MODULE_ID}.backgrounds`];
  if (/talent/i.test(worldPack)) return [`${CONTENT_MODULE_ID}.talents`];
  if (/lineage-and-heritage/i.test(worldPack)) {
    return [`${CONTENT_MODULE_ID}.lineages`, `${CONTENT_MODULE_ID}.heritages`];
  }
  if (/character-classes|classes/i.test(worldPack)) {
    return [`${CONTENT_MODULE_ID}.classes`, `${CONTENT_MODULE_ID}.subclasses`];
  }
  if (/lineage|rasse|race/i.test(worldPack)) return [`${CONTENT_MODULE_ID}.lineages`];
  if (/heritage|kultur|culture/i.test(worldPack)) return [`${CONTENT_MODULE_ID}.heritages`];
  return [];
}

async function resolveWorldItemReference(uuid, cache) {
  if (cache.has(uuid)) return cache.get(uuid);
  const match = /^Compendium\.world\.([\w-]+)\.Item\.([A-Za-z0-9]+)$/.exec(uuid);
  if (!match) return null;
  const [, worldPack, id] = match;
  for (const packId of replacementPacksForWorldPack(worldPack)) {
    const candidate = `Compendium.${packId}.Item.${id}`;
    if (await fromUuid(candidate)) {
      cache.set(uuid, candidate);
      return candidate;
    }
  }
  cache.set(uuid, null);
  return null;
}

const ITEM_REFERENCE = /Compendium\.([\w-]+)\.([\w-]+)\.Item\.([A-Za-z0-9]+)/g;

function characterOptionIdentity(type, identifier, name) {
  const keys = [];
  if (identifier) keys.push(`${type}|id:${String(identifier).trim().toLocaleLowerCase(game.i18n.lang)}`);
  if (name) keys.push(`${type}|name:${String(name).trim().toLocaleLowerCase(game.i18n.lang)}`);
  return keys;
}

async function buildOriginalCharacterOptionIndex() {
  const index = new Map();
  const packs = game.packs.filter(pack => {
    const packageId = pack.metadata.packageName ?? pack.metadata.package ?? "";
    return pack.documentName === "Item" && (
      packageId === game.system.id
      || packageId === "koboldpressogl-bf"
      || packageId.startsWith("kp-tov-")
    );
  });
  await Promise.all(packs.map(async pack => {
    const entries = await pack.getIndex({ fields: ["type", "system.identifier.value"] });
    for (const entry of entries) {
      for (const key of characterOptionIdentity(
        entry.type,
        foundry.utils.getProperty(entry, "system.identifier.value"),
        entry.name
      )) {
        const matches = index.get(key) ?? [];
        matches.push(pack.getUuid(entry._id));
        index.set(key, matches);
      }
    }
  }));
  return index;
}

async function originalCharacterOption(item, index) {
  const candidates = new Set();
  for (const key of characterOptionIdentity(
    item.type,
    item.system?.identifier?.value,
    item.name
  )) {
    for (const uuid of index.get(key) ?? []) candidates.add(uuid);
  }
  const sourceUuid = item._stats?.compendiumSource ?? item.getFlag("core", "sourceId");
  if (sourceUuid && candidates.has(sourceUuid)) return fromUuid(sourceUuid);
  if (candidates.size !== 1) return null;
  return fromUuid(candidates.values().next().value);
}

function itemReferencePaths(value, path = "", references = new Map()) {
  if (typeof value === "string") {
    for (const uuid of value.match(ITEM_REFERENCE) ?? []) {
      const paths = references.get(uuid) ?? [];
      paths.push(path);
      references.set(uuid, paths);
    }
    return references;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => itemReferencePaths(entry, `${path}.${index}`, references));
    return references;
  }
  if (!foundry.utils.isPlainObject(value)) return references;
  for (const [key, entry] of Object.entries(value)) {
    itemReferencePaths(entry, path ? `${path}.${key}` : key, references);
  }
  return references;
}

async function resolveCharacterOptionItemReference(uuid, packNames, cache) {
  if (cache.has(uuid)) return cache.get(uuid);
  if (await fromUuid(uuid)) {
    cache.set(uuid, uuid);
    return uuid;
  }
  const match = /^Compendium\.([\w-]+)\.([\w-]+)\.Item\.([A-Za-z0-9]+)$/.exec(uuid);
  if (!match) return null;
  const id = match[3];
  for (const packName of packNames) {
    const candidate = `Compendium.${CONTENT_MODULE_ID}.${packName}.Item.${id}`;
    if (await fromUuid(candidate)) {
      cache.set(uuid, candidate);
      return candidate;
    }
  }
  cache.set(uuid, null);
  return null;
}

async function pruneBrokenAdvancementChoices(source, unresolved) {
  let removed = 0;
  for (const advancement of Object.values(source.system?.advancement ?? {})) {
    const choices = advancement.configuration?.choices;
    if (!Array.isArray(choices) || choices.length < 2) continue;
    const valid = [];
    const broken = [];
    for (const choice of choices) {
      const uuid = choice?.uuid;
      if (!uuid) {
        valid.push(choice);
        continue;
      }
      let document;
      try {
        document = await fromUuid(uuid);
      } catch (_error) {
        document = null;
      }
      (document ? valid : broken).push(choice);
    }
    // Never erase an entire configured choice pool automatically.
    if (!valid.length || !broken.length) continue;
    advancement.configuration.choices = valid;
    removed += broken.length;
    for (const choice of broken) unresolved.delete(choice.uuid);
  }
  return removed;
}

async function repairCharacterOptionAdvancementLinks() {
  const legacyReplacements = await buildLegacyItemReplacements();
  const originalIndex = await buildOriginalCharacterOptionIndex();
  const worldResolutionCache = new Map();
  const itemResolutionCache = new Map();
  const unresolved = new Set();
  let documents = 0;
  let references = 0;
  let removedChoices = 0;

  const definitions = [
    { pack: "backgrounds", type: "background", targets: ["backgrounds", "talents", "items"] },
    { pack: "heritages", type: "heritage", targets: ["heritages", "talents", "lineages"] }
  ];
  for (const definition of definitions) {
    const pack = game.packs.get(`${CONTENT_MODULE_ID}.${definition.pack}`);
    if (!pack) throw new Error(`Compendium ${CONTENT_MODULE_ID}.${definition.pack} is not available.`);
    await withWritablePack(pack, async () => {
      for (const item of await pack.getDocuments()) {
        if (item.type !== definition.type) continue;
        const source = item.toObject();
        const repaired = foundry.utils.deepClone(source);
        const itemReferences = itemReferencePaths(source);
        const itemReplacements = new Map();
        const original = await originalCharacterOption(item, originalIndex);
        const originalSource = original?.toObject();
        for (const [uuid, paths] of itemReferences) {
          let replacement = await resolveWorldItemReference(uuid, worldResolutionCache);
          replacement ??= await resolveCharacterOptionItemReference(
            uuid,
            definition.targets,
            itemResolutionCache
          );
          if (!replacement && originalSource) {
            for (const path of paths) {
              const originalValue = foundry.utils.getProperty(originalSource, path);
              const originalUuid = typeof originalValue === "string"
                ? originalValue.match(ITEM_REFERENCE)?.[0]
                : null;
              if (originalUuid && await fromUuid(originalUuid)) {
                replacement = originalUuid;
                break;
              }
            }
          }
          if (replacement && replacement !== uuid) itemReplacements.set(uuid, replacement);
          else if (!replacement) unresolved.add(uuid);
        }
        replaceStrings(repaired, value => value.replace(ITEM_REFERENCE, uuid => {
          const replacement = itemReplacements.get(uuid);
          if (replacement) references++;
          return replacement ?? uuid;
        }));
        const legacy = replaceLegacyDocumentUuids(repaired, legacyReplacements);
        for (const uuid of legacy.unresolved) unresolved.add(uuid);
        removedChoices += await pruneBrokenAdvancementChoices(legacy.value, unresolved);
        const changes = foundry.utils.diffObject(source, legacy.value);
        if (foundry.utils.isEmpty(changes)) continue;
        await item.update(changes);
        documents++;
      }
    });
  }
  return { documents, references, removedChoices, unresolved };
}

async function buildModuleItemIdIndex() {
  const index = new Map();
  const packs = game.packs.filter(pack => (
    pack.documentName === "Item"
    && (pack.metadata.packageName ?? pack.metadata.package) === CONTENT_MODULE_ID
  ));
  await Promise.all(packs.map(async pack => {
    for (const entry of await pack.getIndex()) {
      const candidates = index.get(entry._id) ?? [];
      candidates.push(pack.getUuid(entry._id));
      index.set(entry._id, candidates);
    }
  }));
  return index;
}

function nestedDocuments(document) {
  const documents = [document];
  for (const key of ["items", "effects", "pages"]) {
    const collection = document[key];
    if (!collection) continue;
    for (const embedded of collection) documents.push(...nestedDocuments(embedded));
  }
  return documents;
}

function sourceWithoutEmbeddedDocuments(document) {
  const source = document.toObject();
  for (const key of ["items", "effects", "pages"]) delete source[key];
  return source;
}

async function repairAllModuleItemLinks() {
  const legacyReplacements = await buildLegacyItemReplacements();
  const moduleItemsById = await buildModuleItemIdIndex();
  const worldResolutionCache = new Map();
  const resolutionCache = new Map();
  const unresolved = new Set();
  let documents = 0;
  let references = 0;

  const packs = game.packs.filter(pack => (
    (pack.metadata.packageName ?? pack.metadata.package) === CONTENT_MODULE_ID
  ));
  for (const pack of packs) {
    await withWritablePack(pack, async () => {
      for (const rootDocument of await pack.getDocuments()) {
       for (const document of nestedDocuments(rootDocument).reverse()) {
        const source = sourceWithoutEmbeddedDocuments(document);
        let repaired = foundry.utils.deepClone(source);
        const replacements = new Map();
        const itemReferences = new Set(JSON.stringify(source).match(ITEM_REFERENCE) ?? []);
        for (const uuid of itemReferences) {
          let resolves = resolutionCache.get(uuid);
          if (resolves === undefined) {
            try {
              resolves = Boolean(await fromUuid(uuid));
            } catch (_error) {
              resolves = false;
            }
            resolutionCache.set(uuid, resolves);
          }
          if (resolves) continue;

          let replacement = legacyReplacements.get(uuid) ?? null;
          replacement ??= await resolveWorldItemReference(uuid, worldResolutionCache);
          if (!replacement) {
            const match = /^Compendium\.([\w-]+)\.([\w-]+)\.Item\.([A-Za-z0-9]+)$/.exec(uuid);
            const id = match?.[3];
            const candidates = id ? moduleItemsById.get(id) ?? [] : [];
            if (candidates.length === 1) replacement = candidates[0];
          }
          if (replacement) replacements.set(uuid, replacement);
          else unresolved.add(uuid);
        }

        replaceStrings(repaired, value => value.replace(ITEM_REFERENCE, uuid => {
          const replacement = replacements.get(uuid);
          if (replacement) references++;
          return replacement ?? uuid;
        }));
        const legacy = replaceLegacyDocumentUuids(repaired, legacyReplacements);
        repaired = legacy.value;
        for (const uuid of legacy.unresolved) unresolved.add(uuid);
        const changes = foundry.utils.diffObject(source, repaired);
        if (foundry.utils.isEmpty(changes)) continue;
        await document.update(changes);
        documents++;
       }
      }
    });
  }
  return { documents, references, unresolved };
}

async function removeGeneratedMinimalJournalPages() {
  const guidePack = game.packs.get(PLAYER_GUIDE_PACK);
  if (!guidePack) throw new Error(`Compendium ${PLAYER_GUIDE_PACK} ist nicht verfügbar.`);
  const generated = [];
  for (const journal of await guidePack.getDocuments()) {
    for (const page of journal.pages) {
      const match = /^<p>@Embed\[(Compendium\.tov-feuerschwinge\.(?:backgrounds|lineages|heritages)\.Item\.[A-Za-z0-9]+) inline\]<\/p>$/.exec(
        String(page.text?.content ?? "").trim()
      );
      if (!match) continue;
      const item = await fromUuid(match[1]);
      const appendedLink = `<p>@UUID[${page.uuid}]{More Information}</p>`;
      if (!String(item?.system?.description?.value ?? "").includes(appendedLink)) continue;
      if (item.system?.description?.journal === page.uuid) continue;
      generated.push({ journal, page, itemUuid: match[1] });
    }
  }
  if (!generated.length) return 0;

  await withWritablePack(guidePack, async () => {
    for (const journal of new Set(generated.map(entry => entry.journal))) {
      const ids = generated.filter(entry => entry.journal === journal).map(entry => entry.page.id);
      await journal.deleteEmbeddedDocuments("JournalEntryPage", ids);
    }
  });

  for (const packName of ["backgrounds", "lineages", "heritages"]) {
    const pack = game.packs.get(`${CONTENT_MODULE_ID}.${packName}`);
    if (!pack) continue;
    await withWritablePack(pack, async () => {
      for (const item of await pack.getDocuments()) {
        let description = item.system?.description?.value;
        if (typeof description !== "string") continue;
        const original = description;
        for (const { page } of generated) {
          description = description.replace(
            new RegExp(`\\s*<p>@UUID\\[${page.uuid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\{More Information\\}<\\/p>`, "g"),
            ""
          );
        }
        if (description !== original) await item.update({ "system.description.value": description });
      }
    });
  }
  return generated.length;
}

async function repairCharacterOptionJournalLinks() {
  const guidePack = game.packs.get(PLAYER_GUIDE_PACK);
  if (!guidePack) throw new Error(`Compendium ${PLAYER_GUIDE_PACK} ist nicht verfügbar.`);

  const journals = await guidePack.getDocuments();
  const legacyReplacements = await buildLegacyItemReplacements();
  let itemUpdates = 0;
  let pageUpdates = 0;
  const unmatched = [];
  const ambiguous = [];
  const unresolved = new Set();

  for (const definition of CHARACTER_REFERENCE_PACKS) {
    const pack = game.packs.get(`${CONTENT_MODULE_ID}.${definition.pack}`);
    if (!pack) throw new Error(`Compendium ${CONTENT_MODULE_ID}.${definition.pack} ist nicht verfügbar.`);
    const items = (await pack.getDocuments()).filter(item => item.type === definition.type);
    const itemNames = new Set(items.map(item => normalizedDocumentName(item.name)));
    let journal;
    if (definition.journalId) {
      journal = journals.find(entry => entry.id === definition.journalId);
      if (!journal) {
        throw new Error(`Journal ${PLAYER_GUIDE_PACK}.${definition.journalId} ist nicht verfügbar.`);
      }
    } else {
      const ranked = journals
        .map(entry => ({
          journal: entry,
          matches: new Set(
            entry.pages
              .map(page => normalizedDocumentName(page.name))
              .filter(name => itemNames.has(name))
          ).size
        }))
        .sort((a, b) => b.matches - a.matches);
      if (!ranked[0]?.matches || ranked[0].matches === ranked[1]?.matches) {
        throw new Error(`Das Journal für ${definition.type} konnte nicht eindeutig bestimmt werden.`);
      }
      journal = ranked[0].journal;
    }
    const pagesByName = new Map();
    for (const page of journal.pages) {
      const key = normalizedDocumentName(page.name);
      const pages = pagesByName.get(key) ?? [];
      pages.push(page);
      pagesByName.set(key, pages);
    }

    await withWritablePack(pack, async () => {
      for (const item of items) {
        const pageName = normalizedDocumentName(item.name);
        const pages = pagesByName.get(pageName) ?? [];
        if (!pages.length) {
          unmatched.push(`${definition.type}: ${item.name}`);
          continue;
        }
        if (pages.length > 1) {
          ambiguous.push(`${definition.type}: ${item.name}`);
          continue;
        }

        const page = pages[0];
        const source = item.toObject();
        const repaired = replaceStrings(foundry.utils.deepClone(source), value => (
          value.replace(OLD_JOURNAL_REFERENCE, page.uuid)
        ));
        foundry.utils.setProperty(repaired, "system.description.journal", page.uuid);
        const changes = foundry.utils.diffObject(source, repaired);
        if (!foundry.utils.isEmpty(changes)) {
          await item.update(changes);
          itemUpdates++;
        }

        if (page.type !== "text") continue;
        const originalContent = page.text?.content ?? "";
        let content = replaceLegacyDocumentUuids(originalContent, legacyReplacements);
        for (const uuid of content.unresolved) unresolved.add(uuid);
        content = content.value.replace(definition.worldPackPattern, item.uuid);
        if (content !== originalContent) {
          await withWritablePack(guidePack, () => page.update({ "text.content": content }));
          pageUpdates++;
        }
      }
    });
  }

  if (ambiguous.length) {
    throw new Error(`Mehrdeutige Journalseiten: ${ambiguous.join(", ")}`);
  }
  console.info(
    `${MODULE_ID} | Character-option journal repair: ${itemUpdates} Items, `
    + `${pageUpdates} pages; ${unmatched.length} unmatched; ${unresolved.size} unresolved legacy UUIDs.`,
    { unmatched, unresolved: [...unresolved] }
  );
  return { itemUpdates, pageUpdates, unmatched, unresolved };
}

export function registerMigrationSettings() {
  game.settings.register(MODULE_ID, VERSION_SETTING, {
    scope: "world",
    config: false,
    type: Number,
    default: 0
  });
}

export async function runMigrations() {
  if (!game.user.isGM) return;
  const version = game.settings.get(MODULE_ID, VERSION_SETTING);
  if (version >= SCHEMA_VERSION) return;

  if (version < 1) {
    await migrateWeaponDefinitions();
    await migrateActorFlags();
  }

  if (version < 7 && await assignModulePackFolders()) {
    ui.notifications.info(game.i18n.localize("TOVF.Migration.PackFoldersAssigned"));
  }

  if (version < 8) {
    const result = await repairCharacterOptionJournalLinks();
    const details = result.unmatched.length || result.unresolved.size
      ? ` (${result.unmatched.length} ohne passende Seite, ${result.unresolved.size} alte Verweise offen)`
      : "";
    ui.notifications.info(
      `${result.itemUpdates} Background-/Lineage-Links und ${result.pageUpdates} Journalseiten repariert${details}.`,
      { permanent: Boolean(result.unmatched.length || result.unresolved.size) }
    );
  }

  if (version >= 8 && version < 9) {
    const result = await repairCharacterOptionJournalLinks();
    ui.notifications.info(
      `${result.itemUpdates} Background-/Lineage-Links und ${result.pageUpdates} Journalseiten ergänzt oder repariert.`,
      { permanent: true }
    );
  }

  if (version < 10) {
    const removedPages = await removeGeneratedMinimalJournalPages();
    const result = await repairCharacterOptionAdvancementLinks();
    ui.notifications.info(
      `${result.references} Background-Itemverweise in ${result.documents} Backgrounds repariert; `
      + `${removedPages} irrtümliche Minimal-Journalseiten entfernt; `
      + `${result.unresolved.size} Verweise blieben offen.`,
      { permanent: true }
    );
  }

  if (version >= 10 && version < 11) {
    const journals = await repairCharacterOptionJournalLinks();
    const advancements = await repairCharacterOptionAdvancementLinks();
    ui.notifications.info(
      `${journals.itemUpdates} Background-/Lineage-/Heritage-Links und `
      + `${journals.pageUpdates} Journalseiten repariert; `
      + `${advancements.references} Talent-/Feature-Verweise in `
      + `${advancements.documents} Charakteroptionen repariert; `
      + `${journals.unmatched.length + journals.unresolved.size + advancements.unresolved.size} Verweise blieben offen.`,
      { permanent: true }
    );
  }

  if (version >= 11 && version < 12) {
    const result = await repairCharacterOptionAdvancementLinks();
    ui.notifications.info(
      `${result.references} veraltete Feature-/Talent-Verweise in `
      + `${result.documents} Backgrounds oder Heritages repariert; `
      + `${result.unresolved.size} Verweise blieben offen.`,
      { permanent: true }
    );
  }

  if (version < 13) {
    const characterOptions = await repairCharacterOptionAdvancementLinks();
    const result = await repairAllModuleItemLinks();
    ui.notifications.info(
      `${result.references} veraltete Item-Verweise in `
      + `${result.documents} Feuerschwinge-Dokumenten packübergreifend repariert; `
      + `${characterOptions.references} weitere Background-/Heritage-Grants repariert; `
      + `${characterOptions.removedChoices} unerreichbare Choice-Einträge entfernt; `
      + `${new Set([...result.unresolved, ...characterOptions.unresolved]).size} Verweise blieben offen.`,
      { permanent: true }
    );
  }

  await game.settings.set(MODULE_ID, VERSION_SETTING, SCHEMA_VERSION);
  ui.notifications.info(game.i18n.localize("TOVF.Migration.Complete"));
}
