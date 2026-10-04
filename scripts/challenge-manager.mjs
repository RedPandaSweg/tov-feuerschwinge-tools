import { MODULE_ID, modulePath } from "./core/constants.mjs";

const SETTINGS = {
  doom: "doomPoints",
  active: "doomActive",
  announceDoom: "doomAnnounceCurrent",
  actors: "doomSelectedActors"
};
const ACTIVE_SESSION_SETTING = "activeSession";
const AUTO_OPEN_SETTING = "challengeHudAutoOpen";
const SHOW_NPC_HEALTH_SETTING = "challengeHudShowNpcHealthToPlayers";
const SHOW_OTHER_PLAYER_HEALTH_SETTING = "challengeHudShowOtherPlayerHealthToPlayers";
const MAX_INITIATIVE_CARDS_SETTING = "challengeHudMaxInitiativeCards";
let panel;
let rollResultQueue = Promise.resolve();
let initializedDoomCombatId = null;
let pendingDoomCombatId = null;
const pendingRollTotals = new Map();
const pendingClientRolls = new Set();
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class ChallengeHudSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-challenge-hud-settings",
    classes: ["tovf-challenge-hud-settings"],
    tag: "form",
    position: { width: 560, height: "auto" },
    window: { title: "TOVF.ChallengeManager.Settings.Menu.Title", resizable: true },
    form: { handler: ChallengeHudSettings.#submit, closeOnSubmit: true }
  };

  static PARTS = {
    main: { template: modulePath("templates/challenge-hud-settings.hbs") }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      canConfigureWorld: game.user.isGM,
      autoOpen: game.settings.get(MODULE_ID, AUTO_OPEN_SETTING),
      showNpcHealth: game.settings.get(MODULE_ID, SHOW_NPC_HEALTH_SETTING),
      showOtherPlayerHealth: game.settings.get(MODULE_ID, SHOW_OTHER_PLAYER_HEALTH_SETTING),
      maxInitiativeCards: game.settings.get(MODULE_ID, MAX_INITIATIVE_CARDS_SETTING)
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const input = this.element.querySelector('[name="maxInitiativeCards"]');
    const output = input?.closest(".tovf-challenge-card-count")?.querySelector("output");
    input?.addEventListener("input", () => { output.textContent = input.value; });
  }

  static async #submit(_event, _form, formData) {
    const values = formData.object;
    const maxCards = Math.clamp(Math.round(Number(values.maxInitiativeCards) || 10), 1, 10);
    await game.settings.set(MODULE_ID, MAX_INITIATIVE_CARDS_SETTING, maxCards);
    if (game.user.isGM) {
      await game.settings.set(MODULE_ID, AUTO_OPEN_SETTING, values.autoOpen === true);
      await game.settings.set(MODULE_ID, SHOW_NPC_HEALTH_SETTING, values.showNpcHealth === true);
      await game.settings.set(MODULE_ID, SHOW_OTHER_PLAYER_HEALTH_SETTING, values.showOtherPlayerHealth === true);
    }
    ui.notifications.info(game.i18n.localize("TOVF.ChallengeManager.Settings.Menu.Saved"));
  }
}

function selectedActorIds() {
  const activeActorIds = new Set(allPlayerActors().map(actor => actor.id));
  return new Set(game.settings.get(MODULE_ID, SETTINGS.actors).filter(id => activeActorIds.has(id)));
}

async function saveSelectedActors(actorIds) {
  await game.settings.set(MODULE_ID, SETTINGS.actors, [...new Set(actorIds)]);
}

function allPlayerActors() {
  return game.actors
    .filter(actor => actor.type === "pc" && actor.getFlag(MODULE_ID, "active") !== false)
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

async function refreshPanel() {
  if (panel?.rendered) await panel.render({ force: true });
}

function activeSessionActorIds() {
  const active = game.settings.get(MODULE_ID, ACTIVE_SESSION_SETTING) ?? {};
  const actorUuids = new Set(active.actorUuids ?? []);
  return allPlayerActors().filter(actor => actorUuids.has(actor.uuid)).map(actor => actor.id);
}

async function synchronizePartyWithActiveSession() {
  const active = game.settings.get(MODULE_ID, ACTIVE_SESSION_SETTING) ?? {};
  if (!Array.isArray(active.actorUuids)) return;
  const actorIds = activeSessionActorIds();
  const selected = [...selectedActorIds()];
  if (selected.length === actorIds.length && selected.every(id => actorIds.includes(id))) return;
  await game.settings.set(MODULE_ID, SETTINGS.actors, actorIds);
}

function parseCR(value) {
  if (typeof value === "number") return value;
  const fraction = String(value ?? "").match(/^(\d+)\s*\/\s*(\d+)$/);
  if (fraction) return Number(fraction[1]) / Number(fraction[2]);
  return Number(value) || 0;
}

function encounterStats(combat = game.combat) {
  const adversaries = combat?.combatants.filter(combatant => combatant.actor && combatant.actor.type !== "pc") ?? [];
  const activeAdversaries = adversaries.filter(combatant => {
    const hp = Number(combatant.actor?.system.attributes?.hp?.value);
    return !combatant.isDefeated && (!Number.isFinite(hp) || hp > 0);
  });
  return {
    adversaryCount: adversaries.length,
    activeAdversaryCount: activeAdversaries.length,
    maxCR: Math.max(0, ...adversaries.map(combatant => parseCR(
      combatant.actor?.system.attributes?.cr ?? combatant.actor?.system.details?.cr
    )))
  };
}

function startingDoom(combat = game.combat) {
  const { adversaryCount, maxCR } = encounterStats(combat);
  if (!adversaryCount) return 0;
  const base = maxCR >= 23 ? 6 : maxCR >= 17 ? 5 : maxCR >= 11 ? 4 : maxCR >= 5 ? 3 : 2;
  return base + adversaryCount - 1;
}

function formatCR(value) {
  const cr = Number(value) || 0;
  if (cr > 0 && cr < 1) return `1/${Math.round(1 / cr)}`;
  return cr.toLocaleString(game.i18n.lang, { maximumFractionDigits: 2 });
}

function healthColor(ratio) {
  const red = [223, 53, 43];
  const orange = [237, 123, 50];
  const font = [213, 183, 130];
  const amount = Math.clamp(Number(ratio) || 0, 0, 1);
  const [from, to, progress] = amount < 0.5
    ? [red, orange, amount * 2]
    : [orange, font, (amount - 0.5) * 2];
  const rgb = from.map((channel, index) => Math.round(channel + (to[index] - channel) * progress));
  return `rgb(${rgb.join(" ")})`;
}

async function setDoom(value) {
  if (!game.user.isGM) return;
  await game.settings.set(MODULE_ID, SETTINGS.doom, Math.max(0, Number(value) || 0));
}

async function initializeCombatDoom(combat, { force = false } = {}) {
  if (!combat || !game.user.isGM || (!force && initializedDoomCombatId === combat.id)) return;
  initializedDoomCombatId = combat.id;
  try {
    const doom = startingDoom(combat);
    await setDoom(doom);
    const persisted = Number(game.settings.get(MODULE_ID, SETTINGS.doom));
    if (persisted !== doom) throw new Error(`Doom Bank verification failed: expected ${doom}, received ${persisted}`);
    await game.settings.set(MODULE_ID, SETTINGS.active, true);
    pendingDoomCombatId = null;
    console.info(`${MODULE_ID} | Initialized Doom Bank for combat ${combat.id}: ${doom}`, encounterStats(combat));
  } catch (error) {
    initializedDoomCombatId = null;
    throw error;
  }
}

function requestCombatDoomInitialization(combat, options) {
  void initializeCombatDoom(combat, options).catch(error => {
    console.error(`${MODULE_ID} | Could not initialize Doom Bank`, error);
    ui.notifications.error(game.i18n.localize("TOVF.ChallengeManager.Doom.RecalculateFailed"));
  });
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

class ChallengeManager extends HandlebarsApplicationMixin(ApplicationV2) {
  #allActorsExpanded = true;
  #expandedSections = { doom: true, party: true, roll: true };

  static DEFAULT_OPTIONS = {
    id: "tovf-challenge-manager",
    classes: ["tovf-challenge-manager"],
    position: { width: 1080, height: 104, top: 6 },
    window: { title: "TOVF.ChallengeManager.Title", resizable: true },
    actions: {
      adjustDoom: this.#adjustDoom,
      openRulesJournal: this.#openRulesJournal,
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
      round: game.combat?.round ?? 0,
      turn: (game.combat?.turn ?? -1) + 1,
      combatants: (game.combat?.turns ?? []).map((combatant, index) => ({
        id: combatant.id,
        name: combatant.name ?? combatant.actor?.name ?? "Unbekannt",
        img: combatant.token?.texture?.src ?? combatant.actor?.img,
        initiative: combatant.initiative ?? "â€”",
        ac: combatant.actor?.system.attributes?.ac?.value ?? "â€”",
        defeated: Boolean(combatant.isDefeated),
        active: index === game.combat?.turn
      })),
      rulesLinks: [
        { label: "Conditions", icon: "fa-solid fa-circle-exclamation", uuid: "Compendium.tov-feuerschwinge.players-guide.JournalEntry.PpKSlgQI6Xz4StJz" },
        { label: "Actions in Combat", icon: "fa-solid fa-hand-fist", uuid: "Compendium.tov-feuerschwinge.players-guide.JournalEntry.Hx63pkAqiTv1bpTg.JournalEntryPage.jTJ7GX4t88qkaijp" },
        { label: "Movement in Combat", icon: "fa-solid fa-person-running", uuid: "Compendium.tov-feuerschwinge.players-guide.JournalEntry.Hx63pkAqiTv1bpTg.JournalEntryPage.UFhtpXYvDelOu0s0" },
        { label: "Playing the Game", icon: "fa-solid fa-book-open", uuid: "Compendium.tov-feuerschwinge.players-guide.JournalEntry.Hx63pkAqiTv1bpTg" }
      ],
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
    await saveSelectedActors([...selected]);
    await this.render({ force: true });
  }

  static async #addConnectedActors() {
    const selected = selectedActorIds();
    for (const actor of connectedPlayerActors()) selected.add(actor.id);
    await saveSelectedActors([...selected]);
    await this.render({ force: true });
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

  static async #openRulesJournal(_event, target) {
    const document = await fromUuid(target.dataset.uuid).catch(() => null);
    if (!document) {
      ui.notifications.warn(`Regelreferenz nicht gefunden: ${target.dataset.tooltip ?? target.dataset.uuid}`);
      return;
    }
    if (document.documentName === "JournalEntryPage") {
      document.parent.sheet.render(true, { pageId: document.id });
      return;
    }
    document.sheet.render(true);
  }

  static async #addSessionActors() {
    const active = game.settings.get(MODULE_ID, ACTIVE_SESSION_SETTING) ?? {};
    const actorUuids = new Set(active.actorUuids ?? []);
    const selected = selectedActorIds();
    for (const actor of allPlayerActors()) {
      if (actorUuids.has(actor.uuid)) selected.add(actor.id);
    }
    await saveSelectedActors([...selected]);
    await this.render({ force: true });
  }
}

class ChallengeHud {
  #drawers = { party: false, roll: false, doom: false };
  #hpCombatantId = null;
  #excludedRollActorIds = new Set();
  #carouselCombatId = null;
  #carouselStep = null;
  #carouselOffset = null;
  element = null;
  get rendered() { return this.element?.isConnected === true; }

  renderLegacy() {
    const isGM = game.user.isGM;
    const selected = selectedActorIds();
    const actors = allPlayerActors();
    const active = game.settings.get(MODULE_ID, ACTIVE_SESSION_SETTING) ?? {};
    const escape = value => Handlebars.escapeExpression(String(value ?? ""));
    const localize = key => game.i18n.localize(key);
    const actorRow = actor => `<li><img src="${escape(actor.img)}" alt=""><span>${escape(actor.name)}</span><small><i class="fa-solid fa-shield" inert></i>${escape(actor.system.attributes?.ac?.value ?? "â€”")}</small><small><i class="fa-solid fa-eye" inert></i>${escape(actor.system.proficiencies?.skills?.perception?.passive ?? actor.system.attributes?.perception ?? "â€”")}</small><button type="button" data-hud-action="${selected.has(actor.id) ? "remove" : "add"}" data-actor-id="${actor.id}"><i class="fa-solid fa-${selected.has(actor.id) ? "xmark" : "plus"}" inert></i></button></li>`;
    const combatants = (game.combat?.turns ?? []).map((combatant, index) => {
      const actor = combatant.actor;
      const hp = actor?.system.attributes?.hp;
      const portraitSrc = escape(combatant.token?.texture?.src ?? actor?.img);
      const hpControl = isGM && this.#hpCombatantId === combatant.id && actor ? `<div class="tovf-challenge-hud-hp-control"><input type="number" min="0" value="1" data-hud-hp-amount><button type="button" data-hud-action="damage" data-actor-id="${actor.id}">−</button><button type="button" data-hud-action="heal" data-actor-id="${actor.id}">+</button></div>` : "";
      return `<article class="${index === game.combat?.turn ? "is-active" : ""}${combatant.isDefeated ? " is-defeated" : ""}"><img src="${escape(actor?.img ?? combatant.token?.texture?.src)}" alt=""><span class="tovf-challenge-hud-initiative-value">${escape(combatant.initiative ?? "â€”")}</span><strong>${escape(combatant.name ?? actor?.name ?? "Unbekannt")}</strong><div class="tovf-challenge-hud-card-stats">${isGM ? `<span><i class="fa-solid fa-shield" inert></i>${escape(actor?.system.attributes?.ac?.value ?? "â€”")}</span>${hp ? `<button type="button" data-hud-action="hp" data-combatant-id="${combatant.id}"><i class="fa-solid fa-heart" inert></i>${escape(hp.value ?? 0)}</button>` : ""}` : ""}</div>${hpControl}</article>`;
    }).join("") || `<p class="hint">Keine Combatants in der Initiative.</p>`;
    const drawer = (name, icon, label, content, badge = "") => `<section class="tovf-challenge-hud-drawer ${this.#drawers[name] ? "is-open" : ""}"><button type="button" class="tovf-challenge-hud-toggle" data-hud-action="toggle" data-drawer="${name}" title="${escape(label)}" aria-label="${escape(label)}"><i class="fa-solid ${icon}" inert></i>${badge}</button><div class="tovf-challenge-hud-popover">${content}</div></section>`;
    const party = `<header>${localize("TOVF.ChallengeManager.Party.Title")}</header><ul>${actors.filter(actor => selected.has(actor.id)).map(actorRow).join("") || `<li class="hint">${localize("TOVF.ChallengeManager.Party.Empty")}</li>`}</ul><div class="tovf-challenge-hud-actions"><button type="button" data-hud-action="connected"><i class="fa-solid fa-users" inert></i>${localize("TOVF.ChallengeManager.Actors.AddConnected")}</button><button type="button" data-hud-action="session"><i class="fa-solid fa-scroll" inert></i>${localize("TOVF.ChallengeManager.Actors.AddSession")}</button></div><details><summary>${localize("TOVF.ChallengeManager.Actors.Title")}</summary><ul>${actors.filter(actor => !selected.has(actor.id)).map(actorRow).join("") || `<li class="hint">${localize("TOVF.ChallengeManager.Actors.AllSelected")}</li>`}</ul></details>`;
    const roll = `<header>${localize("TOVF.ChallengeManager.Roll.Title")}</header><div class="tovf-challenge-hud-roll-selects"><select data-hud-roll-type><option value="skill">${localize("TOVF.ChallengeManager.Roll.Skill")}</option><option value="save">${localize("TOVF.ChallengeManager.Roll.Save")}</option><option value="die">${localize("TOVF.ChallengeManager.Roll.Die")}</option></select><select data-hud-roll-key data-kind="skill">${Object.entries(CONFIG.BlackFlag.skills.localized ?? {}).map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("")}</select><select data-hud-roll-key data-kind="save" hidden>${Object.entries(CONFIG.BlackFlag.abilities.localized ?? {}).map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("")}</select><select data-hud-roll-key data-kind="die" hidden>${[4, 6, 8, 10, 12, 20, 100].map(value => `<option value="${value}">d${value}</option>`).join("")}</select></div><div class="tovf-challenge-hud-roll-options"><label><input type="checkbox" data-hud-average> ${localize("TOVF.ChallengeManager.Roll.ShowAverage")}</label><label><input type="checkbox" data-hud-private> ${localize("TOVF.ChallengeManager.Roll.Private")}</label><label data-hud-dc>${localize("TOVF.ChallengeManager.Roll.DCShort")} <input type="number" min="0" max="99" data-hud-roll-dc></label></div><button type="button" data-hud-action="request"><i class="fa-solid fa-message-arrow-up-right" inert></i>${localize("TOVF.ChallengeManager.Roll.Post")}</button>`;
    const doom = `<header>${localize("TOVF.ChallengeManager.Doom.Bank")}</header><div class="tovf-challenge-hud-doom-count"><button type="button" data-hud-action="doom" data-amount="-1">&minus;</button><input type="number" min="0" value="${game.settings.get(MODULE_ID, SETTINGS.doom)}" data-hud-doom><button type="button" data-hud-action="doom" data-amount="1">+</button></div><div class="tovf-challenge-hud-doom-actions"><button type="button" data-hud-action="doom" data-amount="-1" data-doom-chat="true" data-doom-icon="fa-thumbs-up">${localize("TOVF.ChallengeManager.Doom.Advantage")}</button><button type="button" data-hud-action="doom" data-amount="-1" data-doom-chat="true" data-doom-icon="fa-thumbs-down">${localize("TOVF.ChallengeManager.Doom.Disadvantage")}</button><button type="button" data-hud-action="doom" data-amount="-2" data-doom-chat="true" data-doom-icon="fa-person-running">${localize("TOVF.ChallengeManager.Doom.ExtraAction")}</button><button type="button" data-hud-action="doom" data-amount="-3" data-doom-chat="true" data-doom-icon="fa-arrows-rotate">${localize("TOVF.ChallengeManager.Doom.Recharge")}</button></div><label><input type="checkbox" data-hud-doom-announce ${game.settings.get(MODULE_ID, SETTINGS.announceDoom) ? "checked" : ""}> ${localize("TOVF.ChallengeManager.Doom.AnnounceCurrent")}</label>`;
    const controls = isGM ? `${drawer("party", "fa-users", localize("TOVF.ChallengeManager.Party.Title"), party)}${drawer("roll", "fa-dice-d20", localize("TOVF.ChallengeManager.Roll.Title"), roll)}${drawer("doom", "fa-skull-crossbones", localize("TOVF.ChallengeManager.Doom.Bank"), doom, `<b>${game.settings.get(MODULE_ID, SETTINGS.doom)}</b>`)}` : "";
    const html = `<div class="tovf-challenge-hud-bar"><div class="tovf-challenge-hud-left">${controls}<div class="tovf-challenge-hud-round"><i class="fa-solid fa-hourglass-half" inert></i><span>Runde</span><strong>${game.combat?.round ?? 0}</strong></div></div><div class="tovf-challenge-hud-initiative">${combatants}</div></div>`;
    this.element ??= document.body.appendChild(document.createElement("section"));
    this.element.id = "tovf-challenge-hud";
    this.element.innerHTML = html;
    this.element.onclick = event => void this.#onClick(event);
    this.element.onchange = event => void this.#onChange(event);
    for (const image of this.element.querySelectorAll(".tovf-challenge-hud-combatant article img")) {
      const classify = () => {
        const longest = Math.max(image.naturalWidth, image.naturalHeight);
        image.classList.toggle("is-square", longest > 0 && Math.abs(image.naturalWidth - image.naturalHeight) / longest < 0.12);
      };
      image.addEventListener("load", classify, { once: true });
      if (image.complete) classify();
    }
    for (const drawerElement of this.element.querySelectorAll(".tovf-challenge-hud-drawer")) {
      drawerElement.onpointerleave = () => {
        const name = drawerElement.querySelector("[data-drawer]")?.dataset.drawer;
        if (!name || !this.#drawers[name]) return;
        this.#drawers[name] = false;
        this.render();
      };
    }
    queueMicrotask(() => this.element?.querySelector(".tovf-challenge-hud-initiative .is-active")?.scrollIntoView({ block: "nearest", inline: "center" }));
    return this;
  }

  render() {
    const isGM = game.user.isGM;
    const selected = selectedActorIds();
    const actors = allPlayerActors();
    const turns = game.combat?.turns ?? [];
    const hasCombatants = turns.length > 0;
    const turnIndex = Number.isInteger(game.combat?.turn) ? game.combat.turn : 0;
    const roundIndex = Math.max(0, Number(game.combat?.round) - 1 || 0);
    const carouselStep = hasCombatants ? (roundIndex * turns.length) + turnIndex : 0;
    const carouselOffset = hasCombatants ? Math.max(0, carouselStep - 1) % turns.length : 0;
    const maxInitiativeCards = Math.clamp(
      Math.round(Number(game.settings.get(MODULE_ID, MAX_INITIATIVE_CARDS_SETTING)) || 10),
      1,
      10
    );
    const carouselTurns = hasCombatants
      ? [...turns.slice(carouselOffset), ...turns.slice(0, carouselOffset)].slice(0, maxInitiativeCards)
      : [];
    const previousCarouselStep = this.#carouselCombatId === game.combat?.id ? this.#carouselStep : null;
    const previousCarouselOffset = this.#carouselCombatId === game.combat?.id ? this.#carouselOffset : null;
    const carouselDirection = previousCarouselStep === null || carouselOffset === previousCarouselOffset
      ? ""
      : carouselStep > previousCarouselStep ? " is-advancing" : " is-reversing";
    const showNpcHealth = isGM || game.settings.get(MODULE_ID, SHOW_NPC_HEALTH_SETTING);
    const showOtherPlayerHealth = isGM || game.settings.get(MODULE_ID, SHOW_OTHER_PLAYER_HEALTH_SETTING);
    const { adversaryCount, activeAdversaryCount, maxCR } = encounterStats();
    const escape = value => Handlebars.escapeExpression(String(value ?? ""));
    const localize = key => game.i18n.localize(key);
    const actorRow = actor => `<li><img src="${escape(actor.img)}" alt=""><span>${escape(actor.name)}</span><small><i class="fa-solid fa-shield" inert></i>${escape(actor.system.attributes?.ac?.value ?? "-")}</small><small><i class="fa-solid fa-eye" inert></i>${escape(actor.system.proficiencies?.skills?.perception?.passive ?? actor.system.attributes?.perception ?? "-")}</small><button type="button" data-hud-action="${selected.has(actor.id) ? "remove" : "add"}" data-actor-id="${actor.id}"><i class="fa-solid fa-${selected.has(actor.id) ? "xmark" : "plus"}" inert></i></button></li>`;
    const rollActors = actors.filter(actor => selected.has(actor.id));
    const rollActorSelection = `<div class="tovf-challenge-hud-roll-actors"><span>${localize("TOVF.ChallengeManager.Roll.RequestedFor")}</span><div>${rollActors.map(actor => {
      const included = !this.#excludedRollActorIds.has(actor.id);
      return `<button type="button" class="${included ? "is-selected" : ""}" data-hud-action="toggleRollActor" data-actor-id="${actor.id}" title="${escape(actor.name)}" aria-label="${escape(actor.name)}" aria-pressed="${included}"><img src="${escape(actor.img)}" alt=""></button>`;
    }).join("") || `<small>${localize("TOVF.ChallengeManager.Party.Empty")}</small>`}</div></div>`;
    const combatants = carouselTurns.map(combatant => {
      const actor = combatant.actor;
      const hp = actor?.system.attributes?.hp;
      const hpValue = Number(hp?.value);
      const hpMax = Number(hp?.max);
      const hpRatio = Number.isFinite(hpValue) && Number.isFinite(hpMax) && hpMax > 0
        ? Math.clamp(hpValue / hpMax, 0, 1)
        : null;
      const isOwned = Boolean(actor?.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER));
      const isNpc = Boolean(actor && !actor.hasPlayerOwner);
      const showHealth = hpRatio !== null && (isGM || isOwned || (isNpc ? showNpcHealth : showOtherPlayerHealth));
      const hpColor = showHealth ? healthColor(hpRatio) : null;
      const healthState = hpColor ? " health-visible" : "";
      const healthStyle = hpColor
        ? ` style="--tovf-health-color:${hpColor};--tovf-health-ratio:${hpRatio.toFixed(3)}"`
        : "";
      const portraitSrc = escape(combatant.token?.texture?.src ?? actor?.img);
      const canRollInitiative = combatant.initiative == null && actor
        && (isGM || isOwned);
      const hpControl = isGM && this.#hpCombatantId === combatant.id && actor
        ? `<div class="tovf-challenge-hud-hp-control"><input type="number" min="0" value="1" data-hud-hp-amount><button type="button" data-hud-action="damage" data-actor-id="${actor.id}">&minus;</button><button type="button" data-hud-action="heal" data-actor-id="${actor.id}">+</button></div>`
        : "";
      const gmStats = isGM ? `<div class="tovf-challenge-hud-card-stats"><span><i class="fa-solid fa-shield" inert></i>${escape(actor?.system.attributes?.ac?.value ?? "-")}</span>${hp ? `<button type="button" data-hud-action="hp" data-combatant-id="${combatant.id}"><i class="fa-solid fa-heart" inert></i>${escape(hp.value ?? 0)}</button>` : ""}</div>` : "";
      const initiativeRoll = canRollInitiative ? `<button type="button" class="tovf-challenge-hud-roll-initiative" data-hud-action="rollInitiative" data-actor-id="${actor.id}" title="Initiative würfeln"><i class="fa-solid fa-dice-d20" inert></i></button>` : "";
      return `<div class="tovf-challenge-hud-combatant ${combatant.id === game.combat?.combatant?.id ? "is-active" : ""}${combatant.isDefeated ? " is-defeated" : ""}${healthState}"${healthStyle}><article><img class="portrait-backdrop" src="${portraitSrc}" alt=""><img class="portrait-main" src="${portraitSrc}" alt="${escape(combatant.name ?? actor?.name ?? "")}"><span class="tovf-challenge-hud-initiative-value">${escape(combatant.initiative ?? "-")}</span>${gmStats}${initiativeRoll}</article>${hpControl}</div>`;
    }).join("");
    const drawer = (name, icon, label, content, badge = "", shortLabel = label) => `<section class="tovf-challenge-hud-drawer ${name} ${this.#drawers[name] ? "is-open" : ""}"><button type="button" class="tovf-challenge-hud-toggle" data-hud-action="toggle" data-drawer="${name}" title="${escape(label)}">${icon ? `<i class="fa-solid ${icon}" inert></i>` : ""}<span>${escape(shortLabel)}</span>${badge}</button><div class="tovf-challenge-hud-popover">${content}</div></section>`;
    const party = `<header>${localize("TOVF.ChallengeManager.Party.Title")}</header><ul>${actors.filter(actor => selected.has(actor.id)).map(actorRow).join("") || `<li class="hint">${localize("TOVF.ChallengeManager.Party.Empty")}</li>`}</ul><details><summary>${localize("TOVF.ChallengeManager.Actors.Title")}</summary><ul>${actors.filter(actor => !selected.has(actor.id)).map(actorRow).join("") || `<li class="hint">${localize("TOVF.ChallengeManager.Actors.AllSelected")}</li>`}</ul></details>`;
    const roll = `<header>${localize("TOVF.ChallengeManager.Roll.Title")}</header>${rollActorSelection}<div class="tovf-challenge-hud-roll-selects"><select data-hud-roll-type><option value="skill">${localize("TOVF.ChallengeManager.Roll.Skill")}</option><option value="save">${localize("TOVF.ChallengeManager.Roll.Save")}</option><option value="die">${localize("TOVF.ChallengeManager.Roll.Die")}</option></select><select data-hud-roll-key data-kind="skill">${Object.entries(CONFIG.BlackFlag.skills.localized ?? {}).map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("")}</select><select data-hud-roll-key data-kind="save" hidden>${Object.entries(CONFIG.BlackFlag.abilities.localized ?? {}).map(([value, label]) => `<option value="${escape(value)}">${escape(label)}</option>`).join("")}</select><select data-hud-roll-key data-kind="die" hidden>${[4, 6, 8, 10, 12, 20, 100].map(value => `<option value="${value}">d${value}</option>`).join("")}</select></div><div class="tovf-challenge-hud-roll-options"><label><input type="checkbox" data-hud-average> ${localize("TOVF.ChallengeManager.Roll.ShowAverageShort")}</label><label><input type="checkbox" data-hud-private> ${localize("TOVF.ChallengeManager.Roll.Private")}</label><label data-hud-dc>${localize("TOVF.ChallengeManager.Roll.DCShort")} <input type="number" min="0" max="99" data-hud-roll-dc></label></div><button type="button" data-hud-action="request"><i class="fa-solid fa-message-arrow-up-right" inert></i>${localize("TOVF.ChallengeManager.Roll.Post")}</button>`;
    const doom = `<header class="tovf-challenge-hud-doom-header"><span>${localize("TOVF.ChallengeManager.Doom.Bank")}</span><div class="tovf-challenge-hud-doom-meta"><button type="button" data-hud-action="recalculateDoom" title="${escape(localize("TOVF.ChallengeManager.Doom.Recalculate"))}" aria-label="${escape(localize("TOVF.ChallengeManager.Doom.Recalculate"))}"><i class="fa-solid fa-arrows-rotate" inert></i></button><small>${localize("TOVF.ChallengeManager.Encounter.MaxCR")}: ${escape(formatCR(maxCR))} <i>|</i> ${localize("TOVF.ChallengeManager.Encounter.Adversaries")}: ${activeAdversaryCount}/${adversaryCount}</small></div></header><div class="tovf-challenge-hud-doom-count"><button type="button" data-hud-action="doom" data-amount="-1">&minus;</button><input type="number" min="0" value="${game.settings.get(MODULE_ID, SETTINGS.doom)}" data-hud-doom><button type="button" data-hud-action="doom" data-amount="1">+</button></div><div class="tovf-challenge-hud-doom-actions"><button type="button" data-hud-action="doom" data-amount="-1" data-doom-chat="true" data-doom-icon="fa-thumbs-up">${localize("TOVF.ChallengeManager.Doom.Advantage")}</button><button type="button" data-hud-action="doom" data-amount="-1" data-doom-chat="true" data-doom-icon="fa-thumbs-down">${localize("TOVF.ChallengeManager.Doom.Disadvantage")}</button><button type="button" data-hud-action="doom" data-amount="-2" data-doom-chat="true" data-doom-icon="fa-person-running">${localize("TOVF.ChallengeManager.Doom.ExtraAction")}</button><button type="button" data-hud-action="doom" data-amount="-3" data-doom-chat="true" data-doom-icon="fa-arrows-rotate">${localize("TOVF.ChallengeManager.Doom.Recharge")}</button></div><label><input type="checkbox" data-hud-doom-announce ${game.settings.get(MODULE_ID, SETTINGS.announceDoom) ? "checked" : ""}> ${localize("TOVF.ChallengeManager.Doom.AnnounceCurrent")}</label>`;
    const controls = isGM ? `${drawer("party", "fa-users", localize("TOVF.ChallengeManager.Party.Title"), party)}${drawer("roll", "fa-dice-d20", localize("TOVF.ChallengeManager.Roll.Title"), roll, "", localize("TOVF.ChallengeManager.Roll.Short"))}${drawer("doom", "", localize("TOVF.ChallengeManager.Doom.Bank"), doom, `<b>${game.settings.get(MODULE_ID, SETTINGS.doom)}</b>`)}` : "";
    this.element ??= document.body.appendChild(document.createElement("section"));
    this.element.id = "tovf-challenge-hud";
    const missingNpcInitiative = turns.filter(combatant => combatant.initiative == null && combatant.actor && !combatant.actor.hasPlayerOwner);
    const npcRoll = missingNpcInitiative.length ? `<button type="button" data-hud-action="rollNpcInitiative" title="Initiative für alle NPCs würfeln"><i class="fa-solid fa-dice-d20" inert></i></button>` : "";
    const combatStarted = Boolean(game.combat?.started);
    const turnControls = combatStarted ? `<button type="button" data-hud-action="previousTurn" title="Vorheriger Zug"><i class="fa-solid fa-backward-step" inert></i></button><button type="button" data-hud-action="nextTurn" title="Nächster Zug"><i class="fa-solid fa-forward-step" inert></i></button>` : "";
    const combatToggle = combatStarted
      ? `<button type="button" data-hud-action="endCombat" title="Combat beenden"><i class="fa-solid fa-flag-checkered" inert></i></button>`
      : `<button type="button" data-hud-action="startCombat" title="Combat starten"><i class="fa-solid fa-play" inert></i></button>`;
    const combatControls = isGM && hasCombatants ? `<div class="tovf-challenge-hud-combat-controls">${turnControls}${npcRoll}${combatToggle}</div>` : "";
    const roundCounter = hasCombatants ? `<div class="tovf-challenge-hud-round"><span>Runde</span><div><i class="fa-solid fa-hourglass-half" inert></i><strong>${game.combat?.round ?? 0}</strong></div>${combatControls}</div>` : "";
    const initiativeCarousel = hasCombatants ? `<div class="tovf-challenge-hud-initiative${carouselDirection}">${combatants}</div>` : "";
    this.element.innerHTML = `<div class="tovf-challenge-hud-bar"><div class="tovf-challenge-hud-left">${controls}${roundCounter}</div>${initiativeCarousel}</div>`;
    this.#carouselCombatId = game.combat?.id ?? null;
    this.#carouselStep = hasCombatants ? carouselStep : null;
    this.#carouselOffset = hasCombatants ? carouselOffset : null;
    const navigation = document.querySelector("#navigation, #scene-navigation");
    const navigationItems = [...(navigation?.querySelectorAll("button, a, .scene, .scene-view") ?? [])]
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0 && rect.top < 100 && rect.right < window.innerWidth - 200);
    const navigationBounds = navigation?.getBoundingClientRect();
    const navigationRight = navigationItems.length ? Math.max(...navigationItems.map(rect => rect.right)) : Math.min(navigationBounds?.right ?? 64, 220);
    const navigationTop = navigationItems.length ? Math.min(...navigationItems.map(rect => rect.top)) : navigationBounds?.top ?? 6;
    this.element.style.left = `${Math.ceil(navigationRight + 8)}px`;
    this.element.style.top = `${Math.ceil(navigationTop)}px`;
    this.element.onclick = event => void this.#onClick(event);
    this.element.onchange = event => void this.#onChange(event);
    for (const image of this.element.querySelectorAll(".tovf-challenge-hud-combatant .portrait-main")) {
      const classify = () => {
        const longest = Math.max(image.naturalWidth, image.naturalHeight);
        image.classList.toggle("is-square", longest > 0 && Math.abs(image.naturalWidth - image.naturalHeight) / longest < 0.12);
      };
      image.addEventListener("load", classify, { once: true });
      if (image.complete) classify();
    }
    for (const drawerElement of this.element.querySelectorAll(".tovf-challenge-hud-drawer")) {
      drawerElement.onpointerleave = () => {
        const name = drawerElement.querySelector("[data-drawer]")?.dataset.drawer;
        if (!name || !this.#drawers[name]) return;
        this.#drawers[name] = false;
        this.render();
      };
    }
    return this;
  }

  async #onClick(event) {
    const button = event.target.closest("button[data-hud-action]");
    if (!button) return;
    const action = button.dataset.hudAction;
    if (action === "toggle") { this.#drawers[button.dataset.drawer] = !this.#drawers[button.dataset.drawer]; this.render(); return; }
    if (action === "startCombat") { await game.combat?.startCombat(); return; }
    if (action === "previousTurn") { await game.combat?.previousTurn(); return; }
    if (action === "nextTurn") { await game.combat?.nextTurn(); return; }
    if (action === "endCombat") { await game.combat?.endCombat(); return; }
    if (action === "rollInitiative") {
      const actor = game.actors.get(button.dataset.actorId);
      if (!actor || (!game.user.isGM && !actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))) return;
      await actor.rollInitiative({ rerollInitiative: false, createCombatants: false });
      return;
    }
    if (action === "rollNpcInitiative") {
      if (!game.user.isGM || !game.combat) return;
      const ids = game.combat.combatants.filter(combatant => combatant.initiative == null && combatant.actor && !combatant.actor.hasPlayerOwner).map(combatant => combatant.id);
      if (ids.length) await game.combat.rollInitiative(ids);
      return;
    }
    if (action === "hp") { this.#hpCombatantId = this.#hpCombatantId === button.dataset.combatantId ? null : button.dataset.combatantId; this.render(); return; }
    if (action === "toggleRollActor") {
      const actorId = button.dataset.actorId;
      if (this.#excludedRollActorIds.has(actorId)) this.#excludedRollActorIds.delete(actorId);
      else this.#excludedRollActorIds.add(actorId);
      const included = !this.#excludedRollActorIds.has(actorId);
      button.classList.toggle("is-selected", included);
      button.setAttribute("aria-pressed", String(included));
      return;
    }
    const selected = selectedActorIds();
    if (action === "add" || action === "remove") { action === "add" ? selected.add(button.dataset.actorId) : selected.delete(button.dataset.actorId); await saveSelectedActors([...selected]); this.render(); return; }
    if (action === "connected") { for (const actor of connectedPlayerActors()) selected.add(actor.id); await saveSelectedActors([...selected]); this.render(); return; }
    if (action === "session") { await synchronizePartyWithActiveSession(); this.render(); return; }
    if (action === "recalculateDoom") {
      try {
        await initializeCombatDoom(game.combat, { force: true });
      } catch (error) {
        console.error(`${MODULE_ID} | Could not recalculate Doom Bank`, error);
        ui.notifications.error(game.i18n.localize("TOVF.ChallengeManager.Doom.RecalculateFailed"));
      }
      this.render();
      return;
    }
    if (action === "doom") {
      const next = Math.max(0, game.settings.get(MODULE_ID, SETTINGS.doom) + Number(button.dataset.amount));
      await setDoom(next);
      if (button.dataset.doomChat === "true") {
        const current = game.settings.get(MODULE_ID, SETTINGS.announceDoom) ? `<div class="tovf-doom-chat-total"><span>${Handlebars.escapeExpression(game.i18n.localize("TOVF.ChallengeManager.Doom.Remaining"))}</span><strong>${next}</strong></div>` : "";
        await ChatMessage.create({ speaker: ChatMessage.getSpeaker(), content: `<section class="tovf-doom-chat"><header><i class="fa-solid fa-skull-crossbones" inert></i><span>${Handlebars.escapeExpression(game.i18n.localize("TOVF.ChallengeManager.Doom.Bank"))}</span></header><div class="tovf-doom-chat-action"><i class="fa-solid ${button.dataset.doomIcon}" inert></i><strong>${Handlebars.escapeExpression(button.textContent.trim())}</strong></div>${current}</section>` });
      }
      this.render();
      return;
    }
    if (action === "damage" || action === "heal") {
      const actor = game.actors.get(button.dataset.actorId);
      const amount = Math.max(0, Number(button.closest(".tovf-challenge-hud-combatant")?.querySelector("[data-hud-hp-amount]")?.value) || 0);
      const hp = actor?.system.attributes?.hp;
      if (!actor || !hp) return;
      const value = action === "damage" ? Math.max(0, Number(hp.value) - amount) : Math.min(Number(hp.max ?? Infinity), Number(hp.value) + amount);
      await actor.update({ "system.attributes.hp.value": value });
      this.render();
      return;
    }
    if (action === "request") {
      const type = this.element.querySelector("[data-hud-roll-type]").value;
      const key = this.element.querySelector(`[data-hud-roll-key][data-kind="${type}"]`).value;
      const actorIds = [...selected].filter(actorId => !this.#excludedRollActorIds.has(actorId));
      await createRollRequest({ actorIds, type, key, dc: type === "die" ? null : Number(this.element.querySelector("[data-hud-roll-dc]").value) || null, showAverage: this.element.querySelector("[data-hud-average]").checked, privateRoll: this.element.querySelector("[data-hud-private]").checked });
    }
  }

  async #onChange(event) {
    if (event.target.matches("[data-hud-doom]")) { await setDoom(event.target.value); this.render(); return; }
    if (event.target.matches("[data-hud-doom-announce]")) { await game.settings.set(MODULE_ID, SETTINGS.announceDoom, event.target.checked); return; }
    if (!event.target.matches("[data-hud-roll-type]")) return;
    const type = event.target.value;
    for (const select of this.element.querySelectorAll("[data-hud-roll-key]")) select.hidden = select.dataset.kind !== type;
    this.element.querySelector("[data-hud-dc]").hidden = type === "die";
  }

  close() {
    this.element?.remove();
    this.element = null;
    syncChallengeHudButtons();
  }
}

function syncChallengeHudButtons() {
  const active = panel?.rendered === true;
  for (const button of document.querySelectorAll("[data-tovf-challenge-manager]")) {
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

async function openPanel() {
  if (game.user.isGM) await synchronizePartyWithActiveSession();
  panel ??= new ChallengeHud();
  panel.render();
  syncChallengeHudButtons();
}

function toggleChallengeHud() {
  if (panel?.rendered) {
    panel.close();
    return;
  }
  return openPanel();
}

export function openChallengeManager() {
  return toggleChallengeHud();
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
    tracker.setAttribute("aria-pressed", String(panel?.rendered === true));
    tracker.classList.toggle("active", panel?.rendered === true);
    tracker.addEventListener("click", toggleChallengeHud);
    controls.append(tracker);
  }
  if (controls.childElementCount) header.append(controls);
}

function activeGM() {
  const configured = typeof game.users.activeGM === "function"
    ? game.users.activeGM()
    : game.users.activeGM;
  return configured ?? game.users.find(user => user.active && user.isGM);
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
  game.settings.registerMenu(MODULE_ID, "challengeHud", {
    name: "TOVF.ChallengeManager.Settings.Menu.Name",
    label: "TOVF.ChallengeManager.Settings.Menu.Label",
    hint: "TOVF.ChallengeManager.Settings.Menu.Hint",
    icon: "fa-solid fa-swords",
    type: ChallengeHudSettings,
    restricted: false
  });
  game.settings.register(MODULE_ID, AUTO_OPEN_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    name: "TOVF.ChallengeManager.Settings.AutoOpen.Name",
    hint: "TOVF.ChallengeManager.Settings.AutoOpen.Hint"
  });
  game.settings.register(MODULE_ID, SHOW_NPC_HEALTH_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    name: "TOVF.ChallengeManager.Settings.ShowNpcHealth.Name",
    hint: "TOVF.ChallengeManager.Settings.ShowNpcHealth.Hint",
    onChange: () => void refreshPanel()
  });
  game.settings.register(MODULE_ID, SHOW_OTHER_PLAYER_HEALTH_SETTING, {
    scope: "world",
    config: false,
    type: Boolean,
    default: true,
    name: "TOVF.ChallengeManager.Settings.ShowOtherPlayerHealth.Name",
    hint: "TOVF.ChallengeManager.Settings.ShowOtherPlayerHealth.Hint",
    onChange: () => void refreshPanel()
  });
  game.settings.register(MODULE_ID, MAX_INITIATIVE_CARDS_SETTING, {
    scope: "client",
    config: false,
    type: Number,
    default: 10,
    range: { min: 1, max: 10, step: 1 },
    name: "TOVF.ChallengeManager.Settings.MaxInitiativeCards.Name",
    hint: "TOVF.ChallengeManager.Settings.MaxInitiativeCards.Hint",
    onChange: () => void refreshPanel()
  });
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
      onChange: () => void refreshPanel()
    });
  }

  Hooks.on("renderCombatTracker", addDoomButtons);
  Hooks.on("renderChatMessageHTML", activateRollRequests);
  Hooks.on("updateChatMessage", refreshRollRequestMessage);
  Hooks.on("createChatMessage", recordCreatedChallengeRoll);
  Hooks.on("updateSetting", setting => {
    if (setting.key !== `${MODULE_ID}.${ACTIVE_SESSION_SETTING}`) return;
    if (activeGM()?.id === game.user.id) void synchronizePartyWithActiveSession();
    void refreshPanel();
  });
  for (const hook of ["createCombat", "updateCombat", "updateCombatant", "deleteCombatant"]) {
    Hooks.on(hook, () => void refreshPanel());
  }
  Hooks.on("updateActor", (actor, changes) => {
    const activityPath = `flags.${MODULE_ID}.active`;
    const activityChanged = Object.hasOwn(changes, activityPath) || foundry.utils.hasProperty(changes, activityPath);
    const isCombatant = game.combat?.combatants.some(combatant => combatant.actor?.id === actor.id);
    if (activityChanged || isCombatant) void refreshPanel();
  });
  Hooks.on("createCombatant", () => {
    if (game.settings.get(MODULE_ID, AUTO_OPEN_SETTING)) void openPanel();
    else void refreshPanel();
  });
  Hooks.on("combatEnd", async () => {
    initializedDoomCombatId = null;
    pendingDoomCombatId = null;
    void refreshPanel();
    if (activeGM()?.id !== game.user.id) return;
    await game.settings.set(MODULE_ID, SETTINGS.active, false);
    await setDoom(0);
  });
  Hooks.on("updateCombat", (combat, changes) => {
    const startedNow = Number(changes.round) === 1 && Number(changes.turn ?? combat?.turn) === 0;
    if (pendingDoomCombatId === combat?.id || startedNow) {
      requestCombatDoomInitialization(combat);
    }
    if (changes.active === false || changes.started === false || combat?.started === false) void refreshPanel();
  });
  game.socket.on(`module.${MODULE_ID}`, socketMessage => {
    if (socketMessage.type !== "challengeRollResult") return;
    if (activeGM()?.id !== game.user.id) return;
    queueRollResult({ ...socketMessage.payload, userId: socketMessage.userId });
  });

  Hooks.on("combatStart", combat => {
    pendingDoomCombatId = combat.id;
    initializedDoomCombatId = null;
    if (game.settings.get(MODULE_ID, AUTO_OPEN_SETTING)) void openPanel();
  });
  Hooks.on("deleteCombat", async () => {
    initializedDoomCombatId = null;
    pendingDoomCombatId = null;
    queueMicrotask(() => void refreshPanel());
    if (game.user.isGM) {
      await game.settings.set(MODULE_ID, SETTINGS.active, false);
      await setDoom(0);
    }
  });
}

export function activateChallengeManager() {
  panel ??= game.user.isGM ? new ChallengeHud() : null;
  if ((game.combat?.turns?.length ?? 0) > 0 && game.settings.get(MODULE_ID, AUTO_OPEN_SETTING)) void openPanel();
  game.modules.get(MODULE_ID).api ??= {};
  Object.assign(game.modules.get(MODULE_ID).api, {
    openChallengeManager: openPanel,
    openDoomPanel: openPanel,
    requestRoll: createRollRequest
  });
}
