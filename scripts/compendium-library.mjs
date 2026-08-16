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
  const type = String(foundry.utils.getProperty(entry, "system.casting.type") ?? "").toLocaleLowerCase("en");
  if (type === "action") return "action";
  if (type === "bonus") return "bonus";
  if (type === "reaction" || type.startsWith("reaction")) return "reaction";
  return "";
}

function spellRequiresConcentration(entry) {
  const tags = foundry.utils.getProperty(entry, "system.tags");
  const tagged = tags instanceof Set
    ? tags.has("concentration")
    : Array.isArray(tags)
      ? tags.includes("concentration")
      : Boolean(tags?.concentration);
  return tagged || Boolean(foundry.utils.getProperty(entry, "system.duration.concentration"));
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
      detail: humanize(typeBase || typeCategory || typeValue)
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
      selectSpellCastingTime: this.#selectSpellCastingTime,
      toggleSpellConcentration: this.#toggleSpellConcentration,
      setLayout: this.#setLayout,
      openDocument: this.#openDocument,
      openPack: this.#openPack
    }
  };

  static PARTS = {
    content: { template: modulePath("templates/compendium-library.hbs") }
  };

  #entries = null;
  #category = "monsters";
  #sources = new Set();
  #query = "";
  #subcategory = "";
  #detail = "";
  #extra = "";
  #challengeRating = "";
  #spellCastingTime = "";
  #spellConcentration = false;
  #spellVoid = false;
  #layout = "list";
  #tableBuilder = false;
  #tableEntries = new Set();

  async #loadEntries() {
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
          "system.identifier.associated",
          "system.level.value",
          "system.attributes.cr",
          "system.circle.base",
          "system.source",
          "system.school",
          "system.casting.type",
          "system.tags",
          "system.duration.concentration"
          , "system.description.value"
          , `flags.${MODULE_ID}.library.tags`
        ]
      });
      const packageId = packageIdFor(pack);
      for (const entry of index) {
        const category = categoryFor(pack, entry);
        const classification = classificationFor(pack, entry, category);
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
            ? Number(foundry.utils.getProperty(entry, "system.attributes.cr"))
            : null,
          spellCastingTime: entry.type === "spell" ? spellCastingTime(entry) : "",
          spellConcentration: entry.type === "spell" && spellRequiresConcentration(entry),
          spellVoid: entry.type === "spell" && spellIsVoid(entry),
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
    this.#entries = entries;
  }

  async _prepareContext(options) {
    if (!this.#entries) await this.#loadEntries();
    const query = this.#query.toLocaleLowerCase(game.i18n.lang);
    const categoryEntries = this.#entries.filter(entry => (
      entry.category === this.#category
      && (!this.#sources.size || this.#sources.has(entry.source))
    ));
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
    const details = (this.#subcategory || this.#category === "spells")
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
    const matchingEntries = spellFilterEntries.filter(entry => (
      (!this.#spellCastingTime || entry.spellCastingTime === this.#spellCastingTime)
      && (!this.#spellConcentration || entry.spellConcentration)
      && (!this.#spellVoid || entry.spellVoid)
      && (!query || entry.name.toLocaleLowerCase(game.i18n.lang).includes(query))
    ));
    const entries = deduplicateEntries(matchingEntries).map(entry => ({
      ...entry,
      tableSelectable: true,
      tableSelected: this.#tableEntries.has(entry.uuid)
    }));
    const sources = [...new Map(
      this.#entries
        .filter(entry => entry.category === this.#category)
        .map(entry => [entry.source, entry.sourceLabel])
    )].map(([value, label]) => ({ value, label, selected: this.#sources.has(value) }))
      .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    return {
      ...(await super._prepareContext(options)),
      categories: CATEGORIES.map(category => ({
        ...category,
        active: category.id === this.#category,
        count: deduplicateEntries(
          this.#entries.filter(entry => entry.category === category.id)
        ).length
      })),
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
      spellCastingTimes: ["action", "bonus", "reaction"].map(value => ({
        value,
        label: game.i18n.localize(`TOVF.Library.SpellCastingTime.${value}`),
        count: deduplicateEntries(spellFilterEntries.filter(entry => entry.spellCastingTime === value)).length,
        active: this.#spellCastingTime === value
      })),
      selectedSpellCastingTime: this.#spellCastingTime,
      spellConcentration: this.#spellConcentration,
      spellConcentrationCount: deduplicateEntries(spellFilterEntries.filter(entry => (
        (!this.#spellCastingTime || entry.spellCastingTime === this.#spellCastingTime)
        && entry.spellConcentration
      ))).length,
      spellVoid: this.#spellVoid,
      spellVoidCount: deduplicateEntries(spellFilterEntries.filter(entry => (
        (!this.#spellCastingTime || entry.spellCastingTime === this.#spellCastingTime)
        && (!this.#spellConcentration || entry.spellConcentration)
        && entry.spellVoid
      ))).length,
      subcategoryLabel: this.#category === "spells" ? "Circle" : "Subcategory",
      detailLabel: this.#category === "spells" ? "Source of Magic" : classFeatures ? "Class" : "Type",
      extraLabel: this.#category === "spells" ? "School of Magic" : "Feature Type",
      layout: this.#layout,
      listLayout: this.#layout === "list",
      gridLayout: this.#layout === "grid",
      sources,
      isGM: game.user.isGM,
      allSourcesSelected: !this.#sources.size,
      sourceSelectionLabel: this.#sources.size
        ? game.i18n.format("TOVF.Library.SelectedSources", { count: this.#sources.size })
        : game.i18n.localize("TOVF.Library.AllSources"),
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
      return a.label.localeCompare(b.label, "en");
    });
  }

  #matchesFilter(value, selected) {
    if (!selected) return true;
    return Array.isArray(value) ? value.includes(selected) : value === selected;
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const search = this.element.querySelector("[data-library-search]");
    search?.addEventListener("input", event => {
      this.#query = event.currentTarget.value;
      this.#filterRenderedEntries();
    });
    for (const source of this.element.querySelectorAll("[data-library-source]")) {
      source.addEventListener("change", event => {
        const value = event.currentTarget.value;
        if (!value) this.#sources.clear();
        else if (event.currentTarget.checked) this.#sources.add(value);
        else this.#sources.delete(value);
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
        }
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
    this.#sources.clear();
    this.#query = "";
    this.#subcategory = "";
    this.#detail = "";
    this.#extra = "";
    this.#challengeRating = "";
    this.#spellCastingTime = "";
    this.#spellConcentration = false;
    this.#spellVoid = false;
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

  static #selectSpellCastingTime(_event, target) {
    const value = target.dataset.spellCastingTime;
    this.#spellCastingTime = this.#spellCastingTime === value ? "" : value;
    this.render();
  }

  static #toggleSpellConcentration() {
    this.#spellConcentration = !this.#spellConcentration;
    this.render();
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
  game.modules.get(MODULE_ID).api ??= {};
  game.modules.get(MODULE_ID).api.openLibrary = openLibrary;
}
