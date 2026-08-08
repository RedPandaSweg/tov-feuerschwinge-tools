import { CONTENT_MODULE_ID, MODULE_ID, modulePath } from "./core/constants.mjs";

const ORIGINAL_MODULE = id => (
  id === game.system.id
  || id === "koboldpressogl-bf"
  || id.startsWith("kp-tov-")
);

function packageIdFor(pack) {
  return pack.metadata.packageName ?? pack.metadata.package ?? "";
}

function sourceLabel(packageId) {
  if (packageId === game.system.id) return game.system.title;
  return game.modules.get(packageId)?.title ?? packageId;
}

function normalizedName(value) {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

function comparisonKeys(documentName, type, identifier, name) {
  const prefix = `${documentName}|${type ?? ""}|`;
  const keys = new Set();
  if (identifier) keys.add(`${prefix}id:${normalizedName(identifier)}`);
  if (name) keys.add(`${prefix}name:${normalizedName(name)}`);
  return keys;
}

function documentIdentifier(document) {
  return document.system?.identifier?.value ?? document.identifier ?? "";
}

function indexIdentifier(entry) {
  return foundry.utils.getProperty(entry, "system.identifier.value") ?? "";
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!foundry.utils.isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, sortObject(value[key])])
  );
}

function comparableDocument(document) {
  const data = document.toObject();
  delete data._id;
  delete data.folder;
  delete data.sort;
  delete data.ownership;
  delete data._stats;
  if (data.flags?.core) {
    delete data.flags.core.sourceId;
    if (!Object.keys(data.flags.core).length) delete data.flags.core;
  }
  if (data.flags?.[MODULE_ID]) {
    delete data.flags[MODULE_ID].transfer;
    if (!Object.keys(data.flags[MODULE_ID]).length) delete data.flags[MODULE_ID];
  }
  if (data.flags && !Object.keys(data.flags).length) delete data.flags;
  return JSON.stringify(sortObject(data));
}

function originalSourceUuid(document) {
  return document._stats?.compendiumSource ?? document.getFlag("core", "sourceId") ?? "";
}

const DOCUMENT_UUID = /Compendium\.[\w-]+\.[\w-]+\.(?:Actor|Item|JournalEntry|JournalEntryPage|Macro|RollTable|Scene|Adventure|Cards)\.[A-Za-z0-9]+(?:\.(?:Item|ActiveEffect|JournalEntryPage)\.[A-Za-z0-9]+)*/g;
const CHARACTER_OPTION_TYPES = new Set(["background", "heritage", "lineage"]);

function collectUuidReferences(value, path = "", references = []) {
  if (typeof value === "string") {
    for (const uuid of value.match(DOCUMENT_UUID) ?? []) references.push({ path, uuid });
    return references;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectUuidReferences(entry, `${path}.${index}`, references));
    return references;
  }
  if (!foundry.utils.isPlainObject(value)) return references;
  for (const [key, entry] of Object.entries(value)) {
    collectUuidReferences(entry, path ? `${path}.${key}` : key, references);
  }
  return references;
}

function embeddedCollections(document) {
  return ["items", "effects", "pages"].map(key => [key, document[key]]).filter(([, value]) => value);
}

function issueFor(document, pack, kind, path, value, severity = "error") {
  return {
    kind,
    kindLabel: `TOVF.Audit.Integrity.Kind.${kind}`,
    severity,
    documentUuid: document.uuid,
    documentName: document.name,
    documentType: document.type ?? document.documentName,
    pack: pack.title,
    path,
    value: String(value ?? "")
  };
}

async function resolveUuid(uuid, cache) {
  if (cache.has(uuid)) return cache.get(uuid);
  try {
    const document = await fromUuid(uuid);
    cache.set(uuid, document || false);
    return document || false;
  } catch (error) {
    console.warn(`${MODULE_ID} | Compendium audit could not resolve ${uuid}.`, error);
    cache.set(uuid, false);
    return false;
  }
}

function auditActivityMappings(document, pack, source) {
  const issues = [];
  const activityIds = new Set();
  const walk = (value, path = "") => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}.${index}`));
      return;
    }
    if (!foundry.utils.isPlainObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = path ? `${path}.${key}` : key;
      if (key === "activities" && foundry.utils.isPlainObject(entry)) {
        for (const [activityKey, activity] of Object.entries(entry)) {
          const activityPath = `${entryPath}.${activityKey}`;
          if (!activity?._id || activity._id !== activityKey) {
            issues.push(issueFor(
              document,
              pack,
              "ActivityIdMismatch",
              activityPath,
              activity?._id ?? ""
            ));
          }
          if (activityIds.has(activityKey)) {
            issues.push(issueFor(document, pack, "DuplicateActivityId", activityPath, activityKey));
          }
          activityIds.add(activityKey);
          if (!activity?.type) {
            issues.push(issueFor(document, pack, "ActivityTypeMissing", activityPath, activityKey));
          }
          if (!activity?.activation) {
            issues.push(issueFor(document, pack, "ActivityActivationMissing", activityPath, activityKey));
          }
          if (!foundry.utils.isPlainObject(activity?.system)) {
            issues.push(issueFor(document, pack, "ActivitySystemMissing", activityPath, activityKey));
          } else if (activity.type === "attack" && !activity.system.attack) {
            issues.push(issueFor(document, pack, "AttackConfigMissing", activityPath, activityKey));
          } else if (activity.type === "save" && !activity.system.save) {
            issues.push(issueFor(document, pack, "SaveConfigMissing", activityPath, activityKey));
          }
        }
      } else {
        walk(entry, entryPath);
      }
    }
  };
  walk(source);
  return issues;
}

async function auditDocumentIntegrity(document, pack, resolutionCache) {
  const source = document.toObject();
  const issues = auditActivityMappings(document, pack, source);

  const folderId = document.folder?.id ?? document.folder;
  if (folderId && !pack.folders?.get(folderId)) {
    issues.push(issueFor(document, pack, "FolderBroken", "folder", folderId));
  }

  const allowedTypes = pack.metadata.flags?.["black-flag"]?.types;
  if (Array.isArray(allowedTypes) && document.type && !allowedTypes.includes(document.type)) {
    issues.push(issueFor(document, pack, "UnexpectedDocumentType", "type", document.type));
  }

  for (const [collectionName, collection] of embeddedCollections(document)) {
    for (const id of collection.invalidDocumentIds ?? []) {
      issues.push(issueFor(document, pack, "InvalidEmbeddedDocument", collectionName, id));
    }
    if (collectionName === "effects") {
      for (const effect of collection) {
        if (effect.toObject().type === "standard") {
          issues.push(issueFor(
            document,
            pack,
            "LegacyActiveEffectType",
            `effects.${effect.id}.type`,
            "standard"
          ));
        }
      }
    }
  }

  const references = collectUuidReferences(source);
  for (const { path, uuid } of references) {
    const parts = uuid.split(".");
    const packageId = parts[1] ?? "";
    const packId = parts[2] ?? "";
    if (
      packageId === "world"
      || packageId === "forge-vtt-shared-compendiums-tcv-gesammt"
      || (packageId === CONTENT_MODULE_ID && !game.packs.get(`${packageId}.${packId}`))
    ) {
      issues.push(issueFor(document, pack, "LegacyUuid", path, uuid, "warning"));
    }
    const resolves = await resolveUuid(uuid, resolutionCache);
    if (!resolves) {
      const sourceAvailable = (
        packageId === "world"
        || packageId === CONTENT_MODULE_ID
        || packageId === game.system.id
        || game.modules.get(packageId)?.active
      );
      issues.push(issueFor(
        document,
        pack,
        sourceAvailable ? "BrokenUuid" : "OptionalExternalUuid",
        path,
        uuid,
        sourceAvailable ? "error" : "warning"
      ));
    }
  }

  if (pack.documentName === "Item" && CHARACTER_OPTION_TYPES.has(document.type)) {
    const journalUuid = document.system?.description?.journal;
    if (!journalUuid) {
      issues.push(issueFor(document, pack, "JournalMissing", "system.description.journal", ""));
    } else {
      const journal = await resolveUuid(journalUuid, resolutionCache);
      if (!journal) {
        issues.push(issueFor(document, pack, "JournalBroken", "system.description.journal", journalUuid));
      }
    }

    const advancements = Object.values(document.system?.advancement ?? {});
    const hasFeatureAdvancement = advancements.some(advancement => (
      /features?/i.test(String(advancement?.type ?? ""))
    ));
    if (!hasFeatureAdvancement) {
      issues.push(issueFor(
        document,
        pack,
        "AdvancementGrantMissing",
        "system.advancement",
        "",
        "warning"
      ));
    }
  }

  return issues;
}

async function buildOriginalIndex() {
  const candidates = new Map();
  const packs = game.packs.filter(pack => ORIGINAL_MODULE(packageIdFor(pack)) && pack.visible !== false);
  await Promise.all(packs.map(async pack => {
    const index = await pack.getIndex({ fields: ["type", "system.identifier.value"] });
    for (const entry of index) {
      const candidate = {
        id: entry._id,
        uuid: pack.getUuid(entry._id),
        name: entry.name,
        type: entry.type ?? "",
        pack: pack.collection,
        packLabel: pack.title,
        source: packageIdFor(pack),
        sourceLabel: sourceLabel(packageIdFor(pack))
      };
      for (const key of comparisonKeys(
        pack.documentName,
        entry.type,
        indexIdentifier(entry),
        entry.name
      )) {
        const values = candidates.get(key) ?? [];
        values.push(candidate);
        candidates.set(key, values);
      }
    }
  }));
  return candidates;
}

async function compareLocalDocument(document, pack, originals) {
  const candidateMap = new Map();
  for (const key of comparisonKeys(
    pack.documentName,
    document.type,
    documentIdentifier(document),
    document.name
  )) {
    for (const candidate of originals.get(key) ?? []) candidateMap.set(candidate.uuid, candidate);
  }
  const candidates = [...candidateMap.values()];
  const localComparable = comparableDocument(document);
  let exact = null;
  let linked = null;
  const sourceUuid = originalSourceUuid(document);

  for (const candidate of candidates) {
    if (candidate.uuid === sourceUuid) linked = candidate;
    const original = await fromUuid(candidate.uuid);
    if (original && comparableDocument(original) === localComparable) {
      exact = candidate;
      break;
    }
  }

  let status;
  let recommendation;
  if (exact) {
    status = "exact";
    recommendation = "TOVF.Audit.Recommendation.Replace";
  } else if (linked || candidates.length === 1) {
    status = "modified";
    recommendation = "TOVF.Audit.Recommendation.Review";
  } else if (candidates.length > 1) {
    status = "ambiguous";
    recommendation = "TOVF.Audit.Recommendation.Ambiguous";
  } else {
    status = "unique";
    recommendation = "TOVF.Audit.Recommendation.Keep";
  }

  const match = exact ?? linked ?? candidates[0] ?? null;
  return {
    name: document.name,
    type: document.type ?? pack.documentName,
    localUuid: document.uuid,
    localPack: pack.title,
    status,
    statusLabel: `TOVF.Audit.Status.${status[0].toUpperCase()}${status.slice(1)}`,
    recommendation,
    matchUuid: match?.uuid ?? "",
    matchName: match?.name ?? "",
    matchPack: match?.packLabel ?? "",
    sourceLabel: match?.sourceLabel ?? "",
    candidateCount: candidates.length
  };
}

export async function auditCompendiums() {
  const originals = await buildOriginalIndex();
  const localPacks = game.packs.filter(pack => packageIdFor(pack) === CONTENT_MODULE_ID);
  const rows = [];
  const integrityIssues = [];
  const resolutionCache = new Map();
  for (const pack of localPacks) {
    const documents = await pack.getDocuments();
    const identifiers = new Map();
    for (const document of documents) {
      rows.push(await compareLocalDocument(document, pack, originals));
      integrityIssues.push(...await auditDocumentIntegrity(document, pack, resolutionCache));
      const identifier = documentIdentifier(document);
      if (identifier) {
        const key = `${document.type ?? document.documentName}|${normalizedName(identifier)}`;
        const matches = identifiers.get(key) ?? [];
        matches.push(document);
        identifiers.set(key, matches);
      }
    }
    for (const matches of identifiers.values()) {
      if (matches.length < 2) continue;
      for (const document of matches) {
        integrityIssues.push(issueFor(
          document,
          pack,
          "DuplicateIdentifier",
          "system.identifier.value",
          documentIdentifier(document),
          "warning"
        ));
      }
    }
  }
  rows.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name, game.i18n.lang));
  integrityIssues.sort((a, b) => (
    a.severity.localeCompare(b.severity)
    || a.pack.localeCompare(b.pack, game.i18n.lang)
    || a.documentName.localeCompare(b.documentName, game.i18n.lang)
  ));
  return {
    generatedAt: new Date().toISOString(),
    rows,
    integrityIssues,
    integrityCount: integrityIssues.length,
    integrityCounts: {
      error: integrityIssues.filter(issue => issue.severity === "error").length,
      warning: integrityIssues.filter(issue => issue.severity === "warning").length
    },
    documentsChecked: rows.length,
    referencesChecked: resolutionCache.size,
    duplicateCount: rows.filter(row => row.status !== "unique" && row.matchUuid).length,
    counts: Object.fromEntries(["exact", "modified", "ambiguous", "unique"].map(status => [
      status,
      rows.filter(row => row.status === status).length
    ]))
  };
}

function replaceUuidStrings(value, pattern, replacements) {
  if (typeof value === "string") return value.replace(pattern, match => replacements.get(match));
  if (Array.isArray(value)) return value.map(entry => replaceUuidStrings(entry, pattern, replacements));
  if (!foundry.utils.isPlainObject(value)) return value;
  for (const [key, entry] of Object.entries(value)) {
    value[key] = replaceUuidStrings(entry, pattern, replacements);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function cleanupExternalCopies(report) {
  const duplicateRows = report.rows.filter(row => row.status !== "unique" && row.matchUuid);
  if (!duplicateRows.length) return { deleted: 0, updated: 0 };

  const replacements = new Map(duplicateRows.map(row => [row.localUuid, row.matchUuid]));
  const duplicateDocuments = (await Promise.all(
    duplicateRows.map(row => fromUuid(row.localUuid))
  )).filter(Boolean);
  foundry.utils.saveDataToFile(
    JSON.stringify({
      format: "tov-feuerschwinge-external-copy-backup",
      version: 2,
      exportedAt: new Date().toISOString(),
      mappings: duplicateRows.map(row => ({
        localUuid: row.localUuid,
        originalUuid: row.matchUuid,
        status: row.status,
        candidateCount: row.candidateCount
      })),
      documents: duplicateDocuments.map(document => ({
        pack: document.pack,
        documentType: document.documentName,
        data: document.toObject()
      }))
    }, null, 2),
    "application/json",
    `tov-feuerschwinge-externe-kopien-backup-${new Date().toISOString().slice(0, 10)}.json`
  );

  const localPacks = game.packs.filter(pack => packageIdFor(pack) === CONTENT_MODULE_ID);
  const lockStates = new Map(localPacks.map(pack => [pack.collection, pack.locked]));
  const duplicateUuids = new Set(replacements.keys());
  const pattern = new RegExp(
    [...replacements.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"),
    "g"
  );
  let updated = 0;

  try {
    for (const pack of localPacks) {
      if (pack.locked) await pack.configure({ locked: false });
    }

    // Rewrite references in every retained module document before deletion.
    for (const pack of localPacks) {
      for (const document of await pack.getDocuments()) {
        if (duplicateUuids.has(document.uuid)) continue;
        const source = document.toObject();
        const replaced = replaceUuidStrings(foundry.utils.deepClone(source), pattern, replacements);
        const changes = foundry.utils.diffObject(source, replaced);
        if (foundry.utils.isEmpty(changes)) continue;
        await document.update(changes);
        updated++;
      }
    }

    const deletions = new Map();
    for (const document of duplicateDocuments) {
      const ids = deletions.get(document.pack) ?? [];
      ids.push(document.id);
      deletions.set(document.pack, ids);
    }
    for (const [collection, ids] of deletions) {
      const pack = game.packs.get(collection);
      await pack.documentClass.deleteDocuments(ids, { pack: collection });
    }
  } finally {
    for (const pack of localPacks) {
      if (lockStates.get(pack.collection) && !pack.locked) await pack.configure({ locked: true });
    }
  }

  return { deleted: duplicateDocuments.length, updated };
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class CompendiumAudit extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-compendium-audit",
    classes: ["tovf-audit"],
    position: { width: 1040, height: 760 },
    window: { title: "TOVF.Audit.Title", resizable: true },
    actions: {
      openLocal: this.#openUuid,
      openOriginal: this.#openUuid,
      exportReport: this.#exportReport,
      cleanupDuplicates: this.#cleanupDuplicates
    }
  };

  static PARTS = {
    content: { template: modulePath("templates/compendium-audit.hbs") }
  };

  report;

  constructor(report, options = {}) {
    super(options);
    this.report = report;
  }

  async _prepareContext(options) {
    return {
      ...(await super._prepareContext(options)),
      ...this.report
    };
  }

  static async #openUuid(_event, target) {
    const document = await fromUuid(target.dataset.uuid);
    document?.sheet?.render(true);
  }

  static #exportReport() {
    foundry.utils.saveDataToFile(
      JSON.stringify(this.report, null, 2),
      "application/json",
      `tov-feuerschwinge-audit-${this.report.generatedAt.slice(0, 10)}.json`
    );
  }

  static async #cleanupDuplicates() {
    const count = this.report.duplicateCount;
    if (!count) return;
    const accepted = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("TOVF.Audit.Cleanup.Title") },
      content: `<p>${game.i18n.format("TOVF.Audit.Cleanup.Confirm", { count })}</p>`,
      modal: true,
      rejectClose: false
    });
    if (!accepted) return;

    try {
      const result = await cleanupExternalCopies(this.report);
      ui.notifications.info(game.i18n.format("TOVF.Audit.Cleanup.Complete", result), { permanent: true });
      await this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | External-copy cleanup failed.`, error);
      ui.notifications.error(game.i18n.format("TOVF.Audit.Cleanup.Error", { message: error.message }), {
        permanent: true
      });
    }
  }
}

export async function openCompendiumAudit() {
  if (!game.user.isGM) return;
  ui.notifications.info(game.i18n.localize("TOVF.Audit.Running"));
  const report = await auditCompendiums();
  new CompendiumAudit(report).render({ force: true });
}
