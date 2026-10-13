import { CONTENT_MODULE_ID, MODULE_ID } from "./core/constants.mjs";

const CONCEPT_TYPES = new Set(["lineage", "heritage", "background"]);
let index = new Map();
let refreshPromise = null;

function sourcePackage(pack) { return pack.metadata.packageName ?? pack.metadata.package ?? ""; }
function supportedPackage(id) {
  return id === CONTENT_MODULE_ID || id === game.system.id || id === "koboldpressogl-bf" || id.startsWith("kp-tov-");
}
function identity(entry) {
  const identifier = foundry.utils.getProperty(entry, "system.identifier.value");
  return identifier ? `identifier:${String(identifier).trim().toLocaleLowerCase("en")}` : `name:${String(entry.name ?? "").trim().toLocaleLowerCase(game.i18n.lang)}`;
}
function humanize(value) { return String(value ?? "").replaceAll(/[-_]/g, " ").replaceAll(/\b\w/g, letter => letter.toUpperCase()); }
function collectStrings(value, strings = new Set()) {
  if (typeof value === "string") strings.add(value);
  else if (value && typeof value === "object") for (const child of Object.values(value)) collectStrings(child, strings);
  return strings;
}
function proficiencyLabel(group, key) {
  const config = CONFIG.BlackFlag;
  const collection = config?.[group]?.localized ?? config?.[group];
  return collection?.[key] ?? humanize(key);
}
function advancementContents(advancements) {
  const references = { feature: new Set(), talent: new Set() };
  const proficiencies = new Set();
  for (const advancement of Object.values(advancements ?? {})) {
    const configuration = advancement?.configuration ?? {};
    const type = String(configuration.type ?? "");
    if (type === "feature" || type === "talent") {
      for (const value of collectStrings(configuration)) {
        if (/^(?:Compendium\.[^.]+\.[^.]+\.Item\.|Item\.)[A-Za-z0-9]+$/.test(value)) references[type].add(value);
      }
    }
    if (advancement?.type !== "trait") continue;
    for (const value of collectStrings(configuration)) {
      const match = value.match(/^(skills|tools|languages|weapons|armor):(.+)$/);
      if (!match || match[2] === "*") continue;
      const [, group, key] = match;
      proficiencies.add(`${humanize(group.slice(0, -1))}: ${proficiencyLabel(group, key)}`);
    }
  }
  return { references, proficiencies: [...proficiencies].sort((a, b) => a.localeCompare(b, game.i18n.lang)) };
}

async function buildIndex() {
  const packs = game.packs.filter(pack => pack.documentName === "Item" && pack.visible !== false && supportedPackage(sourcePackage(pack)));
  const entries = (await Promise.all(packs.map(async pack => {
    try {
      const documents = await pack.getIndex({ fields: ["type", "system.identifier.value", "system.advancement", "flags.core.sourceId"] });
      return documents.map(document => ({ ...document, uuid: pack.getUuid(document._id) }));
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not index character options from ${pack.collection}.`, error);
      return [];
    }
  }))).flat();
  const labels = new Map(entries.map(entry => [entry.uuid, { name: entry.name, identity: identity(entry) }]));
  for (const entry of entries) {
    const sourceId = foundry.utils.getProperty(entry, "flags.core.sourceId");
    if (sourceId) labels.set(sourceId, { name: entry.name, identity: identity(entry) });
  }
  const next = new Map();
  for (const entry of entries.filter(entry => CONCEPT_TYPES.has(entry.type))) {
    const contents = advancementContents(entry.system?.advancement);
    const resolved = uuids => [...uuids].map(uuid => labels.get(uuid) ?? { name: uuid, identity: `uuid:${uuid}` });
    const resolve = uuids => resolved(uuids).map(entry => entry.name).sort((a, b) => a.localeCompare(b, game.i18n.lang));
    next.set(entry.uuid, {
      uuid: entry.uuid, type: entry.type, name: entry.name,
      features: resolve(contents.references.feature),
      talents: entry.type === "background" ? resolve(contents.references.talent) : [],
      talentIdentities: entry.type === "background" ? resolved(contents.references.talent).map(entry => entry.identity) : [],
      proficiencies: contents.proficiencies
    });
  }
  index = next;
  console.info(`${MODULE_ID} | Indexed ${index.size} character selection options.`);
  return index;
}

export function refreshCharacterOptionIndex() {
  if (!refreshPromise) refreshPromise = buildIndex().finally(() => { refreshPromise = null; });
  return refreshPromise;
}
export function ensureCharacterOptionIndex() { return index.size ? Promise.resolve(index) : refreshCharacterOptionIndex(); }
export function characterOption(uuid) { return index.get(uuid) ?? null; }
export function characterOptions(type) { return [...index.values()].filter(option => !type || option.type === type); }
export function characterOptionsForTalent(item) {
  const itemIdentity = identity(item);
  return [...index.values()].filter(option => option.type === "background" && option.talentIdentities.includes(itemIdentity))
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}
export function registerCharacterOptionIndex() {
  Hooks.once("ready", () => void refreshCharacterOptionIndex().catch(error => console.error(`${MODULE_ID} | Failed to build character option index.`, error)));
  for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, item => {
    if (item.pack && (CONCEPT_TYPES.has(item.type) || item.type === "feature" || item.type === "talent")) void refreshCharacterOptionIndex();
  });
}
