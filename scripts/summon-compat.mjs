import { MODULE_ID } from "./core/constants.mjs";

const MAX_PENDING_AGE = 30000;
const ORGANIZER_FLAG = "summonOrganizer";
let pendingSummon = null;
const folderTasks = new Map();

function folderParentId(folder) {
  return typeof folder?.folder === "string" ? folder.folder : folder?.folder?.id ?? null;
}

function summonerName(actor, user) {
  const summonerId = actor.getFlag(MODULE_ID, ORGANIZER_FLAG)?.summonerActorId;
  const summoner = summonerId ? game.actors.get(summonerId) : null;
  if (summoner?.type === "pc") return summoner.name;
  const parentId = actor.folder?.id ?? null;
  const ownerLevel = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const characters = game.actors.filter(candidate => (
    candidate.id !== actor.id
    && candidate.type === "pc"
    && !candidate.getFlag(game.system.id, "summonedCopy")
    && (candidate.folder?.id ?? null) === parentId
    && Number(candidate.ownership?.[user.id] ?? candidate.ownership?.default ?? 0) >= ownerLevel
  ));
  if (characters.length === 1) return characters[0].name;
  const folderMatch = characters.find(candidate => candidate.name === actor.folder?.name);
  return folderMatch?.name ?? user.name;
}

async function organizeSummonedActor(actor, userId) {
  const activeGM = game.users.find(user => user.active && user.isGM);
  const responsible = activeGM ? activeGM.id === game.user.id : userId === game.user.id;
  if (!responsible || actor.pack || !actor.getFlag(game.system.id, "summonedCopy")) return;
  const user = game.users.get(userId);
  if (!user) return;
  const parentId = actor.folder?.id ?? null;
  const name = `${summonerName(actor, user)} - Summons`;
  const key = `${parentId ?? "root"}\u0000${name}`;
  const previous = folderTasks.get(key) ?? Promise.resolve();
  const task = previous.then(async () => {
    let folder = game.folders.find(candidate => (
      candidate.type === "Actor"
      && candidate.name === name
      && folderParentId(candidate) === parentId
    ));
    folder ??= await foundry.documents.Folder.implementation.create({
      name,
      type: "Actor",
      folder: parentId
    });
    if (actor.folder?.id !== folder.id) await actor.update({ folder: folder.id });
    if (actor.getFlag(MODULE_ID, ORGANIZER_FLAG)) await actor.unsetFlag(MODULE_ID, ORGANIZER_FLAG);
  });
  folderTasks.set(key, task);
  try {
    await task;
  } catch (error) {
    console.error(`${MODULE_ID} | Could not organize summoned Actor`, {
      actor: actor.name,
      user: user.name,
      error
    });
  } finally {
    if (folderTasks.get(key) === task) folderTasks.delete(key);
  }
}

function sourceUuid(actor) {
  return String(actor?._stats?.compendiumSource ?? actor?._stats?.duplicateSource ?? "");
}

function currentPending() {
  if (!pendingSummon) return null;
  if (Date.now() - pendingSummon.startedAt <= MAX_PENDING_AGE) return pendingSummon;
  pendingSummon = null;
  return null;
}

function matchingSummonActor(pending) {
  const created = pending.createdActorId ? game.actors.get(pending.createdActorId) : null;
  if (created?.isOwner) return created;
  return game.actors.find(actor => (
    actor.isOwner
    && actor.getFlag(game.system.id, "summonedCopy")
    && sourceUuid(actor) === pending.sourceUuid
    && (
      actor.getFlag(game.system.id, "summon.origin") === pending.activityUuid
      || (!actor.prototypeToken.actorLink && !actor.getFlag(game.system.id, "summon.origin"))
    )
  )) ?? null;
}

function registerSummonTracking() {
  Hooks.on("blackFlag.preSummon", (activity, profile) => {
    pendingSummon = {
      activityUuid: activity?.uuid ?? "",
      sourceUuid: String(profile?.uuid ?? ""),
      summonerActorId: activity?.actor?.id ?? null,
      createdActorId: null,
      startedAt: Date.now()
    };
  });

  Hooks.on("preCreateActor", (actor, _data, _options, userId) => {
    const pending = currentPending();
    if (!pending || userId !== game.user.id || !pending.summonerActorId) return;
    if (!actor.getFlag(game.system.id, "summonedCopy")) return;
    actor.updateSource({
      [`flags.${MODULE_ID}.${ORGANIZER_FLAG}`]: {
        summonerActorId: pending.summonerActorId,
        userId
      }
    });
  });

  Hooks.on("createActor", (actor, _options, userId) => {
    if (actor.getFlag(game.system.id, "summonedCopy")) {
      void organizeSummonedActor(actor, userId);
    }
    const pending = currentPending();
    if (!pending || userId !== game.user.id || !actor.getFlag(game.system.id, "summonedCopy")) return;
    if (pending.sourceUuid && sourceUuid(actor) !== pending.sourceUuid) return;
    pending.createdActorId = actor.id;
  });
}

function patchTokenPlacement() {
  const TokenLayer = CONFIG.Canvas?.layers?.tokens?.layerClass ?? foundry.canvas?.layers?.TokenLayer;
  const prototype = TokenLayer?.prototype;
  if (!prototype || prototype._tovfSummonOwnershipPatch) return;
  const original = prototype.placeTokens;
  if (typeof original !== "function") return;

  Object.defineProperty(prototype, "_tovfSummonOwnershipPatch", { value: true });
  prototype.placeTokens = async function(data, options = {}) {
    const pending = currentPending();
    const tokens = Array.from(data, token => foundry.utils.deepClone(token));
    const needsActor = !game.user.isGM && options.create === false && tokens.some(token => (
      token.actorLink === true && !token.actorId
    ));
    if (!pending || !needsActor) return original.call(this, tokens, options);

    const actor = matchingSummonActor(pending);
    if (!actor) return original.call(this, tokens, options);
    for (const token of tokens) {
      if (token.actorLink === true && !token.actorId) token.actorId = actor.id;
    }
    console.debug(`${MODULE_ID} | Restored linked summon Actor ID`, {
      actor: actor.name,
      actorId: actor.id,
      activity: pending.activityUuid
    });
    try {
      return await original.call(this, tokens, options);
    } finally {
      pendingSummon = null;
    }
  };
}

export function activateSummonCompatibility() {
  if (game.system.id !== "black-flag") return;
  registerSummonTracking();
  patchTokenPlacement();
}
