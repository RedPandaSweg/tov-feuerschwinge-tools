import { MODULE_ID, modulePath } from "../core/constants.mjs";

const FLAG = "preferredToolAbility";
let installed = false;

function descriptionText(item) {
  const html = String(item?.system?.description?.value ?? "");
  const element = document.createElement("div");
  element.innerHTML = html;
  return element.textContent ?? "";
}

export function inferredToolAbility(item) {
  if (item?.type !== "tool") return "";
  const text = descriptionText(item);
  const match = text.match(/associated\s+abilit(?:y|ies)\s*:?\s*([^.;\n]+)/i)
    ?? text.match(/zugeordnete\s+(?:attribute|fähigkeiten)\s*:?\s*([^.;\n]+)/i);
  if (!match) return "";
  const associated = match[1].toLocaleLowerCase();
  return CONFIG.BlackFlag.abilities.localizedOptions
    .find(option => associated.includes(String(option.label).toLocaleLowerCase()))?.value ?? "";
}

export function preferredToolAbility(actor, toolKey) {
  const normalizedKey = String(toolKey ?? "").toLocaleLowerCase();
  const tool = actor?.items?.find(item => item.type === "tool" && [
    item.system?.type?.base,
    item.system?.type?.category,
    item.system?.identifier?.value,
    item.system?.identifier
  ].some(value => {
    const candidate = String(value ?? "").toLocaleLowerCase();
    return candidate === normalizedKey || normalizedKey.endsWith(`:${candidate}`);
  }));
  if (!tool) return "";
  const configured = String(tool.getFlag(MODULE_ID, FLAG) ?? "");
  return configured && configured !== "auto" ? configured : inferredToolAbility(tool);
}

export function installToolAbilitySelection() {
  if (installed || game.system.id !== "black-flag") return;
  const EquipmentSheet = BlackFlag?.applications?.item?.EquipmentSheet;
  if (!EquipmentSheet) return;
  installed = true;

  class ToolAbilitySheet extends EquipmentSheet {
    static PARTS = {
      ...EquipmentSheet.PARTS,
      details: { template: modulePath("templates/tool-ability-details.hbs") }
    };

    async _prepareDetailsContext(context, options) {
      context = await super._prepareDetailsContext(context, options);
      const configured = String(this.item.getFlag(MODULE_ID, FLAG) ?? "auto");
      const inferred = inferredToolAbility(this.item);
      context.tovfToolAbility = {
        configured,
        selected: configured,
        inferred,
        options: CONFIG.BlackFlag.abilities.localizedOptions
      };
      return context;
    }
  }

  foundry.applications.apps.DocumentSheetConfig.registerSheet(Item, MODULE_ID, ToolAbilitySheet, {
    types: ["tool"],
    makeDefault: true,
    label: "TOV.ToolAbility.Sheet"
  });
}
