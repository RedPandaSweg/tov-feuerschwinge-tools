const ENHANCED = "data-tovf-compendium-usability";

function enhanceCompendium(app) {
  const root = app.element;
  if (!root || root.hasAttribute(ENHANCED)) return;
  root.setAttribute(ENHANCED, "");

  // Foundry's directory handlers can consume the wheel event before the
  // absolutely positioned result list scrolls, particularly during a drag.
  root.addEventListener("wheel", event => {
    const list = event.target.closest?.(".directory-list");
    if (!list || !event.deltaY) return;
    const previous = list.scrollTop;
    list.scrollTop += event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? event.deltaY * 32
      : event.deltaY;
    if (list.scrollTop === previous) return;
    event.preventDefault();
    event.stopPropagation();
  }, { capture: true, passive: false });

  // Keep drag-and-drop usable in long packs by scrolling faster as the cursor
  // approaches either edge of the directory list.
  root.addEventListener("dragover", event => {
    const list = event.target.closest?.(".directory-list");
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const edge = Math.min(90, bounds.height / 4);
    let amount = 0;
    if (event.clientY < bounds.top + edge) {
      amount = -Math.ceil((bounds.top + edge - event.clientY) / edge * 30);
    } else if (event.clientY > bounds.bottom - edge) {
      amount = Math.ceil((event.clientY - (bounds.bottom - edge)) / edge * 30);
    }
    if (amount) list.scrollTop += amount;
  });
}

export function installCompendiumUsability() {
  const Compendium = foundry.applications.sidebar.apps.Compendium;
  Compendium.DEFAULT_OPTIONS.window.resizable = true;
  Hooks.on("renderCompendium", enhanceCompendium);
}
