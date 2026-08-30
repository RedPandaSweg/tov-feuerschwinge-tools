import { CONTENT_MODULE_ID, MODULE_ID, modulePath } from "./core/constants.mjs";

const CHARACTER_TYPES = new Set(["background", "class", "heritage", "lineage", "subclass", "talent"]);
const CHARACTER_FEATURE_CATEGORIES = new Set([
  "class", "background", "lineage", "heritage", "talent", "epicLevelBoon"
]);
const SOURCE_MODULES = packageId => (
  packageId === CONTENT_MODULE_ID
  || packageId === game.system.id
  || packageId === "koboldpressogl-bf"
  || packageId.startsWith("kp-tov-")
);
const FALLBACK_ITEM_IMAGE = "icons/svg/item-bag.svg";
const LIBRARY_INDEX_PACK = "tov-feuerschwinge-library-index";
const LIBRARY_INDEX_VERSION = 2;

function libraryIndexPack() {
  return game.packs.get(`world.${LIBRARY_INDEX_PACK}`);
}

async function loadLibraryIndex() {
  const pack = libraryIndexPack();
  if (!pack) return null;
  const documents = await pack.getDocuments();
  const document = documents.find(entry => entry.flags?.[MODULE_ID]?.libraryIndex);
  const cache = document?.flags?.[MODULE_ID]?.libraryIndex;
  return cache?.version === LIBRARY_INDEX_VERSION && Array.isArray(cache.entries) ? cache : null;
}

async function saveLibraryIndex(entries) {
  let pack = libraryIndexPack();
  if (!pack) {
    pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
      type: "JournalEntry",
      label: "Feuerschwinge Tools – Bibliotheksindex",
      name: LIBRARY_INDEX_PACK
    });
  }
  const documents = await pack.getDocuments();
  const existing = documents.find(entry => entry.flags?.[MODULE_ID]?.libraryIndex);
  const cache = { version: LIBRARY_INDEX_VERSION, updatedAt: Date.now(), entries };
  if (existing) await existing.update({ [`flags.${MODULE_ID}.libraryIndex`]: cache });
  else await JournalEntry.create({ name: "Feuerschwinge-Bibliotheksindex", flags: { [MODULE_ID]: { libraryIndex: cache } } }, { pack: pack.collection });
  return cache;
}

const CATEGORIES = [
  { id: "monsters", label: "TOVF.Library.Category.Monsters", icon: "fa-solid fa-dragon" },
  { id: "monsterFeatures", label: "TOVF.Library.Category.MonsterFeatures", icon: "fa-solid fa-paw" },
  { id: "spells", label: "TOVF.Library.Category.Spells", icon: "fa-solid fa-sparkles" },
  { id: "magicItems", label: "TOVF.Library.Category.MagicItems", icon: "fa-solid fa-wand-magic-sparkles" },
  { id: "items", label: "TOVF.Library.Category.Items", icon: "fa-solid fa-sack" },
  { id: "characters", label: "TOVF.Library.Category.Characters", icon: "fa-solid fa-user-plus" },
  { id: "rules", label: "TOVF.Library.Category.Rules", icon: "fa-solid fa-book-open" },
  { id: "adventures", label: "TOVF.Library.Category.Adventures", icon: "fa-solid fa-map" },
  { id: "tools", label: "TOVF.Library.Category.Tools", icon: "fa-solid fa-toolbox" }
];

const MAGIC_ITEM_RARITY_ORDER = new Map([
  ["common", 0],
  ["uncommon", 1],
  ["rare", 2],
  ["very rare", 3],
  ["legendary", 4],
  ["fabled", 5],
  ["artifact", 6],
  ["unique", 7],
  ["other", 9]
]);

function isMagicItem(entry) {
  const rarity = foundry.utils.getProperty(entry, "system.rarity");
  const properties = foundry.utils.getProperty(entry, "system.properties");
  const magical = properties instanceof Set
    ? properties.has("magical")
    : Array.isArray(properties)
      ? properties.includes("magical")
      : Boolean(properties?.magical);
  return Boolean(rarity || magical);
}

function categoryFor(pack, entry) {
  if (pack.documentName === "Actor") return "monsters";
  if (pack.documentName === "JournalEntry") return toolReferenceType(pack, entry) ? "tools" : "rules";
  if (["Adventure", "Scene"].includes(pack.documentName)) return "adventures";
  if (["Macro", "RollTable", "Cards"].includes(pack.documentName)) return "tools";
  if (pack.documentName !== "Item") return "tools";
  if (toolReferenceType(pack, entry)) return "tools";
  if (entry.type === "spell") return "spells";
  if (CHARACTER_TYPES.has(entry.type)) return "characters";
  if (entry.type === "feature") {
    const category = featureCategory(pack, entry);
    if (category === "monsters") return "monsterFeatures";
    if (CHARACTER_FEATURE_CATEGORIES.has(category)) return "characters";
    if (category === "vehicle") return "items";
    return "rules";
  }
  if (isMagicItem(entry)) return "magicItems";
  return "items";
}

const TYPE_LABELS = {
  ammunition: "Ammunition",
  armor: "Armor",
  background: "Backgrounds",
  class: "Classes",
  consumable: "Consumables",
  container: "Containers",
  currency: "Currency",
  feature: "Features",
  gear: "Gear",
  heritage: "Heritages",
  lineage: "Lineages",
  script: "Scripts",
  siege: "Siege Equipment",
  subclass: "Subclasses",
  sundry: "Sundry",
  talent: "Talents",
  tool: "Tools",
  vehicle: "Vehicles",
  weapon: "Weapons"
};

function humanize(value) {
  const text = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return text ? text.replace(/\b\w/g, letter => letter.toUpperCase()) : "";
}

function folderNames(pack, entry) {
  let id = entry.folder?._id ?? entry.folder;
  const names = [];
  while (id) {
    const folder = pack.folders?.get(id) ?? game.folders?.get(id);
    if (!folder) break;
    names.push(folder.name);
    id = folder.folder?.id ?? folder.folder ?? null;
  }
  return names;
}

function folderName(pack, entry) {
  const names = folderNames(pack, entry);
  return names.find(name => !/^(monsters?|creatures?|npcs?)$/i.test(name)) ?? "";
}

function featureCategory(pack, entry) {
  const configured = foundry.utils.getProperty(entry, "system.type.category");
  if (configured) return configured;
  const text = folderNames(pack, entry).join(" ");
  const categories = [
    [/\b(subclass|class)(?:\s+features?)?\b/i, "class"],
    [/\bbackground(?:\s+features?)?\b/i, "background"],
    [/\blineage(?:\s+features?)?\b/i, "lineage"],
    [/\bheritage(?:\s+features?)?\b/i, "heritage"],
    [/\b(monster|npc)(?:\s+features?)?\b/i, "monsters"],
    [/\btalents?\b/i, "talent"],
    [/\bvehicles?\b/i, "vehicle"]
  ];
  return categories.find(([pattern]) => pattern.test(text))?.[1] ?? "";
}

function featureType(pack, entry, category) {
  const configured = foundry.utils.getProperty(entry, "system.type.value");
  if (configured) return humanize(configured);

  const ignored = new Set([
    "feature", "features", "class", "class feature", "class features",
    "monster feature", "monster features", "lineage feature", "lineage features",
    "heritage feature", "heritage features", "background feature", "background features",
    "talent", "talents", humanize(category).toLocaleLowerCase("en"),
    `${humanize(category).toLocaleLowerCase("en")} features`
  ]);
  const folder = [...folderNames(pack, entry)].reverse()
    .find(name => !ignored.has(name.trim().toLocaleLowerCase("en")));
  if (folder) return folder;

  const associated = foundry.utils.getProperty(entry, "system.identifier.associated");
  return humanize(associated) || "Other";
}

function classFeatureOwner(pack, entry) {
  const classFolder = [...folderNames(pack, entry)].reverse()
    .find(name => !/^(features?|class(?:\s+features?)?)$/i.test(name.trim()));
  if (classFolder) return classFolder;

  const classes = CONFIG.BlackFlag.registration.list("class") ?? {};
  const associated = foundry.utils.getProperty(entry, "system.identifier.associated");
  if (associated && classes[associated]) return classes[associated].name;
  if (associated) return humanize(associated);
  return "Other";
}

function classFeatureType(pack, entry) {
  const configured = foundry.utils.getProperty(entry, "system.type.value");
  const registered = CONFIG.BlackFlag.featureCategories?.class?.children?.[configured];
  if (registered) return humanize(configured);
  const folders = folderNames(pack, entry);
  const owner = classFeatureOwner(pack, entry);
  return folders.find(name => (
    name !== owner && !/^(features?|class(?:\s+features?)?)$/i.test(name.trim())
  )) ?? "General";
}

function toolReferenceType(pack, entry) {
  const systemType = [
    foundry.utils.getProperty(entry, "system.type.category"),
    foundry.utils.getProperty(entry, "system.type.value")
  ].filter(Boolean);
  const text = [...folderNames(pack, entry), pack.title, ...systemType].join(" ");
  const topics = [
    [/\bcurses?\b/i, "Curses"],
    [/\btraps?\b/i, "Traps"],
    [/\bdiseases?\b/i, "Diseases"],
    [/\bhazards?\b/i, "Hazards"],
    [/\bafflictions?\b/i, "Afflictions"]
  ];
  return topics.find(([pattern]) => pattern.test(text))?.[1] ?? "";
}

function rollTableType(pack, entry) {
  const text = [...folderNames(pack, entry), entry.name].join(" ");
  const topics = [
    [/\b(encounters?|creatures?|monsters?)\b/i, "Encounters"],
    [/\b(treasure|loot|rewards?)\b/i, "Treasure & Loot"],
    [/\b(rumou?rs?|gossip)\b/i, "Rumors"],
    [/\b(weather|climate)\b/i, "Weather"],
    [/\b(npcs?|characters?)\b/i, "NPCs"],
    [/\b(magic|spells?|arcane)\b/i, "Magic"],
    [/\b(traps?|hazards?)\b/i, "Traps & Hazards"],
    [/\b(travel|journey|wilderness)\b/i, "Travel"],
    [/\b(names?)\b/i, "Names"]
  ];
  return topics.find(([pattern]) => pattern.test(text))?.[1]
    ?? folderNames(pack, entry)[0]
    ?? "Other";
}

function monsterFolderLabel(value) {
  const label = String(value || "Other").trim();
  const aliases = new Map([
    ["aberrations", "Aberration"],
    ["beasts", "Beast"],
    ["celestials", "Celestial"],
    ["constructs", "Construct"],
    ["dragons", "Dragon"],
    ["elementals", "Elemental"],
    ["fey", "Fey"],
    ["fiends", "Fiend"],
    ["giants", "Giant"],
    ["humanoids", "Humanoid"],
    ["monstrosities", "Monstrosity"],
    ["oozes", "Ooze"],
    ["plants", "Plant"],
    ["undead", "Undead"],
    ["vehicles", "Vehicle"]
  ]);
  return aliases.get(label.toLocaleLowerCase("en")) ?? label;
}

function challengeRatingLabel(value) {
  const fractions = new Map([[0.125, "1/8"], [0.25, "1/4"], [0.5, "1/2"]]);
  return fractions.get(value) ?? String(value);
}

function spellCastingTime(entry) {
  return String(foundry.utils.getProperty(entry, "system.casting.type") ?? "").toLocaleLowerCase("en");
}

function collectionValues(value) {
  if (Array.isArray(value?.contents)) return value.contents;
  if (value instanceof Set || Array.isArray(value)) return [...value];
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length && entries.every(([, selected]) => typeof selected === "boolean")) {
      return entries.filter(([, selected]) => selected).map(([key]) => key);
    }
    return Object.values(value);
  }
  return [];
}

function spellTags(entry) {
  const tags = foundry.utils.getProperty(entry, "system.tags");
  return new Set(collectionValues(tags).map(tag => String(tag).toLocaleLowerCase("en")));
}

function spellDuration(entry) {
  const unit = String(foundry.utils.getProperty(entry, "system.duration.unit") ?? "").trim().toLocaleLowerCase("en");
  const rawValue = String(foundry.utils.getProperty(entry, "system.duration.value") ?? "").trim();
  if (!unit || ["none", "null", "undefined", "unspecified"].includes(unit)) {
    return { id: "unspecified", unit: "", value: "", variable: false, rank: Number.MAX_SAFE_INTEGER - 1 };
  }
  const config = CONFIG.BlackFlag.durationOptions?.({ pluralCount: Number(rawValue) || 1, isSpell: true })?.get(unit);
  // Only index duration types that Black Flag exposes in its spell UI. Legacy
  // imports sometimes store complete phrases such as "2-12 hours" in `unit`;
  // treating those as facets creates noisy, non-standard filter options.
  if (!config) return { id: "", unit: "", value: "", variable: false, rank: Number.MAX_SAFE_INTEGER };
  const scalar = Boolean(config?.scalar || unit in (CONFIG.BlackFlag.timeUnits ?? {}));
  const numeric = rawValue !== "" && Number.isFinite(Number(rawValue));
  const variable = scalar && rawValue !== "" && !numeric;
  const value = numeric ? String(Number(rawValue)) : "";
  const rankUnits = {
    turn: 6, turns: 6, round: 6, rounds: 6, second: 1, seconds: 1,
    minute: 60, minutes: 60, hour: 3600, hours: 3600, day: 86400, days: 86400,
    week: 604800, weeks: 604800, month: 2592000, months: 2592000,
    year: 31536000, years: 31536000
  };
  const rank = unit === "instantaneous"
    ? 0
    : (rankUnits[unit] ?? 1_000_000_000) * (numeric ? Number(value) : variable ? 1 : 1);
  return {
    id: scalar ? `${unit}|${variable ? "variable" : value}` : unit,
    unit,
    value,
    variable,
    rank
  };
}

function spellDurationLabel({ unit, value, variable }) {
  if (!unit) return game.i18n.localize("TOVF.Library.SpellDuration.Unspecified");
  if (unit === "instantaneous") return game.i18n.localize("TOVF.Library.SpellDuration.Instantaneous");
  if (unit === "special") return game.i18n.localize("TOVF.Library.SpellDuration.Special");
  const localizedUnit = CONFIG.BlackFlag.timeUnits?.localized?.[unit]
    ?? CONFIG.BlackFlag.durationOptions?.({ pluralCount: Number(value) || 1, isSpell: true })?.get(unit)?.label
    ?? humanize(unit);
  if (variable) return game.i18n.format("TOVF.Library.SpellDuration.Variable", { unit: localizedUnit });
  return value ? `${value} ${localizedUnit}` : localizedUnit;
}

function spellActivityData(entry) {
  const activities = collectionValues(foundry.utils.getProperty(entry, "system.activities"));
  const damageTypes = new Set();
  const conditions = new Set();
  const activityEffectIds = new Set();
  let attack = false;
  let save = false;
  for (const activity of activities) {
    attack ||= activity?.type === "attack";
    save ||= activity?.type === "save";
    for (const part of collectionValues(activity?.system?.damage?.parts)) {
      if (part?.type && part.type !== "variable") damageTypes.add(String(part.type));
      if (part?.type === "variable") {
        for (const type of collectionValues(part.additionalTypes)) damageTypes.add(String(type));
      }
    }
    for (const condition of collectionValues(activity?.system?.conditions ?? activity?.conditions)) {
      const id = String(condition?.id ?? condition?.value ?? condition ?? "");
      if (id) conditions.add(id);
    }
    for (const effect of collectionValues(activity?.effects ?? activity?.system?.effects)) {
      const id = String(effect?._id ?? effect?.id ?? effect?.effectId ?? effect ?? "");
      if (id) activityEffectIds.add(id.split(".").at(-1));
      for (const status of collectionValues(effect?.statuses)) conditions.add(String(status));
    }
  }
  for (const effect of collectionValues(entry.effects)) {
    const effectId = String(effect?._id ?? effect?.id ?? "");
    if (activityEffectIds.size && effectId && !activityEffectIds.has(effectId)) continue;
    for (const status of collectionValues(effect?.statuses)) conditions.add(String(status));
  }
  return { damageTypes: [...damageTypes], conditions: [...conditions].filter(Boolean), attack, save };
}

function conditionLabel(id) {
  const configured = CONFIG.statusEffects?.find(effect => effect.id === id || effect._id === id);
  const label = configured?.name ?? configured?.label;
  return label ? game.i18n.localize(label) : humanize(id);
}

function normalizeCreatureType(value) {
  const raw = String(value ?? "").trim().toLocaleLowerCase("en");
  const aliases = {
    aberrations: "aberration", beasts: "beast", celestials: "celestial", constructs: "construct",
    dragons: "dragon", elementals: "elemental", fey: "fey", fiends: "fiend", giants: "giant",
    humanoids: "humanoid", monstrosities: "monstrosity", monstrosity: "monstrosity",
    oozes: "ooze", plants: "plant", undeads: "undead"
  };
  const normalized = aliases[raw] ?? raw;
  return Object.hasOwn(CONFIG.BlackFlag.creatureTypes ?? {}, normalized) ? normalized : "";
}

function monsterData(actor) {
  const values = path => collectionValues(foundry.utils.getProperty(actor, path)).map(String).filter(Boolean);
  const enabledKeys = path => Object.entries(foundry.utils.getProperty(actor, path) ?? {})
    .filter(([, value]) => value !== "" && value !== 0 && value !== false && value != null)
    .map(([key]) => key);
  return {
    creatureType: normalizeCreatureType(foundry.utils.getProperty(actor, "system.type.value") ?? foundry.utils.getProperty(actor, "system.traits.type.value")),
    size: String(foundry.utils.getProperty(actor, "system.traits.size") ?? foundry.utils.getProperty(actor, "system.size") ?? ""),
    armorClass: Number(foundry.utils.getProperty(actor, "system.attributes.ac.value")),
    hitPoints: Number(foundry.utils.getProperty(actor, "system.attributes.hp.max")),
    movement: enabledKeys("system.traits.movement.types"),
    senses: enabledKeys("system.traits.senses.types"),
    damageResistances: values("system.traits.damage.resistances.value"),
    damageImmunities: values("system.traits.damage.immunities.value"),
    damageVulnerabilities: values("system.traits.damage.vulnerabilities.value"),
    conditionImmunities: values("system.traits.condition.immunities.value"),
    spellcaster: collectionValues(actor.items).some(item => item.type === "spell"),
    legendary: Number(foundry.utils.getProperty(actor, "system.attributes.legendary.max")) > 0
  };
}

function configLabel(config, id) {
  const localization = config?.[id]?.label ?? config?.[id]?.localization;
  return config?.localized?.[id] ?? (localization ? game.i18n.localize(localization) : humanize(id));
}

function spellRequiresConcentration(entry) {
  return spellTags(entry).has("concentration")
    || Boolean(foundry.utils.getProperty(entry, "system.duration.concentration"));
}

function spellIsVoid(entry) {
  const tags = foundry.utils.getProperty(entry, `flags.${MODULE_ID}.library.tags`);
  const tagValues = tags instanceof Set
    ? [...tags]
    : Array.isArray(tags)
      ? tags
      : typeof tags === "string" ? tags.split(/[;,\s]+/) : [];
  if (tagValues.some(tag => String(tag).toLocaleLowerCase("en") === "void")) return true;
  if (/\bvoid\b/i.test(String(entry.name ?? ""))) return true;
  const description = String(foundry.utils.getProperty(entry, "system.description.value") ?? "");
  const plainText = description
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&colon;|&#58;/gi, ":")
    .replace(/\s+/g, " ")
    .trim();
  return /^deep magic:\s*void\b/i.test(plainText);
}

function configuredItemCategoryLabel(itemType, category) {
  if (!category) return "";
  const configNames = {
    ammunition: ["ammunition"],
    armor: ["armor", "armorCategories"],
    consumable: ["consumableCategories"],
    container: ["containerCategories"],
    gear: ["gearCategories"],
    sundry: ["sundryCategories"],
    tool: ["toolCategories", "tools"],
    weapon: ["weaponCategories", "weapons"]
  };
  for (const configName of configNames[itemType] ?? []) {
    const config = CONFIG.BlackFlag?.[configName];
    const localized = config?.localized?.[category];
    if (localized) return localized;
    const definition = config?.[category];
    const label = definition?.label ?? definition?.localization;
    if (label) {
      const translated = game.i18n.localize(label);
      return translated === label ? humanize(category) : translated;
    }
  }
  return humanize(category);
}

function itemLibraryDetail(entry, itemType, typeCategory, typeBase) {
  if (itemType === "gear") {
    const focusIdentity = `${typeCategory} ${typeBase} ${entry.name ?? ""}`
      .replace(/[^a-z]/gi, "")
      .toLocaleLowerCase("en");
    if (typeBase === "focus" || focusIdentity.includes("focus") || focusIdentity.includes("holysymbol")) {
      return game.i18n.localize("TOVF.Library.SpellFocus");
    }
  }
  // The base field identifies individual equipment models (boots, cloak,
  // ring, and so on). Library facets should use the broader system category;
  // otherwise they mostly produce one-entry filters.
  return configuredItemCategoryLabel(itemType, typeCategory);
}

function classificationFor(pack, entry, category) {
  const itemType = entry.type ?? "";
  const typeCategory = itemType === "feature"
    ? featureCategory(pack, entry)
    : foundry.utils.getProperty(entry, "system.type.category") ?? "";
  const typeValue = foundry.utils.getProperty(entry, "system.type.value") ?? "";
  const typeBase = foundry.utils.getProperty(entry, "system.type.base") ?? "";

  if (category === "monsters") {
    return { subcategory: monsterFolderLabel(folderName(pack, entry)), detail: "" };
  }
  if (category === "monsterFeatures") {
    return {
      subcategory: featureType(pack, entry, typeCategory),
      detail: ""
    };
  }
  if (category === "spells") {
    const circle = Number(foundry.utils.getProperty(entry, "system.circle.base"));
    const sources = foundry.utils.getProperty(entry, "system.source");
    const sourceValues = Array.isArray(sources) || sources instanceof Set
      ? Array.from(sources)
      : sources ? [sources] : [];
    const sourceLabels = sourceValues.map(humanize).filter(Boolean);
    const school = humanize(foundry.utils.getProperty(entry, "system.school"));
    const suffix = circle === 1 ? "st" : circle === 2 ? "nd" : circle === 3 ? "rd" : "th";
    return {
      subcategory: Number.isFinite(circle) ? (circle === 0 ? "Cantrip" : `${circle}${suffix} Circle`) : "Other",
      detail: sourceLabels.length ? sourceLabels : ["Other"],
      extra: school || "Other"
    };
  }
  if (category === "characters") {
    if (itemType === "feature") {
      if (typeCategory === "class") {
        return {
          subcategory: "Class Features",
          detail: classFeatureOwner(pack, entry),
          extra: classFeatureType(pack, entry)
        };
      }
      return {
        subcategory: `${humanize(typeCategory) || "Other"} Features`,
        detail: featureType(pack, entry, typeCategory)
      };
    }
    return { subcategory: TYPE_LABELS[itemType] || humanize(itemType) || "Other", detail: "" };
  }
  if (category === "magicItems") {
    return {
      subcategory: humanize(foundry.utils.getProperty(entry, "system.rarity")) || "Other",
      detail: TYPE_LABELS[itemType] || humanize(itemType) || "Other"
    };
  }
  if (category === "items") {
    return {
      subcategory: TYPE_LABELS[itemType] || humanize(itemType) || "Other",
      detail: itemLibraryDetail(entry, itemType, typeCategory, typeBase)
    };
  }
  if (category === "rules") {
    if (itemType === "feature") {
      return {
        subcategory: "Features",
        detail: featureType(pack, entry, typeCategory)
      };
    }
    return {
      subcategory: pack.documentName === "JournalEntry" ? "Journals" : humanize(itemType) || "Other",
      detail: "",
      extra: ""
    };
  }
  if (category === "adventures") {
    return { subcategory: `${pack.documentName}s`, detail: "" };
  }
  if (category === "tools") {
    if (pack.documentName === "RollTable") {
      return { subcategory: "Roll Tables", detail: rollTableType(pack, entry) };
    }
    const referenceType = toolReferenceType(pack, entry);
    if (referenceType) {
      const specificFolder = folderNames(pack, entry).find(name => name !== referenceType);
      return { subcategory: referenceType, detail: specificFolder || "" };
    }
    return { subcategory: pack.documentName, detail: folderName(pack, entry) };
  }
  return { subcategory: pack.documentName, detail: "" };
}

function packageIdFor(pack) {
  return pack.metadata.packageName ?? pack.metadata.package ?? "";
}

function sourceLabel(packageId) {
  if (packageId === CONTENT_MODULE_ID) return game.modules.get(CONTENT_MODULE_ID)?.title ?? "Feuerschwinge – Kompendium";
  if (packageId === game.system.id) return game.system.title;
  return game.modules.get(packageId)?.title ?? packageId;
}

function shortSourceLabel(packageId, label) {
  if (packageId === CONTENT_MODULE_ID) return "Feuerschwinge";
  if (packageId === game.system.id) return "Black Flag";
  if (packageId === "koboldpressogl-bf") return "KPOGL";
  const shortened = String(label)
    .replace(/^Kobold Press\s*/i, "")
    .replace(/^Tales of the Valiant\s*[:–—-]?\s*/i, "")
    .trim();
  if (shortened.length <= 16) return shortened;
  const acronym = shortened.match(/\b[\p{L}\p{N}]/gu)?.join("").toUpperCase();
  return acronym?.slice(0, 8) || shortened.slice(0, 14);
}

function normalizedName(value) {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

function displayKey(entry) {
  return `${entry.documentType}|${entry.itemType}|${normalizedName(entry.name)}`;
}

function sourcePriority(entry) {
  if (entry.source === game.system.id) return 0;
  if (entry.source !== CONTENT_MODULE_ID) return 1;
  return 2;
}

function safeImage(path, documentType) {
  const fallback = {
    Actor: "icons/svg/mystery-man.svg",
    Item: FALLBACK_ITEM_IMAGE,
    JournalEntry: "icons/svg/book.svg",
    Macro: "icons/svg/dice-target.svg",
    RollTable: "icons/svg/d20-black.svg"
  }[documentType] ?? "icons/svg/book.svg";
  if (String(path ?? "").startsWith("modules/delve/")) {
    return fallback;
  }
  return path || fallback;
}

function deduplicateEntries(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = displayKey(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    group.sort((a, b) => sourcePriority(a) - sourcePriority(b));
    const preferred = group[0];
    return {
      ...preferred,
      duplicateCount: group.length,
      hasDuplicates: group.length > 1,
      sourceSummary: [...new Set(group.map(entry => entry.sourceLabel))].join(", ")
    };
  });
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class CompendiumLibrary extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-compendium-library",
    classes: ["tovf-library"],
    position: { width: 1100, height: 780 },
    window: { title: "TOVF.Library.Title", resizable: true },
    actions: {
      selectCategory: this.#selectCategory,
      selectSubcategory: this.#selectSubcategory,
      selectDetail: this.#selectDetail,
      selectExtra: this.#selectExtra,
      setLayout: this.#setLayout,
      openDocument: this.#openDocument,
      openPack: this.#openPack
    }
  };

  static PARTS = {
    content: { template: modulePath("templates/compendium-library.hbs") }
  };

  #entries = null;
  #indexMeta = null;
  #category = "monsters";
  #sources = null;
  #query = "";
  #subcategory = "";
  #detail = "";
  #extra = "";
  #challengeRating = "";
  #spellCastingTime = "";
  #spellDuration = "";
  #spellDamageTypes = new Set();
  #spellConditions = new Set();
  #spellComponents = new Set();
  #spellResolution = "";
  #spellConcentration = false;
  #spellRitual = false;
  #spellVoid = false;
  #magicAttunement = "";
  #magicItemSort = "name";
  #monsterType = "";
  #monsterSize = "";
  #monsterCrMin = "";
  #monsterCrMax = "";
  #monsterAcMin = "";
  #monsterAcMax = "";
  #monsterHpMin = "";
  #monsterHpMax = "";
  #monsterSpellcaster = "";
  #monsterLegendary = false;
  #monsterMulti = { movement: new Set(), senses: new Set(), resistances: new Set(), immunities: new Set(), vulnerabilities: new Set(), conditionImmunities: new Set() };
  #layout = "list";
  #tableBuilder = false;
  #tableEntries = new Set();

  get hasLibraryIndex() { return Boolean(this.#indexMeta); }

  async #loadEntries() {
    const cache = await loadLibraryIndex();
    this.#entries = cache?.entries ?? [];
    this.#indexMeta = cache ? { updatedAt: cache.updatedAt, count: cache.entries.length } : null;
  }

  async #scanEntries() {
    const packs = game.packs.filter(pack => {
      const packageId = packageIdFor(pack);
      return SOURCE_MODULES(packageId) && pack.visible !== false;
    });
    const entries = [];
    await Promise.all(packs.map(async pack => {
      const index = await pack.getIndex({
        fields: [
          "type",
          "img",
          "folder",
          "system.type.category",
          "system.type.value",
          "system.type.base",
          "system.properties",
          "system.rarity",
          "system.attunement.value",
          "system.price.value",
          "system.price.denomination",
          "system.identifier.associated",
          "system.level.value",
          "system.attributes.cr",
          "system.circle.base",
          "system.source",
          "system.school",
          "system.casting.type",
          "system.duration.unit",
          "system.duration.value",
          "system.tags",
          "system.duration.concentration",
          "system.components.required",
          "system.activities",
          "effects"
          , "system.description.value"
          , `flags.${MODULE_ID}.library.tags`
        ]
      });
      const requiresDocuments = pack.documentName === "Actor" || index.some(entry => entry.type === "spell");
      const documents = requiresDocuments ? await pack.getDocuments() : [];
      const documentsById = new Map(documents.map(document => [document.id, document]));
      const packageId = packageIdFor(pack);
      for (const entry of index) {
        const document = documentsById.get(entry._id) ?? entry;
        const category = categoryFor(pack, entry);
        const classification = classificationFor(pack, entry, category);
        const activityData = entry.type === "spell" ? spellActivityData(document) : null;
        const duration = entry.type === "spell" ? spellDuration(document) : null;
        const monster = pack.documentName === "Actor" ? monsterData(document) : null;
        const showPrice = category === "magicItems" || category === "items";
        const priceValue = Math.max(0, Number(foundry.utils.getProperty(entry, "system.price.value")) || 0);
        const priceDenomination = String(foundry.utils.getProperty(entry, "system.price.denomination") ?? "gp").toLocaleLowerCase("en");
        const priceGold = priceValue * ({ pp: 10, gp: 1, sp: 0.1, cp: 0.01 }[priceDenomination] ?? 1);
        entries.push({
          id: entry._id,
          uuid: pack.getUuid(entry._id),
          name: entry.name,
          lowerName: entry.name.toLocaleLowerCase(game.i18n.lang),
          img: safeImage(entry.img, pack.documentName),
          documentType: pack.documentName,
          itemType: entry.type ?? "",
          category,
          challengeRating: pack.documentName === "Actor"
            ? Number(foundry.utils.getProperty(document, "system.attributes.cr"))
            : null,
          monster,
          spellCastingTime: entry.type === "spell" ? spellCastingTime(document) : "",
          spellDuration: duration?.id ?? "",
          spellDurationData: duration,
          spellDamageTypes: activityData?.damageTypes ?? [],
          spellConditions: activityData?.conditions ?? [],
          spellComponents: entry.type === "spell"
            ? collectionValues(foundry.utils.getProperty(document, "system.components.required")).map(String)
            : [],
          spellAttack: activityData?.attack ?? false,
          spellSave: activityData?.save ?? false,
          spellConcentration: entry.type === "spell" && spellRequiresConcentration(document),
          spellRitual: entry.type === "spell" && spellTags(document).has("ritual"),
          spellVoid: entry.type === "spell" && spellIsVoid(document),
          magicAttunement: category === "magicItems"
            ? String(foundry.utils.getProperty(entry, "system.attunement.value") ?? "none") || "none"
            : "",
          showPrice,
          priceGold,
          priceValue: new Intl.NumberFormat(game.i18n.lang, { maximumFractionDigits: 6 }).format(priceValue),
          priceDenomination,
          ...classification,
          pack: pack.collection,
          packLabel: pack.title,
          source: packageId,
          sourceLabel: sourceLabel(packageId),
          shortSourceLabel: shortSourceLabel(packageId, sourceLabel(packageId))
        });
      }
    }));
    entries.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return entries;
  }

  async _prepareContext(options) {
    if (!this.#entries) await this.#loadEntries();
    const query = this.#query.toLocaleLowerCase(game.i18n.lang);
    const allCategoryEntries = this.#entries.filter(entry => entry.category === this.#category);
    const rawCategoryEntries = allCategoryEntries.filter(entry => this.#sources === null || this.#sources.has(entry.source));
    const subcategoryCounts = new Map();
    for (const entry of deduplicateEntries(allCategoryEntries)) {
      const subcategory = entry.subcategory || "Other";
      subcategoryCounts.set(subcategory, (subcategoryCounts.get(subcategory) ?? 0) + 1);
    }
    const smallSubcategories = new Set([...subcategoryCounts]
      .filter(([subcategory, count]) => subcategory !== "Other" && count < 4)
      .map(([subcategory]) => subcategory));
    const categoryEntries = rawCategoryEntries.map(entry => smallSubcategories.has(entry.subcategory)
      ? { ...entry, subcategory: "Other" }
      : entry);
    const challengeRatings = this.#category === "monsters"
      ? [...new Set(categoryEntries
        .map(entry => entry.challengeRating)
        .filter(Number.isFinite))]
        .sort((a, b) => a - b)
        .map(value => ({
          value: String(value),
          label: challengeRatingLabel(value),
          active: String(value) === this.#challengeRating
        }))
      : [];
    if (this.#challengeRating && !challengeRatings.some(option => option.value === this.#challengeRating)) {
      this.#challengeRating = "";
    }
    const challengeRatingEntries = categoryEntries.filter(entry => (
      !this.#challengeRating || String(entry.challengeRating) === this.#challengeRating
    ));
    const subcategories = this.#filterOptions(challengeRatingEntries, "subcategory");
    if (this.#subcategory && !subcategories.some(option => option.value === this.#subcategory)) {
      this.#subcategory = "";
      this.#detail = "";
      this.#extra = "";
    }
    const subcategoryEntries = challengeRatingEntries.filter(entry => (
      !this.#subcategory || entry.subcategory === this.#subcategory
    ));
    const details = (this.#subcategory || this.#category === "spells" || this.#category === "magicItems")
      ? this.#filterOptions(subcategoryEntries, "detail", true)
      : [];
    if (this.#detail && !details.some(option => option.value === this.#detail)) this.#detail = "";
    const detailEntries = subcategoryEntries.filter(entry => this.#matchesFilter(entry.detail, this.#detail));
    const classFeatures = this.#category === "characters" && this.#subcategory === "Class Features";
    const extras = (this.#category === "spells" || (classFeatures && this.#detail))
      ? this.#filterOptions(detailEntries, "extra", true)
      : [];
    if (this.#extra && !extras.some(option => option.value === this.#extra)) this.#extra = "";
    const spellFilterEntries = detailEntries.filter(entry => this.#matchesFilter(entry.extra, this.#extra));
    const spellCastingTimes = this.#spellOptionCounts(spellFilterEntries, entry => [entry.spellCastingTime], value => (
      game.i18n.localize(`TOVF.Library.SpellCastingTime.${value}`) !== `TOVF.Library.SpellCastingTime.${value}`
        ? game.i18n.localize(`TOVF.Library.SpellCastingTime.${value}`)
        : humanize(value)
    ));
    const spellDurations = this.#spellOptionCounts(spellFilterEntries, entry => [entry.spellDuration], value => {
      const duration = spellFilterEntries.find(entry => entry.spellDuration === value)?.spellDurationData;
      return spellDurationLabel(duration ?? { unit: "", value: "" });
    });
    spellDurations.sort((left, right) => {
      const leftRank = spellFilterEntries.find(entry => entry.spellDuration === left.value)?.spellDurationData?.rank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = spellFilterEntries.find(entry => entry.spellDuration === right.value)?.spellDurationData?.rank ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.label.localeCompare(right.label, game.i18n.lang);
    });
    const spellDamageTypes = this.#spellOptionCounts(spellFilterEntries, entry => entry.spellDamageTypes, value => (
      CONFIG.BlackFlag.damageTypes?.localized?.[value] ?? humanize(value)
    ));
    const spellConditions = this.#spellOptionCounts(spellFilterEntries, entry => entry.spellConditions, conditionLabel);
    const spellComponents = this.#spellOptionCounts(spellFilterEntries, entry => entry.spellComponents, value => (
      CONFIG.BlackFlag.spellComponents?.[value]?.label
        ? game.i18n.localize(CONFIG.BlackFlag.spellComponents[value].label)
        : humanize(value)
    ));
    if (this.#spellCastingTime && !spellCastingTimes.some(option => option.value === this.#spellCastingTime)) this.#spellCastingTime = "";
    if (this.#spellDuration && !spellDurations.some(option => option.value === this.#spellDuration)) this.#spellDuration = "";
    const availableDamageTypes = new Set(spellDamageTypes.map(option => option.value));
    const availableConditions = new Set(spellConditions.map(option => option.value));
    const availableComponents = new Set(spellComponents.map(option => option.value));
    this.#spellDamageTypes = new Set([...this.#spellDamageTypes].filter(value => availableDamageTypes.has(value)));
    this.#spellConditions = new Set([...this.#spellConditions].filter(value => availableConditions.has(value)));
    this.#spellComponents = new Set([...this.#spellComponents].filter(value => availableComponents.has(value)));
    const monsterOptions = (field, labelFor = humanize) => this.#spellOptionCounts(
      spellFilterEntries,
      entry => Array.isArray(entry.monster?.[field]) ? entry.monster[field] : [entry.monster?.[field]],
      labelFor
    );
    const monsterTypes = monsterOptions("creatureType", value => configLabel(CONFIG.BlackFlag.creatureTypes, value));
    const monsterSizes = monsterOptions("size", value => configLabel(CONFIG.BlackFlag.actorSizes ?? CONFIG.BlackFlag.sizes, value));
    const monsterMovements = monsterOptions("movement", value => configLabel(CONFIG.BlackFlag.movementTypes, value));
    const monsterSenses = monsterOptions("senses", value => configLabel(CONFIG.BlackFlag.senses, value));
    const monsterDamageResistances = monsterOptions("damageResistances", value => configLabel(CONFIG.BlackFlag.damageTypes, value));
    const monsterDamageImmunities = monsterOptions("damageImmunities", value => configLabel(CONFIG.BlackFlag.damageTypes, value));
    const monsterDamageVulnerabilities = monsterOptions("damageVulnerabilities", value => configLabel(CONFIG.BlackFlag.damageTypes, value));
    const monsterConditionImmunities = monsterOptions("conditionImmunities", conditionLabel);
    const numberMatches = (value, minimum, maximum) => (!minimum || value >= Number(minimum)) && (!maximum || value <= Number(maximum));
    const multiMatches = (values, selected) => !selected.size || values.some(value => selected.has(value));
    const matchingEntries = spellFilterEntries.filter(entry => (
      (!this.#spellCastingTime || entry.spellCastingTime === this.#spellCastingTime)
      && (!this.#spellDuration || entry.spellDuration === this.#spellDuration)
      && (!this.#spellDamageTypes.size || entry.spellDamageTypes.some(type => this.#spellDamageTypes.has(type)))
      && (!this.#spellConditions.size || entry.spellConditions.some(condition => this.#spellConditions.has(condition)))
      && (!this.#spellComponents.size || [...this.#spellComponents].every(component => entry.spellComponents.includes(component)))
      && (!this.#spellResolution
        || (this.#spellResolution === "attack" && entry.spellAttack)
        || (this.#spellResolution === "save" && entry.spellSave)
        || (this.#spellResolution === "neither" && !entry.spellAttack && !entry.spellSave))
      && (!this.#spellConcentration || entry.spellConcentration)
      && (!this.#spellRitual || entry.spellRitual)
      && (!this.#spellVoid || entry.spellVoid)
      && (!this.#magicAttunement || entry.magicAttunement === this.#magicAttunement)
      && (!this.#monsterType || entry.monster?.creatureType === this.#monsterType)
      && (!this.#monsterSize || entry.monster?.size === this.#monsterSize)
      && (!entry.monster || numberMatches(entry.challengeRating, this.#monsterCrMin, this.#monsterCrMax))
      && (!entry.monster || numberMatches(entry.monster.armorClass, this.#monsterAcMin, this.#monsterAcMax))
      && (!entry.monster || numberMatches(entry.monster.hitPoints, this.#monsterHpMin, this.#monsterHpMax))
      && (!this.#monsterSpellcaster || (entry.monster?.spellcaster ? "yes" : "no") === this.#monsterSpellcaster)
      && (!this.#monsterLegendary || entry.monster?.legendary)
      && (!entry.monster || multiMatches(entry.monster.movement, this.#monsterMulti.movement))
      && (!entry.monster || multiMatches(entry.monster.senses, this.#monsterMulti.senses))
      && (!entry.monster || multiMatches(entry.monster.damageResistances, this.#monsterMulti.resistances))
      && (!entry.monster || multiMatches(entry.monster.damageImmunities, this.#monsterMulti.immunities))
      && (!entry.monster || multiMatches(entry.monster.damageVulnerabilities, this.#monsterMulti.vulnerabilities))
      && (!entry.monster || multiMatches(entry.monster.conditionImmunities, this.#monsterMulti.conditionImmunities))
      && (!query || entry.name.toLocaleLowerCase(game.i18n.lang).includes(query))
    ));
    const entries = deduplicateEntries(matchingEntries).map(entry => ({
      ...entry,
      tableSelectable: true,
      tableSelected: this.#tableEntries.has(entry.uuid)
    }));
    if (this.#category === "magicItems" && this.#magicItemSort === "price") {
      entries.sort((left, right) => left.priceGold - right.priceGold || left.name.localeCompare(right.name, game.i18n.lang));
    } else {
      entries.sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
    }
    const sources = [...new Map(
      this.#entries
        .filter(entry => entry.category === this.#category)
        .map(entry => [entry.source, entry.sourceLabel])
    )].map(([value, label]) => ({ value, label, selected: this.#sources === null || this.#sources.has(value) }))
      .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    const categories = CATEGORIES.map(category => ({
      ...category,
      active: category.id === this.#category,
      count: deduplicateEntries(this.#entries.filter(entry => entry.category === category.id)).length
    }));
    const primaryCategoryIds = new Set(["monsters", "spells", "magicItems", "characters", "items"]);
    const primaryCategories = categories.filter(category => primaryCategoryIds.has(category.id));
    const moreCategories = categories.filter(category => !primaryCategoryIds.has(category.id));
    const activeMoreCategory = moreCategories.find(category => category.active);
    return {
      ...(await super._prepareContext(options)),
      primaryCategories,
      moreCategories,
      activeMoreCategory,
      moreCategoryActive: Boolean(activeMoreCategory),
      entries,
      subcategories,
      details,
      extras,
      challengeRatings,
      compactSubcategories: this.#category !== "monsters" && subcategories.length > 18,
      compactDetails: details.length > 18,
      compactExtras: extras.length > 18,
      selectedSubcategory: this.#subcategory,
      selectedDetail: this.#detail,
      selectedExtra: this.#extra,
      selectedChallengeRating: this.#challengeRating,
      showSpellFilters: this.#category === "spells",
      showMonsterFilters: this.#category === "monsters",
      showMagicItemFilters: this.#category === "magicItems",
      magicAttunementOptions: ["none", "optional", "required"].map(value => ({
        value,
        label: game.i18n.localize(`TOVF.Library.Attunement.${value}`),
        count: deduplicateEntries(spellFilterEntries.filter(entry => entry.magicAttunement === value)).length
      })),
      selectedMagicAttunement: this.#magicAttunement,
      selectedMagicItemSort: this.#magicItemSort,
      monsterTypes,
      monsterSizes,
      monsterMovements: monsterMovements.map(option => ({ ...option, selected: this.#monsterMulti.movement.has(option.value) })),
      monsterSenses: monsterSenses.map(option => ({ ...option, selected: this.#monsterMulti.senses.has(option.value) })),
      monsterDamageResistances: monsterDamageResistances.map(option => ({ ...option, selected: this.#monsterMulti.resistances.has(option.value) })),
      monsterDamageImmunities: monsterDamageImmunities.map(option => ({ ...option, selected: this.#monsterMulti.immunities.has(option.value) })),
      monsterDamageVulnerabilities: monsterDamageVulnerabilities.map(option => ({ ...option, selected: this.#monsterMulti.vulnerabilities.has(option.value) })),
      monsterConditionImmunities: monsterConditionImmunities.map(option => ({ ...option, selected: this.#monsterMulti.conditionImmunities.has(option.value) })),
      selectedMonsterType: this.#monsterType,
      selectedMonsterSize: this.#monsterSize,
      monsterAcMin: this.#monsterAcMin,
      monsterAcMax: this.#monsterAcMax,
      monsterHpMin: this.#monsterHpMin,
      monsterHpMax: this.#monsterHpMax,
      monsterCrMin: this.#monsterCrMin,
      monsterCrMax: this.#monsterCrMax,
      selectedMonsterSpellcaster: this.#monsterSpellcaster,
      monsterLegendary: this.#monsterLegendary,
      monsterFilterCount: [this.#monsterType, this.#monsterSize, this.#monsterCrMin, this.#monsterCrMax, this.#monsterAcMin, this.#monsterAcMax, this.#monsterHpMin, this.#monsterHpMax, this.#monsterSpellcaster, this.#monsterLegendary]
        .filter(Boolean).length + Object.values(this.#monsterMulti).reduce((count, set) => count + set.size, 0),
      spellCastingTimes,
      selectedSpellCastingTime: this.#spellCastingTime,
      spellDurations,
      selectedSpellDuration: this.#spellDuration,
      spellDamageTypes: spellDamageTypes.map(option => ({ ...option, selected: this.#spellDamageTypes.has(option.value) })),
      selectedSpellDamageTypeCount: this.#spellDamageTypes.size,
      spellConditions: spellConditions.map(option => ({ ...option, selected: this.#spellConditions.has(option.value) })),
      selectedSpellConditionCount: this.#spellConditions.size,
      spellComponents: spellComponents.map(option => ({ ...option, selected: this.#spellComponents.has(option.value) })),
      selectedSpellComponentCount: this.#spellComponents.size,
      spellResolutionOptions: ["attack", "save", "neither"].map(value => ({
        value,
        label: game.i18n.localize(`TOVF.Library.SpellResolution.${value}`)
      })),
      selectedSpellResolution: this.#spellResolution,
      spellConcentration: this.#spellConcentration,
      spellConcentrationCount: deduplicateEntries(spellFilterEntries.filter(entry => (
        (!this.#spellCastingTime || entry.spellCastingTime === this.#spellCastingTime)
        && entry.spellConcentration
      ))).length,
      spellRitual: this.#spellRitual,
      spellRitualCount: deduplicateEntries(spellFilterEntries.filter(entry => entry.spellRitual)).length,
      spellVoid: this.#spellVoid,
      spellVoidCount: deduplicateEntries(spellFilterEntries.filter(entry => (
        (!this.#spellCastingTime || entry.spellCastingTime === this.#spellCastingTime)
        && (!this.#spellConcentration || entry.spellConcentration)
        && entry.spellVoid
      ))).length,
      spellAdvancedFilterCount: [
        this.#spellCastingTime,
        this.#spellDuration,
        this.#spellResolution,
        this.#spellConcentration,
        this.#spellRitual,
        this.#spellVoid
      ].filter(Boolean).length + this.#spellDamageTypes.size + this.#spellConditions.size + this.#spellComponents.size,
      subcategoryLabel: this.#category === "spells" ? "Circle" : "Subcategory",
      detailLabel: this.#category === "spells" ? "Source of Magic" : classFeatures ? "Class" : "Type",
      extraLabel: this.#category === "spells" ? "School of Magic" : "Feature Type",
      layout: this.#layout,
      listLayout: this.#layout === "list",
      gridLayout: this.#layout === "grid",
      sources,
      isGM: game.user.isGM,
      hasLibraryIndex: Boolean(this.#indexMeta),
      libraryIndexUpdated: this.#indexMeta?.updatedAt
        ? new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "short", timeStyle: "short" }).format(this.#indexMeta.updatedAt)
        : "",
      libraryIndexCount: this.#indexMeta?.count ?? 0,
      allSourcesSelected: this.#sources === null,
      sourceSelectionLabel: this.#sources === null
        ? game.i18n.localize("TOVF.Library.AllSources")
        : game.i18n.format("TOVF.Library.SelectedSources", { count: this.#sources.size }),
      query: this.#query,
      resultCount: entries.length,
      tableBuilder: this.#tableBuilder,
      tableSelectionCount: this.#tableEntries.size
    };
  }

  #filterOptions(entries, property, omitEmpty = false) {
    const groups = new Map();
    for (const entry of deduplicateEntries(entries)) {
      const values = Array.isArray(entry[property]) ? entry[property] : [entry[property] ?? ""];
      for (const value of new Set(values)) {
        if (omitEmpty && !value) continue;
        groups.set(value, (groups.get(value) ?? 0) + 1);
      }
    }
    return [...groups].map(([value, count]) => ({
      value,
      label: value || "Other",
      displayLabel: `${value || "Other"} (${count})`,
      count,
      active: value === {
        subcategory: this.#subcategory,
        detail: this.#detail,
        extra: this.#extra
      }[property]
    })).sort((a, b) => {
      if (property === "subcategory" && this.#category === "spells") {
        const circleRank = label => label === "Cantrip" ? 0 : Number.parseInt(label, 10) || 99;
        return circleRank(a.label) - circleRank(b.label);
      }
      if (property === "subcategory" && this.#category === "magicItems") {
        const rarityRank = label => MAGIC_ITEM_RARITY_ORDER.get(label.toLocaleLowerCase("en")) ?? 8;
        return rarityRank(a.label) - rarityRank(b.label) || a.label.localeCompare(b.label, "en");
      }
      return a.label.localeCompare(b.label, "en");
    });
  }

  #spellOptionCounts(entries, valuesFor, labelFor) {
    const counts = new Map();
    for (const entry of deduplicateEntries(entries)) {
      for (const value of new Set(valuesFor(entry).filter(Boolean))) {
        counts.set(value, (counts.get(value) ?? 0) + 1);
      }
    }
    return [...counts].map(([value, count]) => ({ value, label: labelFor(value), count }))
      .sort((left, right) => left.label.localeCompare(right.label, game.i18n.lang));
  }

  #matchesFilter(value, selected) {
    if (!selected) return true;
    return Array.isArray(value) ? value.includes(selected) : value === selected;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const updated = this.#indexMeta?.updatedAt
      ? new Intl.DateTimeFormat(game.i18n.lang, { dateStyle: "short", timeStyle: "short" }).format(this.#indexMeta.updatedAt)
      : game.i18n.localize("TOVF.Library.Index.MissingShort");
    const title = this.element.closest(".application")?.querySelector(".window-title")
      ?? this.element.querySelector(".window-title");
    if (title) title.textContent = `${game.i18n.localize("TOVF.Library.Title")} · ${game.i18n.format("TOVF.Library.Index.UpdatedShort", { date: updated })}`;
    const search = this.element.querySelector("[data-library-search]");
    search?.addEventListener("input", event => {
      this.#query = event.currentTarget.value;
      this.#filterRenderedEntries();
    });
    for (const source of this.element.querySelectorAll("[data-library-source]")) {
      source.addEventListener("change", event => {
        const value = event.currentTarget.value;
        if (!value) {
          this.#sources = event.currentTarget.checked ? null : new Set();
        } else {
          const availableSources = [...this.element.querySelectorAll("[data-library-source]")]
            .map(input => input.value)
            .filter(Boolean);
          if (this.#sources === null) {
            this.#sources = new Set(availableSources);
          }
          if (event.currentTarget.checked) this.#sources.add(value);
          else this.#sources.delete(value);
          if (availableSources.every(sourceId => this.#sources.has(sourceId))) this.#sources = null;
        }
        this.render();
      });
    }
    for (const select of this.element.querySelectorAll("[data-library-filter]")) {
      select.addEventListener("change", event => {
        const property = event.currentTarget.dataset.libraryFilter;
        if (property === "subcategory") {
          this.#subcategory = event.currentTarget.value;
          this.#detail = "";
          this.#extra = "";
        } else if (property === "detail") {
          this.#detail = event.currentTarget.value;
          this.#extra = "";
        } else if (property === "extra") {
          this.#extra = event.currentTarget.value;
        } else if (property === "challengeRating") {
          this.#challengeRating = event.currentTarget.value;
          this.#subcategory = "";
          this.#detail = "";
          this.#extra = "";
        } else if (property === "magicAttunement") {
          this.#magicAttunement = event.currentTarget.value;
        } else if (property === "magicItemSort") {
          this.#magicItemSort = event.currentTarget.value;
        } else if (property === "monsterType") {
          this.#monsterType = event.currentTarget.value;
        } else if (property === "monsterSize") {
          this.#monsterSize = event.currentTarget.value;
        } else if (property === "monsterSpellcaster") {
          this.#monsterSpellcaster = event.currentTarget.value;
        } else if (property === "spellCastingTime") {
          this.#spellCastingTime = event.currentTarget.value;
        } else if (property === "spellDuration") {
          this.#spellDuration = event.currentTarget.value;
        } else if (property === "spellResolution") {
          this.#spellResolution = event.currentTarget.value;
        }
        this.render();
      });
    }
    for (const checkbox of this.element.querySelectorAll("[data-library-spell-multi]")) {
      checkbox.addEventListener("change", event => {
        const target = event.currentTarget;
        const selection = {
          damage: this.#spellDamageTypes,
          condition: this.#spellConditions,
          component: this.#spellComponents
        }[target.dataset.librarySpellMulti];
        if (!selection) return;
        if (target.checked) selection.add(target.value);
        else selection.delete(target.value);
        this.render();
      });
    }
    for (const checkbox of this.element.querySelectorAll("[data-library-monster-multi]")) {
      checkbox.addEventListener("change", event => {
        const selection = this.#monsterMulti[event.currentTarget.dataset.libraryMonsterMulti];
        if (!selection) return;
        if (event.currentTarget.checked) selection.add(event.currentTarget.value);
        else selection.delete(event.currentTarget.value);
        this.render();
      });
    }
    for (const input of this.element.querySelectorAll("[data-library-monster-number]")) {
      input.addEventListener("change", event => {
        const setters = { CrMin: value => this.#monsterCrMin = value, CrMax: value => this.#monsterCrMax = value, AcMin: value => this.#monsterAcMin = value, AcMax: value => this.#monsterAcMax = value, HpMin: value => this.#monsterHpMin = value, HpMax: value => this.#monsterHpMax = value };
        setters[event.currentTarget.dataset.libraryMonsterNumber]?.(event.currentTarget.value);
        this.render();
      });
    }
    for (const row of this.element.querySelectorAll("[data-library-entry]")) {
      const image = row.querySelector("img");
      image?.addEventListener("error", () => {
        if (!image.src.endsWith(FALLBACK_ITEM_IMAGE)) image.src = FALLBACK_ITEM_IMAGE;
      }, { once: true });
      row.addEventListener("dragstart", event => {
        event.dataTransfer.setData("text/plain", JSON.stringify({
          type: row.dataset.documentType,
          uuid: row.dataset.uuid
        }));
      });
    }
    this.element.querySelector('[data-action="toggleTableBuilder"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.#toggleTableBuilder();
    });
    this.element.querySelector('[data-table-action="select-visible"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.#selectVisibleTableEntries();
    });
    this.element.querySelector('[data-table-action="clear"]')?.addEventListener("click", event => {
      event.preventDefault();
      this.#clearTableEntries();
    });
    this.element.querySelector('[data-table-action="create"]')?.addEventListener("click", event => {
      event.preventDefault();
      void this.#createRollTable();
    });
    for (const checkbox of this.element.querySelectorAll('[data-table-entry-select]')) {
      checkbox.addEventListener("change", event => this.#toggleTableEntry(event.currentTarget));
    }
    this.element.querySelector("[data-library-void]")?.addEventListener("click", event => {
      event.preventDefault();
      this.#spellVoid = !this.#spellVoid;
      this.render();
    });
    this.element.querySelector("[data-library-concentration]")?.addEventListener("click", event => {
      event.preventDefault();
      this.#spellConcentration = !this.#spellConcentration;
      this.render();
    });
    this.element.querySelector("[data-library-ritual]")?.addEventListener("click", event => {
      event.preventDefault();
      this.#spellRitual = !this.#spellRitual;
      this.render();
    });
    this.element.querySelector("[data-library-spell-reset]")?.addEventListener("click", event => {
      event.preventDefault();
      this.#resetSpellFilters();
      this.render();
    });
    this.element.querySelector("[data-library-monster-legendary]")?.addEventListener("click", event => {
      event.preventDefault();
      this.#monsterLegendary = !this.#monsterLegendary;
      this.render();
    });
    this.element.querySelector("[data-library-monster-reset]")?.addEventListener("click", event => {
      event.preventDefault();
      this.#resetMonsterFilters();
      this.render();
    });
  }

  #filterRenderedEntries() {
    const query = this.#query.trim().toLocaleLowerCase(game.i18n.lang);
    let visible = 0;
    for (const row of this.element.querySelectorAll("[data-library-entry]")) {
      const matches = !query || row.dataset.name.includes(query);
      row.hidden = !matches;
      if (matches) visible++;
    }
    const count = this.element.querySelector("[data-library-count]");
    if (count) count.textContent = game.i18n.format("TOVF.Library.Results", { count: visible });
  }

  static #selectCategory(_event, target) {
    this.#category = target.dataset.category;
    this.#sources = null;
    this.#query = "";
    this.#subcategory = "";
    this.#detail = "";
    this.#extra = "";
    this.#challengeRating = "";
    this.#spellCastingTime = "";
    this.#spellDuration = "";
    this.#spellDamageTypes.clear();
    this.#spellConditions.clear();
    this.#spellComponents.clear();
    this.#spellResolution = "";
    this.#spellConcentration = false;
    this.#spellRitual = false;
    this.#spellVoid = false;
    this.#magicAttunement = "";
    this.render();
  }

  static #selectSubcategory(_event, target) {
    this.#subcategory = target.dataset.subcategory;
    this.#detail = "";
    this.#extra = "";
    this.render();
  }

  static #selectDetail(_event, target) {
    this.#detail = target.dataset.detail;
    this.#extra = "";
    this.render();
  }

  static #selectExtra(_event, target) {
    this.#extra = target.dataset.extra;
    this.render();
  }

  #resetSpellFilters() {
    this.#spellCastingTime = "";
    this.#spellDuration = "";
    this.#spellDamageTypes.clear();
    this.#spellConditions.clear();
    this.#spellComponents.clear();
    this.#spellResolution = "";
    this.#spellConcentration = false;
    this.#spellRitual = false;
    this.#spellVoid = false;
  }

  #resetMonsterFilters() {
    this.#monsterType = this.#monsterSize = this.#monsterCrMin = this.#monsterCrMax = this.#monsterAcMin = this.#monsterAcMax = "";
    this.#monsterHpMin = this.#monsterHpMax = this.#monsterSpellcaster = "";
    this.#monsterLegendary = false;
    for (const selection of Object.values(this.#monsterMulti)) selection.clear();
  }

  static #setLayout(_event, target) {
    this.#layout = target.dataset.layout;
    this.render();
  }

  #toggleTableBuilder() {
    if (!game.user.isGM) return;
    this.#tableBuilder = !this.#tableBuilder;
    this.render();
  }

  #toggleTableEntry(target) {
    const uuid = target.closest("[data-library-entry]")?.dataset.uuid;
    if (!uuid) return;
    if (target.checked) this.#tableEntries.add(uuid);
    else this.#tableEntries.delete(uuid);
    this.#updateTableSelectionCount();
  }

  #selectVisibleTableEntries() {
    for (const row of this.element.querySelectorAll('[data-library-entry]:not([hidden])')) {
      this.#tableEntries.add(row.dataset.uuid);
      const checkbox = row.querySelector("[data-table-entry-select]");
      if (checkbox) checkbox.checked = true;
    }
    this.#updateTableSelectionCount();
    const create = this.element.querySelector('[data-table-action="create"]');
    if (create) create.disabled = !this.#tableEntries.size;
  }

  #clearTableEntries() {
    this.#tableEntries.clear();
    for (const checkbox of this.element.querySelectorAll('[data-table-entry-select]')) checkbox.checked = false;
    this.#updateTableSelectionCount();
    const create = this.element.querySelector('[data-table-action="create"]');
    if (create) create.disabled = true;
  }

  #updateTableSelectionCount() {
    const count = this.element.querySelector("[data-table-selection-count]");
    if (count) count.textContent = String(this.#tableEntries.size);
    const create = this.element.querySelector('[data-table-action="create"]');
    if (create) create.disabled = !this.#tableEntries.size;
  }

  async #createRollTable() {
    if (!game.user.isGM || !this.#tableEntries.size) return;
    const selected = [...this.#tableEntries]
      .map(uuid => this.#entries.find(entry => entry.uuid === uuid))
      .filter(Boolean);
    if (!selected.length) return;
    const name = await foundry.applications.api.DialogV2.prompt({
      window: { title: "Rolltable erstellen" },
      content: `<div class="form-group"><label>Name der Rolltable</label><input name="name" value="Neue Bibliotheks-Rolltable" autofocus></div>`,
      ok: { label: "Erstellen", callback: (_event, button) => button.form.elements.name.value.trim() },
      rejectClose: false
    });
    if (!name) return;
    const resultType = CONST.TABLE_RESULT_TYPES?.COMPENDIUM ?? 2;
    const table = await RollTable.create({
      name,
      formula: `1d${selected.length}`,
      replacement: true,
      displayRoll: true,
      results: selected.map((entry, index) => ({
        type: resultType,
        documentCollection: entry.pack,
        documentId: entry.id,
        text: entry.name,
        img: entry.img,
        weight: 1,
        range: [index + 1, index + 1],
        drawn: false
      }))
    });
    ui.notifications.info(`Rolltable „${table.name}“ mit ${selected.length} Einträgen erstellt.`);
    table.sheet.render(true);
  }

  static async #openDocument(_event, target) {
    const row = target.closest("[data-library-entry]");
    const document = await fromUuid(row.dataset.uuid);
    if (String(document?.img ?? "").startsWith("modules/delve/")) {
      document.updateSource({ img: safeImage("", document.documentName) });
    }
    document?.sheet?.render(true);
  }

  static #openPack(_event, target) {
    game.packs.get(target.dataset.pack)?.render(true);
  }

  async rebuildIndex() {
    if (!game.user.isGM) return;
    ui.notifications.info(game.i18n.localize("TOVF.Library.Index.Building"));
    try {
      const entries = await this.#scanEntries();
      const cache = await saveLibraryIndex(entries);
      this.#entries = entries;
      this.#indexMeta = { updatedAt: cache.updatedAt, count: entries.length };
      ui.notifications.info(game.i18n.format("TOVF.Library.Index.Complete", { count: entries.length }));
      this.render();
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to build library index.`, error);
      ui.notifications.error(game.i18n.localize("TOVF.Library.Index.Failed"));
    }
  }

}

let library;

async function openLibrary() {
  if (library) await library.close({ animate: false });
  library = new CompendiumLibrary();
  library.render({ force: true });
}

function addLibraryButton(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("[data-tovf-library]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "tovf-library-launch";
  button.dataset.tovfLibrary = "";
  button.innerHTML = `<i class="fa-solid fa-books" inert></i> ${game.i18n.localize("TOVF.Library.Open")}`;
  button.addEventListener("click", openLibrary);
  const header = root.querySelector(".directory-header") ?? root.querySelector("header") ?? root;
  header.append(button);
}

export function registerCompendiumLibrary() {
  Hooks.on("renderCompendiumDirectory", addLibraryButton);
  Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
    if (!(app instanceof CompendiumLibrary) || !game.user.isGM || !Array.isArray(controls)) return;
    controls.unshift({
      action: "tovf-rebuild-library-index",
      icon: "fa-solid fa-arrows-rotate",
      label: game.i18n.localize(libraryIndexPack() ? "TOVF.Library.Index.Rebuild" : "TOVF.Library.Index.Build"),
      visible: true,
      onClick: () => void app.rebuildIndex()
    });
  });
  game.modules.get(MODULE_ID).api ??= {};
  game.modules.get(MODULE_ID).api.openLibrary = openLibrary;
}
