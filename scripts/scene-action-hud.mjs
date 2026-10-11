import { MODULE_ID } from "./core/constants.mjs";
import { cleanSimpleTriggerAction, executeSimpleTriggerActions } from "./simple-tile-triggers.mjs?v=3.8.5-scene-hud-3";

const FLAG = "sceneActionHud";
const BLOCK_TYPES = new Set(["heading", "text", "button"]);
let hud;
let collapsed = false;
let renderGeneration = 0;
let obstacleObserver;
let sidebarObserver;
const POSITION_KEY = `${MODULE_ID}.sceneActionHud.position`;

function cleanBlock(source = {}) {
  const sourceType = BLOCK_TYPES.has(source.type) ? source.type : "text";
  const type = sourceType === "button" ? "button" : "text";
  const rawText = String(source.text ?? "");
  return {
    id: String(source.id || foundry.utils.randomID()),
    type,
    span: Math.clamp(Math.floor(Number(source.span) || 1), 1, 3),
    text: sourceType === "heading" ? `<h3>${foundry.utils.escapeHTML(rawText)}</h3>` : rawText,
    actions: type === "button" && Array.isArray(source.actions)
      ? source.actions.slice(0, 30).map(cleanSimpleTriggerAction)
      : []
  };
}

function cleanSection(source = {}) {
  const columns = Math.clamp(Math.floor(Number(source.columns) || 1), 1, 3);
  return {
    id: String(source.id || foundry.utils.randomID()),
    columns,
    items: Array.isArray(source.items) ? source.items.slice(0, 50).map(item => {
      const clean = cleanBlock(item);
      return { ...clean, span: Math.min(clean.span, columns) };
    }) : []
  };
}

function sceneHudConfiguration(scene) {
  const source = scene?.getFlag(MODULE_ID, FLAG) ?? {};
  const legacyBlocks = Array.isArray(source.blocks) ? source.blocks.slice(0, 50).map(cleanBlock) : [];
  return {
    version: 2,
    enabled: source.enabled === true,
    sections: Array.isArray(source.sections) ? source.sections.slice(0, 20).map(cleanSection) : (legacyBlocks.length ? [cleanSection({ columns: 1, items: legacyBlocks })] : []),
    allowedActorIds: Array.isArray(source.allowedActorIds) ? [...new Set(source.allowedActorIds.map(String))].slice(0, 100) : []
  };
}

function readEditor(app) {
  const field = app.element.querySelector(`[name="flags.${MODULE_ID}.${FLAG}"]`);
  try { return JSON.parse(field?.value || "{}"); } catch { return sceneHudConfiguration(app.document); }
}

function synchronizeEditor(app) {
  const root = app.element.querySelector("[data-tovf-scene-hud-config]");
  const config = readEditor(app);
  config.enabled = root?.querySelector("[data-hud-enabled]")?.checked === true;
  config.sections = (config.sections ?? []).map(cleanSection);
  for (const sectionRow of root?.querySelectorAll("[data-hud-section-id]") ?? []) {
    const section = config.sections.find(entry => entry.id === sectionRow.dataset.hudSectionId);
    if (!section) continue;
    section.columns = Math.clamp(Number(sectionRow.querySelector("[data-section-columns]")?.value) || 1, 1, 3);
    for (const blockRow of sectionRow.querySelectorAll("[data-hud-block-id]")) {
      const block = section.items.find(entry => entry.id === blockRow.dataset.hudBlockId);
    if (!block) continue;
      block.span = Math.min(section.columns, Math.max(1, Number(blockRow.querySelector("[data-block-span]")?.value) || 1));
    block.text = blockRow.querySelector("[data-hud-block-text]")?.value ?? "";
    for (const actionRow of blockRow.querySelectorAll("[data-hud-action-id]")) {
      const action = block.actions.find(entry => entry.id === actionRow.dataset.hudActionId);
      if (!action) continue;
      for (const input of actionRow.querySelectorAll("[data-action-field]")) {
        action[input.dataset.actionField] = input.dataset.actionFieldType === "checkbox"
          ? input.checked
          : input.dataset.actionFieldType === "text" ? input.value : Number(input.value) || 0;
      }
    }
    }
  }
  const field = root?.querySelector(`[name="flags.${MODULE_ID}.${FLAG}"]`);
  if (field) field.value = JSON.stringify(config);
  app._tovfSceneHudConfig = config;
  return config;
}

async function rerenderEditor(app, config) {
  const oldRoot = app.element.querySelector("[data-tovf-scene-hud-config]");
  const oldScroll = scrollContainer(oldRoot);
  const scrollTop = oldScroll?.scrollTop ?? 0;
  app._tovfSceneHudConfig = { ...config, sections: config.sections.map(cleanSection) };
  app.tabGroups.sheet = "tovfSceneHud";
  await app.render({ force: true });
  const newRoot = app.element.querySelector("[data-tovf-scene-hud-config]");
  const newScroll = scrollContainer(newRoot);
  if (newScroll) newScroll.scrollTop = scrollTop;
}

function scrollContainer(root) {
  let element = root;
  while (element && element !== document.body) {
    const style = getComputedStyle(element);
    if (element.scrollHeight > element.clientHeight && ["auto", "scroll"].includes(style.overflowY)) return element;
    element = element.parentElement;
  }
  return root?.closest?.(".window-content") ?? null;
}

function actionSource(type, scene) {
  const action = { type };
  if (type === "spawnCharacter") { action.x = Math.round(scene.width / 2); action.y = Math.round(scene.height / 2); }
  return cleanSimpleTriggerAction(action);
}

function activateEditor(app, html) {
  const root = html.querySelector?.("[data-tovf-scene-hud-config]") ?? html[0]?.querySelector?.("[data-tovf-scene-hud-config]");
  if (!root) return;
  root.addEventListener("input", () => synchronizeEditor(app));
  root.addEventListener("change", () => synchronizeEditor(app));
  root.addEventListener("click", async event => {
    const button = event.target.closest("[data-hud-editor-action]"); if (!button) return;
    event.preventDefault();
    const config = synchronizeEditor(app);
    const sectionIndex = config.sections.findIndex(entry => entry.id === button.closest("[data-hud-section-id]")?.dataset.hudSectionId);
    const section = config.sections[sectionIndex];
    const blockIndex = section?.items.findIndex(entry => entry.id === button.closest("[data-hud-block-id]")?.dataset.hudBlockId) ?? -1;
    const block = section?.items[blockIndex];
    const actionIndex = block?.actions.findIndex(entry => entry.id === button.closest("[data-hud-action-id]")?.dataset.hudActionId) ?? -1;
    const command = button.dataset.hudEditorAction;
    if (command === "addSection") config.sections.push(cleanSection({ columns: 1, items: [] }));
    else if (command === "removeSection" && sectionIndex >= 0) config.sections.splice(sectionIndex, 1);
    else if (command === "sectionUp" && sectionIndex > 0) [config.sections[sectionIndex - 1], config.sections[sectionIndex]] = [config.sections[sectionIndex], config.sections[sectionIndex - 1]];
    else if (command === "sectionDown" && sectionIndex >= 0 && sectionIndex < config.sections.length - 1) [config.sections[sectionIndex + 1], config.sections[sectionIndex]] = [config.sections[sectionIndex], config.sections[sectionIndex + 1]];
    else if (command === "addBlock" && section) section.items.push(cleanBlock({ type: button.closest("[data-hud-section-id]").querySelector("[data-new-block-type]").value }));
    else if (command === "removeBlock" && blockIndex >= 0) section.items.splice(blockIndex, 1);
    else if (command === "blockUp" && blockIndex > 0) [section.items[blockIndex - 1], section.items[blockIndex]] = [section.items[blockIndex], section.items[blockIndex - 1]];
    else if (command === "blockDown" && blockIndex >= 0 && blockIndex < section.items.length - 1) [section.items[blockIndex + 1], section.items[blockIndex]] = [section.items[blockIndex], section.items[blockIndex + 1]];
    else if (command === "blockPreviousSection" && block && sectionIndex > 0) { section.items.splice(blockIndex, 1); config.sections[sectionIndex - 1].items.push(block); }
    else if (command === "blockNextSection" && block && sectionIndex >= 0 && sectionIndex < config.sections.length - 1) { section.items.splice(blockIndex, 1); config.sections[sectionIndex + 1].items.push(block); }
    else if (command === "addAction" && block) block.actions.push(actionSource(button.closest("[data-hud-block-id]").querySelector("[data-new-action-type]").value, app.document));
    else if (command === "removeAction" && actionIndex >= 0) block.actions.splice(actionIndex, 1);
    else if (command === "actionUp" && actionIndex > 0) [block.actions[actionIndex - 1], block.actions[actionIndex]] = [block.actions[actionIndex], block.actions[actionIndex - 1]];
    else if (command === "actionDown" && actionIndex >= 0 && actionIndex < block.actions.length - 1) [block.actions[actionIndex + 1], block.actions[actionIndex]] = [block.actions[actionIndex], block.actions[actionIndex + 1]];
    else return;
    await rerenderEditor(app, config);
  });
  for (const target of root.querySelectorAll("[data-scene-drop],[data-macro-drop]")) {
    target.addEventListener("dragover", event => { event.preventDefault(); target.classList.add("dragover"); });
    target.addEventListener("dragleave", () => target.classList.remove("dragover"));
    target.addEventListener("drop", async event => {
      event.preventDefault(); target.classList.remove("dragover");
      const data = TextEditor.getDragEventData(event); const document = data.uuid ? await fromUuid(data.uuid) : null;
      const expected = target.hasAttribute("data-scene-drop") ? "Scene" : "Macro";
      if (document?.documentName !== expected) return ui.notifications.warn(`Bitte ${expected === "Scene" ? "eine Szene" : "ein Makro"} hier hineinziehen.`);
      const config = synchronizeEditor(app);
      const section = config.sections.find(entry => entry.id === target.closest("[data-hud-section-id]")?.dataset.hudSectionId);
      const block = section?.items.find(entry => entry.id === target.closest("[data-hud-block-id]")?.dataset.hudBlockId);
      const action = block?.actions.find(entry => entry.id === target.closest("[data-hud-action-id]")?.dataset.hudActionId);
      if (!action) return;
      if (expected === "Scene") { action.sceneUuid = document.uuid; action.sceneName = document.name; }
      else { action.macroUuid = document.uuid; action.macroName = document.name; }
      await rerenderEditor(app, config);
    });
  }
}

function installSceneConfigTab() {
  const entry = CONFIG.Scene.sheetClasses.base?.["core.SceneConfig"];
  const Base = entry?.cls;
  if (!Base || Object.hasOwn(Base, "_tovfSceneActionHud")) return;
  class FeuerschwingeSceneConfig extends Base {
    static _tovfSceneActionHud = true;
    static PARTS = {
      ...Object.fromEntries(Object.entries(Base.PARTS).filter(([id]) => id !== "footer")),
      tovfSceneHud: { template: `modules/${MODULE_ID}/templates/scene-action-hud-config.hbs` },
      ...(Base.PARTS.footer ? { footer: Base.PARTS.footer } : {})
    };
    static TABS = { ...Base.TABS, sheet: { ...Base.TABS.sheet, tabs: [...Base.TABS.sheet.tabs, { id: "tovfSceneHud", icon: "fa-solid fa-table-columns", label: "HUD" }] } };
    async _preparePartContext(partId, context, options) {
      const partContext = await super._preparePartContext(partId, context, options);
      if (partId === "tovfSceneHud") {
        partContext.config = this._tovfSceneHudConfig ?? sceneHudConfiguration(this.document);
        partContext.config.sections.forEach((section, index, sections) => {
          section.displayIndex = index + 1;
          for (const item of section.items) {
            item.canMovePrevious = index > 0;
            item.canMoveNext = index < sections.length - 1;
          }
        });
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
      if (typeof value === "string") foundry.utils.setProperty(data, path, JSON.parse(value));
      return data;
    }
  }
  entry.cls = FeuerschwingeSceneConfig;
}

function removeHud() { hud?.remove(); hud = null; }

function horizontalLimits() {
  const sidebar = document.querySelector("#sidebar");
  const sidebarRect = sidebar?.getBoundingClientRect();
  const effectsRect = document.querySelector("#tovf-selected-token-effects")?.getBoundingClientRect();
  const leftObstacles = ["#controls", "#scene-controls", ".scene-controls"]
    .map(selector => document.querySelector(selector)?.getBoundingClientRect())
    .filter(rect => rect?.width > 0 && rect?.height > 0 && rect.left < window.innerWidth / 2);
  const minimum = Math.max(8, ...leftObstacles.map(rect => rect.right + 8));
  const obstacles = [
    sidebarRect?.width > 20 && sidebarRect.left > window.innerWidth / 2 ? sidebarRect.left : null,
    effectsRect?.width > 20 && effectsRect.left > window.innerWidth / 2 ? effectsRect.left : null
  ].filter(Number.isFinite);
  const right = (obstacles.length ? Math.min(...obstacles) : window.innerWidth) - 8;
  return { minimum, right };
}

function fitHudWidth(element) {
  const { minimum, right } = horizontalLimits();
  const columns = Math.clamp(Number(element.dataset.maxColumns) || 1, 1, 3);
  const desired = 280 + (columns - 1) * 170;
  const available = Math.max(220, right - minimum);
  element.style.setProperty("--hud-width", `${Math.min(desired, available)}px`);
}

function horizontalBounds(element) {
  const { minimum, right } = horizontalLimits();
  return { minimum, maximum: Math.max(minimum, right - element.offsetWidth) };
}

function positionHud(element, requestedLeft = null) {
  fitHudWidth(element);
  const { minimum, maximum } = horizontalBounds(element);
  const storedValue = localStorage.getItem(`${POSITION_KEY}.${game.user?.id ?? "user"}`);
  const stored = storedValue === null ? null : Number(storedValue);
  const fraction = Number.isFinite(stored) ? Math.clamp(stored, 0, 1) : 1;
  const left = requestedLeft == null ? minimum + (maximum - minimum) * fraction : Math.clamp(requestedLeft, minimum, maximum);
  element.style.left = `${Math.round(left)}px`;
  element.style.right = "auto";
  return { left, minimum, maximum };
}

function scheduleHudClamp() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (hud) positionHud(hud, hud.getBoundingClientRect().left);
  }));
}

function activateHudDrag(element, handle) {
  handle.addEventListener("pointerdown", event => {
    if (event.target.closest("button")) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const offset = event.clientX - element.getBoundingClientRect().left;
    const move = moveEvent => positionHud(element, moveEvent.clientX - offset);
    const finish = finishEvent => {
      handle.releasePointerCapture(finishEvent.pointerId);
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish); handle.removeEventListener("pointercancel", finish);
      const { left, minimum, maximum } = positionHud(element, element.getBoundingClientRect().left);
      const fraction = maximum > minimum ? (left - minimum) / (maximum - minimum) : 0;
      localStorage.setItem(`${POSITION_KEY}.${game.user?.id ?? "user"}`, String(fraction));
    };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", finish);
  });
}

async function renderHud() {
  const generation = ++renderGeneration;
  removeHud();
  const scene = canvas?.scene; const config = sceneHudConfiguration(scene);
  if (!scene || !config.enabled || !config.sections.some(section => section.items.length)) return;
  hud = document.createElement("aside"); hud.id = "tovf-scene-action-hud"; hud.classList.toggle("collapsed", collapsed);
  hud.dataset.maxColumns = String(Math.max(1, ...config.sections.map(section => section.columns)));
  const header = document.createElement("div"); header.className = "tovf-scene-hud-handle";
  header.innerHTML = `<i class="fa-solid fa-grip" aria-hidden="true"></i><button type="button" aria-label="HUD ${collapsed ? "ausklappen" : "einklappen"}"><i class="fa-solid fa-chevron-${collapsed ? "down" : "up"}"></i></button>`;
  const toggle = header.querySelector("button");
  toggle.addEventListener("click", () => { collapsed = !collapsed; hud.classList.toggle("collapsed", collapsed); toggle.querySelector("i").className = `fa-solid fa-chevron-${collapsed ? "down" : "up"}`; toggle.ariaLabel = `HUD ${collapsed ? "ausklappen" : "einklappen"}`; positionHud(hud, hud.getBoundingClientRect().left); });
  const content = document.createElement("div"); content.className = "tovf-scene-hud-content";
  for (const section of config.sections) {
    const sectionElement = document.createElement("section"); sectionElement.className = "tovf-scene-hud-section"; sectionElement.style.setProperty("--hud-columns", section.columns);
    for (const block of section.items) {
      let element;
      if (block.type === "text") {
        element = document.createElement("div"); element.className = "tovf-scene-hud-rich-text";
        element.innerHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(block.text, { async: true, relativeTo: scene });
      } else {
        const button = document.createElement("button"); button.type = "button"; button.textContent = block.text || "Aktion";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try { await executeSimpleTriggerActions(scene, block.actions, config); }
          catch (error) { console.error(`${MODULE_ID} | Scene HUD action failed`, error); ui.notifications.error(error.message); }
          finally { button.disabled = false; }
        });
        element = button;
      }
      element.style.gridColumn = `span ${Math.min(block.span, section.columns)}`;
      sectionElement.append(element);
    }
    content.append(sectionElement);
  }
  if (generation !== renderGeneration || canvas?.scene?.id !== scene.id) return;
  hud.append(header, content); document.body.append(hud); positionHud(hud); activateHudDrag(hud, header);
}

export function registerSceneActionHud() {
  Hooks.on("renderSceneConfig", activateEditor);
  Hooks.on("canvasReady", () => void renderHud());
  Hooks.on("updateScene", scene => { if (scene.id === canvas?.scene?.id) void renderHud(); });
  Hooks.on("deleteScene", scene => { if (scene.id === canvas?.scene?.id) removeHud(); });
  Hooks.on("collapseSidebar", scheduleHudClamp);
  window.addEventListener("resize", () => { if (hud) positionHud(hud, hud.getBoundingClientRect().left); });
}

export function activateSceneActionHud() {
  queueMicrotask(installSceneConfigTab);
  obstacleObserver ??= new MutationObserver(records => {
    const effectsChanged = records.some(record => [...record.addedNodes, ...record.removedNodes]
      .some(node => node instanceof HTMLElement && (node.id === "tovf-selected-token-effects" || node.querySelector?.("#tovf-selected-token-effects"))));
    if (effectsChanged && hud) positionHud(hud, hud.getBoundingClientRect().left);
  });
  obstacleObserver.observe(document.body, { childList: true, subtree: false });
  const sidebar = document.querySelector("#sidebar");
  if (sidebar && !sidebarObserver) {
    sidebarObserver = new MutationObserver(scheduleHudClamp);
    sidebarObserver.observe(sidebar, { attributes: true, attributeFilter: ["class", "style"] });
    sidebar.addEventListener("transitionend", scheduleHudClamp);
  }
  void renderHud();
}
