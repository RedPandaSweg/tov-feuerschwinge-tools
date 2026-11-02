import { MODULE_ID } from "./core/constants.mjs";
import { emitModuleEvent, subscribeModuleEvent } from "./core/events.mjs?v=3.7.8-module-events-1";
import { isProjectAdministrator, requireProjectAdministrator } from "./core/permissions.mjs";
import { registerScheduledTask } from "./core/scheduler.mjs?v=3.11.5-task-authority-1";

const FLAG = "patrol";
const FLAG_PATH = `flags.${MODULE_ID}.${FLAG}`;
const EVENT = "tokenPatrolChanged";
const TASK_ID = `${MODULE_ID}.token-patrol`;
const MAX_WAYPOINTS = 100;
const DEFAULT_PATROL = Object.freeze({
  version: 1,
  enabled: false,
  mode: "random",
  regionId: "",
  waypoints: [],
  routeMode: "loop",
  snapToGrid: true,
  speed: 2,
  pauseMinMs: 2000,
  pauseMaxMs: 5000,
  autoRotate: true,
  suspendInCombat: true
});

const activeMovements = new Map();
let activeApp = null;
let routeCapture = null;
let activated = false;

function t(key, fallback, data = {}) {
  const path = `TOVF.Patrol.${key}`;
  return game.i18n.format(game.i18n.has(path) ? path : fallback, data);
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanWaypoint(waypoint) {
  return {
    x: finite(waypoint?.x, 0),
    y: finite(waypoint?.y, 0),
    elevation: finite(waypoint?.elevation, 0)
  };
}

function cleanPatrol(value = {}) {
  const pauseMinMs = Math.clamp(finite(value.pauseMinMs, DEFAULT_PATROL.pauseMinMs), 0, 3600000);
  const pauseMaxMs = Math.clamp(finite(value.pauseMaxMs, DEFAULT_PATROL.pauseMaxMs), 0, 3600000);
  return {
    version: 1,
    enabled: value.enabled === true,
    mode: value.mode === "route" ? "route" : "random",
    regionId: String(value.regionId ?? ""),
    waypoints: Array.isArray(value.waypoints)
      ? value.waypoints.slice(0, MAX_WAYPOINTS).map(cleanWaypoint)
      : [],
    routeMode: ["loop", "pingPong", "random"].includes(value.routeMode) ? value.routeMode : "loop",
    snapToGrid: value.snapToGrid !== false,
    speed: Math.clamp(finite(value.speed, DEFAULT_PATROL.speed), 0.1, 20),
    pauseMinMs: Math.min(pauseMinMs, pauseMaxMs),
    pauseMaxMs: Math.max(pauseMinMs, pauseMaxMs),
    autoRotate: value.autoRotate !== false,
    suspendInCombat: value.suspendInCombat !== false
  };
}

function patrolOf(token) {
  const value = token?.getFlag?.(MODULE_ID, FLAG);
  return value ? cleanPatrol(value) : null;
}

function patrolSignature(config) {
  return JSON.stringify({
    mode: config.mode,
    regionId: config.regionId,
    waypoints: config.waypoints,
    routeMode: config.routeMode,
    speed: config.speed,
    autoRotate: config.autoRotate
  });
}

function responsibleProjectAdministrator() {
  return game.users.filter(user => user.active && isProjectAdministrator(user))
    .sort((left, right) => left.id.localeCompare(right.id))[0] ?? null;
}

function isResponsibleProjectAdministrator() {
  return isProjectAdministrator() && responsibleProjectAdministrator()?.id === game.user.id;
}

function configuredTokens(scene = canvas.scene) {
  return scene?.tokens.filter(token => patrolOf(token)) ?? [];
}

function isServiceBot(user) {
  return /\[bot\]/i.test(String(user?.name ?? "")) || user?.getFlag?.(MODULE_ID, "serviceBot") === true;
}

function userOccupiedScenes() {
  const sceneIds = new Set(game.users
    .filter(user => user.active && !isServiceBot(user) && user.viewedScene)
    .map(user => user.viewedScene));
  return [...sceneIds].map(sceneId => game.scenes.get(sceneId)).filter(Boolean);
}

function stopTokenMovement(token) {
  if (!token) return;
  try {
    token.stopMovement();
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not stop patrol movement for ${token.uuid}.`, error);
  }
  activeMovements.delete(token.uuid);
}

function stopSceneMovements(scene = canvas.scene, tokenIds = null) {
  if (!scene) return;
  const ids = tokenIds ? new Set(tokenIds.map(String)) : null;
  for (const token of scene.tokens) {
    if (ids ? ids.has(token.id) : activeMovements.has(token.uuid)) stopTokenMovement(token);
  }
}

function stopAllMovements() {
  for (const state of [...activeMovements.values()]) stopTokenMovement(state.token);
}

function randomPause(config) {
  return config.pauseMinMs + (Math.random() * (config.pauseMaxMs - config.pauseMinMs));
}

function distanceSquared(left, right) {
  const dx = finite(left?.x, 0) - finite(right?.x, 0);
  const dy = finite(left?.y, 0) - finite(right?.y, 0);
  return (dx * dx) + (dy * dy);
}

function initialRouteState(token, config) {
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  config.waypoints.forEach((waypoint, index) => {
    const distance = distanceSquared(token, waypoint);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  const arrived = nearestDistance <= 4;
  const routeIndex = arrived && config.waypoints.length > 1
    ? (nearestIndex + 1) % config.waypoints.length
    : nearestIndex;
  return { routeIndex, direction: 1 };
}

function advanceRouteState(state, config) {
  const last = config.waypoints.length - 1;
  if (config.routeMode === "random") {
    if (last <= 0) return;
    let next = state.routeIndex;
    while (next === state.routeIndex) next = Math.floor(Math.random() * config.waypoints.length);
    state.routeIndex = next;
    return;
  }
  if (config.routeMode === "pingPong") {
    if (state.routeIndex >= last) state.direction = -1;
    else if (state.routeIndex <= 0) state.direction = 1;
    state.routeIndex += state.direction;
    return;
  }
  state.routeIndex = (state.routeIndex + 1) % config.waypoints.length;
}

function randomRegionDestination(token, region) {
  const bounds = region?.bounds;
  if (!bounds) return null;
  const size = token.getSize();
  const minX = bounds.x;
  const minY = bounds.y;
  const maxX = bounds.x + bounds.width - size.width;
  const maxY = bounds.y + bounds.height - size.height;
  if (maxX < minX || maxY < minY) return null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const candidate = {
      x: minX + (Math.random() * (maxX - minX)),
      y: minY + (Math.random() * (maxY - minY)),
      elevation: finite(token.elevation, 0)
    };
    if (token.testInsideRegion(region, candidate) && distanceSquared(token, candidate) > 16) return candidate;
  }
  return null;
}

function destinationFor(token, config, state) {
  if (config.mode === "route") return config.waypoints[state.routeIndex] ?? null;
  const region = token.parent?.regions?.get(config.regionId);
  return randomRegionDestination(token, region);
}

function tokenIsInActiveCombat(token) {
  return token.combatant?.parent?.started === true;
}

function canPatrol(token, config) {
  if (!config.enabled || game.paused) return false;
  if (config.suspendInCombat && tokenIsInActiveCombat(token)) return false;
  if (token.getFlag(MODULE_ID, "mounting")?.carrierId) return false;
  if (config.mode === "route") return config.waypoints.length >= 2;
  return Boolean(token.parent?.regions?.get(config.regionId));
}

function beginPatrolMovement(token, config, now) {
  const signature = patrolSignature(config);
  let state = activeMovements.get(token.uuid);
  if (!state || state.signature !== signature) {
    state = {
      token,
      signature,
      moving: false,
      nextAt: now,
      ...initialRouteState(token, config)
    };
    activeMovements.set(token.uuid, state);
  }
  state.token = token;
  if (state.moving || state.nextAt > now) return;
  const destination = destinationFor(token, config, state);
  if (!destination) {
    state.nextAt = now + Math.max(2000, randomPause(config));
    return;
  }
  state.moving = true;
  void token.move({
    ...destination,
    action: token.movementAction,
    snapped: config.mode === "route" && config.snapToGrid,
    explicit: true,
    checkpoint: true
  }, {
    method: "api",
    showRuler: false,
    pan: false,
    autoRotate: config.autoRotate,
    animation: { movementSpeed: config.speed }
  }).then(completed => {
    if (completed && config.mode === "route") advanceRouteState(state, config);
    state.nextAt = Date.now() + randomPause(config);
  }).catch(error => {
    state.nextAt = Date.now() + Math.max(2000, randomPause(config));
    console.warn(`${MODULE_ID} | Patrol movement for ${token.uuid} failed.`, error);
  }).finally(() => {
    state.moving = false;
  });
}

async function patrolTick(now) {
  const present = new Set();
  if (!game.paused) {
    for (const scene of userOccupiedScenes()) {
      for (const token of configuredTokens(scene)) {
        const config = patrolOf(token);
        if (!config?.enabled) continue;
        present.add(token.uuid);
        if (canPatrol(token, config)) beginPatrolMovement(token, config, now);
      }
    }
  }
  for (const [uuid, state] of [...activeMovements.entries()]) {
    if (!present.has(uuid)) stopTokenMovement(state.token);
  }
}

async function updatePatrols(scene, tokenIds, transform) {
  requireProjectAdministrator(undefined, t("Errors.Admin", "Only a full Game Master may manage patrols."));
  const ids = new Set(tokenIds.map(String));
  const updates = [];
  for (const token of scene.tokens) {
    if (!ids.has(token.id)) continue;
    const current = patrolOf(token);
    const next = transform(current, token);
    if (next === undefined) continue;
    updates.push(next === null
      ? { _id: token.id, [`flags.${MODULE_ID}.-=${FLAG}`]: null }
      : { _id: token.id, [FLAG_PATH]: cleanPatrol(next) });
  }
  if (!updates.length) return 0;
  await scene.updateEmbeddedDocuments("Token", updates);
  emitModuleEvent(EVENT, { sceneId: scene.id, tokenIds: updates.map(update => update._id) });
  return updates.length;
}

function sceneRegions(scene) {
  return (scene?.regions ?? []).map(region => ({ id: region.id, name: region.name }))
    .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
}

function pointFromPointer(event, snapToGrid) {
  const screen = new PIXI.Point();
  canvas.app.renderer.events.mapPositionToPoint(screen, event.clientX, event.clientY);
  const point = canvas.stage.worldTransform.applyInverse(screen);
  if (!snapToGrid || canvas.grid.isGridless) return { x: Math.round(point.x), y: Math.round(point.y) };
  const offset = canvas.grid.getOffset(point);
  const snapped = canvas.grid.getTopLeftPoint(offset);
  return { x: Math.round(snapped.x), y: Math.round(snapped.y) };
}

function canvasViewElement() {
  const candidates = [
    canvas.app?.renderer?.canvas,
    canvas.app?.canvas,
    canvas.app?.view,
    canvas.app?.renderer?.view,
    document.getElementById("board")
  ];
  return candidates.find(candidate => typeof candidate?.addEventListener === "function") ?? null;
}

function drawCapturedRoute(capture) {
  const graphics = capture.graphics;
  graphics.clear();
  if (!capture.points.length) return;
  graphics.lineStyle({ width: 4, color: 0xFF6A00, alpha: 0.9 });
  graphics.moveTo(capture.points[0].x, capture.points[0].y);
  for (const point of capture.points.slice(1)) graphics.lineTo(point.x, point.y);
  for (const point of capture.points) {
    graphics.beginFill(0xFFB000, 1).lineStyle({ width: 2, color: 0x301000, alpha: 1 })
      .drawCircle(point.x, point.y, 8).endFill();
  }
}

function endRouteCapture({ save, restoreWindow = true }) {
  const capture = routeCapture;
  if (!capture) return;
  routeCapture = null;
  capture.view?.removeEventListener?.("pointerdown", capture.onPointer, true);
  window.removeEventListener("keydown", capture.onKey, true);
  if (!capture.graphics.destroyed) {
    capture.graphics.parent?.removeChild(capture.graphics);
    capture.graphics.destroy();
  }
  if (capture.app.window?.title) capture.app.window.title.textContent = capture.originalTitle;
  void (async () => {
    if (restoreWindow && !capture.wasMinimized) await capture.app.maximize();
    if (save && capture.points.length) {
      capture.app.draft.waypoints = capture.points;
      capture.app.draft.mode = "route";
      await capture.app.refreshPreservingState();
      ui.notifications.info(t("Route.Recorded", "Route with {count} waypoints recorded.", { count: capture.points.length }));
    } else {
      ui.notifications.info(t("Route.Cancelled", "Route recording cancelled."));
    }
  })();
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class PatrolToolsApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-patrol-tools",
    tag: "form",
    classes: ["tovf-patrol-tools"],
    position: { width: 880, height: 760 },
    window: { title: "TOVF.Patrol.Title", icon: "fa-solid fa-route", resizable: true },
    actions: {
      useControlled: this.#useControlled,
      selectActive: this.#selectActive,
      clearSelection: this.#clearSelection,
      edit: this.#edit,
      recordRoute: this.#recordRoute,
      clearRoute: this.#clearRoute,
      applyPaused: this.#applyPaused,
      applyAndStart: this.#applyAndStart,
      stopSelected: this.#stopSelected,
      stopAll: this.#stopAll,
      removeSelected: this.#removeSelected
    }
  };

  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/token-patrol.hbs` } };

  constructor(scene = canvas.scene, options = {}) {
    super(options);
    requireProjectAdministrator(undefined, t("Errors.Admin", "Only a full Game Master may manage patrols."));
    this.scene = scene;
    this.selectedIds = new Set((canvas.tokens?.controlled ?? []).map(token => token.id));
    this.editingTokenId = null;
    this.draft = cleanPatrol(DEFAULT_PATROL);
    if (this.selectedIds.size === 1) this.loadTokenDraft([...this.selectedIds][0]);
  }

  loadTokenDraft(tokenId) {
    const token = this.scene?.tokens.get(tokenId);
    const config = patrolOf(token);
    if (!config) return false;
    this.draft = config;
    this.editingTokenId = token.id;
    return true;
  }

  readDraft() {
    const root = this.element;
    if (!root) return this.draft;
    this.draft = cleanPatrol({
      ...this.draft,
      mode: root.querySelector('[name="mode"]')?.value,
      regionId: root.querySelector('[name="regionId"]')?.value,
      routeMode: root.querySelector('[name="routeMode"]')?.value,
      snapToGrid: root.querySelector('[name="snapToGrid"]')?.checked,
      speed: root.querySelector('[name="speed"]')?.value,
      pauseMinMs: finite(root.querySelector('[name="pauseMin"]')?.value, 2) * 1000,
      pauseMaxMs: finite(root.querySelector('[name="pauseMax"]')?.value, 5) * 1000,
      autoRotate: root.querySelector('[name="autoRotate"]')?.checked,
      suspendInCombat: root.querySelector('[name="suspendInCombat"]')?.checked
    });
    return this.draft;
  }

  validateDraft() {
    const config = this.readDraft();
    if (!this.selectedIds.size) throw new Error(t("Errors.Selection", "Select at least one token."));
    if (config.mode === "random" && !this.scene.regions.get(config.regionId)) {
      throw new Error(t("Errors.Region", "Select an existing Region."));
    }
    if (config.mode === "route" && config.waypoints.length < 2) {
      throw new Error(t("Errors.Route", "Record at least two route waypoints."));
    }
    return config;
  }

  async refreshPreservingState() {
    const list = this.element?.querySelector(".tovf-patrol-token-list");
    const scrollTop = list?.scrollTop ?? 0;
    await this.render({ force: true });
    const refreshed = this.element?.querySelector(".tovf-patrol-token-list");
    if (refreshed) refreshed.scrollTop = scrollTop;
  }

  externalRefresh(sceneId) {
    if (sceneId !== this.scene?.id) return;
    this.readDraft();
    void this.refreshPreservingState();
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const tokens = this.scene?.tokens.map(token => {
      const patrol = patrolOf(token);
      const mode = patrol?.mode === "route"
        ? t("Modes.Route", "Route")
        : t("Modes.Random", "Random Region");
      return {
        id: token.id,
        name: token.name,
        image: token.texture.src,
        selected: this.selectedIds.has(token.id),
        configured: Boolean(patrol),
        enabled: patrol?.enabled === true,
        mode,
        status: patrol?.enabled ? t("Status.Active", "Active") : patrol ? t("Status.Paused", "Paused") : t("Status.None", "Not configured")
      };
    }) ?? [];
    const draft = cleanPatrol(this.draft);
    const editingToken = this.scene?.tokens.get(this.editingTokenId);
    return {
      ...context,
      tokens,
      regions: sceneRegions(this.scene).map(region => ({ ...region, selected: region.id === draft.regionId })),
      selectedCount: this.selectedIds.size,
      editingTokenName: editingToken?.name ?? null,
      draft: {
        ...draft,
        pauseMin: draft.pauseMinMs / 1000,
        pauseMax: draft.pauseMaxMs / 1000,
        randomMode: draft.mode === "random",
        routeModeSelected: draft.mode === "route",
        loopSelected: draft.routeMode === "loop",
        pingPongSelected: draft.routeMode === "pingPong",
        randomRouteSelected: draft.routeMode === "random",
        waypoints: draft.waypoints.map((waypoint, index) => ({ ...waypoint, number: index + 1 }))
      }
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const checkbox of this.element.querySelectorAll("[data-token-select]")) {
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) this.selectedIds.add(checkbox.dataset.tokenSelect);
        else this.selectedIds.delete(checkbox.dataset.tokenSelect);
        const count = this.element.querySelector("[data-selection-count]");
        if (count) count.textContent = String(this.selectedIds.size);
      });
    }
    const mode = this.element.querySelector('[name="mode"]');
    mode?.addEventListener("change", () => {
      const random = mode.value === "random";
      this.element.querySelector("[data-random-region]")?.toggleAttribute("hidden", !random);
      this.element.querySelector("[data-route-behavior]")?.toggleAttribute("hidden", random);
      this.element.querySelector("[data-route-options]")?.toggleAttribute("hidden", random);
    });
  }

  async close(options = {}) {
    if (routeCapture?.app === this) endRouteCapture({ save: false, restoreWindow: false });
    if (activeApp === this) activeApp = null;
    return super.close(options);
  }

  async apply(enabled) {
    const config = { ...this.validateDraft(), enabled };
    await updatePatrols(this.scene, [...this.selectedIds], () => config);
    ui.notifications.info(t(enabled ? "AppliedStarted" : "AppliedPaused",
      enabled ? "Patrol started for {count} token(s)." : "Patrol configuration saved for {count} token(s).",
      { count: this.selectedIds.size }));
  }

  async handle(operation) {
    try {
      return await operation();
    } catch (error) {
      console.error(`${MODULE_ID} | Patrol operation failed.`, error);
      ui.notifications.error(error.message);
      return null;
    }
  }

  static async #useControlled(event) {
    event.preventDefault();
    this.readDraft();
    this.selectedIds = new Set((canvas.tokens?.controlled ?? []).map(token => token.id));
    this.editingTokenId = null;
    if (this.selectedIds.size === 1) this.loadTokenDraft([...this.selectedIds][0]);
    await this.refreshPreservingState();
  }

  static async #selectActive(event) {
    event.preventDefault();
    this.readDraft();
    this.selectedIds = new Set(configuredTokens(this.scene).filter(token => patrolOf(token)?.enabled).map(token => token.id));
    this.editingTokenId = null;
    if (this.selectedIds.size === 1) this.loadTokenDraft([...this.selectedIds][0]);
    await this.refreshPreservingState();
  }

  static async #clearSelection(event) {
    event.preventDefault();
    this.readDraft();
    this.selectedIds.clear();
    this.editingTokenId = null;
    await this.refreshPreservingState();
  }

  static async #edit(event, target) {
    event.preventDefault();
    const tokenId = target.dataset.tokenId;
    this.selectedIds = new Set([tokenId]);
    this.loadTokenDraft(tokenId);
    await this.refreshPreservingState();
  }

  static async #recordRoute(event) {
    event.preventDefault();
    requireProjectAdministrator(undefined, t("Errors.Admin", "Only a full Game Master may manage patrols."));
    this.readDraft();
    if (!canvas.ready || canvas.scene?.id !== this.scene?.id) {
      return ui.notifications.warn(t("Errors.Scene", "Open the patrol scene before recording a route."));
    }
    if (routeCapture) endRouteCapture({ save: false });
    const view = canvasViewElement();
    if (!view) {
      return ui.notifications.error(t("Errors.Canvas", "The Foundry canvas element is unavailable."));
    }
    const graphics = (canvas.controls ?? canvas.interface).addChild(new PIXI.LegacyGraphics());
    graphics.eventMode = "none";
    graphics.zIndex = 1000;
    const baseToken = this.scene.tokens.get([...this.selectedIds][0]);
    const capture = {
      app: this,
      view,
      graphics,
      points: [],
      snapToGrid: this.draft.snapToGrid,
      elevation: finite(baseToken?.elevation, 0),
      wasMinimized: this.minimized,
      originalTitle: this.window?.title?.textContent ?? this.title,
      onPointer: null,
      onKey: null
    };
    capture.onPointer = pointerEvent => {
      if (pointerEvent.button !== 0) return;
      pointerEvent.preventDefault();
      pointerEvent.stopImmediatePropagation();
      const point = pointFromPointer(pointerEvent, capture.snapToGrid);
      capture.points.push({ ...point, elevation: capture.elevation });
      drawCapturedRoute(capture);
    };
    capture.onKey = keyEvent => {
      if (keyEvent.key !== "Enter" && keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopImmediatePropagation();
      if (keyEvent.key === "Enter" && capture.points.length < 2) {
        ui.notifications.warn(t("Errors.Route", "Record at least two route waypoints."));
        return;
      }
      endRouteCapture({ save: keyEvent.key === "Enter" });
    };
    routeCapture = capture;
    view.addEventListener("pointerdown", capture.onPointer, true);
    window.addEventListener("keydown", capture.onKey, true);
    if (this.window?.title) this.window.title.textContent = t("Route.Keys", "Enter: save · Esc: cancel");
    await this.minimize();
    if (routeCapture === capture && this.window?.title) {
      this.window.title.textContent = t("Route.Keys", "Enter: save · Esc: cancel");
    }
  }

  static async #clearRoute(event) {
    event.preventDefault();
    this.readDraft();
    this.draft.waypoints = [];
    await this.refreshPreservingState();
  }

  static async #applyPaused(event) {
    event.preventDefault();
    await this.handle(() => this.apply(false));
  }

  static async #applyAndStart(event) {
    event.preventDefault();
    await this.handle(() => this.apply(true));
  }

  static async #stopSelected(event) {
    event.preventDefault();
    await this.handle(async () => {
      if (!this.selectedIds.size) throw new Error(t("Errors.Selection", "Select at least one token."));
      const ids = [...this.selectedIds];
      const count = await updatePatrols(this.scene, ids, current => current ? { ...current, enabled: false } : undefined);
      stopSceneMovements(this.scene, ids);
      ui.notifications.info(t("Stopped", "Stopped {count} patrol(s).", { count }));
    });
  }

  static async #stopAll(event) {
    event.preventDefault();
    await this.handle(async () => {
      const ids = configuredTokens(this.scene).filter(token => patrolOf(token)?.enabled).map(token => token.id);
      const count = await updatePatrols(this.scene, ids, current => ({ ...current, enabled: false }));
      stopSceneMovements(this.scene, ids);
      ui.notifications.info(t("Stopped", "Stopped {count} patrol(s).", { count }));
    });
  }

  static async #removeSelected(event) {
    event.preventDefault();
    await this.handle(async () => {
      if (!this.selectedIds.size) throw new Error(t("Errors.Selection", "Select at least one token."));
      const ids = [...this.selectedIds];
      const count = await updatePatrols(this.scene, ids, current => current ? null : undefined);
      stopSceneMovements(this.scene, ids);
      ui.notifications.info(t("Removed", "Removed {count} patrol configuration(s).", { count }));
    });
  }
}

function openPatrolTools() {
  requireProjectAdministrator(undefined, t("Errors.Admin", "Only a full Game Master may manage patrols."));
  if (!canvas.scene) return ui.notifications.warn(t("Errors.NoScene", "Open a Scene first."));
  if (activeApp?.scene?.id !== canvas.scene.id) {
    void activeApp?.close();
    activeApp = new PatrolToolsApp(canvas.scene);
  } else activeApp ??= new PatrolToolsApp(canvas.scene);
  activeApp.render(true);
}

export function registerTokenPatrol() {
  Hooks.on("getSceneControlButtons", controls => {
    if (!isProjectAdministrator() || !controls.feuerschwinge?.tools) return;
    controls.feuerschwinge.tools.patrol = {
      name: "patrol",
      order: 3,
      title: "TOVF.Patrol.Open",
      icon: "fa-solid fa-route",
      button: true,
      onChange: openPatrolTools
    };
  });
}

export function activateTokenPatrol() {
  if (activated || !isProjectAdministrator()) return;
  activated = true;
  registerScheduledTask({
    id: TASK_ID,
    intervalMs: 1000,
    run: patrolTick,
    isResponsible: isResponsibleProjectAdministrator,
    authority: "project-administrator"
  });
  subscribeModuleEvent(EVENT, payload => {
    if (payload.stop && isResponsibleProjectAdministrator()) {
      stopSceneMovements(game.scenes.get(payload.sceneId), payload.tokenIds);
    }
    activeApp?.externalRefresh(payload.sceneId);
  });
  Hooks.on("updateToken", (token, changes) => {
    const flags = changes.flags?.[MODULE_ID];
    if (!flags || (!Object.hasOwn(flags, FLAG) && !Object.hasOwn(flags, `-=${FLAG}`))) return;
    stopTokenMovement(token);
  });
  Hooks.on("deleteToken", token => activeMovements.delete(token.uuid));
  Hooks.on("pauseGame", paused => {
    if (paused) stopAllMovements();
  });
  Hooks.on("updateCombat", combat => {
    if (!combat.started) return;
    for (const combatant of combat.combatants) {
      const token = combatant.token;
      if (patrolOf(token)?.suspendInCombat) stopTokenMovement(token);
    }
  });
  Hooks.on("createCombatant", combatant => {
    const token = combatant.token;
    if (combatant.parent?.started && patrolOf(token)?.suspendInCombat) stopTokenMovement(token);
  });
  Hooks.on("canvasTearDown", () => {
    if (routeCapture) endRouteCapture({ save: false });
  });
}

export const tokenPatrolApi = Object.freeze({ open: openPatrolTools });
