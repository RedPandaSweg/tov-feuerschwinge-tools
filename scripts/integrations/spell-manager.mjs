const PATCH_FLAG = "__tovfSpellManager";
const EXCLUDED_SPELL_PACKS = new Set([
  "koboldpressogl-bf.koboldpressspells"
]);

function isExcludedSpell(spell) {
  if (EXCLUDED_SPELL_PACKS.has(spell?.pack)) return true;
  const uuid = String(spell?.uuid ?? "");
  return [...EXCLUDED_SPELL_PACKS].some(pack => uuid.startsWith(`Compendium.${pack}.`));
}

function spellCircle(spell) {
  return Number(spell?.system?.circle?.base ?? 0);
}

function circleLabel(circle) {
  if (circle === 0) return game.i18n.localize("BF.Spell.Circle.Cantrip[one]");
  return CONFIG.BlackFlag?.spellCircles?.()?.[circle] ?? `${circle}. Circle`;
}

function stateFor(app) {
  return (app._tovfSpellManagerState ??= {
    circle: "all", search: "", spellsScrollTop: 0, slotsScrollTop: 0
  });
}

function captureState(app) {
  const root = app.element?.querySelector?.("[data-tovf-spell-manager]");
  if (!root) return;
  const state = stateFor(app);
  state.search = root.querySelector("[data-tovf-spell-search]")?.value ?? state.search;
  state.spellsScrollTop = app.element.querySelector(":scope > .spells")?.scrollTop ?? state.spellsScrollTop;
  state.slotsScrollTop = app.element.querySelector(":scope > .slots")?.scrollTop ?? state.slotsScrollTop;
}

function scheduleRender(app) {
  if (app._tovfSpellManagerRenderFrame) cancelAnimationFrame(app._tovfSpellManagerRenderFrame);
  app._tovfSpellManagerRenderFrame = requestAnimationFrame(() => {
    app._tovfSpellManagerRenderFrame = null;
    app.render();
  });
}

function selectSpell(app, uuid, control) {
  const selectedElsewhere = app.slots.some((slot, index) => (
    index !== app.selectedSlot && slot.selected === uuid
  ));
  if (selectedElsewhere) {
    ui.notifications.warn("Dieser Zauber ist bereits für einen anderen Slot ausgewählt.");
    return;
  }

  captureState(app);
  app.currentSlot.selected = uuid;
  control?.setAttribute("aria-pressed", "true");
  scheduleRender(app);
}

function slotMark(slot) {
  if (slot.type === "replacement") return { replace: true };
  if (slot.type === "rituals") return { text: "R" };
  if (slot.type === "cantrips") return { text: "C" };
  if (slot.spell) {
    const circle = spellCircle(slot.spell);
    return { text: circle === 0 ? "C" : String(circle) };
  }
  return { text: String(slot.number ?? "") };
}

function bindFilters(app) {
  const root = app.element?.querySelector?.("[data-tovf-spell-manager]");
  if (!root || root.dataset.tovfFiltersBound) return;
  root.dataset.tovfFiltersBound = "true";
  const state = stateFor(app);
  const searchField = root.querySelector("[data-tovf-spell-search]");
  searchField.value = state.search;

  const syncCircleControls = () => {
    for (const button of root.querySelectorAll("[data-tovf-circle]")) {
      const active = button.dataset.tovfCircle === state.circle;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
  };

  const apply = () => {
    const search = state.search.trim().toLocaleLowerCase(game.i18n.lang);
    for (const row of root.querySelectorAll("[data-spell-uuid]")) {
      const matchesName = !search || row.dataset.tovfSearch.includes(search);
      const matchesCircle = state.circle === "all" || row.dataset.tovfSpellCircle === state.circle;
      row.hidden = !matchesName || !matchesCircle;
    }
    const visible = [...root.querySelectorAll("[data-spell-uuid]")].some(row => !row.hidden);
    root.querySelector("[data-tovf-no-spells]").hidden = visible;
  };

  root.addEventListener("input", event => {
    if (event.target.matches("[data-tovf-spell-search]")) {
      state.search = event.target.value;
      apply();
    }
  });
  root.addEventListener("click", event => {
    const spell = event.target.closest("[data-tovf-select-spell]");
    if (spell) {
      event.preventDefault();
      event.stopPropagation();
      selectSpell(app, spell.dataset.tovfSelectSpell, spell);
      return;
    }
    const button = event.target.closest("button[data-tovf-circle]");
    if (!button) return;
    state.circle = button.dataset.tovfCircle;
    syncCircleControls();
    apply();
  });
  app.element.querySelector(":scope > .spells")?.addEventListener("scroll", event => {
    state.spellsScrollTop = event.currentTarget.scrollTop;
  });
  app.element.querySelector(":scope > .slots")?.addEventListener("scroll", event => {
    state.slotsScrollTop = event.currentTarget.scrollTop;
  });
  syncCircleControls();
  apply();
  requestAnimationFrame(() => {
    const spells = app.element.querySelector(":scope > .spells");
    const slots = app.element.querySelector(":scope > .slots");
    if (spells) spells.scrollTop = state.spellsScrollTop;
    if (slots) slots.scrollTop = state.slotsScrollTop;
  });
}

/** Replace Black Flag's spell list with a searchable, circle-filtered picker.
 * The system's slot validation, learning, and replacement transactions remain
 * untouched, so its advancement data stays fully compatible. */
export function installSpellManager() {
  const Dialog = BlackFlag?.applications?.advancement?.SpellcastingDialog;
  const prototype = Dialog?.prototype;
  const originalPrepareContext = prototype?._prepareContext;
  const originalOnChangeForm = prototype?._onChangeForm;
  const originalRender = prototype?.render;
  if (typeof originalPrepareContext !== "function" || typeof originalOnChangeForm !== "function"
    || typeof originalRender !== "function" || !Dialog?.PARTS?.spells) {
    return { status: "incompatible", reason: "Missing BlackFlag SpellcastingDialog APIs." };
  }
  if (originalPrepareContext[PATCH_FLAG]) return { status: "already-installed" };

  if (!Dialog.DEFAULT_OPTIONS.classes.includes("tovf-spell-manager-dialog")) {
    Dialog.DEFAULT_OPTIONS.classes.push("tovf-spell-manager-dialog");
  }
  Dialog.DEFAULT_OPTIONS.actions.tovfSelectSlot = function(event, target) {
    const index = Number(target.dataset.tovfSelectSlot);
    if (!Number.isInteger(index) || !this.slots[index]) return;
    captureState(this);
    this.selectedSlot = index;
    scheduleRender(this);
  };

  prototype._prepareContext = async function(options) {
    const context = await originalPrepareContext.call(this, options);
    const state = stateFor(this);
    const search = state.search.trim().toLocaleLowerCase(game.i18n.lang);
    const spells = (context.spells ?? []).filter(spell => !isExcludedSpell(spell));
    const availableCircles = [...new Set(spells.map(spell => spellCircle(spell)))]
      .sort((left, right) => left - right);
    if (state.circle !== "all" && !availableCircles.some(circle => String(circle) === state.circle)) {
      state.circle = "all";
    }
    context.spells = spells.map(spell => ({
      ...spell,
      circle: spellCircle(spell),
      circleMark: spellCircle(spell) === 0 ? "C" : String(spellCircle(spell)),
      search: String(spell.name ?? "").toLocaleLowerCase(game.i18n.lang),
      hidden: (state.circle !== "all" && String(spellCircle(spell)) !== state.circle)
        || (search && !String(spell.name ?? "").toLocaleLowerCase(game.i18n.lang).includes(search))
    }));
    context.slots = (context.slots ?? []).map(slot => ({ ...slot, mark: slotMark(slot) }));
    context.tovfSpellManager = {
      search: state.search,
      allSelected: state.circle === "all",
      source: context.restrictions?.source ?? "—",
      maximumCircle: context.restrictions?.maxCircle
        ?? context.restrictions?.circle
        ?? (this.currentSlot?.type === "cantrips" ? circleLabel(0) : "—"),
      circles: availableCircles.map(circle => ({
          value: circle,
          label: circleLabel(circle),
          selected: String(circle) === state.circle
        }))
    };
    return context;
  };
  Object.defineProperty(prototype._prepareContext, PATCH_FLAG, { value: true });
  prototype._onChangeForm = function(formConfig, event) {
    if (event.target?.name !== "selected-spell") {
      return originalOnChangeForm.call(this, formConfig, event);
    }

    selectSpell(this, event.target.value, event.target);
  };
  prototype.render = function(options) {
    captureState(this);
    return originalRender.call(this, options);
  };

  Dialog.PARTS.spells = {
    ...Dialog.PARTS.spells,
    template: "modules/tov-feuerschwinge-tools/templates/spell-manager/spells.hbs"
  };
  Dialog.PARTS.slots = {
    ...Dialog.PARTS.slots,
    template: "modules/tov-feuerschwinge-tools/templates/spell-manager/slots.hbs"
  };
  Dialog.PARTS.restrictions = {
    ...Dialog.PARTS.restrictions,
    template: "modules/tov-feuerschwinge-tools/templates/spell-manager/restrictions.hbs"
  };
  Hooks.on("renderApplicationV2", app => {
    if (app instanceof Dialog) bindFilters(app);
  });
  return { status: "completed" };
}
