import { CONTENT_MODULE_ID, MODULE_ID } from "./core/constants.mjs";

const SUPPORTED_FEATURE_TYPES = new Set([
  "eldritchInvocation",
  "metamagicOption",
  "martialAction",
  "pactBoon",
  "primalAspect"
]);

let featurePools = new Map();

function packageIdFor(pack) {
  return pack.metadata.packageName ?? pack.metadata.package ?? "";
}

function isOriginalContentPack(pack) {
  const packageId = packageIdFor(pack);
  return pack.documentName === "Item"
    && packageId !== CONTENT_MODULE_ID
    && (
      packageId === game.system.id
      || packageId === "koboldpressogl-bf"
      || packageId.startsWith("kp-tov-")
    );
}

async function indexFeaturePools() {
  const pools = new Map();
  const packs = game.packs.filter(isOriginalContentPack);
  await Promise.all(packs.map(async pack => {
    const index = await pack.getIndex({
      fields: ["type", "system.type.category", "system.type.value"]
    });
    for (const entry of index) {
      if (entry.type !== "feature") continue;
      if (foundry.utils.getProperty(entry, "system.type.category") !== "class") continue;
      const type = foundry.utils.getProperty(entry, "system.type.value");
      if (!SUPPORTED_FEATURE_TYPES.has(type)) continue;
      const uuids = pools.get(type) ?? new Set();
      uuids.add(pack.getUuid(entry._id));
      pools.set(type, uuids);
    }
  }));
  featurePools = pools;
}

function augmentAdvancements(source) {
  const advancements = foundry.utils.deepClone(foundry.utils.getProperty(source, "system.advancement") ?? {});
  let changed = false;
  for (const advancement of Object.values(advancements)) {
    const configuration = advancement?.configuration;
    if (advancement?.type !== "chooseFeatures" || configuration?.type !== "feature") continue;
    if (configuration.restriction?.category !== "class") continue;
    const type = configuration.restriction?.type;
    const additions = featurePools.get(type);
    if (!additions?.size || !Array.isArray(configuration.pool)) continue;

    const existing = new Set(configuration.pool.map(entry => entry.uuid));
    for (const uuid of additions) {
      if (existing.has(uuid)) continue;
      configuration.pool.push({ uuid });
      existing.add(uuid);
      changed = true;
    }
  }
  return changed ? advancements : null;
}

function prepareNewEmbeddedItem(item) {
  if (!item.parent || item.parent.documentName !== "Actor") return;
  const advancements = augmentAdvancements(item.toObject());
  if (advancements) item.updateSource({ "system.advancement": advancements });
}

async function updateExistingCharacters() {
  if (!game.user.isGM) return;
  let updated = 0;
  const failures = [];
  for (const actor of game.actors.filter(candidate => candidate.type === "pc")) {
    const updates = [];
    for (const item of actor.items) {
      const advancements = augmentAdvancements(item.toObject());
      if (advancements) updates.push({ _id: item.id, "system.advancement": advancements });
    }
    if (!updates.length) continue;
    try {
      await actor.updateEmbeddedDocuments("Item", updates, { render: false });
      updated += updates.length;
    } catch (error) {
      failures.push(actor.name);
      console.error(`${MODULE_ID} | Feature pools could not be extended for ${actor.name}`, error);
    }
  }
  if (updated) {
    console.info(`${MODULE_ID} | Extended ${updated} embedded feature-choice pools.`);
  }
  if (failures.length) {
    ui.notifications.warn(
      `Feature-Auswahl konnte bei ${failures.length} Characters nicht erweitert werden: ${failures.join(", ")}.`,
      { permanent: true }
    );
  }
}

export function registerFeaturePoolIntegration() {
  Hooks.on("preCreateItem", prepareNewEmbeddedItem);
}

export async function activateFeaturePoolIntegration() {
  await indexFeaturePools();
  await updateExistingCharacters();
  console.info(
    `${MODULE_ID} | Feature pools indexed:`,
    Object.fromEntries([...featurePools].map(([type, uuids]) => [type, uuids.size]))
  );
}
