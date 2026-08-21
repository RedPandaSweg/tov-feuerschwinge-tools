import { LEGACY_MODULE_ID, MODULE_ID, modulePath } from "./core/constants.mjs";
const SETTING = "weaponDefinitions";

const MECHANICS = {
  none: "BFI.Weapon.Mechanic.None",
  versatile: "BFI.Weapon.Mechanic.Versatile",
  finesse: "BFI.Weapon.Mechanic.Finesse",
  light: "BFI.Weapon.Mechanic.Light",
  thrown: "BFI.Weapon.Mechanic.Thrown",
  twoHanded: "BFI.Weapon.Mechanic.TwoHanded",
  reach: "BFI.Weapon.Mechanic.Reach",
  bonuses: "BFI.Weapon.Mechanic.Bonuses"
};

function normalizeDefinitions(value = {}) {
  const clean = list => Object.values(list ?? {}).map(entry => ({
    id: String(entry.id ?? "").trim().replace(/[^a-zA-Z0-9_-]/g, ""),
    label: String(entry.label ?? "").trim(),
    description: String(entry.description ?? "").trim(),
    mechanic: entry.mechanic in MECHANICS ? entry.mechanic : "none",
    dieSteps: Math.max(1, Number(entry.dieSteps) || 1),
    reachBonus: Number(entry.reachBonus) || 0,
    attackBonus: String(entry.attackBonus ?? "").trim(),
    damageBonus: String(entry.damageBonus ?? "").trim(),
    buttonLabel: String(entry.buttonLabel ?? "").trim(),
    macroMode: entry.macroMode === "inline" ? "inline" : "linked",
    macroUuid: String(entry.macroUuid ?? "").trim(),
    command: String(entry.command ?? "").trim(),
    macroVisibility: entry.macroVisibility === "all" ? "all" : "owner"
  })).filter(entry => entry.id && entry.label);
  return { properties: clean(value.properties), options: clean(value.options) };
}

function getDefinitions() {
  return normalizeDefinitions(game.settings.get(MODULE_ID, SETTING));
}

function selectedDefinitions(item) {
  const definitions = getDefinitions();
  return [
    ...definitions.properties.filter(entry => item.system.properties?.has(entry.id)),
    ...definitions.options.filter(entry => item.system.options?.has(entry.id))
  ];
}

function findSelectedDefinition(item, id) {
  return selectedDefinitions(item).find(definition => definition.id === id) ?? null;
}

function getWeaponEnchantment(item) {
  const effect = item.effects?.find(effect => effect.active && (
    effect.getFlag(MODULE_ID, "weaponEnchantment")
    || effect.flags?.[LEGACY_MODULE_ID]?.weaponEnchantment
  ));
  return effect?.getFlag(MODULE_ID, "weaponEnchantment")
    ?? effect?.flags?.[LEGACY_MODULE_ID]?.weaponEnchantment
    ?? null;
}

function resolveEnchantmentAbility(actor, configured) {
  if (configured !== "spellcasting") return configured;
  const spellcasting = actor?.system.spellcasting;
  const candidates = new Set([
    spellcasting?.ability,
    ...Object.values(spellcasting?.origins ?? {}).map(origin => origin.ability)
  ].filter(Boolean));
  const abilities = actor?.system.abilities ?? {};
  return Array.from(candidates).reduce((best, ability) =>
    (abilities[ability]?.mod ?? -Infinity) > (abilities[best]?.mod ?? -Infinity) ? ability : best
  , candidates.first() ?? null);
}

function addMode(modes, value) {
  if (modes.some(mode => mode.value === value)) return;
  const label = CONFIG.BlackFlag.attackModes.localized[value];
  if (label) modes.push({ value, label });
}

function registerDefinitions() {
  const definitions = getDefinitions();
  for (const definition of definitions.properties) {
    CONFIG.BlackFlag.itemProperties[definition.id] = { label: definition.label };
    if (!CONFIG.BlackFlag.weaponProperties.includes(definition.id)) {
      CONFIG.BlackFlag.weaponProperties.push(definition.id);
    }
  }
  for (const definition of definitions.options) {
    CONFIG.BlackFlag.weaponOptions[definition.id] = { label: definition.label };
  }
}

function installWeaponMechanics() {
  const WeaponData = BlackFlag.data.item.WeaponData;
  const AttackActivity = BlackFlag.documents.activity.AttackActivity;

  const attackModesDescriptor = Object.getOwnPropertyDescriptor(WeaponData.prototype, "attackModes");
  Object.defineProperty(WeaponData.prototype, "attackModes", {
    configurable: true,
    get() {
      const modes = attackModesDescriptor.get.call(this);
      for (const definition of selectedDefinitions(this.parent)) {
        if (definition.mechanic === "versatile") {
          addMode(modes, "oneHanded");
          addMode(modes, "twoHanded");
        } else if (definition.mechanic === "light") {
          addMode(modes, "offhand");
          if (modes.some(mode => mode.value === "thrown")) addMode(modes, "thrownOffhand");
        } else if (definition.mechanic === "thrown") {
          addMode(modes, "thrown");
          if (selectedDefinitions(this.parent).some(entry => entry.mechanic === "light")) addMode(modes, "thrownOffhand");
        } else if (definition.mechanic === "twoHanded") {
          const filtered = modes.filter(mode => mode.value !== "oneHanded");
          modes.splice(0, modes.length, ...filtered);
          addMode(modes, "twoHanded");
        }
      }
      return modes;
    }
  });

  const abilitiesDescriptor = Object.getOwnPropertyDescriptor(WeaponData.prototype, "availableAbilities");
  Object.defineProperty(WeaponData.prototype, "availableAbilities", {
    configurable: true,
    get() {
      const abilities = abilitiesDescriptor.get.call(this);
      if (selectedDefinitions(this.parent).some(entry => entry.mechanic === "finesse")) {
        abilities.add(CONFIG.BlackFlag.defaultAbilities.meleeAttack);
        abilities.add(CONFIG.BlackFlag.defaultAbilities.rangedAttack);
      }
      return abilities;
    }
  });

  const attackTypesDescriptor = Object.getOwnPropertyDescriptor(WeaponData.prototype, "validAttackTypes");
  Object.defineProperty(WeaponData.prototype, "validAttackTypes", {
    configurable: true,
    get() {
      const types = attackTypesDescriptor.get.call(this);
      if (selectedDefinitions(this.parent).some(entry => entry.mechanic === "thrown")) types.add("ranged");
      return types;
    }
  });

  const prepareDerivedData = WeaponData.prototype.prepareDerivedData;
  WeaponData.prototype.prepareDerivedData = function() {
    prepareDerivedData.call(this);
    const bonus = selectedDefinitions(this.parent)
      .filter(entry => entry.mechanic === "reach")
      .reduce((total, entry) => total + entry.reachBonus, 0);
    if (bonus && this.type.value === "melee") this.range.reach += bonus;
  };

  const getAttackDetails = AttackActivity.prototype.getAttackDetails;
  AttackActivity.prototype.getAttackDetails = function(config = {}) {
    const details = getAttackDetails.call(this, config);
    if (!details || this.item.type !== "weapon") return details;
    const enchantment = getWeaponEnchantment(this.item);
    const bonuses = selectedDefinitions(this.item)
      .filter(entry => entry.mechanic === "bonuses" && entry.attackBonus)
      .map(entry => entry.attackBonus);
    if (enchantment?.attackBonus) bonuses.push(enchantment.attackBonus);
    details.parts.push(...bonuses);
    details.formula = Roll.replaceFormulaData(details.parts.join(" + "), details.data, { missing: "0" });
    return details;
  };

  const processDamagePart = AttackActivity.prototype._processDamagePart;
  AttackActivity.prototype._processDamagePart = function(damage, rollConfig, rollData, config = {}) {
    const definitions = this.item.type === "weapon" ? selectedDefinitions(this.item) : [];
    const enchantment = this.item.type === "weapon" ? getWeaponEnchantment(this.item) : null;
    if (damage.base && rollConfig.attackMode === "twoHanded") {
      const steps = Math.max(0, ...definitions
        .filter(entry => entry.mechanic === "versatile")
        .map(entry => entry.dieSteps));
      if (steps && damage.denomination) {
        const dice = CONFIG.BlackFlag.dieSteps;
        damage = damage.clone({
          ...damage,
          denomination: dice[Math.min(dice.length - 1, dice.indexOf(damage.denomination) + steps)]
        });
      }
    }
    if (damage.base && enchantment?.damageMode !== "none" && enchantment?.damageDenomination) {
      const dice = CONFIG.BlackFlag.dieSteps;
      const current = dice.indexOf(damage.denomination);
      const replacement = dice.indexOf(Number(enchantment.damageDenomination));
      if (replacement >= 0 && (enchantment.damageMode === "replace" || replacement > current)) {
        damage = damage.clone({ ...damage, denomination: Number(enchantment.damageDenomination) });
      }
    }
    if (damage.base && enchantment?.damageMode === "formula" && enchantment?.damageFormula) {
      const source = damage.toObject(false);
      source.custom = { enabled: true, formula: enchantment.damageFormula };
      damage = damage.clone(source);
    }
    const roll = processDamagePart.call(this, damage, rollConfig, rollData, config);
    if (damage.base) {
      roll.parts.push(...definitions
        .filter(entry => entry.mechanic === "bonuses" && entry.damageBonus)
        .map(entry => entry.damageBonus));
      if (enchantment?.damageBonus) roll.parts.push(enchantment.damageBonus);
      const criticalBonusDice = Math.max(0, Number(enchantment?.criticalBonusDice) || 0);
      if (criticalBonusDice) {
        const existing = Number(foundry.utils.getProperty(roll, "options.critical.bonusDice")) || 0;
        foundry.utils.setProperty(roll, "options.critical.bonusDice", existing + criticalBonusDice);
      }
    }
    return roll;
  };

  const abilityDescriptor = Object.getOwnPropertyDescriptor(AttackActivity.prototype, "ability");
  Object.defineProperty(AttackActivity.prototype, "ability", {
    configurable: true,
    get() {
      const normal = abilityDescriptor.get.call(this);
      if (this.item.type !== "weapon") return normal;
      const enchantment = getWeaponEnchantment(this.item);
      const override = resolveEnchantmentAbility(this.actor, enchantment?.ability);
      if (!override) return normal;
      if (enchantment.abilityMode !== "higher") return override;
      const abilities = this.actor?.system.abilities;
      return (abilities?.[override]?.mod ?? -Infinity) > (abilities?.[normal]?.mod ?? -Infinity) ? override : normal;
    }
  });

  const activationChatButtons = AttackActivity.prototype._activationChatButtons;
  AttackActivity.prototype._activationChatButtons = function(...args) {
    const buttons = activationChatButtons.call(this, ...args);
    if (this.item.type !== "weapon") return buttons;
    for (const definition of selectedDefinitions(this.item)) {
      const configured = definition.macroMode === "inline" ? definition.command : definition.macroUuid;
      if (!configured) continue;
      buttons.push({
        label: definition.buttonLabel || definition.label,
        icon: '<i class="fa-solid fa-code" inert></i>',
        dataset: {
          action: "runCustomWeaponMacro",
          definitionId: definition.id,
          visibility: definition.macroVisibility === "all" ? "all" : undefined
        }
      });
    }
    return buttons;
  };

  AttackActivity.metadata.usage.actions.runCustomWeaponMacro = async function(event, target, message) {
    try {
      const definition = findSelectedDefinition(this.item, target.dataset.definitionId);
      if (!definition) throw new Error(game.i18n.localize("BFI.Weapon.Macro.NotFound"));
      if (definition.macroVisibility !== "all" && !this.item.isOwner) {
        throw new Error(game.i18n.localize("BFI.Weapon.Macro.NoPermission"));
      }

      const scope = {
        actor: this.actor,
        token: this.actor?.token?.object ?? canvas.tokens?.controlled.find(token => token.actor?.id === this.actor?.id) ?? null,
        item: this.item,
        activity: this,
        event,
        message,
        definition,
        targets: Array.from(game.user.targets ?? []),
        lastAttack: message?.getAssociatedRolls?.("attack")?.pop() ?? null
      };

      if (definition.macroMode === "linked") {
        const reference = definition.macroUuid;
        const macro = reference.includes(".") ? await fromUuid(reference) : game.macros.get(reference);
        if (!(macro instanceof Macro)) throw new Error(game.i18n.localize("BFI.Weapon.Macro.NotFound"));
        return macro.execute(scope);
      }

      if (!definition.command) throw new Error(game.i18n.localize("BFI.Weapon.Macro.Empty"));
      const macro = await Macro.create({
        name: definition.buttonLabel || definition.label,
        type: "script",
        command: definition.command
      }, { temporary: true });
      return macro.execute(scope);
    } catch (error) {
      console.error(`${MODULE_ID} | Custom weapon macro failed.`, error);
      ui.notifications.error(game.i18n.format("BFI.Weapon.Macro.Error", { message: error.message }));
    }
  };
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class WeaponCustomizationConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tov-feuerschwinge-weapon-config",
    tag: "form",
    classes: ["standard-form", "bfi-weapon-config"],
    position: { width: 760, height: 720 },
    window: { title: "BFI.Weapon.Settings.Title", resizable: true },
    actions: {
      addProperty: this.#addProperty,
      addOption: this.#addOption,
      deleteDefinition: this.#deleteDefinition
    },
    form: { closeOnSubmit: true, handler: this.#save }
  };

  static PARTS = {
    form: {
      template: modulePath("templates/weapon-customization.hbs"),
      scrollable: [""]
    }
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const definitions = getDefinitions();
    return {
      ...context,
      properties: definitions.properties,
      options: definitions.options,
      sections: [
        { kind: "properties", label: "BFI.Weapon.Properties", entries: definitions.properties, addAction: "addProperty" },
        { kind: "options", label: "BFI.Weapon.Options", entries: definitions.options, addAction: "addOption" }
      ],
      mechanics: Object.entries(MECHANICS).map(([value, label]) => ({ value, label }))
    };
  }

  static #readForm(form) {
    const data = foundry.utils.expandObject(new foundry.applications.ux.FormDataExtended(form).object);
    return normalizeDefinitions(data);
  }

  static async #addProperty(event, target) {
    const value = this.constructor.#readForm(this.element);
    const number = value.properties.length + 1;
    value.properties.push({ id: `customProperty${number}`, label: `Custom Property ${number}`, description: "", mechanic: "none", dieSteps: 1, macroMode: "linked", macroVisibility: "owner" });
    await game.settings.set(MODULE_ID, SETTING, value);
    this.render({ force: true });
  }

  static async #addOption(event, target) {
    const value = this.constructor.#readForm(this.element);
    const number = value.options.length + 1;
    value.options.push({ id: `customOption${number}`, label: `Custom Option ${number}`, description: "", mechanic: "none", dieSteps: 1, macroMode: "linked", macroVisibility: "owner" });
    await game.settings.set(MODULE_ID, SETTING, value);
    this.render({ force: true });
  }

  static async #deleteDefinition(event, target) {
    const value = this.constructor.#readForm(this.element);
    value[target.dataset.kind].splice(Number(target.dataset.index), 1);
    await game.settings.set(MODULE_ID, SETTING, value);
    this.render({ force: true });
  }

  static async #save(event, form, formData) {
    const value = normalizeDefinitions(foundry.utils.expandObject(formData.object));
    const ids = [...value.properties, ...value.options].map(entry => entry.id);
    if (new Set(ids).size !== ids.length) {
      ui.notifications.error(game.i18n.localize("BFI.Weapon.Settings.Duplicate"));
      return false;
    }
    await game.settings.set(MODULE_ID, SETTING, value);
    SettingsConfig.reloadConfirm({ world: true });
  }
}

Hooks.once("init", () => {
  if (game.system.id !== "black-flag") return;
  game.settings.register(MODULE_ID, SETTING, {
    scope: "world",
    config: false,
    type: Object,
    default: { properties: [], options: [] },
    requiresReload: true
  });
  game.settings.registerMenu(MODULE_ID, "weaponCustomization", {
    name: "BFI.Weapon.Settings.Name",
    label: "BFI.Weapon.Settings.Label",
    hint: "BFI.Weapon.Settings.Hint",
    icon: "fa-solid fa-swords",
    type: WeaponCustomizationConfig,
    restricted: true
  });
  registerDefinitions();
  installWeaponMechanics();
});
