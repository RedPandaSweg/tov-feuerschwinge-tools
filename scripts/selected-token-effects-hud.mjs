const HUD_ID = "tovf-selected-token-effects";

let activated = false;
let renderGeneration = 0;
let observedSidebar = null;
let sidebarResizeObserver = null;
let sidebarMutationObserver = null;

function positionEffectsHud() {
  const hud = document.getElementById(HUD_ID);
  const tabs = document.getElementById("sidebar-tabs");
  if (!hud || !tabs) return;
  const bounds = tabs.getBoundingClientRect();
  const gap = 8;
  hud.style.right = "auto";
  hud.style.left = `${Math.max(gap, bounds.left - hud.offsetWidth - gap)}px`;
  hud.style.top = `${Math.max(gap, bounds.top)}px`;
  hud.style.maxHeight = `${Math.max(80, window.innerHeight - Math.max(gap, bounds.top) - gap)}px`;
}

function observeSidebarPosition() {
  const sidebar = document.getElementById("sidebar");
  if (!sidebar || sidebar === observedSidebar) return;
  observedSidebar = sidebar;
  sidebarResizeObserver?.disconnect();
  sidebarMutationObserver?.disconnect();
  sidebarResizeObserver = new ResizeObserver(positionEffectsHud);
  sidebarResizeObserver.observe(sidebar);
  const tabs = document.getElementById("sidebar-tabs");
  if (tabs) sidebarResizeObserver.observe(tabs);
  sidebarMutationObserver = new MutationObserver(() => requestAnimationFrame(positionEffectsHud));
  sidebarMutationObserver.observe(sidebar, { attributes: true, subtree: true, attributeFilter: ["class", "style"] });
}

function collectionValues(collection) {
  return collection?.contents ?? [...(collection?.values?.() ?? [])];
}

function plainText(value) {
  const parsed = new DOMParser().parseFromString(String(value ?? ""), "text/html");
  return parsed.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

async function embeddedDescription(value) {
  const text = String(value ?? "");
  const references = [...text.matchAll(/@Embed\[([^\]\s]+)[^\]]*\]/g)];
  if (!references.length) return plainText(text);
  let resolved = text;
  for (const reference of references) {
    const document = await fromUuid(reference[1]).catch(() => null);
    const content = document?.text?.content
      ?? document?.system?.description?.value
      ?? document?.system?.description
      ?? "";
    resolved = resolved.replace(reference[0], content);
  }
  return plainText(resolved.replace(/@Embed\[[^\]]*\]/g, ""));
}

function documentDescription(document) {
  return document?.system?.description?.value
    ?? document?.system?.description
    ?? document?.description
    ?? "";
}

function containingItem(document) {
  let current = document;
  while (current && current.documentName !== "Item") current = current.parent;
  return current?.documentName === "Item" ? current : null;
}

async function sourceDocument(effect) {
  if (effect.parent?.documentName === "Item") return effect.parent;
  const origin = String(effect.origin ?? "").trim();
  if (!origin) return null;
  const originDocument = await fromUuid(origin).catch(() => null);
  return containingItem(originDocument) ?? originDocument;
}

async function compendiumSource(document) {
  const sourceId = String(document?._stats?.compendiumSource ?? document?.getFlag?.("core", "sourceId") ?? "").trim();
  return sourceId ? fromUuid(sourceId).catch(() => null) : null;
}

async function effectDescription(effect) {
  const own = await embeddedDescription(documentDescription(effect));
  if (own) return own;
  const source = await sourceDocument(effect);
  const inherited = await embeddedDescription(documentDescription(source));
  if (inherited) return inherited;
  const compendiumDocument = await compendiumSource(source);
  return embeddedDescription(documentDescription(compendiumDocument));
}

function effectDuration(effect) {
  const label = effect.duration?.label;
  if (label && !["none", "keine", "\u2014", "-"].includes(String(label).trim().toLocaleLowerCase())) return String(label);
  const remaining = Number(effect.duration?.remaining);
  if (!Number.isFinite(remaining)) return "";
  const unit = effect.duration?.type === "turns" ? "Runden" : "Sekunden";
  return `${remaining} ${unit}`;
}

function effectSource(effect) {
  if (effect.parent?.documentName === "Item") return effect.parent.name;
  const origin = String(effect.origin ?? "").trim();
  if (!origin) return "";
  try {
    return fromUuidSync(origin)?.name ?? origin;
  } catch {
    return origin;
  }
}

function statusDefinition(id) {
  return CONFIG.statusEffects?.find(entry => entry.id === id || entry._id === id) ?? null;
}

function statusName(id, definition, effect) {
  const label = definition?.name ?? definition?.label;
  if (label) return game.i18n.localize(label);
  return effect.name || id;
}

async function statusDescription(definition, effect) {
  const description = definition?.description;
  return description ? embeddedDescription(game.i18n.localize(description)) : effectDescription(effect);
}

function currentActor() {
  const controlled = canvas?.tokens?.controlled ?? [];
  return controlled.length === 1 ? controlled[0].actor : null;
}

async function effectEntries(actor) {
  const statuses = [];
  const effects = [];
  const seenStatuses = new Set();
  for (const effect of collectionValues(actor.effects)) {
    if (effect.disabled || effect.isSuppressed || effect.active === false) continue;
    const statusIds = collectionValues(effect.statuses).map(String).filter(Boolean);
    if (statusIds.length) {
      for (const id of statusIds) {
        if (seenStatuses.has(id)) continue;
        seenStatuses.add(id);
        const definition = statusDefinition(id);
        statuses.push({
          id,
          name: statusName(id, definition, effect),
          img: definition?.img ?? definition?.icon ?? effect.img ?? "icons/svg/aura.svg",
          description: await statusDescription(definition, effect),
          duration: effectDuration(effect),
          source: effectSource(effect)
        });
      }
      continue;
    }
    effects.push({
      id: effect.id,
      name: effect.name,
      img: effect.img ?? "icons/svg/aura.svg",
      description: await effectDescription(effect),
      duration: effectDuration(effect),
      source: effectSource(effect)
    });
  }
  const byName = (left, right) => left.name.localeCompare(right.name, game.i18n.lang);
  return { statuses: statuses.sort(byName), effects: effects.sort(byName) };
}

function detailRow(label, value) {
  if (!value) return null;
  const row = document.createElement("p");
  const heading = document.createElement("strong");
  heading.textContent = `${label}: `;
  row.append(heading, document.createTextNode(value));
  return row;
}

function effectIcon(entry) {
  const item = document.createElement("div");
  item.className = "tovf-effect-hud-item";
  item.tabIndex = 0;
  item.setAttribute("aria-label", entry.name);
  const img = document.createElement("img");
  img.src = entry.img;
  img.alt = "";
  const tooltip = document.createElement("div");
  tooltip.className = "tovf-effect-hud-tooltip";
  const title = document.createElement("h3");
  title.textContent = entry.name;
  tooltip.append(title);
  const duration = detailRow("Dauer", entry.duration);
  const source = detailRow("Quelle", entry.source);
  if (duration) tooltip.append(duration);
  if (source) tooltip.append(source);
  if (entry.description) {
    const description = document.createElement("p");
    description.className = "tovf-effect-hud-description";
    description.textContent = entry.description;
    tooltip.append(description);
  }
  item.append(img, tooltip);
  const positionTooltip = () => requestAnimationFrame(() => {
    const itemBounds = item.getBoundingClientRect();
    const tooltipBounds = tooltip.getBoundingClientRect();
    const edge = 8;
    const top = Math.clamp(itemBounds.top, edge, Math.max(edge, window.innerHeight - tooltipBounds.height - edge));
    tooltip.style.left = `${Math.max(edge, itemBounds.left - tooltipBounds.width - 10)}px`;
    tooltip.style.top = `${top}px`;
  });
  item.addEventListener("pointerenter", positionTooltip);
  item.addEventListener("focusin", positionTooltip);
  return item;
}

function effectGroup(label, entries) {
  if (!entries.length) return null;
  const group = document.createElement("section");
  group.className = "tovf-effect-hud-group";
  group.setAttribute("aria-label", label);
  const heading = document.createElement("span");
  heading.className = "tovf-effect-hud-group-label";
  const [first, ...remaining] = label.split(" ");
  heading.append(document.createTextNode(first));
  if (remaining.length) heading.append(document.createElement("br"), document.createTextNode(remaining.join(" ")));
  const icons = document.createElement("div");
  icons.className = "tovf-effect-hud-icons";
  icons.append(...entries.map(effectIcon));
  group.append(heading, icons);
  return group;
}

async function renderSelectedTokenEffects() {
  const generation = ++renderGeneration;
  document.getElementById(HUD_ID)?.remove();
  const actor = currentActor();
  if (!actor) return;
  const { statuses, effects } = await effectEntries(actor);
  if (generation !== renderGeneration || actor !== currentActor()) return;
  if (!statuses.length && !effects.length) return;
  const hud = document.createElement("aside");
  hud.id = HUD_ID;
  hud.setAttribute("aria-label", `Effekte: ${actor.name}`);
  const statusGroup = effectGroup("Status Effects", statuses);
  const effectGroupElement = effectGroup("Active Effects", effects);
  if (statusGroup) hud.append(statusGroup);
  if (effectGroupElement) hud.append(effectGroupElement);
  document.body.append(hud);
  observeSidebarPosition();
  positionEffectsHud();
}

function refreshForEffect(effect) {
  const owner = effect?.parent?.documentName === "Actor"
    ? effect.parent
    : effect?.parent?.parent?.documentName === "Actor" ? effect.parent.parent : null;
  if (owner === currentActor()) renderSelectedTokenEffects();
}

export function activateSelectedTokenEffectsHud() {
  if (activated) return;
  activated = true;
  Hooks.on("controlToken", renderSelectedTokenEffects);
  Hooks.on("canvasReady", renderSelectedTokenEffects);
  Hooks.on("createActiveEffect", refreshForEffect);
  Hooks.on("updateActiveEffect", refreshForEffect);
  Hooks.on("deleteActiveEffect", refreshForEffect);
  Hooks.on("collapseSidebar", () => requestAnimationFrame(positionEffectsHud));
  window.addEventListener("resize", positionEffectsHud);
  renderSelectedTokenEffects();
}
