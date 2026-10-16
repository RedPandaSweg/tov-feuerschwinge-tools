function rootOf(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function selectionType(app) {
  return app?.options?.details?.type ?? app?.advancement?.configuration?.type ?? null;
}

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

function styleFeatureSelection(app, element) {
  const Dialog = BlackFlag?.applications?.advancement?.ChooseFeaturesDialog;
  if (!Dialog || !(app instanceof Dialog)) return;
  const type = selectionType(app);
  if (!["feature", "talent"].includes(type)) return;

  const root = rootOf(element);
  const contents = root?.matches?.(".contents") ? root : root?.querySelector?.(".contents");
  if (!contents || contents.querySelector("[data-tovf-feature-search]")) return;

  const application = root.closest(".application") ?? root;
  application.classList.add("tovf-feature-selection-dialog", `tovf-feature-selection-${type}`);

  const search = document.createElement("label");
  search.className = "tovf-feature-selection-search";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-magnifying-glass";
  icon.setAttribute("inert", "");
  const input = document.createElement("input");
  input.type = "search";
  input.dataset.tovfFeatureSearch = "true";
  input.placeholder = type === "talent" ? "Search Talents…" : "Search Class Features…";
  input.setAttribute("aria-label", input.placeholder);
  search.append(icon, input);

  const empty = document.createElement("p");
  empty.className = "tovf-feature-selection-empty hint";
  empty.textContent = "No matching options.";
  empty.hidden = true;

  const options = [...contents.querySelectorAll(":scope > .option")];
  for (const option of options) option.dataset.tovfSearch = normalize(option.querySelector(".name")?.textContent);
  input.addEventListener("input", () => {
    const needle = normalize(input.value);
    let visible = 0;
    for (const option of options) {
      const matches = !needle || option.dataset.tovfSearch.includes(needle);
      option.hidden = !matches;
      if (matches) visible += 1;
    }
    empty.hidden = visible > 0;
  });

  contents.prepend(search);
  search.after(empty);
}

/** Style Black Flag's class-feature and talent choices and add name filtering. */
export function installFeatureSelectionLayout() {
  if (!BlackFlag?.applications?.advancement?.ChooseFeaturesDialog) {
    return { status: "incompatible", reason: "Missing BlackFlag.applications.advancement.ChooseFeaturesDialog." };
  }
  Hooks.on("renderApplicationV2", styleFeatureSelection);
  return { status: "completed" };
}
