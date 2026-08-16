import {
  DEFAULT_SESSION_PROGRESS,
  FLAGS,
  MODULE_ID,
  SETTINGS
} from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { ProjectService } from "./project-service.mjs";
import { playerCharacters, sessionProgress } from "./session-service.mjs";
import { round } from "./utils.mjs";

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
      sessionProgress: actor.getFlag(MODULE_ID, FLAGS.SESSION_PROGRESS) ?? null
    };
    const downtime = finiteNumber(values.downtime, game.i18n.localize("DOWNTIME_MANAGER.GMTools.Downtime"));
    const milestones = finiteNumber(values.milestones, game.i18n.localize("DOWNTIME_MANAGER.GMTools.Milestones"), { integer: true });
    const sessionsPlayed = finiteNumber(values.sessionsPlayed, game.i18n.localize("DOWNTIME_MANAGER.GMTools.SessionsPlayed"), { integer: true });
    let passiveDowntime;
    try {
      passiveDowntime = JSON.parse(String(values.passiveDowntime ?? "{}"));
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
      sessionsPlayed,
      lastMilestoneWeek: String(values.lastMilestoneWeek ?? "").trim() || null,
      passiveDowntime
    };
    await storeUndo({ kind: "actor", actorUuid: actor.uuid, before });
    await actor.setFlag(MODULE_ID, FLAGS.DOWNTIME, downtime);
    await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, progress);
    return { actor, downtime, progress };
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
    await storeUndo({ kind: "actor", actorUuid: actor.uuid, before });
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
    await storeUndo({ kind: "actor", actorUuid: actor.uuid, before });
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
      }
      if (snapshot.settingBefore) await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, snapshot.settingBefore);
    } else if (snapshot.kind === "flags") {
      for (const entry of snapshot.documents ?? []) {
        const document = await flagDocument(entry.uuid);
        await restoreFlags(document, entry.before ?? {});
      }
    }
    await game.settings.set(MODULE_ID, SETTINGS.GM_TOOL_UNDO, {});
    return true;
  }
}
