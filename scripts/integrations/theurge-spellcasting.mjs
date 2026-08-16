import { CONTENT_MODULE_ID, MODULE_ID } from "../core/constants.mjs";

const THEURGE_IDENTIFIER = "theurge";
const LEARNING_MODE = "theurge";
let installed = false;

function advancementIdentifier(advancement) {
  return String(advancement?.identifier ?? advancement?.configuration?.identifier ?? "").toLowerCase();
}

function findSpellcastingValue(advancements, identifier, title) {
  return Object.values(advancements).find(advancement => (
    advancement?.type === "spellcastingValue"
    && (advancementIdentifier(advancement) === identifier || advancement?.title === title)
  ));
}

function theurgeSpellScale() {
  return Object.fromEntries(Array.fromRange(20, 1).map(level => [level, { value: 4 + (2 * level) }]));
}

function normalizeTheurgeSource(item) {
  if (item?.type !== "class" || String(item.system?.identifier?.value ?? item.identifier ?? "") !== THEURGE_IDENTIFIER) {
    return false;
  }

  const source = foundry.utils.deepClone(item._source?.system?.advancement ?? item.system?.advancement ?? {});
  const spellcasting = Object.values(source).filter(advancement => advancement?.type === "spellcasting");
  if (!spellcasting.length) return false;

  const primary = spellcasting[0];
  const spellsKnown = findSpellcastingValue(source, "spells-known", "Spells Known");
  const cantripsKnown = findSpellcastingValue(source, "cantrips-known", "Cantrips Known");
  const ritualsKnown = findSpellcastingValue(source, "rituals-known", "Rituals Known");
  if (!spellsKnown) {
    console.error(`${MODULE_ID} | Theurge spellcasting could not find its Spells Known advancement.`);
    return false;
  }

  spellsKnown.configuration ??= {};
  spellsKnown.configuration.scale = theurgeSpellScale();

  primary.configuration ??= {};
  primary.configuration.sources = ["arcane", "divine"];
  primary.configuration.permissiveSources = false;
  delete primary.configuration.source;
  primary.configuration.spells ??= {};
  primary.configuration.spells.mode = LEARNING_MODE;
  primary.configuration.spells.scale = spellsKnown._id;
  primary.configuration.spells.replacement = true;
  primary.configuration.cantrips ??= {};
  primary.configuration.cantrips.scale = cantripsKnown?._id ?? primary.configuration.cantrips.scale;
  primary.configuration.rituals ??= {};
  primary.configuration.rituals.scale = ritualsKnown?._id ?? primary.configuration.rituals.scale;
  primary.title = "Theurge Spellcasting";

  for (const duplicate of spellcasting.slice(1)) delete source[duplicate._id];
  item.updateSource({ "system.advancement": source });
  return true;
}

function installTheurgeLearningMode() {
  const modes = CONFIG.BlackFlag?.spellLearningModes;
  if (!modes) return false;
  modes[LEARNING_MODE] = {
    label: "Theurge (Known and Prepared)",
    hint: "Learns a limited repertoire and prepares a number of spells equal to Theurge level + INT modifier.",
    prepared: true
  };

  const Spellcasting = CONFIG.Advancement?.types?.spellcasting?.documentClass;
  const prototype = Spellcasting?.prototype;
  if (!prototype || prototype.__tovfTheurgeLearningMode) return Boolean(prototype);
  const originalLearnsSpellsAt = prototype.learnsSpellsAt;
  const originalReplacesSpellAt = prototype.replacesSpellAt;

  prototype.learnsSpellsAt = function(level) {
    if (this.configuration.spells.mode !== LEARNING_MODE) return originalLearnsSpellsAt.call(this, level);
    if (level < this.level.value) return false;
    if (level in (this.configuration.cantrips.scaleValue?.configuration.scale ?? {})) return true;
    if (level in (this.configuration.rituals.scaleValue?.configuration.scale ?? {})) return true;
    return level in (this.configuration.spells.scaleValue?.configuration.scale ?? {});
  };

  prototype.replacesSpellAt = function(level) {
    if (this.configuration.spells.mode !== LEARNING_MODE) return originalReplacesSpellAt.call(this, level);
    return level > this.level.value && this.configuration.spells.replacement;
  };

  Object.defineProperty(prototype, "__tovfTheurgeLearningMode", { value: true, configurable: true });

  const ConfigApp = CONFIG.Advancement?.types?.spellcasting?.sheetClasses?.config;
  const configPrototype = ConfigApp?.prototype;
  if (configPrototype && !configPrototype.__tovfTheurgeLearningMode) {
    const originalPrepareLearningContext = configPrototype._prepareLearningContext;
    configPrototype._prepareLearningContext = async function(context, options) {
      context = await originalPrepareLearningContext.call(this, context, options);
      if (this.advancement.configuration.spells.mode !== LEARNING_MODE) return context;
      const config = this.advancement.configuration.spells;
      const anchor = config.scaleValue?.toAnchor();
      if (anchor) anchor.dataset.action = "openScale";
      context.known ??= {};
      context.known.spells = {
        ...this.constructor.KNOWN.spells,
        anchor: anchor?.outerHTML,
        scaleValue: config.scaleValue
      };
      context.tovfTheurgeMode = true;
      return context;
    };
    Object.defineProperty(configPrototype, "__tovfTheurgeLearningMode", { value: true, configurable: true });
  }

  Hooks.on("renderApplicationV2", app => {
    if (app?.advancement?.configuration?.spells?.mode !== LEARNING_MODE) return;
    const spellsRow = app.element?.querySelector('[data-name="spells"]');
    const fieldset = spellsRow?.closest("fieldset");
    if (!fieldset || fieldset.querySelector('[data-tovf-theurge-replacement]')) return;
    const checked = app.advancement.configuration.spells.replacement ? "checked" : "";
    fieldset.insertAdjacentHTML("beforeend", `
      <div class="form-group" data-tovf-theurge-replacement>
        <label>Spell Replacement</label>
        <div class="form-fields">
          <input type="checkbox" name="configuration.spells.replacement" ${checked}>
        </div>
        <p class="hint">Allows replacing one previously learned spell when gaining a Theurge level.</p>
      </div>
    `);
  });
  return true;
}

async function normalizeCompendiumTheurge() {
  const packs = game.packs.filter(pack => (
    pack.documentName === "Item"
    && (pack.metadata.packageName ?? pack.metadata.package) === CONTENT_MODULE_ID
  ));
  for (const pack of packs) {
    const index = await pack.getIndex({ fields: ["type", "system.identifier.value"] });
    const entry = index.find(candidate => (
      candidate.type === "class"
      && candidate.system?.identifier?.value === THEURGE_IDENTIFIER
    ));
    if (!entry) continue;
    const document = await pack.getDocument(entry._id);
    if (normalizeTheurgeSource(document)) {
      console.info(`${MODULE_ID} | Prepared corrected Theurge spellcasting configuration from ${document.uuid}.`);
    }
    return;
  }
}

export function installTheurgeSpellcasting() {
  if (installed) return;
  installed = true;
  installTheurgeLearningMode();
  Hooks.on("preCreateItem", item => normalizeTheurgeSource(item));
  Hooks.once("ready", () => void normalizeCompendiumTheurge().catch(error => {
    console.error(`${MODULE_ID} | Failed to prepare Theurge spellcasting.`, error);
    ui.notifications.error(`Theurge-Spellcasting konnte nicht vorbereitet werden: ${error.message}`);
  }));
}
