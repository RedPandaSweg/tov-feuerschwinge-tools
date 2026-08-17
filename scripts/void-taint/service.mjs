import { MODULE_ID } from "../core/constants.mjs";
import { FLESH_WARPS, INDEFINITE_DREADS, VOID_TAINT_FLAG, VOID_TAINT_SETTINGS } from "./constants.mjs";

const TABLE_FLAG = "voidTaintStandardTable";

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function tableResults(entries) {
  return entries.map((entry, index) => ({
    type: CONST.TABLE_RESULT_TYPES?.TEXT ?? 0,
    text: Array.isArray(entry) ? `<strong>${entry[0]}.</strong> ${entry[1]}` : entry,
    weight: 1,
    range: [index + 1, index + 1],
    drawn: false
  }));
}

async function createStandardTable(kind) {
  const dread = kind === "dread";
  return RollTable.create({
    name: game.i18n.localize(dread ? "TOVF.VoidTaint.Tables.Dread" : "TOVF.VoidTaint.Tables.FleshWarp"),
    formula: "1d10",
    replacement: true,
    displayRoll: true,
    flags: { [MODULE_ID]: { [TABLE_FLAG]: kind } },
    results: tableResults(dread ? INDEFINITE_DREADS : FLESH_WARPS)
  });
}

async function resolveConfiguredTable(setting) {
  const uuid = game.settings.get(MODULE_ID, setting);
  const table = uuid ? await fromUuid(uuid).catch(() => null) : null;
  return table?.documentName === "RollTable" ? table : null;
}

export function voidTaintValue(actor) {
  return integer(actor?.getFlag(MODULE_ID, VOID_TAINT_FLAG), 0);
}

export function voidTaintEnabled() {
  return Boolean(game.settings.get(MODULE_ID, VOID_TAINT_SETTINGS.ENABLED));
}

export function voidTaintThreshold(actor) {
  const proficiency = Number(actor?.system?.attributes?.proficiency) || 0;
  const charisma = Number(actor?.system?.abilities?.charisma?.mod) || 0;
  const minimum = integer(game.settings.get(MODULE_ID, VOID_TAINT_SETTINGS.MINIMUM_THRESHOLD), 2);
  return Math.max(minimum, proficiency + charisma);
}

export async function setVoidTaint(actor, value) {
  if (!actor || actor.documentName !== "Actor") throw new Error(game.i18n.localize("TOVF.VoidTaint.Errors.Actor"));
  value = integer(value);
  await actor.setFlag(MODULE_ID, VOID_TAINT_FLAG, value);
  return value;
}

export async function drawVoidTaintEffect(kind) {
  const setting = kind === "fleshWarp" ? VOID_TAINT_SETTINGS.FLESH_WARP_TABLE : VOID_TAINT_SETTINGS.DREAD_TABLE;
  const table = await resolveConfiguredTable(setting);
  if (!table) throw new Error(game.i18n.localize("TOVF.VoidTaint.Errors.Table"));
  await table.draw({ displayChat: true });
  return table;
}

export async function addVoidTaint(actor, amount, { chooseEffect } = {}) {
  const value = voidTaintValue(actor) + integer(amount);
  const threshold = voidTaintThreshold(actor);
  if (value <= threshold) return { value: await setVoidTaint(actor, value), threshold, triggered: false };
  const kind = await chooseEffect?.({ actor, value, threshold });
  if (!kind) return { value: await setVoidTaint(actor, value), threshold, triggered: true, pending: true };
  await drawVoidTaintEffect(kind);
  await setVoidTaint(actor, 0);
  return { value: 0, threshold, triggered: true, kind };
}

export async function ensureVoidTaintTables({ recreate = false } = {}) {
  if (!game.user?.isGM) return {};
  const definitions = [
    ["dread", VOID_TAINT_SETTINGS.DREAD_TABLE],
    ["fleshWarp", VOID_TAINT_SETTINGS.FLESH_WARP_TABLE]
  ];
  const tables = {};
  for (const [kind, setting] of definitions) {
    let table = recreate ? null : await resolveConfiguredTable(setting);
    if (!table && !recreate) table = game.tables.find(candidate => candidate.getFlag(MODULE_ID, TABLE_FLAG) === kind);
    if (!table) table = await createStandardTable(kind);
    await game.settings.set(MODULE_ID, setting, table.uuid);
    tables[kind] = table;
  }
  return tables;
}

export async function voidTaintTableOptions() {
  const selected = {
    dread: game.settings.get(MODULE_ID, VOID_TAINT_SETTINGS.DREAD_TABLE),
    fleshWarp: game.settings.get(MODULE_ID, VOID_TAINT_SETTINGS.FLESH_WARP_TABLE)
  };
  const tables = [...game.tables].sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
  return {
    dread: tables.map(table => ({ uuid: table.uuid, name: table.name, selected: table.uuid === selected.dread })),
    fleshWarp: tables.map(table => ({ uuid: table.uuid, name: table.name, selected: table.uuid === selected.fleshWarp }))
  };
}
