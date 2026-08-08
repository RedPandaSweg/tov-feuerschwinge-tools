import { MODULE_ID } from "./core/constants.mjs";

const SETTING = "automaticTokenSizing";

const TOKEN_SIZES = Object.freeze({
  tiny: { footprint: 1, scale: 0.5 },
  small: { footprint: 1, scale: 0.8 },
  medium: { footprint: 1, scale: 1 },
  large: { footprint: 2, scale: 1 },
  huge: { footprint: 3, scale: 1 },
  gargantuan: { footprint: 4, scale: 1 }
});

function enabled() {
  return game.settings.get(MODULE_ID, SETTING);
}

export function tokenSizeForActor(actor) {
  return TOKEN_SIZES[actor?.system?.traits?.size] ?? null;
}

function storedArtworkScale(size, actorSize, dynamicRing) {
  if (!dynamicRing) return size.scale;
  const systemScale = CONFIG.BlackFlag?.actorSizes?.[actorSize]?.dynamicTokenScale ?? 1;
  return size.scale / systemScale;
}

function tokenUpdate(size, { prototype = false, actorSize = "", dynamicRing = false } = {}) {
  const prefix = prototype ? "prototypeToken." : "";
  const scale = storedArtworkScale(size, actorSize, dynamicRing);
  return {
    [`${prefix}width`]: size.footprint,
    [`${prefix}height`]: size.footprint,
    [`${prefix}texture.scaleX`]: scale,
    [`${prefix}texture.scaleY`]: scale
  };
}

function sizeFromChange(actor, changes) {
  const key = foundry.utils.getProperty(changes, "system.traits.size")
    ?? actor.system?.traits?.size;
  return TOKEN_SIZES[key] ?? null;
}

function prepareNewPrototypeTokenSize(actor, changes) {
  if (!enabled()) return;
  if (actor.isToken) return;
  const size = sizeFromChange(actor, changes);
  if (!size) return;
  const actorSize = foundry.utils.getProperty(changes, "system.traits.size")
    ?? actor.system?.traits?.size;
  for (const [path, value] of Object.entries(tokenUpdate(size, {
    prototype: true,
    actorSize,
    dynamicRing: actor.prototypeToken?.hasDynamicRing
  }))) {
    foundry.utils.setProperty(changes, path, value);
  }
}

function prepareChangedPrototypeTokenSize(actor, changes) {
  if (!enabled()) return;
  if (!foundry.utils.hasProperty(changes, "system.traits.size")) return;
  prepareNewPrototypeTokenSize(actor, changes);
}

function preparePlacedTokenSize(token, changes) {
  if (!enabled()) return;
  const actorId = changes.actorId ?? token.actorId;
  const baseActor = token.baseActor ?? game.actors.get(actorId);
  const actorSize = foundry.utils.getProperty(changes, "delta.system.traits.size")
    ?? token.actor?.system?.traits?.size
    ?? baseActor?.system?.traits?.size;
  const size = TOKEN_SIZES[actorSize] ?? null;
  if (!size) return;

  foundry.utils.setProperty(changes, "width", size.footprint);
  foundry.utils.setProperty(changes, "height", size.footprint);

  // Black Flag applies its own 0.8 artwork multiplier to Small dynamic-ring
  // tokens during data preparation. Keep their stored scale at 1 to avoid 0.64.
  const dynamicScale = token.hasDynamicRing
    ? CONFIG.BlackFlag?.actorSizes?.[actorSize]?.dynamicTokenScale ?? 1
    : 1;
  const storedScale = size.scale / dynamicScale;
  foundry.utils.setProperty(changes, "texture.scaleX", storedScale);
  foundry.utils.setProperty(changes, "texture.scaleY", storedScale);
}

async function synchronizePcPrototype(actor) {
  if (!enabled()) return;
  if (actor.type !== "pc" || actor.isToken) return;
  const actorSize = actor.system?.traits?.size;
  const size = TOKEN_SIZES[actorSize] ?? null;
  if (!size) return;
  const desired = tokenUpdate(size, {
    prototype: true,
    actorSize,
    dynamicRing: actor.prototypeToken.hasDynamicRing
  });
  const differs = Object.entries(desired).some(([path, value]) => {
    const sourcePath = path.replace(/^prototypeToken\./, "");
    return foundry.utils.getProperty(actor.prototypeToken._source, sourcePath) !== value;
  });
  if (differs) await actor.update(desired, { [MODULE_ID]: { tokenSizeSync: true } });
}

async function synchronizeDerivedPcSize(actor, _changes, options, userId) {
  if (userId !== game.user.id || options[MODULE_ID]?.tokenSizeSync) return;
  await synchronizePcPrototype(actor);
}

async function synchronizeExistingPcs() {
  if (!game.user.isGM) return;
  for (const actor of game.actors.filter(candidate => candidate.type === "pc")) {
    await synchronizePcPrototype(actor);
  }
}

async function updatePlacedTokenSize(actor, changes, _options, userId) {
  if (!enabled()) return;
  if (userId !== game.user.id || !actor.isToken || !actor.token) return;
  if (!foundry.utils.hasProperty(changes, "system.traits.size")) return;
  const size = sizeFromChange(actor, changes);
  if (size) await actor.token.update(tokenUpdate(size, {
    actorSize: actor.system.traits.size,
    dynamicRing: actor.token.hasDynamicRing
  }));
}

export function registerTokenSizeSync() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "TOVF.TokenSize.Setting.Name",
    hint: "TOVF.TokenSize.Setting.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    requiresReload: true,
    restricted: true
  });

  Hooks.on("preCreateActor", prepareNewPrototypeTokenSize);
  Hooks.on("preUpdateActor", prepareChangedPrototypeTokenSize);
  Hooks.on("preCreateToken", preparePlacedTokenSize);
  Hooks.on("updateActor", updatePlacedTokenSize);
  Hooks.on("updateActor", synchronizeDerivedPcSize);
  Hooks.once("ready", synchronizeExistingPcs);
}
