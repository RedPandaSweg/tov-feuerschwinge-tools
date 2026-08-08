import { CONTENT_MODULE_ID, MODULE_ID, modulePath } from "./core/constants.mjs";

const LEGACY_MODULE = "forge-vtt-shared-compendiums-tcv-gesammt";
const LEGACY_UUID = new RegExp(
  `Compendium\\.${LEGACY_MODULE.replaceAll("-", "\\-")}\\.[\\w-]+(?:\\.Item)?\\.[A-Za-z0-9]+`,
  "g"
);
const WORLD_UUID = /Compendium\.world\.(?:equipment-and-magic-items-geteilt|players-guide-geteilt|character-classes)\.(?:Item|JournalEntry)\.[A-Za-z0-9]+(?:\.JournalEntryPage\.[A-Za-z0-9]+)?/g;
const REPAIRABLE_UUID = new RegExp(`${LEGACY_UUID.source}|${WORLD_UUID.source}`, "g");
const WORLD_PREFIX_REPLACEMENTS = new Map([
  [
    "Compendium.world.equipment-and-magic-items-geteilt",
    `Compendium.${CONTENT_MODULE_ID}.items`
  ],
  [
    "Compendium.world.players-guide-geteilt",
    `Compendium.${CONTENT_MODULE_ID}.players-guide`
  ]
]);
const WORLD_UUID_REPLACEMENTS = new Map([
  [
    `Compendium.${CONTENT_MODULE_ID}.players-guide.JournalEntry.OVthJN0gmuhOb3yA.JournalEntryPage.D5IyE9qnG4SYxhta`,
    `Compendium.${CONTENT_MODULE_ID}.players-guide.JournalEntry.OVthJN0gmuhOb3yA.JournalEntryPage.lsENrbzNtwZcidEC`
  ],
  [
    `Compendium.${CONTENT_MODULE_ID}.players-guide.JournalEntry.Em3HNTj9Fs9qZkBz.JournalEntryPage.UCl0jtcoQd68WLzv`,
    `Compendium.${CONTENT_MODULE_ID}.players-guide.JournalEntry.Em3HNTj9Fs9qZkBz.JournalEntryPage.J8wIBdWUsQJxN4dI`
  ]
]);

function packageIdFor(pack) {
  return pack.metadata.packageName ?? pack.metadata.package ?? "";
}

function playerCharacters() {
  return game.actors.filter(actor => actor.type === "pc");
}

function identities(type, identifier, name) {
  const prefix = `${type}|`;
  const keys = [];
  if (identifier) keys.push(`${prefix}id:${String(identifier).toLocaleLowerCase(game.i18n.lang)}`);
  if (name) keys.push(`${prefix}name:${String(name).trim().toLocaleLowerCase(game.i18n.lang)}`);
  return keys;
}

function sourcePriority(candidate) {
  if (candidate.packageId === game.system.id) return 0;
  if (candidate.packageId.startsWith("kp-tov-") || candidate.packageId === "koboldpressogl-bf") return 1;
  if (candidate.packageId === CONTENT_MODULE_ID) return 2;
  return 3;
}

async function currentItemIndex() {
  const index = new Map();
  const packs = game.packs.filter(pack => (
    pack.documentName === "Item" && packageIdFor(pack) !== LEGACY_MODULE
  ));
  await Promise.all(packs.map(async pack => {
    const entries = await pack.getIndex({ fields: ["type", "system.identifier.value"] });
    for (const entry of entries) {
      const keys = identities(
        entry.type,
        foundry.utils.getProperty(entry, "system.identifier.value"),
        entry.name
      );
      const candidate = {
        uuid: pack.getUuid(entry._id),
        packageId: packageIdFor(pack)
      };
      for (const key of keys) {
        const candidates = index.get(key) ?? [];
        candidates.push(candidate);
        index.set(key, candidates);
      }
    }
  }));
  for (const candidates of index.values()) candidates.sort((a, b) => sourcePriority(a) - sourcePriority(b));
  return index;
}

async function buildReplacements(catalog) {
  const current = await currentItemIndex();
  const replacements = new Map();
  const registerReplacement = (legacyUuid, replacementUuid) => {
    replacements.set(legacyUuid, replacementUuid);
    replacements.set(legacyUuid.replace(".Item.", "."), replacementUuid);
  };
  for (const legacy of catalog.entries) {
    if (legacy.sourceUuid && !legacy.sourceUuid.includes(`Compendium.${LEGACY_MODULE}.`)) {
      const source = await fromUuid(legacy.sourceUuid);
      if (source) {
        registerReplacement(legacy.oldUuid, legacy.sourceUuid);
        continue;
      }
    }
    const candidateMap = new Map();
    for (const key of identities(legacy.type, legacy.identifier, legacy.name)) {
      for (const candidate of current.get(key) ?? []) candidateMap.set(candidate.uuid, candidate);
    }
    const candidates = [...candidateMap.values()].sort((a, b) => sourcePriority(a) - sourcePriority(b));
    if (candidates.length) registerReplacement(legacy.oldUuid, candidates[0].uuid);
  }
  return { replacements, current };
}

async function loadLegacyCatalog({ reportMissing = false } = {}) {
  try {
    const response = await fetch(modulePath("data/tcv-legacy-index.json"));
    if (!response.ok) {
      if (reportMissing) {
        ui.notifications.warn(
          `Der optionale TCV-Legacy-Katalog ist nicht verfügbar (${response.status}).`,
          { permanent: true }
        );
      }
      return { entries: [] };
    }
    const catalog = await response.json();
    return Array.isArray(catalog?.entries) ? catalog : { entries: [] };
  } catch (error) {
    if (reportMissing) {
      console.warn(`${MODULE_ID} | Optional legacy catalog could not be loaded.`, error);
      ui.notifications.warn(
        "Der optionale TCV-Legacy-Katalog konnte nicht geladen werden.",
        { permanent: true }
      );
    }
    return { entries: [] };
  }
}

export async function buildLegacyItemReplacements() {
  // Startup migrations must remain independent of the optional, campaign-specific
  // legacy catalog. The manual repair action below loads it only on explicit request.
  return new Map();
}

function replaceLegacyUuids(value, replacements, unresolved) {
  if (typeof value === "string") {
    return value.replace(REPAIRABLE_UUID, uuid => {
      const replacement = replacements.get(uuid);
      if (!replacement) {
        unresolved.add(uuid);
        return uuid;
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) return value.map(entry => replaceLegacyUuids(entry, replacements, unresolved));
  if (!foundry.utils.isPlainObject(value)) return value;
  for (const [key, entry] of Object.entries(value)) {
    value[key] = replaceLegacyUuids(entry, replacements, unresolved);
  }
  return value;
}

export function replaceLegacyDocumentUuids(value, replacements) {
  const unresolved = new Set();
  return {
    value: replaceLegacyUuids(value, replacements, unresolved),
    unresolved
  };
}

function candidatesForIdentity(current, type, identifier, name) {
  const candidates = new Map();
  for (const key of identities(type, identifier, name)) {
    for (const candidate of current.get(key) ?? []) candidates.set(candidate.uuid, candidate);
  }
  return [...candidates.values()].sort((a, b) => sourcePriority(a) - sourcePriority(b));
}

async function addWorldReplacements(replacements, current) {
  const worldReferences = new Set();
  for (const actor of playerCharacters()) {
    for (const uuid of JSON.stringify(actor.toObject()).match(WORLD_UUID) ?? []) worldReferences.add(uuid);
  }

  for (const uuid of worldReferences) {
    let replacement = uuid;
    for (const [oldPrefix, newPrefix] of WORLD_PREFIX_REPLACEMENTS) {
      if (replacement.startsWith(`${oldPrefix}.`)) replacement = replacement.replace(oldPrefix, newPrefix);
    }
    replacement = WORLD_UUID_REPLACEMENTS.get(replacement) ?? replacement;
    if (replacement !== uuid && await fromUuid(replacement)) replacements.set(uuid, replacement);
  }

  for (const actor of playerCharacters()) {
    for (const item of actor.items) {
      const source = item.toObject();
      const worldClassUuids = sourceUuids(source).filter(uuid => (
        uuid.startsWith("Compendium.world.character-classes.Item.")
      ));
      if (!worldClassUuids.length) continue;
      const candidates = candidatesForIdentity(
        current,
        source.type,
        foundry.utils.getProperty(source, "system.identifier.value"),
        source.name
      );
      if (candidates.length !== 1) continue;
      for (const uuid of worldClassUuids) replacements.set(uuid, candidates[0].uuid);
    }
  }
}

function analyzeActors(replacements) {
  const actors = [];
  const unresolved = new Set();
  let references = 0;
  for (const actor of playerCharacters()) {
    const data = actor.toObject();
    const matches = JSON.stringify(data).match(REPAIRABLE_UUID) ?? [];
    if (!matches.length) continue;
    references += matches.length;
    for (const uuid of matches) if (!replacements.has(uuid)) unresolved.add(uuid);
    actors.push(actor);
  }
  return { actors, references, unresolved };
}

function completeActorSource(actor) {
  const source = actor.toObject();
  source.items = foundry.utils.deepClone(actor.items._source);
  source.effects = foundry.utils.deepClone(actor.effects._source);
  return source;
}

function sourceUuids(value) {
  return JSON.stringify(value).match(/Compendium\.[\w-]+\.[\w-]+(?:\.[A-Za-z][\w]*)?\.[A-Za-z0-9]+/g) ?? [];
}

async function originalForInvalidItem(source, catalog, replacements) {
  const explicitSource = foundry.utils.getProperty(source, "flags.core.sourceId");
  const candidates = explicitSource
    ? [explicitSource, ...sourceUuids(source).filter(uuid => uuid !== explicitSource)]
    : sourceUuids(source);
  for (const uuid of candidates) {
    const resolvedUuid = replacements.get(uuid) ?? uuid;
    if (resolvedUuid.includes(`Compendium.${LEGACY_MODULE}.`)) continue;
    const document = await fromUuid(resolvedUuid);
    if (
      document?.documentName === "Item"
      && document.type === source.type
      && (uuid === explicitSource || document.name === source.name)
    ) return document;
  }

  const identifier = foundry.utils.getProperty(source, "system.identifier.value");
  const matches = catalog.entries.filter(entry => (
    entry.type === source.type
    && (
      (identifier && entry.identifier === identifier)
      || (!identifier && entry.name === source.name)
    )
  ));
  const originals = new Map();
  for (const match of matches) {
    const uuid = replacements.get(match.oldUuid);
    if (!uuid) continue;
    const document = await fromUuid(uuid);
    if (document?.documentName === "Item") originals.set(uuid, document);
  }
  return originals.size === 1 ? originals.values().next().value : null;
}

function grantSpellMaxima(value, path = "", results = new Map()) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => grantSpellMaxima(entry, `${path}.${index}`, results));
    return results;
  }
  if (!foundry.utils.isPlainObject(value)) return results;
  if (foundry.utils.hasProperty(value, "spell.uses.max")) {
    results.set(`${path}.spell.uses.max`.replace(/^\./, ""), foundry.utils.getProperty(value, "spell.uses.max"));
  }
  for (const [key, entry] of Object.entries(value)) {
    grantSpellMaxima(entry, path ? `${path}.${key}` : key, results);
  }
  return results;
}

async function recoverInvalidItems(actor, catalog, replacements) {
  const recovered = [];
  for (const id of [...(actor.items.invalidDocumentIds ?? [])]) {
    const source = actor.items._source.find(item => item._id === id);
    if (!source) continue;
    const original = await originalForInvalidItem(source, catalog, replacements);
    if (!original) throw new Error(`Für das ungültige Item ${source.name ?? id} wurde kein eindeutiges Original gefunden.`);

    const currentMaxima = grantSpellMaxima(source);
    const originalMaxima = grantSpellMaxima(original.toObject());
    const changes = { _id: id };
    let changed = false;
    for (const [path, value] of originalMaxima) {
      if (!currentMaxima.has(path) || currentMaxima.get(path) === value) continue;
      foundry.utils.setProperty(changes, path, value);
      changed = true;
    }
    if (!changed && currentMaxima.size === 1 && originalMaxima.size === 1) {
      const [currentPath, currentValue] = currentMaxima.entries().next().value;
      const originalValue = originalMaxima.values().next().value;
      if (currentValue !== originalValue) {
        foundry.utils.setProperty(changes, currentPath, originalValue);
        changed = true;
      }
    }
    if (!changed) {
      throw new Error(
        `Das Original für ${source.name ?? id} wurde gefunden, enthält aber keine passende GrantSpells-Reparatur.`
      );
    }

    await actor.updateEmbeddedDocuments("Item", [changes]);
    if (actor.items.invalidDocumentIds.has(id)) {
      throw new Error(`Das ungültige Item ${source.name ?? id} konnte nicht wiederhergestellt werden.`);
    }
    recovered.push(source.name ?? id);
  }
  return recovered;
}

async function updateActor(actor, replacements) {
  const invalidItemIds = [...(actor.items.invalidDocumentIds ?? [])];
  const invalidEffectIds = [...(actor.effects.invalidDocumentIds ?? [])];
  if (invalidItemIds.length || invalidEffectIds.length) {
    const details = [
      invalidItemIds.length ? `ungültige Items: ${invalidItemIds.join(", ")}` : "",
      invalidEffectIds.length ? `ungültige Active Effects: ${invalidEffectIds.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    throw new Error(
      `Character enthält bereits ungültige eingebettete Dokumente (${details}). `
      + "Er wurde übersprungen, damit Foundry ihn nicht durch eine Teilaktualisierung beschädigt."
    );
  }

  const unresolved = new Set();
  const itemUpdates = [];
  for (const item of actor.items) {
    const source = item.toObject();
    // Do not submit an Item's embedded effects as part of the Item update.
    // Older Black Flag items can still contain ActiveEffect types which V14
    // can read but rejects when the parent Item is written again.
    delete source.effects;
    const replaced = replaceLegacyUuids(foundry.utils.deepClone(source), replacements, unresolved);
    const changes = foundry.utils.diffObject(source, replaced);
    if (!foundry.utils.isEmpty(changes)) itemUpdates.push({ _id: item.id, ...changes });
  }
  if (itemUpdates.length) await actor.updateEmbeddedDocuments("Item", itemUpdates);

  const source = actor.toObject();
  delete source.items;
  delete source.effects;
  const replaced = replaceLegacyUuids(foundry.utils.deepClone(source), replacements, unresolved);
  const changes = foundry.utils.diffObject(source, replaced);
  if (!foundry.utils.isEmpty(changes)) await actor.update(changes);
  return itemUpdates.length + (foundry.utils.isEmpty(changes) ? 0 : 1);
}

export async function repairLegacyCharacterLinks() {
  if (!game.user.isGM) return;
  ui.notifications.info("Character-Verweise werden geprüft …");
  const catalog = await loadLegacyCatalog({ reportMissing: true });
  const { replacements, current } = await buildReplacements(catalog);
  await addWorldReplacements(replacements, current);
  const analysis = analyzeActors(replacements);
  if (!analysis.actors.length) {
    ui.notifications.info("Keine automatisch reparierbaren Verweise in bestehenden Characters gefunden.");
    return;
  }

  const accepted = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Character-Verweise reparieren" },
    content: `
      <p><strong>${analysis.actors.length}</strong> Characters enthalten insgesamt
      <strong>${analysis.references}</strong> veraltete oder nicht mehr erreichbare Verweise.</p>
      <p><strong>${analysis.unresolved.size}</strong> unterschiedliche Verweise sind nicht automatisch auflösbar
      und bleiben unverändert.</p>
      <p>Vor der Reparatur wird ein vollständiges Backup der betroffenen Characters heruntergeladen.</p>
    `,
    modal: true,
    rejectClose: false
  });
  if (!accepted) return;

  foundry.utils.saveDataToFile(
    JSON.stringify({
      format: "tov-feuerschwinge-tcv-character-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      actors: analysis.actors.map(completeActorSource)
    }, null, 2),
    "application/json",
    `tov-feuerschwinge-character-backup-${new Date().toISOString().slice(0, 10)}.json`
  );

  let repaired = 0;
  let recovered = 0;
  const failures = [];
  for (const actor of analysis.actors) {
    try {
      recovered += (await recoverInvalidItems(actor, catalog, replacements)).length;
      await updateActor(actor, replacements);
      repaired++;
    } catch (error) {
      failures.push(actor.name);
      console.error(`${MODULE_ID} | Character konnte nicht repariert werden: ${actor.name}`, error);
    }
  }
  const failureText = failures.length
    ? ` ${failures.length} Characters schlugen fehl: ${failures.join(", ")}.`
    : "";
  ui.notifications[failures.length ? "warn" : "info"](
    `${repaired} Characters repariert; ${recovered} ungültige Items wiederhergestellt; `
    + `${analysis.unresolved.size} Verweise blieben offen.${failureText}`,
    { permanent: true }
  );
}

const ANY_COMPENDIUM_UUID = /Compendium\.[\w-]+\.[\w-]+(?:\.[A-Za-z][\w]*)?\.[A-Za-z0-9]+/g;

function collectReferences(value, path = "", references = []) {
  if (typeof value === "string") {
    for (const uuid of value.match(ANY_COMPENDIUM_UUID) ?? []) references.push({ path, uuid });
    return references;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectReferences(entry, `${path}.${index}`, references));
    return references;
  }
  if (!foundry.utils.isPlainObject(value)) return references;
  for (const [key, entry] of Object.entries(value)) {
    collectReferences(entry, path ? `${path}.${key}` : key, references);
  }
  return references;
}

export async function auditCharacterLinks() {
  if (!game.user.isGM) return;
  ui.notifications.info("Character-Verknüpfungen werden geprüft …");
  const issues = [];
  let checkedReferences = 0;
  const resolutionCache = new Map();

  const actors = playerCharacters();
  for (const actor of actors) {
    for (const id of actor.items.invalidDocumentIds ?? []) {
      issues.push({
        actor: actor.name,
        document: id,
        kind: "invalid-embedded-item",
        path: "items",
        value: `Actor.${actor.id}.Item.${id}`
      });
    }
    for (const id of actor.effects.invalidDocumentIds ?? []) {
      issues.push({
        actor: actor.name,
        document: id,
        kind: "invalid-embedded-active-effect",
        path: "effects",
        value: `Actor.${actor.id}.ActiveEffect.${id}`
      });
    }

    // Actor#toObject already contains embedded Items and Active Effects.
    // Scanning them separately would count every reference twice.
    const documents = [{ label: actor.name, document: actor }];
    for (const { label, document } of documents) {
      for (const reference of collectReferences(document.toObject())) {
        checkedReferences++;
        let resolves = resolutionCache.get(reference.uuid);
        if (resolves === undefined) {
          resolves = Boolean(await fromUuid(reference.uuid));
          resolutionCache.set(reference.uuid, resolves);
        }
        if (!resolves) {
          issues.push({
            actor: actor.name,
            document: label,
            kind: "broken-compendium-uuid",
            path: reference.path,
            value: reference.uuid
          });
        }
      }
    }

    for (const item of actor.items) {
      if (item.type === "subclass") {
        const classId = item.system?.identifier?.class;
        if (classId && !CONFIG.BlackFlag.registration.get("class", classId)) {
          issues.push({
            actor: actor.name,
            document: item.name,
            kind: "unknown-associated-class",
            path: "system.identifier.class",
            value: classId
          });
        }
      }
      if (item.type === "feature" && item.system?.type?.category === "class") {
        const associated = item.system?.identifier?.associated;
        if (
          associated
          && !CONFIG.BlackFlag.registration.get("class", associated)
          && !CONFIG.BlackFlag.registration.get("subclass", associated)
        ) {
          issues.push({
            actor: actor.name,
            document: item.name,
            kind: "unknown-feature-association",
            path: "system.identifier.associated",
            value: associated
          });
        }
      }
    }
  }

  const report = {
    format: "tov-feuerschwinge-character-link-audit",
    version: 1,
    generatedAt: new Date().toISOString(),
    actorsChecked: actors.length,
    actorNames: actors.map(actor => actor.name),
    referencesChecked: checkedReferences,
    issueCount: issues.length,
    issues
  };

  if (issues.length) {
    foundry.utils.saveDataToFile(
      JSON.stringify(report, null, 2),
      "application/json",
      `tov-feuerschwinge-character-link-audit-${new Date().toISOString().slice(0, 10)}.json`
    );
    ui.notifications.warn(
      `${issues.length} mögliche Character-Verknüpfungsfehler bei ${actors.length} PCs gefunden. Der Bericht wurde heruntergeladen.`,
      { permanent: true }
    );
  } else {
    ui.notifications.info(
      `Keine fehlerhaften Character-Verknüpfungen bei ${actors.length} PCs gefunden (${checkedReferences} Referenzen geprüft).`,
      { permanent: true }
    );
  }
  return report;
}
