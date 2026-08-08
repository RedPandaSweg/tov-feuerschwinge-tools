import { MODULE_ID, modulePath } from "./core/constants.mjs";
const ACTIVITY_TYPE = "tovMacro";

Hooks.once("init", () => {
  if (game.system.id !== "black-flag") return;

  const Activity = BlackFlag.documents.activity.Activity;
  const ActivityDataModel = BlackFlag.data.abstract.ActivityDataModel;
  const ActivitySheet = BlackFlag.applications.activity.ActivitySheet;
  const { StringField } = foundry.data.fields;

  class MacroActivityData extends ActivityDataModel {
    static defineSchema() {
      return {
        mode: new StringField({
          required: true,
          blank: false,
          initial: "linked",
          choices: ["linked", "inline"],
          label: "TOV.MacroActivity.Mode.Label"
        }),
        macroUuid: new StringField({
          nullable: false,
          initial: "",
          label: "TOV.MacroActivity.MacroUuid.Label",
          hint: "TOV.MacroActivity.MacroUuid.Hint"
        }),
        command: new StringField({
          nullable: false,
          initial: "",
          label: "TOV.MacroActivity.Command.Label",
          hint: "TOV.MacroActivity.Command.Hint"
        })
      };
    }
  }

  class MacroActivity extends Activity {
    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      type: ACTIVITY_TYPE,
      dataModel: MacroActivityData,
      icon: "systems/black-flag/artwork/advancement/scale-value.svg",
      title: "TOV.MacroActivity.Title",
      hint: "TOV.MacroActivity.Hint"
    }, { inplace: false }));

    async _triggerSubsequentActions(config, results) {
      try {
        await this.executeMacro({ event: config.event, results });
      } catch (error) {
        console.error(`${MODULE_ID} | Macro activity failed`, error);
        ui.notifications.error(game.i18n.format("TOV.MacroActivity.Error.Execution", {
          name: this.name,
          message: error.message
        }));
      }
    }

    async executeMacro({ event = null, results = null } = {}) {
      const scope = {
        actor: this.actor,
        token: this.actor?.token?.object ?? canvas.tokens?.controlled.find(t => t.actor?.id === this.actor?.id) ?? null,
        item: this.item,
        activity: this,
        event,
        message: results?.message ?? null,
        results
      };

      if (this.system.mode === "linked") {
        const reference = this.system.macroUuid.trim();
        const macro = reference.includes(".") ? await fromUuid(reference) : game.macros.get(reference);
        if (!(macro instanceof Macro)) {
          throw new Error(game.i18n.localize("TOV.MacroActivity.Error.NotFound"));
        }
        return macro.execute(scope);
      }

      if (!this.system.command.trim()) {
        throw new Error(game.i18n.localize("TOV.MacroActivity.Error.EmptyCode"));
      }
      const macro = await Macro.create({
        name: this.name,
        type: "script",
        command: this.system.command
      }, { temporary: true });
      return macro.execute(scope);
    }
  }

  class MacroActivitySheet extends ActivitySheet {
    static DEFAULT_OPTIONS = {
      classes: ["tov-macro-activity"]
    };

    static PARTS = {
      ...super.PARTS,
      effect: {
        template: modulePath("templates/macro-effect.hbs")
      }
    };

    async _prepareEffectContext(context, options) {
      context = await super._prepareEffectContext(context, options);
      context.modes = [
        { value: "linked", label: game.i18n.localize("TOV.MacroActivity.Mode.Linked") },
        { value: "inline", label: game.i18n.localize("TOV.MacroActivity.Mode.Inline") }
      ];
      context.isLinked = this.activity.system.mode === "linked";
      return context;
    }

    _onRender(context, options) {
      super._onRender(context, options);
      const dropZone = this.element.querySelector("[data-tov-macro-drop]");
      if (!dropZone) return;
      dropZone.addEventListener("dragover", event => event.preventDefault());
      dropZone.addEventListener("drop", event => this.#onMacroDrop(event));
    }

    async #onMacroDrop(event) {
      event.preventDefault();
      const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
      if (data?.type !== "Macro") return;
      const macro = await Macro.implementation.fromDropData(data);
      if (!macro) return;
      const input = event.currentTarget.querySelector('[name="system.macroUuid"]');
      input.value = macro.uuid;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  CONFIG.Activity.types[ACTIVITY_TYPE] = {
    documentClass: MacroActivity,
    sheetClasses: { config: MacroActivitySheet }
  };
  // Module activity types are registered after Black Flag's i18nInit localization pass.
  MacroActivity.localize();

  BlackFlag.modules[MODULE_ID] = {
    MacroActivity,
    MacroActivityData,
    MacroActivitySheet
  };
});
