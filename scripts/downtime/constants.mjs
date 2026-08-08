export const MODULE_ID = "tov-feuerschwinge-tools";
export const CONTENT_MODULE_ID = "tov-feuerschwinge";
export const LEGACY_MODULE_SCOPE = CONTENT_MODULE_ID;
export const DEFAULT_RECIPE_BASE_ITEM_UUID = "Compendium.tov-feuerschwinge.items.Item.bmcacq8xezFxkszI";
export const DOWNTIME_REWARD_ITEM_UUIDS = Object.freeze({
  FIVE: "Compendium.tov-feuerschwinge.items.Item.VwZ9CxuPJnMX6O9Q",
  TEN: "Compendium.tov-feuerschwinge.items.Item.J0ruc5gn7FPcbiVu"
});

export const DEFAULT_MILESTONE_LEVEL_BANDS = Object.freeze([
  { minLevel: 1, maxLevel: 2, sessions: 1 },
  { minLevel: 3, maxLevel: 4, sessions: 2 },
  { minLevel: 5, maxLevel: 7, sessions: 3 },
  { minLevel: 8, maxLevel: 11, sessions: 4 },
  { minLevel: 12, maxLevel: 16, sessions: 5 },
  { minLevel: 17, maxLevel: 20, sessions: 6 }
]);

export const FLAGS = Object.freeze({
  STATION: "station",
  PROJECTS: "projects",
  RECIPE: "recipe",
  DOWNTIME: "downtime",
  REPUTATION: "reputation",
  STATION_VALUES: "stationValues",
  STATION_FOLDER: "stationFolder",
  PROJECT_FOLDER: "projectFolder",
  SESSION_PROGRESS: "sessionProgress",
  DOWNTIME_ITEM: "downtimeItem",
  SHARED_PROJECTS: "sharedProjects"
});

export const SETTINGS = Object.freeze({
  RECIPE_BASE_ITEM_UUID: "recipeBaseItemUuid",
  DEFAULT_COST_ITEM_UUID: "defaultCostItemUuid",
  STATION_CATEGORIES: "stationCategories",
  PLAYER_ACTOR_FOLDERS: "playerActorFolders",
  ACTIVE_SESSION: "activeSession",
  LAST_SESSION_RESULT: "lastSessionResult",
  SESSION_REWARDS: "sessionRewards",
  SESSION_HISTORY_JOURNAL: "sessionHistoryJournal",
  SESSION_HISTORY_ENABLED: "sessionHistoryEnabled",
  SESSION_HISTORY: "sessionHistory",
  PASSIVE_DOWNTIME: "passiveDowntimeConfig",
  MILESTONE_LEVEL_BANDS: "milestoneLevelBands",
  MILESTONE_CATCH_UP: "milestoneCatchUp",
  LAST_DIRECT_DOWNTIME_ALL: "lastDirectDowntimeAll",
  GM_TOOL_UNDO: "gmToolUndo"
});

export const DEFAULT_STATION_CATEGORIES = Object.freeze([
  { id: "research", label: "Research" },
  { id: "training", label: "Training" },
  { id: "working", label: "Working" },
  { id: "carousing", label: "Carousing" }
]);

const TOOL_ACTIVITY_CATEGORIES = Object.freeze([
  { match: ["alchemist"], id: "alchemy", label: "Alchemy" },
  { match: ["artist"], id: "artistry", label: "Artistry" },
  { match: ["charlatan"], id: "deception", label: "Deception" },
  { match: ["clothier"], id: "tailoring", label: "Tailoring" },
  { match: ["construction"], id: "construction", label: "Construction" },
  { match: ["gaming", "dice", "card"], id: "gaming", label: "Gaming" },
  { match: ["smithing"], id: "smithing", label: "Smithing" },
  { match: ["herbalist"], id: "herbalism", label: "Herbalism" },
  { match: ["musicalinstrument", "bagpipes", "drum", "flute", "lute", "lyre", "horn"], id: "music", label: "Music" },
  { match: ["navigator"], id: "navigation", label: "Navigation" },
  { match: ["provisioner"], id: "cooking", label: "Cooking" },
  { match: ["trapper"], id: "hunting", label: "Hunting" },
  { match: ["thieves"], id: "thievery", label: "Thievery" },
  { match: ["tinker"], id: "tinkering", label: "Tinkering" }
]);

export function createDefaultStationCategories(checks = []) {
  const categories = DEFAULT_STATION_CATEGORIES.map(category => ({ ...category }));
  for (const tool of checks.filter(check => check.type === "tool")) {
    const key = String(tool.key ?? "").replace(/[^a-z]/gi, "").toLowerCase();
    const activity = TOOL_ACTIVITY_CATEGORIES.find(category => category.match.some(part => key.includes(part.toLowerCase())));
    if (!activity || categories.some(category => category.id === activity.id)) continue;
    categories.push({ id: activity.id, label: activity.label });
  }
  return categories;
}

const sessionGold = level => {
  if (level <= 3) return 100;
  if (level <= 6) return 500;
  if (level <= 9) return 1000;
  if (level <= 12) return 1500;
  if (level <= 15) return 5000;
  if (level <= 18) return 8000;
  return 20000;
};

export const sessionDowntime = level => {
  if (level <= 3) return 5;
  if (level <= 6) return 10;
  if (level <= 9) return 15;
  if (level <= 12) return 20;
  if (level <= 15) return 25;
  return 30;
};

export function createDefaultSessionRewards(goldItemUuid = "") {
  return {
    schemaVersion: 2,
    levels: Array.from({ length: 20 }, (_, index) => {
      const level = index + 1;
      const downtime = sessionDowntime(level);
      return {
        level,
        items: [
          ...(goldItemUuid ? [{ uuid: goldItemUuid, quantity: sessionGold(level) }] : []),
          ...(downtime % 10 ? [{ uuid: DOWNTIME_REWARD_ITEM_UUIDS.FIVE, quantity: 1 }] : []),
          ...(Math.floor(downtime / 10)
            ? [{ uuid: DOWNTIME_REWARD_ITEM_UUIDS.TEN, quantity: Math.floor(downtime / 10) }]
            : [])
        ]
      };
    })
  };
}

export const DEFAULT_SESSION_PROGRESS = Object.freeze({
  milestones: 0,
  sessionsPlayed: 0,
  lastMilestoneWeek: null,
  passiveDowntime: {}
});

export const DEFAULT_PASSIVE_DOWNTIME = Object.freeze({
  enabled: true,
  period: "month",
  rate: 0.1,
  capMultiplier: 4
});

export const DEFAULT_MILESTONE_CATCH_UP = Object.freeze({ enabled: true });

export const COIN_IDENTIFIERS = Object.freeze(["pp", "gp", "sp", "cp"]);
export const COIN_VALUE_CP = Object.freeze({ pp: 1000, gp: 100, sp: 10, cp: 1 });

export const CHECK_DEFINITIONS = [
  {
    type: "ability",
    key: "strength",
    label: "DOWNTIME_MANAGER.Checks.Ability.Strength"
  },
  {
    type: "ability",
    key: "dexterity",
    label: "DOWNTIME_MANAGER.Checks.Ability.Dexterity"
  },
  {
    type: "ability",
    key: "constitution",
    label: "DOWNTIME_MANAGER.Checks.Ability.Constitution"
  },
  {
    type: "ability",
    key: "intelligence",
    label: "DOWNTIME_MANAGER.Checks.Ability.Intelligence"
  },
  {
    type: "ability",
    key: "wisdom",
    label: "DOWNTIME_MANAGER.Checks.Ability.Wisdom"
  },
  {
    type: "ability",
    key: "charisma",
    label: "DOWNTIME_MANAGER.Checks.Ability.Charisma"
  },

  {
    type: "skill",
    key: "acrobatics",
    label: "DOWNTIME_MANAGER.Checks.Skill.Acrobatics"
  },
  {
    type: "skill",
    key: "animalHandling",
    label: "DOWNTIME_MANAGER.Checks.Skill.AnimalHandling"
  },
  {
    type: "skill",
    key: "arcana",
    label: "DOWNTIME_MANAGER.Checks.Skill.Arcana"
  },
  {
    type: "skill",
    key: "athletics",
    label: "DOWNTIME_MANAGER.Checks.Skill.Athletics"
  },
  {
    type: "skill",
    key: "deception",
    label: "DOWNTIME_MANAGER.Checks.Skill.Deception"
  },
  {
    type: "skill",
    key: "history",
    label: "DOWNTIME_MANAGER.Checks.Skill.History"
  },
  {
    type: "skill",
    key: "insight",
    label: "DOWNTIME_MANAGER.Checks.Skill.Insight"
  },
  {
    type: "skill",
    key: "intimidation",
    label: "DOWNTIME_MANAGER.Checks.Skill.Intimidation"
  },
  {
    type: "skill",
    key: "investigation",
    label: "DOWNTIME_MANAGER.Checks.Skill.Investigation"
  },
  {
    type: "skill",
    key: "medicine",
    label: "DOWNTIME_MANAGER.Checks.Skill.Medicine"
  },
  {
    type: "skill",
    key: "nature",
    label: "DOWNTIME_MANAGER.Checks.Skill.Nature"
  },
  {
    type: "skill",
    key: "perception",
    label: "DOWNTIME_MANAGER.Checks.Skill.Perception"
  },
  {
    type: "skill",
    key: "performance",
    label: "DOWNTIME_MANAGER.Checks.Skill.Performance"
  },
  {
    type: "skill",
    key: "persuasion",
    label: "DOWNTIME_MANAGER.Checks.Skill.Persuasion"
  },
  {
    type: "skill",
    key: "religion",
    label: "DOWNTIME_MANAGER.Checks.Skill.Religion"
  },
  {
    type: "skill",
    key: "sleightOfHand",
    label: "DOWNTIME_MANAGER.Checks.Skill.SleightOfHand"
  },
  {
    type: "skill",
    key: "stealth",
    label: "DOWNTIME_MANAGER.Checks.Skill.Stealth"
  },
  {
    type: "skill",
    key: "survival",
    label: "DOWNTIME_MANAGER.Checks.Skill.Survival"
  }
];

export const DEFAULT_VALUE_TIERS = Object.freeze([
  { id: "default-value-0", minimum: 0, maximum: 9, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1 },
  { id: "default-value-10", minimum: 10, maximum: 19, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.1 },
  { id: "default-value-20", minimum: 20, maximum: 29, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.2 },
  { id: "default-value-30", minimum: 30, maximum: 39, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.3 },
  { id: "default-value-40", minimum: 40, maximum: 49, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.4 },
  { id: "default-value-50", minimum: 50, maximum: 59, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.5 },
  { id: "default-value-60", minimum: 60, maximum: 69, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.6 },
  { id: "default-value-70", minimum: 70, maximum: 79, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.7 },
  { id: "default-value-80", minimum: 80, maximum: 89, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.8 },
  { id: "default-value-90", minimum: 90, maximum: 99, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1.9 },
  { id: "default-value-100", minimum: 100, maximum: 119, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 2 },
  { id: "default-value-120", minimum: 120, maximum: 149, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 2.2 },
  { id: "default-value-150", minimum: 150, maximum: 199, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 2.5 },
  { id: "default-value-200", minimum: 200, maximum: 249, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 3 },
  { id: "default-value-250", minimum: 250, maximum: null, addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 4 }
]);

export const CRAFTING_ROLL_TABLE = Object.freeze([
  { id: "crafting-natural-1", enabled: true, natural1: true, minimum: 1, maximum: 1, label: "Katastrophe!", addition: -20, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-1-5", minimum: 1, maximum: 5, label: "Pfusch!", addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-6-10", minimum: 6, maximum: 10, label: "Mäßig.", addition: 10, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-11-15", minimum: 11, maximum: 15, label: "Routine.", addition: 25, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-16-20", minimum: 16, maximum: 20, label: "Gelungen!", addition: 50, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-21-25", minimum: 21, maximum: 25, label: "Erfolgreich!", addition: 75, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-26-30", minimum: 26, maximum: 30, label: "Außerordentlich!", addition: 100, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-31-plus", minimum: 31, maximum: null, label: "Meisterlich!", addition: 150, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 },
  { id: "crafting-natural-20", enabled: true, natural20: true, minimum: 20, maximum: 20, label: "Legendär!", addition: 200, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 }
]);

export const STANDARD_ROLL_TABLE = Object.freeze([
  { id: "standard-natural-1", enabled: true, minimum: 1, maximum: 1, label: "Katastrophe!", addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: -3, natural1: true, natural20: false },
  { id: "standard-1-5", minimum: 1, maximum: 5, label: "Pfusch!", addition: 0, multiplier: 1, rewardAddition: 1, rewardMultiplier: 1, actorValueChange: -1, natural1: false, natural20: false },
  { id: "standard-6-10", minimum: 6, maximum: 10, label: "Mäßig.", addition: 0, multiplier: 1, rewardAddition: 10, rewardMultiplier: 1, actorValueChange: 0, natural1: false, natural20: false },
  { id: "standard-11-15", minimum: 11, maximum: 15, label: "Routine.", addition: 0, multiplier: 1, rewardAddition: 20, rewardMultiplier: 1, actorValueChange: 1, natural1: false, natural20: false },
  { id: "standard-16-20", minimum: 16, maximum: 20, label: "Gelungen!", addition: 0, multiplier: 1, rewardAddition: 50, rewardMultiplier: 1, actorValueChange: 2, natural1: false, natural20: false },
  { id: "standard-21-25", minimum: 21, maximum: 25, label: "Erfolgreich!", addition: 0, multiplier: 1, rewardAddition: 80, rewardMultiplier: 1, actorValueChange: 3, natural1: false, natural20: false },
  { id: "standard-26-30", minimum: 26, maximum: 30, label: "Außerordentlich!", addition: 0, multiplier: 1, rewardAddition: 100, rewardMultiplier: 1, actorValueChange: 4, natural1: false, natural20: false },
  { id: "standard-31-plus", minimum: 31, maximum: null, label: "Meisterlich!", addition: 0, multiplier: 1, rewardAddition: 150, rewardMultiplier: 1, actorValueChange: 5, natural1: false, natural20: false },
  { id: "standard-natural-20", enabled: true, minimum: 20, maximum: 20, label: "Legendär!", addition: 0, multiplier: 1, rewardAddition: 200, rewardMultiplier: 1, actorValueChange: 10, natural1: false, natural20: true }
]);

export const ROLL_TABLE_PRESETS = Object.freeze([
  { id: "crafting", labelKey: "DOWNTIME_MANAGER.RollTablePresets.Crafting.Name", descriptionKey: "DOWNTIME_MANAGER.RollTablePresets.Crafting.Description", rollTable: CRAFTING_ROLL_TABLE },
  { id: "standard", labelKey: "DOWNTIME_MANAGER.RollTablePresets.Standard.Name", descriptionKey: "DOWNTIME_MANAGER.RollTablePresets.Standard.Description", rollTable: STANDARD_ROLL_TABLE }
]);

export const DEFAULT_STATION_CONFIG = Object.freeze({
  enabled: true,
  displayName: "",
  description: "",
  categories: [],
  allowedChecks: [],
  baseProgress: 0,
  requiresRoll: false,
  rollInterval: 1,
  progressSources: {
    level: { enabled: false, multiplier: 1 },
    proficiency: { enabled: false, multiplier: 1 },
    checkProficiency: { enabled: false, multiplier: 1 }
  },
  evaluationMode: "total",
  requiredTool: null,
  recipes: [],
  modifiers: [],
  rollTable: [],
  rollTablePreset: "",
  actorValue: {
    enabled: false,
    scope: "station",
    category: "",
    key: "station-value",
    label: "",
    defaultValue: 0,
    minimum: null,
    maximum: null,
    completionChange: 0,
    tiers: []
  }
});

export const DEFAULT_PROJECT_CONFIG = Object.freeze({
  enabled: true,
  description: "",
  categories: [],
  requiredProgress: 1,
  repeatable: true,
  collaborative: false,
  completionCheck: { enabled: false, dc: 10, retryDowntime: 1 },
  allowedChecks: [],
  requiredTools: [],
  completionCosts: [],
  rewards: [],
  characterRewards: [],
  rollTable: [],
  rollTablePreset: "",
  conditions: []
});

export const PROJECT_TEMPLATES = Object.freeze([
  { id: "crafting", nameKey: "DOWNTIME_MANAGER.Project.Templates.Crafting.Name", descriptionKey: "DOWNTIME_MANAGER.Project.Templates.Crafting.Description", img: "icons/tools/smithing/hammer-sledge-steel-grey.webp", config: { categories: [], requiredProgress: 10, repeatable: false, collaborative: true } },
  { id: "research", nameKey: "DOWNTIME_MANAGER.Project.Templates.Research.Name", descriptionKey: "DOWNTIME_MANAGER.Project.Templates.Research.Description", img: "icons/sundries/books/book-open-purple.webp", config: { categories: ["research"], requiredProgress: 100, repeatable: false, collaborative: true, completionCheck: { enabled: false, dc: 15, retryDowntime: 1 } } },
  { id: "work", nameKey: "DOWNTIME_MANAGER.Project.Templates.Work.Name", descriptionKey: "DOWNTIME_MANAGER.Project.Templates.Work.Description", img: "icons/skills/trades/construction-carpentry-hammer.webp", config: { categories: ["working"], requiredProgress: 5, repeatable: true } },
  { id: "training", nameKey: "DOWNTIME_MANAGER.Project.Templates.Training.Name", descriptionKey: "DOWNTIME_MANAGER.Project.Templates.Training.Description", img: "icons/skills/trades/academics-study-reading-book.webp", config: { categories: ["training"], requiredProgress: 600, repeatable: false, completionCheck: { enabled: true, dc: 15, retryDowntime: 1 } } },
  { id: "carousing", nameKey: "DOWNTIME_MANAGER.Project.Templates.Carousing.Name", descriptionKey: "DOWNTIME_MANAGER.Project.Templates.Carousing.Description", img: "icons/environment/settlement/tavern.webp", config: { categories: ["carousing"], requiredProgress: 5, repeatable: true } },
  { id: "recovery", nameKey: "DOWNTIME_MANAGER.Project.Templates.Recovery.Name", descriptionKey: "DOWNTIME_MANAGER.Project.Templates.Recovery.Description", img: "icons/magic/life/heart-cross-strong-flame-green.webp", config: { categories: [], requiredProgress: 5, repeatable: true } }
]);
