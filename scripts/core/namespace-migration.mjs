import { LEGACY_MODULE_SCOPE, MODULE_ID } from "./constants.mjs";

const MIGRATION_VERSION = 1;
const VERSION_SETTING = "namespaceMigrationVersion";
const REPORT_SETTING = "namespaceMigrationReport";
const WARNING_SETTING = "warnLegacyNamespaceAccess";
const GUARD = Symbol.for(`${MODULE_ID}.legacyNamespaceGuard`);
const warnedAccesses = new Set();

function storageValue(scope, namespace, key) {
  const entry = game.settings.storage.get(scope)?.get(`${namespace}.${key}`);
  if (entry === undefined) return undefined;
  return entry && typeof entry === "object" && "value" in entry ? entry.value : entry;
}

function clone(value) {
  return foundry.utils.deepClone(value);
}

function equal(left, right) {
  if (typeof foundry.utils.objectsEqual === "function") {
    return foundry.utils.objectsEqual(left, right);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function registeredToolSettings() {
  const prefix = `${MODULE_ID}.`;
  return [...game.settings.settings]
    .filter(([fullKey]) => fullKey.startsWith(prefix))
    .map(([fullKey, config]) => ({ key: fullKey.slice(prefix.length), scope: config.scope }))
    .filter(({ key }) => ![VERSION_SETTING, REPORT_SETTING, WARNING_SETTING].includes(key));
}

async function migrateSettings(scopes) {
  const copied = [];
  const retained = [];
  for (const { key, scope } of registeredToolSettings()) {
    if (!scopes.has(scope)) continue;
    const legacy = storageValue(scope, LEGACY_MODULE_SCOPE, key);
    if (legacy === undefined) continue;
    const current = storageValue(scope, MODULE_ID, key);
    if (current === undefined) {
      await game.settings.set(MODULE_ID, key, clone(legacy));
      const migrated = storageValue(scope, MODULE_ID, key);
      if (!equal(migrated, legacy)) throw new Error(`Setting verification failed: ${key}`);
      copied.push(`${scope}:${key}`);
    } else {
      retained.push(`${scope}:${key}`);
    }
  }
  return { copied, retained };
}

function embeddedDocuments(document) {
  const result = [];
  const embedded = document?.constructor?.metadata?.embedded ?? {};
  for (const [documentName, property] of Object.entries(embedded)) {
    let collection;
    try {
      collection = document.getEmbeddedCollection?.(documentName);
    } catch (_error) {
      collection = document[property];
    }
    if (!collection) continue;
    result.push(...collection);
  }
  return result;
}

function worldDocuments() {
  const documents = new Map();
  const add = document => {
    if (!document?.uuid || documents.has(document.uuid)) return;
    documents.set(document.uuid, document);
    for (const embedded of embeddedDocuments(document)) add(embedded);
  };
  for (const collection of game.collections?.values?.() ?? []) {
    for (const document of collection) add(document);
  }
  for (const collection of [game.users, game.folders, game.messages]) {
    for (const document of collection ?? []) add(document);
  }
  return [...documents.values()];
}

async function migrateFlags() {
  let copied = 0;
  let retained = 0;
  const verified = [];
  for (const document of worldDocuments()) {
    const legacy = document.flags?.[LEGACY_MODULE_SCOPE];
    if (!legacy || typeof legacy !== "object") continue;
    const current = document.flags?.[MODULE_ID];
    const merged = foundry.utils.mergeObject(clone(legacy), clone(current ?? {}), { inplace: false });
    if (!current || !equal(current, merged)) {
      await document.update({ [`flags.${MODULE_ID}`]: merged });
      copied++;
    } else {
      retained++;
    }
    if (!equal(document.flags?.[MODULE_ID], merged)) {
      throw new Error(`Flag verification failed: ${document.uuid}`);
    }
    verified.push(document.uuid);
  }
  return { copied, retained, verified };
}

function warn(kind, scope, key) {
  if (scope !== LEGACY_MODULE_SCOPE || game.settings.get(MODULE_ID, WARNING_SETTING) === false) return;
  const signature = `${kind}:${key ?? "*"}`;
  if (warnedAccesses.has(signature)) return;
  warnedAccesses.add(signature);
  const message = `${MODULE_ID} | Obsolete namespace access: ${kind}("${scope}", "${key ?? ""}"). Use "${MODULE_ID}" instead.`;
  console.warn(message, new Error("Legacy namespace access trace"));
  Hooks.callAll(`${MODULE_ID}.legacyNamespaceAccess`, { kind, scope, key, message });
}

function wrap(target, method, scopeIndex = 0, keyIndex = 1) {
  const original = target?.[method];
  if (typeof original !== "function" || original[GUARD]) return;
  const wrapped = function(...args) {
    warn(method, args[scopeIndex], args[keyIndex]);
    return original.apply(this, args);
  };
  Object.defineProperty(wrapped, GUARD, { value: true });
  target[method] = wrapped;
}

export function registerNamespaceMigration() {
  game.settings.register(MODULE_ID, VERSION_SETTING, {
    scope: "world", config: false, type: Number, default: 0
  });
  game.settings.register(MODULE_ID, REPORT_SETTING, {
    scope: "world", config: false, type: Object, default: {}
  });
  game.settings.register(MODULE_ID, WARNING_SETTING, {
    name: "Warnung bei Zugriffen auf den alten Modul-Namespace",
    hint: "Schreibt pro veraltetem Flag- oder Setting-Zugriff eine Warnung mit Aufrufpfad in die Browser-Konsole.",
    scope: "client", config: true, type: Boolean, default: true
  });
}

export function installLegacyNamespaceGuard() {
  const documentPrototype = foundry.abstract.Document?.prototype;
  for (const method of ["getFlag", "setFlag", "unsetFlag"]) wrap(documentPrototype, method);
  for (const method of ["get", "set"]) wrap(game.settings, method);
}

export async function migrateToolNamespace() {
  const clientSettings = await migrateSettings(new Set(["client"]));
  if (!game.user.isGM) return { clientSettings };
  if (game.settings.get(MODULE_ID, VERSION_SETTING) >= MIGRATION_VERSION) {
    return { ...game.settings.get(MODULE_ID, REPORT_SETTING), clientSettings };
  }
  const settings = await migrateSettings(new Set(["world"]));
  const flags = await migrateFlags();
  const report = {
    version: MIGRATION_VERSION,
    migratedAt: new Date().toISOString(),
    legacyScope: LEGACY_MODULE_SCOPE,
    targetScope: MODULE_ID,
    settings: { ...settings, client: clientSettings },
    flags: { copied: flags.copied, retained: flags.retained, verified: flags.verified.length }
  };
  await game.settings.set(MODULE_ID, REPORT_SETTING, report);
  await game.settings.set(MODULE_ID, VERSION_SETTING, MIGRATION_VERSION);
  console.info(`${MODULE_ID} | Namespace migration completed.`, report);
  return report;
}
