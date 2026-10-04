import { uiText } from "../core/localization.mjs";
import {
  DEFAULT_SESSION_PROGRESS,
  FLAGS,
  MODULE_ID,
  SETTINGS
} from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { ProjectService } from "./project-service.mjs";
import { isActiveCharacter, milestoneEntries, playerCharacters, sessionProgress } from "./session-service.mjs";
import { assignMilestoneEvidence, milestoneEvidence } from "../campaign/milestone-evidence.mjs";
import { round } from "./utils.mjs";
import { deleteExistingEmbeddedDocuments } from "../core/document-operations.mjs?v=3.7.8-safe-documents-1";

function requireGM() {
  if (!game.user?.isGM) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.GMOnly"));
}

function finiteNumber(value, label, { minimum = 0, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || (integer && !Number.isInteger(number))) {
    throw new Error(game.i18n.format("DOWNTIME_MANAGER.GMTools.Errors.InvalidNumber", { label }));
  }
  return integer ? number : round(number, 6);
}

async function actorFromUuid(uuid) {
  const actor = await fromUuid(String(uuid ?? "")).catch(() => null);
  if (!actor || actor.documentName !== "Actor") {
    throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.ActorMissing"));
  }
  return actor;
}

async function storeUndo(snapshot) {
  await game.settings.set(MODULE_ID, SETTINGS.GM_TOOL_UNDO, {
    ...foundry.utils.deepClone(snapshot),
    timestamp: Date.now(),
    userId: game.user.id
  });
}

function flagDocumentCollections() {
  const actors = collectionDocuments(game.actors);
  const pcTypes = new Set(["pc", "character", "player-character"]);
  const pcs = actors.filter(actor => pcTypes.has(actor.type));
  const npcs = actors.filter(actor => actor.type === "npc");
  const worldItems = collectionDocuments(game.items);
  const actorItems = actors.flatMap(actor => collectionDocuments(actor.items));
  const items = [...worldItems, ...actorItems];
  const scenes = collectionDocuments(game.scenes);
  const journals = collectionDocuments(game.journal);
  const effects = [...actors, ...items].flatMap(document => collectionDocuments(document.effects));
  return [
    ["ActorPC", pcs],
    ["ActorNPC", npcs],
    ["Item", items],
    ["ActiveEffect", effects],
    ["Scene", scenes],
    ["Token", scenes.flatMap(scene => collectionDocuments(scene.tokens))],
    ["JournalEntry", journals],
    ["JournalEntryPage", journals.flatMap(journal => collectionDocuments(journal.pages))],
    ["RollTable", game.tables],
    ["Macro", game.macros],
    ["Playlist", game.playlists],
    ["Cards", game.cards]
  ].filter(([, collection]) => collection);
}

function collectionDocuments(collection) {
  return collection?.contents ?? [...(collection?.values?.() ?? [])];
}

const LEGACY_EFFECT_FORMULA_REFERENCES = [
  "@traits.movement.base",
  "@abilities.dexterity.mod",
  "@abilities.str.mod",
  "@attributes.proficiency",
  "@attributes.spell.mod",
  "@prof",
  "@base"
];

function actorEffects(actor) {
  return [
    ...collectionDocuments(actor.effects),
    ...collectionDocuments(actor.items).flatMap(item => collectionDocuments(item.effects))
  ];
}

function formulaSource(document) {
  return {
    sourceId: String(document?._stats?.compendiumSource ?? document?.getFlag?.("core", "sourceId") ?? "").trim(),
    sourceName: document?.name ?? "?"
  };
}

function legacyEffectFormulaChanges() {
  const matches = [];
  for (const actor of collectionDocuments(game.actors)) {
    for (const effect of actorEffects(actor)) {
      const indexes = [];
      for (const [index, change] of collectionDocuments(effect.changes).entries()) {
        const value = String(change?.value ?? "");
        if (LEGACY_EFFECT_FORMULA_REFERENCES.some(reference => value.includes(reference))) indexes.push(index);
      }
      const legacyType = effect.type === "standard" || effect._source?.type === "standard";
      if (indexes.length || legacyType) matches.push({ actor, effect, indexes, legacyType });
    }
  }
  return matches;
}

function cleanLegacyAdvancementFormulas(value) {
  let removed = 0;
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node?.configuration?.changes)) {
      const before = node.configuration.changes.length;
      node.configuration.changes = node.configuration.changes.filter(change => {
        const formula = String(change?.value ?? "");
        return !LEGACY_EFFECT_FORMULA_REFERENCES.some(reference => formula.includes(reference));
      });
      removed += before - node.configuration.changes.length;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return removed;
}

function legacyAdvancementFormulaItems() {
  const matches = [];
  for (const actor of collectionDocuments(game.actors)) {
    for (const item of collectionDocuments(actor.items)) {
      const advancement = foundry.utils.deepClone(item._source?.system?.advancement);
      if (!advancement) continue;
      const removed = cleanLegacyAdvancementFormulas(advancement);
      if (removed) matches.push({ actor, item, advancement, removed });
    }
  }
  return matches;
}

function flagValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function flagValueText(value) {
  if (typeof value === "string") return value;
  if (["object", "array"].includes(flagValueType(value))) return JSON.stringify(value, null, 2);
  if (value === null) return "null";
  return String(value);
}

function flagValueSummary(value) {
  const type = flagValueType(value);
  if (type === "array") return `Array(${value.length})`;
  if (type === "object") return `Object(${Object.keys(value).length})`;
  const text = flagValueText(value);
  return text.length > 70 ? `${text.slice(0, 67)}…` : text;
}

function flagNodes(value, prefix = "") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const nodes = [];
  for (const [key, child] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right, game.i18n.lang))) {
    const path = prefix ? `${prefix}.${key}` : key;
    nodes.push({ path, label: key, type: flagValueType(child), summary: flagValueSummary(child), depth: path.split(".").length - 1 });
    if (child && typeof child === "object" && !Array.isArray(child)) nodes.push(...flagNodes(child, path));
  }
  return nodes;
}

function validateFlagAddress(namespace, path, { allowEmptyPath = true } = {}) {
  namespace = String(namespace ?? "").trim();
  path = String(path ?? "").trim();
  const validPart = value => /^[A-Za-z0-9_-]+$/.test(value);
  if (!validPart(namespace) || (!allowEmptyPath && !path) || (path && !path.split(".").every(validPart))) {
    throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidFlagPath"));
  }
  return { namespace, path };
}

function parseFlagValue(type, raw) {
  type = String(type ?? "string");
  if (type === "string") return String(raw ?? "");
  if (type === "number") {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidFlagValue"));
    return value;
  }
  if (type === "boolean") return String(raw) === "true";
  if (type === "null") return null;
  if (!["object", "array"].includes(type)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidFlagValue"));
  let value;
  try {
    value = JSON.parse(String(raw ?? ""));
  } catch {
    throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidFlagJson"));
  }
  if ((type === "array") !== Array.isArray(value) || (type === "object" && (!value || Array.isArray(value) || typeof value !== "object"))) {
    throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidFlagValue"));
  }
  return value;
}

async function flagDocument(uuid) {
  const document = await fromUuid(String(uuid ?? "")).catch(() => null);
  if (!document?.update || !document.documentName) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.DocumentMissing"));
  return document;
}

async function restoreFlags(document, flags) {
  const removals = {};
  for (const namespace of Object.keys(document.flags ?? {})) removals[`flags.-=${namespace}`] = null;
  if (Object.keys(removals).length) await document.update(removals);
  const replacements = Object.fromEntries(Object.entries(flags ?? {}).map(([namespace, value]) => (
    [`flags.${namespace}`, foundry.utils.deepClone(value)]
  )));
  if (Object.keys(replacements).length) await document.update(replacements);
}

export class GMToolsService {

  static expiredTemporaryEffectSummary() {
    requireGM();
    const entries = collectionDocuments(game.actors).flatMap(actor => collectionDocuments(actor.effects)
      .filter(effect => effect.isTemporary && effect.duration?.expired === true)
      .map(effect => ({
        actorUuid: actor.uuid,
        actorName: actor.name,
        effectId: effect.id,
        effectName: effect.name
      })));
    return {
      count: entries.length,
      actors: new Set(entries.map(entry => entry.actorUuid)).size,
      entries: entries.sort((left, right) => left.actorName.localeCompare(right.actorName, game.i18n.lang)
        || left.effectName.localeCompare(right.effectName, game.i18n.lang))
    };
  }

  static async deleteExpiredTemporaryEffects() {
    requireGM();
    const groups = collectionDocuments(game.actors).map(actor => ({
      actor,
      effects: collectionDocuments(actor.effects).filter(effect => effect.isTemporary && effect.duration?.expired === true)
    })).filter(entry => entry.effects.length);
    const count = groups.reduce((total, entry) => total + entry.effects.length, 0);
    if (!count) return 0;
    await storeUndo({
      kind: "effects",
      tab: "diagnostics",
      actors: groups.map(({ actor, effects }) => ({
        actorUuid: actor.uuid,
        effects: effects.map(effect => effect.toObject())
      }))
    });
    for (const { actor, effects } of groups) {
      await deleteExistingEmbeddedDocuments(actor, "ActiveEffect", effects.map(effect => effect.id));
    }
    return count;
  }

  static legacyEffectFormulaSummary() {
    requireGM();
    const matches = legacyEffectFormulaChanges();
    const advancementMatches = legacyAdvancementFormulaItems();
    const entries = [
        ...matches.flatMap(({ actor, effect, indexes, legacyType }) => {
          const owner = effect.parent?.documentName === "Item" ? effect.parent : effect;
          const source = formulaSource(owner);
          const location = effect.parent?.documentName === "Item"
            ? `${effect.parent.name} · ${effect.name}`
            : effect.name;
          const formulaEntries = indexes.map(index => {
            const change = collectionDocuments(effect.changes)[index] ?? {};
            return {
              actorName: actor.name,
              documentUuid: owner.uuid,
              location,
              path: `changes.${index}.value`,
              formula: String(change.value ?? ""),
              references: LEGACY_EFFECT_FORMULA_REFERENCES.filter(reference => String(change.value ?? "").includes(reference)).join(", "),
              ...source
            };
          });
          if (legacyType) formulaEntries.push({
            actorName: actor.name,
            documentUuid: owner.uuid,
            location,
            path: "type",
            formula: "standard",
            references: "Active Effect type",
            ...source
          });
          return formulaEntries;
        }),
        ...advancementMatches.flatMap(({ actor, item }) => {
          const entries = [];
          const source = formulaSource(item);
          const visit = (node, path = "system.advancement") => {
            if (!node || typeof node !== "object") return;
            if (Array.isArray(node?.configuration?.changes)) {
              node.configuration.changes.forEach((change, index) => {
                const formula = String(change?.value ?? "");
                const references = LEGACY_EFFECT_FORMULA_REFERENCES.filter(reference => formula.includes(reference));
                if (references.length) entries.push({
                  actorName: actor.name,
                  documentUuid: item.uuid,
                  location: item.name,
                  path: `${path}.configuration.changes.${index}.value`,
                  formula,
                  references: references.join(", "),
                  ...source
                });
              });
            }
            for (const [key, child] of Object.entries(node)) visit(child, `${path}.${key}`);
          };
          visit(item._source?.system?.advancement);
          return entries;
        })
      ];
    const grouped = new Map();
    for (const entry of entries) {
      const key = entry.sourceId || `document:${entry.documentUuid}`;
      if (!grouped.has(key)) grouped.set(key, { sourceId: entry.sourceId, sourceName: entry.sourceName, entries: [] });
      grouped.get(key).entries.push(entry);
    }
    const groups = [...grouped.values()].map(group => ({
      ...group,
      actors: new Set(group.entries.map(entry => entry.actorName)).size,
      entries: group.entries.sort((left, right) => left.actorName.localeCompare(right.actorName, game.i18n.lang)
        || left.location.localeCompare(right.location, game.i18n.lang)
        || left.path.localeCompare(right.path, game.i18n.lang))
    })).sort((left, right) => left.sourceName.localeCompare(right.sourceName, game.i18n.lang)
      || left.sourceId.localeCompare(right.sourceId, game.i18n.lang));
    return {
      changes: matches.reduce((count, entry) => count + entry.indexes.length, 0),
      types: matches.filter(entry => entry.legacyType).length,
      effects: matches.length,
      advancementChanges: advancementMatches.reduce((count, entry) => count + entry.removed, 0),
      advancementItems: advancementMatches.length,
      actors: new Set([...matches, ...advancementMatches].map(entry => entry.actor.uuid)).size,
      groups
    };
  }

  static flagDocumentTypes() {
    requireGM();
    return flagDocumentCollections().map(([id, collection]) => ({ id, count: collection.size ?? collection.length ?? 0 }));
  }

  static flagDocuments(type, { query = "", namespace = "", onlyFlagged = true } = {}) {
    requireGM();
    const collection = flagDocumentCollections().find(([id]) => id === type)?.[1];
    if (!collection) return [];
    query = String(query).trim().toLocaleLowerCase();
    namespace = String(namespace).trim();
    return collectionDocuments(collection)
      .filter(document => {
        const flags = document.flags ?? {};
        if (onlyFlagged && !Object.keys(flags).length) return false;
        if (namespace && !Object.hasOwn(flags, namespace)) return false;
        const haystack = `${document.name} ${document.id} ${document.uuid} ${Object.keys(flags).join(" ")}`.toLocaleLowerCase();
        return !query || haystack.includes(query);
      })
      .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang))
      .map(document => ({
        uuid: document.uuid,
        id: document.id,
        name: document.name,
        img: document.img ?? document.thumbnail ?? "icons/svg/book.svg",
        namespaces: Object.keys(document.flags ?? {}).sort(),
        flagCount: Object.keys(foundry.utils.flattenObject(document.flags ?? {})).length
      }));
  }

  static flagNamespaces(type) {
    requireGM();
    const collection = flagDocumentCollections().find(([id]) => id === type)?.[1];
    if (!collection) return [];
    const counts = new Map();
    for (const document of collectionDocuments(collection)) for (const namespace of Object.keys(document.flags ?? {})) counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
    return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([id, count]) => ({ id, count }));
  }

  static async flagDocumentData(uuid, selectedAddress = "") {
    requireGM();
    const document = await flagDocument(uuid);
    const groups = Object.entries(document.flags ?? {}).sort(([left], [right]) => left.localeCompare(right)).map(([namespace, value]) => ({
      namespace,
      count: Object.keys(foundry.utils.flattenObject(value ?? {})).length,
      entries: [
        { path: "", address: namespace, label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Database.EntireNamespace"), type: flagValueType(value), summary: flagValueSummary(value), depth: 0, indent: 0 },
        ...flagNodes(value).map(node => ({ ...node, address: `${namespace}.${node.path}`, depth: node.depth + 1 }))
      ].map(node => ({ ...node, indent: node.indent ?? node.depth * 0.7, selected: node.address === selectedAddress }))
    }));
    let selected = null;
    if (selectedAddress) {
      const [namespace, ...parts] = selectedAddress.split(".");
      const path = parts.join(".");
      const value = path ? foundry.utils.getProperty(document.flags?.[namespace], path) : document.flags?.[namespace];
      if (value !== undefined) selected = { namespace, path, address: selectedAddress, type: flagValueType(value), value: flagValueText(value), summary: flagValueSummary(value) };
    }
    return { document, groups, selected };
  }

  static parseFlagValue(type, raw) {
    requireGM();
    return parseFlagValue(type, raw);
  }

  static async setFlags(uuids, namespace, path, type, rawValue) {
    requireGM();
    ({ namespace, path } = validateFlagAddress(namespace, path));
    const value = parseFlagValue(type, rawValue);
    if (!path && (!value || Array.isArray(value) || typeof value !== "object")) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidFlagNamespace"));
    }
    const documents = await Promise.all([...new Set(uuids)].map(flagDocument));
    if (!documents.length) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.DocumentMissing"));
    await storeUndo({ kind: "flags", documents: documents.map(document => ({ uuid: document.uuid, before: foundry.utils.deepClone(document.flags ?? {}) })) });
    for (const document of documents) await document.update({ [`flags.${namespace}${path ? `.${path}` : ""}`]: foundry.utils.deepClone(value) });
    return documents.length;
  }

  static async deleteFlags(uuids, namespace, path) {
    requireGM();
    ({ namespace, path } = validateFlagAddress(namespace, path));
    const documents = await Promise.all([...new Set(uuids)].map(flagDocument));
    if (!documents.length) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.DocumentMissing"));
    await storeUndo({ kind: "flags", documents: documents.map(document => ({ uuid: document.uuid, before: foundry.utils.deepClone(document.flags ?? {}) })) });
    const parts = path.split(".").filter(Boolean);
    const key = parts.pop();
    const updatePath = key
      ? `flags.${namespace}${parts.length ? `.${parts.join(".")}` : ""}.-=${key}`
      : `flags.-=${namespace}`;
    for (const document of documents) await document.update({ [updatePath]: null });
    return documents.length;
  }

  static async exportFlags(uuids) {
    requireGM();
    const documents = await Promise.all([...new Set(uuids)].map(flagDocument));
    return {
      format: "tov-feuerschwinge-flag-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      documents: documents.map(document => ({ uuid: document.uuid, documentName: document.documentName, id: document.id, name: document.name, flags: foundry.utils.deepClone(document.flags ?? {}) }))
    };
  }

  static characters() {
    requireGM();
    return playerCharacters();
  }

  static async characterData(actorUuid) {
    requireGM();
    const actor = await actorFromUuid(actorUuid);
    return {
      actor,
      downtime: DowntimeService.get(actor),
      progress: sessionProgress(actor),
      projects: ProjectService.get(actor)
    };
  }

  static async updateCharacter(actorUuid, values) {
    requireGM();
    const actor = await actorFromUuid(actorUuid);
    const before = {
      downtime: actor.getFlag(MODULE_ID, FLAGS.DOWNTIME) ?? null,
      sessionProgress: actor.getFlag(MODULE_ID, FLAGS.SESSION_PROGRESS) ?? null,
      active: actor.getFlag(MODULE_ID, FLAGS.ACTIVE) ?? null
    };
    const downtime = values.downtime === undefined ? DowntimeService.get(actor) : finiteNumber(values.downtime, game.i18n.localize("DOWNTIME_MANAGER.GMTools.Downtime"));
    const milestoneLabel = game.i18n.localize('DOWNTIME_MANAGER.GMTools.Milestones');
    const existingEntries = milestoneEntries(actor);
    if (values.milestoneSignature && values.milestoneSignature !== JSON.stringify(existingEntries)) throw new Error(uiText("TOVF.Interface.MilestonesHaveChangedReopenTheEditor_05bca3", "Meilensteine wurden inzwischen geändert. Editor neu öffnen."));
    const rows = Array.isArray(values.milestoneEntries) ? values.milestoneEntries : existingEntries.map((entry, originalIndex) => ({ ...entry, originalIndex }));
    const used = new Set();
    let entries = rows.map(entry => {
      const index = Number(entry.originalIndex);
      const original = entry.originalIndex !== "" && Number.isInteger(index) && index >= 0 && !used.has(index) ? existingEntries[index] : null;
      if (original) used.add(index);
      return {
        ...(original || {}),
        source: ["session", "community", "gm", "start", "correction"].includes(entry.source) ? entry.source : "start",
        note: String(entry.note ?? "").trim(),
        week: String(entry.week ?? "").trim()
      };
    });
    entries = assignMilestoneEvidence(entries, rows, existingEntries, milestoneEvidence(actor.uuid));
    const milestones = finiteNumber(entries.length, milestoneLabel, { integer: true });
    const sessionsPlayed = finiteNumber(values.sessionsPlayed, game.i18n.localize("DOWNTIME_MANAGER.GMTools.SessionsPlayed"), { integer: true });
    let passiveDowntime;
    try {
      passiveDowntime = values.passiveDowntime === undefined ? sessionProgress(actor).passiveDowntime ?? {} : JSON.parse(String(values.passiveDowntime));
    } catch {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidPassive"));
    }
    if (!passiveDowntime || Array.isArray(passiveDowntime) || typeof passiveDowntime !== "object"
      || Object.values(passiveDowntime).some(value => !Number.isFinite(Number(value)) || Number(value) < 0)) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.InvalidPassive"));
    }
    passiveDowntime = Object.fromEntries(Object.entries(passiveDowntime).map(([key, value]) => [key, round(Number(value), 6)]));
    const progress = {
      ...foundry.utils.deepClone(DEFAULT_SESSION_PROGRESS),
      ...sessionProgress(actor),
      milestones,
      milestoneEntries: entries,
      sessionsPlayed,
      lastMilestoneWeek: String(values.lastMilestoneWeek ?? "").trim() || null,
      passiveDowntime
    };
    await storeUndo({ kind: "actor", tab: "characters", actorUuid: actor.uuid, before });
    if (values.downtime !== undefined) await actor.setFlag(MODULE_ID, FLAGS.DOWNTIME, downtime);
    await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, progress);
    await actor.setFlag(MODULE_ID, FLAGS.ACTIVE, values.active !== false);
    return { actor, downtime, progress };
  }

  static async updateActivity(entries) {
    requireGM();
    const eligible = new Map(playerCharacters().map(actor => [actor.uuid, actor]));
    const rows = [];
    for (const entry of entries ?? []) {
      const actor = eligible.get(entry.actorUuid);
      if (!actor) continue;
      const active = Boolean(entry.active);
      const before = actor.getFlag(MODULE_ID, FLAGS.ACTIVE);
      if ((before !== false) === active && before !== undefined) continue;
      if (before === undefined && active) continue;
      rows.push({ actor, active, before: before ?? null });
    }
    if (!rows.length) return 0;
    await storeUndo({
      kind: "batch",
      actors: rows.map(row => ({ actorUuid: row.actor.uuid, before: { active: row.before } }))
    });
    await Actor.updateDocuments(rows.map(row => ({ _id: row.actor.id, [`flags.${MODULE_ID}.${FLAGS.ACTIVE}`]: row.active })));
    return rows.length;
  }

  static async updateDowntime(actorUuid, values) {
    requireGM();
    const actor = await actorFromUuid(actorUuid);
    const progress = sessionProgress(actor);
    const current = { downtime: DowntimeService.get(actor), passiveDowntime: progress.passiveDowntime ?? {} };
    if (values.signature !== JSON.stringify(current)) throw new Error(uiText("TOVF.Interface.DowntimeHasChangedRefreshTheView_f84973", "Downtime wurde inzwischen geändert. Ansicht aktualisieren."));
    const downtime = finiteNumber(values.downtime, "Downtime");
    let passive;
    try { passive = JSON.parse(values.passiveDowntime); } catch { throw new Error(uiText("TOVF.Interface.InvalidPassiveDowntime_1978c5", "Ungültige passive Downtime.")); }
    if (!passive || typeof passive !== "object" || Array.isArray(passive)) throw new Error(uiText("TOVF.Interface.InvalidPassiveDowntime_1978c5", "Ungültige passive Downtime."));
    for (const value of Object.values(passive)) finiteNumber(value, "Passive Downtime");
    await storeUndo({ kind: "actor", tab: "downtime", actorUuid: actor.uuid, before: { downtime: actor.getFlag(MODULE_ID, FLAGS.DOWNTIME) ?? null, sessionProgress: actor.getFlag(MODULE_ID, FLAGS.SESSION_PROGRESS) ?? null } });
    await actor.setFlag(MODULE_ID, FLAGS.DOWNTIME, downtime);
    await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, { ...progress, passiveDowntime: Object.fromEntries(Object.entries(passive).map(([key, value]) => [key, Number(value)])) });
  }

  static async updateProject(actorUuid, stateId, values) {
    requireGM();
    const actor = await actorFromUuid(actorUuid);
    const before = { projects: actor.getFlag(MODULE_ID, FLAGS.PROJECTS) ?? null };
    const projects = ProjectService.get(actor);
    const state = projects.find(entry => String(entry.id ?? "") === String(stateId ?? ""));
    if (!state) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.ProjectMissing"));
    state.progress = finiteNumber(values.progress, game.i18n.localize("DOWNTIME_MANAGER.GMTools.Progress"));
    state.requiredProgress = finiteNumber(values.requiredProgress, game.i18n.localize("DOWNTIME_MANAGER.GMTools.RequiredProgress"));
    state.intervalProgress = finiteNumber(values.intervalProgress, game.i18n.localize("DOWNTIME_MANAGER.GMTools.IntervalProgress"));
    state.active = Boolean(values.active);
    state.completed = Boolean(values.completed);
    state.pendingRoll = Boolean(values.pendingRoll);
    state.awaitingCompletionCheck = Boolean(values.awaitingCompletionCheck);
    if (state.completed) {
      state.active = false;
      state.pendingRoll = false;
      state.awaitingCompletionCheck = false;
    }
    await storeUndo({ kind: "actor", tab: "projects", actorUuid: actor.uuid, before });
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, projects);
    return state;
  }

  static async removeProject(actorUuid, stateId) {
    requireGM();
    const actor = await actorFromUuid(actorUuid);
    const before = { projects: actor.getFlag(MODULE_ID, FLAGS.PROJECTS) ?? null };
    const projects = ProjectService.get(actor);
    const filtered = projects.filter(entry => String(entry.id ?? "") !== String(stateId ?? ""));
    if (filtered.length === projects.length) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.ProjectMissing"));
    await storeUndo({ kind: "actor", tab: "projects", actorUuid: actor.uuid, before });
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, filtered);
  }

  static activeSession() {
    requireGM();
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {});
  }

  static async unlockSession() {
    requireGM();
    const before = this.activeSession();
    await storeUndo({ kind: "setting", setting: SETTINGS.ACTIVE_SESSION, before });
    await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, { ...before, status: "draft", lockId: null });
  }

  static async resetSession() {
    requireGM();
    const before = this.activeSession();
    await storeUndo({ kind: "setting", setting: SETTINGS.ACTIVE_SESSION, before });
    await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, {});
  }

  static async diagnostics() {
    requireGM();
    const problems = [];
    for (const actor of playerCharacters()) {
      const rawDowntime = actor.getFlag(MODULE_ID, FLAGS.DOWNTIME);
      if (rawDowntime != null && (!Number.isFinite(Number(rawDowntime)) || Number(rawDowntime) < 0)) {
        problems.push({ actorUuid: actor.uuid, actorName: actor.name, type: "downtime", label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Diagnostics.InvalidDowntime") });
      }
      const progress = actor.getFlag(MODULE_ID, FLAGS.SESSION_PROGRESS);
      if (progress != null && (typeof progress !== "object" || Array.isArray(progress))) {
        problems.push({ actorUuid: actor.uuid, actorName: actor.name, type: "progress", label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Diagnostics.InvalidProgress") });
      }
      for (const project of ProjectService.get(actor)) {
        const projectUuid = project.projectUuid ?? project.recipeUuid;
        const station = project.stationUuid ? await fromUuid(project.stationUuid).catch(() => null) : null;
        const item = projectUuid ? await fromUuid(projectUuid).catch(() => null) : null;
        if (!station) problems.push({ actorUuid: actor.uuid, actorName: actor.name, stateId: project.id, type: "station", label: game.i18n.format("DOWNTIME_MANAGER.GMTools.Diagnostics.MissingStation", { project: project.projectName ?? projectUuid ?? "?" }) });
        if (!item) problems.push({ actorUuid: actor.uuid, actorName: actor.name, stateId: project.id, type: "project", label: game.i18n.format("DOWNTIME_MANAGER.GMTools.Diagnostics.MissingProject", { project: project.projectName ?? projectUuid ?? "?" }) });
      }
    }
    const active = this.activeSession();
    if (active.status === "awarding") problems.push({ type: "session", label: game.i18n.localize("DOWNTIME_MANAGER.GMTools.Diagnostics.LockedSession") });
    return problems;
  }

  static async repairSafeProblems() {
    requireGM();
    const snapshots = [];
    const actorRepairs = [];
    for (const actor of playerCharacters()) {
      const changes = {};
      const repair = {};
      const rawDowntime = actor.getFlag(MODULE_ID, FLAGS.DOWNTIME);
      if (rawDowntime != null && (!Number.isFinite(Number(rawDowntime)) || Number(rawDowntime) < 0)) {
        changes.downtime = rawDowntime;
        repair.downtime = 0;
      }
      const progress = actor.getFlag(MODULE_ID, FLAGS.SESSION_PROGRESS);
      if (progress != null && (typeof progress !== "object" || Array.isArray(progress))) {
        changes.sessionProgress = progress;
        repair.sessionProgress = foundry.utils.deepClone(DEFAULT_SESSION_PROGRESS);
      }
      if (Object.keys(changes).length) {
        snapshots.push({ actorUuid: actor.uuid, before: changes });
        actorRepairs.push({ actor, repair });
      }
    }
    const active = this.activeSession();
    const settingBefore = active.status === "awarding" ? active : null;
    const repaired = actorRepairs.reduce((count, entry) => count + Object.keys(entry.repair).length, 0) + (settingBefore ? 1 : 0);
    if (!repaired) return 0;
    await storeUndo({ kind: "batch", actors: snapshots, settingBefore });
    for (const { actor, repair } of actorRepairs) {
      if ("downtime" in repair) await actor.setFlag(MODULE_ID, FLAGS.DOWNTIME, repair.downtime);
      if ("sessionProgress" in repair) await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, repair.sessionProgress);
    }
    if (settingBefore) await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, { ...active, status: "draft", lockId: null });
    return repaired;
  }

  static undoData() {
    requireGM();
    return foundry.utils.deepClone(game.settings.get(MODULE_ID, SETTINGS.GM_TOOL_UNDO) ?? {});
  }

  static async undo() {
    requireGM();
    const snapshot = this.undoData();
    if (!snapshot.kind) return false;
    if (snapshot.kind === "actor") {
      const actor = await actorFromUuid(snapshot.actorUuid);
      if ("downtime" in snapshot.before) {
        if (snapshot.before.downtime == null) await actor.unsetFlag(MODULE_ID, FLAGS.DOWNTIME);
        else await actor.setFlag(MODULE_ID, FLAGS.DOWNTIME, snapshot.before.downtime);
      }
      if ("sessionProgress" in snapshot.before) {
        if (snapshot.before.sessionProgress == null) await actor.unsetFlag(MODULE_ID, FLAGS.SESSION_PROGRESS);
        else await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, snapshot.before.sessionProgress);
      }
      if ("active" in snapshot.before) {
        if (snapshot.before.active == null) await actor.unsetFlag(MODULE_ID, FLAGS.ACTIVE);
        else await actor.setFlag(MODULE_ID, FLAGS.ACTIVE, snapshot.before.active);
      }
      if ("projects" in snapshot.before) {
        if (snapshot.before.projects == null) await actor.unsetFlag(MODULE_ID, FLAGS.PROJECTS);
        else await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, snapshot.before.projects);
      }
    } else if (snapshot.kind === "setting") {
      await game.settings.set(MODULE_ID, snapshot.setting, snapshot.before ?? {});
    } else if (snapshot.kind === "batch") {
      for (const entry of snapshot.actors ?? []) {
        const actor = await actorFromUuid(entry.actorUuid);
        if ("downtime" in entry.before) await actor.setFlag(MODULE_ID, FLAGS.DOWNTIME, entry.before.downtime);
        if ("sessionProgress" in entry.before) await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, entry.before.sessionProgress);
        if ("active" in entry.before) {
          if (entry.before.active == null) await actor.unsetFlag(MODULE_ID, FLAGS.ACTIVE);
          else await actor.setFlag(MODULE_ID, FLAGS.ACTIVE, entry.before.active);
        }
      }
      if (snapshot.settingBefore) await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, snapshot.settingBefore);
    } else if (snapshot.kind === "flags") {
      for (const entry of snapshot.documents ?? []) {
        const document = await flagDocument(entry.uuid);
        await restoreFlags(document, entry.before ?? {});
      }
    } else if (snapshot.kind === "effects") {
      for (const entry of snapshot.actors ?? []) {
        const actor = await actorFromUuid(entry.actorUuid);
        const missing = (entry.effects ?? []).filter(effect => !actor.effects.has(effect._id));
        if (missing.length) await actor.createEmbeddedDocuments("ActiveEffect", missing, { keepId: true });
      }
    }
    await game.settings.set(MODULE_ID, SETTINGS.GM_TOOL_UNDO, {});
    return true;
  }
}
