const BLACK_FLAG_ID = "black-flag";
const CACHE_TARGET_PATTERN = /(?:^|\.)Item\.([^.]+)\.Activity\.([^.]+)$/;

function documentId(document) {
  return String(document?._id ?? document?.id ?? "");
}

function advancementEntries(item) {
  const advancement = item?.system?.advancement;
  if (!advancement || typeof advancement !== "object") return {};
  return advancement;
}

function activityExists(item, activityId) {
  const activities = item?.system?.activities;
  if (!activities) return false;
  if (typeof activities.has === "function") return activities.has(activityId);
  if (Array.isArray(activities)) return activities.some(activity => documentId(activity) === activityId);
  return Object.hasOwn(activities, activityId);
}

function collectAdvancementReferences(value, itemsById) {
  const references = [];
  const visited = new WeakSet();

  function visit(entry, path = []) {
    if (!entry || typeof entry !== "object" || visited.has(entry)) return;
    visited.add(entry);

    if (typeof entry.document === "string") {
      const ownerId = String(path[0] ?? "");
      const advancementId = String(path[1] ?? "");
      const owner = itemsById.get(ownerId);
      const advancement = advancementEntries(owner)?.[advancementId];
      const addedIndex = path.indexOf("added");
      references.push({
        documentId: entry.document,
        sourceUuid: String(entry.uuid ?? ""),
        ownerId,
        ownerName: String(owner?.name ?? ""),
        advancementId,
        advancementTitle: String(advancement?.title ?? ""),
        level: addedIndex >= 0 ? String(path[addedIndex + 1] ?? "") : "",
        path: path.join(".")
      });
    }

    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, [...path, String(index)]));
      return;
    }
    for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
  }

  visit(value);
  return references;
}

function groupBy(values, keyFor) {
  const grouped = new Map();
  for (const value of values) {
    const key = keyFor(value);
    if (!key) continue;
    const entries = grouped.get(key) ?? [];
    entries.push(value);
    grouped.set(key, entries);
  }
  return grouped;
}

function sourceUuid(item) {
  return String(
    item?.flags?.[BLACK_FLAG_ID]?.sourceId
      ?? item?._stats?.compendiumSource
      ?? item?.flags?.core?.sourceId
      ?? ""
  );
}

function auditRow(item, itemsById, referencesByDocument, cacheGroups) {
  const id = documentId(item);
  const flags = item?.flags?.[BLACK_FLAG_ID] ?? {};
  const cachedFor = String(flags.cachedFor ?? "");
  const references = referencesByDocument.get(id) ?? [];
  const cacheMatch = cachedFor.match(CACHE_TARGET_PATTERN);
  const cacheParent = cacheMatch ? itemsById.get(cacheMatch[1]) : null;
  const cacheActivityExists = Boolean(cacheMatch && cacheParent && activityExists(cacheParent, cacheMatch[2]));
  const duplicateCache = cachedFor ? (cacheGroups.get(cachedFor)?.length ?? 0) > 1 : false;

  let category;
  let disposition;
  let reason;
  if (cachedFor && !cacheActivityExists && references.length) {
    category = "conflicting-orphan-cache";
    disposition = "review";
    reason = "Cache target is missing, but progression still references this spell.";
  } else if (cachedFor && !cacheActivityExists) {
    category = "orphan-cache";
    disposition = "safe-removal-candidate";
    reason = "The cached Activity no longer exists.";
  } else if (cachedFor && duplicateCache) {
    category = "duplicate-active-cache";
    disposition = "review";
    reason = "Multiple cached spells point to the same active Activity.";
  } else if (cachedFor) {
    category = "active-cache";
    disposition = "keep";
    reason = "The cached Activity still exists.";
  } else if (references.length) {
    category = "progression-tracked";
    disposition = "keep";
    reason = "Current actor progression references this spell document.";
  } else if (flags.advancementOrigin) {
    category = "untracked-advancement-origin";
    disposition = "review";
    reason = "The spell has an advancement origin but no current progression reference.";
  } else {
    category = "manual-or-untracked";
    disposition = "review";
    reason = "No cache or progression reference owns this spell; it may have been added manually.";
  }

  return {
    id,
    name: String(item?.name ?? ""),
    circle: Number(item?.system?.circle?.base ?? -1),
    sourceUuid: sourceUuid(item),
    advancementOrigin: String(flags.advancementOrigin ?? ""),
    cachedFor,
    cacheParentId: String(cacheMatch?.[1] ?? ""),
    cacheParentName: String(cacheParent?.name ?? ""),
    cacheActivityId: String(cacheMatch?.[2] ?? ""),
    cacheActivityExists,
    category,
    disposition,
    reason,
    references
  };
}

/** Inspect raw Actor data without changing any documents. */
export function auditActorSpellData(actorData) {
  if (!actorData || typeof actorData !== "object") throw new TypeError("Actor data is required.");
  const items = Array.from(actorData.items ?? []);
  const itemsById = new Map(items.map(item => [documentId(item), item]).filter(([id]) => id));
  const progression = actorData.system?.progression?.advancement ?? {};
  const advancementReferences = collectAdvancementReferences(progression, itemsById);
  const referencesByDocument = groupBy(advancementReferences, reference => reference.documentId);
  const spells = items.filter(item => item?.type === "spell");
  const cacheGroups = groupBy(spells, item => String(item?.flags?.[BLACK_FLAG_ID]?.cachedFor ?? ""));
  const rows = spells.map(item => auditRow(item, itemsById, referencesByDocument, cacheGroups));
  const categories = Object.fromEntries(
    [...groupBy(rows, row => row.category)].map(([category, entries]) => [category, entries.length])
  );
  const referencedIds = new Set(advancementReferences.map(reference => reference.documentId));
  const missingProgressionDocuments = [...referencedIds]
    .filter(id => id && !itemsById.has(id))
    .map(id => ({
      id,
      references: referencesByDocument.get(id) ?? []
    }));

  return {
    actor: {
      id: documentId(actorData),
      name: String(actorData.name ?? ""),
      uuid: String(actorData.uuid ?? "")
    },
    summary: {
      spells: rows.length,
      keep: rows.filter(row => row.disposition === "keep").length,
      review: rows.filter(row => row.disposition === "review").length,
      safeRemovalCandidates: rows.filter(row => row.disposition === "safe-removal-candidate").length,
      projectedAfterSafeRemoval: rows.filter(row => row.disposition !== "safe-removal-candidate").length,
      categories
    },
    spells: rows,
    safeRemovalIds: rows
      .filter(row => row.disposition === "safe-removal-candidate")
      .map(row => row.id),
    missingProgressionDocuments
  };
}
