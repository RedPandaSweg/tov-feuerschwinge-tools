import { MODULE_ID } from "./constants.mjs";

const statuses = new Map();
const notifiedFailures = new Set();
let failureNotificationRegistered = false;

function serializeError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error ?? "Unknown error")
  };
}

export function notifyStartupFailures() {
  const failed = [...statuses.values()].filter(entry => (
    entry.status === "failed" && !notifiedFailures.has(entry.id)
  ));
  if (!failed.length) return;
  for (const entry of failed) notifiedFailures.add(entry.id);
  ui.notifications.error(game.i18n.format("TOVF.Startup.InstallFailed", {
    features: failed.map(entry => entry.id).join(", ")
  }), { permanent: true });
}

function notifyFailuresOnReady() {
  if (failureNotificationRegistered) return;
  failureNotificationRegistered = true;
  Hooks.once("ready", notifyStartupFailures);
}

function recordFailure(id, startedAt, error) {
  statuses.set(id, {
    id,
    status: "failed",
    durationMs: Date.now() - startedAt,
    error: serializeError(error)
  });
  console.error(`${MODULE_ID} | Startup step "${id}" failed.`, error);
  notifyFailuresOnReady();
}

/** Load a feature module without allowing a link or evaluation failure to abort the bootstrap. */
export async function loadStartupModule(id, path) {
  const startedAt = Date.now();
  try {
    const loaded = await import(path);
    statuses.set(`load:${id}`, { id: `load:${id}`, status: "completed", durationMs: Date.now() - startedAt });
    return loaded;
  } catch (error) {
    recordFailure(`load:${id}`, startedAt, error);
    return null;
  }
}

/** Run a synchronous registration step without allowing it to block later features. */
export function runStartupStep(id, register) {
  if (statuses.get(id)?.status === "completed") return true;
  const startedAt = Date.now();
  try {
    register();
    statuses.set(id, { id, status: "completed", durationMs: Date.now() - startedAt });
    return true;
  } catch (error) {
    recordFailure(id, startedAt, error);
    return false;
  }
}

/** Run an ordered set of independent synchronous lifecycle steps. */
export function runStartupSteps(steps) {
  const results = new Map();
  for (const [id, callback] of steps) results.set(id, runStartupStep(id, callback));
  return results;
}

/** Run and await an asynchronous activation step without blocking later features on failure. */
export async function runStartupStepAsync(id, activate) {
  if (statuses.get(id)?.status === "completed") return true;
  const startedAt = Date.now();
  try {
    await activate();
    statuses.set(id, { id, status: "completed", durationMs: Date.now() - startedAt });
    return true;
  } catch (error) {
    recordFailure(id, startedAt, error);
    return false;
  }
}

/** Run ordered asynchronous lifecycle steps while isolating each failure. */
export async function runStartupStepsAsync(steps) {
  const results = new Map();
  for (const [id, callback] of steps) results.set(id, await runStartupStepAsync(id, callback));
  return results;
}

export function startupReport() {
  return [...statuses.values()].map(entry => foundry.utils.deepClone(entry));
}

export const startupApi = Object.freeze({ report: startupReport });
