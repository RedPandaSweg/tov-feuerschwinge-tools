import { MODULE_ID, SETTINGS } from "./constants.mjs";

const LEGACY_MODULE_ID = "downtime-manager";
export const MIGRATION_SETTING = "integratedDowntimeMigration";
const MIGRATION_VERSION = 1;

function storedWorldValue(namespace, key) {
  return game.settings.storage.get("world")?.get(`${namespace}.${key}`)?.value;
}

async function migrateSettings() {
  for (const key of Object.values(SETTINGS)) {
    if (storedWorldValue(MODULE_ID, key) !== undefined) continue;
    const legacy = storedWorldValue(LEGACY_MODULE_ID, key);
    if (legacy === undefined) continue;
    await game.settings.set(MODULE_ID, key, foundry.utils.deepClone(legacy));
  }
}

async function migrateDocument(document) {
  const legacy = document.flags?.[LEGACY_MODULE_ID];
  if (!legacy || typeof legacy !== "object") return false;
  const current = document.flags?.[MODULE_ID] ?? {};
  const merged = foundry.utils.mergeObject(
    foundry.utils.deepClone(legacy),
    foundry.utils.deepClone(current),
    { inplace: false }
  );
  await document.update({ [`flags.${MODULE_ID}`]: merged });
  return true;
}

async function migrateFlags() {
  const documents = [
    ...game.actors,
    ...game.items,
    ...game.folders,
    ...[...game.actors].flatMap(actor => [...actor.items])
  ];
  let count = 0;
  for (const document of documents) {
    if (await migrateDocument(document)) count++;
  }
  return count;
}

export async function migrateIntegratedDowntime() {
  if (!game.user.isGM) return;
  if (game.settings.get(MODULE_ID, MIGRATION_SETTING) >= MIGRATION_VERSION) return;
  await migrateSettings();
  const documents = await migrateFlags();
  await game.settings.set(MODULE_ID, MIGRATION_SETTING, MIGRATION_VERSION);
  if (documents) {
    console.info(`${MODULE_ID} | Migrated downtime data on ${documents} documents.`);
  }
}
