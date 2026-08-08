import { CONTENT_MODULE_ID, MODULE_ID } from "../core/constants.mjs";

const ITEM_PACK = `${CONTENT_MODULE_ID}.items`;
const CLASS_PACK = `${CONTENT_MODULE_ID}.classes`;

let installed = false;
let synchronization = null;
const uuidOverrides = new Map();

function identifierOf(document) {
  return String(document?.system?.identifier?.value ?? document?.identifier ?? "").trim();
}

function normalizedIdentifier(value) {
  return String(value ?? "").toLocaleLowerCase("en").replaceAll(/[^a-z0-9]/g, "");
}

function moveToEnd(values, value) {
  const remaining = values.filter(entry => entry !== value);
  remaining.push(value);
  return remaining;
}

function groupBy(values, callback) {
  const groups = new Map();
  for (const value of values) {
    const key = callback(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

async function prioritizeClasses() {
  const pack = game.packs.get(CLASS_PACK);
  if (!pack) return { prioritized: 0, conflicts: 0 };

  let prioritized = 0;
  let conflicts = 0;
  const classes = (await pack.getDocuments()).filter(document => document.type === "class");
  const byIdentifier = groupBy(classes, identifierOf);

  for (const [identifier, documents] of byIdentifier) {
    if (!identifier) continue;
    if (documents.length !== 1) {
      conflicts += 1;
      console.warn(
        `${MODULE_ID} | Cannot prioritize class "${identifier}": ${documents.length} Feuerschwinge entries found.`,
        documents.map(document => document.uuid)
      );
      continue;
    }

    const document = documents[0];
    const registration = CONFIG.BlackFlag.registration.get("class", identifier);
    if (!registration) {
      console.warn(`${MODULE_ID} | Cannot prioritize unregistered class "${identifier}" (${document.uuid}).`);
      continue;
    }

    registration.sources = moveToEnd(registration.sources, document.uuid);
    registration.name = document.name;
    registration.img = document.img;
    prioritized += 1;
  }

  return { prioritized, conflicts };
}

function configuredWeapons() {
  const weapons = CONFIG.BlackFlag.weapons;
  if (!weapons) return [];

  const entries = [];
  for (const category of ["simple", "martial"]) {
    for (const [base, configuration] of Object.entries(weapons[category]?.children ?? {})) {
      if (configuration.link) entries.push({ base, category, configuration });
    }
  }
  return entries;
}

async function prioritizeWeapons() {
  uuidOverrides.clear();
  const pack = game.packs.get(ITEM_PACK);
  if (!pack) return { prioritized: 0, missing: 0, conflicts: 0 };

  const documents = (await pack.getDocuments()).filter(document => document.type === "weapon");
  const byIdentifier = groupBy(documents, identifierOf);
  const byBase = groupBy(documents, document => {
    const category = String(document.system?.type?.category ?? "").trim();
    const base = String(document.system?.type?.base ?? "").trim();
    return category && base ? `${category}.${base}` : "";
  });
  const aliases = new Map();
  let prioritized = 0;
  let missing = 0;
  let conflicts = 0;

  for (const { base, category, configuration } of configuredWeapons()) {
    const officialUuid = configuration.__tovfOriginalLink ?? configuration.link;
    Object.defineProperty(configuration, "__tovfOriginalLink", {
      value: officialUuid,
      configurable: true,
      writable: true
    });

    let official;
    try {
      official = await fromUuid(officialUuid);
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not resolve the Black Flag ${base} weapon (${officialUuid}).`, error);
    }
    const identifier = identifierOf(official);
    const baseMatches = byBase.get(`${category}.${base}`) ?? [];
    let matches = baseMatches;
    if (matches.length > 1) {
      const standardMatches = matches.filter(document => (
        normalizedIdentifier(identifierOf(document)) === normalizedIdentifier(base)
      ));
      if (standardMatches.length) matches = standardMatches;
    }
    if (!matches.length && identifier) matches = byIdentifier.get(identifier) ?? [];

    if (matches.length === 0) {
      missing += 1;
      configuration.link = officialUuid;
      console.warn(
        `${MODULE_ID} | No Feuerschwinge override found for ${category} weapon "${base}"`,
        { identifier, officialUuid }
      );
      continue;
    }
    if (matches.length !== 1) {
      conflicts += 1;
      configuration.link = officialUuid;
      console.warn(
        `${MODULE_ID} | Cannot override ${category} weapon "${base}": ${matches.length} entries share identifier "${identifier}".`,
        matches.map(document => document.uuid)
      );
      continue;
    }

    const replacement = matches[0];
    configuration.link = replacement.uuid;
    const alias = aliases.get(officialUuid) ?? { official, replacements: new Map() };
    alias.official ??= official;
    alias.replacements.set(replacement.uuid, replacement);
    aliases.set(officialUuid, alias);
    prioritized += 1;
  }

  for (const [officialUuid, { official, replacements }] of aliases) {
    if (replacements.size === 1) {
      uuidOverrides.set(officialUuid, replacements.keys().next().value);
      continue;
    }

    // Some Black Flag configuration entries incorrectly share a UUID. A bare
    // UUID still means the document it actually resolves to, while category
    // choices have already been routed independently using category and base.
    const officialIdentifier = identifierOf(official);
    const directMatches = [...replacements.values()].filter(document => (
      identifierOf(document) === officialIdentifier
    ));
    if (directMatches.length === 1) {
      uuidOverrides.set(officialUuid, directMatches[0].uuid);
    } else {
      console.warn(
        `${MODULE_ID} | Direct equipment link ${officialUuid} is ambiguous and will not be overridden.`,
        [...replacements.keys()]
      );
    }
  }

  return { prioritized, missing, conflicts };
}

async function synchronizeCharacterCreationOverrides() {
  if (synchronization) return synchronization;
  synchronization = Promise.all([prioritizeClasses(), prioritizeWeapons()])
    .then(([classes, weapons]) => {
      console.info(`${MODULE_ID} | Character Creation overrides synchronized.`, { classes, weapons });
      return { classes, weapons };
    })
    .catch(error => {
      console.error(`${MODULE_ID} | Character Creation override synchronization failed.`, error);
    })
    .finally(() => {
      synchronization = null;
    });
  return synchronization;
}

function installEquipmentUuidResolver() {
  const EquipmentEntryData = BlackFlag?.data?.advancement?.EquipmentEntryData;
  const prototype = EquipmentEntryData?.prototype;
  const original = prototype?.findSelection;
  if (typeof original !== "function" || original.__tovfCharacterCreationResolver) return;

  function findSelection(selection) {
    const uuid = original.call(this, selection);
    return uuidOverrides.get(uuid) ?? uuid;
  }
  Object.defineProperty(findSelection, "__tovfCharacterCreationResolver", { value: true });
  prototype.findSelection = findSelection;
}

/**
 * Prefer Feuerschwinge classes and standard weapons in Black Flag's existing
 * Character Creation without replacing its selection flow.
 */
export function installCharacterCreationOverrides() {
  if (installed) return;
  installed = true;

  installEquipmentUuidResolver();
  if (CONFIG.BlackFlag.registration.ready) void synchronizeCharacterCreationOverrides();
  else Hooks.once("blackFlag.registrationComplete", synchronizeCharacterCreationOverrides);

  Hooks.on("createItem", item => {
    if (item.pack === ITEM_PACK || item.pack === CLASS_PACK) void synchronizeCharacterCreationOverrides();
  });
  Hooks.on("updateItem", item => {
    if (item.pack === ITEM_PACK || item.pack === CLASS_PACK) void synchronizeCharacterCreationOverrides();
  });
  Hooks.on("deleteItem", item => {
    if (item.pack === ITEM_PACK || item.pack === CLASS_PACK) void synchronizeCharacterCreationOverrides();
  });
}

export const characterCreationOverridesApi = {
  resolveUuid(uuid) {
    return uuidOverrides.get(uuid) ?? uuid;
  },
  synchronize: synchronizeCharacterCreationOverrides
};
