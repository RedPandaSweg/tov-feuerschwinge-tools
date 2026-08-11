import { CONTENT_MODULE_ID, MODULE_ID } from "../core/constants.mjs";

const ITEM_PACK = `${CONTENT_MODULE_ID}.items`;
const MANAGED_FLAG = "weaponOptionActivity";
const MANAGED_EFFECT_FLAG = "weaponOptionEffect";
const CHAIN_FLAG = "activityChain";
const UPDATE_OPTION = "weaponOptionActivitySync";

const OPTION_ACTIVITIES = Object.freeze({
  bash: {
    id: "tovfwoBash000000",
    icon: "icons/svg/explosion.svg",
    description: "Make an attack roll with this weapon. On a hit, the target has disadvantage on its next attack roll."
  },
  disarm: {
    id: "tovfwoDisarm0000",
    saveId: "tovfwoDisSave000",
    saveAbilities: ["strength", "dexterity"],
    icon: "icons/svg/sword.svg",
    description: "Make an attack roll with this weapon. On a hit, the target must succeed on a STR or DEX save (target’s choice) or drop a weapon, shield, or object it is wielding. The dropped item lands in an unoccupied space within 5 feet of the target. If no unoccupied space is within range, the item lands at the target’s feet."
  },
  hamstring: {
    id: "tovfwoHamstring0",
    icon: "systems/black-flag/artwork/damage/slashing.svg",
    description: "Make an attack roll with this weapon. On a hit, the target’s base movement speed is reduced by 10 feet for 1 minute. A creature’s speed can’t be reduced by more than 10 feet with this weapon option. A creature within 5 feet of the target can take an action to tend the wound with a successful WIS (Medicine) check against your weapon option DC, ending the effect. The effect also ends if the target receives any magical healing."
  },
  harmlessFusillade: {
    id: "tovfwoFusillade0",
    saveId: "tovfwoFusSave000",
    saveAbilities: ["constitution"],
    icon: "icons/svg/stoned.svg",
    description: "Harmlessly discharge the weapon while aiming at a creature within the weapon’s normal range. On a successful hit, the target must succeed on a CON save or have disadvantage on the next concentration check it makes before the start of your next turn."
  },
  pinningShot: {
    id: "tovfwoPinning000",
    saveId: "tovfwoPinSave000",
    effectActivityId: "tovfwoPinEffect0",
    saveAbilities: ["strength", "dexterity"],
    effect: "pinningShot",
    icon: "systems/black-flag/artwork/statuses/restrained.svg",
    description: "Make an attack roll with this weapon against a Large or smaller creature. On a hit, the target must succeed on a STR or DEX save (target’s choice) or its speed becomes 0 feet until the end of its next turn. A creature can use its action to free the target with a successful STR (Athletics) or DEX (Acrobatics) check against your weapon option DC."
  },
  pull: {
    id: "tovfwoPull000000",
    icon: "systems/black-flag/artwork/statuses/grappled.svg",
    description: "Make an attack roll with this weapon against a Large or smaller creature. On a hit, the target is pulled up to 5 feet closer to you. If this would pull the creature into damaging terrain, it can make a STR or DEX save (target’s choice) to avoid the pull."
  },
  ricochetShot: {
    id: "tovfwoRicochet00",
    icon: "systems/black-flag/artwork/activities/save.svg",
    damage: true,
    description: "Make an attack roll with this weapon against a target you can see that has half or three-quarters cover and is within 10 feet of another object or structure that isn’t providing the cover. Treat the target’s AC as if it wasn’t behind cover. On a hit, the target takes normal weapon damage. This expends the same ammunition as a normal attack."
  },
  trip: {
    id: "tovfwoTrip000000",
    saveId: "tovfwoTripSave00",
    effectActivityId: "tovfwoTripEffect",
    saveAbilities: ["strength", "dexterity"],
    effect: "trip",
    icon: "systems/black-flag/artwork/statuses/prone.svg",
    description: "Make an attack roll with this weapon against a Large or smaller creature. On a hit, the target must succeed on a STR or DEX save (target’s choice) or fall prone. A mounted target has advantage on the save."
  }
});

let installed = false;

function optionEffectId(option) {
  if (option === "trip") return CONFIG.statusEffects.prone?._id ?? "bfprone000000000";
  if (option === "pinningShot") return "tovfwoPinned0000";
  return null;
}

function optionEffectData(option) {
  if (option === "pinningShot") {
    return {
      _id: optionEffectId(option),
      name: "Pinning Shot",
      img: OPTION_ACTIVITIES.pinningShot.icon,
      changes: [{
        key: "system.traits.movement.multiplier",
        mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE,
        value: "0",
        priority: 20
      }],
      disabled: false,
      transfer: false,
      duration: { rounds: 1 },
      flags: { [MODULE_ID]: { [MANAGED_EFFECT_FLAG]: option } }
    };
  }
  return {
    _id: optionEffectId(option),
    name: "Trip",
    img: "systems/black-flag/artwork/statuses/prone.svg",
    changes: [],
    disabled: false,
    transfer: false,
    statuses: ["prone"],
    flags: { [MODULE_ID]: { [MANAGED_EFFECT_FLAG]: "trip" } }
  };
}

function selectedManagedEffects(item) {
  return new Set([...new Set(item.system?.options ?? [])]
    .map(option => OPTION_ACTIVITIES[option]?.effect)
    .filter(Boolean));
}

function synchronizeOptionEffectSource(item) {
  const effects = item.effects.map(effect => effect.toObject());
  const selected = selectedManagedEffects(item);
  for (let index = effects.length - 1; index >= 0; index -= 1) {
    const option = foundry.utils.getProperty(effects[index], `flags.${MODULE_ID}.${MANAGED_EFFECT_FLAG}`);
    if (option && !selected.has(option)) effects.splice(index, 1);
  }
  for (const option of selected) {
    const data = optionEffectData(option);
    const index = effects.findIndex(effect => effect._id === data._id);
    if (index >= 0) effects[index] = data;
    else effects.push(data);
  }
  item.updateSource({ effects });
}

async function synchronizeOptionEffectDocuments(item) {
  const selected = selectedManagedEffects(item);
  const obsolete = item.effects.filter(effect => {
    const option = effect.getFlag(MODULE_ID, MANAGED_EFFECT_FLAG);
    return option && !selected.has(option);
  });
  if (obsolete.length) await item.deleteEmbeddedDocuments("ActiveEffect", obsolete.map(effect => effect.id));
  for (const option of selected) {
    const data = optionEffectData(option);
    if (item.effects.get(data._id)) await item.updateEmbeddedDocuments("ActiveEffect", [data]);
    else await item.createEmbeddedDocuments("ActiveEffect", [data], { keepId: true });
  }
}

function managedOption(activity) {
  return foundry.utils.getProperty(activity, `flags.${MODULE_ID}.${MANAGED_FLAG}`);
}

function activitySource(activity) {
  return activity?.toObject ? activity.toObject() : foundry.utils.deepClone(activity);
}

function activitiesObject(item) {
  return Object.fromEntries(
    [...(item.system?.activities ?? [])].map(activity => [activity.id ?? activity._id, activitySource(activity)])
  );
}

function baseAttack(item) {
  return [...(item.system?.activities ?? [])].find(activity => (
    activity.type === "attack" && !managedOption(activity)
  ));
}

function optionLabel(option) {
  const configured = CONFIG.BlackFlag.weaponOptions?.[option]?.label;
  return configured ? game.i18n.localize(configured) : option.replace(/([a-z])([A-Z])/g, "$1 $2").titleCase();
}

function buildActivity(item, option, definition, attack, sort) {
  const source = activitySource(attack);
  source._id = definition.id;
  source.name = optionLabel(option);
  source.img = definition.icon;
  source.description = `<p>${definition.description}</p>`;
  source.sort = sort;
  source.activation ??= {};
  source.activation.primary = false;
  foundry.utils.setProperty(source, `flags.${MODULE_ID}.${MANAGED_FLAG}`, option);

  source.system ??= {};
  source.system.damage ??= {};
  if (!definition.damage) {
    source.system.damage.includeBase = false;
    source.system.damage.parts = [];
    source.system.damage.critical ??= {};
    source.system.damage.critical.bonus = "";
  }
  source.system.effects = [];
  if (definition.saveId) {
    foundry.utils.setProperty(source, `flags.${MODULE_ID}.${CHAIN_FLAG}`, [{
      trigger: "attackHit",
      activityId: definition.saveId,
      execution: "automatic",
      targets: "successful"
    }]);
  } else {
    foundry.utils.unsetProperty(source, `flags.${MODULE_ID}.${CHAIN_FLAG}`);
  }

  const ActivityClass = CONFIG.Activity.types.attack.documentClass;
  return new ActivityClass(source, { parent: item }).toObject();
}

function buildSaveActivity(item, option, definition, attack, sort) {
  const ActivityClass = CONFIG.Activity.types.save.documentClass;
  const flags = { [MODULE_ID]: { [MANAGED_FLAG]: option } };
  if (definition.effectActivityId) {
    flags[MODULE_ID][CHAIN_FLAG] = [{
      trigger: "saveFailure",
      activityId: definition.effectActivityId,
      execution: "automatic",
      targets: "failed"
    }];
  }
  return new ActivityClass({
    _id: definition.saveId,
    type: "save",
    name: `${optionLabel(option)} — Save`,
    img: definition.icon,
    description: `<p>${definition.description}</p>`,
    sort,
    activation: { primary: false },
    system: {
      damage: { onSave: "none", parts: [] },
      effects: [],
      save: {
        ability: definition.saveAbilities,
        bonus: "",
        dc: { ability: attack.ability ?? attack.system?.attack?.ability ?? "", formula: "" },
        visible: true
      }
    },
    flags
  }, { parent: item }).toObject();
}

function buildEffectActivity(item, option, definition, sort) {
  const ActivityClass = CONFIG.Activity.types.utility.documentClass;
  return new ActivityClass({
    _id: definition.effectActivityId,
    type: "utility",
    name: `${optionLabel(option)} — Effect`,
    img: definition.icon,
    description: `<p>${definition.description}</p>`,
    sort,
    activation: { primary: false },
    system: {
      effects: [{ _id: optionEffectId(definition.effect) }],
      roll: { formula: "", name: "", prompt: false, visible: false }
    },
    flags: {
      [MODULE_ID]: { [MANAGED_FLAG]: option }
    }
  }, { parent: item }).toObject();
}

function synchronizedActivities(item) {
  if (item.type !== "weapon") return null;
  const selected = new Set(
    [...(item.system.options ?? [])].filter(option => OPTION_ACTIVITIES[option])
  );
  const original = activitiesObject(item);
  const current = foundry.utils.deepClone(original);

  // Rebuild only the currently selected managed Activities. This also removes
  // stale data written by earlier versions, including invalid image paths.
  for (const [id, source] of Object.entries(current)) {
    const option = managedOption(source);
    if (!option) continue;
    delete current[id];
  }

  if (!selected.size) return foundry.utils.equals(original, current) ? null : current;
  const attack = baseAttack(item);
  const attackOptions = [...selected];
  if (!attack && attackOptions.length) {
    console.warn(`${MODULE_ID} | Cannot create Weapon Option Activities for ${item.name}: no base Attack Activity found.`);
  }

  let sort = Math.max(0, ...Object.values(current).map(activity => Number(activity.sort) || 0));
  for (const option of selected) {
    const definition = OPTION_ACTIVITIES[option];
    sort += CONST.SORT_INTEGER_DENSITY;
    if (attack) {
      current[definition.id] = buildActivity(item, option, definition, attack, sort);
      if (definition.saveId) {
        sort += CONST.SORT_INTEGER_DENSITY;
        current[definition.saveId] = buildSaveActivity(item, option, definition, attack, sort);
      }
      if (definition.effectActivityId) {
        sort += CONST.SORT_INTEGER_DENSITY;
        current[definition.effectActivityId] = buildEffectActivity(item, option, definition, sort);
      }
    }
  }
  return foundry.utils.equals(original, current) ? null : current;
}

async function synchronizeWeapon(item, { persist = true } = {}) {
  if (persist) await synchronizeOptionEffectDocuments(item);
  else synchronizeOptionEffectSource(item);
  const activities = synchronizedActivities(item);
  if (!activities) return false;
  if (persist) {
    const current = activitiesObject(item);
    const activityUpdates = {};
    for (const id of Object.keys(current)) {
      if (!Object.hasOwn(activities, id)) {
        activityUpdates[id] = new foundry.data.operators.ForcedDeletion();
      }
    }
    for (const [id, activity] of Object.entries(activities)) {
      if (!foundry.utils.equals(current[id], activity)) {
        activityUpdates[id] = activity;
      }
    }
    if (!foundry.utils.isEmpty(activityUpdates)) {
      await item.update({ "system.activities": activityUpdates }, { [UPDATE_OPTION]: true });
    }
  } else {
    item.updateSource({ "system.activities": activities });
  }
  return true;
}

async function synchronizeWorldWeapons() {
  if (!game.user.isGM) return 0;
  const weapons = [
    ...game.items.filter(item => item.type === "weapon"),
    ...game.actors.reduce((items, actor) => (
      items.concat(actor.items.filter(item => item.type === "weapon"))
    ), [])
  ];
  const results = await Promise.all(weapons.map(item => synchronizeWeapon(item)));
  return results.filter(Boolean).length;
}

async function synchronizeCompendiumWeapons() {
  if (!game.user.isGM) return 0;
  const pack = game.packs.get(ITEM_PACK);
  if (!pack) return 0;
  const wasLocked = pack.locked;
  let updated = 0;
  try {
    if (wasLocked) await pack.configure({ locked: false });
    for (const item of await pack.getDocuments()) {
      if (item.type === "weapon" && await synchronizeWeapon(item)) updated += 1;
    }
  } finally {
    if (wasLocked) await pack.configure({ locked: true });
  }
  return updated;
}

async function synchronizeAllWeaponOptionActivities() {
  const [world, compendium] = await Promise.all([
    synchronizeWorldWeapons(),
    synchronizeCompendiumWeapons()
  ]);
  console.info(`${MODULE_ID} | Weapon Option Activities synchronized.`, { world, compendium });
  return { world, compendium };
}

export function installWeaponOptionActivities() {
  if (installed) return;
  installed = true;

  Hooks.on("preCreateItem", item => {
    if (item.type === "weapon") synchronizeWeapon(item, { persist: false });
  });
  Hooks.on("updateItem", (item, changes, options) => {
    if (options?.[UPDATE_OPTION] || item.type !== "weapon") return;
    if (foundry.utils.hasProperty(changes, "system.options")) void synchronizeWeapon(item);
  });
}

export const weaponOptionActivitiesApi = {
  synchronizeAll: synchronizeAllWeaponOptionActivities,
  synchronizeCompendium: synchronizeCompendiumWeapons,
  synchronizeWeapon
};
