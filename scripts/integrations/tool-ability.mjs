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
    .map(option => {
      const candidates = [
        option.value,
        option.label,
        CONFIG.BlackFlag.abilities.localizedAbbreviations?.[option.value]
      ]
        .map(value => String(value ?? "").toLocaleLowerCase())
        .filter(Boolean);
      const positions = candidates
        .map(candidate => associated.indexOf(candidate))
        .filter(position => position >= 0);
      return { value: option.value, position: positions.length ? Math.min(...positions) : -1 };
    })
    .filter(option => option.position >= 0)
    .sort((a, b) => a.position - b.position)[0]?.value ?? "";
}

function configuredToolData(toolKey, configuration = CONFIG.BlackFlag.tools, prefix = "") {
  const normalizedKey = String(toolKey ?? "").toLocaleLowerCase();
  for (const [key, entry] of Object.entries(configuration ?? {})) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const id = prefix ? `${prefix}:${key}` : key;
    if (id.toLocaleLowerCase() === normalizedKey) return entry;
    if (entry.children) {
      const nested = configuredToolData(toolKey, entry.children, id);
      if (nested) return nested;
    }
  }
  return null;
}

export function actorTool(actor, toolKey) {
  const normalizedKey = String(toolKey ?? "").toLocaleLowerCase();
  const configuredTool = CONFIG.BlackFlag.tools.localizedOptions
    .find(option => String(option.value).toLocaleLowerCase() === normalizedKey);
  const configuredData = configuredToolData(toolKey);
  const configuredLabel = String(configuredTool?.label ?? "").trim().toLocaleLowerCase();
  const configuredSource = String(configuredData?.link ?? "");
  return actor?.items?.find(item => item.type === "tool" && [
    item.system?.type?.base,
    item.system?.type?.category,
    item.system?.identifier?.value,
    item.system?.identifier
  ].some(value => {
    const candidate = String(value ?? "").toLocaleLowerCase();
    return candidate === normalizedKey || normalizedKey.endsWith(`:${candidate}`);
  }) || (configuredLabel && String(item.name ?? "").trim().toLocaleLowerCase() === configuredLabel)
    || (configuredSource && [item._stats?.compendiumSource, item.getFlag("core", "sourceId")].includes(configuredSource)));
}

export function preferredToolAbility(actor, toolKey) {
  const tool = actorTool(actor, toolKey);
  if (!tool) return "";
  const configured = String(tool.getFlag(MODULE_ID, FLAG) ?? "");
  return configured && configured !== "auto" ? configured : inferredToolAbility(tool);
}

export async function rememberToolAbility(actor, toolKey, ability) {
  const selected = String(ability ?? "");
  if (!CONFIG.BlackFlag.abilities.localizedOptions.some(option => option.value === selected)) return false;
  const tool = actorTool(actor, toolKey);
  if (!tool || preferredToolAbility(actor, toolKey) === selected) return false;
  await tool.setFlag(MODULE_ID, FLAG, selected);
  return true;
}

export function installToolAbilitySelection() {
  if (installed) return { status: "already-installed" };
  if (game.system.id !== "black-flag") return { status: "inactive", reason: "Requires the black-flag system." };
  const EquipmentSheet = BlackFlag?.applications?.item?.EquipmentSheet;
  if (!EquipmentSheet) {
    return { status: "incompatible", reason: "BlackFlag.applications.item.EquipmentSheet is unavailable." };
  }
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
  return { status: "completed" };
}
