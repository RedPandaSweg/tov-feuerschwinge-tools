import { CONTENT_MODULE_ID, MODULE_ID, modulePath } from "./core/constants.mjs";
import { characterCreationOverridesApi } from "./integrations/character-creation-overrides.mjs";

const imageAvailability = new Map();
const FALLBACK_IMAGE = modulePath("assets/FroschmitHerz.webp");

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en");
}

function isMissingImagePath(image) {
  const path = normalized(image).split(/[?#]/, 1)[0];
  return !path;
}

function imageIsAvailable(image) {
  if (isMissingImagePath(image)) return Promise.resolve(false);
  if (imageAvailability.has(image)) return imageAvailability.get(image);
  const check = new Promise(resolve => {
    const element = new Image();
    const timeout = globalThis.setTimeout(() => resolve(false), 5000);
    element.addEventListener("load", () => {
      globalThis.clearTimeout(timeout);
      resolve(true);
    }, { once: true });
    element.addEventListener("error", () => {
      globalThis.clearTimeout(timeout);
      resolve(false);
    }, { once: true });
    element.src = image;
  });
  imageAvailability.set(image, check);
  return check;
}

function sourceUuidOf(item) {
  return String(item?._stats?.compendiumSource ?? item?.getFlag?.("core", "sourceId") ?? "").trim();
}

function identifierOf(document) {
  return normalized(document?.system?.identifier?.value ?? document?.system?.identifier ?? document?.identifier);
}

function nameKey(document) {
  return `${normalized(document?.type)}|${normalized(document?.name)}`;
}

function identifierKey(document) {
  const identifier = identifierOf(document);
  return identifier ? `${normalized(document?.type)}|${identifier}` : "";
}

function addToMap(map, key, candidate) {
  if (!key) return;
  const entries = map.get(key) ?? [];
  entries.push(candidate);
  map.set(key, entries);
}

async function chooseImage(candidates = []) {
  const tested = await Promise.all(candidates.map(async candidate => ({
    candidate,
    available: await imageIsAvailable(candidate.img)
  })));
  const useful = tested.filter(entry => entry.available).map(entry => entry.candidate);
  if (!useful.length) return "";
  const preferred = useful.filter(candidate => candidate.packageName === CONTENT_MODULE_ID);
  const pool = preferred.length ? preferred : useful;
  const images = new Set(pool.map(candidate => candidate.img));
  return images.size === 1 ? images.values().next().value : "";
}

async function buildCompendiumImageCatalog() {
  const catalog = { byUuid: new Map(), bySource: new Map(), byIdentifier: new Map(), byName: new Map() };
  const packs = game.packs.filter(pack => pack.documentName === "Item");
  for (const pack of packs) {
    let index;
    try {
      index = await pack.getIndex({ fields: ["type", "img", "system.identifier", "_stats.compendiumSource", "flags.core.sourceId"] });
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not index images in ${pack.collection}.`, error);
      continue;
    }
    for (const entry of index) {
      if (isMissingImagePath(entry.img)) continue;
      const uuid = `Compendium.${pack.collection}.Item.${entry._id}`;
      const candidate = {
        uuid,
        name: entry.name,
        type: entry.type,
        img: entry.img,
        system: entry.system,
        packageName: pack.metadata?.packageName ?? pack.metadata?.package
      };
      catalog.byUuid.set(uuid, candidate);
      addToMap(catalog.bySource, entry._stats?.compendiumSource, candidate);
      addToMap(catalog.bySource, foundry.utils.getProperty(entry, "flags.core.sourceId"), candidate);
      addToMap(catalog.byIdentifier, identifierKey(candidate), candidate);
      addToMap(catalog.byName, nameKey(candidate), candidate);
    }
  }
  return catalog;
}

async function findReplacementImage(item, catalog) {
  const originalUuid = sourceUuidOf(item);
  const resolvedUuid = characterCreationOverridesApi.resolveUuid(originalUuid);
  for (const uuid of [resolvedUuid, originalUuid]) {
    const direct = catalog.byUuid.get(uuid);
    if (direct?.img && await imageIsAvailable(direct.img)) return direct.img;
  }
  for (const uuid of [resolvedUuid, originalUuid]) {
    const image = await chooseImage(catalog.bySource.get(uuid));
    if (image) return image;
  }
  const byIdentifier = await chooseImage(catalog.byIdentifier.get(identifierKey(item)));
  if (byIdentifier) return byIdentifier;
  return chooseImage(catalog.byName.get(nameKey(item)));
}

export async function repairMissingActorItemImages() {
  if (!game.user.isGM) return;
  ui.notifications.info(game.i18n.localize("TOVF.LinkTools.ImagesScanning"));
  const catalog = await buildCompendiumImageCatalog();
  const plans = [];
  let fallback = 0;
  const actorItems = [...game.actors].flatMap(actor => [...actor.items]);
  const missingImages = new Set();
  await Promise.all([...new Set(actorItems.map(item => item.img))].map(async image => {
    if (isMissingImagePath(image) || !await imageIsAvailable(image)) missingImages.add(image);
  }));
  for (const actor of game.actors) {
    const updates = [];
    for (const item of actor.items) {
      if (!missingImages.has(item.img)) continue;
      const img = await findReplacementImage(item, catalog) || FALLBACK_IMAGE;
      if (img === FALLBACK_IMAGE) fallback += 1;
      updates.push({ _id: item.id, img });
    }
    if (updates.length) plans.push({ actor, updates });
  }
  const itemCount = plans.reduce((sum, plan) => sum + plan.updates.length, 0);
  if (!itemCount) {
    ui.notifications.info(game.i18n.localize("TOVF.LinkTools.ImagesNone"));
    return { actors: 0, items: 0, fallback: 0 };
  }
  const matched = itemCount - fallback;
  const accepted = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("TOVF.LinkTools.ImagesTitle") },
    content: `<p>${game.i18n.format("TOVF.LinkTools.ImagesConfirm", {
      actors: plans.length,
      items: itemCount,
      matched,
      fallback
    })}</p>`,
    modal: true,
    rejectClose: false
  });
  if (!accepted) return;
  foundry.utils.saveDataToFile(
    JSON.stringify({
      format: "tov-feuerschwinge-actor-image-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      actors: plans.map(({ actor }) => actor.toObject())
    }, null, 2),
    "application/json",
    `tov-feuerschwinge-image-backup-${new Date().toISOString().slice(0, 10)}.json`
  );
  let actors = 0;
  let items = 0;
  for (const { actor, updates } of plans) {
    await actor.updateEmbeddedDocuments("Item", updates);
    actors += 1;
    items += updates.length;
  }
  const result = { actors, items, matched, fallback };
  ui.notifications.info(game.i18n.format("TOVF.LinkTools.ImagesComplete", result), { permanent: true });
  return result;
}
