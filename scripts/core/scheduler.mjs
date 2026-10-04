import { MODULE_ID } from "./constants.mjs";

const tasks = new Map();
let timer = null;
let activated = false;

export function responsibleGM() {
  return game.users.filter(user => user.active && user.isGM)
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

export function isResponsibleGM() {
  return game.user.isGM && responsibleGM()?.id === game.user.id;
}

export function registerScheduledTask({ id, intervalMs, run, immediate = true }) {
  if (!id || typeof run !== "function") throw new TypeError("A scheduled task requires an id and run callback.");
  if (tasks.has(id)) return false;
  tasks.set(id, {
    id,
    intervalMs: Math.max(1000, Number(intervalMs) || 60000),
    run,
    immediate,
    running: false,
    nextCheckAt: 0,
    lastStartedAt: 0,
    lastFinishedAt: 0,
    lastError: null
  });
  if (activated) scheduleNext(0);
  return true;
}

async function executeTask(task, now) {
  if (task.running || task.nextCheckAt > now) return;
  task.running = true;
  task.lastStartedAt = now;
  // Keep the cadence independent from task duration and failed executions.
  task.nextCheckAt = now + task.intervalMs;
  try {
    await task.run(now);
    task.lastError = null;
  } catch (error) {
    task.lastError = { name: String(error?.name ?? "Error"), message: String(error?.message ?? error) };
    console.error(`${MODULE_ID} | Scheduled task "${task.id}" failed.`, error);
  } finally {
    task.running = false;
    task.lastFinishedAt = Date.now();
  }
}

function scheduleNext(delay = null) {
  if (!activated) return;
  clearTimeout(timer);
  const now = Date.now();
  const wait = delay ?? (isResponsibleGM()
    ? Math.max(0, Math.min(...[...tasks.values()].map(task => task.nextCheckAt - now)))
    : 30000);
  timer = setTimeout(() => void tick(), Math.max(0, Math.min(wait, 2147483647)));
}

async function tick() {
  if (!isResponsibleGM()) {
    scheduleNext();
    return;
  }
  const now = Date.now();
  await Promise.all([...tasks.values()].map(task => executeTask(task, now)));
  scheduleNext();
}

export function activateScheduler() {
  if (activated || !game.user.isGM) return;
  activated = true;
  const now = Date.now();
  for (const task of tasks.values()) task.nextCheckAt = task.immediate ? 0 : now + task.intervalMs;
  game.socket.on("userActivity", () => scheduleNext(0));
  scheduleNext(0);
}

export function schedulerReport() {
  return {
    active: activated,
    responsibleGM: responsibleGM()?.id ?? null,
    tasks: [...tasks.values()].map(task => ({
      id: task.id,
      intervalMs: task.intervalMs,
      running: task.running,
      nextCheckAt: task.nextCheckAt,
      lastStartedAt: task.lastStartedAt,
      lastFinishedAt: task.lastFinishedAt,
      lastError: task.lastError
    }))
  };
}

export const schedulerApi = Object.freeze({ report: schedulerReport });
