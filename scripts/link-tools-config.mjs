import { MODULE_ID, modulePath } from "./core/constants.mjs";
import { auditCharacterLinks, repairLegacyCharacterLinks } from "./tcv-link-repair.mjs";
import { openCompendiumAudit } from "./compendium-audit.mjs";
import { weaponOptionActivitiesApi } from "./integrations/weapon-option-activities.mjs";
import { repairMissingActorItemImages } from "./actor-item-image-repair.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class LinkToolsConfig extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-link-tools",
    classes: ["tovf-link-tools"],
    position: { width: 560, height: 640 },
    window: { title: "TOVF.LinkTools.Title" },
    actions: {
      audit: this.#audit,
      auditCompendiums: this.#auditCompendiums,
      repair: this.#repair,
      repairMissingImages: this.#repairMissingImages,
      synchronizeWeaponActivities: this.#synchronizeWeaponActivities
    }
  };

  static PARTS = {
    content: { template: modulePath("templates/link-tools-config.hbs") }
  };

  static async #run(application, action) {
    application.element.querySelectorAll("button").forEach(button => { button.disabled = true; });
    try {
      await action();
    } catch (error) {
      console.error(`${MODULE_ID} | Character link tool failed`, error);
      ui.notifications.error(error.message, { permanent: true });
    } finally {
      application.element.querySelectorAll("button").forEach(button => { button.disabled = false; });
    }
  }

  static #audit() {
    return this.constructor.#run(this, auditCharacterLinks);
  }

  static #auditCompendiums() {
    return this.constructor.#run(this, openCompendiumAudit);
  }

  static #repair() {
    return this.constructor.#run(this, repairLegacyCharacterLinks);
  }

  static #repairMissingImages() {
    return this.constructor.#run(this, repairMissingActorItemImages);
  }

  static #synchronizeWeaponActivities() {
    return this.constructor.#run(this, async () => {
      const result = await weaponOptionActivitiesApi.synchronizeAll();
      ui.notifications.info(game.i18n.format("TOVF.LinkTools.WeaponActivitiesComplete", result));
    });
  }
}

export function registerLinkTools() {
  game.settings.registerMenu(MODULE_ID, "characterLinkTools", {
    name: "TOVF.LinkTools.Name",
    label: "TOVF.LinkTools.Label",
    hint: "TOVF.LinkTools.Hint",
    icon: "fa-solid fa-link",
    type: LinkToolsConfig,
    restricted: true
  });
}
