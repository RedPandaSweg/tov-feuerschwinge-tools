import { MODULE_ID } from "./core/constants.mjs";
import { spellMarkerState } from "./spell-name-markers.mjs";
import { installConcentrationEffects, linkConcentrationCast } from "./concentration-effects.mjs";

const FLAG = "concentration";
const queues = new Map();
const rolling = new Set();
const enabled = () => game.settings.get(MODULE_ID, "automaticConcentration")
  && !(game.modules.get("bf-qol")?.active
    && ["autoConcentration", "saveConcentration"].some(key => game.settings.settings.has(`bf-qol.${key}`) && game.settings.get("bf-qol", key)));
const escape = value => foundry.utils.escapeHTML(String(value));
const localize = key => game.i18n.localize(`TOVF.Concentration.${key}`);
const format = (key, data) => game.i18n.format(`TOVF.Concentration.${key}`, data);
const effects = actor => [...actor.effects].filter(effect => effect.getFlag(MODULE_ID, FLAG) && !effect.disabled);
const unable = actor => actor.system.attributes.hp.value <= 0
  || ["incapacitated", "unconscious", "dead", "stunned", "paralyzed", "petrified"].some(id => actor.statuses.has(id));

function cardHeader(effect) {
  const spell = effect.name.replace(/^Concentration:\s*/, "");
  return `<header class="tovf-concentration-header">
    <span class="tovf-concentration-icon"><i class="fa-solid fa-brain" aria-hidden="true"></i></span>
    <div><span class="tovf-concentration-eyebrow">${escape(localize("Title"))}</span><strong>${escape(spell)}</strong></div>
  </header>`;
}

function saveCard(effect, amount, dc) {
  return `<section class="tovf-concentration-card">
    ${cardHeader(effect)}
    <div class="tovf-concentration-stats">
      <div><span>${escape(localize("Damage"))}</span><strong>${amount}</strong></div>
      <div><span>${escape(localize("Save"))}</span><strong><small>${escape(localize("DC"))}</small> ${dc}</strong></div>
    </div>
    <button class="tovf-concentration-roll" type="button" data-tovf-concentration>
      <i class="fa-solid fa-dice-d20" aria-hidden="true"></i> ${escape(localize("Roll"))}
    </button>
  </section>`;
}

function resultCard(effect, total, dc) {
  const success = total >= dc;
  return `<section class="tovf-concentration-card tovf-concentration-${success ? "success" : "failure"}">
    ${cardHeader(effect)}
    <div class="tovf-concentration-outcome">
      <i class="fa-solid ${success ? "fa-circle-check" : "fa-circle-xmark"}" aria-hidden="true"></i>
      <strong>${escape(localize(success ? "Maintained" : "Ended"))}</strong>
    </div>
    <div class="tovf-concentration-comparison"><span>${escape(localize("Save"))} <strong>${escape(total)}</strong></span><span>${escape(localize("DC"))} <strong>${dc}</strong></span></div>
  </section>`;
}

function enqueue(actor, task) {
  const previous = queues.get(actor.uuid) ?? Promise.resolve();
  const next = previous.then(task).catch(error => {
    console.error(`${MODULE_ID} | Concentration`, error);
    ui.notifications.error(localize("ProcessingError"));
  }).finally(() => { if (queues.get(actor.uuid) === next) queues.delete(actor.uuid); });
  queues.set(actor.uuid, next);
  return next;
}

async function end(actor) {
  const ids = effects(actor).map(effect => effect.id);
  if (ids.length) await actor.deleteEmbeddedDocuments("ActiveEffect", ids);
}

async function start(activity, message) {
  const actor = activity.actor;
  if (!actor?.isOwner || unable(actor)) return;
  await end(actor);
  const duration = activity.duration;
  const seconds = Number(duration?.value) * ({ round: 6, minute: 60, hour: 3600, day: 86400 }[duration?.unit] ?? 0);
  const created = await actor.createEmbeddedDocuments("ActiveEffect", [{
    name: format("EffectName", { spell: activity.item.name }),
    img: "systems/black-flag/artwork/statuses/concentrating.svg",
    origin: activity.item.uuid,
    statuses: ["tovf-concentration"],
    duration: seconds > 0 ? { seconds, startTime: game.time.worldTime } : {},
    flags: { [MODULE_ID]: { [FLAG]: { pending: {} } } }
  }]);
  await linkConcentrationCast(message, created?.[0]);
}

async function damage(actor, changes) {
  const effect = effects(actor)[0];
  if (!effect) return;
  if (unable(actor)) return end(actor);
  const amount = -changes.total;
  if (!(amount > 0)) return;
  const id = foundry.utils.randomID();
  const dc = Math.max(10, Math.floor(amount / 2));
  await effect.setFlag(MODULE_ID, `${FLAG}.pending.${id}`, { dc });
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker({ actor }),
    content: saveCard(effect, amount, dc),
    flags: { [MODULE_ID]: { concentrationSave: { actor: actor.uuid, effect: effect.id, id, dc } } }
  });
}

function roller(actor) {
  return game.users.find(user => user.active && !user.isGM && actor.testUserPermission(user, "OWNER"))
    ?? game.users.activeGM;
}

async function render(message, html) {
  const data = message.getFlag(MODULE_ID, "concentrationSave");
  if (!data) return;
  const button = (html[0] ?? html).querySelector("[data-tovf-concentration]");
  if (!button) return;
  const actor = await fromUuid(data.actor);
  const effect = actor?.effects.get(data.effect);
  const pending = effect?.getFlag(MODULE_ID, FLAG)?.pending ?? {};
  button.disabled = !enabled() || !actor?.isOwner || roller(actor)?.id !== game.user.id
    || !pending[data.id] || effect.disabled || rolling.has(data.id);
  if (!pending[data.id]) button.textContent = localize("Resolved");
  else button.innerHTML = `<i class="fa-solid fa-dice-d20" aria-hidden="true"></i> ${escape(localize("Roll"))}`;
  button.addEventListener("click", async () => {
    if (rolling.has(data.id) || !enabled() || roller(actor)?.id !== game.user.id) return;
    rolling.add(data.id);
    button.disabled = true;
    try {
      const current = actor.effects.get(data.effect);
      if (!current?.getFlag(MODULE_ID, FLAG)?.pending[data.id] || current.disabled) return;
      const rolls = await actor.rollAbilitySave({ ability: "constitution", target: data.dc }, {}, {
        data: { flavor: escape(format("RollFlavor", { dc: data.dc })) }
      });
      if (!rolls?.length) return;
      // A delayed save must never end a newly cast spell's concentration.
      if (!actor.effects.has(data.effect)) return;
      if (rolls[0].total < data.dc) await current.delete();
      else await current.unsetFlag(MODULE_ID, `${FLAG}.pending.${data.id}`);
      await ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: resultCard(current, rolls[0].total, data.dc) });
    } catch (error) {
      console.error(`${MODULE_ID} | Concentration save`, error);
      ui.notifications.error(localize("SaveError"));
    } finally {
      rolling.delete(data.id);
      await render(message, html);
    }
  }, { once: true });
}

export function installConcentration() {
  installConcentrationEffects({ enabled, waitForActor: actor => queues.get(actor.uuid) ?? Promise.resolve() });
  game.settings.register(MODULE_ID, "automaticConcentration", {
    name: "TOVF.Concentration.SettingName",
    hint: "TOVF.Concentration.SettingHint",
    scope: "world", config: true, type: Boolean, default: true
  });
  CONFIG.statusEffects.push({ id: "tovf-concentration", name: "TOVF.Concentration.Title", img: "systems/black-flag/artwork/statuses/concentrating.svg", flags: { [MODULE_ID]: { [FLAG]: { pending: {} } } } });
  Hooks.on("blackFlag.postActivateActivity", (activity, config, results) => {
    if (!enabled() || !activity.actor) return;
    if (activity.duration?.concentration || (!activity.duration?.override && activity.item?.type === "spell" && spellMarkerState(activity.item).concentration)) {
      return enqueue(activity.actor, () => start(activity, results?.message));
    }
  });
  Hooks.on("blackFlag.damageActor", (actor, changes, update, userId) => {
    if (enabled() && game.user.id === userId && actor.isOwner) return enqueue(actor, () => damage(actor, changes));
  });
  const checkStatus = (effect, options, userId) => {
    const actor = effect.parent;
    if (enabled() && game.user.id === userId && actor?.documentName === "Actor" && actor.isOwner && unable(actor)) enqueue(actor, () => end(actor));
  };
  Hooks.on("createActiveEffect", checkStatus);
  Hooks.on("updateActiveEffect", (effect, changes, options, userId) => checkStatus(effect, options, userId));
  Hooks.on("renderChatMessageHTML", render);
}
