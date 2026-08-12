import { LEGACY_MODULE_ID, LEGACY_MODULE_SCOPE, MODULE_ID } from "./core/constants.mjs";

const FLAG = "effectGroup";
const GROUPS = new Set(["magical-drink", "magical-food"]);
const GENERATED_FLAG = "magicalDrinkWorldItem";
const IMPORT_SETTING = "magicalDrinkWorldItemsCreated";
let installed = false;

const DRINKS = [
  {
    id: "animal-speech", name: "Tierzungen-Gebräu — Speak with Animals",
    img: "icons/consumables/potions/bottle-corked-labeled-green.webp",
    intro: "Ein eigentümliches Gebräu, das die Wahrnehmung für die Laute und Gesten von Tieren schärft. Nach dem Trinken wirken selbst Knurren, Zwitschern und Quieken plötzlich erstaunlich verständlich.",
    benefit: "Für <strong>1 Stunde</strong> erhältst du die Fähigkeit, Beasts zu verstehen und verbal mit ihnen zu kommunizieren. Das Wissen und Bewusstsein vieler Beasts ist durch ihre Intelligence begrenzt, aber sie können dir zumindest Informationen über nahe Orte und Kreaturen geben, einschließlich dessen, was sie kürzlich wahrgenommen haben."
  },
  {
    id: "bears-endurance", name: "Bärenstarkbier — Bear's Endurance", ability: "constitution",
    img: "icons/consumables/drinks/beer-stein-wooden-brown.webp",
    intro: "Ein schweres Gebräu, das den Körper widerstandsfähiger macht und selbst große Anstrengungen leichter wegstecken lässt.",
    benefit: "Für <strong>1 Stunde</strong> hast du <strong>Advantage auf Constitution Checks</strong>. Außerdem erhältst du <strong>2d6 Temporary Hit Points</strong>, die verloren gehen, wenn der Effekt endet.",
    tempHp: true
  },
  {
    id: "bulls-strength", name: "Stierbock — Bull's Strength", ability: "strength",
    img: "icons/consumables/drinks/alcohol-beer-stein-wooden-metal-brown.webp",
    intro: "Ein kräftiges Gebräu, das die Muskeln anspannt und dem Körper für kurze Zeit außergewöhnliche Kraft verleiht.",
    benefit: "Für <strong>1 Stunde</strong> hast du <strong>Advantage auf Strength Checks</strong> und deine <strong>Carrying Capacity</strong> verdoppelt sich.",
    carrying: true
  },
  {
    id: "cats-grace", name: "Katzenschluck — Cat's Grace", ability: "dexterity",
    img: "icons/consumables/potions/bottle-bulb-corked-labeled-blue.webp",
    intro: "Ein leichtes Gebräu, das Bewegungen geschmeidiger werden lässt und selbst einen Fehltritt erstaunlich kontrolliert erscheinen lässt.",
    benefit: "Für <strong>1 Stunde</strong> hast du <strong>Advantage auf Dexterity Checks</strong>. Außerdem erleidest du keinen Damage durch Stürze von <strong>20 feet oder weniger</strong>, solange du nicht Incapacitated bist."
  },
  {
    id: "eagles-splendor", name: "Adlerwein — Eagle's Splendor", ability: "charisma",
    img: "icons/consumables/drinks/wine-amphora-clay-gray.webp",
    intro: "Ein vollmundiges Gebräu, das Selbstsicherheit und Ausstrahlung verstärkt. Worte kommen leichter über die Lippen und die eigene Präsenz scheint den Raum auszufüllen.",
    benefit: "Für <strong>1 Stunde</strong> hast du <strong>Advantage auf Charisma Checks</strong>."
  },
  {
    id: "foxs-cunning", name: "Fuchsgeist — Fox's Cunning", ability: "intelligence",
    img: "icons/consumables/potions/bottle-round-corked-orange.webp",
    intro: "Ein scharfes Gebräu, das die Gedanken ordnet und den Verstand auf Hochtouren bringt. Zusammenhänge werden klarer und selbst komplizierte Probleme erscheinen plötzlich lösbar.",
    benefit: "Für <strong>1 Stunde</strong> hast du <strong>Advantage auf Intelligence Checks</strong>."
  },
  {
    id: "owls-wisdom", name: "Eulentrunk — Owl's Wisdom", ability: "wisdom",
    img: "icons/consumables/potions/bottle-corked-labeled-purple.webp",
    intro: "Ein beruhigendes Gebräu, das die Sinne schärft und dabei hilft, Ablenkungen auszublenden und auf Instinkt und Erfahrung zu vertrauen.",
    benefit: "Für <strong>1 Stunde</strong> hast du <strong>Advantage auf Wisdom Checks</strong>."
  },
  {
    id: "dragon-breath", name: "Drachenatem", durationHours: 1, breath: true,
    img: "icons/consumables/potions/bottle-bulb-corked-glowing-red.webp",
    intro: "Ein feurig-scharfes Gebräu, das den Körper von innen aufheizt und den Atem mit der Hitze eines Drachen erfüllt.",
    benefit: "Für <strong>1 Stunde</strong> kannst du als Bonus Action Feuer in einem <strong>15-foot Cone</strong> speien. Jede Kreatur im Bereich muss einen Dexterity Saving Throw gegen <strong>DC 8 + deinen Proficiency Bonus + deinen Constitution Modifier</strong> ablegen. Bei einem Fehlschlag erleidet sie <strong>3d6 Fire Damage</strong>, bei einem Erfolg halb so viel.<br><br>Nachdem du deinen Drachenatem eingesetzt hast, kannst du ihn erst wieder einsetzen, nachdem du zu Beginn deines Turns eine <strong>5 oder 6 auf einem d6</strong> würfelst."
  },
  {
    id: "iron-stomach", name: "Eisenmagen", durationHours: 8,
    img: "icons/consumables/potions/vial-ornet-silver-black.webp",
    intro: "Ein bitteres Gebräu, das den Körper für mehrere Stunden gegen Gifte abhärtet.",
    benefit: "Für <strong>8 Stunden</strong> hast du Advantage auf Saving Throws gegen Poison. Wenn du einen solchen Saving Throw ablegst, kannst du dich entscheiden, ihn automatisch zu bestehen. Tust du dies, endet der Effekt des Getränks sofort."
  },
  {
    id: "cold-blood", name: "Kaltblut", durationHours: 1,
    img: "icons/consumables/potions/vial-ornet-silver-black.webp",
    intro: "Ein tiefschwarzes Gebräu, das Gefühle abstumpft und den Geist gegenüber Angst und fremden Einflüssen verhärtet.",
    benefit: "Für <strong>1 Stunde</strong> hast du Resistance gegen Psychic Damage und bist immun gegen die Charmed und Frightened Conditions. Während der Wirkung verlierst du jegliches Mitgefühl. Charisma Checks, die an deine bessere Natur appellieren, scheitern automatisch und du handelst nicht selbstlos für andere Kreaturen, sofern du daraus keinen eigenen Vorteil ziehst.",
    changes: [
      { key: "system.traits.damage.resistances.value", type: "add", value: "psychic" },
      { key: "system.traits.condition.immunities.value", type: "add", value: "charmed" },
      { key: "system.traits.condition.immunities.value", type: "add", value: "frightened" }
    ]
  },
  {
    id: "echo-burn", name: "Echobrand", durationHours: 1,
    img: "icons/consumables/potions/flask-corked-blue-glow.webp",
    intro: "Ein scharfes Gebräu, das Gehör und Stimme verändert, bis selbst feinste Echos ein klares Bild der Umgebung zeichnen.",
    benefit: "Für <strong>1 Stunde</strong> kannst du Laute zur Echolocation erzeugen und interpretieren. Du erhältst <strong>Blindsight bis zu 60 feet</strong> und Advantage auf Wisdom (Perception) Checks, die auf deinem Gehör beruhen. Während du Deafened bist, kannst du dieses Blindsight nicht nutzen und es kann Bereiche von Magical Silence nicht durchdringen. Außerdem hast du während der Nutzung Disadvantage auf Dexterity (Stealth) Checks, die darauf beruhen, leise zu sein.",
    changes: [
      { key: "system.traits.senses.types.blindsight", type: "upgrade", value: "60" }
    ]
  },
  {
    id: "kobold-soda", name: "Koboldbrause", durationMinutes: 1, concentration: true,
    img: "icons/consumables/potions/flask-red-bubbles-vortex.webp",
    intro: "Ein stark kohlensäurehaltiges Gebräu, das den Körper mit rastloser Energie erfüllt und schon nach wenigen Augenblicken einen unangenehmen Druck im Magen aufbaut.",
    benefit: "Für bis zu <strong>1 Minute</strong> erhältst du die Effekte von <strong>Haste</strong>. Dieser Effekt erfordert Concentration, als würdest du dich auf einen Spell konzentrieren.<br><br>Wenn deine Concentration endet, übergibst du dich und der Effekt endet. Wenn der Effekt endet, kannst du dich bis zum Ende deines nächsten Turns nicht bewegen und keine Actions ausführen."
  }
];

const drinkRule = "<p><strong>Getränk:</strong> Du kannst dieses Item als Action trinken. Du kannst immer nur von einem magischen Getränke-Buff gleichzeitig profitieren. Trinkst du ein weiteres magisches Getränk, das dir einen Getränke-Buff verleiht, endet der vorherige Getränke-Buff sofort.</p>";

function drinkDescription(drink) {
  return `<p>${drink.intro}</p>${drinkRule}<p>${drink.benefit}</p>`;
}

function drinkEffect(drink, id) {
  const changes = foundry.utils.deepClone(drink.changes ?? []);
  if (drink.ability) changes.push({
    key: "system.modifiers", type: "add", value: JSON.stringify({
      type: "note",
      filter: [{ k: "type", v: "ability-check" }, { k: "ability", v: drink.ability }],
      note: { rollMode: 1, text: `Advantage auf ${drink.ability.capitalize()} Checks durch ${drink.name}.` }
    })
  });
  if (drink.carrying) changes.push({
    key: "system.attributes.encumbrance.multipliers.overall", type: "multiply", value: "2"
  });
  return {
    _id: id, name: drink.name, img: drink.img, description: `<p>${drink.benefit}</p>`,
    changes, disabled: false, transfer: false, duration: { seconds: drinkDurationSeconds(drink) },
    flags: { [MODULE_ID]: { [FLAG]: "magical-drink" } }
  };
}

function drinkDurationSeconds(drink) {
  if (drink.durationMinutes) return drink.durationMinutes * 60;
  return (drink.durationHours ?? 1) * 3600;
}

function drinkActivityDuration(drink) {
  return drink.durationMinutes
    ? { value: String(drink.durationMinutes), unit: "minute", concentration: Boolean(drink.concentration) }
    : { value: String(drink.durationHours ?? 1), unit: "hour", concentration: Boolean(drink.concentration) };
}

function drinkActivity(drink, id, effectId) {
  const common = {
    _id: id, type: drink.tempHp ? "heal" : "utility", name: "Trinken", img: drink.img,
    activation: { type: "action", primary: true },
    duration: drinkActivityDuration(drink),
    consumption: { targets: [{ type: "item", target: "", value: "1" }] }
  };
  common.system = drink.tempHp
    ? {
        effects: [{ _id: effectId }],
        healing: { number: 2, denomination: 6, type: "temp", bonus: "" }
      }
    : {
        effects: [{ _id: effectId }],
        roll: { formula: "", name: "", prompt: false, visible: false }
      };
  return common;
}

function dragonBreathActivity(drink, id) {
  return {
    _id: id, type: "save", name: "Drachenatem", img: drink.img,
    description: "<p><strong>Recharge 5–6:</strong> Nach dem Einsatz würfelst du zu Beginn jedes deiner Turns einen d6. Bei einer 5 oder 6 kannst du den Drachenatem wieder einsetzen.</p>",
    activation: { value: 1, type: "bonus", condition: "Drachenatem ist verfügbar", override: false, primary: false },
    consumption: { targets: [], scale: { allowed: false } },
    duration: { units: "instantaneous", override: false, concentration: false },
    range: { value: "", units: "self", special: "", override: false },
    target: {
      template: { count: "1", contiguous: false, type: "cone", size: "15", width: "", height: "", unit: "foot" },
      affects: { choice: false, count: "", special: "Jede Kreatur im Cone", type: "creature" },
      override: false, prompt: true
    },
    uses: { spent: 0, consumeQuantity: false, recovery: [], min: "", max: "" },
    system: {
      save: {
        ability: ["dexterity"], bonus: "",
        dc: { ability: "custom", formula: "8 + @attributes.proficiency + @abilities.constitution.mod" },
        visible: true
      },
      damage: {
        onSave: "half",
        parts: [{
          number: 3, denomination: 6, bonus: "", custom: { formula: "", enabled: false },
          type: "fire", additionalTypes: [], scaling: { number: 1 }
        }]
      },
      effects: []
    }
  };
}

function drinkItemSource(drink, folderId) {
  const effectId = foundry.utils.randomID();
  const activityId = foundry.utils.randomID();
  const activities = { [activityId]: drinkActivity(drink, activityId, effectId) };
  if (drink.breath) {
    const breathActivityId = foundry.utils.randomID();
    activities[breathActivityId] = dragonBreathActivity(drink, breathActivityId);
  }
  return {
    name: drink.name, type: "consumable", img: drink.img, folder: folderId,
    system: {
      type: { category: "potion", base: "" },
      quantity: 1,
      description: { value: drinkDescription(drink) },
      activities
    },
    effects: [drinkEffect(drink, effectId)],
    flags: { [MODULE_ID]: { [GENERATED_FLAG]: drink.id } }
  };
}

export async function createMagicalDrinkWorldItems({ force = false } = {}) {
  if (!game.user.isGM) return [];
  let folder = game.folders.find(entry => entry.type === "Item" && entry.name === "Magische Getränke");
  folder ??= await Folder.create({ name: "Magische Getränke", type: "Item" });
  const existing = new Set(game.items.map(item => item.getFlag(MODULE_ID, GENERATED_FLAG)).filter(Boolean));
  const sources = DRINKS.filter(drink => force || !existing.has(drink.id))
    .map(drink => drinkItemSource(drink, folder.id));
  const created = sources.length ? await Item.createDocuments(sources) : [];
  if (DRINKS.every(drink => existing.has(drink.id) || created.some(item => item.getFlag(MODULE_ID, GENERATED_FLAG) === drink.id))) {
    await game.settings.set(MODULE_ID, IMPORT_SETTING, true);
  }
  return created;
}

export function effectGroup(effect) {
  for (const scope of [MODULE_ID, LEGACY_MODULE_SCOPE, LEGACY_MODULE_ID]) {
    // Reading raw flag data also supports inactive legacy module scopes.
    // Document#getFlag rejects scopes whose owning module is not active.
    const group = foundry.utils.getProperty(effect, `flags.${scope}.${FLAG}`)
      ?? foundry.utils.getProperty(effect?._source, `flags.${scope}.${FLAG}`);
    if (GROUPS.has(group)) return group;
  }
  return "";
}

async function enforceExclusiveGroup(effect, userId) {
  if (userId && userId !== game.user.id) return;
  const actor = effect?.parent;
  const group = effectGroup(effect);
  if (actor?.documentName !== "Actor" || !group) return;

  const obsolete = actor.effects.filter(other => other.id !== effect.id && effectGroup(other) === group);
  if (obsolete.length) {
    await actor.deleteEmbeddedDocuments("ActiveEffect", obsolete.map(other => other.id));
  }
}

function activeEffectFromApplication(app, context) {
  const candidates = [
    app?.document, app?.object, app?.effect, app?.options?.document,
    context?.document, context?.effect, context?.object
  ];
  return candidates.find(candidate => candidate?.documentName === "ActiveEffect") ?? null;
}

function applicationRoot(app, html) {
  const HTMLElementClass = globalThis.HTMLElement;
  if (HTMLElementClass && html instanceof HTMLElementClass) return html;
  if (HTMLElementClass && html?.[0] instanceof HTMLElementClass) return html[0];
  if (HTMLElementClass && app?.element instanceof HTMLElementClass) return app.element;
  if (HTMLElementClass && app?.element?.[0] instanceof HTMLElementClass) return app.element[0];
  return null;
}

function injectGroupField(app, html, context) {
  const effect = activeEffectFromApplication(app, context);
  if (effect?.documentName !== "ActiveEffect") return;
  const root = applicationRoot(app, html);
  const form = root?.matches?.("form") ? root : root?.querySelector?.("form") ?? root;
  if (!form || form.querySelector("[data-tovf-effect-group]")) return;

  const selected = effectGroup(effect);
  const field = document.createElement("details");
  field.className = "tovf-effect-group-config";
  field.dataset.tovfEffectGroup = "";
  field.innerHTML = `
    <summary>Feuerschwinge-Buffgruppe${selected ? " (aktiv)" : ""}</summary>
    <div class="form-group">
      <label>Exklusive Buffgruppe</label>
      <div class="form-fields">
        <select name="flags.${MODULE_ID}.${FLAG}">
          <option value="">Keine</option>
          <option value="magical-drink"${selected === "magical-drink" ? " selected" : ""}>Magisches Getränk</option>
          <option value="magical-food"${selected === "magical-food" ? " selected" : ""}>Magisches Bufffood</option>
        </select>
      </div>
      <p class="hint">Beim Anwenden endet ein anderer Effekt derselben Buffgruppe automatisch.</p>
    </div>`;

  if (selected) field.open = true;
  const target = form.querySelector(
    '.tab[data-tab="details"]:not(button):not(a), [data-tab="details"].tab-content, .tab-body [data-tab="details"]'
  ) ?? form.querySelector("fieldset")?.parentElement ?? form;
  target.append(field);
}

function scheduleGroupFieldInjection(app, html, context) {
  injectGroupField(app, html, context);
  queueMicrotask(() => injectGroupField(app, html, context));
  requestAnimationFrame(() => injectGroupField(app, app?.element ?? html, context));
  setTimeout(() => injectGroupField(app, app?.element ?? html, context), 100);
}

export function installEffectGroups() {
  if (installed) return;
  installed = true;
  game.settings.register(MODULE_ID, IMPORT_SETTING, {
    scope: "world", config: false, type: Boolean, default: false
  });
  Hooks.on("createActiveEffect", (effect, _options, userId) => {
    void enforceExclusiveGroup(effect, userId).catch(error => {
      console.error(`${MODULE_ID} | Failed to enforce exclusive effect group.`, error);
    });
  });
  Hooks.on("updateActiveEffect", (effect, changes, _options, userId) => {
    const changed = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG}`)
      || Object.hasOwn(changes ?? {}, `flags.${MODULE_ID}.${FLAG}`);
    if (changed) void enforceExclusiveGroup(effect, userId);
  });
  Hooks.on("renderActiveEffectConfig", scheduleGroupFieldInjection);
  Hooks.on("renderActiveEffectConfigV2", scheduleGroupFieldInjection);
  Hooks.on("renderApplicationV2", scheduleGroupFieldInjection);
}

export const effectGroupsApi = {
  groups: Object.freeze({ drink: "magical-drink", food: "magical-food" }),
  get: effectGroup,
  createMagicalDrinkWorldItems
};
