import { MODULE_ID } from "../../core/constants.mjs";
import { getSetting } from "./settings.mjs";

const ECHItems = {};

function temporaryShoveItem(actor, source) {
    const activityId = foundry.utils.randomID();
    const itemData = {
        name: source.name,
        type: "feature",
        img: source.img,
        system: {
            activities: {
                [activityId]: {
                    _id: activityId,
                    type: "tovContest",
                    name: source.name,
                    img: source.img,
                    description: source.system?.description?.value ?? "",
                    activation: { value: null, type: "action", condition: "", override: false, primary: true },
                    consumption: { targets: [], scale: { allowed: false } },
                    duration: { units: "instantaneous", override: false, concentration: false },
                    range: { value: "5", units: "foot", special: "", override: false },
                    target: {
                        template: { count: "1", contiguous: false, type: "", size: "", width: "", height: "", unit: "foot" },
                        affects: { choice: false, count: "1", special: "", type: "creature" },
                        override: false,
                        prompt: false
                    },
                    uses: { spent: 0, consumeQuantity: false, recovery: [], min: "", max: "" },
                    flags: {},
                    magical: false,
                    system: {
                        contest: {
                            attacker: ["skill:athletics"],
                            defender: ["skill:athletics", "skill:acrobatics"],
                            ties: "defender"
                        },
                        damage: { critical: { allow: false, bonus: "" }, parts: [] },
                        effects: []
                    }
                }
            },
            uses: { spent: 0, consumeQuantity: false, recovery: [], min: "", max: "" },
            advancement: {},
            description: { value: source.system?.description?.value ?? "", source: { fallback: MODULE_ID } },
            restriction: { allowMultipleTimes: false, filters: [], items: [], requireAll: true },
            type: { category: "class", value: "" },
            overrides: { proficiency: null },
            identifier: { value: "shove", associated: "" },
            level: { value: null }
        },
        effects: [],
        flags: { [MODULE_ID]: { argonContestedShove: true } }
    };
    return new Item.implementation(itemData, { parent: actor });
}

async function activateShoveContest(actor, source, event) {
    const item = temporaryShoveItem(actor, source);
    const activity = Array.from(item.system.activities ?? [])[0];
    if (!activity) {
        ui.notifications.error(game.i18n.localize("TOV.ContestedActivity.Error.ShoveUnavailable"));
        return false;
    }
    return activity.activate({ event }, { event });
}

async function activateSpecialSkillCheck(actor, skill, event) {
    return actor.rollSkill(
        { skill, event },
        {},
        { data: { speaker: ChatMessage.getSpeaker({ actor }) } }
    );
}

const fallbackLabel = (...values) => values.find((value) => value !== undefined && value !== null && value !== "") ?? "-";

export function getSpellCircleSchoolSubtitle(item) {
    const blackFlagConfig = globalThis.CONFIG?.BlackFlag;
    const circle = item?.system?.circle?.base ?? item?.system?.circle?.value;
    const circleLabels = blackFlagConfig?.spellCircles?.({ dashed: true }) ?? blackFlagConfig?.spellCircles?.() ?? {};
    const circleLabel = fallbackLabel(circleLabels[circle], item?.labels?.level);
    const schoolLabel = fallbackLabel(blackFlagConfig?.spellSchools?.localized?.[item?.system?.school], item?.labels?.school);
    return [circleLabel, schoolLabel].filter((part) => part && part !== "-").join(" ") || "-";
}

export function getSpellTargetLabel(item) {
    const sourceItem = item?.item ?? item;
    return fallbackLabel(
        item?.target?.label,
        item?.target?.affects?.labels?.sheet,
        item?.target?.template?.label,
        item?.system?.target?.label,
        item?.system?.target?.affects?.labels?.sheet,
        item?.system?.target?.template?.label,
        sourceItem?.system?.target?.label,
        sourceItem?.system?.target?.affects?.labels?.sheet,
        sourceItem?.system?.target?.template?.label,
        sourceItem?.labels?.target
    );
}

export function getSpellRangeLabel(item) {
    const sourceItem = item?.item ?? item;
    const range = item?.range ?? item?.system?.range ?? sourceItem?.system?.range;
    const target = item?.target ?? item?.system?.target ?? sourceItem?.system?.target;
    const rangeLabel = fallbackLabel(item?.range?.label, item?.system?.range?.label, sourceItem?.system?.range?.label, sourceItem?.labels?.range);
    const templateLabel = target?.template?.label;
    if (range?.unit === "self" && templateLabel && !String(rangeLabel).includes(String(templateLabel))) {
        return `${rangeLabel} (${templateLabel})`;
    }
    return rangeLabel;
}

const formatSigned = (value) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "number") return value >= 0 ? `+${value}` : `${value}`;
    const text = String(value);
    return /^-/.test(text) || /^\+/.test(text) ? text : `+${text}`;
};

const activityList = (item) => {
    const activities = item?.system?.activities;
    if (!activities) return [];
    return Array.from(typeof activities.values === "function" ? activities.values() : activities);
};

const combatActivityCandidates = (item) => {
    const sourceItem = item?.item ?? item;
    const candidates = [];
    if (item) candidates.push(item);
    for (const activity of activityList(sourceItem)) candidates.push(activity);
    if (sourceItem && sourceItem !== item) candidates.push(sourceItem);
    return candidates;
};


export function isStandardSpellMode(mode) {
    return !mode || mode === "spell" || mode === "standard";
}

export function isSpellPreparedForHud(item) {
    const mode = item?.getFlag?.('black-flag', 'relationship.mode');
    if (["atWill", "innate", "pact"].includes(mode)) return true;
    if (item?.system?.circle?.base == 0) return true;
    if (item?.system?.prepared === undefined) return true;
    return item.system.prepared === true || item.system.prepared > 0;
}

export function getSpellSlotUses(actor, slotKey) {
    const slots = actor?.system?.spellcasting?.slots;
    return slots?.[slotKey] ?? { max: Infinity, value: Infinity };
}

export function getTooltipToHitLabel(item) {
    for (const candidate of combatActivityCandidates(item)) {
        const toHit = fallbackLabel(
            candidate?.labels?.toHit,
            candidate?.toHit,
            formatSigned(candidate?.system?.toHit),
            formatSigned(candidate?.system?.attack?.bonus)
        );
        if (toHit !== "-") return toHit;
    }
    return "-";
}

const normalizeDamageParts = (parts) => parts.map((part) => ({
    formula: part.formula,
    damageType: part.damageType ?? part.type ?? part.types?.[0]
}));

const damagePartsFor = (candidate) => {
    const sourceItem = candidate?.item ?? candidate;
    if (candidate?.labels?.damages?.length) return candidate.labels.damages;

    const parts = [];
    const base = sourceItem?.system?.damage?.base ?? candidate?.system?.damage?.base;
    const includeBase = candidate?.system?.damage?.includeBase;
    if (includeBase && base?.formula) parts.push(base);

    for (const part of candidate?.system?.damage?.parts ?? []) {
        if (part?.formula) parts.push(part);
    }

    return parts;
};

export function getTooltipDamageParts(item) {
    for (const candidate of combatActivityCandidates(item)) {
        const parts = damagePartsFor(candidate);
        if (parts.length) return normalizeDamageParts(parts);
    }
    return [];
}

let explodeItemActivities;
export function setExplodeItemActivities() {
    explodeItemActivities = getSetting("explodeItemActivities");
}

export function initConfig() {
    console.log("[Argon-BF] initConfig started");

    Hooks.on("updateItem", (item) => {
        if(item.parent === ui.ARGON._actor && ui.ARGON.rendered) ui.ARGON.components.portrait.refresh()
    })

    Hooks.on("argonInit", (CoreHUD) => {
        console.log("[Argon-BF] argonInit handler started");
        if (game.system.id !== "black-flag") return console.log("[Argon-BF] Wrong system, exiting. System is:", game.system.id);
        registerItems();
        setExplodeItemActivities();
        const ARGON = CoreHUD.ARGON;

        const installSidePhoenix = (panel, remainingAttempts = 4) => {
            const actionHud = panel.element.closest(".action-hud");
            if (!actionHud) {
                if (remainingAttempts > 0) requestAnimationFrame(() => installSidePhoenix(panel, remainingAttempts - 1));
                return;
            }
            if (actionHud.querySelector(":scope > .tovf-side-phoenix")) return;
            const phoenix = document.createElement("div");
            phoenix.classList.add("tovf-side-phoenix");
            phoenix.setAttribute("aria-hidden", "true");
            actionHud.appendChild(phoenix);
        };

        const addActionOrnaments = (panel) => {
            installSidePhoenix(panel);
        };

        class DND5eTooltip extends ARGON.CORE.Tooltip {
            get classes() {
                const original = super.classes;
                return original.concat(["blackflag"]);
            }
        }

        const isMIDI = game.modules.get("midi-qol")?.active;
        const getMidiFlag = (actionType) => {
            if (!isMIDI || !ui.ARGON._actor) return null;
            const flag = ui.ARGON._actor.getFlag("midi-qol", "actions") ?? {};
            const value = flag[actionType] ?? false;
            const midiAction = value ? 0 : 1;
            return midiAction;
        };

        function expandItemIntoActivities(item) {
            if(explodeItemActivities === "never") return false;
            if(explodeItemActivities === "always") return true;
            if(explodeItemActivities === "only-weapons") return item.type === "weapon";
        }

        function expandActivities(itemList, activationType) {
            const items = [];
            const activities = []
            for(const item of itemList) {
                if(expandItemIntoActivities(item)) {
                    activities.push(Array.from(item.system.activities).filter(activity => checkActivationType(activity, activationType) && activity.type !== "cast"));
                } else {
                    items.push(item);
                }
            }
            const allElements = [...items, ...(activities.flat())];
            const weapons = allElements.filter(item => (item.item ?? item).type === "weapon");
            const nonWeapons = allElements.filter(item => (item.item ?? item).type !== "weapon");
            return [...weapons, ...nonWeapons];
        }

        const checkActivationType = (itemOrActivity, activationTypes) => {
            if (itemOrActivity.activation?.type) return activationTypes.includes(itemOrActivity.activation.type);
            if (!itemOrActivity?.system?.activities) {
                return;
            }
            for (const activity of Array.from(itemOrActivity.system.activities)) {
                if(activationTypes.includes(activity.activation?.type)) return true;
            }
        }

        const getActivationType = (item) => {
            const activities = Array.from(item?.system?.activities ?? []);
            const primaryActivity = activities.find((activity) => activity.activation?.primary) ?? activities[0];
            return primaryActivity?.activation?.type ?? item?.system?.casting?.type;
        };

        const getActionType = (item) => {
            if (!item?.system?.activities?.size) {
                return;
            }
            return Array.from(item.system.activities)[0]?.actionType;
        };

        const actionTypes = {
            action: ["action"],
            bonus: ["bonus"],
            reaction: ["reaction", "reactiondamage", "reactionmanual"],
            free: ["special"],
        };

        const itemTypes = {
            spell: ["spell"],
            feature: ["feature", "talent"],
            consumable: ["consumable", "gear", "sundry", "container", "tool"],
        };

        const mainBarFeatures = [];

        if (game.settings.get(MODULE_ID, "showWeaponsItems")) itemTypes.consumable.unshift("weapon");
        if (game.settings.get(MODULE_ID, "showClassActions")) mainBarFeatures.push("class");

        CoreHUD.BlackFlag = {
            actionTypes,
            itemTypes,
            mainBarFeatures,
            ECHItems,
        };

        Hooks.callAll("enhanced-combat-hud.blackflag.initConfig", { actionTypes, itemTypes, ECHItems });

        async function getTooltipDetails(item, type, { name } = {}) {
            const sourceItem = item?.item ?? item;
            let title, description, itemType, subtitle, target, range, dt;
            let damageTypes = [];
            let properties = [];
            let materialComponents = "";

            if (type == "skill") {
                title = CONFIG.BlackFlag.skills.localized[item];
                const key = `enhancedcombathud-black-flag.skills.${item}.tooltip`;
                description = game.i18n.has(key) ? game.i18n.localize(key) : "";
            } else if (type == "save") {
                title = CONFIG.BlackFlag.abilities.localized[item];
                const key = `enhancedcombathud-black-flag.abilities.${item}.tooltip`;
                description = game.i18n.has(key) ? game.i18n.localize(key) : "";
            } else {
                if (!sourceItem || !sourceItem.system) return;

                title = name ?? item.name ?? sourceItem.name;
                description = sourceItem.system.identified ? sourceItem.system.description.value : sourceItem.system.description.unidentified ?? sourceItem.system.description.value;
                itemType = sourceItem.type;
                target = itemType === "spell" ? getSpellTargetLabel(item) : (item.target?.label || sourceItem.labels?.target || "-");
                range = itemType === "spell" ? getSpellRangeLabel(item) : (item.range?.label || sourceItem.labels?.range || "-");
                properties = [];
                let property;
                dt = getTooltipDamageParts(item).map(d => d.damageType);
                damageTypes = dt && dt.length ? dt : [];
                materialComponents = "";

                switch (itemType) {
                    case "weapon":
                        subtitle = CONFIG.BlackFlag.weaponTypes.localized[sourceItem.system.type?.value];
                        property = game.i18n.localize(`BF.ACTIVITY.Type.${getActionType(item)}`);
                        if (property) properties.push(property);
                        for (const propName of sourceItem.system.properties) {
                            let prop = CONFIG.BlackFlag.weaponProperties.includes(propName) ? game.i18n.localize(`BF.WEAPON.Property.${propName}`) : undefined;
                            if (prop) properties.push(prop);
                        }
                        break;
                    case "spell":
                        subtitle = getSpellCircleSchoolSubtitle(sourceItem);
                        properties.push(CONFIG.BlackFlag.spellSchools.localized[sourceItem.system.school]);
                        if (sourceItem.labels?.duration) properties.push(sourceItem.labels.duration);
                        if (sourceItem.labels?.save) properties.push(sourceItem.labels.save);
                        for (let comp of (sourceItem.labels?.components?.all ?? [])) {
                            properties.push(comp.abbr);
                        }
                        if (sourceItem.labels?.materials) materialComponents = sourceItem.labels.materials;
                        break;
                    case "consumable":
                        subtitle = CONFIG.BlackFlag.consumableCategories.localized[sourceItem.system.type?.base];
                        {
                            const actionType = getActionType(item);
                            if (actionType) {
                                const key = `BF.ACTIVITY.Type.${actionType}`;
                                property = game.i18n.has(key) ? game.i18n.localize(key) : actionType;
                            }
                        }
                        if (property) properties.push(property);
                        break;
                    case "feature":
                        subtitle = null;
                        {
                            const actionType = getActionType(item);
                            if (actionType) {
                                const key = `BF.ACTIVITY.Type.${actionType}`;
                                property = game.i18n.has(key) ? game.i18n.localize(key) : actionType;
                            }
                        }
                        if (property) properties.push(property);
                        break;
                }
            }

            if (description) description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(description, { async: true, relativeTo: sourceItem });
            let details = [];
            if (target || range) {
                details = [
                    {
                        label: "enhancedcombathud-black-flag.tooltip.target.name",
                        value: target,
                    },
                    {
                        label: "enhancedcombathud-black-flag.tooltip.range.name",
                        value: range,
                    },
                ];
            }
            const toHit = getTooltipToHitLabel(item);
            if (toHit !== "-") {
                details.push({
                    label: "enhancedcombathud-black-flag.tooltip.toHit.name",
                    value: toHit,
                });
            }
            const damages = getTooltipDamageParts(item);
            if (damages.length) {
                let dmgString = "";
                damages.forEach((dDmg) => {
                    dmgString += dDmg.formula + " " + getDamageTypeIcon(dDmg.damageType) + " ";
                });
                details.push({
                    label: "enhancedcombathud-black-flag.tooltip.damage.name",
                    value: dmgString,
                });
            }

            const tooltipProperties = [];
            if (damageTypes?.length) damageTypes.forEach((d) => tooltipProperties.push({ label: d, primary: true }));
            if (properties?.length) properties.forEach((p) => tooltipProperties.push({ label: p?.label ?? p, secondary: true }));
            return { title, description, subtitle, details, properties: tooltipProperties, footerText: materialComponents };
        }

        function getDamageTypeIcon(damageType) {
            damageType ??= "";
            switch (damageType.toLowerCase()) {
                case "acid":
                    return '<i class="fas fa-flask"></i>';
                case "bludgeoning":
                    return '<i class="fas fa-hammer"></i>';
                case "cold":
                    return '<i class="fas fa-snowflake"></i>';
                case "fire":
                    return '<i class="fas fa-fire"></i>';
                case "force":
                    return '<i class="fas fa-hand-sparkles"></i>';
                case "lightning":
                    return '<i class="fas fa-bolt"></i>';
                case "necrotic":
                    return '<i class="fas fa-skull"></i>';
                case "piercing":
                    return '<i class="fas fa-crosshairs"></i>';
                case "poison":
                    return '<i class="fas fa-skull-crossbones"></i>';
                case "psychic":
                    return '<i class="fas fa-brain"></i>';
                case "radiant":
                    return '<i class="fas fa-sun"></i>';
                case "slashing":
                    return '<i class="fas fa-cut"></i>';
                case "thunder":
                    return '<i class="fas fa-bell"></i>';
                case "healing":
                    return '<i class="fas fa-heart"></i>';
                default:
                    return '<i class="fas fa-sparkles"></i>';
            }
        }

        function getProficiencyIcon(proficiency) {
            if (proficiency == 0) return '<i style="margin-right: 1ch; pointer-events: none" class="fa-regular fa-circle"> </i>';
            else if (proficiency == 1) return '<i style="margin-right: 1ch; pointer-events: none" class="fa-solid fa-check"> </i>';
            else if (proficiency == 2) return '<i style="margin-right: 1ch; pointer-events: none" class="fa-solid fa-check-double"> </i>';
            else if (proficiency == 0.5) return '<i style="margin-right: 1ch; pointer-events: none" class="fa-solid fa-circle-half-stroke"> </i>';
            else return '<i style="margin-right: 1ch; pointer-events: none" class="fa-regular fa-circle"> </i>';
        }

        function condenseItemButtons(items) {
            const condenseClassActions = game.settings.get(MODULE_ID, "condenseClassActions");
            if (!condenseClassActions) return items.map((item) => new DND5eItemButton({ item, inActionPanel: true }));
            const condensedItems = [];
            const barItemsLength = items.length;
            const barItemsMultipleOfTwo = barItemsLength - (barItemsLength % 2);
            let currentSplitButtonItemButton = null;
            for (let i = 0; i < barItemsLength; i++) {
                const isCondensedButton = i < barItemsMultipleOfTwo;
                const item = items[i];
                if (isCondensedButton) {
                    if (currentSplitButtonItemButton) {
                        const button = new DND5eItemButton({ item, inActionPanel: false });
                        condensedItems.push(new ARGON.MAIN.BUTTONS.SplitButton(currentSplitButtonItemButton, button));
                        currentSplitButtonItemButton = null;
                    } else {
                        currentSplitButtonItemButton = new DND5eItemButton({ item, inActionPanel: false });
                    }
                } else {
                    condensedItems.push(new DND5eItemButton({ item, inActionPanel: true }));
                }
            }
            return condensedItems;
        }

        class DND5ePortraitPanel extends ARGON.PORTRAIT.PortraitPanel {
            constructor(...args) {
                console.log("[Argon-BF] Portrait constructor, actor type:", args[0]?.actor?.type || "unknown");
                super(...args);
            }

            get description() {
                const { type, system } = this.actor;
                const actor = this.actor;
                const isNPC = type === "npc";
                const isPC = type === "pc";
                if (isNPC) {
                    const traitsType = actor.system.traits?.type;
                    const typeValue = traitsType?.value;
                    const typeLabel = (typeValue && CONFIG.BlackFlag.creatureTypes?.[typeValue]?.label) || traitsType?.custom || typeValue || "Creature";
                    const creatureType = typeof typeLabel === "string" ? typeLabel : "Creature";
                    const cr = system.attributes.cr >= 1 || system.attributes.cr <= 0 ? system.attributes.cr : `1/${1 / system.attributes.cr}`;
                    return `CR ${cr} ${creatureType}`;
                } else if (isPC) {
                    const classes = Object.values(actor.system.progression?.classes ?? {})
                        .map((c) => c.document?.name ?? c.name ?? "")
                        .join(" / ");
                    const level = Number(system.progression?.level) || 0;
                    const classLabel = Object.values(actor.system.progression?.classes ?? {})
                        .map((c) => `${c.document?.name ?? c.name ?? ""} ${Number(c.levels) || 0}`.trim())
                        .filter(Boolean)
                        .join(" / ");
                    return `${game.i18n.format("TOVF.Argon.CharacterLevel", { level })} ${classLabel}`.trim();
                } else {
                    return "";
                }
            }

            async render(...args) {
                const rendered = await super.render(...args);
                const dcLabel = this.element.querySelector("#tovf-spell-dc-label");
                if (dcLabel) {
                    dcLabel.dataset.tooltip = "Spell DC";
                    dcLabel.setAttribute("aria-label", "Spell DC");
                    dcLabel.title = "Spell DC";
                }
                if (this.actor.type !== "pc") return rendered;

                const detail = this.element.querySelector(".player-detail");
                if (!detail) return rendered;

                const level = Number(this.actor.system.progression?.level) || 0;
                const classLabel = Object.values(this.actor.system.progression?.classes ?? {})
                    .map((entry) => `${entry.document?.name ?? entry.name ?? ""} ${Number(entry.levels) || 0}`.trim())
                    .filter(Boolean)
                    .join(" / ");
                const levelElement = document.createElement("span");
                levelElement.classList.add("tovf-character-level");
                levelElement.textContent = game.i18n.format("TOVF.Argon.CharacterLevel", { level });
                const classesElement = document.createElement("span");
                classesElement.classList.add("tovf-character-classes");
                classesElement.textContent = classLabel;

                detail.classList.add("tovf-player-progression");
                detail.replaceChildren(levelElement, classesElement);
                return rendered;
            }

            get isDead() {
                return this.isDying && this.actor.type !== "pc";
            }

            get isDying() {
                return this.actor.system.attributes.hp.value <= 0;
            }

            get successes() {
                return this.actor.system.attributes?.death?.success ?? 0;
            }

            get failures() {
                return this.actor.system.attributes?.death?.failure ?? 0;
            }

            get configurationTemplate() {
                return `modules/${MODULE_ID}/templates/argon-actor-config.hbs`;
            }

            async _onDeathSave(event) {
                this.actor.rollDeathSave({});
            }

            async _getButtons() {
                return (await super._getButtons()).filter((button) => button.id === "toggle-minimize");
            }

            async getStatBlocks() { console.log("[BF] Portrait.getStatBlocks");
                const HPText = "Hit Points"
                    .split(" ")
                    .map((word) => word.charAt(0).toUpperCase())
                    .join("");
                const ACText = "Armor Class"
                    .split(" ")
                    .map((word) => word.charAt(0).toUpperCase())
                    .join("");
                const SpellDC = "DC";
                const configuredSpellDC = Number(this.actor.system.spellcasting?.dc);
                const classes = Object.values(this.actor.system.progression?.classes ?? {});
                const mainClass = classes.find((entry) => entry.originalClass) ?? classes[0];
                const keyAbility = mainClass?.document?.system?.keyAbility;
                const keyAbilityDC = Number(this.actor.system.abilities?.[keyAbility]?.dc);
                const highestAbilityDC = Math.max(
                    ...Object.values(this.actor.system.abilities ?? {}).map((ability) => Number(ability.dc) || 0),
                );
                const displayedDC = configuredSpellDC > 0
                    ? configuredSpellDC
                    : keyAbilityDC > 0
                        ? keyAbilityDC
                        : highestAbilityDC;

                const hpColor = this.actor.system.attributes.hp.temp ? "#6698f3" : "rgb(0 255 170)";
                const tempMax = this.actor.system.attributes.hp.tempmax;
                const hpMaxColor = tempMax ? (tempMax > 0 ? "rgb(222 91 255)" : "#ffb000") : "rgb(255 255 255)";

                return [
                    [
                        {
                            text: `${this.actor.system.attributes.hp.value + (this.actor.system.attributes.hp.temp ?? 0)}`,
                            color: hpColor,
                        },
                        {
                            text: `/`,
                        },
                        {
                            text: `${this.actor.system.attributes.hp.max + (this.actor.system.attributes.hp.tempmax ?? 0)}`,
                            color: hpMaxColor,
                        },
                        {
                            text: HPText,
                        },
                    ],
                    [
                        {
                            text: ACText,
                        },
                        {
                            text: this.actor.system.attributes.ac.value,
                            color: "var(--ech-movement-baseMovement-background)",
                        },
                    ],
                    [
                        {
                            text: SpellDC,
                            id: "tovf-spell-dc-label",
                        },
                        {
                            text: displayedDC,
                            color: "var(--ech-movement-baseMovement-background)",
                        },
                    ],
                ];
            }
        }

        class DND5eDrawerButton extends ARGON.DRAWER.DrawerButton {
            constructor(buttons, item, type) {
                super(buttons);
                this.item = item;
                this.type = type;
            }

            get hasTooltip() {
                return true;
            }

            async getTooltipData() {
                const tooltipData = await getTooltipDetails(this.item, this.type);
                return tooltipData;
            }
        }

        class DND5eDrawerPanel extends ARGON.DRAWER.DrawerPanel {
            constructor(...args) {
                super(...args);
            }

            get categories() {
                const abilities = this.actor.system.abilities;
                const skills = this.actor.system.proficiencies?.skills ?? {};
                const tools = this.actor.system.proficiencies?.tools ?? {};

                const addSign = (value) => {
                    if (value >= 0) return `+${value}`;
                    return value;
                };

                const abilitiesButtons = Object.keys(abilities).map((ability) => {
                    const abilityData = abilities[ability];
                    return new DND5eDrawerButton(
                        [
                            {
                                label: CONFIG.BlackFlag.abilities.localized[ability],
                                onClick: (event) => this.actor.rollAbilityCheck({ ability, event }),
                            },
                            {
                                label: addSign(abilityData.mod + (abilityData.checkBonus || 0)),
                                onClick: (event) => this.actor.rollAbilityCheck({ ability, event }),
                            },
                            {
                                label: addSign(abilityData.mod + (abilityData.save?.proficiency?.flat ?? 0)),
                                onClick: (event) => this.actor.rollSavingThrow({ ability, event }),
                            },
                        ],
                        ability,
                        "save",
                    );
                });

                const skillsButtons = Object.keys(skills).map((skill) => {
                    const skillData = skills[skill];
                    return new DND5eDrawerButton(
                        [
                            {
                                label: getProficiencyIcon(skillData.proficiency.multiplier) + CONFIG.BlackFlag.skills.localized[skill],
                                onClick: (event) => this.actor.rollSkill({ skill, event }),
                            },
                            {
                                label: `${addSign(skillData.mod)}<span style="margin: 0 1rem; filter: brightness(0.8)">(${skillData.passive ?? 0})</span>`,
                                style: "display: flex; justify-content: flex-end;",
                            },
                        ],
                        skill,
                        "skill",
                    );
                });

                function getToolLabel(key) {
                    // Black Flag uses tools/toolTypes configs — check safely
                    const toolCfg = CONFIG.BlackFlag.tools;
                    if (toolCfg && key in toolCfg) {
                        const item = toolCfg[key];
                        if (typeof item == "string") {
                            const name = fromUuidSync(item)?.name;
                            if (name) return name;
                            return item;
                        }
                        const name = fromUuidSync(item?.id)?.name;
                        if (name) return name;
                        return item?.label ? game.i18n.localize(item.label) : key;
                    }
                    // Check toolTypes if available
                    const toolTypes = CONFIG.BlackFlag.toolTypes;
                    if (toolTypes && key in toolTypes) {
                        return game.i18n.localize(toolTypes[key]?.label ?? key);
                    }
                    return key.charAt(0).toUpperCase() + key.slice(1);
                }

                const toolButtons = Object.entries(tools).map(([key, tool]) => {
                    return new DND5eDrawerButton(
                        [
                            {
                                label: getProficiencyIcon(tool.proficiency.multiplier) + getToolLabel(key, tool),
                                onClick: (event) => this.actor.rollTool({tool: key})
                            },
                            {
                                label: addSign(tool.mod + tool.proficiency.multiplier * this.actor.system.attributes.proficiency),
                            },
                        ],
                        tool,
                    );
                });

                return [
                    {
                        gridCols: "5fr 2fr 2fr",
                        captions: [
                            {
                                label: "Abilities",
                                align: "left",
                            },
                            {
                                label: "Check",
                                align: "center",
                            },
                            {
                                label: "Save",
                                align: "center",
                            },
                        ],
                        align: ["left", "center", "center"],
                        buttons: abilitiesButtons,
                    },
                    {
                        gridCols: "7fr 2fr",
                        captions: [
                            {
                                label: "Skills",
                            },
                            {
                                label: "",
                            },
                        ],
                        buttons: skillsButtons,
                    },
                    {
                        gridCols: "7fr 2fr",
                        captions: [
                            {
                                label: game.i18n.localize("enhancedcombathud-black-flag.hud.tools.name"),
                            },
                            {
                                label: "",
                            },
                        ],
                        buttons: toolButtons,
                    },
                ];
            }

            get title() {
                return `${game.i18n.localize("enhancedcombathud-black-flag.hud.saves.name")} / ${game.i18n.localize("enhancedcombathud-black-flag.hud.skills.name")} / ${game.i18n.localize("enhancedcombathud-black-flag.hud.tools.name")}`;
            }
        }

        class DND5eActionActionPanel extends ARGON.MAIN.ActionPanel {
            constructor(...args) {
                super(...args);
            }

            get label() {
                return "Action";
            }

            get maxActions() {
                return this.actor?.inCombat ? 1 : null;
            }

            get currentActions() {
                return getMidiFlag("action") ?? (this.isActionUsed ? 0 : 1);
            }

            async _renderInner() {
                await super._renderInner();
                addActionOrnaments(this);
            }

            _onNewRound(combat) {
                this.isActionUsed = false;
                this.updateActionUse();
            }

            async _getButtons() {
                const spellItems = this.actor.items.filter((item) => itemTypes.spell.includes(item.type) && actionTypes.action.includes(getActivationType(item)) && !CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value));
                const featureItems = expandActivities(this.actor.items.filter((item) => itemTypes.feature.includes(item.type) && checkActivationType(item, actionTypes.action) && !CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value)), actionTypes.action);
                const consumableItems = expandActivities(this.actor.items.filter((item) => itemTypes.consumable.includes(item.type) && checkActivationType(item, actionTypes.action) && !CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value)), actionTypes.action);

                const spellButton = !spellItems.length ? [] : [new DND5eButtonPanelButton({ type: "spell", items: spellItems, color: 0 })].filter((button) => button.hasContents);

                const specialActions = Object.values(ECHItems);

                const showSpecialActions = game.settings.get(MODULE_ID, "showSpecialActions");
                const buttons = [];
                if (showSpecialActions) {
                    buttons.push(...[new DND5eItemButton({ item: null, isWeaponSet: true, isPrimary: true }), new ARGON.MAIN.BUTTONS.SplitButton(new DND5eSpecialActionButton(specialActions[0]), new DND5eSpecialActionButton(specialActions[1])), ...spellButton, new DND5eButtonPanelButton({ type: "feature", items: featureItems, color: 0 }), new ARGON.MAIN.BUTTONS.SplitButton(new DND5eSpecialActionButton(specialActions[2]), new DND5eSpecialActionButton(specialActions[3])), new ARGON.MAIN.BUTTONS.SplitButton(new DND5eSpecialActionButton(specialActions[4]), new DND5eSpecialActionButton(specialActions[5])), new DND5eButtonPanelButton({ type: "consumable", items: consumableItems, color: 0 })]);
                } else {
                    buttons.push(...[new DND5eItemButton({ item: null, isWeaponSet: true, isPrimary: true }), ...spellButton, new DND5eButtonPanelButton({ type: "feature", items: featureItems, color: 0 }), new DND5eButtonPanelButton({ type: "consumable", items: consumableItems, color: 0 })]);
                }

                const barItems = this.actor.items.filter((item) => CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value) && checkActivationType(item, actionTypes.action));
                buttons.push(...condenseItemButtons(barItems));

                return buttons.filter((button) => button.hasContents || button.items == undefined || button.items.length);
            }
        }

        class DND5eBonusActionPanel extends ARGON.MAIN.ActionPanel {
            constructor(...args) {
                super(...args);
            }

            get label() {
                return "Bonus Action";
            }

            get maxActions() {
                return this.actor?.inCombat ? 1 : null;
            }

            get currentActions() {
                return getMidiFlag("bonus") ?? (this.isActionUsed ? 0 : 1);
            }

            async _renderInner() {
                await super._renderInner();
                addActionOrnaments(this);
            }

            _onNewRound(combat) {
                this.isActionUsed = false;
                this.updateActionUse();
            }

            async _getButtons() {
                const buttons = [new DND5eItemButton({ item: null, isWeaponSet: true, isPrimary: false })];
                for (const [type, types] of Object.entries(itemTypes)) {
                    const items = this.actor.items.filter((item) => types.includes(item.type) && checkActivationType(item, actionTypes.bonus) && !CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value));
                    if (!items.length) continue;
                    if (type === "spell") {
                        const itemsWithCorrectActionTypeAsMainActivity = items.filter(item => actionTypes.bonus.includes(getActivationType(item)));
                        const button = new DND5eButtonPanelButton({ type, items: itemsWithCorrectActionTypeAsMainActivity, color: 1 });
                        if (button.hasContents) buttons.push(button);
                        continue;
                    }
                    // const activities = items.map(item => Array.from(item.system.activities)).flat().filter(activity => checkActivationType(activity, actionTypes.bonus));
                    const itemsAndActivities = expandActivities(items, actionTypes.bonus);
                    if (!itemsAndActivities.length) continue;
                    const button = new DND5eButtonPanelButton({ type, items: itemsAndActivities, color: 1 });
                    if (button.hasContents) buttons.push(button);
                }

                const barItems = this.actor.items.filter((item) => CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value) && checkActivationType(item, actionTypes.bonus));
                buttons.push(...condenseItemButtons(barItems));

                return buttons;
            }
        }

        class DND5eReactionActionPanel extends ARGON.MAIN.ActionPanel {
            constructor(...args) {
                super(...args);
            }

            get label() {
                return "Reaction";
            }

            get maxActions() {
                return this.actor?.inCombat ? 1 : null;
            }

            get currentActions() {
                return getMidiFlag("reaction") ?? (this.isActionUsed ? 0 : 1);
            }

            async _renderInner() {
                await super._renderInner();
                addActionOrnaments(this);
            }

            _onNewRound(combat) {
                this.isActionUsed = false;
                this.updateActionUse();
            }

            async _getButtons() {
                const buttons = [new DND5eItemButton({ item: null, isWeaponSet: true, isPrimary: true })];
                //buttons.push(new DND5eEquipmentButton({slot: 1}));
                for (const [type, types] of Object.entries(itemTypes)) {
                    const items = this.actor.items.filter((item) => types.includes(item.type) && checkActivationType(item, actionTypes.reaction) && !CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value));
                    if (!items.length) continue;
                    if (type === "spell") {
                        const itemsWithCorrectActionTypeAsMainActivity = items.filter(item => actionTypes.reaction.includes(getActivationType(item)));
                        const button = new DND5eButtonPanelButton({ type, items: itemsWithCorrectActionTypeAsMainActivity, color: 1 });
                        if (button.hasContents) buttons.push(button);
                        continue;
                    }
                    // const activities = items.map(item => Array.from(item.system.activities)).flat().filter(activity => checkActivationType(activity, actionTypes.reaction));
                    const itemsAndActivities = expandActivities(items, actionTypes.reaction);
                    if (!itemsAndActivities.length) continue;
                    const button = new DND5eButtonPanelButton({ type, items: itemsAndActivities, color: 3 });
                    if (button.hasContents) buttons.push(button);
                }

                const barItems = this.actor.items.filter((item) => CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value) && checkActivationType(item, actionTypes.reaction));
                buttons.push(...condenseItemButtons(barItems));

                return buttons;
            }
        }

        class DND5eFreeActionPanel extends ARGON.MAIN.ActionPanel {
            constructor(...args) {
                super(...args);
            }

            get label() {
                return "Free Action";
            }

            get maxActions() {
                return this.actor?.inCombat ? 1 : null;
            }

            get currentActions() {
                return this.isActionUsed ? 0 : 1;
            }

            _onNewRound(combat) {
                this.isActionUsed = false;
                this.updateActionUse();
            }

            async _getButtons() {
                const buttons = [];

                for (const [type, types] of Object.entries(itemTypes)) {
                    const items = this.actor.items.filter((item) => types.includes(item.type) && checkActivationType(item, actionTypes.free) && !CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value));
                    if (!items.length) continue;
                    if (type === "spell") {
                        const itemsWithCorrectActionTypeAsMainActivity = items.filter(item => actionTypes.free.includes(getActivationType(item)));
                        const button = new DND5eButtonPanelButton({ type, items: itemsWithCorrectActionTypeAsMainActivity, color: 1 });
                        if (button.hasContents) buttons.push(button);
                        continue;
                    }
                    // const activities = items.map(item => Array.from(item.system.activities)).flat().filter(activity => checkActivationType(activity, actionTypes.free));
                    const itemsAndActivities = expandActivities(items, actionTypes.free);
                    if (!itemsAndActivities.length) continue;
                    const button = new DND5eButtonPanelButton({ type, items: itemsAndActivities, color: 2 });
                    if (button.hasContents) buttons.push(button);
                }

                const barItems = this.actor.items.filter((item) => CoreHUD.BlackFlag.mainBarFeatures.includes(item.system.type?.value) && checkActivationType(item, actionTypes.free));
                buttons.push(...condenseItemButtons(barItems));

                return buttons;
            }
        }

        class DND5eLegActionPanel extends ARGON.MAIN.ActionPanel {
            constructor(...args) {
                super(...args);
            }

            get label() {
                return "Legendary Action";
            }

            get maxActions() {
                return this.actor?.inCombat ? this.actor.system.attributes?.legendary?.max ?? null : null;
            }

            get currentActions() {
                return this.actor.system.attributes?.legendary?.value ?? null;
            }

            async _getButtons() {
                const buttons = [];
                const legendary = this.actor.items.filter((item) => getActivationType(item) === "legendary");
                legendary.forEach((item) => {
                    buttons.push(new DND5eItemButton({ item, inActionPanel: true }));
                });
                return buttons;
            }
        }

        class DND5eLairActionPanel extends ARGON.MAIN.ActionPanel {
            constructor(...args) {
                super(...args);
            }

            get label() {
                return "Lair Action";
            }

            get maxActions() {
                return this.actor?.inCombat ? 1 : null;
            }

            get currentActions() {
                return this.actor.system.attributes?.lair?.value ?? 0 * 1;
            }

            async _getButtons() {
                const buttons = [];
                const lair = this.actor.items.filter((item) => getActivationType(item) === "lair");
                lair.forEach((item) => {
                    buttons.push(new DND5eItemButton({ item, inActionPanel: true }));
                });
                return buttons;
            }
        }

        class DND5eMythicActionPanel extends ARGON.MAIN.ActionPanel {
            constructor(...args) {
                super(...args);
            }

            get label() {
                return "Legendary Action";
            }

            get maxActions() {
                return null; //this.actor?.inCombat ? 1 : null;
            }

            get currentActions() {
                return null; //this.actor.system.resources.mythic?.value * 1;
            }

            async _getButtons() {
                const buttons = [];
                const mythic = this.actor.items.filter((item) => getActivationType(item) === "mythic");
                mythic.forEach((item) => {
                    buttons.push(new DND5eItemButton({ item, inActionPanel: true }));
                });
                return buttons;
            }
        }

        class DND5eItemButton extends ARGON.MAIN.BUTTONS.ItemButton {
            constructor(...args) {
                super(...args);
            }

            get item() {
                return this._item?.item ?? this._item;
            }

            get isActivity() {
                return !this._item?.system?.activities;
            }

            get activity() {
                if (this.isActivity) return this._item;
                return Array.from(this._item.system.activities)[0];
            }

            get hasTooltip() {
                return true;
            }

            get useTargetPicker() {
                return false;
            }

            get ranges() {
                const activity = this.activity;
                const rangeUnit = activity?.range?.unit ?? activity?.range?.units;
                const touchRange = rangeUnit == "touch" ? canvas?.scene?.grid?.distance : null;
                return {
                    normal: activity?.range?.value ?? activity?.range?.short ?? touchRange,
                    long: activity?.range?.long ?? null,
                };
            }

            get label() {
                if(!this.isActivity) return super.label;
                return this.activity.name + ` (${this.item.name})`;
            }

            get targets() {
                const activity = this.activity;
                const validTargets = ["creature", "ally", "enemy"];
                const actionType = activity.actionType;
                const affects = activity.target?.affects ?? {};
                const targetType = affects.type;
                const templateUnit = activity.target?.template?.unit ?? activity.target?.template?.units;
                if (!templateUnit && validTargets.includes(targetType)) {
                    return affects.count ?? 1;
                } else if (validTargets.includes(targetType) && affects.count) {
                    return affects.count;
                } else if (actionType === "mwak" || actionType === "rwak" || actionType === "msak" || actionType === "rsak") {
                    return affects.count || 1;
                }
                return null;
            }

            get visible() {
                if (!this._isWeaponSet) return super.visible;
                const isReaction = this.parent instanceof DND5eReactionActionPanel;
                const isMelee = this.activity?.actionType === "mwak";
                if (isReaction && !isMelee) return false;
                if (this._isPrimary) return super.visible;
                if (this.activity?.type?.value === "shield") return false;
                return super.visible;
            }

            async getTooltipData() {
                const tooltipData = this.isActivity ? await getTooltipDetails(this.activity, undefined, { name: this.label }) : await getTooltipDetails(this.item);
                tooltipData.propertiesLabel = "enhancedcombathud-black-flag.tooltip.properties.name";
                return tooltipData;
            }

            async _onLeftClick(event) {
                const activity = this.activity;
                const used = await activity?.activate?.({ event, legacy: false }, { event });
                if (used) {
                    DND5eItemButton.consumeActionEconomy(activity);
                    const useOtherItem = activity?.consumption?.targets?.find(t => t.type === "itemUses");
                    if (useOtherItem) {
                        const otherItem = this.actor.items.get(useOtherItem.target);
                        const allConnectedItems = this.actor.items.filter(i => i.system.activities?.find(a => a.consumption?.targets?.find(t => t.type === "itemUses" && t.target === otherItem.id)));
                        ui.ARGON.updateItemButtons(allConnectedItems);
                    }
                    this.render(true)
                }
            }

            async _onRightClick(event) {
                if(!this.isActivity) return this.item?.sheet?.render(true);
                this.activity?.sheet?.render(true);
            }

            static consumeActionEconomy(activity) {
                const activationType = activity?.activation?.type;
                let actionType = null;
                for (const [type, types] of Object.entries(actionTypes)) {
                    if (types.includes(activationType)) actionType = type;
                }
                if (!actionType) return;
                if (game.combat?.combatant?.actor !== activity.item.parent) actionType = "reaction";
                if (actionType === "action") {
                    ui.ARGON.components.main[0].isActionUsed = true;
                    ui.ARGON.components.main[0].updateActionUse();
                } else if (actionType === "bonus") {
                    ui.ARGON.components.main[1].isActionUsed = true;
                    ui.ARGON.components.main[1].updateActionUse();
                } else if (actionType === "reaction") {
                    ui.ARGON.components.main[2].isActionUsed = true;
                    ui.ARGON.components.main[2].updateActionUse();
                } else if (actionType === "free") {
                    ui.ARGON.components.main[3].isActionUsed = true;
                    ui.ARGON.components.main[3].updateActionUse();
                } else if (actionType === "legendary") {
                    ui.ARGON.components.main[4].isActionUsed = true;
                }
            }

            async render(...args) {
                await super.render(...args);
                if (this.activity) {
                    const weapons = this.actor.items.filter((item) => item.consume?.target === this.activity.id);
                    ui.ARGON.updateItemButtons(weapons);
                }
            }

            get quantity() {
                if(!this.item) return null;
                if (this.item.system.uses?.max) return this.item.system.uses.max - this.item.system.uses.spent;
                if (!this.activity) return null;
                const showQuantityItemTypes = ["consumable"];
                const consumeType = this.activity?.consume?.type;
                const useAmmo = this.item.system.ammunition?.type;
                const useOtherItem = this.activity?.consumption?.targets?.find(t => t.type === "itemUses");
                if (useOtherItem) {
                    const otherItem = this.actor.items.get(useOtherItem.target);
                    if (otherItem && otherItem.system.uses?.max) {
                        return otherItem.system.uses.max - otherItem.system.uses.spent;
                    }
                }
                if (useAmmo) {
                    const ammoItem = this.item.system.ammunitionOptions[0]?.item;
                    if (!ammoItem) return null;
                    return Math.floor(ammoItem.system.quantity ?? 0);
                } else if (consumeType === "attribute") {
                    return Math.floor(getProperty(this.actor, this.activity.consume.target) / this.activity.consume.amount);
                } else if (consumeType === "charges") {
                    const chargesItem = this.actor.items.get(this.activity.consume.target);
                    if (!chargesItem) return null;
                    return Math.floor((chargesItem.uses?.value ?? 0) / this.activity.consume.amount);
                } else if (showQuantityItemTypes.includes(this.item.type) && !this.activity.uses.max) {
                    return this.item.system.quantity;
                } else if (this.activity.uses.value !== null && this.activity.uses.per !== null && this.activity.uses.max) {
                    return this.activity.uses.value;
                }
                return null;
            }
        }

        class DND5eButtonPanelButton extends ARGON.MAIN.BUTTONS.ButtonPanelButton {
            constructor({ type, items, color }) {
                super();
                this.type = type;
                this.items = items;
                this.color = color;
                this.itemsWithSpells = [];
                this._spells = this.prePrepareSpells();
            }

            get hasContents() {
                return this._spells ? !!this._spells.length || !!this.itemsWithSpells.length : !!this.items.length;
            }

            get colorScheme() {
                return this.color;
            }

            get id() {
                return `${this.type}-${this.color}`;
            }

            get label() {
                switch (this.type) {
                    case "spell":
                        return "enhancedcombathud-black-flag.hud.castspell.name";
                    case "feature":
                        return "enhancedcombathud-black-flag.hud.usepower.name";
                    case "consumable":
                        return "enhancedcombathud-black-flag.hud.useitem.name";
                    case "weapon":
                        return "enhancedcombathud-black-flag.hud.useitem.name";
                }
            }

            get icon() {
                switch (this.type) {
                    case "spell":
                        return "modules/enhancedcombathud/icons/spell-book.webp";
                    case "feature":
                        return "modules/enhancedcombathud/icons/mighty-force.webp";
                    case "consumable":
                        return "modules/enhancedcombathud/icons/drink-me.webp";
                    case "weapon":
                        return "modules/enhancedcombathud/icons/drink-me.webp";
                }
            }

            get showPreparedOnly() {
                if (this.actor.type !== "pc") return false;
                const preparedFlag = this.actor.getFlag(MODULE_ID, "showPrepared");
                if(preparedFlag === "auto") {
                    const classes = Object.keys(this.actor.system.progression?.classes ?? {});
                    const requiresPreparation = ["cleric", "druid", "wizard"].some((className) => classes.includes(className));
                    return requiresPreparation;
                }
                if (preparedFlag === "all") return false;
                // default 2024 rules: all classes prepare spells
                return true;
            }

            prePrepareSpells() {
                if (this.type !== "spell") return;

                const spellLevels = CONFIG.BlackFlag.spellCircles();
                const itemsToIgnore = [];
                const magicItems = new Map();
                this.items.filter((item) => item.flags["black-flag"]?.cachedFor).forEach(is => {
                    const activity = fromUuidSync(this.actor.documentName + "." + this.actor.id + is.flags["black-flag"].cachedFor);
                    itemsToIgnore.push(is);
                    if(!activity?.displayInSpellbook) return;
                    const magicItem = activity.item;
                    const current = magicItems.get(magicItem);
                    current ? current.push(is) : magicItems.set(magicItem, [is]);
                })

                for (const [item, spells] of magicItems) {
                    this.itemsWithSpells.push({
                        label: item.name,
                        buttons: spells.map((spell) => new DND5eItemButton({ item: spell })),
                        uses: () => {
                            return { max: item.system?.uses?.max, value: item.system?.uses?.value };
                        },
                    });
                }
                
                this.items = this.items.filter((item) => !itemsToIgnore.includes(item));
                if (this.showPreparedOnly) {
                    this.items = this.items.filter(isSpellPreparedForHud);
                }

                const spells = [
                    ...this.itemsWithSpells,
                    {
                        label: "At-Will",
                        buttons: this.items.filter((item) => item.getFlag('black-flag', 'relationship.mode') === "atWill").map((item) => new DND5eItemButton({ item })),
                        uses: { max: Infinity, value: Infinity },
                    },
                    {
                        label: "Innate",
                        buttons: this.items.filter((item) => item.getFlag('black-flag', 'relationship.mode') === "innate").map((item) => new DND5eItemButton({ item })),
                        uses: { max: Infinity, value: Infinity },
                    },
                    {
                        label: Object.values(spellLevels)[0],
                        buttons: this.items.filter((item) => item.system?.circle?.base == 0).map((item) => new DND5eItemButton({ item })),
                        uses: { max: Infinity, value: Infinity },
                    },
                    {
                        label: "Pact Magic",
                        buttons: this.items.filter((item) => item.getFlag('black-flag', 'relationship.mode') === "pact").map((item) => new DND5eItemButton({ item })),
                        uses: () => {
                            return getSpellSlotUses(this.actor, "pact");
                        },
                    },
                ];
                const spellRelationshipMode = (item) => item.getFlag('black-flag', 'relationship.mode');
                const isStandardLeveledSpell = (item) => isStandardSpellMode(spellRelationshipMode(item));
                for (const [level, label] of Object.entries(spellLevels)) {
                    const levelSpells = this.items.filter((item) => item.system?.circle?.base == level && isStandardLeveledSpell(item));
                    if (!levelSpells.length || level == 0) continue;
                    spells.push({
                        label,
                        buttons: levelSpells.map((item) => new DND5eItemButton({ item })),
                        uses: () => {
                            return getSpellSlotUses(this.actor, `circle-${level}`);
                        },
                    });
                }
                return spells.filter((spell) => spell.buttons.length);
            }

            async _getPanel() {
                if (this.type === "spell") {
                    return new ARGON.MAIN.BUTTON_PANELS.ACCORDION.AccordionPanel({ id: this.id, accordionPanelCategories: this._spells.map(({ label, buttons, uses }) => new ARGON.MAIN.BUTTON_PANELS.ACCORDION.AccordionPanelCategory({ label, buttons, uses })) });
                } else {
                    return new ARGON.MAIN.BUTTON_PANELS.ButtonPanel({ id: this.id, buttons: this.items.map((item) => new DND5eItemButton({ item })) });
                }
            }
        }

        class DND5eSpecialActionButton extends ARGON.MAIN.BUTTONS.ActionButton {
            constructor(specialItem) {
                super();
                const actorItem = this.actor.items.getName(specialItem.name);
                this.specialItem = specialItem;
                this.actorItem = actorItem;
                this.statusId = specialItem.flags?.statusId?.id;
                this.item = actorItem ?? specialItem;
            }

            get label() {
                return this.item.name;
            }

            get icon() {
                return this.item.img;
            }

            get hasTooltip() {
                return true;
            }

            get activity() {
                if (!this.item?.system?.activities) {
                    return;
                }
                return Array.from(this.item.system.activities)[0];
            }

            async getTooltipData() {
                const tooltipData = await getTooltipDetails(this.item);
                tooltipData.propertiesLabel = "enhancedcombathud-black-flag.tooltip.properties.name";
                return tooltipData;
            }

            async _onLeftClick(event) {
                const useCE = game.modules.get("dfreds-convenient-effects")?.active && game.dfreds.effectInterface.findEffect({ effectName: this.label });
                const skillCheck = foundry.utils.getProperty(this.specialItem, `flags.${MODULE_ID}.argonSkillCheck`);
                let success = false;
                if (skillCheck) {
                    success = Boolean(await activateSpecialSkillCheck(this.actor, skillCheck, event));
                    if (success && useCE) {
                        await game.dfreds.effectInterface.toggleEffect({ effectName: this.label, overlay: false, uuids: [this.actor.uuid] });
                    } else if (success && this.statusId) {
                        const status = CONFIG.statusEffects.find(e => e.id === this.statusId || e._id === this.statusId);
                        if (status) await this.actor.toggleStatusEffect(status.id);
                    }
                } else if (useCE) {
                    success = true;
                    await game.dfreds.effectInterface.toggleEffect({ effectName: this.label, overlay: false, uuids: [this.actor.uuid] });
                } else {
                    const contestedShove = foundry.utils.getProperty(this.specialItem, `flags.${MODULE_ID}.argonContestedShove`);
                    success = contestedShove
                        ? await activateShoveContest(this.actor, this.specialItem, event)
                        : this.actorItem
                            ? await this.activity?.activate?.({ event }, { event })
                            : await this.createChatMessage();
                    if(this.statusId) {
                        const status = CONFIG.statusEffects.find(e => e.id === this.statusId || e._id === this.statusId);
                        if(status) this.actor.toggleStatusEffect(status.id);
                    }
                }
                if (success) {
                    DND5eItemButton.consumeActionEconomy(this.item);
                }
            }

            async createChatMessage() {
                return await ChatMessage.create({
                    user: game.user,
                    speaker: {
                        actor: this.actor,
                        token: this.actor.token,
                        alias: this.actor.name,
                    },
                    content: `
                    <div class="chat-card item-card" data-display-challenge="">

    <section class="card-header description collapsible">

        <header class="summary">
            <img class="gold-icon" src="${this.icon}">
            <div class="name-stacked border">
                <span class="title">${this.label}</span>
                <span class="subtitle">
                    Feature
                </span>
            </div>
            <i class="fas fa-chevron-down fa-fw"></i>
        </header>

        <section class="details collapsible-content card-content">
            <div class="wrapper">
                ${this.item.system.description.value}
            </div>
        </section>
    </section>


</div>
                    `,
                });
            }
        }

        class DND5eMovementHud extends ARGON.MovementHud {
            get movementMax() {
                if (!this.actor) return 0;
                if (!this.actor.system.traits.movement.types[this.movementMode]?.value ?? 0) return 0;
                return this.actor.system.traits.movement.types[this.movementMode]?.value ?? 0 / canvas.scene.dimensions.distance;
            }
        }

        class DND5eButtonHud extends ARGON.ButtonHud {
            constructor(...args) {
                super(...args);
            }

            get visible() {
                return !game.combat?.started;
            }

            get classes() {
                return [...super.classes, "tovf-rest-hud"];
            }

            async _getButtons() {
                return [
                    {
                        id: "roll-initiative",
                        label: "Roll Initiative",
                        onClick: async () => {
                            if (this.token?.combatant?.initiative !== undefined) {
                                const confirmed = await foundry.applications.api.DialogV2.confirm({
                                    window: { title: game.i18n.localize("enhancedcombathud.confirmRerollInitiativeTitle") },
                                    content: game.i18n.localize("enhancedcombathud.confirmRerollInitiativeContent"),
                                    defaultYes: false,
                                });
                                if (!confirmed) return;
                            }
                            return this.actor.rollInitiative({ rerollInitiative: true, createCombatants: true });
                        },
                        icon: "fa-solid fa-dice-d20",
                    },
                    {
                        id: "open-sheet",
                        label: "Open Sheet",
                        onClick: () => this.actor.sheet.render(true),
                        icon: "fa-solid fa-suitcase",
                    },
                    {
                        id: "long-rest",
                        label: "Long Rest",
                        onClick: (event) => this.actor.longRest(),
                        icon: "fas fa-bed",
                    },
                    {
                        id: "short-rest",
                        label: "Short Rest",
                        onClick: (event) => this.actor.shortRest(),
                        icon: "fas fa-coffee",
                    },
                ];
            }

            async render(...args) {
                await super.render(...args);
                const elements = Array.from(this.element.querySelectorAll(".button-hud-button"));
                elements.forEach((element, index) => {
                    const button = this.buttons[index];
                    if (button?.id) element.classList.add(`tovf-${button.id}`);
                    if (button?.label) {
                        element.dataset.tooltip = button.label;
                        element.setAttribute("aria-label", button.label);
                    }
                    if (!button?.id?.endsWith("-rest") && !["open-sheet", "roll-initiative"].includes(button?.id)) return;
                    const label = element.querySelector("span");
                    const [prefix, suffix] = String(button.label).split(" ");
                    label.textContent = prefix;
                    label.classList.add("tovf-stack-prefix");
                    const suffixElement = document.createElement("span");
                    suffixElement.classList.add("tovf-stack-suffix");
                    suffixElement.textContent = suffix;
                    element.appendChild(suffixElement);
                });
                return this.element;
            }
        }

        class DND5eWeaponSets extends ARGON.WeaponSets {
            async getDefaultSets() {
                const sets = await super.getDefaultSets();
                const isTransformed = this.actor.flags?.["black-flag"]?.isPolymorphed;
                if (this.actor.type !== "npc" && !isTransformed) return sets;
                const actions = this.actor.items.filter((item) => item.type === "weapon" && getActivationType(item) === "action");
                const bonus = this.actor.items.filter((item) => item.type === "weapon" && getActivationType(item) === "bonus");
                return {
                    1: {
                        primary: actions[0]?.uuid ?? null,
                        secondary: bonus[0]?.uuid ?? null,
                    },
                    2: {
                        primary: actions[1]?.uuid ?? null,
                        secondary: bonus[1]?.uuid ?? null,
                    },
                    3: {
                        primary: actions[2]?.uuid ?? null,
                        secondary: bonus[2]?.uuid ?? null,
                    },
                };
            }

            async _getSets() {
                const isTransformed = this.actor.flags?.["black-flag"]?.isPolymorphed;

                const sets = isTransformed ? await this.getDefaultSets() : foundry.utils.mergeObject(await this.getDefaultSets(), foundry.utils.deepClone(this.actor.getFlag("enhancedcombathud", "weaponSets") || {}));

                for (const [set, slots] of Object.entries(sets)) {
                    slots.primary = slots.primary ? await fromUuid(slots.primary) : null;
                    slots.secondary = slots.secondary ? await fromUuid(slots.secondary) : null;
                }
                return sets;
            }

            async _onSetChange({ sets, active }) {
                const switchEquip = game.settings.get(MODULE_ID, "switchEquip");
                if (!switchEquip) return;
                const updates = [];
                const activeSet = sets[active];
                const activeItems = Object.values(activeSet).filter((item) => item);
                const inactiveSets = Object.values(sets).filter((set) => set !== activeSet);
                const inactiveItems = inactiveSets
                    .flatMap((set) => Object.values(set))
                    .filter((item) => item)
                    .filter((item) => !activeItems.includes(item));
                activeItems.forEach((item) => {
                    if (!item.system?.equipped) updates.push({ _id: item.id, "system.equipped": true });
                });
                inactiveItems.forEach((item) => {
                    if (item.system?.equipped) updates.push({ _id: item.id, "system.equipped": false });
                });
                return await this.actor.updateEmbeddedDocuments("Item", updates);
            }
        }

        class TOVFMacroPanel extends ARGON.PREFAB.MacroPanel {
            async _renderInner() {
                await super._renderInner();
                addActionOrnaments(this);
            }
        }

        const enableMacroPanel = game.settings.get(MODULE_ID, "macroPanel");

        const mainPanels = [DND5eActionActionPanel, DND5eBonusActionPanel, DND5eReactionActionPanel, DND5eFreeActionPanel, DND5eLegActionPanel, DND5eLairActionPanel, DND5eMythicActionPanel];
        if (enableMacroPanel) mainPanels.push(TOVFMacroPanel);
        mainPanels.push(ARGON.PREFAB.PassTurnPanel);

        console.log("[Argon-BF] Defining portrait panel...");
        CoreHUD.definePortraitPanel(DND5ePortraitPanel);
        console.log("[Argon-BF] Portrait panel defined");
        console.log("[Argon-BF] Defining drawer panel...");
        CoreHUD.defineDrawerPanel(DND5eDrawerPanel);
        console.log("[Argon-BF] Drawer panel defined");
        console.log("[Argon-BF] Defining main panels:", mainPanels.length, "panels");
        CoreHUD.defineMainPanels(mainPanels);
        console.log("[Argon-BF] Main panels defined");
        CoreHUD.defineMovementHud(DND5eMovementHud);
        CoreHUD.defineButtonHud(DND5eButtonHud);
        CoreHUD.defineWeaponSets(DND5eWeaponSets);
        CoreHUD.defineTooltip(DND5eTooltip);
        console.log("[Argon-BF] Defining supported actor types: pc, npc");
        CoreHUD.defineSupportedActorTypes(["pc", "npc"]);
        console.log("[Argon-BF] argonInit handler COMPLETED successfully");
    });
}

function registerItems() {
    ECHItems[game.i18n.localize("enhancedcombathud-black-flag.items.disengage.name")] = {
        name: game.i18n.localize("enhancedcombathud-black-flag.items.disengage.name"),
        type: "feature",
        img: "modules/enhancedcombathud/icons/journey.webp",
        system: {
            type: {
                value: "",
                subtype: "",
            },
            description: {
                value: game.i18n.localize("enhancedcombathud-black-flag.items.disengage.desc"),
                chat: "",
                unidentified: "",
            },
            source: "",
            quantity: 1,
            weight: 0,
            price: 0,
            attuned: false,
            attunement: 0,
            equipped: false,
            rarity: "",
            identified: true,
            activation: {
                type: "action",
                cost: 1,
                condition: "",
            },
            duration: {
                value: 1,
                units: "turn",
            },
            target: {
                value: null,
                width: null,
                units: "",
                type: "self",
            },
            range: {
                value: null,
                long: null,
                units: "",
            },
            consume: {
                type: "",
                target: "",
                amount: null,
            },
            ability: "",
            actionType: "util",
            attackBonus: 0,
            chatFlavor: "",
            critical: null,
            damage: {
                parts: [],
                versatile: "",
            },
            formula: "",
            save: {
                ability: "",
                dc: null,
                scaling: "spell",
            },
        },
        sort: 0,
        flags: {
            core: {
                sourceId: "Item.wyQkeuZkttllAFB1",
            },

            "midi-qol": {
                onUseMacroName: "",
            },
        },
    };
    ECHItems[game.i18n.localize("enhancedcombathud-black-flag.items.dodge.name")] = {
        name: game.i18n.localize("enhancedcombathud-black-flag.items.dodge.name"),
        type: "feature",
        img: "modules/enhancedcombathud/icons/armor-upgrade.webp",
        system: {
            type: {
                value: "",
                subtype: "",
            },
            description: {
                value: game.i18n.localize("enhancedcombathud-black-flag.items.dodge.desc"),
                chat: "",
                unidentified: "",
            },
            source: "",
            quantity: 1,
            weight: 0,
            price: 0,
            attuned: false,
            attunement: 0,
            equipped: false,
            rarity: "",
            identified: true,
            activation: {
                type: "action",
                cost: 1,
                condition: "",
            },
            duration: {
                value: 1,
                units: "round",
            },
            target: {
                value: null,
                width: null,
                units: "",
                type: "self",
            },
            range: {
                value: null,
                long: null,
                units: "",
            },

            consume: {
                type: "",
                target: "",
                amount: null,
            },
            ability: "",
            actionType: "util",
            attackBonus: 0,
            chatFlavor: "",
            critical: null,
            damage: {
                parts: [],
                versatile: "",
            },
            formula: "",
            save: {
                ability: "",
                dc: null,
                scaling: "spell",
            },
            consumableType: "trinket",
        },
        sort: 0,
        flags: {
            statusId: {
                        id: "dodging",
            },
            "midi-qol": {
                onUseMacroName: "",
            },
        },
    };
    ECHItems[game.i18n.localize("enhancedcombathud-black-flag.items.ready.name")] = {
        name: game.i18n.localize("enhancedcombathud-black-flag.items.ready.name"),
        type: "feature",
        img: "modules/enhancedcombathud/icons/clockwork.webp",
        system: {
            type: {
                value: "",
                subtype: "",
            },
            description: {
                value: game.i18n.localize("enhancedcombathud-black-flag.items.ready.desc"),
                chat: "",
                unidentified: "",
            },
            source: "",
            quantity: 1,
            weight: 0,
            price: 0,
            attuned: false,
            attunement: 0,
            equipped: false,
            rarity: "",
            identified: true,
            activation: {
                type: "action",
                cost: 1,
                condition: "",
            },
            duration: {
                value: null,
                units: "",
            },
            target: {
                value: null,
                width: null,
                units: "",
                type: "self",
            },
            range: {
                value: null,
                long: null,
                units: "",
            },

            consume: {
                type: "",
                target: "",
                amount: null,
            },
            ability: "",
            actionType: "util",
            attackBonus: 0,
            chatFlavor: "",
            critical: null,
            damage: {
                parts: [],
                versatile: "",
            },
            formula: "",
            save: {
                ability: "",
                dc: null,
                scaling: "spell",
            },
            consumableType: "trinket",
        },
        sort: 0,
        flags: {
            "midi-qol": {
                onUseMacroName: "",
            },
        },
    };
    ECHItems[game.i18n.localize("enhancedcombathud-black-flag.items.hide.name")] = {
        name: game.i18n.localize("enhancedcombathud-black-flag.items.hide.name"),
        type: "feature",
        img: "modules/enhancedcombathud/icons/cloak-dagger.webp",
        system: {
            type: {
                value: "",
                subtype: "",
            },
            description: {
                value: game.i18n.localize("enhancedcombathud-black-flag.items.hide.desc"),
                chat: "",
                unidentified: "",
            },
            source: "",
            quantity: 1,
            weight: 0,
            price: 0,
            attuned: false,
            attunement: 0,
            equipped: false,
            rarity: "",
            identified: true,
            activation: {
                type: "action",
                cost: 1,
                condition: "",
            },
            duration: {
                value: null,
                units: "",
            },
            target: {
                value: null,
                width: null,
                units: "",
                type: "self",
            },
            range: {
                value: null,
                long: null,
                units: "",
            },

            consume: {
                type: "",
                target: "",
                amount: null,
            },
            recharge: {
                value: null,
                charged: false,
            },
            ability: "",
            actionType: "util",
            attackBonus: 0,
            chatFlavor: "",
            critical: null,
            damage: {
                parts: [],
                versatile: "",
            },
            formula: "",
            save: {
                ability: "",
                dc: null,
                scaling: "spell",
            },
            consumableType: "trinket",
        },
        sort: 0,
        flags: {
            [MODULE_ID]: {
                argonSkillCheck: "stealth",
            },
            statusId: {
                        id: "hiding",
            },
            "midi-qol": {
                onUseMacroName: "",
            },
        },
    };
    ECHItems[game.i18n.localize("enhancedcombathud-black-flag.items.dash.name")] = {
        name: game.i18n.localize("enhancedcombathud-black-flag.items.dash.name"),
        type: "feature",
        img: "modules/enhancedcombathud/icons/walking-boot.webp",
        system: {
            type: {
                value: "",
                subtype: "",
            },
            description: {
                value: game.i18n.localize("enhancedcombathud-black-flag.items.dash.desc"),
                chat: "",
                unidentified: "",
            },
            source: "",
            quantity: 1,
            weight: 0,
            price: 0,
            attuned: false,
            attunement: 0,
            equipped: false,
            rarity: "",
            identified: true,
            activation: {
                type: "action",
                cost: 1,
                condition: "",
            },
            duration: {
                value: null,
                units: "",
            },
            target: {
                value: null,
                width: null,
                units: "",
                type: "self",
            },
            range: {
                value: null,
                long: null,
                units: "",
            },

            consume: {
                type: "",
                target: "",
                amount: null,
            },
            ability: "",
            actionType: "util",
            attackBonus: 0,
            chatFlavor: "",
            critical: null,
            damage: {
                parts: [],
                versatile: "",
            },
            formula: "",
            save: {
                ability: "",
                dc: null,
                scaling: "spell",
            },
            consumableType: "trinket",
        },
        sort: 0,
        flags: {
            "midi-qol": {
                onUseMacroName: "",
            },
        },
    };
    ECHItems[game.i18n.localize("enhancedcombathud-black-flag.items.shove.name")] = {
        name: game.i18n.localize("enhancedcombathud-black-flag.items.shove.name"),
        type: "feature",
        img: "modules/enhancedcombathud/icons/shield-bash.webp",
        system: {
            type: {
                value: "",
                subtype: "",
            },
            description: {
                value: game.i18n.localize("enhancedcombathud-black-flag.items.shove.desc"),
                chat: "",
                unidentified: "",
            },
            source: "",
            quantity: 1,
            weight: 0,
            price: 0,
            attuned: false,
            attunement: 0,
            equipped: false,
            rarity: "",
            identified: true,
            activation: {
                type: "action",
                cost: 1,
                condition: "",
            },
            duration: {
                value: null,
                units: "",
            },
            target: {
                value: 1,
                width: null,
                units: "",
                type: "creature",
            },
            range: {
                value: null,
                long: null,
                units: "touch",
            },

            consume: {
                type: "",
                target: "",
                amount: null,
            },
            ability: "",
            actionType: "util",
            attackBonus: 0,
            chatFlavor: "",
            critical: null,
            damage: {
                parts: [],
                versatile: "",
            },
            formula: "",
            save: {
                ability: "",
                dc: null,
                scaling: "spell",
            },
            consumableType: "trinket",
        },
        sort: 0,
        flags: {
            [MODULE_ID]: {
                argonContestedShove: true,
            },
            "midi-qol": {
                onUseMacroName: "",
            },
        },
    };
}
