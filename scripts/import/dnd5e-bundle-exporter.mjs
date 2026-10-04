import { MODULE_ID, modulePath } from "../core/constants.mjs";
import { isProjectAdministrator } from "../core/permissions.mjs";

const FORMAT = "tov-feuerschwinge-dnd5e-content";
const VERSION = 1;
const FALLBACK_IMAGE = "icons/svg/item-bag.svg";
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function route(path) {
  return foundry.utils.getRoute?.(path) ?? path;
}

function itemPacks() {
  return [...game.packs]
    .filter(pack => pack.documentName === "Item" && pack.metadata?.system === "dnd5e")
    .map(pack => ({ id: pack.collection, name: `${pack.title} (${pack.collection})` }));
}

function documentAssets(document) {
  const sources = new Set();
  if (document.img) sources.add(document.img);
  const html = String(document.system?.description?.value ?? "");
  for (const match of html.matchAll(/\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    if (match[2]) sources.add(match[2]);
  }
  return sources;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

function base64(bytes) {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function exportAsset(source) {
  if (!source || source.startsWith("data:") || source.startsWith("blob:")
    || source.startsWith("icons/") || source.startsWith("systems/black-flag/")) return null;
  const response = await fetch(route(source), { cache: "no-store" });
  if (!response.ok) throw new Error(`Bild ${source} konnte nicht exportiert werden (${response.status}).`);
  const bytes = await response.arrayBuffer();
  return {
    source,
    hash: await sha256(bytes),
    type: response.headers.get("content-type") ?? "application/octet-stream",
    data: base64(bytes)
  };
}

function replaceMissingAssets(document, missingAssets) {
  const data = document.toObject();
  if (missingAssets.has(data.img)) data.img = FALLBACK_IMAGE;
  const description = data.system?.description?.value;
  if (typeof description === "string") {
    data.system.description.value = [...missingAssets].reduce(
      (html, source) => html.replaceAll(source, FALLBACK_IMAGE),
      description
    );
  }
  return data;
}

export async function createDnd5eBundle(pack) {
  if (!isProjectAdministrator()) throw new Error("Nur ein vollständiger Spielleiter darf D&D5e-Inhalte exportieren.");
  if (pack?.documentName !== "Item" || pack.metadata?.system !== "dnd5e") {
    throw new Error("Wähle ein D&D5e-Item-Kompendium.");
  }
  const documents = await pack.getDocuments();
  const sourcePackage = pack.metadata?.packageName ?? "dnd5e";
  const sources = new Set(documents.flatMap(document => [...documentAssets(document)]));
  const assetsByHash = new Map();
  const sourceAssets = {};
  const missingAssets = new Set();
  for (const source of sources) {
    let asset;
    try {
      asset = await exportAsset(source);
    } catch (error) {
      missingAssets.add(source);
      console.warn(`${MODULE_ID} | Skipping unavailable D&D5e export asset: ${source}`, error);
      continue;
    }
    if (!asset) continue;
    sourceAssets[source] = asset.hash;
    if (!assetsByHash.has(asset.hash)) assetsByHash.set(asset.hash, asset);
  }
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      system: game.system.id,
      systemVersion: game.system.version,
      package: sourcePackage,
      assetNamespace: sourcePackage === "world" ? "ddb" : sourcePackage,
      world: game.world.id,
      collection: pack.collection,
      label: pack.title
    },
    folders: pack.folders.map(folder => folder.toObject()),
    documents: documents.map(document => replaceMissingAssets(document, missingAssets)),
    sourceAssets,
    assets: [...assetsByHash.values()],
    missingAssets: [...missingAssets]
  };
}

class Dnd5eBundleExporter extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-dnd5e-bundle-exporter",
    tag: "form",
    classes: ["standard-form"],
    position: { width: 600, height: "auto" },
    window: { title: "Feuerschwinge D&D5e-Export", resizable: true },
    actions: { export: this.#export }
  };

  static PARTS = { form: { template: modulePath("templates/dnd5e-bundle-exporter.hbs") } };

  async _prepareContext(options) {
    return { ...(await super._prepareContext(options)), packs: itemPacks() };
  }

  static async #export(event) {
    event.preventDefault();
    try {
      const pack = game.packs.get(this.element.querySelector('[name="sourcePack"]')?.value);
      ui.notifications.info("Dokumente und Bilder werden exportiert …");
      const bundle = await createDnd5eBundle(pack);
      const filename = `feuerschwinge-${pack.metadata?.name ?? "dnd5e"}-${Date.now()}.json`;
      foundry.utils.saveDataToFile(JSON.stringify(bundle), "application/json", filename);
      const missing = bundle.missingAssets.length;
      ui.notifications.info(`${bundle.documents.length} Dokumente und ${bundle.assets.length} unterschiedliche Bilder exportiert.${missing ? ` ${missing} fehlende Bilder wurden durch ein Standardbild ersetzt.` : ""}`);
    } catch (error) {
      console.error(`${MODULE_ID} | D&D5e bundle export failed.`, error);
      ui.notifications.error(error.message);
    }
  }
}

export function registerDnd5eBundleExporter() {
  Hooks.on("renderCompendiumDirectory", (_app, html) => {
    if (!isProjectAdministrator()) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.querySelector("[data-tovf-dnd5e-export]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.tovfDnd5eExport = "";
    button.innerHTML = '<i class="fa-solid fa-file-export" inert></i> Für Feuerschwinge exportieren';
    button.addEventListener("click", () => new Dnd5eBundleExporter().render({ force: true }));
    (root.querySelector(".directory-header") ?? root.querySelector("header") ?? root).append(button);
  });
}
