import { MODULE_ID } from "../core/constants.mjs";

let cubeTemplateFixInstalled = false;
let currencyStackingInstalled = false;
let damageFormulaToggleInstalled = false;
let permanentStatusIconFixInstalled = false;
let forwardActivityConsumptionFixInstalled = false;

/**
 * Black Flag 3.0.077 resolves a Forward Activity involved in linked resource
 * consumption through `linkedActivity.activity.id`, although ForwardActivity
 * only stores that reference in `system.linked.id`. Supply the missing lookup
 * while the affected implementation is present so forwarded Heal Activities
 * and other linked activities can finish their consumption step.
 */
function installForwardActivityConsumptionFix() {
  if (forwardActivityConsumptionFixInstalled) return;

  const Activity = BlackFlag?.documents?.activity?.Activity;
  const ForwardActivity = CONFIG.Activity?.types?.forward?.documentClass;
  const prepareUpdates = Activity?.prototype?._prepareActivationUpdates;
  if (typeof prepareUpdates !== "function" || !ForwardActivity?.prototype) return;

  const affected = Function.prototype.toString.call(prepareUpdates)
    .includes("linkedActivity.activity.id");
  if (!affected || "activity" in ForwardActivity.prototype) return;

  Object.defineProperty(ForwardActivity.prototype, "activity", {
    configurable: true,
    get() {
      const id = this.system?.linked?.id;
      return id ? this.item?.system?.activities?.get(id) ?? null : null;
    }
  });

  forwardActivityConsumptionFixInstalled = true;
  console.debug(`${MODULE_ID} | Applied Black Flag Forward Activity consumption compatibility fix.`);
}

/**
 * Foundry only renders an Active Effect icon in CONDITIONAL mode while the
 * effect is temporary. Black Flag's permanent condition effects inherit that
 * default when copied from an Item or compendium entry to an Actor, although
 * their normal `statuses` entry remains active. Promote only those Actor
 * copies to ALWAYS so the status is visible on the Token without creating a
 * duplicate rider condition through `system.rider.statuses`.
 */
function installPermanentStatusIconFix() {
  if (permanentStatusIconFixInstalled) return;

  Hooks.on("preCreateActiveEffect", effect => {
    if (effect.parent?.documentName !== "Actor") return;

    const statuses = effect.statuses;
    const hasStatus = statuses instanceof Set
      ? statuses.size > 0
      : Array.isArray(statuses) && statuses.length > 0;
    if (!hasStatus) return;

    const showIcon = CONST.ACTIVE_EFFECT_SHOW_ICON;
    if (effect.showIcon !== showIcon.CONDITIONAL || effect.isTemporary) return;
    effect.updateSource({ showIcon: showIcon.ALWAYS });
  });

  permanentStatusIconFixInstalled = true;
}

/** Black Flag's formula button can look for a hidden input absent from the rendered damage row. */
function installDamageFormulaToggleFix() {
  if (damageFormulaToggleInstalled) return;
  const DamageListElement = BlackFlag?.applications?.components?.DamageListElement;
  const original = DamageListElement?.prototype?._onAction;
  if (typeof original !== "function" || !original.toString().includes("this._createFormula(index)")) return;
  damageFormulaToggleInstalled = true;
  DamageListElement.prototype._onAction = async function(target, action) {
    if (action !== "customize") return original.call(this, target, action);
    if (!this.isEditable) return;
    const index = Number(target.closest("li")?.dataset.index);
    const source = foundry.utils.getProperty(this.activity.toObject(), this.name);
    const damage = this.single ? source : source?.[index];
    if (!damage) return;
    const custom = {
      ...damage.custom,
      enabled: !damage.custom?.enabled,
      formula: damage.custom?.formula || this._createFormula(index)
    };
    const updated = this.single ? { ...source, custom } : source.map((part, partIndex) =>
      partIndex === index ? { ...part, custom } : part);
    const path = `system.activities.${this.activity.id}.${this.name}`;
    return this.activity.item.update({ [path]: updated });
  };
}

function installOtherInventorySection() {
  const sections = CONFIG.BlackFlag?.sheetSections?.pc;
  if (!Array.isArray(sections) || sections.some(section => section.id === "tovf-other")) return;

  // Black Flag assigns each Item to the first matching section. Keeping this
  // physical-item filter last therefore catches only equipment which none of
  // the system's more specific inventory sections recognize, without pulling
  // unclassified Features or other non-equipment Items into the inventory.
  sections.push({
    id: "tovf-other",
    tab: "inventory",
    label: "TOVF.Inventory.Other",
    filters: [{ k: "system.isPhysical", v: true }],
    options: { autoHide: true }
  });
}

/**
 * Black Flag 3.0.077 calls an unbound `formatNumber` identifier while preparing
 * the numbered exhaustion effect. The formatter itself is publicly exposed by
 * the system; provide the missing global binding until the system fixes the
 * bundled reference.
 */
function installExhaustionFormatNumberFix() {
  if (typeof globalThis.formatNumber === "function") return;
  const formatter = BlackFlag?.utils?.formatNumber;
  if (typeof formatter !== "function") return;
  Object.defineProperty(globalThis, "formatNumber", {
    value: (...args) => formatter(...args),
    configurable: true,
    writable: true
  });
  console.debug(`${MODULE_ID} | Applied Black Flag 3.0.077 exhaustion formatNumber compatibility fix.`);
}

function currencyIdentifier(item) {
  if (item?.type !== "currency") return "";
  return String(item.system?.identifier?.value ?? item.system?.identifier ?? "")
    .trim()
    .toLowerCase();
}

async function mergeCurrencyStacks(actor) {
  if (actor?.documentName !== "Actor" || !actor.isOwner) return;
  const groups = new Map();
  for (const item of actor.items) {
    const identifier = currencyIdentifier(item);
    if (!identifier) continue;
    if (!groups.has(identifier)) groups.set(identifier, []);
    groups.get(identifier).push(item);
  }
  for (const stacks of groups.values()) {
    if (stacks.length < 2) continue;
    const [keeper, ...duplicates] = stacks;
    const quantity = stacks.reduce((sum, item) => sum + Number(item.system.quantity ?? 0), 0);
    await keeper.update({ "system.quantity": quantity });
    await actor.deleteEmbeddedDocuments("Item", duplicates.map(item => item.id));
  }
}

function installCurrencyStacking() {
  if (currencyStackingInstalled) return;
  currencyStackingInstalled = true;
  Hooks.on("createItem", (item, _options, userId) => {
    if (userId !== game.user.id || !currencyIdentifier(item)) return;
    void mergeCurrencyStacks(item.parent).catch(error =>
      console.error(`${MODULE_ID} | Failed to merge currency stacks.`, error)
    );
  });
  Hooks.once("ready", async () => {
    if (!game.user.isGM) return;
    for (const actor of game.actors) {
      await mergeCurrencyStacks(actor).catch(error =>
        console.error(`${MODULE_ID} | Failed to normalize currency stacks for ${actor.uuid}.`, error));
    }
  });
}

/**
 * Black Flag 3.0.077 creates cube templates with a line shape whose width is
 * undefined. Foundry V14 requires the width to be numeric.
 */
function installCubeTemplateFix() {
  if (cubeTemplateFixInstalled) return;

  Hooks.on("blackFlag.preCreateMeasuredTemplate", (activity, placementConfig) => {
    if (activity.target?.template?.type !== "cube") return;

    const shape = placementConfig.shapes?.[0];
    const size = Number(shape?.size);
    if (!shape || !Number.isFinite(size)) return;

    shape.width = size;
  });

  cubeTemplateFixInstalled = true;
}

function cleanStackData(value) {
  const data = foundry.utils.deepClone(value?.toObject ? value.toObject() : value);
  delete data._id;
  delete data._stats;
  delete data.folder;
  delete data.ownership;
  delete data.sort;
  foundry.utils.deleteProperty(data, "flags.core.sourceId");
  foundry.utils.deleteProperty(data, "system.quantity");
  foundry.utils.deleteProperty(data, "system.container");
  return data;
}

function installItemStacking() {
  const InventoryElement = BlackFlag?.applications?.components?.InventoryElement;
  if (!InventoryElement || InventoryElement.__tovfItemStacking) return;
  const original = InventoryElement._transformDroppedItem;
  if (typeof original !== "function") return;

  InventoryElement._transformDroppedItem = async function(event, target, itemData) {
    const transformed = await original.call(this, event, target, itemData);
    if (!transformed || transformed.type === "weapon") return transformed;

    const quantity = Number(transformed.system?.quantity);
    if (!Number.isFinite(quantity)) return transformed;
    const items = target?.documentName === "Actor"
      ? target.items
      : await target?.system?.contents;
    const signature = cleanStackData(transformed);
    const existing = items?.find(item =>
      item.type !== "weapon"
      && Number.isFinite(Number(item.system?.quantity))
      && ((currencyIdentifier(transformed)
        && currencyIdentifier(item) === currencyIdentifier(transformed))
        || foundry.utils.equals(cleanStackData(item), signature))
    );
    if (!existing) return transformed;

    await existing.update({
      "system.quantity": Number(existing.system.quantity) + Math.max(1, quantity)
    });
    return false;
  };

  Object.defineProperty(InventoryElement, "__tovfItemStacking", {
    value: true,
    configurable: true
  });
}

function installSpellManagerTooltipCoverage() {
  Hooks.on("renderApplicationV2", app => {
    if (!app?.options?.classes?.includes("spell-manager")) return;
    requestAnimationFrame(() => {
      for (const row of app.element?.querySelectorAll?.("[data-spell-uuid]") ?? []) {
        const label = row.querySelector(":scope > label");
        if (!label || !row.dataset.tooltip) continue;
        label.dataset.tooltip = row.dataset.tooltip;
        label.dataset.tooltipClass = row.dataset.tooltipClass;
        label.dataset.tooltipDirection = row.dataset.tooltipDirection;
      }
    });
  });
}

/**
 * Black Flag 3.0.077 references an undefined `config` variable while adding
 * targeted-token data to an activity chat message. Keep this patch
 * self-disabling so a corrected system implementation is never replaced.
 */
export function installBlackFlagCompatibility() {
  installDamageFormulaToggleFix();
  installPermanentStatusIconFix();
  installForwardActivityConsumptionFix();
  installOtherInventorySection();
  installExhaustionFormatNumberFix();
  installCubeTemplateFix();
  installItemStacking();
  installCurrencyStacking();
  installSpellManagerTooltipCoverage();
  const Activity = BlackFlag?.documents?.activity?.Activity;
  const prototype = Activity?.prototype;
  const original = prototype?._finalizeMessageConfig;
  if (typeof original !== "function") return;

  const source = Function.prototype.toString.call(original);
  if (!source.includes("config.targets")) return;

  prototype._finalizeMessageConfig = function(activationConfig, messageConfig, results) {
    messageConfig.data.rolls = (messageConfig.data.rolls ?? []).concat(results.updates.rolls);
    if (activationConfig.targets?.length) {
      foundry.utils.setProperty(
        messageConfig,
        `data.flags.${game.system.id}.targets`,
        activationConfig.targets
      );
    }
    const effects = this.system.applicableEffects?.map(effect => effect.relativeUUID);
    if (effects) foundry.utils.setProperty(messageConfig.data, "system.effects", effects);
  };

  console.debug(`${MODULE_ID} | Applied Black Flag activity target compatibility fix.`);
}
