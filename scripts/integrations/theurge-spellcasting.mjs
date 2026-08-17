const LEARNING_MODE = "theurge";
let installed = false;

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
  if (installed) return;
  installed = true;
  installTheurgeLearningMode();
}
