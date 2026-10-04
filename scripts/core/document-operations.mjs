function embeddedCollection(parent, documentName) {
  if (!parent || !documentName) return null;
  try {
    return parent.getEmbeddedCollection(documentName);
  } catch (error) {
    console.warn(`Could not resolve ${documentName} collection on ${parent.uuid ?? parent.id ?? "document"}.`, error);
    return null;
  }
}

function uniqueIds(ids) {
  return [...new Set((ids ?? []).map(String).filter(Boolean))];
}

/** Delete only embedded documents which still exist at mutation time. */
export async function deleteExistingEmbeddedDocuments(parent, documentName, ids, options = {}) {
  const requested = uniqueIds(ids);
  if (!requested.length) return { deleted: [], missing: [] };
  const collection = embeddedCollection(parent, documentName);
  if (!collection) throw new Error(`${documentName} collection is unavailable on ${parent?.uuid ?? "document"}.`);
  const deleted = requested.filter(id => collection.has(id));
  const missing = requested.filter(id => !collection.has(id));
  if (deleted.length) await parent.deleteEmbeddedDocuments(documentName, deleted, options);
  return { deleted, missing };
}

/** Update only embedded documents which still exist at mutation time. */
export async function updateExistingEmbeddedDocuments(parent, documentName, updates, options = {}) {
  const collection = embeddedCollection(parent, documentName);
  if (!collection) throw new Error(`${documentName} collection is unavailable on ${parent?.uuid ?? "document"}.`);
  const valid = [];
  const missing = [];
  for (const update of updates ?? []) {
    const id = String(update?._id ?? update?.id ?? "");
    if (id && collection.has(id)) valid.push(update);
    else if (id) missing.push(id);
  }
  if (valid.length) await parent.updateEmbeddedDocuments(documentName, valid, options);
  return { updated: valid.map(update => String(update._id ?? update.id)), missing };
}

/** Delete a world document if it is still present in its collection. */
export async function deleteExistingDocument(document, options = {}) {
  if (!document?.id) return false;
  const collection = document.collection;
  if (collection?.has && !collection.has(document.id)) return false;
  await document.delete(options);
  return true;
}
