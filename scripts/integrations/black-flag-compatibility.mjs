import { MODULE_ID } from "../core/constants.mjs";

let cubeTemplateFixInstalled = false;
let currencyStackingInstalled = false;

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

/**
 * Black Flag 3.0.077 references an undefined `config` variable while adding
 * targeted-token data to an activity chat message. Keep this patch
 * self-disabling so a corrected system implementation is never replaced.
 */
export function installBlackFlagCompatibility() {
  installCubeTemplateFix();
  installItemStacking();
  installCurrencyStacking();
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

  console.warn(`${MODULE_ID} | Applied Black Flag activity target compatibility fix.`);
}
