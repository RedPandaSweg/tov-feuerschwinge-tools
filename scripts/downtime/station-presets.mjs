import { CRAFTING_ROLL_TABLE, DEFAULT_VALUE_TIERS, STANDARD_ROLL_TABLE } from "./constants.mjs";

const STATION_PRESET_BASE_CONFIG = Object.freeze({
  baseProgress: 0,
  requiresRoll: true,
  rollInterval: 5,
  progressSources: {
    level: { enabled: false, multiplier: 1 },
    proficiency: { enabled: true, multiplier: 5 },
    checkProficiency: { enabled: false, multiplier: 1 }
  },
  actorValue: { enabled: false },
  rollTable: CRAFTING_ROLL_TABLE,
  rollTablePreset: "crafting"
});

function toolCheck(key) {
  return [{ type: "tool", key }];
}

export const STATION_PRESETS = Object.freeze([
  {
    id: "workplace",
    category: "working",
    icon: "fa-solid fa-coins",
    img: "icons/environment/settlement/warehouse-barn-crates.webp",
    projectTemplate: "work",
    allChecks: true,
    stationConfig: {
      baseProgress: 1,
      requiresRoll: true,
      rollInterval: 5,
      progressSources: {
        level: { enabled: false, multiplier: 1 },
        proficiency: { enabled: false, multiplier: 1 },
        checkProficiency: { enabled: false, multiplier: 1 }
      },
      allowedChecks: [],
      rollTable: STANDARD_ROLL_TABLE,
      rollTablePreset: "standard",
      actorValue: {
        enabled: true,
        scope: "station",
        key: "reputation",
        label: "Reputation",
        defaultValue: 0,
        minimum: 0,
        maximum: null,
        completionChange: 0,
        tiers: DEFAULT_VALUE_TIERS
      }
    }
  },
  {
    id: "smithy",
    category: "smithing",
    icon: "fa-solid fa-hammer",
    img: "icons/environment/settlement/blacksmith.webp",
    projectTemplate: "crafting",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.fKjUrqM49opM4ps5", identifier: "smithing" },
      allowedChecks: toolCheck("smithing"),
      rollTable: CRAFTING_ROLL_TABLE,
      rollTablePreset: "crafting"
    }
  },
  {
    id: "alchemy-lab",
    category: "alchemy",
    icon: "fa-solid fa-flask",
    img: "icons/environment/settlement/wizard-castle.webp",
    projectTemplate: "crafting",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.klz44oS9m4omG4eG", identifier: "alchemist" },
      allowedChecks: toolCheck("alchemist"),
      rollTable: CRAFTING_ROLL_TABLE,
      rollTablePreset: "crafting"
    }
  },
  {
    id: "kitchen",
    category: "cooking",
    icon: "fa-solid fa-utensils",
    img: "icons/environment/settlement/house-city.webp",
    projectTemplate: "work",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.poBCR3CoQsHVKxU9", identifier: "provisioner" },
      allowedChecks: toolCheck("provisioner")
    }
  },
  {
    id: "library",
    category: "research",
    icon: "fa-solid fa-book",
    img: "icons/environment/settlement/city-hall.webp",
    projectTemplate: "research",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      allowedChecks: [{ type: "skill", key: "investigation" }]
    }
  },
  {
    id: "training-grounds",
    category: "training",
    icon: "fa-solid fa-dumbbell",
    img: "icons/environment/settlement/target-dummy.webp",
    projectTemplate: "training",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      baseProgress: 10,
      progressSources: {
        level: { enabled: false, multiplier: 1 },
        proficiency: { enabled: false, multiplier: 1 },
        checkProficiency: { enabled: false, multiplier: 1 }
      },
      modifiers: [{ id: "training-bonus", label: "Attribut + Ausbilderbonus", operation: "add", value: 0 }],
      allowedChecks: ["str", "dex", "con", "int", "wis", "cha"].map(key => ({ type: "ability", key }))
    }
  },
  {
    id: "tavern",
    category: "carousing",
    icon: "fa-solid fa-beer-mug-empty",
    img: "icons/environment/settlement/tavern.webp",
    projectTemplate: "carousing",
    stationConfig: {
      baseProgress: 1,
      requiresRoll: false,
      rollInterval: 5,
      progressSources: {
        level: { enabled: false, multiplier: 1 },
        proficiency: { enabled: false, multiplier: 1 },
        checkProficiency: { enabled: false, multiplier: 1 }
      },
      allowedChecks: ["deception", "insight", "intimidation", "performance", "persuasion"].map(key => ({ type: "skill", key })),
      rollTable: [],
      rollTablePreset: "",
      actorValue: { enabled: false }
    }
  },
  {
    id: "workshop",
    category: "tinkering",
    icon: "fa-solid fa-gears",
    img: "icons/environment/settlement/lumbermill.webp",
    projectTemplate: "crafting",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.02Se8KL2vaL2BF5s", identifier: "tinker" },
      allowedChecks: toolCheck("tinker"),
      rollTable: CRAFTING_ROLL_TABLE,
      rollTablePreset: "crafting"
    }
  },
  {
    id: "tailor",
    category: "tailoring",
    icon: "fa-solid fa-shirt",
    img: "icons/environment/settlement/market-stall.webp",
    projectTemplate: "crafting",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.42AxnVcNl4R5WZj6", identifier: "clothier" },
      allowedChecks: toolCheck("clothier"),
      rollTable: CRAFTING_ROLL_TABLE,
      rollTablePreset: "crafting"
    }
  },
  {
    id: "herbalist",
    category: "herbalism",
    icon: "fa-solid fa-leaf",
    img: "icons/environment/settlement/hut.webp",
    projectTemplate: "recovery",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.mhgW4NnKHq3Vy1nL", identifier: "herbalist" },
      allowedChecks: toolCheck("herbalist")
    }
  },
  {
    id: "music-hall",
    category: "music",
    icon: "fa-solid fa-music",
    img: "icons/environment/settlement/gazebo.webp",
    projectTemplate: "work",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      allowedChecks: ["bagpipes", "drum", "flute", "lute", "lyre", "horn"].map(key => ({ type: "tool", key: `musicalInstrument:${key}` }))
    }
  },
  {
    id: "thieves-guild",
    category: "thievery",
    icon: "fa-solid fa-mask",
    img: "icons/environment/settlement/sewer-entrance.webp",
    projectTemplate: "training",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.cNWGEyGSVCYKxmCg", identifier: "thieves" },
      allowedChecks: toolCheck("thieves")
    }
  },
  {
    id: "expedition-office",
    category: "navigation",
    icon: "fa-solid fa-compass",
    img: "icons/environment/settlement/watchtower-city.webp",
    projectTemplate: "research",
    stationConfig: {
      ...STATION_PRESET_BASE_CONFIG,
      requiredTool: { uuid: "Compendium.black-flag.items.Item.2TuWsCp00Sbgaer3", identifier: "navigator" },
      allowedChecks: toolCheck("navigator")
    }
  }
]);

export function stationPresetNameKey(id) { return `DOWNTIME_MANAGER.StationPresets.Entries.${id}.Name`; }
export function stationPresetDescriptionKey(id) { return `DOWNTIME_MANAGER.StationPresets.Entries.${id}.Description`; }
