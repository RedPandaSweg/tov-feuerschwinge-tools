const LEARNING_MODE = "theurge";
const THEURGE_SOURCES = Object.freeze(["arcane", "divine"]);
let installed = false;

function installTheurgeSourceSelection() {
  const Spellcasting = CONFIG.Advancement?.types?.spellcasting?.documentClass;
  const prototype = Spellcasting?.prototype;
  const originalSlotSources = prototype?.slotSources;
  if (typeof originalSlotSources !== "function") return false;
  if (originalSlotSources.__tovfTheurgeSourceSelection) return true;

  const slotSources = function(levels, slot) {
    if (this.configuration.spells.mode !== LEARNING_MODE) {
      return originalSlotSources.call(this, levels, slot);
    }

    const sources = new Set(THEURGE_SOURCES);
    if (this.configuration.permissiveSources) return sources;

    const total = this.statsForLevel(levels).get(slot?.type)?.total ?? 0;
    if (total < sources.size) return sources;

    const numericLevel = Number(levels);
    const level = Number.isFinite(numericLevel) ? numericLevel : this.relavantLevel(levels);
    const isFirstLevel = level === this.level.value;
    const divisor = Math.floor(total / (sources.size + (isFirstLevel ? 1 : 0)));
    if (divisor < 1 || !Number.isInteger(slot?.number)) return sources;

    const source = THEURGE_SOURCES[Math.floor(slot.number / divisor)];
    return source ? new Set([source]) : sources;
  };

  Object.defineProperty(slotSources, "__tovfTheurgeSourceSelection", { value: true });
  prototype.slotSources = slotSources;
  return true;
}

function installTheurgeReplacementFix() {
  const Dialog = globalThis.BlackFlag?.applications?.advancement?.SpellcastingDialog;
  const actions = Dialog?.DEFAULT_OPTIONS?.actions;
  const originalLearn = actions?.learn;
  if (!originalLearn || originalLearn.__tovfTheurgeReplacementFix) return Boolean(originalLearn);

  const learn = async function(event, target) {
    if (this.advancement.configuration.spells.mode !== LEARNING_MODE) {
      return originalLearn.call(this, event, target);
    }

    const toAdd = new Map();
    const toRemove = new Set();
    let replacement;
    const visibleSlots = new Set();

    for (const slot of this.slots) {
      visibleSlots.add(slot.type);
      if (!slot.selected) continue;
      if (slot.type === "replacement") replacement = { original: slot.replaces, replacement: slot.selected };
      else toAdd.set(slot.selected, { slot: slot.type, slotNumber: slot.number });
    }

    for (const spell of this.advancement._getAddedSpells(this.levels)) {
      if (!visibleSlots.has(spell.slot) || spell.slot === "replacement") continue;
      // Black Flag currently checks `.type` here, although the selection data uses `.slot`.
      // That marks unchanged spells for deletion and makes replacement delete the same Item twice.
      if (toAdd.get(spell.uuid)?.slot === spell.slot) toAdd.delete(spell.uuid);
      else toRemove.add(spell.document);
    }

    await this.close();

    if (toRemove.size) await this.advancement.reverse(this.levels, { deleteIds: toRemove });
    if (toAdd.size || replacement) {
      await this.advancement.apply(this.levels, {
        added: Array.from(toAdd.entries()).map(([uuid, { slot, slotNumber }]) => ({ uuid, slot, slotNumber })),
        replacement
      });
    }
  };

  Object.defineProperty(learn, "__tovfTheurgeReplacementFix", { value: true });
  actions.learn = learn;
  return true;
}

function installTheurgeLearningMode() {
  const modes = CONFIG.BlackFlag?.spellLearningModes;
  if (!modes) return false;
  modes[LEARNING_MODE] = {
    label: "TOVF.Theurge.LearningMode.Label",
    hint: "TOVF.Theurge.LearningMode.Hint",
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
    return level > this.level.value;
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
      return context;
    };
    Object.defineProperty(configPrototype, "__tovfTheurgeLearningMode", { value: true, configurable: true });
  }

  return true;
}

export function installTheurgeSpellcasting() {
  if (installed) return { status: "already-installed" };
  const spellcastingType = CONFIG.Advancement?.types?.spellcasting;
  const missing = [];
  if (!CONFIG.BlackFlag?.spellLearningModes) missing.push("CONFIG.BlackFlag.spellLearningModes");
  if (typeof spellcastingType?.documentClass?.prototype?.learnsSpellsAt !== "function") {
    missing.push("SpellcastingAdvancement.learnsSpellsAt");
  }
  if (typeof spellcastingType?.documentClass?.prototype?.replacesSpellAt !== "function") {
    missing.push("SpellcastingAdvancement.replacesSpellAt");
  }
  if (typeof spellcastingType?.documentClass?.prototype?.slotSources !== "function") {
    missing.push("SpellcastingAdvancement.slotSources");
  }
  if (typeof spellcastingType?.sheetClasses?.config?.prototype?._prepareLearningContext !== "function") {
    missing.push("SpellcastingConfig._prepareLearningContext");
  }
  if (typeof globalThis.BlackFlag?.applications?.advancement?.SpellcastingDialog?.DEFAULT_OPTIONS?.actions?.learn !== "function") {
    missing.push("SpellcastingDialog.actions.learn");
  }
  if (missing.length) {
    return { status: "incompatible", reason: `Missing Black Flag APIs: ${missing.join(", ")}.` };
  }
  installed = true;
  installTheurgeLearningMode();
  installTheurgeSourceSelection();
  installTheurgeReplacementFix();
  return { status: "completed" };
}
