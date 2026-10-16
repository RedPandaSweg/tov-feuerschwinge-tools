function rootOf(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function compactTrait(trait) {
  const original = trait.textContent.trim();
  const match = original.match(/^([^:]+):\s*(.+)$/);
  if (!match) return;
  const [, label, value] = match;
  const normalized = label.toLocaleLowerCase();
  let text = value;
  if (/hit\s*die|trefferw(ü|u)rfel/.test(normalized)) text = `${value} Hit Die`;
  trait.textContent = text;
  trait.dataset.tooltip = original;
  trait.setAttribute("aria-label", original);
}

function compactDescription(option) {
  const description = option.querySelector(".info .description");
  const summary = description?.querySelector(":scope > p");
  const link = description?.querySelector(".journal-link .content-link");
  if (!description || !summary || !link) return;
  link.innerHTML = '<i class="fa-solid fa-book-open" inert></i> More';
  summary.append(" ", link);
  description.querySelector(".journal-link")?.remove();
}

function repositionName(option) {
  const summary = option.querySelector(".summary");
  const name = option.querySelector(".poster .document-name");
  if (!summary || !name || summary.querySelector(".tovf-class-name")) return;
  name.classList.add("tovf-class-name");
  summary.prepend(name);
}

function layoutSubclass(option) {
  const info = option.querySelector(".summary > .info");
  const name = option.querySelector(".summary > .poster > .document-name");
  if (!info || !name || info.querySelector(".tovf-subclass-name")) return;
  name.classList.add("tovf-subclass-name");
  info.prepend(name);
}

function styleClassSelection(app, element) {
  const type = app?.options?.details?.type;
  if (!['class', 'subclass'].includes(type)) return;
  const root = rootOf(element);
  root?.closest(".application")?.classList.add("tovf-character-concept-dialog");
  root?.querySelectorAll(".option").forEach(option => {
    if (type === "class") {
      repositionName(option);
      option.querySelectorAll(".info .trait").forEach(compactTrait);
      compactDescription(option);
    } else layoutSubclass(option);
  });
}

/** Compact the existing class selector without replacing its selection workflow. */
export function installClassSelectionLayout() {
  if (!BlackFlag?.applications?.actor?.ConceptSelectionDialog) {
    return { status: "incompatible", reason: "Missing BlackFlag.applications.actor.ConceptSelectionDialog." };
  }
  Hooks.on("renderApplicationV2", styleClassSelection);
  return { status: "completed" };
}
