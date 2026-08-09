import { MODULE_ID } from "./core/constants.mjs";

function getModuleVersion() {
  return game.modules?.get(MODULE_ID)?.version ?? "0.0.0";
}

const ITEM_FILTERS = [{
  path: "type",
  filters: "background,class,feature,heritage,lineage,spell,subclass,talent"
}];
const ITEM_SIMILARITIES = ["name", "type"];
const UNSTACKABLE_ITEM_TYPES = ["container", "armor", "weapon"];
const BLACK_FLAG_GP_UUID = "Compendium.black-flag.currencies.Item.eWMYzM5UVZUDIqtg";
const EARLY_CURRENCIES = [
  {
    type: "item",
    name: "Platinum",
    img: null,
    abbreviation: "{#}pp",
    data: { uuid: "Compendium.black-flag.currencies.Item.DSIvSjJQvxdi7IWG" },
    primary: false,
    exchangeRate: 10
  },
  {
    type: "item",
    name: "Gold",
    img: null,
    abbreviation: "{#}gp",
    data: { uuid: BLACK_FLAG_GP_UUID },
    primary: true,
    exchangeRate: 1
  },
  {
    type: "item",
    name: "Silver",
    img: null,
    abbreviation: "{#}sp",
    data: { uuid: "Compendium.black-flag.currencies.Item.ywar06UcV0H66yKq" },
    primary: false,
    exchangeRate: 0.1
  },
  {
    type: "item",
    name: "Copper",
    img: null,
    abbreviation: "{#}cp",
    data: { uuid: "Compendium.black-flag.currencies.Item.CsAQAHTK5LWUHcPX" },
    primary: false,
    exchangeRate: 0.01
  }
];

let registrationPromise;
let currencySyncPromise;
let currencyHookInstalled = false;
let chatCompatibilityInstalled = false;

function baseGoldCurrency() {
  return {
    type: "item",
    name: "Gold",
    img: null,
    abbreviation: "{#}gp",
    data: { uuid: BLACK_FLAG_GP_UUID },
    primary: true,
    exchangeRate: 1
  };
}

function currencyDenomination(currency) {
  return String(currency?.abbreviation ?? "")
    .replace("{#}", "")
    .trim()
    .toLowerCase();
}

function ensurePrimaryCurrency(currencies) {
  if (!Array.isArray(currencies)) return [baseGoldCurrency()];
  if (currencies.some(currency => currency?.primary && Number(currency.exchangeRate) > 0)) return currencies;
  const gold = currencies.find(currency => currencyDenomination(currency) === "gp");
  if (gold) {
    gold.primary = true;
    if (!(Number(gold.exchangeRate) > 0)) gold.exchangeRate = 1;
  } else {
    currencies.push(baseGoldCurrency());
  }
  return currencies;
}

async function buildCurrencies() {
  const registered = CONFIG.BlackFlag?.registration?.list("currency") ?? {};
  const currencies = new Map();
  for (const [registeredIdentifier, registration] of Object.entries(registered)) {
    const canonicalUuid = registration.sources?.find(uuid =>
      uuid.startsWith("Compendium.black-flag.currencies.")
    );
    if (!canonicalUuid) continue;
    const item = await fromUuid(canonicalUuid);
    if (!item) continue;
    const denomination = String(
      item.identifier ?? item.system?.identifier?.value ?? registeredIdentifier
    ).trim().toLowerCase();
    const conversion = Number(item.system?.conversion?.value);
    if (!denomination || !(conversion > 0)) continue;
    currencies.set(denomination, {
      type: "item",
      name: item.name,
      img: null,
      abbreviation: `{#}${denomination.toUpperCase()}`,
      data: { uuid: item.uuid, item: item.toObject() },
      primary: denomination === "gp",
      // Black Flag stores units per gp (cp = 100); Item Piles expects the
      // value of one unit in its primary currency (cp = 0.01 gp).
      exchangeRate: 1 / conversion
    });
  }
  return ensurePrimaryCurrency([...currencies.values()]);
}

async function normalizeBlackFlagCurrencies() {
  const registered = CONFIG.BlackFlag?.registration?.list("currency") ?? {};
  const configured = CONFIG.BlackFlag?.currencies;
  if (!configured) return;

  for (const [registeredIdentifier, registration] of Object.entries(registered)) {
    const sourceUuid = registration.sources?.[0];
    const item = registration.cached ?? (sourceUuid ? await fromUuid(sourceUuid) : null);
    if (!item) continue;

    const denomination = String(
      item.identifier ?? item.system?.identifier?.value ?? registeredIdentifier
    ).trim().toLowerCase();
    if (!denomination) continue;

    const existing = configured[registeredIdentifier] ?? configured[denomination] ?? {};
    configured[denomination] = {
      ...existing,
      label: item.name,
      abbreviation: denomination,
      conversion: Number(item.system?.conversion?.value),
      uuid: item.uuid,
      default: ["pp", "gp", "sp", "cp"].includes(denomination)
    };

    if (registeredIdentifier !== denomination &&
        configured[registeredIdentifier]?.uuid === item.uuid) {
      delete configured[registeredIdentifier];
    }
  }
}

function getItemCost(item, currencies = []) {
  // Item Piles normally passes the Item itself, but some merchant paths pass
  // the surrounding price entry instead.
  ensurePrimaryCurrency(currencies);
  const itemData = item?.item ?? item;
  const value = Number(foundry.utils.getProperty(itemData, "system.price.value"));
  if (!Number.isFinite(value) || value <= 0) return 0;

  const denomination = foundry.utils.getProperty(itemData, "system.price.denomination") || "gp";
  const currency = currencies.find(entry => {
    const abbreviation = entry?.abbreviation?.replace("{#}", "").trim().toLowerCase();
    return abbreviation === denomination.toLowerCase();
  });
  const exchangeRate = Number(currency?.exchangeRate);
  if (Number.isFinite(exchangeRate) && exchangeRate > 0) {
    return value * exchangeRate;
  }

  // Currency overrides are optional. Registered Black Flag currencies use the
  // same GP-value-per-unit convention as Item Piles.
  const conversion = Number(CONFIG.BlackFlag?.currencies?.[denomination]?.conversion);
  if (!Number.isFinite(conversion) || conversion <= 0) {
    console.warn(`${MODULE_ID} | Unknown price denomination "${denomination}"; treating it as gp.`, itemData);
    return value;
  }

  return value * conversion;
}

function installChatCompatibility() {
  if (chatCompatibilityInstalled) return;
  chatCompatibilityInstalled = true;
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!html) return;
    if (!html.find) {
      html.find = selector => $(html).find(selector);
      html.closest = selector => $(html).closest(selector);
    }

    const root = html instanceof HTMLElement ? html : html[0];
    if (!root?.querySelector(".item-piles-chat-card")) return;

    const recipientIds = message?.whisper ?? [];
    if (!recipientIds.some(id => game.users.get(id)?.isGM)) return;

    const recipients = recipientIds.reduce((names, id) => {
      const user = game.users.get(id);
      if (!user) return names;
      const name = user.isGM ? "Spielleitung" : user.name;
      if (!names.includes(name)) names.push(name);
      return names;
    }, []);
    const whisperLabel = root.querySelector(".whisper-to");
    if (whisperLabel && recipients.length) {
      const prefix = whisperLabel.textContent.match(/^\s*([^:]+:)/)?.[1] ?? "An:";
      whisperLabel.textContent = `${prefix} ${recipients.join(", ")}`;
    }
  });
}

function getIntegrationData(currencies) {
  const methods = game.itempiles.CONSTANTS.ITEM_TYPE_METHODS;
  return {
    VERSION: getModuleVersion(),
    ACTOR_CLASS_TYPE: "pc",
    ITEM_CLASS_LOOT_TYPE: "sundry",
    ITEM_CLASS_WEAPON_TYPE: "weapon",
    ITEM_CLASS_EQUIPMENT_TYPE: "gear",
    ITEM_QUANTITY_ATTRIBUTE: "system.quantity",
    ITEM_PRICE_ATTRIBUTE: "system.price.value",
    QUANTITY_FOR_PRICE_ATTRIBUTE: "flags.item-piles.system.quantityForPrice",
    ITEM_FILTERS,
    ITEM_SIMILARITIES,
    UNSTACKABLE_ITEM_TYPES,
    CURRENCIES: currencies,
    CURRENCY_DECIMAL_DIGITS: 1e-5,
    PILE_DEFAULTS: {},

    ITEM_TRANSFORMER: itemData => {
      if (itemData?.flags?.["black-flag"]?.relationship?.attuned) {
        foundry.utils.setProperty(itemData, "flags.black-flag.relationship.attuned", false);
      }
      return itemData;
    },

    PRICE_MODIFIER_TRANSFORMER: ({ buyPriceModifier, sellPriceModifier } = {}) => ({
      buyPriceModifier,
      sellPriceModifier
    }),

    ITEM_COST_TRANSFORMER: getItemCost,

    ITEM_TYPE_HANDLERS: {
      GLOBAL: {
        [methods.IS_CONTAINED]: ({ item }) => {
          const itemData = item instanceof Item ? item.toObject() : item;
          return itemData?.system?.container;
        },
        [methods.IS_CONTAINED_PATH]: "system.container"
      },
      container: {
        [methods.HAS_CURRENCY]: true,
        [methods.CONTENTS]: ({ item }) => {
          if (!item.parent) return [];
          return item.parent.items.filter(entry => entry.system.container === item.id);
        },
        [methods.TRANSFER]: ({ item, items, raw = false } = {}) => {
          if (!item.parent) return items;
          const contents = item.parent.items
            .filter(entry => entry.system.container === item.id)
            .map(entry => raw ? entry : entry.toObject());
          return [...items, ...contents];
        }
      }
    },

    VAULT_STYLES: [
      { path: "system.rarity", value: "artifact", styling: { "box-shadow": "inset 0 0 7px rgba(255,191,0,1)" } },
      { path: "system.rarity", value: "legendary", styling: { "box-shadow": "inset 0 0 7px rgba(255,119,0,1)" } },
      { path: "system.rarity", value: "veryRare", styling: { "box-shadow": "inset 0 0 7px rgba(255,0,247,1)" } },
      { path: "system.rarity", value: "rare", styling: { "box-shadow": "inset 0 0 7px rgba(0,136,255,1)" } },
      { path: "system.rarity", value: "uncommon", styling: { "box-shadow": "inset 0 0 7px rgba(0,255,9,1)" } }
    ],

    SYSTEM_HOOKS: installChatCompatibility
  };
}

async function persistSettings(currencies) {
  if (!game.user?.isGM) return;
  const api = game.itempiles.API;
  await api.setActorClassType("pc");
  await api.setItemQuantityAttribute("system.quantity");
  await api.setItemPriceAttribute("system.price.value");
  await api.setItemFilters(ITEM_FILTERS);
  await api.setItemSimilarities(ITEM_SIMILARITIES);
  await api.setUnstackableItemTypes(UNSTACKABLE_ITEM_TYPES);
  await api.setPileDefaults({});
  if (currencies.length) {
    await api.setCurrencies(currencies);
    console.log(`${MODULE_ID} | Synchronized ${currencies.length} Item Piles currencies: ${currencies.map(c => c.abbreviation.replace("{#}", "")).join(", ")}`);
  }
}

async function persistSettingsSafely() {
  if (currencySyncPromise) return currencySyncPromise;
  currencySyncPromise = (async () => {
    try {
      await persistSettings(await buildCurrencies());
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to persist Item Piles settings.`, error);
      ui.notifications.error(game.i18n.format("BFI.ItemPiles.Error", { message: error.message }));
    } finally {
      currencySyncPromise = undefined;
    }
  })();
  return currencySyncPromise;
}

function installCurrencySyncHook() {
  if (currencyHookInstalled) return;
  currencyHookInstalled = true;
  const synchronize = async () => {
    try {
      await normalizeBlackFlagCurrencies();
      if (game.itempiles?.API) await persistSettingsSafely();
    } catch (error) {
      console.error(`${MODULE_ID} | Failed to normalize registered currencies.`, error);
    }
  };
  if (CONFIG.BlackFlag?.registration?.ready) synchronize();
  else Hooks.once("blackFlag.registrationComplete", synchronize);
}

async function registerIntegration() {
  if (game.system.id !== "black-flag" || !game.itempiles?.API) return;
  if (registrationPromise) return registrationPromise;

  registrationPromise = (async () => {
    if (game.modules.get("item-piles-black-flag")?.active) {
      ui.notifications.warn(game.i18n.localize("BFI.ItemPiles.AdapterConflict"), { permanent: true });
      console.warn(`${MODULE_ID} | Disable item-piles-black-flag; this module now provides that integration.`);
    }

    // Item Piles checks system support shortly after ready. Static UUID
    // descriptors pass its validation without resolving Currency documents
    // and therefore cannot race Black Flag's central Compendium indexing.
    // An empty array is unsafe because Item Piles merges arrays index-wise
    // with its current defaults. The authoritative list is persisted after
    // blackFlag.registrationComplete.
    game.itempiles.API.addSystemIntegration(getIntegrationData(EARLY_CURRENCIES));
    installCurrencySyncHook();

    console.log(`${MODULE_ID} | Item Piles integration registered with early system support.`);
  })().catch(error => {
    registrationPromise = undefined;
    console.error(`${MODULE_ID} | Item Piles integration failed.`, error);
    ui.notifications.error(game.i18n.format("BFI.ItemPiles.Error", { message: error.message }));
  });
  return registrationPromise;
}

Hooks.once("init", () => {
  if (game.system.id !== "black-flag" || !game.modules.get("item-piles")?.active) return;
  installChatCompatibility();
  Hooks.once("item-piles-ready", registerIntegration);
  // When Item Piles happened to initialize first, register immediately.
  // Otherwise setup and item-piles-ready provide safe optional fallbacks.
  if (game.itempiles?.API) registerIntegration();
});

// Item Piles exposes its API during init. Registering in setup makes Black Flag
// a supported system before Item Piles fires item-piles-ready and checks its
// system data during ready.
Hooks.once("setup", registerIntegration);
