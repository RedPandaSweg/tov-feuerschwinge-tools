const DEFAULT_IMAGE = "icons/sundries/books/book-red-exclamation.webp";
const GOLD_UUID = "Compendium.black-flag.currencies.Item.eWMYzM5UVZUDIqtg";
let currentTalents = [];
let currentActor = null;

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function identifier(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "custom-background";
}

function exceedsLevel(restriction, actor) {
  const levelFilters = restriction?.filters?.filter?.(entry => ["characterLevel", "classLevel"].includes(entry?._id)) ?? [];
  const current = Number(actor?.system?.progression?.level ?? 0);
  return levelFilters.some(filter => {
    const required = Number(filter.v);
    return Number.isFinite(required) && required > current;
  });
}

async function talentOptions(actor) {
  const choices = [];
  for (const item of game.items.filter(item => item.type === "talent")) {
    choices.push({
      key: item.uuid, label: item.name, img: item.img,
      description: item.system.description?.value ?? "", source: "World",
      restriction: item.system.restriction
    });
  }
  for (const pack of game.packs.filter(pack => pack.documentName === "Item" && pack.visible)) {
    const index = await pack.getIndex({ fields: ["type", "img", "system.description.value", "system.restriction"] });
    for (const item of index.filter(item => item.type === "talent")) {
      choices.push({
        key: `Compendium.${pack.collection}.Item.${item._id}`,
        label: item.name,
        img: item.img,
        description: foundry.utils.getProperty(item, "system.description.value") ?? "",
        source: pack.metadata.label,
        restriction: foundry.utils.getProperty(item, "system.restriction")
      });
    }
  }
  return choices
    .filter(talent => !exceedsLevel(talent.restriction, actor))
    .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
}

async function browseTalents(talents, selectedUuid, actor) {
  const cards = await Promise.all(talents.map(async talent => {
    const document = await fromUuid(talent.key);
    const prerequisite = document?.system?.createPrerequisiteLabel?.(actor) ?? "";
    return {
      ...talent,
      prerequisite,
      description: await foundry.applications.ux.TextEditor.implementation.enrichHTML(talent.description, { async: true })
    };
  }));
  return foundry.applications.api.DialogV2.wait({
    classes: ["tovf-talent-browser-dialog"],
    window: { title: "Talent auswählen" },
    position: { width: 760, height: 720 },
    content: `<div class="tovf-talent-browser standard-form">
      <input type="search" data-tovf-talent-search placeholder="Talente durchsuchen …">
      <div class="tovf-talent-browser-list">
        ${cards.map(talent => `<label class="tovf-talent-card" data-search="${escape(talent.label.toLocaleLowerCase(game.i18n.lang))}">
          <input type="radio" name="talentUuid" value="${escape(talent.key)}" ${talent.key === selectedUuid ? "checked" : ""}>
          <img src="${escape(talent.img || DEFAULT_IMAGE)}" alt="">
          <span><strong>${escape(talent.label)}</strong><small>${escape(talent.source)}</small>
            ${talent.prerequisite ? `<span class="tovf-talent-prerequisite"><b>Voraussetzungen:</b> ${talent.prerequisite}</span>` : ""}
            <span class="tovf-talent-description">${talent.description}</span></span>
        </label>`).join("")}
      </div>
    </div>`,
    buttons: [
      {
        action: "select", label: "Talent übernehmen", icon: "fa-solid fa-check", default: true,
        callback: (_event, button) => new FormData(button.form).get("talentUuid")
      },
      { action: "cancel", label: "Abbrechen" }
    ],
    close: () => null
  });
}

function setTalentSelection(root, uuid, name) {
  root.querySelector('[name="talent"]').value = uuid;
  root.querySelector("[data-tovf-selected-talent]").textContent = name;
  root.querySelector("[data-tovf-talent-drop]").classList.add("selected");
}

function setupBackgroundEditor(app, element) {
  if (!app.options.classes?.includes("tovf-custom-background-dialog")) return;
  const form = element.querySelector("form");
  const preview = element.querySelector("[data-tovf-background-image]");
  const imageInput = form?.elements.img;
  if (!form || !preview || !imageInput || preview.dataset.ready) return;
  preview.dataset.ready = "true";
  preview.addEventListener("click", () => {
    const Picker = foundry.applications.apps.FilePicker.implementation;
    new Picker({
      type: "image", current: imageInput.value,
      callback: path => { imageInput.value = path; preview.src = path; }
    }).browse();
  });

  const talents = currentTalents;
  element.querySelector("[data-tovf-browse-talents]")?.addEventListener("click", async () => {
    const uuid = await browseTalents(talents, form.elements.talent.value, currentActor);
    if (!uuid) return;
    const talent = talents.find(entry => entry.key === uuid);
    setTalentSelection(form, uuid, talent?.label ?? uuid);
  });

  const drop = element.querySelector("[data-tovf-talent-drop]");
  drop?.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("dragover"); });
  drop?.addEventListener("dragleave", () => drop.classList.remove("dragover"));
  drop?.addEventListener("drop", async event => {
    event.preventDefault();
    drop.classList.remove("dragover");
    try {
      const data = JSON.parse(event.dataTransfer.getData("text/plain"));
      const item = data.type === "Item" ? await Item.implementation.fromDropData(data) : null;
      if (item?.type !== "talent") return ui.notifications.warn("Hier kann nur ein Talent abgelegt werden.");
      setTalentSelection(form, item.uuid, item.name);
    } catch (error) {
      console.warn("tov-feuerschwinge-tools | Invalid talent drop", error);
    }
  });
}

function setupTalentBrowser(app, element) {
  if (!app.options.classes?.includes("tovf-talent-browser-dialog")) return;
  const search = element.querySelector("[data-tovf-talent-search]");
  if (!search || search.dataset.ready) return;
  search.dataset.ready = "true";
  search.addEventListener("input", () => {
    const needle = search.value.trim().toLocaleLowerCase(game.i18n.lang);
    for (const card of element.querySelectorAll(".tovf-talent-card")) card.hidden = !card.dataset.search.includes(needle);
  });
}

async function promptForBackground(actor) {
  const talents = await talentOptions(actor);
  currentTalents = talents;
  currentActor = actor;
  if (!talents.length) {
    ui.notifications.error("Die Auswahloptionen für den Custom Background konnten nicht geladen werden.");
    return null;
  }

  let draft = {
    name: "Custom Background", img: DEFAULT_IMAGE, description: "", motivation: "",
    talent: talents[0].key
  };

  while (true) {
    const selectedTalent = talents.find(talent => talent.key === draft.talent) ?? talents[0];
    const result = await foundry.applications.api.DialogV2.prompt({
      classes: ["tovf-custom-background-dialog"],
      window: { title: "Custom Background" },
      position: { width: 760 },
      content: `<div class="standard-form tovf-custom-background-form">
        <div class="tovf-background-name-row">
          <label><span>Name</span><input type="text" name="name" required value="${escape(draft.name)}"></label>
          <div class="tovf-background-starting-gold"><span>Startausrüstung</span><strong><i class="fa-solid fa-coins"></i> 50 gp</strong></div>
        </div>
        <div class="tovf-background-overview">
          <label class="tovf-background-image-field"><span>Bild auswählen</span>
            <img data-tovf-background-image src="${escape(draft.img || DEFAULT_IMAGE)}" alt="Background-Bild">
            <input type="hidden" name="img" value="${escape(draft.img || DEFAULT_IMAGE)}">
          </label>
          <div class="tovf-background-copy">
            <div class="tovf-background-description">
              <span class="tovf-background-field-label">Beschreibung</span>
              <prose-mirror name="description" value="${escape(draft.description)}" class="description" compact></prose-mirror>
            </div>
          </div>
        </div>
        <div class="tovf-background-motivation">
          <span class="tovf-background-field-label">Adventuring Motivation</span>
          <textarea name="motivation" rows="2">${escape(draft.motivation)}</textarea>
        </div>
        <div class="tovf-background-proficiency-note">
          <i class="fa-solid fa-circle-info"></i>
          <span><strong>Proficiencies im Character Sheet auswählen</strong>
            Nach dem Erstellen wählst du dort 2 Skill Proficiencies sowie 2 Tools oder Sprachen aus.</span>
        </div>
        <fieldset class="tovf-background-talent"><legend>Talent</legend>
          <input type="hidden" name="talent" value="${escape(selectedTalent.key)}">
          <button type="button" data-tovf-browse-talents><i class="fa-solid fa-list"></i> Talente ansehen und auswählen</button>
          <div class="tovf-talent-drop selected" data-tovf-talent-drop>
            <i class="fa-solid fa-arrow-down-to-bracket"></i>
            <span>Ausgewählt: <strong data-tovf-selected-talent>${escape(selectedTalent.label)}</strong></span>
            <small>Talent aus Welt oder Kompendium kann auch hier abgelegt werden.</small>
          </div>
        </fieldset>
      </div>`,
      ok: {
        label: "Background erstellen",
        callback: (_event, button) => ({
          ...Object.fromEntries(new FormData(button.form)),
          description: button.form.querySelector('prose-mirror[name="description"]')?.value ?? ""
        })
      },
      rejectClose: false
    });
    if (!result) return null;
    draft = result;
    if (!String(result.name ?? "").trim()) {
      ui.notifications.warn("Bitte einen Namen für den Background eingeben.");
      continue;
    }
    return result;
  }
}

function advancement(type, title, configuration, level = {}) {
  const _id = foundry.utils.randomID();
  return [_id, { _id, type, title, configuration, icon: null, flags: {}, level }];
}

async function createBackground(actor, data) {
  const source = {
    name: String(data.name).trim(),
    type: "background",
    img: String(data.img || DEFAULT_IMAGE),
    system: {
      description: { value: String(data.description ?? ""), source: {} },
      identifier: { value: identifier(data.name) },
      advancement: Object.fromEntries([
        advancement("trait", "Skill Proficiencies", {
          choices: [{ count: 2, pool: ["skills:*"] }],
          choiceMode: "inclusive", grants: [], mode: "default"
        }, { value: 0 }),
        advancement("trait", "Tools and Languages", {
          choices: [{ count: 2, pool: ["tools:*", "languages:*"] }],
          choiceMode: "inclusive", grants: [], mode: "default"
        }, { value: 0 }),
        advancement("chooseFeatures", "Talent", {
          choices: { "0": { count: 1, replacement: false } }, allowDrops: false,
          type: "talent", pool: [{ uuid: data.talent }], restriction: {}
        }),
        advancement("equipment", "Starting Equipment", {
          pool: [{
            _id: foundry.utils.randomID(), type: "linked", key: GOLD_UUID, count: 50,
            group: "", sort: 100000, requiresProficiency: false
          }]
        })
      ])
    }
  };
  const document = new CONFIG.Item.documentClass(source, { pack: null });
  await actor.system.setConcept(document);
  await actor.update({ "system.biography.motivation": String(data.motivation ?? "") });
}

async function chooseCustomBackground(app, button) {
  button.disabled = true;
  try {
    const data = await promptForBackground(app.actor);
    if (!data) return;
    await createBackground(app.actor, data);
    await app.close();
  } catch (error) {
    console.error("tov-feuerschwinge-tools | Custom Background creation failed", error);
    ui.notifications.error(`Custom Background konnte nicht erstellt werden: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function injectCustomBackground(app, element) {
  if (!app?.options?.classes?.includes("concept-selection-dialog") || app.type !== "background") return;
  const container = element.querySelector(".concept-selection-dialog .background, .window-content > .background");
  if (!container || container.querySelector("[data-tovf-custom-background]")) return;
  const section = document.createElement("section");
  section.className = "option tovf-custom-background-option";
  section.dataset.tovfCustomBackground = "true";
  section.innerHTML = `<figure class="poster">
      <img src="${DEFAULT_IMAGE}" alt="">
      <button type="button" class="light-button">${escape(game.i18n.localize("BF.Action.Choose.Generic"))}</button>
      <div class="window-mask" inert></div>
    </figure>
    <div class="info"><header><div class="name">Custom Background</div><div class="source">Feuerschwinge Tools</div></header>
      <div class="description"><p>Erstelle einen eigenen Background mit zwei Skill Proficiencies, zwei Tools oder Sprachen, einem Talent und 50 gp.</p></div>
    </div>`;
  section.querySelector("button").addEventListener("click", event => chooseCustomBackground(app, event.currentTarget));
  container.prepend(section);
}

export function installCustomBackground() {
  Hooks.on("renderApplicationV2", injectCustomBackground);
  Hooks.on("renderApplicationV2", setupBackgroundEditor);
  Hooks.on("renderApplicationV2", setupTalentBrowser);
}
