import { MODULE_ID } from "./core/constants.mjs";

const SETTING = "tokenDistanceDisplay";
const TRIGGER = Object.freeze({
  HOVER: 1,
  TARGET: 2,
  ALT: 4
});
const GEOMETRY_FLAGS = Object.freeze(["refreshPosition", "refreshElevation", "refreshSize"]);
const TOKEN_GEOMETRY_FIELDS = Object.freeze(["x", "y", "elevation", "width", "height"]);

let activated = false;
let activeDisplay = null;
let altActive = false;

function settingEnabled() {
  return game.settings.get(MODULE_ID, SETTING);
}

function canvasTokens() {
  return canvas.tokens?.placeables ?? [];
}

function baseTokenId(token) {
  return token?.sourceId?.replace(/\.preview$/, "") ?? token?.id ?? null;
}

function isSameToken(left, right) {
  const leftId = baseTokenId(left);
  return !!leftId && leftId === baseTokenId(right);
}

function baseSourceToken() {
  const controlled = (canvas.tokens?.controlled ?? []).filter(token => !token.isPreview && !token.destroyed);
  if (controlled.length === 1) return controlled[0];
  if (controlled.length > 1) return null;

  const characterId = game.user.character?.id;
  if (!characterId) return null;
  const characterTokens = canvasTokens().filter(token => (
    !token.isPreview
    && !token.destroyed
    && (token.document?.actorId === characterId || token.actor?.id === characterId)
  ));
  return characterTokens.length === 1 ? characterTokens[0] : null;
}

function sourceToken() {
  const base = baseSourceToken();
  if (!base?.isDragged) return base;
  const preview = canvas.tokens?.preview?.children?.find(token => (
    token.isPreview && !token.destroyed && isSameToken(token, base)
  ));
  return preview ?? base;
}

function isPerceptible(token) {
  if (!token || token.destroyed || token.isPreview || !token.isVisible || token.renderable === false) return false;
  const center = token.toGlobal(new PIXI.Point(token.w / 2, token.h / 2));
  return canvas.app.screen.contains(center.x, center.y);
}

function tokenSignature(token) {
  const document = token.document;
  return [
    baseTokenId(token),
    document?.x,
    document?.y,
    document?.elevation,
    document?.width,
    document?.height,
    token.x,
    token.y,
    token.w,
    token.h
  ].join(":");
}

function centerPoint(token, elevation) {
  return {
    x: token.center.x,
    y: token.center.y,
    elevation
  };
}

function occupiedCenters(token) {
  const elevation = Number(token.document?.elevation ?? 0);
  const fallback = centerPoint(token, elevation);
  if (canvas.grid.isGridless) return [fallback];

  const offsets = token.document?.getOccupiedGridSpaceOffsets?.() ?? [];
  if (!offsets.length) return [fallback];
  return offsets.map(offset => {
    const center = canvas.grid.getCenterPoint(offset);
    return { x: center.x, y: center.y, elevation };
  });
}

function measureTokenDistance(source, target) {
  const sourcePoints = occupiedCenters(source);
  const targetPoints = occupiedCenters(target);
  let shortest = Number.POSITIVE_INFINITY;

  for (const origin of sourcePoints) {
    for (const destination of targetPoints) {
      const distance = canvas.grid.measurePath([origin, destination]).distance;
      if (!Number.isFinite(distance)) continue;
      shortest = Math.min(shortest, distance);
      if (shortest === 0) return 0;
    }
  }
  return Number.isFinite(shortest) ? shortest : null;
}

function formatDistance(distance) {
  const rounded = Math.round(distance * 100) / 100;
  const formatted = new Intl.NumberFormat(game.i18n.lang, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  }).format(rounded);
  return game.i18n.format("TOVF.TokenDistance.Label", {
    distance: formatted,
    units: canvas.grid.units ?? canvas.scene?.grid?.units ?? ""
  }).trim();
}

function createLabel() {
  const { PreciseText } = foundry.canvas.containers;
  const label = new PreciseText("", {
    ...CONFIG.canvasTextStyle,
    align: "center",
    fill: 0xFFFFFF,
    fontSize: 24,
    fontWeight: "600",
    lineJoin: "round",
    padding: 8,
    stroke: 0x000000,
    strokeThickness: 4
  });
  label.anchor.set(0.5, 1);
  label.eventMode = "none";
  label.resolution = 4;
  label.visible = false;
  return label;
}

class TokenDistanceDisplay {
  constructor({ showAll = false } = {}) {
    this.enabled = false;
    this.showAll = showAll;
    this.root = null;
    this.records = new Map();
    this.measurements = new Map();
    this.pendingAll = false;
    this.pendingTokens = new Set();
    this.animationFrame = null;
    this.setEnabled(settingEnabled());
  }

  setEnabled(enabled) {
    enabled = !!enabled;
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.clear();
      return;
    }
    this.createRoot();
    this.reconcile();
  }

  createRoot() {
    if (this.root || !canvas.ready || !canvas.interface) return;
    const root = new PIXI.Container();
    root.eventMode = "none";
    root.interactiveChildren = false;
    root.sortableChildren = true;
    root.zIndex = CONFIG.Canvas.groups.interface.zIndexScrollingText ?? 0;
    canvas.interface.addChild(root);
    this.root = root;
  }

  clear() {
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.pendingAll = false;
    this.pendingTokens.clear();
    this.measurements.clear();
    this.records.clear();
    if (this.root && !this.root.destroyed) this.root.destroy({ children: true });
    this.root = null;
  }

  destroy() {
    this.enabled = false;
    this.clear();
  }

  reconcile() {
    if (!this.enabled) return;
    this.createRoot();
    const tokens = canvasTokens();
    const tokenIds = new Set(tokens.map(token => token.id));
    for (const tokenId of this.records.keys()) {
      if (!tokenIds.has(tokenId)) this.deleteToken(tokenId);
    }

    for (const token of tokens) {
      let triggers = 0;
      if (token.hover) triggers |= TRIGGER.HOVER;
      if (token.isTargeted) triggers |= TRIGGER.TARGET;
      if (this.showAll) triggers |= TRIGGER.ALT;
      if (triggers || this.records.has(token.id)) this.recordFor(token).triggers = triggers;
    }
    this.refreshAll();
  }

  recordFor(token) {
    let record = this.records.get(token.id);
    if (!record) {
      record = { token, triggers: 0, label: null };
      this.records.set(token.id, record);
    } else record.token = token;
    return record;
  }

  setTrigger(token, trigger, active) {
    if (!this.enabled || token.isPreview) return;
    const record = this.recordFor(token);
    record.triggers = active ? record.triggers | trigger : record.triggers & ~trigger;
    this.refreshRecord(record);
  }

  setAlt(active) {
    this.showAll = !!active;
    if (!this.enabled) return;
    for (const token of canvasTokens()) {
      const record = active ? this.recordFor(token) : this.records.get(token.id);
      if (!record) continue;
      record.triggers = active ? record.triggers | TRIGGER.ALT : record.triggers & ~TRIGGER.ALT;
    }
    this.refreshAll();
  }

  sourceChanged() {
    if (!this.enabled) return;
    this.measurements.clear();
    if (this.showAll) this.setAlt(true);
    else this.refreshAll();
  }

  tokenDrawn(token) {
    if (!this.enabled || token.isPreview) return;
    let triggers = 0;
    if (token.hover) triggers |= TRIGGER.HOVER;
    if (token.isTargeted) triggers |= TRIGGER.TARGET;
    if (this.showAll) triggers |= TRIGGER.ALT;
    if (!triggers) return;
    const record = this.recordFor(token);
    record.triggers = triggers;
    this.refreshRecord(record);
  }

  tokenRefreshed(token, flags = {}) {
    if (!this.enabled || !GEOMETRY_FLAGS.some(flag => flags[flag])) return;
    const source = sourceToken();
    if (source && isSameToken(source, token)) this.scheduleRefresh();
    else if (token.isPreview) return;
    else if (this.records.get(token.id)?.triggers) this.scheduleRefresh(token);
  }

  tokenDocumentUpdated(document, changes) {
    if (!this.enabled || document.parent?.id !== canvas.scene?.id) return;
    if (!TOKEN_GEOMETRY_FIELDS.some(field => Object.hasOwn(changes, field))) return;
    const token = document.object;
    if (!token) return;
    const source = sourceToken();
    if (source && isSameToken(source, token)) this.scheduleRefresh();
    else if (this.records.get(token.id)?.triggers) this.scheduleRefresh(token);
  }

  scheduleRefresh(token = null) {
    if (!this.enabled) return;
    if (token) this.pendingTokens.add(token.id);
    else this.pendingAll = true;
    if (this.animationFrame !== null) return;
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      if (!this.enabled) return;
      if (this.pendingAll) this.refreshAll();
      else {
        for (const tokenId of this.pendingTokens) {
          const record = this.records.get(tokenId);
          if (record) this.refreshRecord(record);
        }
      }
      this.pendingAll = false;
      this.pendingTokens.clear();
    });
  }

  sceneUpdated() {
    if (!this.enabled) return;
    this.measurements.clear();
    this.scheduleRefresh();
  }

  visibilityChanged() {
    if (this.enabled) this.scheduleRefresh();
  }

  refreshAll() {
    if (!this.enabled) return;
    for (const record of this.records.values()) this.refreshRecord(record);
  }

  measurement(source, target) {
    const key = `${baseTokenId(source)}|${baseTokenId(target)}`;
    const signature = `${tokenSignature(source)}|${tokenSignature(target)}`;
    const cached = this.measurements.get(key);
    if (cached?.signature === signature) return cached.distance;
    const distance = measureTokenDistance(source, target);
    if (distance !== null) this.measurements.set(key, { signature, distance });
    return distance;
  }

  refreshRecord(record) {
    if (!record.triggers || !this.root) {
      if (record.label) record.label.visible = false;
      return;
    }

    const source = sourceToken();
    const target = record.token;
    if (!source || isSameToken(source, target) || !isPerceptible(target)) {
      if (record.label) record.label.visible = false;
      return;
    }

    const distance = this.measurement(source, target);
    if (distance === null) {
      if (record.label) record.label.visible = false;
      return;
    }

    if (!record.label) {
      record.label = createLabel();
      this.root.addChild(record.label);
    }
    const label = record.label;
    const text = formatDistance(distance);
    if (label.text !== text) label.text = text;
    const uiScale = Number(canvas.dimensions?.uiScale ?? 1) || 1;
    label.position.set(target.x + target.w / 2, target.y - (24 * uiScale));
    label.scale.set(uiScale);
    label.zIndex = target.document?.sort ?? 0;
    label.visible = true;
  }

  deleteToken(tokenOrId) {
    const tokenId = typeof tokenOrId === "string" ? tokenOrId : tokenOrId?.id;
    if (!tokenId) return;
    const record = this.records.get(tokenId);
    if (record?.label && !record.label.destroyed) record.label.destroy();
    this.records.delete(tokenId);
    this.measurements.clear();
    this.scheduleRefresh();
  }
}

function createDisplay() {
  activeDisplay?.destroy();
  activeDisplay = canvas.ready ? new TokenDistanceDisplay({ showAll: altActive }) : null;
}

function destroyDisplay() {
  activeDisplay?.destroy();
  activeDisplay = null;
  altActive = false;
}

export function registerTokenDistanceDisplay() {
  game.settings.register(MODULE_ID, SETTING, {
    name: "TOVF.TokenDistance.Setting.Name",
    hint: "TOVF.TokenDistance.Setting.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    restricted: true,
    onChange: value => activeDisplay?.setEnabled(value)
  });
}

export function activateTokenDistanceDisplay() {
  if (activated) return;
  activated = true;

  Hooks.on("canvasReady", createDisplay);
  Hooks.on("canvasTearDown", destroyDisplay);
  Hooks.on("hoverToken", (token, hovered) => activeDisplay?.setTrigger(token, TRIGGER.HOVER, hovered));
  Hooks.on("targetToken", (user, token, targeted) => {
    if (user.id === game.user.id) activeDisplay?.setTrigger(token, TRIGGER.TARGET, targeted);
  });
  Hooks.on("highlightObjects", active => {
    altActive = !!active;
    activeDisplay?.setAlt(altActive);
  });
  Hooks.on("controlToken", () => activeDisplay?.sourceChanged());
  Hooks.on("drawToken", token => activeDisplay?.tokenDrawn(token));
  Hooks.on("refreshToken", (token, flags) => activeDisplay?.tokenRefreshed(token, flags));
  Hooks.on("updateToken", (document, changes) => activeDisplay?.tokenDocumentUpdated(document, changes));
  Hooks.on("deleteToken", document => activeDisplay?.deleteToken(document.id));
  Hooks.on("destroyToken", token => {
    if (token.isPreview) activeDisplay?.sourceChanged();
    else activeDisplay?.deleteToken(token.id);
  });
  Hooks.on("visibilityRefresh", () => activeDisplay?.visibilityChanged());
  Hooks.on("canvasPan", () => activeDisplay?.visibilityChanged());
  Hooks.on("updateScene", scene => {
    if (scene.id === canvas.scene?.id) activeDisplay?.sceneUpdated();
  });
  Hooks.on("updateUser", user => {
    if (user.id === game.user.id) activeDisplay?.sourceChanged();
  });

  if (canvas.ready) createDisplay();
}
