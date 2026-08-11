import { MODULE_ID } from "./core/constants.mjs";

const FLAG = "simpleTileTrigger";
const SPAWN_FLAG = "playerSpawn";
const ACTION_TYPES = new Set(["spawnCharacter", "removeSpawned", "viewScene", "executeMacro"]);
const running = new Set();
const LAYER_PATCH = Symbol.for(`${MODULE_ID}.simpleTileTriggerLayerPatch`);
const SOCKET_SCOPE = "simple-tile-triggers";
const pendingGMExecutions = new Map();
let socketInstalled = false;

function cleanAction(source = {}) {
  const type = ACTION_TYPES.has(source.type) ? source.type : "spawnCharacter";
  const action = { id: String(source.id || foundry.utils.randomID()), type };
  if (type === "spawnCharacter") {
    action.x = Number.isFinite(Number(source.x)) ? Number(source.x) : 0;
    action.y = Number.isFinite(Number(source.y)) ? Number(source.y) : 0;
  }
  if (type === "viewScene") {
    action.sceneUuid = String(source.sceneUuid ?? "");
    action.sceneName = String(source.sceneName ?? "");
  }
  if (type === "executeMacro") {
    action.macroUuid = String(source.macroUuid ?? "");
    action.macroName = String(source.macroName ?? "");
    action.arguments = typeof source.arguments === "string" ? source.arguments : JSON.stringify(source.arguments ?? {});
    action.runAsGM = source.runAsGM === true;
  }
  return action;
}

function tileConfiguration(tile) {
  const source = tile?.getFlag(MODULE_ID, FLAG) ?? {};
  return {
    version: 1,
    enabled: source.version === 1 ? source.enabled !== false : true,
    trigger: source.trigger === "click" ? "click" : "dblclick",
    actions: Array.isArray(source.actions) ? source.actions.slice(0, 30).map(cleanAction) : [],
    allowedActorIds: Array.isArray(source.allowedActorIds) ? [...new Set(source.allowedActorIds.map(String))].slice(0, 100) : []
  };
}

function normalizeFlagData(document, changes) {
  const path = `flags.${MODULE_ID}.${FLAG}`;
  const value = foundry.utils.getProperty(changes, path);
  if (typeof value !== "string") return;
  try {
    const parsed = JSON.parse(value);
    const config = {
      version: 1,
      enabled: parsed?.enabled !== false,
      trigger: parsed?.trigger === "click" ? "click" : "dblclick",
      actions: Array.isArray(parsed?.actions) ? parsed.actions.slice(0, 30).map(cleanAction) : [],
      allowedActorIds: Array.isArray(parsed?.allowedActorIds) ? [...new Set(parsed.allowedActorIds.map(String))].slice(0, 100) : []
    };
    foundry.utils.setProperty(changes, path, config);
    if (config.enabled && document.getFlag("monks-active-tiles", "active") === true) {
      foundry.utils.setProperty(changes, "flags.monks-active-tiles.active", false);
    }
  } catch {
    document.updateSource({ [path]: tileConfiguration(document) });
    foundry.utils.deleteProperty(changes, path);
  }
}

function escapeHtml(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function pointWithinTile(tile, point) {
  const object = tile?.object;
  return object?.bounds?.contains?.(point.x, point.y) === true;
}

function clickedTile(point, triggerType) {
  return canvas.scene?.tiles
    ?.filter(tile => {
      const config = tileConfiguration(tile);
      return config.enabled && config.trigger === triggerType
        && (!tile.hidden || game.user.isGM) && pointWithinTile(tile, point);
    })
    .sort((left, right) => (right.sort ?? right.z ?? 0) - (left.sort ?? left.z ?? 0))[0];
}

function activeGM() {
  return game.users.activeGM ?? game.users.find(user => user.active && user.isGM);
}

function canUseTrigger(config, user = game.user) {
  if (user?.isGM || !config.allowedActorIds.length) return true;
  return config.allowedActorIds.some(id => game.actors.get(id)?.testUserPermission(user, "OWNER") === true);
}

async function selectOwnedActor(config) {
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const actors = game.actors
    .filter(actor => actor.testUserPermission(game.user, owner)
      && (!config.allowedActorIds.length || config.allowedActorIds.includes(actor.id)))
    .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
  if (!actors.length) throw new Error("Du besitzt keine Charaktere.");
  const options = actors.map(actor => `<option value="${actor.id}">${escapeHtml(actor.name)}</option>`).join("");
  const actorId = await foundry.applications.api.DialogV2.prompt({
    window: { title: "Charakter auswählen" },
    content: `<div class="form-group"><label for="tovf-spawn-actor">Charakter</label><select id="tovf-spawn-actor" name="actorId">${options}</select></div>`,
    ok: { label: "Spawnen", callback: (_event, button) => button.form.elements.actorId.value },
    rejectClose: false
  });
  return actorId ? game.actors.get(actorId) : null;
}

async function spawnCharacter(action, config) {
  const actor = await selectOwnedActor(config);
  if (!actor) return;
  if (canvas.scene.tokens.some(token => token.actorId === actor.id)) {
    throw new Error(`${actor.name} befindet sich bereits auf dieser Szene.`);
  }
  const token = await actor.getTokenDocument({
    x: action.x,
    y: action.y,
    flags: { [MODULE_ID]: { [SPAWN_FLAG]: { userId: game.user.id } } }
  });
  await canvas.scene.createEmbeddedDocuments("Token", [token.toObject()]);
}

async function removeSpawnedTokens() {
  const ids = canvas.scene.tokens.filter(token => (
    token.getFlag(MODULE_ID, SPAWN_FLAG)?.userId === game.user.id
    || token.getFlag("world", SPAWN_FLAG)?.userId === game.user.id
  )).map(token => token.id);
  if (ids.length) await canvas.scene.deleteEmbeddedDocuments("Token", ids);
}

async function viewScene(action) {
  if (!action.sceneUuid) throw new Error("Für diese Aktion wurde keine Zielszene festgelegt.");
  const scene = await fromUuid(action.sceneUuid);
  if (scene?.documentName !== "Scene") throw new Error("Die Zielszene wurde nicht gefunden.");
  if (!scene.testUserPermission(game.user, "OBSERVER")) throw new Error("Du darfst diese Szene nicht ansehen.");
  await scene.view();
}

async function executeMacroLocal(action, tile, { user = game.user, actor = null, token = null, scene = null } = {}) {
  if (!action.macroUuid) throw new Error("Für diese Aktion wurde kein Makro festgelegt.");
  const macro = await fromUuid(action.macroUuid);
  if (macro?.documentName !== "Macro") throw new Error("Das hinterlegte Makro wurde nicht gefunden.");
  let args;
  try {
    args = JSON.parse(action.arguments?.trim() || "{}");
  } catch (error) {
    throw new Error(`Die Makro-Arguments sind kein gültiges JSON: ${error.message}`);
  }
  token ??= canvas.tokens?.controlled?.[0] ?? null;
  actor ??= token?.actor ?? user?.character ?? null;
  scene ??= tile?.parent ?? canvas.scene;
  const named = foundry.utils.isPlainObject(args)
    ? Object.fromEntries(Object.entries(args).filter(([key]) => /^[A-Za-z_$][\w$]*$/.test(key)))
    : {};
  return macro.execute({
    ...named,
    args,
    tile,
    scene,
    triggeringUser: user,
    triggeringUserId: user.id,
    actor,
    token
  });
}

async function executeMacroAsGM(action, tile) {
  if (game.user.isGM) return executeMacroLocal(action, tile);
  const gm = activeGM();
  if (!gm) throw new Error("Für diese Makro-Aktion muss eine Spielleitung verbunden sein.");
  const requestId = foundry.utils.randomID();
  const controlled = canvas.tokens?.controlled?.[0] ?? null;
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingGMExecutions.delete(requestId);
      reject(new Error("Die Spielleitung hat nicht auf die Makro-Anfrage geantwortet."));
    }, 10000);
    pendingGMExecutions.set(requestId, {
      resolve: () => { clearTimeout(timeout); resolve(true); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(`module.${MODULE_ID}`, {
    scope: SOCKET_SCOPE,
    type: "request",
    requestId,
    targetGMId: gm.id,
    userId: game.user.id,
    tileUuid: tile.uuid,
    actionId: action.id,
    sceneId: canvas.scene?.id ?? null,
    tokenUuid: controlled?.document?.uuid ?? null,
    actorUuid: controlled?.actor?.uuid ?? game.user.character?.uuid ?? null
  });
  return promise;
}

async function executeMacro(action, tile) {
  return action.runAsGM ? executeMacroAsGM(action, tile) : executeMacroLocal(action, tile);
}

async function trigger(tile) {
  if (running.has(tile.uuid)) return;
  running.add(tile.uuid);
  try {
    const config = tileConfiguration(tile);
    if (!canUseTrigger(config)) throw new Error("Keiner deiner Charaktere darf diesen Auslöser verwenden.");
    for (const action of config.actions) {
      if (action.type === "spawnCharacter") await spawnCharacter(action, config);
      else if (action.type === "removeSpawned") await removeSpawnedTokens();
      else if (action.type === "viewScene") await viewScene(action);
      else if (action.type === "executeMacro") await executeMacro(action, tile);
    }
  } catch (error) {
    console.error(`${MODULE_ID} | Simple tile trigger failed`, error);
    ui.notifications.error(error.message);
  } finally {
    running.delete(tile.uuid);
  }
}

function readEditor(app) {
  const field = app.element.querySelector(`[name="flags.${MODULE_ID}.${FLAG}"]`);
  try { return JSON.parse(field?.value || "{}"); }
  catch { return tileConfiguration(app.document); }
}

function synchronizeEditor(app) {
  const config = readEditor(app);
  const root = app.element.querySelector("[data-tovf-tile-actions]");
  config.enabled = root?.querySelector("[data-tovf-enabled]")?.checked === true;
  config.trigger = root?.querySelector("[data-tovf-trigger]")?.value === "click" ? "click" : "dblclick";
  config.allowedActorIds = Array.isArray(config.allowedActorIds) ? config.allowedActorIds.map(String) : [];
  config.actions = (config.actions ?? []).map(cleanAction);
  for (const row of root?.querySelectorAll("[data-action-id]") ?? []) {
    const action = config.actions.find(entry => entry.id === row.dataset.actionId);
    if (!action) continue;
    for (const input of row.querySelectorAll("[data-action-field]")) {
      action[input.dataset.actionField] = input.dataset.actionFieldType === "checkbox"
        ? input.checked
        : input.dataset.actionFieldType === "text" ? input.value : Number(input.value) || 0;
    }
  }
  const field = root?.querySelector(`[name="flags.${MODULE_ID}.${FLAG}"]`);
  if (field) field.value = JSON.stringify(config);
  app._tovfSimpleTileConfig = config;
  return config;
}

async function renderEditor(app, config) {
  app._tovfSimpleTileConfig = {
    version: 1,
    enabled: config.enabled === true,
    trigger: config.trigger === "click" ? "click" : "dblclick",
    actions: config.actions.map(cleanAction),
    allowedActorIds: Array.isArray(config.allowedActorIds) ? config.allowedActorIds.map(String) : []
  };
  app.tabGroups.sheet = "tovfActions";
  await app.render({ force: true });
}

async function selectTriggerCharacters(currentIds = []) {
  const selected = new Set(currentIds);
  const actors = game.actors.filter(actor => actor.type === "pc")
    .sort((left, right) => left.name.localeCompare(right.name, game.i18n.lang));
  const players = game.users.filter(user => !user.isGM && actors.some(actor => actor.testUserPermission(user, "OWNER")));
  const folders = [...new Map(actors.map(actor => [actor.folder?.id ?? "", actor.folder?.name ?? "Ohne Ordner"])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1], game.i18n.lang));
  const connectedIds = new Set(actors.filter(actor => game.users.some(user => user.active && !user.isGM && actor.testUserPermission(user, "OWNER"))).map(actor => actor.id));
  const tokenIds = new Set((canvas?.tokens?.controlled ?? []).map(token => token.actor?.id).filter(Boolean));
  const esc = escapeHtml;
  const rows = actors.map(actor => {
    const ownerIds = players.filter(user => actor.testUserPermission(user, "OWNER")).map(user => user.id);
    return `<label data-trigger-actor data-search="${esc(actor.name.toLocaleLowerCase())}" data-folder="${actor.folder?.id ?? ""}" data-owners="${ownerIds.join(",")}" data-connected="${connectedIds.has(actor.id)}"><input type="checkbox" name="actors" value="${actor.id}" ${selected.has(actor.id) ? "checked" : ""}><img src="${esc(actor.img)}" alt=""><span><strong>${esc(actor.name)}</strong><small>${esc(actor.folder?.name ?? "Ohne Ordner")}</small></span></label>`;
  }).join("");
  const content = `<div class="tovf-trigger-character-picker"><div class="tovf-trigger-character-filters"><label><i class="fa-solid fa-magnifying-glass"></i><input type="search" data-trigger-search placeholder="Charaktere durchsuchen …" autocomplete="off"></label><select data-trigger-player><option value="">Alle Spieler</option>${players.map(user => `<option value="${user.id}">${esc(user.name)}</option>`).join("")}</select><select data-trigger-folder><option value="*">Alle Ordner</option>${folders.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("")}</select></div><div class="tovf-actor-selection-actions"><button type="button" data-picker-mode="all"><i class="fa-solid fa-check-double"></i> Alle</button><button type="button" data-picker-mode="none"><i class="fa-solid fa-xmark"></i> Keine</button><button type="button" data-picker-mode="connected"><i class="fa-solid fa-users"></i> Verbundene Spieler</button><button type="button" data-picker-mode="tokens"><i class="fa-solid fa-location-dot"></i> Ausgewählte Token</button></div><p class="hint">Ohne Auswahl können alle Spieler den Trigger benutzen. Ansonsten genügt der Besitz eines ausgewählten Charakters.</p><div class="tovf-actor-list">${rows || "<p>Keine Spielercharaktere vorhanden.</p>"}</div></div>`;
  return foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog", "tovf-trigger-character-dialog"], window: { title: "Triggerberechtigungen" }, position: { width: 700, height: 650 }, content,
    render: (_event, dialog) => {
      const root = dialog.element.querySelector(".tovf-trigger-character-picker");
      const visibleRows = () => [...root.querySelectorAll("[data-trigger-actor]")].filter(row => !row.hidden);
      const filter = () => {
        const search = root.querySelector("[data-trigger-search]").value.trim().toLocaleLowerCase();
        const player = root.querySelector("[data-trigger-player]").value;
        const folder = root.querySelector("[data-trigger-folder]").value;
        for (const row of root.querySelectorAll("[data-trigger-actor]")) {
          const owners = row.dataset.owners.split(",").filter(Boolean);
          row.hidden = !!search && !row.dataset.search.includes(search) || !!player && !owners.includes(player) || folder !== "*" && row.dataset.folder !== folder;
        }
      };
      root.querySelector("[data-trigger-search]").addEventListener("input", filter);
      root.querySelector("[data-trigger-player]").addEventListener("change", filter);
      root.querySelector("[data-trigger-folder]").addEventListener("change", filter);
      root.addEventListener("click", event => {
        const mode = event.target.closest("[data-picker-mode]")?.dataset.pickerMode; if (!mode) return;
        let targets = visibleRows();
        if (mode === "connected") targets = targets.filter(row => row.dataset.connected === "true");
        if (mode === "tokens") targets = targets.filter(row => tokenIds.has(row.querySelector('[name="actors"]')?.value));
        if (mode === "connected" || mode === "tokens") for (const input of root.querySelectorAll('[name="actors"]')) input.checked = false;
        for (const row of targets) {
          const input = row.querySelector('[name="actors"]');
          if (input) input.checked = mode !== "none";
        }
      });
    },
    ok: { label: "Auswahl übernehmen", icon: "fa-solid fa-check", callback: (_event, button) => [...button.form.querySelectorAll('[name="actors"]:checked')].map(input => input.value) },
    rejectClose: false });
}

function activateEditor(app, html) {
  const root = html.querySelector?.("[data-tovf-tile-actions]") ?? html[0]?.querySelector?.("[data-tovf-tile-actions]");
  if (!root) return;
  root.addEventListener("change", () => synchronizeEditor(app));
  root.addEventListener("input", () => synchronizeEditor(app));
  root.addEventListener("click", async event => {
    const button = event.target.closest("[data-tovf-action]");
    if (!button) return;
    event.preventDefault();
    const config = synchronizeEditor(app);
    if (button.dataset.tovfAction === "permissions") {
      const allowedActorIds = await selectTriggerCharacters(config.allowedActorIds);
      if (allowedActorIds) await renderEditor(app, { ...config, allowedActorIds });
      return;
    }
    const actions = Array.isArray(config.actions) ? config.actions.map(cleanAction) : [];
    const row = button.closest("[data-action-id]");
    const index = actions.findIndex(action => action.id === row?.dataset.actionId);
    if (button.dataset.tovfAction === "add") {
      const source = { type: root.querySelector("[data-tovf-new-action]")?.value };
      if (!ACTION_TYPES.has(source.type)) return;
      if (source.type === "spawnCharacter") {
        source.x = Math.round(app.document.x ?? 0);
        source.y = Math.round(app.document.y ?? 0);
      }
      actions.push(cleanAction(source));
    } else if (button.dataset.tovfAction === "remove" && index >= 0) actions.splice(index, 1);
    else if (button.dataset.tovfAction === "up" && index > 0) [actions[index - 1], actions[index]] = [actions[index], actions[index - 1]];
    else if (button.dataset.tovfAction === "down" && index >= 0 && index < actions.length - 1) [actions[index + 1], actions[index]] = [actions[index], actions[index + 1]];
    else return;
    await renderEditor(app, { ...config, actions });
  });
  for (const target of root.querySelectorAll("[data-scene-drop]")) {
    target.addEventListener("dragover", event => { event.preventDefault(); target.classList.add("dragover"); });
    target.addEventListener("dragleave", () => target.classList.remove("dragover"));
    target.addEventListener("drop", async event => {
      event.preventDefault();
      target.classList.remove("dragover");
      const data = TextEditor.getDragEventData(event);
      const scene = data.uuid ? await fromUuid(data.uuid) : null;
      if (scene?.documentName !== "Scene") return ui.notifications.warn("Bitte eine Szene aus der Szenenleiste hierher ziehen.");
      const config = synchronizeEditor(app);
      const action = config.actions?.find(entry => entry.id === target.closest("[data-action-id]")?.dataset.actionId);
      if (!action) return;
      action.sceneUuid = scene.uuid;
      action.sceneName = scene.name;
      await renderEditor(app, { ...config, actions: config.actions.map(cleanAction) });
    });
  }
  for (const target of root.querySelectorAll("[data-macro-drop]")) {
    target.addEventListener("dragover", event => { event.preventDefault(); target.classList.add("dragover"); });
    target.addEventListener("dragleave", () => target.classList.remove("dragover"));
    target.addEventListener("drop", async event => {
      event.preventDefault();
      target.classList.remove("dragover");
      const data = TextEditor.getDragEventData(event);
      const macro = data.uuid ? await fromUuid(data.uuid) : null;
      if (macro?.documentName !== "Macro") return ui.notifications.warn("Bitte ein Makro aus dem Makroverzeichnis hierher ziehen.");
      const config = synchronizeEditor(app);
      const action = config.actions?.find(entry => entry.id === target.closest("[data-action-id]")?.dataset.actionId);
      if (!action) return;
      action.macroUuid = macro.uuid;
      action.macroName = macro.name;
      await renderEditor(app, { ...config, actions: config.actions.map(cleanAction) });
    });
  }
}

function installTileConfigTab() {
  const registry = CONFIG.Tile.sheetClasses.base;
  const entry = registry?.["core.TileConfig"];
  const Base = entry?.cls;
  if (!Base || Object.hasOwn(Base, "_tovfSimpleTileTriggers")) return;
  class FeuerschwingeTileConfig extends Base {
    static _tovfSimpleTileTriggers = true;
    static PARTS = {
      ...Object.fromEntries(Object.entries(Base.PARTS).filter(([id]) => id !== "footer")),
      tovfActions: { template: `modules/${MODULE_ID}/templates/simple-tile-trigger-3-1-3.hbs` },
      ...(Base.PARTS.footer ? { footer: Base.PARTS.footer } : {})
    };
    static TABS = {
      ...Base.TABS,
      sheet: {
        ...Base.TABS.sheet,
        tabs: [...Base.TABS.sheet.tabs, { id: "tovfActions", icon: "fa-solid fa-bolt", label: "Aktionen" }]
      }
    };
    async _preparePartContext(partId, context, options) {
      const partContext = await super._preparePartContext(partId, context, options);
      if (partId === "tovfActions") {
        const config = tileConfiguration(this.document);
        partContext.config = this._tovfSimpleTileConfig ?? config;
        partContext.configJson = JSON.stringify(partContext.config);
        partContext.tab = partContext.tabs[partId];
      }
      return partContext;
    }
    _processFormData(event, form, formData) {
      synchronizeEditor(this);
      const data = super._processFormData(event, form, formData);
      const path = `flags.${MODULE_ID}.${FLAG}`;
      const value = foundry.utils.getProperty(data, path);
      if (typeof value === "string") {
        const parsed = JSON.parse(value);
        foundry.utils.setProperty(data, path, {
          version: 1,
          enabled: parsed?.enabled !== false,
          trigger: parsed?.trigger === "click" ? "click" : "dblclick",
          actions: Array.isArray(parsed?.actions) ? parsed.actions.slice(0, 30).map(cleanAction) : [],
          allowedActorIds: Array.isArray(parsed?.allowedActorIds) ? [...new Set(parsed.allowedActorIds.map(String))].slice(0, 100) : []
        });
      }
      return data;
    }
  }
  entry.cls = FeuerschwingeTileConfig;
}

export function registerSimpleTileTriggers() {
  exposeApi();
  try {
    installLayerTriggerPatch();
  } catch (error) {
    console.error(`${MODULE_ID} | Installing simple tile trigger handlers during init failed`, error);
  }
  Hooks.on("preCreateTile", normalizeFlagData);
  Hooks.on("preUpdateTile", normalizeFlagData);
  Hooks.on("renderTileConfig", activateEditor);
  Hooks.on("canvasReady", installLayerTriggerPatch);
  Hooks.once("init", exposeApi);
  Hooks.once("setup", exposeApi);
  Hooks.once("ready", exposeApi);
}

function patchLayerPrototype(prototype) {
  if (!prototype || Object.hasOwn(prototype, LAYER_PATCH)) return;
  Object.defineProperty(prototype, LAYER_PATCH, { value: true });
  for (const [method, triggerType] of [["_onClickLeft", "click"], ["_onClickLeft2", "dblclick"]]) {
    const original = prototype[method];
    prototype[method] = function(event, ...args) {
      const point = canvas.activeLayer.toLocal(event);
      const tile = point && clickedTile(point, triggerType);
      if (tile) void trigger(tile);
      return original.call(this, event, ...args);
    };
  }
}

function installLayerTriggerPatch() {
  patchLayerPrototype(foundry.canvas.layers.TokenLayer.prototype);
}

function diagnostics(point = canvas.mousePosition) {
  const base = foundry.canvas.layers.TokenLayer.prototype;
  const active = canvas.tokens?.constructor?.prototype;
  return {
    activeLayer: canvas.activeLayer?.constructor?.name,
    tokenLayer: canvas.tokens?.constructor?.name,
    basePatched: Object.hasOwn(base, LAYER_PATCH),
    activePatched: Object.hasOwn(active ?? {}, LAYER_PATCH),
    point: { x: Math.round(point?.x ?? 0), y: Math.round(point?.y ?? 0) },
    tiles: canvas.scene?.tiles.map(tile => ({
      id: tile.id,
      name: tile.texture?.src?.split("/").at(-1) ?? tile.id,
      config: tileConfiguration(tile),
      containsPoint: pointWithinTile(tile, point)
    })) ?? []
  };
}

function exposeApi() {
  const module = game.modules?.get?.(MODULE_ID);
  if (!module) return;
  module.api ??= {};
  module.api.simpleTileTriggers = {
    inspect: diagnostics,
    install: installLayerTriggerPatch,
    trigger: async tileUuid => {
      const tile = await fromUuid(tileUuid);
      if (tile?.documentName !== "Tile") throw new Error("Das Tile wurde nicht gefunden.");
      return trigger(tile);
    }
  };
}

async function handleGMExecutionRequest(message) {
  const user = game.users.get(message.userId);
  if (!user?.active) throw new Error("Der auslösende Benutzer ist nicht mehr verbunden.");
  const tile = await fromUuid(message.tileUuid);
  if (tile?.documentName !== "Tile" || tile.parent?.id !== message.sceneId) throw new Error("Das auslösende Tile wurde nicht gefunden.");
  if (tile.hidden && !user.isGM) throw new Error("Dieses Tile darf nicht ausgelöst werden.");
  const config = tileConfiguration(tile);
  if (!config.enabled || !canUseTrigger(config, user)) throw new Error("Du darfst diesen Auslöser nicht verwenden.");
  const action = config.actions.find(entry => entry.id === message.actionId && entry.type === "executeMacro" && entry.runAsGM);
  if (!action) throw new Error("Die GM-Makro-Aktion ist nicht mehr hinterlegt.");

  const tokenDocument = message.tokenUuid ? await fromUuid(message.tokenUuid) : null;
  if (tokenDocument && (tokenDocument.documentName !== "Token" || tokenDocument.parent?.id !== tile.parent.id
    || !tokenDocument.actor?.testUserPermission(user, "OWNER"))) {
    throw new Error("Der übergebene Token gehört nicht zum auslösenden Benutzer.");
  }
  let actor = tokenDocument?.actor ?? (message.actorUuid ? await fromUuid(message.actorUuid) : user.character);
  if (actor && !actor.testUserPermission(user, "OWNER") && user.character?.id !== actor.id) {
    throw new Error("Der übergebene Charakter gehört nicht zum auslösenden Benutzer.");
  }
  const token = tokenDocument?.object ?? tokenDocument;
  await executeMacroLocal(action, tile, { user, actor, token, scene: tile.parent });
  return true;
}

function installSocket() {
  if (socketInstalled) return;
  socketInstalled = true;
  game.socket.on(`module.${MODULE_ID}`, message => {
    if (message.scope !== SOCKET_SCOPE) return;
    if (message.type === "response") {
      const pending = pendingGMExecutions.get(message.requestId);
      if (!pending || message.targetUserId !== game.user.id) return;
      pendingGMExecutions.delete(message.requestId);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.type !== "request" || !game.user.isGM || message.targetGMId !== game.user.id || activeGM()?.id !== game.user.id) return;
    handleGMExecutionRequest(message)
      .then(result => game.socket.emit(`module.${MODULE_ID}`, {
        scope: SOCKET_SCOPE, type: "response", requestId: message.requestId,
        targetUserId: message.userId, result
      }))
      .catch(error => game.socket.emit(`module.${MODULE_ID}`, {
        scope: SOCKET_SCOPE, type: "response", requestId: message.requestId,
        targetUserId: message.userId, error: error.message
      }));
  });
}

export function activateSimpleTileTriggers() {
  // Monk's Active Tile Triggers may replace TileConfig during its ready hook.
  // Re-apply our mixin after all synchronous ready listeners have completed.
  queueMicrotask(installTileConfigTab);
  installSocket();
  exposeApi();
  try {
    installLayerTriggerPatch();
  } catch (error) {
    console.error(`${MODULE_ID} | Installing simple tile trigger handlers failed`, error);
  }
}
