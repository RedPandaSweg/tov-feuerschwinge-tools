import { MODULE_ID } from "./core/constants.mjs";

const LINK = "concentrationSource";
const CAST = "concentrationCast";
const localize = key => game.i18n.localize(`TOVF.Concentration.${key}`);

function actors() {
  const result = new Map(game.actors.map(actor => [actor.uuid, actor]));
  for (const scene of game.scenes) for (const token of scene.tokens) {
    if (token.actor) result.set(token.actor.uuid, token.actor);
  }
  return [...result.values()];
}

function responsible(actor) {
  const gm = game.users.find(user => user.active && user.isGM);
  if (gm) return gm.id === game.user.id;
  return game.users.find(user => user.active && actor.testUserPermission(user, "OWNER"))?.id === game.user.id;
}

export async function removeConcentrationEffects(markerUuid) {
  for (const actor of actors()) {
    if (!actor.isOwner || !responsible(actor)) continue;
    const ids = [...actor.effects].filter(effect => effect.getFlag(MODULE_ID, LINK) === markerUuid).map(effect => effect.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
  }
}

export async function linkConcentrationCast(message, marker) {
  if (message && marker) await message.setFlag(MODULE_ID, CAST, marker.uuid);
}

export function installConcentrationEffects({ enabled, waitForActor }) {
  const report = error => {
    console.error(`${MODULE_ID} | Concentration effect cleanup`, error);
    ui.notifications.error(localize("CleanupError"));
  };
  Hooks.on("deleteActiveEffect", effect => {
    if (effect.getFlag(MODULE_ID, "concentration")) return removeConcentrationEffects(effect.uuid).catch(report);
  });
  Hooks.on("updateActiveEffect", (effect, changes) => {
    if (changes.disabled === true && effect.getFlag(MODULE_ID, "concentration")) return removeConcentrationEffects(effect.uuid).catch(report);
  });
  Hooks.on("ready", () => {
    const prototype = globalThis.customElements?.get("blackflag-effectapplication")?.prototype;
    if (!prototype?._applyEffectToActor) {
      ui.notifications.warn(localize("LinkingUnavailable"));
      return;
    }
    const original = prototype._applyEffectToActor;
    prototype._applyEffectToActor = async function(effect, actor) {
      if (!enabled()) return original.call(this, effect, actor);
      const caster = this.message.getAssociatedActor();
      if (caster) await waitForActor(caster);
      const source = this.message.getFlag(MODULE_ID, CAST);
      if (!source) return original.call(this, effect, actor);
      const marker = await fromUuid(source);
      if (!marker || marker.disabled) {
        ui.notifications.warn(localize("CastEnded"));
        return;
      }
      const applied = await original.call(this, effect, actor);
      if (!applied) return applied;
      await applied.setFlag(MODULE_ID, LINK, source);
      // Concentration can end while the target's effect is being created.
      const current = await fromUuid(source);
      if (!current || current.disabled) await applied.delete();
      return applied;
    };
    // Catch effects whose caster was deleted or ended concentration while this
    // client was disconnected. Only explicitly linked effects are considered.
    void (async () => {
      for (const actor of actors()) {
        if (!actor.isOwner || !responsible(actor)) continue;
        for (const effect of actor.effects) {
          const source = effect.getFlag(MODULE_ID, LINK);
          if (!source) continue;
          const marker = await fromUuid(source);
          if (!marker || marker.disabled) await effect.delete();
        }
      }
    })().catch(report);
  });
}
