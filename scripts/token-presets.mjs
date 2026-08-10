import { MODULE_ID } from "./core/constants.mjs";

const FLAG = "tokenPresets";
const SOCKET_SCOPE = "token-presets";
const pending = new Map();

function baseActor(token) {
  return token?.baseActor ?? game.actors.get(token?.actorId) ?? token?.actor;
}

function activeGM() {
  return game.users.activeGM ?? game.users.find(user => user.active && user.isGM);
}

function cleanPreset(source = {}) {
  return {
    id: String(source.id || foundry.utils.randomID()),
    name: String(source.name || "Token").trim().slice(0, 80),
    tokenName: String(source.tokenName ?? "").trim().slice(0, 120),
    image: String(source.image || CONST.DEFAULT_TOKEN).trim(),
    scale: Math.clamp(Number(source.scale) || 1, 0.1, 3),
    width: Math.clamp(Number(source.width) || 1, 0.5, 20),
    height: Math.clamp(Number(source.height) || 1, 0.5, 20)
  };
}

async function authorize(userId, { actorUuid, tokenUuid }) {
  const user = game.users.get(userId);
  const actor = await fromUuid(actorUuid);
  const token = tokenUuid ? await fromUuid(tokenUuid) : null;
  const ownsActor = actor?.testUserPermission?.(user, "OWNER")
    || user?.character?.uuid === actor?.uuid;
  const ownsTokenActor = token?.actor?.testUserPermission?.(user, "OWNER");
  if (!user || !actor || (!user.isGM && !ownsActor && !ownsTokenActor)) {
    throw new Error("Du besitzt diesen Charakter nicht.");
  }
  if (token && baseActor(token)?.uuid !== actor.uuid) throw new Error("Token und Charakter stimmen nicht überein.");
  return { actor, token };
}

async function execute(action, payload, userId = game.user.id) {
  const { actor, token } = await authorize(userId, payload);
  if (action === "save") {
    const presets = Array.isArray(payload.presets) ? payload.presets.slice(0, 30).map(cleanPreset) : [];
    await actor.setFlag(MODULE_ID, FLAG, presets);
    return presets;
  }
  if (action === "apply") {
    if (!token) throw new Error("Der Token wurde nicht gefunden.");
    const preset = (actor.getFlag(MODULE_ID, FLAG) ?? []).find(entry => entry.id === payload.presetId);
    if (!preset) throw new Error("Das Token-Preset wurde nicht gefunden.");
    const clean = cleanPreset(preset);
    const changes = {
      "texture.src": clean.image,
      "texture.scaleX": clean.scale,
      "texture.scaleY": clean.scale,
      width: clean.width,
      height: clean.height,
      [`flags.${MODULE_ID}.activeTokenPreset`]: clean.id
    };
    if (clean.tokenName) changes.name = clean.tokenName;
    await token.update(changes);
    return true;
  }
  throw new Error("Unbekannte Token-Preset-Aktion.");
}

async function request(action, payload) {
  if (game.user.isGM) return execute(action, payload);
  const gm = activeGM();
  if (!gm) throw new Error("Zum Ändern der Token-Presets muss eine Spielleitung verbunden sein.");
  const requestId = foundry.utils.randomID();
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Die Spielleitung hat nicht auf die Token-Preset-Anfrage geantwortet."));
    }, 8000);
    pending.set(requestId, {
      resolve: result => { clearTimeout(timeout); resolve(result); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(`module.${MODULE_ID}`, {
    scope: SOCKET_SCOPE,
    type: "request",
    requestId,
    userId: game.user.id,
    targetGMId: gm.id,
    action,
    payload
  });
  return promise;
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
class TokenPresetApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-token-presets", tag: "form", classes: ["tovf-token-presets"],
    position: { width: 680, height: "auto" },
    window: { title: "Token-Presets", icon: "fa-solid fa-images", resizable: true },
    actions: {
      add: this.#add,
      chooseImage: this.#chooseImage,
      save: this.#save,
      apply: this.#apply,
      remove: this.#remove
    }
  };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/token-presets.hbs` } };
  constructor(token, options = {}) {
    super(options);
    this.token = token;
    this.actor = baseActor(token);
    this.presets = foundry.utils.deepClone(this.actor?.getFlag(MODULE_ID, FLAG) ?? []);
  }
  _onRender(context, options) {
    super._onRender(context, options);
    const list = this.element.querySelector(".tovf-token-preset-list");
    let dragged = null;
    for (const row of this.element.querySelectorAll("[data-preset]")) {
      const updatePreview = () => {
        const scale = Math.clamp(Number(row.querySelector('[name="scale"]')?.value) || 1, 0.1, 3);
        const width = Math.clamp(Number(row.querySelector('[name="width"]')?.value) || 1, 0.5, 20);
        const height = Math.clamp(Number(row.querySelector('[name="height"]')?.value) || 1, 0.5, 20);
        const preview = row.querySelector(".tovf-token-preset-image");
        preview?.style.setProperty("--token-scale", scale);
        preview?.style.setProperty("--token-width", width);
        preview?.style.setProperty("--token-height", height);
      };
      for (const input of row.querySelectorAll('[name="scale"], [name="width"], [name="height"]')) {
        input.addEventListener("input", updatePreview);
      }
      updatePreview();
      const handle = row.querySelector(".tovf-token-preset-drag");
      handle?.addEventListener("pointerdown", () => row.draggable = true);
      handle?.addEventListener("pointerup", () => row.draggable = false);
      row.addEventListener("dragstart", event => {
        if (!row.draggable) return event.preventDefault();
        dragged = row;
        row.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", row.dataset.preset);
      });
      row.addEventListener("dragend", () => {
        row.draggable = false;
        row.classList.remove("dragging");
        dragged = null;
        this.presets = this._presetsFromForm();
      });
    }
    list?.addEventListener("dragover", event => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      const target = event.target.closest("[data-preset]");
      if (!target || target === dragged) return;
      const before = event.clientY < target.getBoundingClientRect().top + (target.offsetHeight / 2);
      list.insertBefore(dragged, before ? target : target.nextSibling);
    });
    list?.addEventListener("drop", event => event.preventDefault());
  }
  _presetsFromForm() {
    return [...this.element.querySelectorAll("[data-preset]")].map(row => cleanPreset({
      id: row.dataset.preset, name: row.querySelector('[name="name"]')?.value,
      tokenName: row.querySelector('[name="tokenName"]')?.value,
      image: row.querySelector('[name="image"]')?.value, scale: row.querySelector('[name="scale"]')?.value,
      width: row.querySelector('[name="width"]')?.value, height: row.querySelector('[name="height"]')?.value
    }));
  }
  async _prepareContext() {
    return { presets: this.presets, current: {
      image: this.token.texture.src, scale: Math.abs(this.token.texture.scaleX), width: this.token.width, height: this.token.height
    }};
  }
  async _savePresets() {
    const presets = this._presetsFromForm();
    if (this.actor.isOwner) await this.actor.setFlag(MODULE_ID, FLAG, presets);
    else await request("save", { actorUuid: this.actor.uuid, tokenUuid: this.token.uuid, presets });
    this.presets = foundry.utils.deepClone(presets);
    return presets;
  }
  async _handle(operation) {
    try { return await operation(); }
    catch (error) {
      console.error(`${MODULE_ID} | Token preset operation failed`, error);
      ui.notifications.error(error.message);
      return null;
    }
  }
  static async #add(event) {
    event.preventDefault();
    const presets = this._presetsFromForm();
    presets.push(cleanPreset({ name: `Preset ${presets.length + 1}`, tokenName: this.token.name, image: this.token.texture.src,
      scale: Math.abs(this.token.texture.scaleX), width: this.token.width, height: this.token.height }));
    this.presets = presets;
    await this.render({ force: true });
  }
  static #chooseImage(event, target) {
    event.preventDefault();
    const row = target.closest("[data-preset]");
    const input = row?.querySelector('[name="image"]');
    const preview = target.querySelector("img");
    if (!row || !input || !preview) return;
    const Picker = foundry.applications.apps.FilePicker.implementation;
    new Picker({
      type: "image",
      current: input.value || this.token.texture.src,
      callback: path => {
        input.value = path;
        preview.src = path;
        this.presets = this._presetsFromForm();
      }
    }).render(true);
  }
  static async #save(event) { event.preventDefault(); await this._handle(async () => { await this._savePresets(); ui.notifications.info("Token-Presets gespeichert."); }); }
  static async #apply(event, target) {
    event.preventDefault();
    await this._handle(async () => {
      const presets = await this._savePresets();
      const presetId = target.closest("[data-preset]").dataset.preset;
      const preset = presets.find(entry => entry.id === presetId);
      await request("apply", {
        actorUuid: this.actor.uuid,
        tokenUuid: this.token.uuid,
        presetId,
        preset
      });
      ui.notifications.info("Token-Preset aktiviert.");
    });
  }
  static async #remove(event, target) {
    event.preventDefault();
    await this._handle(async () => {
      target.closest("[data-preset]").remove();
      await this._savePresets();
    });
  }
}

export function registerTokenPresets() {
  Hooks.on("renderTokenHUD", (app, html) => {
    const token = app.object?.document;
    const actor = baseActor(token);
    if (!token || !actor?.isOwner) return;
    const right = html.querySelector?.(".col.right") ?? html[0]?.querySelector?.(".col.right");
    if (!right || right.querySelector('[data-tovf-token-presets]')) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "control-icon";
    button.dataset.tovfTokenPresets = "true";
    button.dataset.tooltip = "";
    button.setAttribute("aria-label", "Token-Presets");
    button.innerHTML = '<i class="fa-solid fa-images" inert></i>';
    button.addEventListener("click", event => { event.preventDefault(); new TokenPresetApp(token).render({ force: true }); });
    right.prepend(button);
  });
}

export function activateTokenPresetSocket() {
  game.socket.on(`module.${MODULE_ID}`, message => {
    if (message.scope !== SOCKET_SCOPE) return;
    if (message.type === "response") {
      const entry = pending.get(message.requestId);
      if (!entry || message.targetUserId !== game.user.id) return;
      pending.delete(message.requestId);
      message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.result);
      return;
    }
    if (message.type !== "request" || message.targetGMId !== game.user.id || activeGM()?.id !== game.user.id) return;
    execute(message.action, message.payload, message.userId)
      .then(result => game.socket.emit(`module.${MODULE_ID}`, { scope: SOCKET_SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, result }))
      .catch(error => game.socket.emit(`module.${MODULE_ID}`, { scope: SOCKET_SCOPE, type: "response", requestId: message.requestId, targetUserId: message.userId, error: error.message }));
  });
}
