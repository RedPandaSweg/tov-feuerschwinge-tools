import { MODULE_ID } from "../core/constants.mjs";

let installed = false;
const ENCHANTMENT_LIBRARY_PACK = "feuerschwinge-enchantment-library";
const ENCHANTMENT_LIBRARY_COLLECTION = `world.${ENCHANTMENT_LIBRARY_PACK}`;

function escape(value) {
  return foundry.utils.escapeHTML(String(value ?? ""));
}

function effectsOnItems(items, prefix = "") {
  return items.flatMap(item => item.effects
    .filter(effect => effect.type === "enchantment")
    .map(effect => ({ uuid: effect.uuid, label: `${prefix}${item.name} · ${effect.name}` }))
  );
}

async function enchantmentLibrary() {
  let pack = game.packs.get(ENCHANTMENT_LIBRARY_COLLECTION);
  if (pack) return pack;
  pack = await foundry.documents.collections.CompendiumCollection.createCompendium({
    type: "Item",
    package: "world",
    name: ENCHANTMENT_LIBRARY_PACK,
    label: "Feuerschwinge Tools – Enchantment-Bibliothek"
  });
  return pack;
}

async function effectCandidates() {
  const pack = game.packs.get(ENCHANTMENT_LIBRARY_COLLECTION);
  if (!pack) return [];
  try {
    return effectsOnItems(await pack.getDocuments());
  } catch (error) {
    console.warn(`${MODULE_ID} | Enchantment-Bibliothek konnte nicht gelesen werden.`, error);
    return [];
  }
}

async function addProfile(activity, uuid) {
  const effect = await fromUuid(uuid).catch(() => null);
  if (!effect || effect.documentName !== "ActiveEffect" || effect.type !== "enchantment") {
    throw new Error("Die Auswahl verweist nicht auf ein Enchantment-Profil.");
  }
  const profiles = activity.toObject().system.effects ?? [];
  if (profiles.some(profile => profile.uuid === effect.uuid)) return false;
  await activity.update({ "system.effects": [...profiles, { _id: `${foundry.utils.randomID(10)}REMOTE`, uuid: effect.uuid }] });
  return true;
}

async function chooseWorldPreset(sheet) {
  const candidates = (await effectCandidates()).sort((left, right) => left.label.localeCompare(right.label, game.i18n.lang));
  if (!candidates.length) {
    ui.notifications.warn("Die Feuerschwinge-Enchantment-Bibliothek enthält noch keine Profile. Erstelle zuerst ein einfaches Enchantment.");
    return;
  }
  const listId = `tovf-enchantment-library-${foundry.utils.randomID()}`;
  const options = candidates.map(candidate => (
    `<option value="${escape(candidate.uuid)}" label="${escape(candidate.label)}"></option>`
  )).join("");
  const uuid = await BlackFlag.applications.api.BFDialog.wait({
    window: { title: "Feuerschwinge – Enchantment-Bibliothek" },
    content: `<section class="tovf-enchantment-dialog"><header><i class="fa-solid fa-dragon"></i> Feuerschwinge Tools</header><div class="form-group"><label>Enchantment-Profil</label><div class="form-fields"><input name="uuid" list="${listId}" placeholder="Nach Preset suchen"><datalist id="${listId}">${options}</datalist></div></div></section>`,
    buttons: [
      {
        action: "add",
        label: "Hinzufügen",
        icon: "<i class='fa-solid fa-plus'></i>",
        default: true,
        callback: (_event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.uuid
      },
      { action: "cancel", label: game.i18n.localize("Cancel"), callback: () => null }
    ],
    rejectClose: false
  });
  if (uuid && await addProfile(sheet.activity, uuid)) sheet.render();
}

function numeric(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function createWeaponPreset(sheet) {
  const abilityOptions = [
    `<option value="spellcasting">Zauberattribut</option>`,
    ...CONFIG.BlackFlag.abilities.localizedOptions.map(ability => (
      `<option value="${escape(ability.value)}">${escape(ability.label)}</option>`
    ))
  ].join("");
  const saveAbilityOptions = [
    `<option value="">Alle Rettungswürfe</option>`,
    ...CONFIG.BlackFlag.abilities.localizedOptions.map(ability => (
      `<option value="${escape(ability.value)}">${escape(ability.label)}</option>`
    ))
  ].join("");
  const dieOptions = `<option value="">Unverändert</option>${CONFIG.BlackFlag.dieSteps
    .map(die => `<option value="${die}">d${die}</option>`).join("")}`;
  const data = await BlackFlag.applications.api.BFDialog.wait({
    window: { title: "Feuerschwinge – Einfaches Enchantment" },
    content: `<section class="tovf-enchantment-dialog"><header><i class="fa-solid fa-dragon"></i> Feuerschwinge Tools · Enchantment-Preset</header><fieldset class="tovf-enchantment-preset-form">
      <legend>Enchantment-Profil</legend>
      <div class="form-group"><label>Name</label><div class="form-fields"><input name="name" type="text" value="${escape(sheet.activity.name)}"></div></div>
      <div class="form-group"><label>Gegenstandstyp</label><div class="form-fields"><select name="targetType"><option value="weapon">Waffe</option><option value="armor">Rüstung</option><option value="">Beliebiges Equipment</option></select></div></div>
      <div class="form-group"><label>Angriffsattribut</label><div class="form-fields"><select name="ability">${abilityOptions}</select><select name="abilityMode"><option value="always">Immer verwenden</option><option value="higher">Nur bei höherem Modifikator</option></select></div></div>
      <div class="form-group"><label>Angriffsbonus</label><div class="form-fields"><input name="attackBonus" type="text" placeholder="z. B. 1"></div></div>
      <div class="form-group"><label>Schadensbonus</label><div class="form-fields"><input name="damageBonus" type="text" placeholder="z. B. 1"></div></div>
      <div class="form-group"><label>Schadenswürfel</label><div class="form-fields"><select name="damageMode"><option value="none">Unverändert</option><option value="minimum">Mindestens</option><option value="replace">Ersetzen</option><option value="formula">Eigene Formel</option></select><select name="damageDenomination">${dieOptions}</select></div></div>
      <div class="form-group"><label>Eigene Schadensformel</label><div class="form-fields"><input name="damageFormula" type="text" placeholder="z. B. 1d8 + @mod"></div></div>
      <div class="form-group"><label>Zusätzliche Crit-Würfel</label><div class="form-fields"><input name="criticalBonusDice" type="number" min="0" value="0"></div></div>
      <div class="form-group"><label>Bonus auf AC</label><div class="form-fields"><input name="armorClassBonus" type="text" placeholder="z. B. 1 oder @attributes.proficiency"></div></div>
      <div class="form-group"><label>Bonus auf Rettungswürfe</label><div class="form-fields"><input name="saveBonus" type="text" placeholder="z. B. 1 oder 1d4"><select name="saveAbility">${saveAbilityOptions}</select></div></div>
      <div class="form-group"><label>Magisch</label><div class="form-fields"><input name="magical" type="checkbox" checked></div></div>
    </fieldset></section>`,
    buttons: [
      {
        action: "create",
        label: "Profil erstellen",
        icon: "<i class='fa-solid fa-wand-magic-sparkles'></i>",
        default: true,
        callback: (_event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
      },
      { action: "cancel", label: game.i18n.localize("Cancel"), callback: () => null }
    ],
    rejectClose: false
  });
  if (!data) return;

  const magical = data.magical === true || data.magical === "true" || data.magical === "on";
  const armorClassBonus = String(data.armorClassBonus ?? "").trim();
  const saveBonus = String(data.saveBonus ?? "").trim();
  const changes = magical ? [{ key: "system.properties", type: "add", value: "magical", priority: 20 }] : [];
  if (armorClassBonus) changes.push({
    key: "system.modifiers",
    type: "add",
    value: JSON.stringify({
      type: "bonus",
      filter: [{ k: "type", v: "armor-class" }],
      formula: armorClassBonus
    })
  });
  if (saveBonus) {
    const filter = [{ k: "type", v: "ability-save" }];
    if (data.saveAbility) filter.push({ k: "ability", v: String(data.saveAbility) });
    changes.push({
      key: "system.modifiers",
      type: "add",
      value: JSON.stringify({ type: "bonus", filter, formula: saveBonus })
    });
  }
  const effectData = {
    name: String(data.name || sheet.activity.name || "Waffen-Enchantment").trim(),
    img: sheet.activity.img || sheet.item.img,
    type: "enchantment",
    disabled: false,
    transfer: false,
    system: { magical },
    flags: {
      [MODULE_ID]: {
        weaponEnchantment: {
          ability: String(data.ability || "spellcasting"),
          abilityMode: data.abilityMode === "higher" ? "higher" : "always",
          damageMode: ["minimum", "replace", "formula"].includes(data.damageMode) ? data.damageMode : "none",
          damageDenomination: data.damageDenomination ? numeric(data.damageDenomination, null) : null,
          damageFormula: String(data.damageFormula ?? "").trim(),
          magical,
          attackBonus: String(data.attackBonus ?? "").trim(),
          damageBonus: String(data.damageBonus ?? "").trim(),
          criticalBonusDice: Math.max(0, Math.floor(numeric(data.criticalBonusDice))),
          manualChanges: []
        }
      }
    },
    changes
  };
  const pack = await enchantmentLibrary();
  const [item] = await pack.documentClass.createDocuments([{
    name: effectData.name,
    type: "equipment",
    img: effectData.img,
    effects: [effectData],
    flags: { [MODULE_ID]: { enchantmentLibrary: true } }
  }], { pack: pack.collection });
  const effect = item.effects.find(entry => entry.type === "enchantment");
  if (!effect) throw new Error("Das Enchantment-Profil konnte nicht in der Feuerschwinge-Bibliothek gespeichert werden.");
  await addProfile(sheet.activity, effect.uuid);
  await sheet.activity.update({ "system.restrictions.type": String(data.targetType ?? "") });
  sheet.render();
}

/** Add convenience controls without replacing Black Flag's Enchant activity or its data model. */
export function installEnchantActivityUi() {
  if (installed) return { status: "already-installed" };
  const NativeSheet = CONFIG.Activity?.types?.enchant?.sheetClasses?.config;
  if (typeof NativeSheet !== "function" || !BlackFlag?.applications?.api?.BFDialog?.wait) {
    return { status: "incompatible", reason: "Black Flag Enchant sheet or dialog API is unavailable." };
  }

  class EnchantSheetWithPresets extends NativeSheet {
    _onRender(context, options) {
      super._onRender(context, options);
      const add = this.element.querySelector("button[data-action='addEffect']");
      if (!add || add.closest(".add-control")?.querySelector("[data-tovf-enchantment-action]")) return;
      const controls = document.createElement("li");
      controls.className = "add-control tovf-enchantment-controls";
      controls.innerHTML = `<button type="button" class="link-button tovf-enchantment-action" data-tovf-enchantment-action="world"><i class="fa-solid fa-dragon" inert></i> Feuerschwinge-Preset auswählen</button><button type="button" class="link-button tovf-enchantment-action" data-tovf-enchantment-action="weapon"><i class="fa-solid fa-wand-magic-sparkles" inert></i> Feuerschwinge-Enchantment erstellen</button>`;
      add.closest(".add-control").before(controls);
      controls.addEventListener("click", event => {
        const action = event.target.closest("[data-tovf-enchantment-action]")?.dataset.tovfEnchantmentAction;
        if (!action) return;
        event.preventDefault();
        if (action === "world") void chooseWorldPreset(this);
        if (action === "weapon") void createWeaponPreset(this);
      });
    }
  }

  CONFIG.Activity.types.enchant.sheetClasses.config = EnchantSheetWithPresets;
  installed = true;
  return { status: "completed" };
}
