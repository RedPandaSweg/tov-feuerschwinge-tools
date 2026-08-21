function localized(key, fallback) {
  const value = game.i18n.localize(key);
  return value === key ? fallback : value;
}

function replaceValueInput(row) {
  const input = row.querySelector('.value input[name$=".value"]');
  if (!input) return;
  const textarea = document.createElement("textarea");
  for (const attribute of input.attributes) textarea.setAttribute(attribute.name, attribute.value);
  textarea.rows = 2;
  textarea.value = input.value;
  input.replaceWith(textarea);
}

function addPriorityField(app, row) {
  if (row.querySelector('.priority [name$=".priority"]')) return;
  const keyInput = row.querySelector('[name$=".key"]');
  if (!keyInput) return;
  const index = Number(row.dataset.changeIndex);
  const priority = app.document?.changes?.[index]?.priority ?? "";
  const container = document.createElement("div");
  container.className = "priority";
  const input = document.createElement("input");
  input.type = "number";
  input.step = "1";
  input.name = keyInput.name.replace(/\.key$/, ".priority");
  input.value = priority;
  container.append(input);
  row.querySelector(".effect-controls")?.before(container);
}

function labelFields(row) {
  const labels = {
    key: localized("BFI.Enchantment.ChangeKey", "Attribute path"),
    type: localized("BFI.Enchantment.ChangeMode", "Mode"),
    mode: localized("BFI.Enchantment.ChangeMode", "Mode"),
    priority: localized("BFI.Enchantment.ChangePriority", "Priority"),
    value: localized("BFI.Enchantment.ChangeValue", "Value")
  };
  for (const [className, label] of Object.entries(labels)) {
    const field = row.querySelector(`:scope > .${className}`);
    if (!field) continue;
    field.setAttribute("data-field-label", label);
    if (!field.querySelector(":scope > .tovf-effect-change-label")) {
      const heading = document.createElement("span");
      heading.className = "tovf-effect-change-label";
      heading.textContent = label;
      field.prepend(heading);
    }
  }
}

function enhanceRows(app, root) {
  const selector = [
    ".active-effect-sheet .effect-change",
    ".active-effect-config section.changes ol[data-changes] > li"
  ].join(",");
  for (const row of root.querySelectorAll(selector)) {
    if (row.matches(".effect-change")) addPriorityField(app, row);
    replaceValueInput(row);
    labelFields(row);
    row.classList.add("tovf-effect-change");
  }
}

export function installActiveEffectChangesUi() {
  Hooks.on("renderActiveEffectConfig", (app, element) => {
    const root = element instanceof HTMLElement ? element : element?.[0];
    if (!root) return;
    root.querySelector(".active-effect-config section.changes > header")
      ?.classList.add("tovf-effect-change-add-header");
    enhanceRows(app, root);
  });
}
