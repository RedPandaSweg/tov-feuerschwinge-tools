import { MODULE_ID } from "./core/constants.mjs";
import { uiText } from "./core/localization.mjs";
import { isOperationalGM } from "./core/permissions.mjs";

// A deliberately small document-flag relationship: riders remain normal Tokens.
const SCOPE = "mounting";
const FLAG = "mounting";
const PASTE_FLAG = "mountingPaste";
let active = false;
const pending = new Map();
const pasteBatches = new Map();
const positioning = new Set();
const t = (key, fallback) => uiText(`TOVF.Mounting.${key}`, fallback);
const state = token => token?.getFlag(MODULE_ID, FLAG) ?? {};
const gm = () => game.users.find(u => u.active && u.isGM && u.viewedScene) ?? game.users.find(u => u.active && u.isGM);
const token = (sceneId, id) => game.scenes.get(sceneId)?.tokens.get(id) ?? null;
const riders = carrier => (state(carrier).riderIds ?? []).map(id => carrier.parent.tokens.get(id)).filter(r => state(r).carrierId === carrier.id);
const carrier = rider => {
  const mount = state(rider).carrierId ? rider.parent.tokens.get(state(rider).carrierId) : null;
  return mount && (state(mount).riderIds ?? []).includes(rider.id) ? mount : null;
};
const isAttached = entry => Boolean(carrier(entry) || riders(entry).length);
const canUse = (entry, user = game.user) => isOperationalGM(user) || entry?.actor?.testUserPermission?.(user, "OWNER") === true || entry?.isOwner === true;

function distance(a, b) { const s = a.parent?.grid?.size ?? 100, ax2 = a.x + a.width * s, ay2 = a.y + a.height * s, bx2 = b.x + b.width * s, by2 = b.y + b.height * s, dx = Math.max(b.x - ax2, a.x - bx2, 0), dy = Math.max(b.y - ay2, a.y - by2, 0); return Math.hypot(dx, dy) / s; }
function controllingRider(mount) { const attached = riders(mount).filter(entry => state(entry).kind === "rider"); return attached.find(entry => entry.id === state(mount).controllerId) ?? attached[0] ?? null; }
function hasControllingRider(mount) { return Boolean(controllingRider(mount)); }
function ownsToken(entry, user = game.user) { return entry?.actor?.testUserPermission?.(user, "OWNER") === true || entry?.isOwner === true; }
function isPlayerCharacter(entry) { return entry?.actor?.hasPlayerOwner === true; }
function compareCandidates(rider, left, right) { const ownership = Number(ownsToken(right)) - Number(ownsToken(left)); if (ownership) return ownership; const range = distance(rider, left) - distance(rider, right); if (Math.abs(range) > 0.001) return range; const riderPc = isPlayerCharacter(rider), affinity = Number(riderPc !== isPlayerCharacter(right)) - Number(riderPc !== isPlayerCharacter(left)); if (affinity) return affinity; const riderArea = rider.width * rider.height, leftArea = left.width * left.height, rightArea = right.width * right.height, leftFits = leftArea > riderArea, rightFits = rightArea > riderArea; if (leftFits !== rightFits) return rightFits ? 1 : -1; if (leftArea !== rightArea) return rightArea - leftArea; return left.name.localeCompare(right.name, game.i18n.lang) || left.id.localeCompare(right.id); }
function possible(rider, kind) { return (rider.parent.tokens.contents ?? []).filter(entry => entry.id !== rider.id && !carrier(entry) && distance(rider, entry) <= 1.5 && (kind !== "rider" || !hasControllingRider(entry))).sort((left, right) => compareCandidates(rider, left, right)); }
function offset(carrier, index, count) { const s = carrier.parent?.grid?.size ?? 100, r = Math.max(s * .18, Math.min(carrier.width, carrier.height) * s * .23), a = count === 1 ? -Math.PI / 2 : -Math.PI / 2 + index * 2 * Math.PI / count; return { x: Math.cos(a) * r, y: Math.sin(a) * r, elevation: 0 }; }
function position(carrier, rider, local, change = {}) { const s = carrier.parent?.grid?.size ?? 100, has = key => Object.hasOwn(change, key), carrierX = has("x") ? change.x : carrier.x, carrierY = has("y") ? change.y : carrier.y, rotation = has("rotation") ? change.rotation : carrier.rotation, elevation = has("elevation") ? change.elevation : carrier.elevation, a = Number(rotation ?? 0) * Math.PI / 180, x = local.x * Math.cos(a) - local.y * Math.sin(a), y = local.x * Math.sin(a) + local.y * Math.cos(a); return { x: carrierX + carrier.width * s / 2 + x - rider.width * s / 2, y: carrierY + carrier.height * s / 2 + y - rider.height * s / 2, rotation, elevation: Number(elevation ?? 0) + Number(local.elevation ?? 0) }; }
function relativeOffset(mount, rider, change) { const s = mount.parent?.grid?.size ?? 100, riderX = Object.hasOwn(change, "x") ? change.x : rider.x, riderY = Object.hasOwn(change, "y") ? change.y : rider.y, riderElevation = Object.hasOwn(change, "elevation") ? change.elevation : rider.elevation, dx = riderX + rider.width * s / 2 - mount.x - mount.width * s / 2, dy = riderY + rider.height * s / 2 - mount.y - mount.height * s / 2, a = Number(mount.rotation ?? 0) * Math.PI / 180; return { x: dx * Math.cos(a) + dy * Math.sin(a), y: -dx * Math.sin(a) + dy * Math.cos(a), elevation: Number(riderElevation ?? 0) - Number(mount.elevation ?? 0) }; }
const positioningKey = rider => `${rider.parent.id}.${rider.id}`;
const mountSyncOptions = (extra = {}) => ({ tovfMountSync: true, constrainOptions: { ignoreWalls: true }, ...extra });
function validate(rider, mount, kind) { if (!rider || !mount || rider.parent !== mount.parent || rider.id === mount.id || isAttached(rider) || carrier(mount)) throw new Error(t("Errors.Invalid", "Diese Reitverbindung ist nicht möglich.")); if (kind === "rider" && hasControllingRider(mount)) throw new Error(t("Errors.RiderOccupied", "Dieses Reittier hat bereits einen Reiter. Weitere Tokens können nur als Passagiere einsteigen.")); }
async function attach(rider, mount, kind = "rider") { validate(rider, mount, kind); const existing = riders(mount), local = offset(mount, existing.length, existing.length + 1), riderIds = [...existing.map(r => r.id), rider.id], controllerId = controllingRider(mount)?.id ?? (kind === "rider" ? rider.id : null); await rider.update({ [`flags.${MODULE_ID}.${FLAG}`]: { carrierId: mount.id, kind, offset: local } }); await mount.update({ [`flags.${MODULE_ID}.${FLAG}`]: { riderIds, controllerId } }); await rider.update(position(mount, rider, local), mountSyncOptions()); }
async function detach(rider) { const mount = carrier(rider); if (!mount) throw new Error(t("Errors.None", "Dieses Token sitzt auf keinem Reittier.")); const rest = riders(mount).filter(r => r.id !== rider.id), currentController = controllingRider(mount)?.id ?? null, nextController = rest.find(entry => state(entry).kind === "rider")?.id ?? null, s = mount.parent?.grid?.size ?? 100; await rider.update({ [`flags.${MODULE_ID}.${FLAG}`]: null, x: mount.x + mount.width * s / 2 + s - rider.width * s / 2, y: mount.y + mount.height * s / 2 - rider.height * s / 2, elevation: mount.elevation }, { tovfMountSync: true }); await mount.update({ [`flags.${MODULE_ID}.${FLAG}`]: { riderIds: rest.map(r => r.id), controllerId: currentController === rider.id ? nextController : currentController } }); }
async function execute(action, data, userId) { const rider = token(data.sceneId, data.riderId), user = game.users.get(userId); if (!rider || (!isOperationalGM(user) && !canUse(rider, user))) throw new Error(t("Errors.Permission", "Dafür fehlt die Berechtigung.")); if (action === "attach") { const mount = token(data.sceneId, data.mountId); if (!mount) throw new Error(t("Errors.Missing", "Das Reittier existiert nicht mehr.")); return attach(rider, mount, data.kind); } if (action === "detach") return detach(rider); const mount = carrier(rider); if (!mount) throw new Error(t("Errors.None", "Dieses Token sitzt auf keinem Reittier.")); if (state(rider).kind !== "rider" || controllingRider(mount)?.id !== rider.id) throw new Error(t("Errors.Controller", "Nur der steuernde Reiter kann das Reittier bewegen.")); if (action === "move") { const targetX = Number(data.x), targetY = Number(data.y), targetElevation = Number(data.elevation); if (![targetX, targetY, targetElevation].every(Number.isFinite)) throw new Error(t("Errors.Position", "Ungültige Zielposition.")); return mount.move({ x: mount.x + targetX - rider.x, y: mount.y + targetY - rider.y, elevation: Number(mount.elevation ?? 0) + targetElevation - Number(rider.elevation ?? 0), action: mount.movementAction, snapped: false, explicit: true, checkpoint: true }, { showRuler: true }); } if (action === "movePath") { if (data.mountId !== mount.id || !Array.isArray(data.movement?.waypoints) || !data.movement.waypoints.length || data.movement.waypoints.length > 100) throw new Error(t("Errors.Position", "Ungültiger Bewegungspfad.")); const waypoints = data.movement.waypoints.map(waypoint => { const x = Number(waypoint.x), y = Number(waypoint.y), elevation = Number(waypoint.elevation); if (![x, y, elevation].every(Number.isFinite)) throw new Error(t("Errors.Position", "Ungültiger Bewegungspfad.")); return { x, y, elevation, action: waypoint.action in CONFIG.Token.movement.actions ? waypoint.action : mount.movementAction, snapped: waypoint.snapped === true, explicit: waypoint.explicit !== false, checkpoint: waypoint.checkpoint !== false }; }); return mount.move(waypoints, { method: "dragging", showRuler: true }); } throw new Error(t("Errors.Invalid", "Diese Reitaktion ist nicht möglich.")); }
function canExecuteDirectly(action, data, user = game.user) { if (isOperationalGM(user)) return true; const rider = token(data.sceneId, data.riderId); if (!ownsToken(rider, user)) return false; const mount = action === "attach" ? token(data.sceneId, data.mountId) : carrier(rider); if (!ownsToken(mount, user)) return false; return !["move", "movePath"].includes(action) || riders(mount).every(entry => ownsToken(entry, user)); }
function request(action, data) { if (canExecuteDirectly(action, data)) return execute(action, data, game.user.id); const target = gm(); if (!target) return Promise.reject(new Error(t("Errors.GM", "Eine Spielleitung muss verbunden sein."))); const requestId = foundry.utils.randomID(); return new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(t("Errors.Timeout", "Die Spielleitung hat nicht geantwortet."))); }, 12000); pending.set(requestId, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); game.socket.emit(`module.${MODULE_ID}`, { scope: SCOPE, type: "request", requestId, targetGMId: target.id, action, data, userId: game.user.id }); }); }
async function choose(rider, kind) { const options = possible(rider, kind); if (!options.length) throw new Error(t("Errors.NoMount", "Kein passendes Reittier in Reichweite gefunden.")); let mountId = options[0].id; if (options.length > 1) mountId = await foundry.applications.api.DialogV2.prompt({ window: { title: t("Choose.Title", "Reittier wählen") }, content: `<form><select name="mountId">${options.map(entry => `<option value="${entry.id}">${foundry.utils.escapeHTML(entry.name)}</option>`).join("")}</select></form>`, ok: { label: kind === "passenger" ? t("HUD.Passenger", "Als Passagier einsteigen") : t("HUD.Mount", "Aufsitzen"), callback: (_event, button) => new FormDataExtended(button.form).object.mountId } }); if (mountId) return request("attach", { sceneId: rider.parent.id, riderId: rider.id, mountId, kind }); }
async function beginPositioning(rider) { positioning.add(positioningKey(rider)); ui.notifications.info(t("Position.Hint", "Verschiebe den Reiter jetzt frei an die gewünschte Position.")); }

function preparePastedMounting(objects, data, { cut = false } = {}) {
  if (cut || !Array.isArray(objects) || !Array.isArray(data)) return;
  const selected = objects.map((object, index) => ({ document: object.document, data: data[index] }))
    .filter(entry => entry.data && (state(entry.document).carrierId || state(entry.document).riderIds?.length));
  if (!selected.length) return;
  const batchId = foundry.utils.randomID();
  const flagPath = `flags.${MODULE_ID}.${FLAG}`;
  const pastePath = `flags.${MODULE_ID}.${PASTE_FLAG}`;
  for (const { document: source, data: target } of selected) {
    foundry.utils.deleteProperty(target, flagPath);
    foundry.utils.setProperty(target, pastePath, {
      batchId,
      expected: selected.length,
      userId: game.user.id,
      sourceId: source.id,
      relationship: foundry.utils.deepClone(state(source))
    });
  }
}

async function reconcilePastedMounting(batchId) {
  const batch = pasteBatches.get(batchId);
  if (!batch || batch.finalizing) return;
  batch.finalizing = true;
  pasteBatches.delete(batchId);
  if (batch.timer) clearTimeout(batch.timer);
  const entries = [...batch.tokens.values()];
  const scene = entries[0]?.token.parent;
  if (!scene) return;
  const flagPath = `flags.${MODULE_ID}.${FLAG}`;
  const pastePath = `flags.${MODULE_ID}.${PASTE_FLAG}`;
  const updates = entries.map(({ token: pasted, marker }) => {
    const relationship = marker.relationship ?? {};
    let next = null;
    const pastedMount = relationship.carrierId ? batch.tokens.get(relationship.carrierId) : null;
    if (pastedMount && (pastedMount.marker.relationship?.riderIds ?? []).includes(marker.sourceId)) {
      next = { ...relationship, carrierId: pastedMount.token.id };
    } else {
      const pastedRiders = (relationship.riderIds ?? [])
        .map(id => batch.tokens.get(id))
        .filter(entry => entry?.marker.relationship?.carrierId === marker.sourceId);
      if (pastedRiders.length) {
        const controller = pastedRiders.find(entry => entry.marker.sourceId === relationship.controllerId
          && entry.marker.relationship?.kind === "rider")
          ?? pastedRiders.find(entry => entry.marker.relationship?.kind === "rider")
          ?? null;
        next = {
          riderIds: pastedRiders.map(entry => entry.token.id),
          controllerId: controller?.token.id ?? null
        };
      }
    }
    return { _id: pasted.id, [flagPath]: next, [pastePath]: null };
  });
  await scene.updateEmbeddedDocuments("Token", updates);
}

function collectPastedMounting(token, _options, userId) {
  const marker = token.getFlag(MODULE_ID, PASTE_FLAG);
  if (!marker?.batchId || marker.userId !== game.user.id || userId !== game.user.id) return;
  let batch = pasteBatches.get(marker.batchId);
  if (!batch) {
    batch = { expected: Number(marker.expected) || 1, tokens: new Map(), timer: null, finalizing: false };
    pasteBatches.set(marker.batchId, batch);
  }
  batch.tokens.set(marker.sourceId, { token, marker });
  if (batch.timer) clearTimeout(batch.timer);
  const delay = batch.tokens.size >= batch.expected ? 0 : 1000;
  batch.timer = setTimeout(() => {
    void reconcilePastedMounting(marker.batchId).catch(error => console.warn(`${MODULE_ID} | Could not restore pasted mount relationships.`, error));
  }, delay);
}

export function registerMounting() {
  Hooks.on("pasteToken", preparePastedMounting);
  Hooks.on("createToken", collectPastedMounting);
  Hooks.on(`${MODULE_ID}.tokenHudMenu`, (rider, addAction) => {
    if (!rider || !canUse(rider)) return;
    if (carrier(rider)) {
      addAction({ icon: "fa-arrows-up-down-left-right", label: t("Position.Title", "Reitposition ändern"), callback: () => beginPositioning(rider) });
      addAction({ icon: "fa-person-walking-arrow-right", label: t("HUD.Dismount", "Absitzen"), callback: () => request("detach", { sceneId: rider.parent.id, riderId: rider.id }) });
    } else {
      addAction({ icon: "fa-horse", label: t("HUD.Mount", "Aufsitzen"), callback: () => choose(rider, "rider") });
      addAction({ icon: "fa-person-circle-plus", label: t("HUD.Passenger", "Als Passagier einsteigen"), callback: () => choose(rider, "passenger") });
    }
  });
}
export function activateMounting() {
  if (active) return;
  active = true;
  Hooks.on(`${MODULE_ID}.mountedDragDrop`, data => {
    void request("movePath", data).catch(error => ui.notifications.error(error.message));
  });
  Hooks.on("preUpdateToken", (rider, change, options) => {
    const mount = carrier(rider);
    const changed = field => Object.hasOwn(change, field) && change[field] !== rider._source[field];
    const positionChanged = ["x", "y", "elevation"].some(changed);
    const placementChanged = positionChanged || changed("rotation");
    if (options?.tovfMountSync || !mount || !placementChanged) return;
    const key = positioningKey(rider);
    if (positioning.delete(key)) {
      const local = relativeOffset(mount, rider, change);
      const placement = {
        x: Object.hasOwn(change, "x") ? change.x : rider.x,
        y: Object.hasOwn(change, "y") ? change.y : rider.y,
        elevation: Object.hasOwn(change, "elevation") ? change.elevation : rider.elevation,
        rotation: mount.rotation,
        [`flags.${MODULE_ID}.${FLAG}.offset`]: local
      };
      queueMicrotask(() => {
        void rider.update(placement, mountSyncOptions({ animate: false }))
          .then(() => ui.notifications.info(t("Position.Saved", "Reitposition gespeichert.")))
          .catch(error => ui.notifications.error(error.message));
      });
      return false;
    }
    if (!positionChanged) return false;
    const data = {
      sceneId: rider.parent.id,
      riderId: rider.id,
      x: Object.hasOwn(change, "x") ? change.x : rider.x,
      y: Object.hasOwn(change, "y") ? change.y : rider.y,
      elevation: Object.hasOwn(change, "elevation") ? change.elevation : rider.elevation
    };
    queueMicrotask(() => {
      void request("move", data).catch(error => ui.notifications.error(error.message));
    });
    return false;
  });
  Hooks.on("updateToken", (mount, change, options, userId) => {
    if (options?.tovfMountSync || (gm()?.id ?? userId) !== game.user.id || !["x", "y", "rotation", "elevation"].some(key => Object.hasOwn(change, key))) return;
    for (const rider of riders(mount)) {
      rider.update(position(mount, rider, state(rider).offset ?? { x: 0, y: 0 }, change), mountSyncOptions())
        .catch(error => console.warn(`${MODULE_ID} | Mounted-token synchronization failed.`, error));
    }
  });
  Hooks.on("deleteToken", mount => {
    positioning.delete(positioningKey(mount));
    for (const rider of riders(mount)) rider.update({ [`flags.${MODULE_ID}.${FLAG}`]: null }).catch(() => {});
    const parent = carrier(mount);
    if (parent) {
      const remaining = riders(parent).filter(rider => rider.id !== mount.id);
      const currentController = state(parent).controllerId;
      const nextController = remaining.find(rider => state(rider).kind === "rider")?.id ?? null;
      parent.update({
        [`flags.${MODULE_ID}.${FLAG}`]: {
          riderIds: remaining.map(rider => rider.id),
          controllerId: currentController === mount.id ? nextController : currentController
        }
      }).catch(() => {});
    }
  });
  game.socket.on(`module.${MODULE_ID}`, message => {
    if (message?.scope !== SCOPE) return;
    if (message.type === "response" && message.targetUserId === game.user.id) {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      return message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
    }
    if (message.type !== "request" || !isOperationalGM() || message.targetGMId !== game.user.id || gm()?.id !== game.user.id) return;
    execute(message.action, message.data, message.userId)
      .then(result => game.socket.emit(`module.${MODULE_ID}`, { scope: SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, result }))
      .catch(error => game.socket.emit(`module.${MODULE_ID}`, { scope: SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, error: error.message }));
  });
}
export const mountingApi = Object.freeze({ attach, detach, riders, carrier, isPositioning: rider => positioning.has(positioningKey(rider)) });
