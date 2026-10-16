import { MODULE_ID } from "./core/constants.mjs";

const EVENT = `${MODULE_ID}.tokenHudMenu`;

export function registerTokenHudMenu() {
  Hooks.on("renderTokenHUD", (app, html) => {
    const token = app.object?.document;
    const root = html.querySelector?.(".col.right") ?? html[0]?.querySelector?.(".col.right");
    if (!token || !root || root.querySelector('[data-palette="tovf"]')) return;
    const actions = [];
    Hooks.callAll(EVENT, token, action => actions.push(action));
    if (!actions.length) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "control-icon";
    toggle.dataset.action = "togglePalette";
    toggle.dataset.palette = "tovf";
    toggle.dataset.tooltip = "Feuerschwinge";
    toggle.setAttribute("aria-label", "Feuerschwinge");
    toggle.innerHTML = '<i class="fa-solid fa-fire-flame-curved" inert></i>';
    const list = document.createElement("div");
    list.className = "palette tovf-token-hud-menu-actions";
    list.dataset.palette = "tovf";
    for (const action of actions) {
      const control = document.createElement("button");
      control.type = "button";
      control.className = "control-icon tovf-token-hud-menu-action";
      control.dataset.tooltipText = action.label;
      control.setAttribute("aria-label", action.label);
      control.innerHTML = `<i class="fa-solid ${action.icon}" inert></i>`;
      const activate = event => { event.preventDefault(); action.callback().catch(error => ui.notifications.error(error.message)); };
      control.addEventListener("click", activate);
      list.append(control);
    }
    root.prepend(toggle, list);
    requestAnimationFrame(() => {
      list.style.top = `${toggle.offsetTop}px`;
    });
  });
}

export const tokenHudMenuEvent = EVENT;
