import { LEGACY_MODULE_ID, MODULE_ID, modulePath } from "./core/constants.mjs";
const ACTIVITY_TYPE = "weaponEnchantment";
const FLAG = "weaponEnchantment";

Hooks.once("init", () => {
  if (game.system.id !== "black-flag") return;

  const Activity = BlackFlag.documents.activity.Activity;
  const ActivityDataModel = BlackFlag.data.abstract.ActivityDataModel;
  const ActivitySheet = BlackFlag.applications.activity.ActivitySheet;
  const FormulaField = BlackFlag.data.fields.FormulaField;
  const { ArrayField, BooleanField, NumberField, SchemaField, StringField } = foundry.data.fields;

  class WeaponEnchantmentData extends ActivityDataModel {
    static defineSchema() {
      return {
        abilityOverride: new StringField({
          initial: "spellcasting",
          label: "BFI.Enchantment.Ability",
          hint: "BFI.Enchantment.AbilityHint"
        }),
        abilityMode: new StringField({ initial: "always", choices: ["always", "higher"], label: "BFI.Enchantment.AbilityMode" }),
        damageMode: new StringField({ initial: "none", choices: ["none", "minimum", "replace", "formula"], label: "BFI.Enchantment.DamageMode" }),
        damageDenomination: new NumberField({ nullable: true, integer: true, min: 2, label: "BFI.Enchantment.DamageDie" }),
        damageFormula: new FormulaField({ initial: "", label: "BFI.Enchantment.DamageFormula" }),
        magical: new BooleanField({ initial: true, label: "BFI.Enchantment.Magical" }),
        attackBonus: new FormulaField({ initial: "", label: "BFI.Enchantment.AttackBonus" }),
        damageBonus: new FormulaField({ initial: "", label: "BFI.Enchantment.DamageBonus" }),
        criticalBonusDice: new NumberField({
          initial: 0,
          integer: true,
          min: 0,
          label: "BFI.Enchantment.CriticalBonusDice",
          hint: "BFI.Enchantment.CriticalBonusDiceHint"
        }),
        manualChanges: new ArrayField(new SchemaField({
          key: new StringField({ initial: "" }),
          mode: new StringField({ initial: "add" }),
          value: new StringField({ initial: "" }),
          priority: new NumberField({ nullable: true, integer: true })
        }), { initial: [] }),
        durationSeconds: new NumberField({ initial: 0, min: 0, label: "BFI.Enchantment.Duration" })
      };
    }
  }

  class WeaponEnchantmentActivity extends Activity {
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      type: ACTIVITY_TYPE,
      dataModel: WeaponEnchantmentData,
      icon: "systems/black-flag/artwork/advancement/spellcasting.svg",
      title: "BFI.Enchantment.Title",
      hint: "BFI.Enchantment.Hint",
      usage: {
        actions: {
          removeWeaponEnchantment: WeaponEnchantmentActivity.removeFromChat
        }
      }
    }, { inplace: false }));

    _activationChatButtons() {
      return [{
        label: game.i18n.localize("BFI.Enchantment.Remove"),
        icon: '<i class="fa-solid fa-wand-magic-sparkles" inert></i>',
        dataset: { action: "removeWeaponEnchantment" }
      }, ...super._activationChatButtons()];
    }

    async _triggerSubsequentActions(config, results) {
      const weapon = await this.chooseWeapon();
      if (!weapon) return;
      await this.applyToWeapon(weapon);
    }

    async chooseWeapon() {
      const weapons = this.actor?.items.filter(item => item.type === "weapon") ?? [];
      if (!weapons.length) {
        ui.notifications.warn(game.i18n.localize("BFI.Enchantment.NoWeapons"));
        return null;
      }
      const options = weapons.map(weapon =>
        `<option value="${weapon.id}">${foundry.utils.escapeHTML(weapon.name)}</option>`
      ).join("");
      const id = await BlackFlag.applications.api.BFDialog.wait({
        window: { title: game.i18n.localize("BFI.Enchantment.ChooseTitle") },
        content: `<div class="form-group"><label>${game.i18n.localize("BFI.Enchantment.Weapon")}</label><div class="form-fields"><select name="weaponId">${options}</select></div></div>`,
        buttons: [
          {
            action: "apply",
            label: game.i18n.localize("BFI.Enchantment.Apply"),
            icon: "<i class='fa-solid fa-wand-magic-sparkles'></i>",
            default: true,
            callback: (_event, button) => new foundry.applications.ux.FormDataExtended(button.form).object.weaponId
          },
          { action: "cancel", label: game.i18n.localize("Cancel"), callback: () => null }
        ],
        rejectClose: false
      });
      return this.actor.items.get(id) ?? null;
    }

    async applyToWeapon(weapon) {
      await this.removeEnchantments({ notify: false });
      const ability = this.resolveAbility();
      const manualChanges = Array.from(this.system.manualChanges ?? [])
        .filter(change => String(change.key ?? "").trim())
        .map(change => {
          const legacyTypes = ["custom", "multiply", "add", "downgrade", "upgrade", "override"];
          const type = legacyTypes[Number(change.mode)] ?? String(change.mode || "add");
          const hasPriority = change.priority !== null && change.priority !== undefined && change.priority !== "";
          const priority = hasPriority ? Number(change.priority) : null;
          return {
            key: String(change.key).trim(),
            type: Object.hasOwn(CONST.ACTIVE_EFFECT_CHANGE_TYPES, type) ? type : "add",
            value: String(change.value ?? ""),
            priority: Number.isFinite(priority) ? priority : null
          };
        });
      const config = {
        sourceActivity: this.uuid,
        sourceItem: this.item.uuid,
        ability,
        spellOrigin: this.item.getFlag(game.system.id, "relationship.origin.identifier") ?? null,
        abilityMode: this.system.abilityMode,
        damageMode: this.system.damageMode,
        damageDenomination: this.system.damageDenomination,
        damageFormula: this.system.damageFormula,
        magical: this.system.magical,
        attackBonus: this.system.attackBonus,
        damageBonus: this.system.damageBonus,
        criticalBonusDice: this.system.criticalBonusDice,
        manualChanges
      };
      const seconds = this.system.durationSeconds;
      const effect = {
        name: `${this.name}: ${weapon.name}`,
        img: this.img,
        type: "enchantment",
        origin: this.uuid,
        disabled: false,
        duration: seconds ? {
          seconds,
          rounds: Math.ceil(seconds / (CONFIG.time.roundTime || 6)),
          startTime: game.time.worldTime,
          startRound: game.combat?.round,
          startTurn: game.combat?.turn
        } : {},
        system: { magical: this.system.magical },
        flags: { [MODULE_ID]: { [FLAG]: config } },
        changes: [...(this.system.magical ? [{
          key: "system.properties",
          type: "add",
          value: "magical",
          priority: 20
        }] : []), ...manualChanges]
      };
      await weapon.createEmbeddedDocuments("ActiveEffect", [effect]);
      ui.notifications.info(game.i18n.format("BFI.Enchantment.Applied", { weapon: weapon.name }));
    }

    resolveAbility() {
      const configured = this.system.abilityOverride;
      if (configured !== "spellcasting") return configured;

      // A Black Flag Spell resolves its own origin override, class origin, and general fallback in this getter.
      if (this.item.type === "spell" && this.item.system.ability) return this.item.system.ability;

      const spellcasting = this.actor?.system.spellcasting;
      const originId = this.item.getFlag(game.system.id, "relationship.origin.identifier");
      const originAbility = spellcasting?.origins?.[originId]?.ability;
      if (originAbility) return originAbility;
      if (spellcasting?.ability) return spellcasting.ability;

      const candidates = new Set(Object.values(spellcasting?.origins ?? {}).map(origin => origin.ability).filter(Boolean));
      return this.actor?.system.selectBestAbility?.(candidates) ?? null;
    }

    async removeEnchantments({ notify = true } = {}) {
      const removals = [];
      for (const weapon of this.actor?.items.filter(item => item.type === "weapon") ?? []) {
        const ids = weapon.effects
          .filter(effect => (
            effect.getFlag(MODULE_ID, FLAG)
            ?? effect.flags?.[LEGACY_MODULE_ID]?.[FLAG]
          )?.sourceActivity === this.uuid)
          .map(effect => effect.id);
        if (ids.length) removals.push(weapon.deleteEmbeddedDocuments("ActiveEffect", ids));
      }
      await Promise.all(removals);
      if (notify) ui.notifications.info(game.i18n.localize(removals.length ? "BFI.Enchantment.Removed" : "BFI.Enchantment.NothingToRemove"));
      return removals.length;
    }

    static removeFromChat(event, target, message) {
      return this.removeEnchantments();
    }
  }

  class WeaponEnchantmentSheet extends ActivitySheet {
    static DEFAULT_OPTIONS = { classes: ["bfi-weapon-enchantment"] };
    static PARTS = {
      ...super.PARTS,
      effect: { template: modulePath("templates/weapon-enchantment-effect.hbs") }
    };

    async _prepareEffectContext(context, options) {
      context = await super._prepareEffectContext(context, options);
      context.abilityOptions = [
        { value: "spellcasting", label: game.i18n.localize("BFI.Enchantment.SpellcastingAbility") },
        ...CONFIG.BlackFlag.abilities.localizedOptions
      ];
      context.abilityModes = [
        { value: "always", label: "BFI.Enchantment.AbilityAlways" },
        { value: "higher", label: "BFI.Enchantment.AbilityHigher" }
      ];
      context.damageModes = [
        { value: "none", label: "BFI.Enchantment.DamageNone" },
        { value: "minimum", label: "BFI.Enchantment.DamageMinimum" },
        { value: "replace", label: "BFI.Enchantment.DamageReplace" },
        { value: "formula", label: "BFI.Enchantment.DamageUseFormula" }
      ];
      context.dieOptions = CONFIG.BlackFlag.dieSteps.map(value => ({ value, label: `d${value}` }));
      context.effectModes = [
        ["custom", "BFI.Enchantment.EffectMode.Custom"],
        ["multiply", "BFI.Enchantment.EffectMode.Multiply"],
        ["add", "BFI.Enchantment.EffectMode.Add"],
        ["downgrade", "BFI.Enchantment.EffectMode.Downgrade"],
        ["upgrade", "BFI.Enchantment.EffectMode.Upgrade"],
        ["override", "BFI.Enchantment.EffectMode.Override"]
      ].map(([value, label]) => ({ value, label: game.i18n.localize(label) }));
      return context;
    }

    _onRender(context, options) {
      super._onRender(context, options);
      const editor = this.element.querySelector("[data-manual-changes]");
      if (!editor) return;

      const renumber = () => {
        [...editor.querySelectorAll("[data-manual-change]")].forEach((row, index) => {
          row.querySelectorAll("[name]").forEach(input => {
            input.name = input.name.replace(
              /system\.manualChanges\.(?:\d+|__INDEX__)\./,
              `system.manualChanges.${index}.`
            );
          });
        });
      };
      const appendBlank = () => {
        const template = editor.querySelector("template[data-manual-change-template]");
        const row = template?.content.firstElementChild?.cloneNode(true);
        if (row) editor.querySelector("[data-manual-change-list]").append(row);
        return row;
      };

      editor.addEventListener("click", event => {
        const button = event.target.closest("[data-manual-change-action]");
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        if (button.dataset.manualChangeAction === "add") {
          appendBlank();
        } else if (button.dataset.manualChangeAction === "delete") {
          button.closest("[data-manual-change]")?.remove();
          if (!editor.querySelector("[data-manual-change]")) appendBlank();
        }
        renumber();
      });
    }
  }

  CONFIG.Activity.types[ACTIVITY_TYPE] = {
    documentClass: WeaponEnchantmentActivity,
    sheetClasses: { config: WeaponEnchantmentSheet }
  };
  // Module activity types are registered after Black Flag's i18nInit localization pass.
  WeaponEnchantmentActivity.localize();
  BlackFlag.modules[MODULE_ID].WeaponEnchantmentActivity = WeaponEnchantmentActivity;
});
