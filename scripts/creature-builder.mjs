import { MODULE_ID } from "./core/constants.mjs";

export const CREATURE_FORMAT = "tov-feuerschwinge.creature";
export const CREATURE_VERSION = 1;

const FORBIDDEN_PACKAGES = new Set([
  MODULE_ID,
  "koboldpressogl",
  "koboldpressogl-bf"
]);
const ABILITIES = [
  "strength", "dexterity", "constitution",
  "intelligence", "wisdom", "charisma"
];
const SIZES = new Set(["tiny", "small", "medium", "large", "huge", "gargantuan"]);
const SPELLCASTING_ABILITIES = new Set(["intelligence", "wisdom", "charisma"]);
const ABILITY_ALIASES = {
  str: "strength", strength: "strength",
  dex: "dexterity", dexterity: "dexterity",
  con: "constitution", constitution: "constitution",
  int: "intelligence", intelligence: "intelligence",
  wis: "wisdom", wisdom: "wisdom",
  cha: "charisma", charisma: "charisma"
};

function text(value) {
  return String(value ?? "").trim();
}

function number(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function integer(value, fallback = null) {
  const parsed = number(value, fallback);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function html(value) {
  const source = text(value);
  return source.startsWith("<") ? source : `<p>${source}</p>`;
}

function slugify(value) {
  return text(value)
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "monster-feature";
}

function randomId() {
  return foundry.utils.randomID(16);
}

function removePortableFields(data) {
  for (const key of ["_id", "_stats", "folder", "sort", "ownership"]) delete data[key];
  if (data.flags?.core) delete data.flags.core.sourceId;
  return data;
}

function traitGroup(damage = false, values = []) {
  const result = { value: values, custom: [] };
  if (damage) result.nonmagical = [];
  return result;
}

function normalizeAbility(value) {
  return ABILITY_ALIASES[text(value).toLowerCase()] ?? text(value).toLowerCase();
}

function normalizeAbilities(value = {}) {
  const result = {};
  for (const [key, modifier] of Object.entries(value ?? {})) {
    const ability = normalizeAbility(key);
    if (ABILITIES.includes(ability)) result[ability] = modifier;
  }
  return result;
}

function normalizeDamage(value, fallbackType = "") {
  if (Array.isArray(value)) {
    return value.flatMap(part => normalizeDamage(part, fallbackType));
  }
  if (typeof value === "string") {
    const source = text(value);
    const typed = source.match(/^(.+?\d)\s+([A-Za-z]+)$/);
    return [{
      formula: text(typed?.[1] ?? source),
      type: text(typed?.[2] ?? fallbackType).toLowerCase()
    }];
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.parts)) return normalizeDamage(value.parts, fallbackType);
    return [{
      ...value,
      formula: value.formula ?? value.value ?? "",
      type: text(value.type ?? fallbackType).toLowerCase()
    }];
  }
  return [];
}

function normalizeActivation(value) {
  const key = text(value);
  return ({
    passive: "passive",
    action: "action",
    bonus: "bonus",
    bonusaction: "bonus",
    reaction: "reaction"
  }[key.toLowerCase()] ?? key.toLowerCase()) || "passive";
}

function normalizeRecovery(value) {
  const key = text(value).replace(/[\s_-]+/g, "").toLowerCase();
  return {
    longrest: "day",
    shortrest: "shortRest"
  }[key] ?? (key === "day" ? "day" : text(value) || "day");
}

function normalizeSpellcasting(value) {
  if (!value) return undefined;
  return {
    ability: normalizeAbility(value.ability),
    spells: foundry.utils.deepClone(value.spells ?? []),
    customSpells: foundry.utils.deepClone(value.customSpells ?? [])
  };
}

export function canonicalizeCreature(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return source;
  const traits = source.traits ?? {};
  const actions = Array.isArray(source.actions) ? source.actions : [];
  const normalizedActions = actions.map(action => {
    const kind = text(action.kind).toLowerCase();
    const uses = action.uses && typeof action.uses === "object"
      ? action.uses
      : undefined;
    const normalized = {
      ...foundry.utils.deepClone(action),
      kind,
      activation: normalizeActivation(action.activation ?? (kind === "passive" ? "passive" : "action")),
      condition: action.condition ?? action.trigger,
      uses: uses?.type === "recharge" ? 1 : uses?.value,
      recovery: uses?.type === "recharge"
        ? `recharge${integer(uses.value, 6)}`
        : normalizeRecovery(uses?.recovery)
    };
    if (kind === "attack") return {
      ...normalized,
      attackType: text(action.attackType).toLowerCase(),
      bonus: action.attackBonus,
      classification: text(action.classification || "weapon").toLowerCase(),
      magical: action.magical ?? text(action.classification).toLowerCase() === "spell",
      damage: normalizeDamage(action.damage)
    };
    if (kind === "save") return {
      ...normalized,
      ability: normalizeAbility(action.save?.ability),
      dc: action.save?.dc,
      onSave: action.save?.result,
      templateType: text(action.area?.type).toLowerCase(),
      templateSize: integer(action.area?.size, undefined),
      templateWidth: integer(action.area?.width, undefined),
      damage: normalizeDamage(action.damage)
    };
    return normalized;
  });
  const attacks = normalizedActions.filter(action => action.kind === "attack");
  const saveActions = normalizedActions.filter(action => action.kind === "save");
  const features = normalizedActions.filter(action => !["attack", "save"].includes(action.kind));
  return {
    ...foundry.utils.deepClone(source),
    name: text(source.name),
    cr: source.cr,
    role: text(source.role).toLowerCase(),
    size: text(source.size).toLowerCase(),
    creatureType: text(source.creatureType).toLowerCase(),
    description: text(source.description),
    stats: foundry.utils.deepClone(source.stats ?? {}),
    abilities: normalizeAbilities(source.abilities),
    movement: foundry.utils.deepClone(source.movement ?? {}),
    senses: foundry.utils.deepClone(traits.senses ?? {}),
    languages: foundry.utils.deepClone(traits.languages ?? []),
    saveProficiencies: (traits.savingThrows ?? []).map(normalizeAbility),
    damageResistances: foundry.utils.deepClone(traits.damageResistances ?? []),
    damageImmunities: foundry.utils.deepClone(traits.damageImmunities ?? []),
    damageVulnerabilities: foundry.utils.deepClone(traits.damageVulnerabilities ?? []),
    conditionImmunities: foundry.utils.deepClone(traits.conditionImmunities ?? []),
    actions: normalizedActions,
    attacks,
    saveActions,
    features,
    spellcasting: normalizeSpellcasting(source.spellcasting)
  };
}

function defaultAbilities(brief) {
  const spellcaster = brief.spellcasting?.ability;
  const result = {
    strength: 0,
    dexterity: 2,
    constitution: 2,
    intelligence: spellcaster === "intelligence" ? 4 : 0,
    wisdom: spellcaster === "wisdom" ? 4 : 1,
    charisma: spellcaster === "charisma" ? 4 : 1
  };
  for (const ability of ABILITIES) {
    result[ability] = integer(brief.abilities?.[ability], result[ability]);
  }
  return result;
}

export function validateCreature(source) {
  const errors = [];
  const warnings = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { valid: false, errors: ["The creature JSON must be one JSON object."], warnings };
  }
  const rawSource = source;
  source = canonicalizeCreature(source);
  for (const field of ["stats", "abilities", "movement", "traits", "spellcasting"]) {
    if (!(field in rawSource)) errors.push(`${field} is required.`);
  }
  if (!Array.isArray(rawSource.actions)) errors.push("actions must be an array.");
  for (const obsolete of ["attacks", "saveActions", "features", "bonusActions", "reactions"]) {
    if (rawSource[obsolete] !== undefined) errors.push(`${obsolete} is obsolete; put every entry in actions.`);
  }
  if (source.format !== CREATURE_FORMAT) errors.push(`format must be "${CREATURE_FORMAT}".`);
  if (source.version !== CREATURE_VERSION) errors.push(`version must be ${CREATURE_VERSION}.`);
  if (!text(source.name)) errors.push("name is required.");
  const cr = number(source.cr);
  if (cr === null || cr < 0 || cr > 30) errors.push("cr must be a number from 0 through 30.");
  if (!SIZES.has(source.size ?? "medium")) errors.push("size is not a supported Black Flag size.");
  if (!text(source.creatureType)) errors.push("creatureType is required.");
  const abilityKeys = Object.keys(rawSource.abilities ?? {}).sort();
  const expectedAbilityKeys = ["cha", "con", "dex", "int", "str", "wis"];
  if (abilityKeys.join(",") !== expectedAbilityKeys.join(",")) {
    errors.push("abilities must contain exactly str, dex, con, int, wis, and cha.");
  }
  for (const [key, minimum] of [["ac", 1], ["hp", 1], ["attackBonus", -20], ["saveDC", 1]]) {
    const value = number(source.stats?.[key]);
    if (value === null || value < minimum) errors.push(`stats.${key} is required and invalid.`);
  }
  for (const action of source.actions ?? []) {
    if (!["attack", "save", "utility", "passive"].includes(action.kind)) {
      errors.push(`${action.name || "Action"} has an unsupported kind.`);
    }
    if (!["action", "bonus", "reaction", "passive"].includes(action.activation)) {
      errors.push(`${action.name || "Action"} has an unsupported activation.`);
    }
  }
  for (const attack of source.attacks ?? []) {
    if (!text(attack.name)) errors.push("Every attack needs a name.");
    if (!Array.isArray(attack.damage) || !attack.damage.length) errors.push(`${attack.name || "Attack"} needs damage parts.`);
  }
  if (source.spellcasting) {
    if (!SPELLCASTING_ABILITIES.has(source.spellcasting.ability)) {
      errors.push("spellcasting.ability must be intelligence, wisdom, or charisma.");
    }
    if (source.spellcasting.spells !== undefined && !Array.isArray(source.spellcasting.spells)) {
      errors.push("spellcasting.spells must be an array.");
    }
    if (!(source.spellcasting.spells?.length || source.spellcasting.customSpells?.length)) {
      errors.push("A spellcaster needs at least one official or custom spell.");
    }
    for (const spell of source.spellcasting.spells ?? []) {
      if (!text(spell.name)) errors.push("Every spell entry needs a name.");
    }
    if (source.spellcasting.customSpells !== undefined && !Array.isArray(source.spellcasting.customSpells)) {
      errors.push("spellcasting.customSpells must be an array.");
    }
    for (const spell of source.spellcasting.customSpells ?? []) {
      if (!text(spell.name)) errors.push("Every custom spell needs a name.");
      if (!Number.isInteger(spell.circle) || spell.circle < 0 || spell.circle > 9) {
        errors.push(`${spell.name || "Custom spell"} needs a circle from 0 through 9.`);
      }
      if (!text(spell.school)) errors.push(`${spell.name || "Custom spell"} needs a school.`);
      if (!["action", "bonus", "reaction"].includes(spell.casting)) {
        errors.push(`${spell.name || "Custom spell"} needs casting action, bonus, or reaction.`);
      }
      if (!["attack", "save", "healing", "teleport", "utility"].includes(spell.activityType)) {
        errors.push(`${spell.name || "Custom spell"} has an unsupported activityType.`);
      }
      if (!text(spell.description)) errors.push(`${spell.name || "Custom spell"} needs a description.`);
      if (["attack", "save"].includes(spell.activityType) && !normalizeDamage(spell.damage).length) {
        errors.push(`${spell.name || "Custom spell"} needs damage parts.`);
      }
      if (spell.activityType === "save" && !ABILITIES.includes(spell.saveAbility)) {
        errors.push(`${spell.name || "Custom spell"} needs a valid saveAbility.`);
      }
      if (spell.activityType === "healing" && !text(spell.healing)) {
        errors.push(`${spell.name || "Custom spell"} needs a healing formula.`);
      }
      if (spell.activityType === "teleport" && integer(spell.teleportDistance, 0) <= 0) {
        errors.push(`${spell.name || "Custom spell"} needs a positive teleportDistance.`);
      }
    }
  }
  if (!(source.actions?.some(action => ["attack", "save"].includes(action.kind)) || source.spellcasting?.spells?.length)) {
    errors.push("The brief needs at least one attack, save action, or spell.");
  }
  if (!(source.actions?.some(action => !["attack", "save"].includes(action.kind)))) {
    warnings.push("The monster has no signature feature.");
  }
  return { valid: !errors.length, errors, warnings };
}

export function normalizeCreature(source) {
  const report = validateCreature(source);
  if (!report.valid) throw new Error(report.errors.join("\n"));
  source = canonicalizeCreature(source);
  return {
    ...foundry.utils.deepClone(source),
    name: text(source.name),
    size: source.size ?? "medium",
    creatureType: text(source.creatureType),
    role: text(source.role),
    description: text(source.description) || "An original Black Flag creature.",
    stats: {
      ac: integer(source.stats.ac),
      hp: integer(source.stats.hp),
      attackBonus: integer(source.stats.attackBonus),
      saveDC: integer(source.stats.saveDC)
    },
    abilities: defaultAbilities(source),
    movement: {
      walk: integer(source.movement?.walk, 30),
      climb: integer(source.movement?.climb, 0),
      fly: integer(source.movement?.fly, 0),
      swim: integer(source.movement?.swim, 0),
      burrow: integer(source.movement?.burrow, 0)
    },
    senses: {
      darkvision: integer(source.senses?.darkvision, 0),
      blindsight: integer(source.senses?.blindsight, 0),
      tremorsense: integer(source.senses?.tremorsense, 0),
      truesight: integer(source.senses?.truesight, 0)
    },
    languages: Array.isArray(source.languages) ? source.languages.map(text).filter(Boolean) : [],
    attacks: source.attacks ?? [],
    saveActions: source.saveActions ?? [],
    features: source.features ?? []
  };
}

function featureSystem(name, description, activities) {
  return {
    activities,
    uses: { spent: 0, consumeQuantity: false, recovery: [], min: "", max: "" },
    advancement: {},
    description: { value: html(description), source: { fallback: "Original creation" } },
    restriction: { allowMultipleTimes: false, filters: [], items: [], requireAll: true },
    type: { category: "monsters", value: "" },
    overrides: { proficiency: null },
    identifier: { value: slugify(name), associated: "" },
    level: { value: null }
  };
}

function commonActivity(spec, type, id) {
  return {
    _id: id,
    type,
    system: {},
    description: html(spec.description),
    activation: {
      value: null,
      type: spec.activation ?? "action",
      condition: text(spec.condition),
      override: false,
      primary: true
    },
    consumption: { targets: [], scale: { allowed: false } },
    duration: {
      units: spec.duration ?? "instantaneous",
      override: false,
      concentration: false
    },
    range: {
      value: spec.range ? String(spec.range) : "",
      units: "foot",
      special: "",
      override: false
    },
    target: {
      template: {
        count: "1",
        contiguous: false,
        type: spec.templateType ?? "",
        size: spec.templateSize ? String(spec.templateSize) : "",
        width: spec.templateWidth ? String(spec.templateWidth) : "",
        height: "",
        unit: "foot"
      },
      affects: {
        choice: false,
        count: spec.targetCount ? String(spec.targetCount) : "1",
        special: "",
        type: spec.targetType ?? "creature"
      },
      override: false,
      prompt: true
    },
    uses: { spent: 0, consumeQuantity: false, recovery: [], min: "", max: "" },
    name: spec.name,
    img: "",
    flags: {},
    magical: Boolean(spec.magical)
  };
}

function damagePart(part) {
  const match = text(part.formula).match(/^(\d+)d(\d+)(?:\s*([+-])\s*(\d+))?$/i);
  if (!match) throw new Error(`Invalid damage formula "${part.formula}". Use forms such as 2d8+4.`);
  const signedBonus = match[4] ? `${match[3] === "-" ? "-" : ""}${match[4]}` : "";
  return {
    number: Number(match[1]),
    denomination: Number(match[2]),
    bonus: signedBonus,
    custom: { formula: "", enabled: false },
    type: text(part.type),
    additionalTypes: [],
    scaling: { number: 1 }
  };
}

function featureItem(spec, activity) {
  return {
    _id: randomId(),
    name: spec.name,
    type: "feature",
    img: spec.img ?? "icons/svg/aura.svg",
    system: featureSystem(spec.name, spec.description, { [activity._id]: activity }),
    effects: [],
    flags: {}
  };
}

function createAttack(spec, brief) {
  const id = randomId();
  const activity = commonActivity(spec, "attack", id);
  activity.img = "systems/black-flag/artwork/activities/attack.svg";
  activity.system = {
    attack: {
      flat: true,
      bonus: String(integer(spec.bonus, brief.stats.attackBonus)),
      ability: "",
      type: {
        value: spec.attackType ?? "melee",
        classification: spec.classification ?? (spec.magical ? "spell" : "weapon")
      },
      critical: { threshold: null }
    },
    damage: {
      parts: spec.damage.map(damagePart),
      includeBase: false,
      critical: { bonus: "" }
    },
    effects: []
  };
  return featureItem(spec, activity);
}

function createSaveAction(spec, brief) {
  const id = randomId();
  const activity = commonActivity(spec, "save", id);
  activity.img = "systems/black-flag/artwork/activities/save.svg";
  activity.system = {
    save: {
      ability: [spec.ability ?? "dexterity"],
      bonus: "",
      dc: { ability: "custom", formula: String(integer(spec.dc, brief.stats.saveDC)) },
      visible: true
    },
    damage: {
      onSave: spec.onSave ?? "half",
      parts: (spec.damage ?? []).map(damagePart)
    },
    effects: []
  };
  const item = featureItem(spec, activity);
  applyUses(item.system.uses, spec);
  applyUses(activity.uses, spec);
  return item;
}

function createUtility(spec) {
  if (!spec.activation || spec.activation === "passive") {
    const item = {
      _id: randomId(),
      name: spec.name,
      type: "feature",
      img: spec.img ?? "icons/svg/aura.svg",
      system: featureSystem(spec.name, spec.description, {}),
      effects: [],
      flags: {}
    };
    applyUses(item.system.uses, spec);
    return item;
  }
  const id = randomId();
  const activity = commonActivity({
    ...spec,
    targetType: spec.targetType ?? "self"
  }, "utility", id);
  activity.system = { effects: [] };
  const item = featureItem(spec, activity);
  applyUses(item.system.uses, spec);
  applyUses(activity.uses, spec);
  return item;
}

function applyUses(target, spec) {
  if (spec.uses === undefined || spec.uses === "atWill") return;
  const maximum = String(integer(spec.uses, 1));
  target.max = maximum;
  const recharge = text(spec.recovery).match(/^recharge([1-6])$/);
  target.recovery = recharge
    ? [{ period: "recharge", formula: recharge[1] }]
    : [{ period: spec.recovery ?? "day", formula: maximum }];
}

function parseDiceFormula(formula, label) {
  const match = text(formula).match(/^(\d+)d(\d+)(.*)$/i);
  if (!match) throw new Error(`${label} must use a dice formula such as 2d8+4.`);
  return {
    number: Number(match[1]),
    denomination: Number(match[2]),
    bonus: match[3].replace(/^\+/, "").trim()
  };
}

function spellTarget(spec) {
  const area = spec.area ?? {};
  return {
    template: {
      count: 1,
      units: "foot",
      type: area.type ?? "",
      size: area.size ? String(area.size) : "",
      width: area.width ? String(area.width) : "",
      height: area.height ? String(area.height) : ""
    },
    affects: {
      choice: false,
      type: spec.targetType ?? (area.type ? "creature" : ""),
      count: spec.targetCount ? String(spec.targetCount) : "",
      special: text(spec.targetSpecial)
    }
  };
}

function customSpellActivity(spec, brief) {
  const id = randomId();
  const activitySpec = {
    ...spec,
    activation: spec.casting,
    templateType: spec.area?.type,
    templateSize: spec.area?.size,
    templateWidth: spec.area?.width,
    targetCount: spec.targetCount,
    targetType: spec.targetType
  };
  const type = {
    attack: "attack",
    save: "savingThrow",
    healing: "healing",
    teleport: "teleport",
    utility: "utility"
  }[spec.activityType];
  const activity = commonActivity(activitySpec, type, id);
  activity.magical = true;
  activity.activation.type = spec.casting;
  if (spec.activityType === "attack") {
    activity.img = "systems/black-flag/artwork/activities/attack.svg";
    activity.system = {
      type: {
        value: spec.attackType ?? "ranged",
        classification: "spell"
      },
      damage: {
        includeBaseDamage: true,
        parts: normalizeDamage(spec.damage).map(damagePart)
      },
      ability: "",
      attack: {
        flat: true,
        bonus: String(integer(spec.attackBonus, brief.stats.attackBonus))
      }
    };
  } else if (spec.activityType === "save") {
    activity.img = "systems/black-flag/artwork/activities/save.svg";
    activity.system = {
      damage: {
        onSave: spec.onSave ?? "half",
        parts: normalizeDamage(spec.damage).map(damagePart)
      },
      dc: {
        ability: "custom",
        formula: String(integer(spec.dc, brief.stats.saveDC))
      },
      ability: spec.saveAbility
    };
  } else if (spec.activityType === "healing") {
    const healing = parseDiceFormula(spec.healing, `${spec.name} healing`);
    activity.system = {
      healing: {
        type: "healing",
        denomination: healing.denomination,
        bonus: healing.bonus,
        custom: "",
        number: healing.number,
        scaling: { mode: "whole", formula: "" }
      },
      ability: ""
    };
  } else if (spec.activityType === "teleport") {
    activity.system = {
      distance: {
        unit: "foot",
        value: String(integer(spec.teleportDistance))
      },
      unlimited: false
    };
  } else {
    activity.system = { effects: [] };
  }
  applyUses(activity.uses, spec);
  return activity;
}

function createCustomSpell(spec, brief) {
  const activity = customSpellActivity(spec, brief);
  const rangeValue = number(spec.range);
  const rangeUnits = rangeValue === null ? text(spec.range) || "self" : "foot";
  const concentration = Boolean(spec.concentration);
  const item = {
    _id: randomId(),
    name: spec.name,
    type: "spell",
    img: spec.img ?? "icons/magic/symbols/runes-star-pentagon-blue.webp",
    system: {
      activities: { [activity._id]: activity },
      uses: {
        spent: 0,
        consumeQuantity: false,
        recovery: [],
        min: "",
        max: ""
      },
      description: {
        value: html(spec.description),
        source: { fallback: "Original creation" },
        short: text(spec.summary)
      },
      type: { value: "standard" },
      circle: { value: null, base: integer(spec.circle) },
      casting: {
        value: null,
        type: spec.casting,
        condition: text(spec.castingCondition)
      },
      components: {
        required: Array.isArray(spec.components) ? spec.components : [],
        material: {
          cost: null,
          consumed: false,
          denomination: "gp"
        }
      },
      duration: {
        units: spec.duration?.units ?? "instantaneous",
        ...(spec.duration?.value !== undefined ? { value: String(spec.duration.value) } : {})
      },
      tags: concentration ? ["concentration"] : [],
      target: spellTarget(spec),
      range: {
        units: rangeUnits,
        ...(rangeValue !== null ? { value: String(rangeValue) } : {}),
        special: ""
      },
      school: spec.school,
      source: Array.isArray(spec.sources) ? spec.sources : []
    },
    effects: [],
    flags: {
      "black-flag": {
        relationship: {
          enabled: true,
          alwaysPrepared: true,
          mode: "standard"
        }
      }
    }
  };
  applyUses(item.system.uses, spec);
  return item;
}

function packageIdFor(pack) {
  return pack.metadata.packageName ?? pack.metadata.package ?? "";
}

function allowedSpellPack(pack) {
  const packageId = packageIdFor(pack);
  if (pack.documentName !== "Item" || FORBIDDEN_PACKAGES.has(packageId)) return false;
  return packageId === game.system.id || packageId.startsWith("kp-tov-");
}

function sourcePriority(pack) {
  const packageId = packageIdFor(pack);
  if (packageId === game.system.id) return 0;
  if (packageId === "kp-tov-pg") return 1;
  if (packageId.includes("player")) return 2;
  return 10;
}

async function spellCandidates() {
  const packs = game.packs.filter(allowedSpellPack).sort((a, b) => sourcePriority(a) - sourcePriority(b));
  const candidates = [];
  for (const pack of packs) {
    const index = await pack.getIndex({ fields: ["type", "system.circle.base"] });
    for (const entry of index) {
      if (entry.type !== "spell") continue;
      candidates.push({ pack, entry, normalized: entry.name.toLocaleLowerCase() });
    }
  }
  return candidates;
}

export async function resolveMonsterSpells(brief) {
  const requested = brief.spellcasting?.spells ?? [];
  if (!requested.length) return { items: [], sources: [], missing: [] };
  const candidates = await spellCandidates();
  const items = [];
  const sources = [];
  const missing = [];
  for (const spec of requested) {
    const normalized = text(spec.name).toLocaleLowerCase();
    const candidate = candidates.find(value => value.normalized === normalized);
    if (!candidate) {
      missing.push(spec.name);
      continue;
    }
    const document = await candidate.pack.getDocument(candidate.entry._id);
    const item = removePortableFields(document.toObject());
    item._id = randomId();
    const activities = {};
    for (const activity of Object.values(item.system?.activities ?? {})) {
      const id = randomId();
      activity._id = id;
      activities[id] = activity;
    }
    item.system.activities = activities;
    item.flags ??= {};
    item.flags["black-flag"] ??= {};
    item.flags["black-flag"].relationship = {
      ...(item.flags["black-flag"].relationship ?? {}),
      enabled: true,
      alwaysPrepared: true,
      mode: "standard"
    };
    item.system.uses ??= { spent: 0, consumeQuantity: false, recovery: [], min: "", max: "" };
    applyUses(item.system.uses, spec);
    items.push(item);
    sources.push({
      name: document.name,
      pack: candidate.pack.collection,
      packageId: packageIdFor(candidate.pack)
    });
  }
  return { items, sources, missing };
}

function tokenDimensions(size) {
  return { tiny: 0.5, small: 1, medium: 1, large: 2, huge: 3, gargantuan: 4 }[size] ?? 1;
}

export function createMonsterActorData(brief, embeddedSpells = [], folder = null) {
  const image = brief.img ?? "icons/svg/mystery-man.svg";
  const size = tokenDimensions(brief.size);
  const walk = brief.movement.walk;
  const actor = {
    name: brief.name,
    type: "npc",
    img: image,
    folder,
    system: {
      attributes: {
        ac: {
          baseFormulas: ["unarmored"],
          formulas: [],
          flat: brief.stats.ac,
          override: null,
          customLabel: ""
        },
        cr: brief.cr,
        hp: { value: brief.stats.hp, max: brief.stats.hp, temp: null, tempMax: null },
        exhaustion: 0,
        initiative: { proficiency: { multiplier: 0, rounding: "down" } },
        legendary: { spent: 0, max: null },
        perception: 10 + brief.abilities.wisdom,
        stealth: 10 + brief.abilities.dexterity
      },
      abilities: Object.fromEntries(ABILITIES.map(ability => [
        ability,
        {
          mod: brief.abilities[ability],
          proficient: (brief.saveProficiencies ?? []).includes(ability)
        }
      ])),
      biography: { value: html(brief.description), legendary: "" },
      description: {
        source: { fallback: "Original creation", book: "", page: "" }
      },
      modifiers: [],
      proficiencies: {
        languages: {
          value: brief.languages,
          communication: {},
          custom: [],
          tags: []
        }
      },
      traits: {
        condition: {
          immunities: traitGroup(false, brief.conditionImmunities ?? []),
          resistances: traitGroup(),
          vulnerabilities: traitGroup()
        },
        damage: {
          immunities: traitGroup(true, brief.damageImmunities ?? []),
          resistances: traitGroup(true, brief.damageResistances ?? []),
          vulnerabilities: traitGroup(true, brief.damageVulnerabilities ?? [])
        },
        movement: {
          base: walk,
          custom: [],
          tags: [],
          types: {
            walk: "@base",
            climb: brief.movement.climb ? String(brief.movement.climb) : "",
            fly: brief.movement.fly ? String(brief.movement.fly) : "",
            swim: brief.movement.swim ? String(brief.movement.swim) : "",
            burrow: brief.movement.burrow ? String(brief.movement.burrow) : ""
          },
          units: "foot"
        },
        senses: {
          custom: [],
          tags: [],
          types: {
            darkvision: brief.senses.darkvision ? String(brief.senses.darkvision) : "",
            keensense: brief.senses.blindsight ? String(brief.senses.blindsight) : "",
            tremorsense: brief.senses.tremorsense ? String(brief.senses.tremorsense) : "",
            truesight: brief.senses.truesight ? String(brief.senses.truesight) : ""
          },
          units: "foot"
        },
        size: brief.size,
        type: { value: brief.creatureType, tags: [], custom: [], swarm: "" }
      }
    },
    prototypeToken: {
      name: brief.name,
      displayName: 20,
      actorLink: false,
      appendNumber: false,
      prependAdjective: false,
      width: size,
      height: size,
      texture: {
        src: image,
        anchorX: 0.5,
        anchorY: 0.5,
        fit: "contain",
        scaleX: 1,
        scaleY: 1,
        tint: "#ffffff",
        alphaThreshold: 0.75
      },
      lockRotation: false,
      rotation: 0,
      alpha: 1,
      disposition: -1,
      displayBars: 20,
      bar1: { attribute: "attributes.hp" },
      bar2: { attribute: null },
      randomImg: false
    },
    items: [
      ...brief.features.map(createUtility),
      ...brief.attacks.map(spec => createAttack(spec, brief)),
      ...brief.saveActions.map(spec => createSaveAction(spec, brief)),
      ...embeddedSpells,
      ...(brief.spellcasting?.customSpells ?? []).map(spec => createCustomSpell(spec, brief))
    ],
    effects: [],
    flags: {
      [MODULE_ID]: {
        creatureBuilder: {
          format: CREATURE_FORMAT,
          version: CREATURE_VERSION,
          importedAt: new Date().toISOString()
        }
      }
    }
  };
  if (brief.spellcasting) {
    actor.system.spellcasting = {
      ability: brief.spellcasting.ability,
      dc: brief.stats.saveDC
    };
  }
  return actor;
}

export async function importCreature(source, { folder = null } = {}) {
  if (!game.user.isGM) throw new Error("Only a GM can create creatures.");
  const brief = normalizeCreature(source);
  const spells = await resolveMonsterSpells(brief);
  const data = createMonsterActorData(brief, spells.items, folder || null);
  if (!data.items.length) throw new Error("The generated Actor has no embedded Items.");
  const actor = await Actor.create(data);
  return {
    actor,
    brief,
    spellSources: spells.sources,
    missingSpells: spells.missing,
    counts: {
      features: brief.features.length,
      attacks: brief.attacks.length,
      saveActions: brief.saveActions.length,
      spells: spells.items.length,
      customSpells: brief.spellcasting?.customSpells?.length ?? 0
    }
  };
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class CreatureBuilder extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tov-feuerschwinge-creature-builder",
    tag: "form",
    classes: ["standard-form", "tovf-creature-builder"],
    position: { width: 760, height: "auto" },
    window: { title: "TOVF.CreatureBuilder.Title" },
    actions: {
      loadFile: this.#loadFile,
      validate: this.#validate,
      import: this.#import
    }
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/creature-builder.hbs` }
  };

  report = null;
  briefText = "";

  async _prepareContext(options) {
    const folders = game.folders
      .filter(folder => folder.type === "Actor")
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...(await super._prepareContext(options)),
      folders,
      report: this.report,
      briefText: this.briefText
    };
  }

  source() {
    return JSON.parse(this.element.querySelector('[name="brief"]').value);
  }

  static async #loadFile() {
    const file = this.element.querySelector('[name="file"]').files[0];
    if (!file) return;
    this.briefText = await foundry.utils.readTextFromFile(file);
    this.report = null;
    this.render({ force: true });
  }

  static async #validate() {
    try {
      this.briefText = this.element.querySelector('[name="brief"]').value;
      const source = this.source();
      this.report = validateCreature(source);
    } catch (error) {
      this.report = { valid: false, errors: [error.message], warnings: [] };
    }
    this.render({ force: true });
  }

  static async #import() {
    try {
      const result = await importCreature(this.source(), {
        folder: this.element.querySelector('[name="folder"]').value || null
      });
      ui.notifications.info(game.i18n.format("TOVF.CreatureBuilder.Complete", {
        name: result.actor.name,
        spells: result.counts.spells + result.counts.customSpells
      }));
      if (result.missingSpells.length) {
        ui.notifications.warn(game.i18n.format("TOVF.CreatureBuilder.MissingSpells", {
          spells: result.missingSpells.join(", ")
        }), { permanent: true });
      }
      result.actor.sheet.render(true);
      this.close();
    } catch (error) {
      console.error(`${MODULE_ID} | Creature Builder failed`, error);
      ui.notifications.error(error.message);
    }
  }
}

export function registerCreatureBuilder() {
  game.settings.registerMenu(MODULE_ID, "creatureBuilder", {
    name: "TOVF.CreatureBuilder.Settings.Name",
    label: "TOVF.CreatureBuilder.Settings.Label",
    hint: "TOVF.CreatureBuilder.Settings.Hint",
    icon: "fa-solid fa-dragon",
    type: CreatureBuilder,
    restricted: true
  });
}

export function creatureBuilderApi() {
  return {
    validateCreature,
    normalizeCreature,
    resolveMonsterSpells,
    createMonsterActorData,
    importCreature
  };
}
