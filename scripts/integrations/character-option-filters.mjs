import { MODULE_ID } from "../core/constants.mjs";
import { characterOption, characterOptions, ensureCharacterOptionIndex } from "../character-option-index.mjs";

const TYPES = new Set(["lineage", "heritage", "background"]);
const FILTERS = Object.freeze([
  { key: "features", label: "Features" },
  { key: "talents", label: "Talente", backgroundOnly: true },
  { key: "proficiencies", label: "Proficiencies" }
]);

function rootOf(element) { return element instanceof HTMLElement ? element : element?.[0] ?? null; }
function optionUuid(option) {
  const source = option.querySelector("[data-uuid], [data-document-uuid], [data-document-id], [data-entry-id]");
  return option.dataset.uuid ?? option.dataset.documentUuid ?? option.dataset.documentId ?? option.dataset.entryId
    ?? source?.dataset.uuid ?? source?.dataset.documentUuid ?? source?.dataset.documentId ?? source?.dataset.entryId ?? "";
}
function equals(left, right) { return String(left).localeCompare(String(right), game.i18n.lang, { sensitivity: "accent" }) === 0; }
function availableValues(options, key) {
  return [...new Set(options.flatMap(option => option[key] ?? []))].sort((a, b) => a.localeCompare(b, game.i18n.lang));
}

async function installFilters(app, element) {
  const type = app?.options?.details?.type ?? app?.type;
  if (!TYPES.has(type)) return;
  const root = rootOf(element);
  root?.closest(".application")?.classList.add("tovf-character-concept-dialog");
  const container = root?.querySelector(`.concept-selection-dialog .${type}, .window-content > .${type}`);
  if (!container || container.querySelector("[data-tovf-character-option-filters]")) return;
  await ensureCharacterOptionIndex().catch(error => console.error(`${MODULE_ID} | Failed to load character option index.`, error));

  const indexedOptions = characterOptions(type);
  const controls = document.createElement("section");
  controls.className = "tovf-character-option-filters";
  controls.dataset.tovfCharacterOptionFilters = "true";
  const header = document.createElement("header");
  const heading = document.createElement("strong");
  heading.textContent = "Auswahl filtern";
  const count = document.createElement("small");
  count.className = "tovf-character-option-filter-count";
  header.append(heading, count);
  controls.append(header);
  const fields = FILTERS.filter(filter => !filter.backgroundOnly || type === "background");
  const selections = Object.fromEntries(fields.map(({ key }) => [key, new Set()]));
  const inputs = new Map();
  const chips = new Map();
  const cards = [...container.querySelectorAll(":scope > .option")];
  for (const card of cards) {
    const poster = card.querySelector(".poster");
    const choose = poster?.querySelector('[data-action="choose"], button');
    if (!poster || !choose || poster.querySelector(".tovf-choose-mask")) continue;
    const mask = document.createElement("span");
    mask.className = "tovf-choose-mask";
    mask.setAttribute("aria-hidden", "true");
    poster.insertBefore(mask, choose);
  }
  const apply = () => {
    let visible = 0;
    for (const card of cards) {
      const option = characterOption(optionUuid(card));
      const matches = !option || fields.every(({ key }) => [...selections[key]].every(value => option[key]?.some(entry => equals(entry, value))));
      card.hidden = !matches;
      if (matches) visible += 1;
    }
    count.textContent = `${visible} von ${cards.length}`;
  };
  const renderChips = key => {
    const target = chips.get(key);
    target.replaceChildren(...[...selections[key]].map(value => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tovf-character-option-filter-chip";
      chip.textContent = value;
      chip.title = `${value} entfernen`;
      chip.addEventListener("click", () => { selections[key].delete(value); renderChips(key); apply(); });
      return chip;
    }));
  };
  const add = (key, value) => {
    const match = availableValues(indexedOptions, key).find(entry => equals(entry, value));
    if (!match) return;
    selections[key].add(match);
    inputs.get(key).value = "";
    renderChips(key); apply();
  };

  for (const { key, label } of fields) {
    const field = document.createElement("label");
    field.className = "tovf-character-option-filter-field";
    const name = document.createElement("span"); name.textContent = label;
    const input = document.createElement("input");
    input.type = "search"; input.placeholder = `${label} wählen …`;
    const list = document.createElement("datalist");
    list.id = `tovf-${type}-${key}-${foundry.utils.randomID()}`;
    input.setAttribute("list", list.id);
    for (const value of availableValues(indexedOptions, key)) {
      const option = document.createElement("option"); option.value = value; list.append(option);
    }
    const chipList = document.createElement("span"); chipList.className = "tovf-character-option-filter-chips";
    input.addEventListener("change", () => add(key, input.value));
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const needle = input.value.toLocaleLowerCase(game.i18n.lang);
      add(key, availableValues(indexedOptions, key).find(value => value.toLocaleLowerCase(game.i18n.lang).startsWith(needle)) ?? input.value);
    });
    field.append(name, input, list, chipList); controls.append(field);
    inputs.set(key, input); chips.set(key, chipList);
  }
  container.prepend(controls); apply();
}

export function installCharacterOptionFilters() {
  if (!BlackFlag?.applications?.actor?.ConceptSelectionDialog) return { status: "incompatible", reason: "Missing BlackFlag.applications.actor.ConceptSelectionDialog." };
  Hooks.on("renderApplicationV2", (app, element) => void installFilters(app, element));
  return { status: "completed" };
}
