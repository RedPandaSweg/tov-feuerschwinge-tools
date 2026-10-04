import { CONTENT_MODULE_ID } from "../core/constants.mjs";

const CONTENT_ASSET_ROOT = `modules/${CONTENT_MODULE_ID}/assets`;
const SAFE_CORE_PREFIXES = ["icons/", "systems/black-flag/"];
const IMAGE_EXTENSION = /\.(?:avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i;

function importRoot() {
  // Imported content belongs to the distributable content module. Keeping
  // assets alongside its compendiums makes the pack transferable as one unit.
  return `${CONTENT_ASSET_ROOT}/imported`;
}

function route(path) {
  return foundry.utils.getRoute?.(path) ?? path;
}

function cleanSegment(value) {
  let decoded = String(value ?? "");
  try { decoded = decodeURIComponent(decoded); } catch (_error) { /* Keep malformed source text as-is. */ }
  return decoded
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .replace(/^\.+$/, "_")
    .trim() || "_";
}

function cleanPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .split("/")
    .filter(segment => segment && segment !== "." && segment !== "..")
    .map(cleanSegment)
    .join("/");
}

function sourceLocation(source, namespace) {
  const raw = String(source ?? "").trim();
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  if (SAFE_CORE_PREFIXES.some(prefix => raw.startsWith(prefix))) return { keep: raw };
  if (raw.startsWith(`modules/${CONTENT_MODULE_ID}/`)) return { keep: raw };
  let path = raw.split(/[?#]/, 1)[0];
  let externalHost = "";
  try {
    const url = new URL(raw, window.location.href);
    if (/^https?:$/i.test(url.protocol) && url.origin !== window.location.origin) externalHost = url.hostname;
    path = decodeURIComponent(url.pathname).replace(/^\//, "");
  } catch (_error) {
    // Foundry paths are commonly relative URLs and need no URL parsing.
  }
  for (const prefix of [`modules/${namespace}/`, `worlds/${game.world.id}/`]) {
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
  }
  path = path.replace(/^worlds\/[^/]+\//, "");
  if (externalHost) path = `external/${externalHost}/${path}`;
  return { raw, relative: cleanPath(path) };
}

async function fetchBytes(path) {
  const response = await fetch(route(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`Asset ${path} konnte nicht geladen werden (${response.status}).`);
  return { bytes: await response.arrayBuffer(), type: response.headers.get("content-type") ?? "application/octet-stream" };
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function ensureDirectory(path) {
  const FilePicker = foundry.applications.apps.FilePicker.implementation;
  const parts = cleanPath(path).split("/");
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try {
      await FilePicker.browse("data", current);
      continue;
    } catch (_error) {
      // Missing directories are created below. A failed follow-up browse keeps
      // real permission and storage errors visible instead of swallowing them.
    }
    try {
      await FilePicker.createDirectory("data", current);
    } catch (error) {
      try {
        await FilePicker.browse("data", current);
      } catch (_browseError) {
        throw error;
      }
    }
  }
}

async function loadManifest() {
  try {
    const response = await fetch(route(`${importRoot()}/import-manifest.json`), { cache: "no-store" });
    if (!response.ok) return { version: 1, assets: {} };
    const parsed = await response.json();
    return parsed?.version === 1 && parsed.assets && typeof parsed.assets === "object"
      ? parsed
      : { version: 1, assets: {} };
  } catch (_error) {
    return { version: 1, assets: {} };
  }
}

function collisionPath(path, hash) {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/")
    ? `${path.slice(0, dot)}-${hash.slice(0, 10)}${path.slice(dot)}`
    : `${path}-${hash.slice(0, 10)}`;
}

export class ContentAssetImporter {
  static async create(sourceNamespace, bundle = null) {
    const importer = new ContentAssetImporter(cleanSegment(sourceNamespace || "dnd5e"), bundle);
    importer.manifest = await loadManifest();
    importer.byHash = new Map();
    await importer.indexExistingAssets();
    return importer;
  }

  async indexExistingAssets() {
    this.existingPaths = new Set();
    const pending = [CONTENT_ASSET_ROOT];
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    while (pending.length) {
      const directory = pending.pop();
      let listing;
      try {
        listing = await FilePicker.browse("data", directory);
      } catch (_error) {
        continue;
      }
      pending.push(...(listing.dirs ?? []));
      for (const path of listing.files ?? []) {
        if (!IMAGE_EXTENSION.test(path)) continue;
        this.existingPaths.add(path);
        try {
          const loaded = await fetchBytes(path);
          const hash = await sha256(loaded.bytes);
          if (!this.byHash.has(hash)) this.byHash.set(hash, path);
        } catch (_error) {
          // An unreadable unrelated asset must not abort the authoring import.
        }
      }
    }
  }

  constructor(namespace, bundle = null) {
    this.namespace = namespace;
    this.manifest = { version: 1, assets: {} };
    this.byHash = new Map();
    this.existingPaths = new Set();
    this.changed = false;
    this.uploaded = 0;
    this.reused = 0;
    const assetsByHash = new Map((bundle?.assets ?? []).map(asset => [asset.hash, asset]));
    this.bundledAssets = new Map(Object.entries(bundle?.sourceAssets ?? {}).flatMap(([source, hash]) => {
      const asset = assetsByHash.get(hash);
      return asset ? [[source, asset]] : [];
    }));
  }

  async import(source) {
    const location = sourceLocation(source, this.namespace);
    if (!location) return source;
    if (location.keep) return location.keep;
    const bundled = this.bundledAssets.get(location.raw);
    const loaded = bundled
      ? { bytes: decodeBase64(bundled.data), type: bundled.type ?? "application/octet-stream" }
      : await fetchBytes(location.raw);
    const hash = await sha256(loaded.bytes);
    const knownSource = this.manifest.assets[location.raw];
    const existingHashTarget = this.byHash.get(hash);
    if (knownSource?.hash === hash && existingHashTarget) {
      if (knownSource.target !== existingHashTarget) {
        knownSource.target = existingHashTarget;
        this.changed = true;
      }
      this.reused += 1;
      return existingHashTarget;
    }
    const knownHash = existingHashTarget;
    if (knownHash) {
      this.manifest.assets[location.raw] = { target: knownHash, hash };
      this.changed = true;
      this.reused += 1;
      return knownHash;
    }

    let target = `${importRoot()}/${this.namespace}/${location.relative}`;
    if (this.existingPaths.has(target)) {
      const existing = await fetchBytes(target);
      const existingHash = await sha256(existing.bytes);
      if (existingHash === hash) {
        this.manifest.assets[location.raw] = { target, hash };
        this.byHash.set(hash, target);
        this.changed = true;
        this.reused += 1;
        return target;
      }
      target = collisionPath(target, hash);
    }

    const slash = target.lastIndexOf("/");
    const directory = target.slice(0, slash);
    const filename = target.slice(slash + 1);
    await ensureDirectory(directory);
    const file = new File([loaded.bytes], filename, { type: loaded.type });
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const result = await FilePicker.upload("data", directory, file, {}, { notify: false });
    const stored = result?.path ?? target;
    this.manifest.assets[location.raw] = { target: stored, hash };
    this.byHash.set(hash, stored);
    this.existingPaths.add(stored);
    this.changed = true;
    this.uploaded += 1;
    return stored;
  }

  async importHtml(html) {
    let rewritten = String(html ?? "");
    const sources = [...rewritten.matchAll(/\bsrc\s*=\s*(["'])(.*?)\1/gi)]
      .map(match => match[2])
      .filter(Boolean);
    for (const source of new Set(sources)) {
      const target = await this.import(source);
      if (target && target !== source) rewritten = rewritten.replaceAll(source, target);
    }
    return rewritten;
  }

  async save() {
    if (!this.changed) return;
    const root = importRoot();
    await ensureDirectory(root);
    const data = JSON.stringify({ ...this.manifest, updatedAt: new Date().toISOString() }, null, 2);
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    await FilePicker.upload("data", root, new File([data], "import-manifest.json", {
      type: "application/json"
    }), {}, { notify: false });
    this.changed = false;
  }
}
