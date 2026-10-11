const SPELLCASTING_TAB = "spellcasting";
const boundFilters = new WeakSet();

function rootOf(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function bindSpellcastingFilter(app, filter) {
  if (boundFilters.has(filter)) return;
  boundFilters.add(filter);

  filter.addEventListener("click", event => {
    if (event instanceof MouseEvent && event.button !== 0) return;

    // Black Flag can initialize a filter before its parent filter group. That
    // leaves the system control without its click handler until a later sheet
    // render. Handling this one control directly preserves the native three
    // states while making its first click reliable.
    event.preventDefault();
    event.stopImmediatePropagation();
    const current = Number(filter.getAttribute("value")) || 0;
    const value = current === 1 ? -1 : current + 1;
    filter.value = value;
    void app.document.update({
      [`flags.black-flag.sheet.filters.${SPELLCASTING_TAB}.${filter.getAttribute("filter")}`]: value
    }).catch(error => console.error("tov-feuerschwinge-tools | Could not update spell filter.", error));
  }, true);
}

function installFiltersOnSheet(app, element) {
  if (app?.document?.documentName !== "Actor") return;
  const root = rootOf(element);
  const filters = root?.querySelectorAll?.(
    `[data-tab="${SPELLCASTING_TAB}"] > blackFlag-inventory > table > thead blackFlag-filter[filter]`
  );
  filters?.forEach(filter => bindSpellcastingFilter(app, filter));
}

export function installSpellcastingFilterControls() {
  Hooks.on("renderApplicationV2", installFiltersOnSheet);
  Hooks.on("renderActorSheet", installFiltersOnSheet);
  return { status: "completed" };
}
