import { MODULE_ID, modulePath } from "./core/constants.mjs";

const SETTINGS = {
  doom: "doomPoints",
  active: "doomActive",
  announceDoom: "doomAnnounceCurrent",
  actors: "doomSelectedActors"
};
const ACTIVE_SESSION_SETTING = "activeSession";
let panel;
let rollResultQueue = Promise.resolve();
const pendingRollTotals = new Map();
const pendingClientRolls = new Set();

function selectedActorIds() {
  return new Set(game.settings.get(MODULE_ID, SETTINGS.actors));
}

function allPlayerActors() {
  return game.actors
    .filter(actor => actor.type === "pc")
    .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
}

function connectedPlayerActors() {
  return allPlayerActors()
    .filter(actor => game.users.some(user => (
      user.active
      && !user.isGM
      && actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
    )));
}

function refreshPanel() {
  if (panel?.rendered) panel.render({ force: true });
}

function parseCR(value) {
  if (typeof value === "number") return value;
  const fraction = String(value ?? "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return Number(value) || 0;
}

function encounterStats() {
  const adversaries = game.combat?.combatants.filter(combatant => !combatant.actor?.hasPlayerOwner) ?? [];
  return {
    adversaryCount: adversaries.length,
    maxCR: Math.max(0, ...adversaries.map(combatant => parseCR(
      combatant.actor?.system.attributes?.cr ?? combatant.actor?.system.details?.cr
    )))
  };
}

function startingDoom() {
  const { adversaryCount, maxCR } = encounterStats();
  if (!adversaryCount) return 0;
  const base = maxCR >= 23 ? 6 : maxCR >= 17 ? 5 : maxCR >= 11 ? 4 : maxCR >= 5 ? 3 : 2;
  return base + adversaryCount - 1;
}

async function setDoom(value) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, SETTINGS.doom, Math.max(0, Number(value) || 0));
}

function requestLabel(type, key) {
  if (type === "die") return `d${key}`;
  return type === "skill"
    ? CONFIG.BlackFlag.skills.localized[key] ?? key
    : CONFIG.BlackFlag.abilities.localized[key] ?? key;
}

async function createRollRequest({ actorIds, type, key, dc, showAverage = false, privateRoll = false }) {
  const actors = actorIds.map(id => game.actors.get(id)).filter(Boolean);
  if (!actors.length) {
    ui.notifications.warn(game.i18n.localize("TOVF.ChallengeManager.Roll.NoActors"));
    return;
  }
  const label = requestLabel(type, key);
  const dcLabel = dc ? ` · DC ${dc}` : "";
  const buttons = actors.map(actor => `
    <div class="tovf-roll-request-row">
      <button type="button" class="tovf-roll-request" data-actor-id="${actor.id}"
        data-roll-type="${type}" data-roll-key="${key}" data-dc="${dc || ""}">
        <i class="fa-solid fa-dice-d20" inert></i> ${Handlebars.escapeExpression(actor.name)}
      </button>
      <span class="tovf-roll-request-result" data-roll-result="${actor.id}"></span>
    </div>
  `).join("");
  await ChatMessage.create({
    speaker: ChatMessage.getSpeaker(),
    content: `
      <section class="tovf-roll-request-card">
        <h3>${Handlebars.escapeExpression(label)}${dcLabel}</h3>
        <p>${Handlebars.escapeExpression(game.i18n.localize("TOVF.ChallengeManager.Roll.RequestedFor"))}</p>
        <div class="tovf-roll-request-actors">${buttons}</div>
        ${showAverage ? '<p class="tovf-roll-request-average" data-roll-average hidden></p>' : ""}
      </section>
    `,
    flags: {
      [MODULE_ID]: {
        rollRequest: {
          actorIds: actors.map(actor => actor.id),
          type,
          key,
          dc: dc || null,
          showAverage: Boolean(showAverage),
          privateRoll: Boolean(privateRoll),
          rolledActorIds: [],
          rollMessageIds: {},
          results: {},
          average: null
        }
      }
    }
  });
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class ChallengeManager extends HandlebarsApplicationMixin(ApplicationV2) {
  #allActorsExpanded = true;
  #expandedSections = { doom: true, party: true, roll: true };

  static DEFAULT_OPTIONS = {
    id: "tovf-challenge-manager",
    classes: ["tovf-challenge-manager"],
    position: { width: 390, height: 690 },
    window: { title: "TOVF.ChallengeManager.Title", resizable: true },
    actions: {
      adjustDoom: this.#adjustDoom,
      selectActor: this.#selectActor,
      addConnectedActors: this.#addConnectedActors,
      addSessionActors: this.#addSessionActors,
      requestRoll: this.#requestRoll
    }
  };

  static PARTS = {
    content: { template: modulePath("templates/challenge-manager.hbs") }
  };

  async _prepareContext(options) {
    const selected = selectedActorIds();
    const actors = allPlayerActors();
    const activeSession = game.settings.get(MODULE_ID, ACTIVE_SESSION_SETTING) ?? {};
    const sessionActorUuids = new Set(activeSession.actorUuids ?? []);
    const actorView = actor => ({
      id: actor.id,
      uuid: actor.uuid,
      name: actor.name,
      img: actor.img,
      ac: actor.system.attributes?.ac?.value ?? "—",
      passivePerception: actor.system.proficiencies?.skills?.perception?.passive
        ?? actor.system.attributes?.perception
        ?? "—"
    });
    return {
      ...(await super._prepareContext(options)),
      doom: game.settings.get(MODULE_ID, SETTINGS.doom),
      announceDoom: game.settings.get(MODULE_ID, SETTINGS.announceDoom),
      ...encounterStats(),
      allActorsExpanded: this.#allActorsExpanded,
      doomExpanded: this.#expandedSections.doom,
      partyExpanded: this.#expandedSections.party,
      rollExpanded: this.#expandedSections.roll,
      sessionActorCount: actors.filter(actor => sessionActorUuids.has(actor.uuid)).length,
      selectedActors: actors.filter(actor => selected.has(actor.id)).map(actorView),
      availableActors: actors.filter(actor => !selected.has(actor.id)).map(actorView),
      skills: CONFIG.BlackFlag.skills.localizedOptions,
      abilities: CONFIG.BlackFlag.abilities.localizedOptions,
      dice: [4, 6, 8, 10, 12, 20, 100].map(value => ({ value, label: `d${value}` }))
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.querySelector("[data-doom-value]")?.addEventListener("change", event => setDoom(event.target.value));
    this.element.querySelector("[data-doom-announce]")?.addEventListener("change", event => (
      game.settings.set(MODULE_ID, SETTINGS.announceDoom, event.currentTarget.checked)
    ));
    const type = this.element.querySelector("[data-request-type]");
    type?.addEventListener("change", () => this.#updateRequestFields());
    this.element.querySelector("[data-all-actors]")?.addEventListener("toggle", event => {
      this.#allActorsExpanded = event.currentTarget.open;
    });
    for (const section of this.element.querySelectorAll("[data-challenge-section]")) {
      section.addEventListener("toggle", event => {
        this.#expandedSections[event.currentTarget.dataset.challengeSection] = event.currentTarget.open;
      });
    }
    for (const entry of this.element.querySelectorAll("[data-selected-actor]")) {
      entry.addEventListener("dblclick", event => {
        if (event.target.closest("button")) return;
        game.actors.get(entry.dataset.actorId)?.sheet.render(true);
      });
      entry.addEventListener("dragstart", event => {
        event.dataTransfer.setData("text/plain", JSON.stringify({
          type: "Actor",
          uuid: entry.dataset.actorUuid
        }));
      });
    }
    this.#updateRequestFields();
  }

  #updateRequestFields() {
    const type = this.element.querySelector("[data-request-type]")?.value;
    for (const select of this.element.querySelectorAll("[data-request-key]")) {
      select.hidden = select.dataset.kind !== type;
    }
    const dc = this.element.querySelector("[data-request-dc-field]");
    if (dc) dc.hidden = type === "die";
  }

  static async #adjustDoom(_event, target) {
    const previous = game.settings.get(MODULE_ID, SETTINGS.doom);
    const next = Math.max(0, previous + Number(target.dataset.amount));
    await setDoom(next);
    if (target.dataset.doomChat !== "true") return;
    const action = target.dataset.doomAction || target.textContent.trim();
    const icon = ["fa-thumbs-up", "fa-thumbs-down", "fa-person-running", "fa-arrows-rotate"].includes(target.dataset.doomIcon)
      ? target.dataset.doomIcon
      : "fa-skull-crossbones";
    const current = game.settings.get(MODULE_ID, SETTINGS.announceDoom)
      ? `<div class="tovf-doom-chat-total"><span>${Handlebars.escapeExpression(game.i18n.localize("TOVF.ChallengeManager.Doom.Remaining"))}</span><strong>${next}</strong></div>`
      : "";
    return ChatMessage.create({
      speaker: ChatMessage.getSpeaker(),
      content: `<section class="tovf-doom-chat"><header><i class="fa-solid fa-skull-crossbones" inert></i><span>${Handlebars.escapeExpression(game.i18n.localize("TOVF.ChallengeManager.Doom.Bank"))}</span></header><div class="tovf-doom-chat-action"><i class="fa-solid ${icon}" inert></i><strong>${Handlebars.escapeExpression(action)}</strong></div>${current}</section>`
    });
  }

  static async #selectActor(_event, target) {
    const selected = selectedActorIds();
    target.dataset.operation === "add"
      ? selected.add(target.dataset.actorId)
      : selected.delete(target.dataset.actorId);
    await game.settings.set(MODULE_ID, SETTINGS.actors, [...selected]);
  }

  static async #addConnectedActors() {
    const selected = selectedActorIds();
    for (const actor of connectedPlayerActors()) selected.add(actor.id);
    await game.settings.set(MODULE_ID, SETTINGS.actors, [...selected]);
  }

  static #requestRoll() {
    const type = this.element.querySelector("[data-request-type]").value;
    const key = this.element.querySelector(`[data-request-key][data-kind="${type}"]`).value;
    const dc = type === "die"
      ? null
      : Number(this.element.querySelector("[data-request-dc]").value) || null;
    const showAverage = Boolean(this.element.querySelector("[data-request-average]")?.checked);
    const privateRoll = Boolean(this.element.querySelector("[data-request-private]")?.checked);
    const actorIds = [...selectedActorIds()];
    return createRollRequest({ actorIds, type, key, dc, showAverage, privateRoll });
  }

  static async #addSessionActors() {
    const active = game.settings.get(MODULE_ID, ACTIVE_SESSION_SETTING) ?? {};
    const actorUuids = new Set(active.actorUuids ?? []);
    const selected = selectedActorIds();
    for (const actor of allPlayerActors()) {
      if (actorUuids.has(actor.uuid)) selected.add(actor.id);
    }
    await game.settings.set(MODULE_ID, SETTINGS.actors, [...selected]);
  }
}

function openPanel() {
  if (!game.user.isGM) return;
  panel ??= new ChallengeManager();
  panel.render({ force: true });
}

export function openChallengeManager() {
  return openPanel();
}

function addDoomButtons(_app, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("[data-tovf-doom-controls]")) return;
  const header = root.querySelector(".combat-tracker-header")
    ?? root.querySelector(".directory-header")
    ?? root.querySelector("header")
    ?? root;
  const controls = document.createElement("div");
  controls.className = "tovf-doom-controls";
  controls.dataset.tovfDoomControls = "";
  if (game.user.isGM) {
    const tracker = document.createElement("button");
    tracker.type = "button";
    tracker.dataset.tovfChallengeManager = "";
    tracker.innerHTML = `<i class="fa-solid fa-skull-crossbones" inert></i> ${
      game.i18n.localize("TOVF.ChallengeManager.Open")
    }`;
    tracker.addEventListener("click", openPanel);
    controls.append(tracker);
  }
  if (controls.childElementCount) header.append(controls);
}

function activeGM() {
  return game.users.activeGM ?? game.users.find(user => user.active && user.isGM);
}

function messageRollTotal(message) {
  const rolls = message?.rolls;
  const roll = Array.isArray(rolls)
    ? rolls[0]
    : rolls?.contents?.[0] ?? rolls?.first?.() ?? message?.roll;
  const total = Number(roll?.total);
  return Number.isFinite(total) ? total : null;
}

function linkedRollMessages(requestMessageId) {
  const messages = game.messages?.contents ?? Array.from(game.messages ?? []);
  return messages.filter(message =>
    message?.getFlag?.(MODULE_ID, "challengeRoll")?.requestMessageId === requestMessageId
  );
}

function rollUserId(message) {
  return message?.author?.id
    ?? message?.user?.id
    ?? (typeof message?.user === "string" ? message.user : null)
    ?? message?._source?.user
    ?? null;
}

function clientRollKey(messageId, actorId) {
  return `${messageId}.${actorId}`;
}

function setVisibleRollButtonsDisabled(messageId, actorId, disabled) {
  for (const button of document.querySelectorAll(
    `.tovf-roll-request[data-actor-id="${CSS.escape(actorId)}"]`
  )) {
    if (button.closest("[data-message-id]")?.dataset.messageId === messageId) button.disabled = disabled;
  }
}

async function createPrivateAverageMessage(requestMessage, request, average) {
  const recipients = ChatMessage.getWhisperRecipients("GM").map(user => user.id);
  const label = requestLabel(request.type, request.key);
  await ChatMessage.create({
    speaker: requestMessage.speaker,
    whisper: recipients,
    content: `
      <section class="tovf-roll-request-card">
        <h3>${Handlebars.escapeExpression(label)}</h3>
        <p class="tovf-roll-request-average">${Handlebars.escapeExpression(
          game.i18n.format("TOVF.ChallengeManager.Roll.Average", {
            average: Number(average).toLocaleString(game.i18n.lang, { maximumFractionDigits: 2 })
          })
        )}</p>
      </section>
    `,
    flags: {
      [MODULE_ID]: {
        challengeAverage: { requestMessageId: requestMessage.id }
      }
    }
  });
}

async function recordRollResult({ messageId, rollMessageId, actorId, userId, total: submittedTotal }) {
  const message = game.messages.get(messageId);
  const rollMessage = rollMessageId ? game.messages.get(rollMessageId) : null;
  const request = message?.getFlag(MODULE_ID, "rollRequest");
  const rollLink = rollMessage?.getFlag?.(MODULE_ID, "challengeRoll");
  const user = game.users.get(userId);
  const actor = game.actors.get(actorId);
  if (!message || !request || !user || !actor) {
    return;
  }
  if (!request.actorIds?.includes(actorId)) {
    return;
  }
  if (!user.isGM && !actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) {
    return;
  }
  const authorId = rollUserId(rollMessage);
  if (authorId && authorId !== userId) {
    return;
  }
  if (rollLink && (rollLink.requestMessageId !== messageId || rollLink.actorId !== actorId)) {
    return;
  }
  if (request.rolledActorIds?.includes(actorId)) {
    return;
  }

  const submitted = Number(submittedTotal);
  const total = messageRollTotal(rollMessage) ?? (Number.isFinite(submitted) ? submitted : null);
  if (total === null) {
    return;
  }

  const rolledActorIds = [...new Set([...(request.rolledActorIds ?? []), actorId])];
  const rollMessageIds = {
    ...(request.rollMessageIds ?? {}),
    ...(rollMessageId ? { [actorId]: rollMessageId } : {})
  };
  const results = {
    ...(request.results ?? {}),
    ...(!request.privateRoll ? { [actorId]: total } : {})
  };
  const update = { ...request, rolledActorIds, rollMessageIds, results };
  let privateAverage = null;
  const submittedTotals = pendingRollTotals.get(messageId) ?? new Map();
  submittedTotals.set(actorId, total);
  pendingRollTotals.set(messageId, submittedTotals);
  if (request.showAverage && rolledActorIds.length === request.actorIds.length) {
    const totals = new Map(submittedTotals);
    for (const requestedActorId of request.actorIds) {
      const total = messageRollTotal(game.messages.get(rollMessageIds[requestedActorId]));
      if (total !== null) totals.set(requestedActorId, total);
    }
    // Compatibility for requests created before roll-message IDs were stored.
    for (const resultMessage of linkedRollMessages(messageId)) {
      const link = resultMessage.getFlag(MODULE_ID, "challengeRoll");
      const total = messageRollTotal(resultMessage);
      if (link?.actorId && total !== null) totals.set(link.actorId, total);
    }
    if (request.actorIds.every(id => totals.has(id))) {
      const average = request.actorIds.reduce((sum, id) => sum + totals.get(id), 0) / request.actorIds.length;
      if (request.privateRoll) {
        update.average = null;
        privateAverage = average;
      } else {
        update.average = average;
      }
      pendingRollTotals.delete(messageId);
    }
  }
  await message.update({ [`flags.${MODULE_ID}.rollRequest`]: update });
  if (privateAverage !== null) {
    await createPrivateAverageMessage(message, request, privateAverage);
  }
  pendingClientRolls.delete(clientRollKey(messageId, actorId));
}

function submitRollResult(payload) {
  if (game.user.isGM) return queueRollResult({ ...payload, userId: game.user.id });
  game.socket.emit(`module.${MODULE_ID}`, {
    type: "challengeRollResult",
    userId: game.user.id,
    payload
  });
}

function queueRollResult(payload) {
  rollResultQueue = rollResultQueue
    .then(() => recordRollResult(payload))
    .catch(error => console.error(`${MODULE_ID} | Could not record challenge roll`, error));
  return rollResultQueue;
}

function recordCreatedChallengeRoll(message) {
  const link = message?.getFlag(MODULE_ID, "challengeRoll");
  if (!link || activeGM()?.id !== game.user.id) return;
  const userId = rollUserId(message) ?? game.user.id;
  queueRollResult({
    messageId: link.requestMessageId,
    rollMessageId: message.id,
    actorId: link.actorId,
    userId,
    total: messageRollTotal(message)
  });
}

function activateRollRequests(message, html) {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  const request = message.getFlag(MODULE_ID, "rollRequest");
  if (!request) return;
  const rolled = new Set(request.rolledActorIds ?? []);
  for (const actorId of rolled) {
    pendingClientRolls.delete(clientRollKey(message.id, actorId));
    const result = root.querySelector(`[data-roll-result="${CSS.escape(actorId)}"]`);
    if (result) {
      const total = Number(request.results?.[actorId]);
      result.textContent = !request.privateRoll && Number.isFinite(total) ? `✓ ${total}` : "✓";
    }
  }
  const average = root.querySelector("[data-roll-average]");
  if (average && request.average !== null && Number.isFinite(Number(request.average))) {
    average.hidden = false;
    average.textContent = game.i18n.format("TOVF.ChallengeManager.Roll.Average", {
      average: Number(request.average).toLocaleString(game.i18n.lang, { maximumFractionDigits: 2 })
    });
  }
  for (const button of root.querySelectorAll(".tovf-roll-request")) {
    if (button.dataset.tovfBound) continue;
    button.dataset.tovfBound = "true";
    const actor = game.actors.get(button.dataset.actorId);
    const allowed = actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
    button.disabled = !allowed || rolled.has(button.dataset.actorId);
    if (!allowed) button.title = game.i18n.localize("TOVF.ChallengeManager.Roll.NotAllowed");
    button.addEventListener("click", async event => {
      const pendingKey = clientRollKey(message.id, actor.id);
      if (!allowed || button.dataset.rolled === "true" || pendingClientRolls.has(pendingKey)) return;
      const target = Number(button.dataset.dc) || undefined;
      pendingClientRolls.add(pendingKey);
      setVisibleRollButtonsDisabled(message.id, actor.id, true);
      button.dataset.rolled = "true";
      button.disabled = true;
      try {
        const options = { target, event };
        const messageOptions = {
          ...(request.privateRoll ? { rollMode: CONST.DICE_ROLL_MODES.PRIVATE } : {}),
          data: {
            flags: {
              [MODULE_ID]: {
                challengeRoll: { requestMessageId: message.id, actorId: actor.id }
              }
            }
          }
        };
        let roll;
        let rollMessageId;
        if (button.dataset.rollType === "die") {
          const sides = Number(button.dataset.rollKey);
          if (![4, 6, 8, 10, 12, 20, 100].includes(sides)) return;
          roll = await new Roll(`1d${sides}`).evaluate();
          const rollMessage = await roll.toMessage({
            speaker: ChatMessage.getSpeaker({ actor }),
            flavor: `d${sides}`,
            flags: messageOptions.data.flags
          }, {
            rollMode: messageOptions.rollMode
          });
          rollMessageId = rollMessage?.id;
        } else {
          const rolls = button.dataset.rollType === "skill"
            ? await actor.rollSkill({ skill: button.dataset.rollKey, ...options }, {}, messageOptions)
            : await actor.rollAbilitySave({ ability: button.dataset.rollKey, ...options }, {}, messageOptions);
          roll = Array.isArray(rolls) ? rolls[0] : rolls;
          rollMessageId = roll?.parent?.id;
        }
        if (!roll || !Number.isFinite(Number(roll.total))) {
          pendingClientRolls.delete(pendingKey);
          setVisibleRollButtonsDisabled(message.id, actor.id, false);
          button.dataset.rolled = "false";
          button.disabled = false;
          return;
        }
        await submitRollResult({
          messageId: message.id,
          rollMessageId,
          actorId: actor.id,
          total: Number(roll.total)
        });
      } catch (error) {
        pendingClientRolls.delete(pendingKey);
        setVisibleRollButtonsDisabled(message.id, actor.id, false);
        button.dataset.rolled = "false";
        button.disabled = false;
        ui.notifications.error(error.message);
      }
    });
  }
}

function refreshRollRequestMessage(message) {
  if (!message?.getFlag(MODULE_ID, "rollRequest")) return;
  queueMicrotask(() => {
    const roots = document.querySelectorAll(
      `.chat-message[data-message-id="${CSS.escape(message.id)}"], [data-message-id="${CSS.escape(message.id)}"].message`
    );
    for (const root of roots) {
      activateRollRequests(message, root);
    }
  });
}

export function registerChallengeManager() {
  for (const [key, type, value] of [
    [SETTINGS.doom, Number, 0],
    [SETTINGS.active, Boolean, false],
    [SETTINGS.announceDoom, Boolean, false],
    [SETTINGS.actors, Array, []]
  ]) {
    game.settings.register(MODULE_ID, key, {
      scope: "world",
      config: false,
      type,
      default: value,
      onChange: () => {
        refreshPanel();
      }
    });
  }

  Hooks.on("renderCombatTracker", addDoomButtons);
  Hooks.on("renderChatMessageHTML", activateRollRequests);
  Hooks.on("updateChatMessage", refreshRollRequestMessage);
  Hooks.on("createChatMessage", recordCreatedChallengeRoll);
  Hooks.on("updateSetting", setting => {
    if (setting.key === `${MODULE_ID}.${ACTIVE_SESSION_SETTING}`) refreshPanel();
  });
  game.socket.on(`module.${MODULE_ID}`, socketMessage => {
    if (socketMessage.type !== "challengeRollResult") return;
    if (activeGM()?.id !== game.user.id) return;
    queueRollResult({ ...socketMessage.payload, userId: socketMessage.userId });
  });

  Hooks.on("combatStart", async () => {
    if (!game.user.isGM) return;
    await setDoom(startingDoom());
    await game.settings.set(MODULE_ID, SETTINGS.active, true);
    openPanel();
  });
  Hooks.on("deleteCombat", async () => {
    if (!game.user.isGM) return;
    await game.settings.set(MODULE_ID, SETTINGS.active, false);
    await setDoom(0);
  });
}

export function activateChallengeManager() {
  panel ??= game.user.isGM ? new ChallengeManager() : null;
  game.modules.get(MODULE_ID).api ??= {};
  Object.assign(game.modules.get(MODULE_ID).api, {
    openChallengeManager: openPanel,
    openDoomPanel: openPanel,
    requestRoll: createRollRequest
  });
}
