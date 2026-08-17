import { CONTENT_MODULE_ID, MODULE_ID } from "./core/constants.mjs";

let backgroundsByTalent = new Map();
let refreshPromise = null;

function sourcePackage(pack) {
  return pack.metadata.packageName ?? pack.metadata.package ?? "";
}

function supportedPackage(packageId) {
  return packageId === CONTENT_MODULE_ID
    || packageId === game.system.id
    || packageId === "koboldpressogl-bf"
    || packageId.startsWith("kp-tov-");
}

function collectUuids(value, uuids = new Set()) {
  if (typeof value === "string") {
    if (/^(?:Compendium\.[^.]+\.[^.]+\.(?:Item|Actor)\.|Item\.)[A-Za-z0-9]+$/.test(value)) uuids.add(value);
    return uuids;
  }
  if (!value || typeof value !== "object") return uuids;
  for (const child of Object.values(value)) collectUuids(child, uuids);
  return uuids;
}

function talentKeys(item) {
  // Compendium variants are mapped to their shared talent identity by the
  // index. World and embedded copies additionally use core.sourceId.
  if (item?.pack || item?.compendium) return new Set([item.uuid].filter(Boolean));
  return new Set([
    item?.getFlag?.("core", "sourceId"),
    foundry.utils.getProperty(item, "_source.flags.core.sourceId"),
    item?.uuid
  ].filter(Boolean));
}

function backgroundSummary(background) {
  return {
    uuid: background.uuid,
    name: background.name,
    img: background.img ?? "icons/svg/book.svg"
  };
}

function talentIdentity(item) {
  const identifier = foundry.utils.getProperty(item, "system.identifier.value");
  if (identifier) return `identifier:${String(identifier).trim().toLocaleLowerCase("en")}`;
  const name = String(item?.name ?? "").trim().toLocaleLowerCase(game.i18n.lang);
  return name ? `name:${name}` : "";
}

async function talentAliases() {
  const aliases = new Map();
  const packs = game.packs.filter(pack => (
    pack.documentName === "Item"
    && pack.visible !== false
    && supportedPackage(sourcePackage(pack))
  ));
  await Promise.all(packs.map(async pack => {
    try {
      const index = await pack.getIndex({
        fields: ["type", "system.identifier.value", "flags.core.sourceId"]
      });
      for (const item of index.filter(entry => entry.type === "talent")) {
        const identity = talentIdentity(item);
        if (!identity) continue;
        aliases.set(pack.getUuid(item._id), identity);
        const sourceId = foundry.utils.getProperty(item, "flags.core.sourceId");
        if (sourceId) aliases.set(sourceId, identity);
      }
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not index talents from ${pack.collection}.`, error);
    }
  }));
  for (const item of game.items.filter(item => item.type === "talent")) {
    const identity = talentIdentity(item);
    if (!identity) continue;
    aliases.set(item.uuid, identity);
    for (const key of talentKeys(item)) aliases.set(key, identity);
  }
  return aliases;
}

async function backgroundDocuments() {
  const packs = game.packs.filter(pack => (
    pack.documentName === "Item"
    && pack.visible !== false
    && supportedPackage(sourcePackage(pack))
  ));
  const packed = await Promise.all(packs.map(async pack => {
    try {
      const index = await pack.getIndex({ fields: ["type", "img", "system.advancement"] });
      return index.filter(item => item.type === "background").map(item => ({
        ...item,
        uuid: pack.getUuid(item._id)
      }));
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not index backgrounds from ${pack.collection}.`, error);
      return [];
    }
  }));
  return [
    ...packed.flat(),
    ...game.items.filter(item => item.type === "background")
  ];
}

async function buildBackgroundIndex() {
  const [backgrounds, aliases] = await Promise.all([backgroundDocuments(), talentAliases()]);
  const exact = new Map();
  for (const background of backgrounds) {
    const advancements = Object.values(background.system?.advancement ?? {})
      .filter(advancement => (
        /features/i.test(String(advancement?.type ?? ""))
        && advancement?.configuration?.type === "talent"
      ));
    for (const uuid of collectUuids(advancements)) {
      const entries = exact.get(uuid) ?? new Map();
      entries.set(background.uuid, backgroundSummary(background));
      exact.set(uuid, entries);
    }
  }

  const byIdentity = new Map();
  for (const [uuid, entries] of exact) {
    const identity = aliases.get(uuid) ?? `uuid:${uuid}`;
    const combined = byIdentity.get(identity) ?? new Map();
    for (const [backgroundUuid, background] of entries) combined.set(backgroundUuid, background);
    byIdentity.set(identity, combined);
  }

  const next = new Map();
  for (const [uuid, identity] of aliases) {
    const entries = byIdentity.get(identity);
    if (entries) next.set(uuid, entries);
  }
  for (const [uuid, entries] of exact) {
    if (!next.has(uuid)) next.set(uuid, entries);
  }
  backgroundsByTalent = new Map([...next].map(([key, entries]) => [
    key,
    [...entries.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang))
  ]));
  console.info(`${MODULE_ID} | Indexed ${backgroundsByTalent.size} talents across ${backgrounds.length} backgrounds.`);
  return backgroundsByTalent;
}

function refreshBackgroundIndex() {
  if (!refreshPromise) refreshPromise = buildBackgroundIndex()
    .catch(error => console.error(`${MODULE_ID} | Failed to index talent backgrounds.`, error))
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
}

function backgroundsForTalent(item) {
  const backgrounds = new Map();
  for (const key of talentKeys(item)) {
    for (const background of backgroundsByTalent.get(key) ?? []) backgrounds.set(background.uuid, background);
  }
  return [...backgrounds.values()].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

async function showTalentBackgrounds(item) {
  await refreshPromise;
  const backgrounds = backgroundsForTalent(item);
  if (!backgrounds.length) {
    return ui.notifications.info(game.i18n.localize("TOVF.TalentBackgrounds.None"));
  }
  const selected = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.format("TOVF.TalentBackgrounds.Title", { talent: item.name }) },
    content: `<p>${game.i18n.localize("TOVF.TalentBackgrounds.Hint")}</p>`,
    buttons: backgrounds.map(background => ({
      action: background.uuid,
      label: background.name,
      icon: "fa-solid fa-person-rays",
      callback: () => background.uuid
    })),
    rejectClose: false
  });
  if (!selected) return;
  const background = await fromUuid(selected).catch(() => null);
  background?.sheet.render(true);
}

function itemFromApp(app) {
  const item = app?.item ?? app?.document ?? app?.object;
  return item?.documentName === "Item" ? item : null;
}

function addTalentBackgroundControl(app, controls) {
  const item = itemFromApp(app);
  if (item?.type !== "talent" || !Array.isArray(controls)) return;
  const action = "tovf-talent-backgrounds";
  if (controls.some(control => control.action === action)) return;
  const count = backgroundsForTalent(item).length;
  controls.unshift({
    action,
    icon: "fa-solid fa-person-rays",
    label: game.i18n.format("TOVF.TalentBackgrounds.Control", { count }),
    visible: true,
    onClick: () => void showTalentBackgrounds(item)
  });
}

export function registerTalentBackgrounds() {
  Hooks.on("getHeaderControlsItemSheetV2", addTalentBackgroundControl);
  Hooks.on("getHeaderControlsApplicationV2", addTalentBackgroundControl);
  Hooks.once("ready", () => void refreshBackgroundIndex());
  for (const hook of ["createItem", "updateItem", "deleteItem"]) {
    Hooks.on(hook, item => {
      if (item.type === "background") void refreshBackgroundIndex();
    });
  }
}
