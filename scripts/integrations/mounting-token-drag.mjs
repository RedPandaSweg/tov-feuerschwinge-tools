import { MODULE_ID } from "../core/constants.mjs";

const PATCHED = Symbol.for(`${MODULE_ID}.mountedTokenDragging`);

function mountingState(document) {
  return document?.getFlag?.(MODULE_ID, "mounting") ?? {};
}

function riderCanControlMount(mount, user, controllerId) {
  if (!controllerId) return false;
  const rider = mount.parent?.tokens?.get(controllerId);
  return mountingState(rider).carrierId === mount.id
    && mountingState(rider).kind === "rider"
    && rider.actor?.testUserPermission?.(user, "OWNER") === true;
}

function positioningRider(document) {
  return game.modules.get(MODULE_ID)?.api?.mounting?.isPositioning?.(document) === true;
}

export function installMountedTokenDragging() {
  const TokenClass = CONFIG.Token?.objectClass;
  const prototype = TokenClass?.prototype;
  const required = ["_canControl", "_onDragLeftStart", "_prepareDragLeftDropUpdates", "_finalizeDragLeft"];
  if (!prototype || required.some(method => typeof prototype[method] !== "function")) {
    return { status: "incompatible", reason: "Foundry v14 Token drag methods are unavailable." };
  }
  if (prototype[PATCHED]) return { status: "already-installed" };

  const originalCanControl = prototype._canControl;
  const originalDragStart = prototype._onDragLeftStart;
  const originalPrepareDrop = prototype._prepareDragLeftDropUpdates;
  const originalFinalizeDrag = prototype._finalizeDragLeft;

  prototype._canControl = function(user, event) {
    return originalCanControl.call(this, user, event)
      || riderCanControlMount(this.document, user, this.__tovfControlProxy);
  };

  prototype._onDragLeftStart = function(event) {
    const relationship = mountingState(this.document);
    if (relationship.carrierId && relationship.kind === "rider" && !positioningRider(this.document)) {
      const mount = this.document.parent?.tokens?.get(relationship.carrierId);
      if (mount && mountingState(mount).controllerId === this.document.id && mount.object) {
        mount.object.__tovfControlProxy = this.document.id;
        try {
          if (mount.object.control({ releaseOthers: true })) {
            this.__tovfMountedDrag = { riderId: this.document.id, mountId: mount.id };
          }
        } finally {
          delete mount.object.__tovfControlProxy;
        }
      }
    }
    return originalDragStart.call(this, event);
  };

  prototype._prepareDragLeftDropUpdates = function(event) {
    const prepared = originalPrepareDrop.call(this, event);
    const redirect = this.__tovfMountedDrag;
    if (!redirect) return prepared;
    const movement = prepared?.[1]?.movement?.[redirect.mountId];
    if (movement?.waypoints?.length) {
      Hooks.callAll(`${MODULE_ID}.mountedDragDrop`, {
        sceneId: this.document.parent.id,
        riderId: redirect.riderId,
        mountId: redirect.mountId,
        movement: {
          method: "dragging",
          waypoints: movement.waypoints.map(waypoint => ({
            x: waypoint.x,
            y: waypoint.y,
            elevation: waypoint.elevation,
            action: waypoint.action,
            snapped: waypoint.snapped,
            explicit: waypoint.explicit,
            checkpoint: waypoint.checkpoint
          }))
        }
      });
    }
    return [[], {}];
  };

  prototype._finalizeDragLeft = function(event) {
    const redirect = this.__tovfMountedDrag;
    try {
      return originalFinalizeDrag.call(this, event);
    } finally {
      delete this.__tovfMountedDrag;
      if (redirect) this.control({ releaseOthers: true });
    }
  };

  Object.defineProperty(prototype, PATCHED, { value: true, configurable: false });
  return { status: "completed" };
}
