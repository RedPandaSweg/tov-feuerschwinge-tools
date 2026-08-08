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

export class GMToolsService {
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
    }
    await game.settings.set(MODULE_ID, SETTINGS.GM_TOOL_UNDO, {});
    return true;
  }
}
