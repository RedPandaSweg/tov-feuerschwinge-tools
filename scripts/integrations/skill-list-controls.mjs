import { MODULE_ID } from "../core/constants.mjs";

const SORT_FLAG = "skillListSort";
const ABILITY_COLORS = Object.freeze({
  int: "var(--tovf-ability-int)", intelligence: "var(--tovf-ability-int)",
  cha: "var(--tovf-ability-cha)", charisma: "var(--tovf-ability-cha)",
  wis: "var(--tovf-ability-wis)", wisdom: "var(--tovf-ability-wis)",
  str: "var(--tovf-ability-str)", strength: "var(--tovf-ability-str)",
  dex: "var(--tovf-ability-dex)", dexterity: "var(--tovf-ability-dex)"
});

const SKILL_ICONS = Object.freeze({
  acrobatics: "person-running", akrobatik: "person-running",
  animalhandling: "paw", "animal handling": "paw", "umgang mit tieren": "paw",
  arcana: "wand-sparkles", arkanes: "wand-sparkles",
  athletics: "dumbbell", athletik: "dumbbell",
  deception: "masks-theater", täuschung: "masks-theater",
  history: "landmark", geschichte: "landmark",
  insight: "eye", menschenkenntnis: "eye",
  intimidation: "skull", einschüchtern: "skull",
  investigation: "magnifying-glass", nachforschung: "magnifying-glass",
  medicine: "kit-medical", heilkunde: "kit-medical",
  nature: "leaf", naturkunde: "leaf",
  perception: "binoculars", wahrnehmung: "binoculars",
  performance: "music", auftreten: "music",
  persuasion: "comments", überzeugen: "comments",
  religion: "place-of-worship",
  sleightofhand: "hand-sparkles", "sleight of hand": "hand-sparkles", fingerfertigkeit: "hand-sparkles",
  stealth: "user-ninja", heimlichkeit: "user-ninja",
  survival: "campfire", überleben: "campfire"
});

function rootOf(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function skillIconName(skillId, label = "") {
  return SKILL_ICONS[String(skillId ?? "").toLowerCase()]
    ?? SKILL_ICONS[String(label).trim().toLowerCase()];
}

function sortMode(actor) {
  return actor.getFlag(MODULE_ID, SORT_FLAG) === "ability" ? "ability" : "alpha";
}

function swapAbilityValueDisplays(root) {
  const abilities = root?.querySelectorAll?.('[data-tab="main"] .abilities > .ability') ?? [];
  for (const ability of abilities) {
    if (ability.dataset.tovfValuesSwapped === "true") continue;
    const score = ability.querySelector(".ability-score > .value");
    const modifier = ability.querySelector(".ability-mod > .value");
    const scoreContainer = ability.querySelector(".ability-score");
    const modifierContainer = ability.querySelector(".ability-mod");
    if (!score || !modifier || !scoreContainer || !modifierContainer) continue;
    const label = score.querySelector(".label")?.cloneNode(true);
    if (label) {
      label.classList.add("tovf-ability-name");
      const modifierValue = document.createElement("span");
      modifierValue.className = "tovf-ability-modifier";
      modifierValue.textContent = modifier.textContent.trim();
      modifier.replaceChildren(modifierValue);
      ability.append(label);
    }
    scoreContainer.append(modifier);
    modifierContainer.append(score);
    ability.dataset.tovfValuesSwapped = "true";
  }
}

function addSkillIcon(row) {
  const name = row.querySelector("button[data-action=roll] .name");
  const iconName = skillIconName("", name?.textContent);
  if (!name || !iconName || row.querySelector(".tovf-skill-icon")) return;
  const icon = document.createElement("i");
  icon.className = `fa-solid fa-${iconName} tovf-skill-icon`;
  icon.setAttribute("aria-hidden", "true");
  name.before(icon);
}

function rollingTokenImage(message) {
  const { scene: sceneId, token: tokenId } = message?.speaker ?? {};
  const token = sceneId && tokenId ? game.scenes.get(sceneId)?.tokens.get(tokenId) : null;
  const actor = token?.actor ?? message?.speakerActor;
  return token?.texture?.src
    ?? actor?.prototypeToken?.texture?.src
    ?? actor?.img
    ?? "icons/svg/mystery-man.svg";
}

function enhanceSkillCheckMessage(message, element) {
  const rollData = message?.getFlag?.(game.system.id, "roll");
  if (rollData?.type !== "skill" || !rollData.skill) return;

  const skill = CONFIG.BlackFlag.skills?.[rollData.skill];
  const iconName = skillIconName(rollData.skill, skill?.label);
  const tokenImage = rollingTokenImage(message);
  const root = rootOf(element);
  if (!root || !skill) return;

  for (const roll of root.querySelectorAll(".message-content .dice-roll")) {
    const flavor = roll.querySelector(":scope > .dice-flavor");
    if (flavor && iconName && !flavor.querySelector(".tovf-skill-check-icon")) {
      const icon = document.createElement("i");
      icon.className = `fa-solid fa-${iconName} tovf-skill-check-icon`;
      icon.setAttribute("aria-hidden", "true");
      flavor.prepend(icon);
    }

    const result = roll.querySelector(":scope > .dice-result");
    if (!result || !skill.icon || result.dataset.tovfSkillArt === "true") continue;
    const values = document.createElement("div");
    values.className = "tovf-skill-roll-values";
    values.append(...result.childNodes);

    const token = document.createElement("img");
    token.className = "tovf-skill-roll-token";
    token.src = tokenImage;
    token.alt = "";
    token.draggable = false;
    token.setAttribute("aria-hidden", "true");

    const artwork = document.createElement("img");
    artwork.className = "tovf-skill-roll-art";
    artwork.src = skill.icon;
    artwork.alt = "";
    artwork.draggable = false;
    artwork.setAttribute("aria-hidden", "true");

    result.classList.add("tovf-skill-result");
    result.dataset.tovfSkillArt = "true";
    result.append(token, values, artwork);
  }
}

function addLuckRemoveControl(root) {
  const luck = root?.querySelector?.('[data-tab="main"] fieldset.luck');
  if (!luck) return;
  let add = luck.querySelector('[data-action="addLuck"]');
  if (!add) {
    add = document.createElement("button");
    add.type = "button";
    add.className = "link-button tovf-luck-add";
    add.dataset.action = "addLuck";
    add.dataset.tovfLuckAdd = "true";
    add.dataset.tooltip = "Luck hinzufügen";
    add.setAttribute("aria-label", "Luck hinzufügen");
    add.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
    luck.append(add);
  }
  if (luck.querySelector('[data-tovf-luck-remove]')) return;
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link-button tovf-luck-remove";
  remove.dataset.action = "removeLuck";
  remove.dataset.tovfLuckRemove = "true";
  remove.dataset.tooltip = "Luck abziehen";
  remove.setAttribute("aria-label", "Luck abziehen");
  remove.innerHTML = '<i class="fa-solid fa-minus" aria-hidden="true"></i>';
  add.after(remove);
}

function extendInventorySortingBar(root) {
  const table = root?.querySelector?.('[data-tab="inventory"] > blackFlag-inventory > table');
  const sortingCell = table?.querySelector?.(':scope > thead > tr.filters > th');
  const columnCount = table?.querySelector?.(':scope > tbody > tr.table-header')?.children.length;
  if (!sortingCell || !columnCount) return;
  sortingCell.colSpan = columnCount;
}

function addRestControls(root) {
  const hitPoints = root?.querySelector?.('[data-tab="main"] fieldset.hit-points');
  const hitDice = hitPoints?.querySelector?.(".hit-dice");
  if (!hitPoints || !hitDice || hitPoints.querySelector("[data-tovf-rest-controls]")) return;
  const controls = document.createElement("div");
  controls.className = "tovf-rest-controls";
  controls.dataset.tovfRestControls = "true";
  controls.innerHTML = `
    <button type="button" data-action="rest" data-type="short"><i class="fa-solid fa-mug-hot" aria-hidden="true"></i> Short Rest</button>
    <button type="button" data-action="rest" data-type="long"><i class="fa-solid fa-bed" aria-hidden="true"></i> Long Rest</button>`;
  hitDice.after(controls);
}

function addActionColumnHeadings(root) {
  const table = root?.querySelector?.('[data-tab="main"] .actions blackFlag-actions > table');
  const head = table?.querySelector?.("thead");
  if (!head || head.querySelector("[data-tovf-action-column-headings]")) return;
  const row = document.createElement("tr");
  row.className = "tovf-action-column-headings";
  row.dataset.tovfActionColumnHeadings = "true";
  row.innerHTML = `
    <th class="control" scope="col"></th>
    <th class="name" scope="col">Action</th>
    <th class="uses" scope="col">Res</th>
    <th class="challenge" scope="col">Atk/Save</th>
    <th class="effect" scope="col">Dmg</th>`;
  head.append(row);

  for (const button of table.querySelectorAll("td.control > button.heavy-button")) {
    const label = button.textContent.trim().toLowerCase();
    if (["cast", "zaubern"].includes(label)) button.classList.add("tovf-action-cast");
    if (["use", "benutzen"].includes(label)) button.classList.add("tovf-action-use");
  }
}

function annotateAndSort(actor, skills, mode) {
  const rows = [...skills.querySelectorAll(":scope > .skill.stat-block")];
  for (const row of rows) {
    // The visible abbreviation is stable across Black Flag's data-model
    // variants and is exactly what the sheet presents to the user.
    const ability = (row.querySelector(".ability")?.textContent ?? "").trim().toLowerCase();
    row.dataset.tovfAbility = ability;
    const label = row.querySelector(".ability");
    if (label && ABILITY_COLORS[ability]) label.style.color = ABILITY_COLORS[ability];
    addSkillIcon(row);
  }
  rows.sort((left, right) => {
    if (mode === "ability") {
      const ability = String(left.dataset.tovfAbility).localeCompare(String(right.dataset.tovfAbility), game.i18n.lang);
      if (ability) return ability;
    }
    return (left.querySelector(".name")?.textContent ?? "")
      .trim()
      .localeCompare((right.querySelector(".name")?.textContent ?? "").trim(), game.i18n.lang);
  });
  skills.append(...rows);
}

function updateControls(controls, mode) {
  const button = controls.querySelector("button[data-tovf-skill-sort]");
  if (!button) return;
  const abilityOrder = mode === "ability";
  button.dataset.tovfSkillSort = mode;
  button.querySelector("span").textContent = abilityOrder ? "Abilities" : "Skills";
  button.setAttribute("aria-label", abilityOrder ? "Skills alphabetisch sortieren" : "Skills nach Ability sortieren");
  button.setAttribute("data-tooltip", button.getAttribute("aria-label"));
  button.setAttribute("aria-pressed", String(abilityOrder));
}

function enhanceSkills(app, element) {
  const actor = app?.document;
  if (actor?.documentName !== "Actor" || actor.type !== "pc") return;
  const root = rootOf(element);
  swapAbilityValueDisplays(root);
  addLuckRemoveControl(root);
  extendInventorySortingBar(root);
  addRestControls(root);
  addActionColumnHeadings(root);
  const skills = root?.querySelector?.('[data-tab="main"] fieldset.skills');
  if (!skills) return;

  const mode = sortMode(actor);
  annotateAndSort(actor, skills, mode);
  if (skills.querySelector("[data-tovf-skill-sort-controls]")) return;

  const controls = document.createElement("span");
  controls.className = "tovf-skill-sort-controls";
  controls.dataset.tovfSkillSortControls = "true";
  controls.innerHTML = '<button type="button" data-tovf-skill-sort aria-pressed="false"><i class="fa-solid fa-arrow-down-a-z" aria-hidden="true"></i><span></span></button>';
  updateControls(controls, mode);
  controls.addEventListener("click", event => {
    const button = event.target.closest("button[data-tovf-skill-sort]");
    if (!button) return;
    event.preventDefault();
    const next = button.dataset.tovfSkillSort === "ability" ? "alpha" : "ability";
    annotateAndSort(actor, skills, next);
    updateControls(controls, next);
    void actor.setFlag(MODULE_ID, SORT_FLAG, next).catch(error => {
      console.error(`${MODULE_ID} | Could not save skill sort preference.`, error);
      ui.notifications.error("Die Skill-Sortierung konnte nicht gespeichert werden.");
    });
  });
  skills.append(controls);
}

export function installSkillListControls() {
  if (!CONFIG.BlackFlag?.skills) {
    return { status: "incompatible", reason: "CONFIG.BlackFlag.skills is unavailable." };
  }
  Hooks.on("renderApplicationV2", enhanceSkills);
  Hooks.on("renderActorSheet", enhanceSkills);
  Hooks.on("renderChatMessageHTML", enhanceSkillCheckMessage);
  return { status: "completed" };
}
