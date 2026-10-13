import { uiText } from "../core/localization.mjs";

const boundRoots = new WeakSet();

function rootOf(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function isEditMode(app) {
  return app?.isEditable && app._mode === app.constructor?.MODES?.EDIT;
}

function waitForProgressionQueue(sheet, actor, expectedLevel) {
  return new Promise((resolve, reject) => {
    const hookId = Hooks.on("renderApplicationV2", app => {
      if (app !== sheet || Number(actor.system?.progression?.level) > expectedLevel) return;
      clearTimeout(timeout);
      Hooks.off("renderApplicationV2", hookId);
      resolve();
    });
    const timeout = setTimeout(() => {
      Hooks.off("renderApplicationV2", hookId);
      reject(new Error(uiText("TOVF.Interface.LevelDownTimedOut_18a5c7", "Das Zurückstufen wurde nicht abgeschlossen. Bitte prüfe den Charakterbogen.")));
    }, 10000);
  });
}

async function lowerLevels(sheet, actor, amount) {
  for (let step = 0; step < amount; step += 1) {
    const currentLevel = Number(actor.system?.progression?.level ?? 0);
    if (currentLevel <= 0) break;
    const completed = waitForProgressionQueue(sheet, actor, currentLevel - 1);
    await actor.system.levelDown();
    await completed;
  }
}

async function requestLevelDown(sheet, amount) {
  const actor = sheet?.document;
  const currentLevel = Number(actor?.system?.progression?.level ?? 0);
  if (!actor || actor.type !== "pc" || currentLevel <= 0) return;
  const levels = Number(amount);
  if (!Number.isInteger(levels) || levels < 1 || levels > currentLevel) {
    ui.notifications.warn(uiText("TOVF.Interface.InvalidLevelDownAmount_426ce9", "Bitte gib eine gültige Anzahl von Leveln an."));
    return;
  }
  const targetLevel = currentLevel - levels;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    classes: ["tovf-commerce-dialog", "tovf-level-down-dialog"],
    window: { title: uiText("TOVF.Interface.LevelDown_87a8c2", "Zurückstufen") },
    content: `<p><strong>${uiText("TOVF.Interface.LevelDownConfirmation_2ea59f", "Möchtest du den Charakter wirklich zurückstufen?")}</strong></p><p>${uiText("TOVF.Interface.LevelDownTarget_9d26ef", "Der Charakter wird auf Level {level} zurückgestuft. Features und Fortschrittsentscheidungen der entfernten Level gehen dabei verloren.", { level: targetLevel })}</p>`,
    rejectClose: false
  });
  if (!confirmed) return;

  try {
    await lowerLevels(sheet, actor, levels);
  } catch (error) {
    console.error("tov-feuerschwinge-tools | Could not lower multiple character levels.", error);
    ui.notifications.error(error?.message ?? uiText("TOVF.Interface.LevelDownFailed_9f83b1", "Der Charakter konnte nicht vollständig zurückgestuft werden."));
  }
}

function createButton(tooltip, amount, targetLevel = null) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "link-button tovf-level-down-button";
  button.dataset.tovfLevelDown = String(amount);
  if (targetLevel !== null) button.dataset.tovfTargetLevel = String(targetLevel);
  button.dataset.tooltip = tooltip;
  button.setAttribute("aria-label", tooltip);
  button.innerHTML = '<i class="fa-solid fa-arrow-down-wide-short" inert></i>';
  return button;
}

function installLevelDownControls(app, element) {
  const actor = app?.document;
  if (actor?.documentName !== "Actor" || actor.type !== "pc" || !isEditMode(app)) return;
  const root = rootOf(element);
  const currentLevel = Number(actor.system?.progression?.level ?? 0);
  if (!root || currentLevel <= 0) return;

  for (const row of root.querySelectorAll("section.levels > .level[data-level]")) {
    const level = Number(row.dataset.level);
    const heading = row.querySelector("h3");
    if (!heading || level < 1 || level > currentLevel) continue;
    const nativeButton = heading.querySelector('button[data-action="levelDown"]');
    if (level === currentLevel && nativeButton) {
      const controls = nativeButton.closest(".controls") ?? nativeButton.parentElement;
      controls.replaceChildren();
      const input = document.createElement("input");
      input.type = "number";
      input.className = "tovf-level-down-amount";
      input.min = "1";
      input.max = String(currentLevel);
      input.step = "1";
      input.value = "1";
      const amountTooltip = uiText("TOVF.Interface.LevelsToRemove_8ef91a", "Anzahl der Level, die zurückgestuft werden");
      input.dataset.tooltip = amountTooltip;
      input.setAttribute("aria-label", amountTooltip);
      controls.append(input, createButton(uiText("TOVF.Interface.LevelDown_87a8c2", "Zurückstufen"), 1));
    } else if (level < currentLevel && !heading.querySelector("[data-tovf-level-down]")) {
      const controls = document.createElement("span");
      controls.className = "controls tovf-level-down-target";
      controls.append(createButton(`${uiText("TOVF.Interface.SetLevelTo_5f0cf0", "Auf Level")} ${level}`, currentLevel - level, level));
      heading.append(controls);
    }
  }
}

function bindLevelDownControl(app, element) {
  if (app?.document?.documentName !== "Actor" || app.document.type !== "pc") return;
  const root = rootOf(element);
  if (!root) return;
  installLevelDownControls(app, root);
  if (boundRoots.has(root)) return;
  boundRoots.add(root);

  root.addEventListener("click", event => {
    const button = event.target instanceof Element ? event.target.closest("[data-tovf-level-down]") : null;
    if (!button || !root.contains(button)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const input = button.closest(".controls")?.querySelector(".tovf-level-down-amount");
    const amount = input ? Number(input.value) : Number(button.dataset.tovfLevelDown);
    void requestLevelDown(app, amount);
  }, true);
}

/** Add level-down controls while retaining Black Flag's per-level reversal workflow. */
export function installMultiLevelDown() {
  if (!BlackFlag?.applications?.actor?.PCSheet) {
    return { status: "incompatible", reason: "Missing BlackFlag.applications.actor.PCSheet." };
  }
  Hooks.on("renderApplicationV2", bindLevelDownControl);
  Hooks.on("renderActorSheet", bindLevelDownControl);
  return { status: "completed" };
}
