import { CONTENT_MODULE_ID, MODULE_ID, modulePath } from "./core/constants.mjs";
import { uiText } from "./core/localization.mjs";
import { isOperationalGM, isProjectAdministrator } from "./core/permissions.mjs";
import { ContentAssetImporter } from "./import/content-assets.mjs?v=3.8.0-content-module-assets-1";

const DND5E_SYSTEM_ID = "dnd5e";
const BATCH_SIZE = 50;
const CONTENT_TARGET_PACKS = new Set([`${CONTENT_MODULE_ID}.items`, `${CONTENT_MODULE_ID}.spells`]);
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function isDnd5eItemPack(pack) {
  return pack?.documentName === "Item" && (
    pack.metadata?.system === DND5E_SYSTEM_ID
    || pack.metadata?.packageName === DND5E_SYSTEM_ID
  );
}

function canWriteItemPack(pack) {
  if (pack?.documentName !== "Item") return false;
  if (pack.metadata?.packageName === CONTENT_MODULE_ID) {
    return isProjectAdministrator() && CONTENT_TARGET_PACKS.has(pack.collection);
  }
  if (pack.metadata?.packageName === "world") return isOperationalGM();
  return !pack.locked && pack.testUserPermission?.(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

async function createTargetPack() {
  if (!isOperationalGM()) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.GM", "Für diesen Import wird eine Spielleitung benötigt."));
  const label = await foundry.applications.api.DialogV2.prompt({
    window: { title: uiText("TOVF.Dnd5eImporter.CreateTarget", "Ziel-Compendium erstellen") },
    content: `<div class="form-group"><label>Name</label><input name="label" type="text" required autofocus></div>`,
    ok: { label: "Erstellen", callback: (_event, button) => button.form.elements.label.value.trim() },
    rejectClose: false
  });
  if (!label) return null;
  return foundry.documents.collections.CompendiumCollection.createCompendium({
    type: "Item",
    label,
    package: "world"
  });
}

function isContentPack(pack) {
  return pack?.metadata?.packageName === CONTENT_MODULE_ID;
}

function itemType(source) {
  if (source.type === "spell") return "spell";
  if (source.type === "feat") return "feature";
  if (source.type === "race") return "lineage";
  if (["background", "class", "subclass"].includes(source.type)) return source.type;
  if (source.type === "weapon") return "weapon";
  if (source.type === "tool") return "tool";
  if (source.type === "consumable") return "consumable";
  if (source.type === "container") return "container";
  if (source.type === "equipment" && source.system?.type?.base === "armor") return "armor";
  if (source.type === "equipment" && source.system?.type?.base === "shield") return "armor";
  // Black Flag represents vehicles as Actors rather than inventory Items.
  // Keep D&D5e vehicles (and mounts, which already fall through here) usable
  // in an Item compendium by importing them as ordinary gear.
  if (source.type === "equipment" && source.system?.type?.base === "vehicle") return "gear";
  if (source.type === "equipment" && source.system?.type?.base === "ammunition") return "ammunition";
  return "gear";
}

function scalarValue(value, fallback = "") {
  return value && typeof value === "object" && "value" in value ? value.value : (value ?? fallback);
}

const CATEGORY_CONFIGS = Object.freeze({
  ammunition: ["ammunition"], armor: ["armor", "armorCategories"], consumable: ["consumableCategories"],
  container: ["containerCategories"], gear: ["gearCategories"], sundry: ["sundryCategories"],
  tool: ["toolCategories", "tools"], weapon: ["weaponCategories", "weapons"]
});
const CATEGORY_FALLBACKS = Object.freeze({
  ammunition: ["ammunition"], armor: ["light", "medium", "heavy", "shield"], consumable: ["potion", "scroll"],
  container: ["container"], gear: ["wondrous", "adventuringGear", "adventuring"], sundry: ["other"],
  tool: ["artisan", "other"], weapon: ["simple", "martial"]
});

// D&D5e uses compact internal IDs such as "martialM" and "ammo" while
// Black Flag category IDs are configured by the active system. These are
// aliases only: the active Black Flag configuration remains authoritative.
const DND_CATEGORY_ALIASES = Object.freeze({
  ammo: ["ammunition"],
  martialm: ["martial"], martialr: ["martial"],
  simplem: ["simple"], simpler: ["simple"],
  adventuringgear: ["adventuringGear", "adventuring"],
  foodanddrink: ["food", "rations"],
  gamingset: ["gamingSet", "gaming"],
  musicalinstrument: ["musicalInstrument", "musical"],
  vehicleland: ["vehicle"], vehiclewater: ["vehicle"],
  art: ["artisan"], game: ["gamingSet", "gaming"],
  music: ["musicalInstrument", "musical"],
  thief: ["thieves", "thief"],
  land: ["vehicle"], water: ["vehicle"]
});

function categoryKey(value) {
  return String(value ?? "").replace(/[^a-z0-9]/gi, "").toLocaleLowerCase("en");
}

function blackFlagCategories(itemType) {
  for (const name of CATEGORY_CONFIGS[itemType] ?? []) {
    const definition = CONFIG.BlackFlag?.[name];
    const categories = definition?.localized ?? definition;
    if (categories && typeof categories === "object") {
      const keys = Object.keys(categories).filter(key => key !== "localized");
      if (keys.length) return keys;
    }
  }
  return [];
}

function sourceItemType(source, targetType) {
  const type = source?.system?.type ?? {};
  const sourceCategory = String(scalarValue(type.value, "")).trim();
  const base = String(scalarValue(type.base, "")).trim();
  const categories = blackFlagCategories(targetType);
  const candidates = [sourceCategory, base];
  for (const candidate of [...candidates]) {
    candidates.push(...(DND_CATEGORY_ALIASES[categoryKey(candidate)] ?? []));
  }
  candidates.push(...(CATEGORY_FALLBACKS[targetType] ?? []));
  const category = candidates
    .map(candidate => categories.find(available => categoryKey(available) === categoryKey(candidate)))
    .find(Boolean) ?? categories[0] ?? "";
  return {
    // Only write category keys that the active Black Flag installation
    // actually exposes; schema normalization otherwise clears unknown keys.
    category,
    value: base
  };
}

function sourceRarity(source) {
  const raw = String(scalarValue(source?.system?.rarity, "")).trim().toLocaleLowerCase();
  const normalized = raw.replace(/[\s_-]/g, "");
  return ({ common: "common", uncommon: "uncommon", rare: "rare", veryrare: "veryRare",
    legendary: "legendary", artifact: "artifact", mundane: "mundane" })[normalized] ?? "";
}

const DND_SPELL_SCHOOLS = Object.freeze({
  abj: "abjuration", con: "conjuration", div: "divination", enc: "enchantment",
  evo: "evocation", ill: "illusion", nec: "necromancy", trs: "transmutation"
});

function sourceSpellSchool(source) {
  const raw = String(scalarValue(source?.system?.school, "")).trim().toLocaleLowerCase();
  const school = DND_SPELL_SCHOOLS[raw] ?? raw;
  // Do not write an ID which the active Black Flag installation does not know.
  return CONFIG.BlackFlag?.spellSchools?.[school] ? school : "";
}

function sourceData(source) {
  const raw = source?.system?.source;
  const book = typeof raw === "string"
    ? raw.trim()
    : String(raw?.book || raw?.custom || "").trim();
  const page = typeof raw === "object" ? String(raw?.page ?? "").trim() : "";
  if (!book) return {};
  return { book: book.startsWith("DnD: ") ? book : `DnD: ${book}`, fallback: "", page };
}

async function convertItem(source, sourcePack, { assetImporter = null, folder = null } = {}) {
  const sourceSystem = source.system ?? {};
  const quantity = scalarValue(sourceSystem.quantity, 1);
  const weight = scalarValue(sourceSystem.weight, "");
  const price = foundry.utils.deepClone(sourceSystem.price ?? {});
  const rarity = sourceRarity(source);
  const description = assetImporter
    ? await assetImporter.importHtml(sourceSystem.description?.value ?? "")
    : sourceSystem.description?.value ?? "";
  const image = assetImporter ? await assetImporter.import(source.img) : source.img;
  const data = {
    name: source.name,
    type: itemType(source),
    img: image,
    folder,
    system: {
      description: { value: description, source: sourceData(source) },
      quantity: { value: Number.isFinite(Number(quantity)) ? Number(quantity) : 1 },
      weight: { value: Number.isFinite(Number(weight)) ? Number(weight) : 0 },
      price,
      type: sourceItemType(source, itemType(source)),
      rarity
    },
    flags: {
      [MODULE_ID]: {
        importedItem: {
          sourceUuid: source.uuid ?? `Compendium.${sourcePack.collection}.Item.${source.id ?? source._id}`,
          sourcePack: sourcePack.collection,
          importedAt: new Date().toISOString(),
          sourceSystem: DND5E_SYSTEM_ID
        }
      }
    }
  };
  if (source.type === "spell") {
    const level = scalarValue(sourceSystem.level, 0);
    data.system.circle = { value: Number.isFinite(Number(level)) ? Number(level) : 0 };
    const school = sourceSpellSchool(source);
    if (school) data.system.school = school;
  }

  // Let the active system apply its schema defaults and discard incompatible
  // D&D5e-only fields before the document is written to the target pack.
  try {
    const converted = Item.implementation.fromSource(data, { strict: false }).toObject();
    // Black Flag's data model initializes physical Items as mundane while it
    // normalizes their type. Apply the valid D&D5e rarity afterward so that
    // this initialization cannot erase an imported magic item's rarity.
    if (rarity) converted.system.rarity = rarity;
    // Containers and a few other Black Flag item types intentionally have no
    // `system.type` field. They are already normalized correctly; do not turn
    // that normal condition into a warning or discard the normalized result.
    const category = data.system.type.category;
    if (category && converted.system?.type) converted.system.type.category = category;
    return converted;
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not fully normalize imported item "${source.name}".`, error);
    return data;
  }
}

function folderId(folder) {
  return folder?._id ?? folder?.id;
}

function parentFolderId(folder) {
  return folder?.folder?._id ?? folder?.folder?.id ?? folder?.folder ?? null;
}

async function synchronizeFolders(sourceCollection, sourceFolders, targetPack) {
  const mapping = new Map();
  const pending = [...sourceFolders];
  const FolderClass = foundry.documents.Folder.implementation;
  while (pending.length) {
    let progressed = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const source = pending[index];
      const parentId = parentFolderId(source);
      if (parentId && !mapping.has(parentId)) continue;
      const sourceId = folderId(source);
      const identity = `${sourceCollection}:${sourceId}`;
      let folder = targetPack.folders.find(candidate => (
        candidate.getFlag?.(MODULE_ID, "dnd5eImportFolder") === identity
      ));
      const data = {
        name: source.name,
        type: "Item",
        folder: parentId ? mapping.get(parentId) : null,
        color: source.color,
        sorting: source.sorting,
        sort: source.sort,
        flags: { [MODULE_ID]: { dnd5eImportFolder: identity } }
      };
      if (folder) await folder.update(data);
      else folder = await FolderClass.create(data, { pack: targetPack.collection });
      mapping.set(sourceId, folder.id);
      pending.splice(index, 1);
      progressed = true;
    }
    if (!progressed) throw new Error("Die Quellordner enthalten eine ungültige Hierarchie.");
  }
  return mapping;
}

function importedDndItem(document) {
  return document.getFlag?.(MODULE_ID, "importedItem")?.sourceSystem === DND5E_SYSTEM_ID;
}

async function replaceableImportsByName(targetPack) {
  const byName = new Map();
  for (const document of await targetPack.getDocuments()) {
    if (!importedDndItem(document)) continue;
    const name = document.name.trim().toLocaleLowerCase();
    const matches = byName.get(name) ?? [];
    matches.push(document.id);
    byName.set(name, matches);
  }
  return byName;
}

async function importItems(sourcePack, targetPack, { query = "", skipDuplicates = true, replaceExisting = false } = {}) {
  if (!isOperationalGM()) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.GM", "Für diesen Import wird eine Spielleitung benötigt."));
  if (!isDnd5eItemPack(sourcePack)) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Source", "Wähle ein D&D5e-Item-Kompendium als Quelle."));
  if (!canWriteItemPack(targetPack)) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Target", "Wähle ein beschreibbares Item-Kompendium als Ziel."));
  if (isContentPack(targetPack) && !isProjectAdministrator()) {
    throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Admin", "Nur ein vollständiger Spielleiter darf das Feuerschwinge-Content-Modul bearbeiten."));
  }

  const wasLocked = targetPack.locked;
  if (wasLocked) await targetPack.configure({ locked: false });
  try {
    const needle = query.trim().toLocaleLowerCase();
    const sourceItems = (await sourcePack.getDocuments())
      .filter(item => !needle || item.name.toLocaleLowerCase().includes(needle));
    const existingNames = new Set((await targetPack.getIndex({ fields: ["name"] }))
      .map(entry => entry.name.trim().toLocaleLowerCase()));
    const replaceable = replaceExisting ? await replaceableImportsByName(targetPack) : new Map();
    const folderMapping = await synchronizeFolders(sourcePack.collection, sourcePack.folders, targetPack);
    const assetImporter = isContentPack(targetPack)
      ? await ContentAssetImporter.create(sourcePack.metadata?.packageName ?? DND5E_SYSTEM_ID)
      : null;
    const imported = [];
    const replacedIds = new Set();
    let skipped = 0;
    for (const source of sourceItems) {
      if (skipDuplicates && existingNames.has(source.name.trim().toLocaleLowerCase())) {
        skipped += 1;
        continue;
      }
      if (replaceExisting) {
        for (const id of replaceable.get(source.name.trim().toLocaleLowerCase()) ?? []) replacedIds.add(id);
      }
      const sourceFolderId = source.folder?.id ?? source.folder ?? null;
      imported.push(await convertItem(source, sourcePack, {
        assetImporter,
        folder: sourceFolderId ? folderMapping.get(sourceFolderId) ?? null : null
      }));
      existingNames.add(source.name.trim().toLocaleLowerCase());
    }
    await assetImporter?.save();
    if (replacedIds.size) await targetPack.documentClass.deleteDocuments([...replacedIds], { pack: targetPack.collection });
    for (let index = 0; index < imported.length; index += BATCH_SIZE) {
      const batch = imported.slice(index, index + BATCH_SIZE);
      await targetPack.documentClass.createDocuments(batch, { pack: targetPack.collection });
    }
    return {
      found: sourceItems.length,
      imported: imported.length,
      skipped,
      replaced: replacedIds.size,
      uploaded: assetImporter?.uploaded ?? 0,
      reused: assetImporter?.reused ?? 0
    };
  } finally {
    if (targetPack.locked !== wasLocked) await targetPack.configure({ locked: wasLocked });
  }
}

function assertBundle(bundle) {
  if (bundle?.format !== "tov-feuerschwinge-dnd5e-content" || bundle.version !== 1
    || bundle.source?.system !== "dnd5e" || !Array.isArray(bundle.documents)
    || !Array.isArray(bundle.folders) || !Array.isArray(bundle.assets)) {
    throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Bundle", "Die Datei ist kein unterstütztes Feuerschwinge-D&D5e-Bundle."));
  }
}

async function importBundle(file, targetPack, { skipDuplicates = true, replaceExisting = false } = {}) {
  if (!file) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.BundleFile", "Wähle zuerst eine D&D5e-Transferdatei aus."));
  if (!canWriteItemPack(targetPack)) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Target", "Wähle ein beschreibbares Item-Kompendium als Ziel."));
  if (isContentPack(targetPack) && !isProjectAdministrator()) {
    throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Admin", "Nur ein vollständiger Spielleiter darf das Feuerschwinge-Content-Modul bearbeiten."));
  }
  const bundle = JSON.parse(await file.text());
  assertBundle(bundle);
  const wasLocked = targetPack.locked;
  if (wasLocked) await targetPack.configure({ locked: false });
  try {
    const existingNames = new Set((await targetPack.getIndex({ fields: ["name"] }))
      .map(entry => entry.name.trim().toLocaleLowerCase()));
    const replaceable = replaceExisting ? await replaceableImportsByName(targetPack) : new Map();
    const sourceCollection = bundle.source.collection ?? `bundle.${bundle.source.package}`;
    const folderMapping = await synchronizeFolders(sourceCollection, bundle.folders, targetPack);
    const assetImporter = await ContentAssetImporter.create(
      bundle.source.assetNamespace ?? bundle.source.package ?? "dnd5e",
      bundle
    );
    const imported = [];
    const replacedIds = new Set();
    let skipped = 0;
    for (const source of bundle.documents) {
      const name = String(source.name ?? "").trim().toLocaleLowerCase();
      if (skipDuplicates && existingNames.has(name)) {
        skipped += 1;
        continue;
      }
      if (replaceExisting) {
        for (const id of replaceable.get(name) ?? []) replacedIds.add(id);
      }
      const sourceFolderId = source.folder?._id ?? source.folder?.id ?? source.folder ?? null;
      imported.push(await convertItem(source, {
        collection: sourceCollection,
        metadata: { packageName: bundle.source.package ?? "dnd5e" }
      }, {
        assetImporter,
        folder: sourceFolderId ? folderMapping.get(sourceFolderId) ?? null : null
      }));
      existingNames.add(name);
    }
    await assetImporter.save();
    if (replacedIds.size) await targetPack.documentClass.deleteDocuments([...replacedIds], { pack: targetPack.collection });
    for (let index = 0; index < imported.length; index += BATCH_SIZE) {
      await targetPack.documentClass.createDocuments(imported.slice(index, index + BATCH_SIZE), {
        pack: targetPack.collection
      });
    }
    return {
      found: bundle.documents.length,
      imported: imported.length,
      skipped,
      replaced: replacedIds.size,
      uploaded: assetImporter.uploaded,
      reused: assetImporter.reused
    };
  } finally {
    if (targetPack.locked !== wasLocked) await targetPack.configure({ locked: wasLocked });
  }
}

function jsonItemSources(value) {
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(value?.items)
      ? value.items
      : Array.isArray(value?.documents)
        ? value.documents
        : [value];
  const items = entries.filter(entry => entry && typeof entry === "object" && typeof entry.type === "string");
  if (!items.length) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Json", "Die JSON-Datei enthält keine importierbaren D&D5e-Items."));
  return items;
}

async function importJsonItems(file, targetPack, { skipDuplicates = true, replaceExisting = false } = {}) {
  if (!file) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.JsonFile", "Wähle zuerst eine JSON-Datei aus."));
  if (!canWriteItemPack(targetPack)) throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Target", "Wähle ein beschreibbares Item-Kompendium als Ziel."));
  if (isContentPack(targetPack) && !isProjectAdministrator()) {
    throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Admin", "Nur ein vollständiger Spielleiter darf das Feuerschwinge-Content-Modul bearbeiten."));
  }
  let source;
  try { source = JSON.parse(await file.text()); }
  catch { throw new Error(uiText("TOVF.Dnd5eImporter.Errors.Json", "Die JSON-Datei enthält keine importierbaren D&D5e-Items.")); }
  const sources = jsonItemSources(source);
  const wasLocked = targetPack.locked;
  if (wasLocked) await targetPack.configure({ locked: false });
  try {
    const existingNames = new Set((await targetPack.getIndex({ fields: ["name"] }))
      .map(entry => entry.name.trim().toLocaleLowerCase()));
    const replaceable = replaceExisting ? await replaceableImportsByName(targetPack) : new Map();
    const assetImporter = isContentPack(targetPack) ? await ContentAssetImporter.create("dnd5e") : null;
    const imported = [];
    const replacedIds = new Set();
    let skipped = 0;
    for (const item of sources) {
      const name = String(item.name ?? "").trim().toLocaleLowerCase();
      if (!name || (skipDuplicates && existingNames.has(name))) {
        skipped += 1;
        continue;
      }
      if (replaceExisting) {
        for (const id of replaceable.get(name) ?? []) replacedIds.add(id);
      }
      imported.push(await convertItem(item, {
        collection: "json.dnd5e-items",
        metadata: { packageName: "dnd5e" }
      }, { assetImporter }));
      existingNames.add(name);
    }
    await assetImporter?.save();
    if (replacedIds.size) await targetPack.documentClass.deleteDocuments([...replacedIds], { pack: targetPack.collection });
    for (let index = 0; index < imported.length; index += BATCH_SIZE) {
      await targetPack.documentClass.createDocuments(imported.slice(index, index + BATCH_SIZE), {
        pack: targetPack.collection
      });
    }
    return { found: sources.length, imported: imported.length, skipped, replaced: replacedIds.size,
      uploaded: assetImporter?.uploaded ?? 0, reused: assetImporter?.reused ?? 0 };
  } finally {
    if (targetPack.locked !== wasLocked) await targetPack.configure({ locked: wasLocked });
  }
}

class Dnd5eItemImporter extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-dnd5e-item-importer",
    tag: "form",
    classes: ["standard-form", "tovf-dnd5e-item-importer"],
    position: { width: 620, height: "auto" },
    window: { title: uiText("TOVF.Dnd5eImporter.Title", "D&D5e-Inhalte importieren"), resizable: true },
    actions: { import: this.#import, importBundle: this.#importBundle, importJson: this.#importJson, createTarget: this.#createTarget }
  };

  static PARTS = { form: { template: modulePath("templates/dnd5e-item-importer.hbs") } };

  async _prepareContext(options) {
    const itemPacks = [...game.packs].filter(pack => pack?.documentName === "Item");
    console.debug(`${MODULE_ID} | D&D5e importer pack detection`, itemPacks.map(pack => ({
      collection: pack.collection,
      title: pack.title,
      system: pack.metadata?.system ?? null,
      packageName: pack.metadata?.packageName ?? null,
      dnd5eSource: isDnd5eItemPack(pack)
    })));
    return {
      ...(await super._prepareContext(options)),
      sourcePacks: itemPacks.filter(isDnd5eItemPack)
        .map(pack => ({ id: pack.collection, name: `${pack.title} (${pack.collection})` })),
      targetPacks: [...game.packs].filter(canWriteItemPack)
        .map(pack => ({
          id: pack.collection,
          name: `${pack.title} (${pack.collection})${isContentPack(pack) ? " – Assets werden übernommen" : ""}`
        })),
      bundleTargetPacks: [...game.packs].filter(canWriteItemPack)
        .map(pack => ({ id: pack.collection, name: `${pack.title} (${pack.collection})` })),
      ddbImporterActive: game.modules.get("ddb-importer")?.active === true,
      labels: {
        bundleTitle: uiText("TOVF.Dnd5eImporter.Bundle.Title", "Transfer aus einer D&D5e-Welt"),
        bundleHint: uiText("TOVF.Dnd5eImporter.Bundle.Hint", "Nur für eine zuvor exportierte Feuerschwinge-Transferdatei."),
        bundleFile: uiText("TOVF.Dnd5eImporter.Bundle.File", "Transferdatei"),
        bundleImport: uiText("TOVF.Dnd5eImporter.Bundle.Import", "Transferdatei importieren"),
        jsonTitle: uiText("TOVF.Dnd5eImporter.Json.Title", "Einzelne D&D5e-Items importieren"),
        jsonHint: uiText("TOVF.Dnd5eImporter.Json.Hint", "Akzeptiert ein exportiertes Item, eine Item-Liste oder ein Objekt mit items."),
        jsonFile: uiText("TOVF.Dnd5eImporter.Json.File", "Item-JSON-Datei"),
        jsonImport: uiText("TOVF.Dnd5eImporter.Json.Import", "Item-JSON importieren"),
        hint: uiText("TOVF.Dnd5eImporter.Hint", "Wähle unten ein aktiviertes D&D5e-Item-Kompendium. JSON-Dateien oder .ldb-Dateien werden dafür nicht benötigt."),
        ddbHint: uiText("TOVF.Dnd5eImporter.DdbHint", "DDB Importer ist aktiv. Wähle anschließend dessen Item- oder Zauber-Kompendium als Quelle."),
        source: uiText("TOVF.Dnd5eImporter.Source", "Quellkompendium"),
        target: uiText("TOVF.Dnd5eImporter.Target", "Zielkompendium"),
        filter: uiText("TOVF.Dnd5eImporter.Filter", "Namensfilter"),
        filterHint: uiText("TOVF.Dnd5eImporter.FilterHint", "Optional: nur Items mit passendem Namen importieren"),
        duplicates: uiText("TOVF.Dnd5eImporter.Duplicates", "Vorhandene Namen überspringen"),
        targetHint: uiText("TOVF.Dnd5eImporter.TargetHint", "Wähle das Ziel-Kompendium für die konvertierten Items."),
        import: uiText("TOVF.Dnd5eImporter.Import", "Inhalte importieren"),
        noSource: uiText("TOVF.Dnd5eImporter.NoSource", "Kein aktiviertes D&D5e-Item-Kompendium gefunden."),
        noTarget: uiText("TOVF.Dnd5eImporter.NoTarget", "Kein beschreibbares Item-Kompendium gefunden."),
        createTarget: uiText("TOVF.Dnd5eImporter.CreateTarget", "Ziel-Compendium erstellen"),
        replace: uiText("TOVF.Dnd5eImporter.Replace", "Frühere D&D-Importe mit gleichem Namen ersetzen")
      }
    };
  }

  static async #import(event) {
    event.preventDefault();
    const form = this.element;
    try {
      const source = game.packs.get(form.querySelector('[name="sourcePack"]')?.value);
      const destination = game.packs.get(form.querySelector('[name="targetPack"]')?.value);
      const replaceExisting = form.querySelector('[name="replaceExisting"]')?.checked === true;
      const result = await importItems(source, destination, {
        query: form.querySelector('[name="query"]')?.value ?? "",
        skipDuplicates: !replaceExisting && form.querySelector('[name="skipDuplicates"]')?.checked !== false,
        replaceExisting
      });
      ui.notifications.info(uiText("TOVF.Dnd5eImporter.Result", "{imported} von {found} Items importiert; {skipped} vorhandene Namen übersprungen. Bilder: {uploaded} neu, {reused} wiederverwendet.", result));
    } catch (error) {
      console.error(`${MODULE_ID} | D&D5e item import failed.`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #importBundle(event) {
    event.preventDefault();
    try {
      const destination = game.packs.get(this.element.querySelector('[name="bundleTargetPack"]')?.value);
      const replaceExisting = this.element.querySelector('[name="bundleReplaceExisting"]')?.checked === true;
      const result = await importBundle(
        this.element.querySelector('[name="bundleFile"]')?.files?.[0],
        destination,
        { skipDuplicates: !replaceExisting && this.element.querySelector('[name="bundleSkipDuplicates"]')?.checked !== false, replaceExisting }
      );
      ui.notifications.info(uiText("TOVF.Dnd5eImporter.Result", "{imported} von {found} Items importiert; {skipped} vorhandene Namen übersprungen. Bilder: {uploaded} neu, {reused} wiederverwendet.", result));
    } catch (error) {
      console.error(`${MODULE_ID} | D&D5e bundle import failed.`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #importJson(event) {
    event.preventDefault();
    try {
      const destination = game.packs.get(this.element.querySelector('[name="jsonTargetPack"]')?.value);
      const replaceExisting = this.element.querySelector('[name="jsonReplaceExisting"]')?.checked === true;
      const result = await importJsonItems(
        this.element.querySelector('[name="jsonFile"]')?.files?.[0],
        destination,
        { skipDuplicates: !replaceExisting && this.element.querySelector('[name="jsonSkipDuplicates"]')?.checked !== false, replaceExisting }
      );
      ui.notifications.info(uiText("TOVF.Dnd5eImporter.Result", "{imported} von {found} Items importiert; {skipped} vorhandene Namen übersprungen. Bilder: {uploaded} neu, {reused} wiederverwendet.", result));
    } catch (error) {
      console.error(`${MODULE_ID} | D&D5e JSON item import failed.`, error);
      ui.notifications.error(error.message);
    }
  }

  static async #createTarget(event) {
    event.preventDefault();
    try {
      const pack = await createTargetPack();
      if (!pack) return;
      ui.notifications.info(`Item-Compendium „${pack.title}“ wurde erstellt.`);
      await this.render({ force: true });
    } catch (error) {
      console.error(`${MODULE_ID} | Could not create D&D5e import target pack.`, error);
      ui.notifications.error(error.message);
    }
  }
}

let importer;

export function openDnd5eItemImporter() {
  if (!isOperationalGM()) return ui.notifications.warn(uiText("TOVF.Dnd5eImporter.Errors.GM", "Für diesen Import wird eine Spielleitung benötigt."));
  importer?.close({ animate: false });
  importer = new Dnd5eItemImporter();
  importer.render({ force: true });
}

export function registerDnd5eItemImporter() {
  Hooks.on("renderCompendiumDirectory", (_app, html) => {
    if (!isOperationalGM()) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector("[data-tovf-dnd5e-importer]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tovfDnd5eImporter = "";
    button.innerHTML = `<i class="fa-solid fa-file-import" inert></i> ${uiText("TOVF.Dnd5eImporter.Open", "D&D5e-Inhalte importieren")}`;
    button.addEventListener("click", openDnd5eItemImporter);
    (root.querySelector(".directory-header") ?? root.querySelector("header") ?? root).append(button);
  });
  game.modules.get(MODULE_ID).api ??= {};
  game.modules.get(MODULE_ID).api.openDnd5eItemImporter = openDnd5eItemImporter;
}
