import { CONTENT_MODULE_ID } from "./constants.mjs";

export function packageIdFor(pack) {
  return pack?.metadata?.packageName ?? pack?.metadata?.package ?? "";
}

export function normalizedDocumentName(value) {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

export function contentSourcePriority(source) {
  if (source === CONTENT_MODULE_ID) return 0;
  if (source === game.system.id) return 1;
  return 2;
}

/** Keep one entry per identity, preferring Feuerschwinge and then system content. */
export function deduplicatePreferredContent(entries, { identity, source, merge } = {}) {
  const groups = new Map();
  for (const entry of entries) {
    const key = identity(entry);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].map(group => {
    group.sort((left, right) => contentSourcePriority(source(left)) - contentSourcePriority(source(right)));
    return merge ? merge(group[0], group) : group[0];
  });
}
