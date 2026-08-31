const MARKER_SUFFIX = /\s*\((C|R|C\s*[,/&+]\s*R|R\s*[,/&+]\s*C)\)\s*$/i;

function tagValues(spell) {
  const tags = spell?.system?.tags;
  if (tags instanceof Set) return tags;
  if (Array.isArray(tags)) return new Set(tags);
  if (typeof tags === "string") return new Set(tags.split(/[;,\s]+/).filter(Boolean));
  return new Set();
}

export function legacySpellNameMarkers(value) {
  let name = String(value ?? "").trim();
  const markers = new Set();
  let match;
  while ((match = name.match(MARKER_SUFFIX))) {
    for (const marker of match[1].toUpperCase().match(/[CR]/g) ?? []) markers.add(marker);
    name = name.slice(0, match.index).trimEnd();
  }
  return { name, concentration: markers.has("C"), ritual: markers.has("R") };
}

export function canonicalSpellName(value) {
  return legacySpellNameMarkers(value).name;
}

export function spellMarkerState(spell) {
  const legacy = legacySpellNameMarkers(spell?.name ?? spell?._source?.name);
  const tags = tagValues(spell);
  return {
    concentration: Boolean(spell?.system?.duration?.concentration) || tags.has("concentration") || legacy.concentration,
    ritual: tags.has("ritual") || legacy.ritual
  };
}

export function markedSpellName(spell) {
  const base = canonicalSpellName(spell?.name ?? spell?._source?.name);
  const state = spellMarkerState(spell);
  return `${base}${state.concentration ? " (C)" : ""}${state.ritual ? " (R)" : ""}`;
}

export function installSpellNameMarkers() {
  Hooks.on("preCreateItem", document => {
    if (document.type !== "spell" || document.pack) return;
    const name = markedSpellName(document);
    if (name && name !== document.name) document.updateSource({ name });
  });

  Hooks.on("preUpdateItem", (document, changes) => {
    if (document.type !== "spell" || document.pack) return;
    const keys = Object.keys(changes);
    const relevant = Object.hasOwn(changes, "name")
      || foundry.utils.hasProperty(changes, "system.duration.concentration")
      || foundry.utils.hasProperty(changes, "system.tags")
      || keys.some(key => key === "system.duration.concentration" || key === "system.tags" || key.startsWith("system.tags."));
    if (!relevant) return;
    const source = foundry.utils.mergeObject(document.toObject(), foundry.utils.expandObject(changes), { inplace: false });
    const name = markedSpellName(source);
    if (name) changes.name = name;
  });
}
