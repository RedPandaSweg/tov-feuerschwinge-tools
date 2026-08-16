import { MODULE_ID } from "../core/constants.mjs";
import { selectCharacters } from "../character-picker.mjs";
import { getSystemAdapter } from "../downtime/system-adapter.mjs";
import { formatCopper, itemQuantity, priceInCopper, purse, quantityForPrice } from "./currency.mjs";
import { broadcastPeerTrade, commerceRequest } from "./socket.mjs";
import { AUCTION_HOUSE_FLAG, commerceState, isAuctionHouse, merchantAccess, merchantAllowsActor, merchantAvailableToUser, merchantConfig, ownedCharacters } from "./service.mjs";
import { addItem, cleanTransferredItem } from "./transactions.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const TRADEABLE_TYPES = new Set(["ammunition", "armor", "consumable", "container", "gear", "sundry", "tool", "weapon"]);
const COIN_FALLBACKS = Object.freeze({
  pp: "icons/commodities/currency/coin-embossed-skull-silver.webp",
  gp: "icons/commodities/currency/coin-inset-insect-gold.webp",
  sp: "icons/commodities/currency/coin-inset-snail-silver.webp",
  cp: "icons/commodities/currency/coin-oval-rune-copper.webp"
});
const liveTrades = new Map();

function merchantAccessOptions() {
  return { sceneId: globalThis.canvas?.scene?.id ?? null };
}

function tradeOwnedSide(trade) {
  if (actorOwned(trade?.fromActorId)) return "from";
  if (actorOwned(trade?.toActorId)) return "to";
  return null;
}

function storePeerTrade(trade) {
  if (!trade?.id) return null;
  const copy = foundry.utils.deepClone(trade);
  liveTrades.set(copy.id, copy);
  return copy;
}

function publishPeerTrade(event, trade, side = null) {
  trade.revision = Number(trade.revision || 0) + 1;
  trade.updatedAt = Date.now();
  storePeerTrade(trade);
  broadcastPeerTrade(event, trade, side);
}

function wallet(actor) {
  const entries = purse(actor);
  return ["pp", "gp", "sp", "cp"].map(id => ({
    id,
    quantity: entries.get(id)?.quantity ?? 0,
    img: entries.get(id)?.item?.img || COIN_FALLBACKS[id]
  }));
}

function priceCoins(item, multiplier) {
  let id = String(item?.system?.price?.denomination ?? "gp").toLowerCase();
  let quantity = Math.max(0, Number(item?.system?.price?.value ?? 0) * Number(multiplier || 0));
  if (id === "pp") {
    id = "gp";
    quantity *= 10;
  }
  if (!(["gp", "sp", "cp"].includes(id))) id = "gp";
  while (Math.abs(quantity - Math.round(quantity)) > 1e-8 && id !== "cp") {
    quantity *= 10;
    id = id === "gp" ? "sp" : "cp";
  }
  quantity = Math.round(quantity);
  return [{ id, quantity, img: COIN_FALLBACKS[id] }];
}

function copperPriceCoins(copper) {
  const value = Math.max(0, Math.round(Number(copper) || 0));
  const id = value % 100 === 0 ? "gp" : value % 10 === 0 ? "sp" : "cp";
  return [{ id, quantity: value / ({ gp: 100, sp: 10, cp: 1 })[id], img: COIN_FALLBACKS[id] }];
}

function remainingTime(endsAt) {
  const minutes = Math.max(0, Math.ceil((endsAt - Date.now()) / 60000));
  if (minutes >= 1440) return `${Math.ceil(minutes / 1440)} T.`;
  if (minutes >= 60) return `${Math.ceil(minutes / 60)} Std.`;
  return `${minutes} Min.`;
}

function localize(value, fallback) {
  if (!value) return fallback;
  const translated = game.i18n.localize(value);
  return translated === value ? fallback : translated;
}

function humanizeIdentifier(value) {
  return String(value ?? "")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map(word => word ? `${word[0].toLocaleUpperCase()}${word.slice(1)}` : "")
    .join(" ");
}

function subtypeName(item, subtype) {
  const configNames = {
    ammunition: ["ammunition"],
    consumable: ["consumableCategories"],
    gear: ["gearCategories"],
    sundry: ["sundryCategories"],
    armor: ["armor", "armorCategories"],
    container: ["containerCategories"],
    tool: ["toolCategories", "tools"],
    weapon: ["weaponCategories", "weapons"]
  };
  for (const configName of configNames[item.type] ?? []) {
    const config = CONFIG.BlackFlag?.[configName];
    const localized = config?.localized?.[subtype];
    if (localized) return localize(localized, humanizeIdentifier(subtype));
    const entry = config?.[subtype];
    if (entry?.label || entry?.localization) return localize(entry.label ?? entry.localization, humanizeIdentifier(subtype));
  }
  return humanizeIdentifier(subtype);
}

function categoryData(item) {
  const typeLabel = localize(CONFIG.Item?.typeLabels?.[item.type], item.type.titleCase());
  const category = String(item.system?.type?.category ?? "").trim();
  const rarity = String(item.system?.rarity ?? "").trim();
  const rarityLabel = rarity ? localize(CONFIG.BlackFlag?.rarities?.localized?.[rarity], humanizeIdentifier(rarity)) : "";
  const categoryResult = (parts, labels) => ({
    id: [rarity ? `rarity=${rarity}` : "", ...parts].filter(Boolean).join(":"),
    label: [rarityLabel, ...labels].filter(Boolean).join(" – ")
  });
  if (item.type === "tool") {
    const toolValue = String(item.system?.type?.value ?? "").trim();
    const toolClassification = `${category} ${toolValue}`.replace(/[^a-z]/gi, "").toLocaleLowerCase();
    if (toolClassification.includes("gamingset")) return categoryResult([item.type, "gamingSet"], [typeLabel, "Gaming Sets"]);
    if (toolClassification.includes("musicalinstrument")) return categoryResult([item.type, "musicalInstrument"], [typeLabel, "Musical Instruments"]);
    return categoryResult([item.type], [typeLabel]);
  }
  if (item.type === "weapon") {
    const weaponType = String(item.system?.type?.value ?? "").trim();
    const labels = [category ? subtypeName(item, category) : ""];
    if (weaponType) labels.push(localize(CONFIG.BlackFlag?.weaponTypes?.localized?.[weaponType], humanizeIdentifier(weaponType)));
    const suffix = labels.filter(Boolean);
    return categoryResult([item.type, category, weaponType], [typeLabel, ...suffix]);
  }
  const subtypeLabel = category ? subtypeName(item, category) : "";
  return categoryResult([item.type, category], [typeLabel, subtypeLabel]);
}

function inventoryEntries(actor, multiplier, config, { management = false, discounts = false } = {}) {
  if (!actor) return [];
  return actor.items.filter(item => item.type !== "currency" && TRADEABLE_TYPES.has(item.type)).map(item => {
    const category = categoryData(item);
    const itemConfig = item.getFlag(MODULE_ID, "merchantItem") ?? {};
    const hidden = itemConfig.hidden === true;
    const discountPercent = discounts ? Math.clamp(Number(itemConfig.discountPercent) || 0, 0, 100) : 0;
    const quantity = itemQuantity(item);
    const originalPriceCopper = priceInCopper(item, multiplier);
    const effectiveMultiplier = multiplier * (1 - discountPercent / 100);
    const effectivePriceCopper = Math.round(originalPriceCopper * (1 - discountPercent / 100));
    const priceQuantity = quantityForPrice(item);
    const detailLabel = [config.displayQuantity ? `${quantity} verfügbar` : "", priceQuantity > 1 ? `Preis für ${priceQuantity}` : ""].filter(Boolean).join(" · ");
    return { id: item.id, actorId: actor.id, name: item.name, img: item.img, quantity, quantityForPrice: priceQuantity, detailLabel, categoryId: category.id,
      categoryLabel: category.label, hidden, visible: management || (!hidden && (config.showZeroQuantity || quantity > 0)),
      discounted: discountPercent > 0, discountPercent, originalPrice: formatCopper(originalPriceCopper),
      originalPriceCoins: priceCoins(item, multiplier), priceCopper: effectivePriceCopper,
      price: formatCopper(effectivePriceCopper), priceCoins: priceCoins(item, effectiveMultiplier) };
  });
}

function filtered(entries, category, search) {
  const term = String(search ?? "").trim().toLocaleLowerCase();
  return entries.filter(entry => entry.visible && (!category || entry.categoryId === category) && (!term || entry.name.toLocaleLowerCase().includes(term)));
}

function categories(entries) {
  return [...new Map(entries.map(entry => [entry.categoryId, entry.categoryLabel])).entries()]
    .map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label, "de"));
}

function groupedInventory(entries, sort = "type") {
  const compare = sort === "price"
    ? (a, b) => a.priceCopper - b.priceCopper || a.name.localeCompare(b.name, "de")
    : (a, b) => a.name.localeCompare(b.name, "de");
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.categoryId;
    if (!groups.has(key)) groups.set(key, { id: key, label: entry.categoryLabel, items: [] });
    groups.get(key).items.push(entry);
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "de"))
    .map(group => ({ ...group, items: group.items.sort(compare) }));
}

async function numberPrompt({ title, label, value = 1, min = 1, step = 1 }) {
  return foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title },
    content: `<div class="form-group"><label for="tovf-commerce-number">${label}</label><input id="tovf-commerce-number" name="value" type="number" value="${value}" min="${min}" step="${step}"></div>`,
    ok: { label: "Bestätigen", callback: (_event, button) => Number(button.form.elements.value.value) }, rejectClose: false });
}

async function itemsFromTable(table, count, { quantityMin = 1, quantityMax = 1 } = {}) {
  const draw = await table.drawMany(count, { displayChat: false });
  const items = new Map();
  const minimum = Math.max(1, Math.floor(Number(quantityMin) || 1));
  const maximum = Math.max(minimum, Math.floor(Number(quantityMax) || minimum));
  for (const result of draw.results ?? []) {
    const uuid = result.documentUuid ?? (result.documentCollection && result.documentId ? `${result.documentCollection}.${result.documentId}` : "");
    const document = uuid ? await fromUuid(uuid) : null;
    if (document?.documentName !== "Item" || !TRADEABLE_TYPES.has(document.type)) continue;
    const quantity = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
    const entry = items.get(document.uuid);
    if (entry) entry.quantity += quantity;
    else items.set(document.uuid, { document, quantity });
  }
  return [...items.values()];
}

async function itemFromDrop(event) {
  let data;
  try { data = JSON.parse(event.dataTransfer?.getData("text/plain") || "{}"); } catch { return null; }
  const item = data.uuid ? await fromUuid(data.uuid) : data.type === "Item" && data.id ? game.items.get(data.id) : null;
  return item?.documentName === "Item" && TRADEABLE_TYPES.has(item.type) ? item : null;
}

async function requirementItemFromDrop(event) {
  const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
  const item = data.uuid ? await fromUuid(data.uuid) : null;
  return item?.documentName === "Item" ? item : null;
}

function openItemPreview(source) {
  const data = foundry.utils.deepClone(source?.toObject ? source.toObject() : source);
  if (!data) return false;
  delete data._id;
  delete data.folder;
  data.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER };
  const item = new CONFIG.Item.documentClass(data, { parent: null });
  item.sheet.render(true);
  return true;
}

function requiredItemData(item) {
  return item ? {
    uuid: item.uuid,
    type: item.type,
    identifier: String(item.system?.identifier?.value ?? item.system?.identifier ?? item.identifier ?? "").trim(),
    name: item.name,
    img: item.img
  } : null;
}

async function configureMerchantRequirements(actor) {
  const current = merchantConfig(actor);
  const options = getSystemAdapter().getCharacterRewardOptions();
  const esc = foundry.utils.escapeHTML;
  const selectedLanguages = new Set(current.requiredLanguages);
  const selectedProficiencies = new Set(current.requiredProficiencies);
  const languageOptions = (options.language ?? []).map(option =>
    `<label><input type="checkbox" name="languages" value="${esc(option.key)}" ${selectedLanguages.has(option.key) ? "checked" : ""}><span>${esc(option.label)}</span></label>`).join("");
  const typeLabels = { skill: "Skills", tool: "Tools", weapon: "Waffen", armor: "Rüstungen" };
  const proficiencyOptions = ["skill", "tool", "weapon", "armor"].map(type => {
    return (options[type] ?? []).map(option => {
      const value = `${type}:${option.key}`;
      return `<label><input type="checkbox" name="proficiencies" value="${esc(value)}" ${selectedProficiencies.has(value) ? "checked" : ""}><span>${typeLabels[type]} — ${esc(option.label)}</span></label>`;
    }).join("");
  }).join("");
  let requiredItem = current.requiredItem;
  const itemMarkup = () => requiredItem
    ? `<img src="${esc(requiredItem.img || "icons/svg/item-bag.svg")}" alt=""><span><strong>${esc(requiredItem.name)}</strong><small>${esc(requiredItem.type)}</small></span><button type="button" data-remove-required-item title="Entfernen"><i class="fa-solid fa-xmark"></i></button>`
    : '<i class="fa-solid fa-box-open"></i><span>Item, Spell oder Feature hierher ziehen</span>';
  const content = `<div class="standard-form tovf-merchant-requirements">
    <p class="hint">Ein Charakter muss alle ausgewählten Voraussetzungen erfüllen. Leere Felder schränken den Zugriff nicht ein.</p>
    <div class="form-group stacked"><label>Erforderliche Sprachen</label><details class="tovf-requirement-picker" data-requirement-picker><summary><span data-picker-label>Sprachen auswählen</span><i class="fa-solid fa-chevron-down"></i></summary><div>${languageOptions || "<em>Keine Sprachen verfügbar.</em>"}</div></details></div>
    <div class="form-group stacked"><label>Erforderliche Proficiencies</label><details class="tovf-requirement-picker" data-requirement-picker><summary><span data-picker-label>Proficiencies auswählen</span><i class="fa-solid fa-chevron-down"></i></summary><div>${proficiencyOptions || "<em>Keine Proficiencies verfügbar.</em>"}</div></details></div>
    <div class="form-group stacked"><label>Erforderliches Item</label><div class="tovf-merchant-requirement-drop" data-required-item-drop>${itemMarkup()}</div></div>
    <div class="form-group stacked"><label>Nachricht bei verweigertem Zugriff</label><prose-mirror name="deniedMessage" value="${esc(current.accessDeniedMessage)}" data-document-uuid="${actor.uuid}" class="description"></prose-mirror></div>
  </div>`;
  return foundry.applications.api.DialogV2.prompt({
    classes: ["tovf-commerce-dialog", "tovf-merchant-requirements-dialog"],
    window: { title: `Voraussetzungen: ${actor.name}` }, position: { width: 620, height: 720 }, content,
    render: (_event, dialog) => {
      const drop = dialog.element.querySelector("[data-required-item-drop]");
      const refresh = () => { drop.innerHTML = itemMarkup(); };
      for (const picker of dialog.element.querySelectorAll("[data-requirement-picker]")) {
        const updateLabel = () => {
          const checked = [...picker.querySelectorAll('input[type="checkbox"]:checked')];
          picker.querySelector("[data-picker-label]").textContent = checked.length
            ? checked.length === 1 ? checked[0].nextElementSibling.textContent : `${checked.length} ausgewählt`
            : picker.querySelector('input[name="languages"]') ? "Sprachen auswählen" : "Proficiencies auswählen";
        };
        picker.addEventListener("change", updateLabel);
        updateLabel();
      }
      drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("dragover"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
      drop.addEventListener("drop", async event => {
        event.preventDefault(); drop.classList.remove("dragover");
        const item = await requirementItemFromDrop(event);
        if (!item) return ui.notifications.warn("Bitte ein Item, einen Spell oder ein Feature ablegen.");
        requiredItem = requiredItemData(item); refresh();
      });
      drop.addEventListener("click", event => {
        if (!event.target.closest("[data-remove-required-item]")) return;
        requiredItem = null; refresh();
      });
    },
    ok: { label: "Speichern", callback: (_event, button) => ({
      requiredLanguages: [...button.form.querySelectorAll('input[name="languages"]:checked')].map(input => input.value),
      requiredProficiencies: [...button.form.querySelectorAll('input[name="proficiencies"]:checked')].map(input => input.value),
      requiredItem,
      accessDeniedMessage: button.form.querySelector('prose-mirror[name="deniedMessage"]')?.value ?? ""
    }) }, rejectClose: false
  });
}

function merchantAccessProblem(merchant) {
  const characters = ownedCharacters(game.user);
  if (!characters.length) return "Du hast keinen Charakter, mit dem du auf diesen Händler zugreifen kannst.";

  const options = merchantAccessOptions();
  const config = merchantConfig(merchant);
  const access = characters.map(actor => ({ actor, ...merchantAccess(merchant, actor, game.user, options) }));
  const rangeOnly = access.filter(result => (
    result.reasons.includes("distance") && result.reasons.every(reason => reason === "distance")
  ));
  if (!config.requireInteractionRange || !rangeOnly.length) return "";

  const scene = game.scenes.get(options.sceneId);
  if (!scene) return "Es ist keine aktive Szene vorhanden, auf der die Entfernung zum Händler geprüft werden kann.";
  if (![...scene.tokens].some(token => token.actorId === merchant.id)) {
    return "Der Händler hat auf der aktuellen Szene keinen Token. Die benötigte Reichweite kann deshalb nicht geprüft werden.";
  }
  if (!rangeOnly.some(({ actor }) => [...scene.tokens].some(token => token.actorId === actor.id))) {
    return "Keiner deiner berechtigten Charaktere hat auf der aktuellen Szene einen Token. Stelle einen Charaktertoken auf die Szene und versuche es erneut.";
  }
  return `Dein Charaktertoken ist zu weit vom Händler entfernt. Er muss sich innerhalb von ${config.interactionRange} ${config.interactionRange === 1 ? "Feld" : "Feldern"} befinden.`;
}

async function showMerchantAccessDenied(merchant) {
  const configured = merchantConfig(merchant).accessDeniedMessage;
  const problem = merchantAccessProblem(merchant);
  const source = problem
    ? `<p>${foundry.utils.escapeHTML(problem)}</p>`
    : configured || `<p><strong>${foundry.utils.escapeHTML(merchant.name)}</strong> steht diesem Charakter nicht zur Verfügung.</p>`;
  const content = await foundry.applications.ux.TextEditor.implementation.enrichHTML(source, { async: true, relativeTo: merchant });
  return foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: "Zugriff verweigert" },
    content: `<div class="tovf-merchant-access-denied">${content}</div>`, ok: { label: "Schließen" }, rejectClose: false });
}

async function composeTradeRequest(actor) {
  let wanted = null;
  const offered = new Map();
  const esc = foundry.utils.escapeHTML;
  const content = `<div class="tovf-request-composer"><section><h3>Gesuchter Gegenstand</h3><div class="tovf-request-drop wanted" data-drop="wanted"><i class="fa-solid fa-magnifying-glass"></i><span>Item hierher ziehen</span></div><div class="tovf-request-wanted"></div></section><section><h3>Gegenleistung</h3><div class="tovf-request-drop offered" data-drop="offered"><i class="fa-solid fa-hand-holding"></i><span>Eigene Items hierher ziehen</span><small>Beliebig viele Gegenstände möglich</small></div><div class="tovf-request-offered-items"></div><label class="tovf-request-gold">Zusätzliches Gold <span><input name="gold" type="number" value="0" min="0" step="0.01"> gp</span></label></section><p class="hint"><i class="fa-solid fa-lock"></i> Die Gegenleistung wird bis zur Erfüllung oder Rücknahme reserviert.</p></div>`;
  const refresh = dialog => {
    const root = dialog.element.querySelector(".tovf-request-composer"); if (!root) return;
    root.querySelector(".tovf-request-wanted").innerHTML = wanted ? `<article><img src="${esc(wanted.img)}"><span><b>${esc(wanted.name)}</b><small>${esc(wanted.type)}</small></span><label>Menge <input name="wantedQuantity" type="number" value="1" min="1"></label><button type="button" data-remove-wanted title="Entfernen"><i class="fa-solid fa-xmark"></i></button></article>` : "";
    root.querySelector(".tovf-request-drop.wanted").hidden = !!wanted;
    root.querySelector(".tovf-request-offered-items").innerHTML = [...offered.values()].map(entry => `<article data-item-id="${entry.item.id}"><img src="${esc(entry.item.img)}"><span><b>${esc(entry.item.name)}</b><small>Verfügbar: ${itemQuantity(entry.item)}</small></span><label>Menge <input data-offer-quantity type="number" value="${entry.quantity}" min="1" max="${itemQuantity(entry.item)}"></label><button type="button" data-remove-offer title="Entfernen"><i class="fa-solid fa-xmark"></i></button></article>`).join("");
    const gold = Number(root.querySelector('[name="gold"]')?.value) || 0;
    dialog.element.querySelector('button[data-action="ok"]').disabled = !wanted || (!offered.size && gold <= 0);
  };
  return foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog", "tovf-request-composer-dialog"], window: { title: "Handelsgesuch erstellen" }, position: { width: 640, height: 510 }, content,
    render: (_event, dialog) => {
      const root = dialog.element.querySelector(".tovf-request-composer");
      for (const zone of root.querySelectorAll("[data-drop]")) {
        zone.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("dragover"); });
        zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
        zone.addEventListener("drop", async event => {
          event.preventDefault(); zone.classList.remove("dragover"); const item = await itemFromDrop(event);
          if (!item) return ui.notifications.warn("Bitte einen handelbaren Gegenstand ablegen.");
          if (zone.dataset.drop === "wanted") wanted = item;
          else {
            if (item.parent?.id !== actor.id) return ui.notifications.warn("Als Gegenleistung können nur Gegenstände dieses Charakters verwendet werden.");
            const existing = offered.get(item.id); offered.set(item.id, { item, quantity: Math.min(itemQuantity(item), (existing?.quantity ?? 0) + 1) });
          }
          refresh(dialog);
        });
      }
      root.addEventListener("click", event => {
        if (event.target.closest("[data-remove-wanted]")) wanted = null;
        const offer = event.target.closest("[data-remove-offer]")?.closest("[data-item-id]"); if (offer) offered.delete(offer.dataset.itemId);
        refresh(dialog);
      });
      root.addEventListener("input", event => {
        const row = event.target.closest("[data-item-id]");
        if (row && event.target.matches("[data-offer-quantity]")) offered.get(row.dataset.itemId).quantity = Math.max(1, Math.floor(Number(event.target.value) || 1));
        else refresh(dialog);
      });
      refresh(dialog);
    },
    ok: { label: "Gesuch einstellen", callback: (_event, button) => {
      const wantedQuantity = Math.max(1, Math.floor(Number(button.form.elements.wantedQuantity?.value) || 1));
      const gold = Math.max(0, Number(button.form.elements.gold?.value) || 0);
      return { wanted, wantedQuantity, gold, offeredItems: [...offered.values()].map(entry => ({ itemId: entry.item.id, quantity: entry.quantity })) };
    } }, rejectClose: false });
}

export async function configureMerchantActor(actor, app = null) {
  if (!game.user.isGM || !actor) return;
  const current = merchantConfig(actor);
  await actor.setFlag(MODULE_ID, "merchant", { ...current, enabled: true });
  app?.render?.();
  return openCommerce({ mode: "merchant", merchantId: actor.id, shopPage: "management" });
}

export async function configureAuctionHouseActor(actor, app = null) {
  if (!game.user.isGM || !actor) return;
  await actor.setFlag(MODULE_ID, AUCTION_HOUSE_FLAG, { enabled: true });
  app?.render?.();
  return openCommerce({ mode: "auction", auctionHouseId: actor.id });
}

class CommerceApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = { id: "tovf-commerce", classes: ["tovf-commerce"], position: { width: 1040, height: 760 },
    window: { title: "Handel", icon: "fa-solid fa-scale-balanced", resizable: true }, actions: {
      changeMode: this.#changeMode, changeShopPage: this.#changeShopPage, buy: this.#buy, sell: this.#sell,
      createAuction: this.#createAuction, bid: this.#bid, buyout: this.#buyout, createTrade: this.#createTrade,
      acceptTrade: this.#acceptTrade, cancelTrade: this.#cancelTrade, configureMerchant: this.#configureMerchant,
      saveMerchantSettings: this.#saveMerchantSettings,
      selectMerchantCharacters: this.#selectMerchantCharacters,
      configureMerchantRequirements: this.#configureMerchantRequirements,
      deleteMerchantItem: this.#deleteMerchantItem, clearMerchantItems: this.#clearMerchantItems,
      toggleMerchantItem: this.#toggleMerchantItem, populateFromTable: this.#populateFromTable,
      chooseMerchantImage: this.#chooseMerchantImage, openMerchantItem: this.#openMerchantItem,
      setItemDiscount: this.#setItemDiscount, setItemPriceQuantity: this.#setItemPriceQuantity, openAuctionItem: this.#openAuctionItem
      , changeAuctionPage: this.#changeAuctionPage, createRequest: this.#createRequest,
      fulfillRequest: this.#fulfillRequest, cancelRequest: this.#cancelRequest, openRequestItem: this.#openRequestItem
      , acceptTradeInvite: this.#acceptTradeInvite, tradeRemoveItem: this.#tradeRemoveItem, tradeSetMoney: this.#tradeSetMoney,
      confirmTrade: this.#confirmTrade, openTradeItem: this.#openTradeItem
      , cancelAuction: this.#cancelAuction, editAuctionDescription: this.#editAuctionDescription,
      editMerchantDescription: this.#editMerchantDescription
    } };
  static PARTS = { main: { template: `modules/${MODULE_ID}/templates/commerce.hbs` } };
  constructor(options = {}) { super(options); this.mode = options.mode ?? "merchant"; this.shopPage = options.shopPage ?? "buy";
    this.actorId = options.actorId ?? null; this.merchantId = options.merchantId ?? null; this.auctionHouseId = options.auctionHouseId ?? null;
    this.category = ""; this.search = ""; this.sort = "type"; this.auctionPage = options.auctionPage ?? "auctions"; this.tradeId = options.tradeId ?? null;
    this.merchantSessionId = foundry.utils.randomID(); }
  _onRender(context, options) {
    super._onRender(context, options);
    for (const [selector, property] of [["[name=actorId]", "actorId"], ["[name=merchantId]", "merchantId"], ["[name=category]", "category"], ["[name=sort]", "sort"]]) {
      this.element.querySelector(selector)?.addEventListener("change", event => {
        this[property] = event.currentTarget.value;
        if (property === "merchantId") this.merchantSessionId = foundry.utils.randomID();
        void this.render({ force: true });
      });
    }
    this.element.querySelector("[name=search]")?.addEventListener("input", foundry.utils.debounce(event => {
      this.search = event.target.value; void this.render({ force: true });
    }, 180));
    if (this.mode === "merchant" && context.managementPage) {
      for (const discountButton of this.element.querySelectorAll('[data-action="setItemDiscount"]')) {
        const item = this._merchant()?.items.get(discountButton.dataset.itemId);
        discountButton.insertAdjacentHTML("beforebegin", `<button type="button" data-action="setItemPriceQuantity" data-item-id="${discountButton.dataset.itemId}" title="Menge pro Preiseinheit festlegen (aktuell ${quantityForPrice(item)})"><i class="fa-solid fa-boxes-stacked"></i></button>`);
      }
      const content = this.element.querySelector(".tovf-merchant-content");
      const stockTools = content?.querySelector(".tovf-merchant-stock-tools");
      if (content && stockTools) {
        stockTools.insertAdjacentHTML("afterend", '<div class="tovf-merchant-inventory-drop"><i class="fa-solid fa-box-open"></i><span>Items hierher ziehen, um sie dem Händler hinzuzufügen</span></div>');
        const dropzone = content.querySelector(".tovf-merchant-inventory-drop");
        content.addEventListener("dragover", event => { event.preventDefault(); dropzone.classList.add("dragover"); });
        content.addEventListener("dragleave", event => { if (!content.contains(event.relatedTarget)) dropzone.classList.remove("dragover"); });
        content.addEventListener("drop", async event => {
          event.preventDefault(); dropzone.classList.remove("dragover");
          const item = await itemFromDrop(event);
          if (!item) return ui.notifications.warn("Nur handelbare Equipment-Items können einem Händler hinzugefügt werden.");
          const merchant = this._merchant(); if (!merchant) return;
          const quantity = Math.max(1, itemQuantity(item));
          await addItem(merchant, cleanTransferredItem(item, quantity), quantity);
          ui.notifications.info(`${quantity}× ${item.name} wurde dem Händler hinzugefügt.`);
          await this.render({ force: true });
        });
      }
    }
    if (this.mode === "auction") this._renderAuctionNavigation(context);
    if (this.mode === "trade") {
      this.element.querySelector(".tovf-commerce-character")?.setAttribute("hidden", "");
      this._renderLiveTrade(context);
      const tradeWindowTooSmall = this.position.width < 840 || this.position.height < 500;
      const tradeWindowTooLarge = this.position.width > 900 || this.position.height > 540;
      if (tradeWindowTooSmall || tradeWindowTooLarge) this.setPosition({ width: 840, height: 500 });
    }
    else if (this.position.width < 900 || this.position.height < 680) this.setPosition({ width: 1040, height: 760 });
  }
  _renderAuctionNavigation(context) {
    const content = this.element.querySelector(".tovf-auction-content"); if (!content) return;
    const esc = foundry.utils.escapeHTML;
    const tabs = `<nav class="tovf-auction-page-tabs"><button type="button" class="${this.auctionPage === "auctions" ? "active" : ""}" data-action="changeAuctionPage" data-page="auctions"><i class="fa-solid fa-gavel"></i> Auktionen</button><button type="button" class="${this.auctionPage === "requests" ? "active" : ""}" data-action="changeAuctionPage" data-page="requests"><i class="fa-solid fa-magnifying-glass-dollar"></i> Handelsgesuche</button></nav>`;
    content.querySelector(":scope > .tovf-auction-page-tabs")?.remove();
    content.querySelector(":scope > header")?.insertAdjacentHTML("afterend", tabs);
    const sidebar = this.element.querySelector(".tovf-auction-shell > .tovf-merchant-sidebar");
    if (sidebar && !sidebar.querySelector(".tovf-auction-sidebar-nav")) sidebar.insertAdjacentHTML("beforeend", tabs.replace("tovf-auction-page-tabs", "tovf-auction-sidebar-nav"));
    if (sidebar && game.user.isGM && context.auctionHouse) {
      const heading = sidebar.querySelector(":scope > h2");
      if (heading && !sidebar.querySelector(".tovf-auction-house-heading")) heading.outerHTML = `<div class="tovf-auction-house-heading"><h2>${esc(context.auctionHouse.name)}</h2><button type="button" data-action="editAuctionDescription" title="Auktionshaus bearbeiten" aria-label="Auktionshaus bearbeiten"><i class="fa-solid fa-gear"></i></button></div>`;
    }
    if (this.auctionPage === "auctions") for (const auction of context.auctions) {
      if (!auction.canCancel) continue;
      const actions = content.querySelector(`[data-auction-id="${auction.id}"]`)?.closest("article")?.querySelector(".tovf-shop-actions");
      if (actions) actions.insertAdjacentHTML("beforeend", `<button type="button" data-action="cancelAuction" data-auction-id="${auction.id}" title="Auktion zurückziehen"><i class="fa-solid fa-trash"></i></button>`);
    }
    if (this.auctionPage !== "requests") return;
    const heading = content.querySelector(":scope > header");
    if (heading) heading.innerHTML = `<div><h2>Handelsgesuche</h2><small>${context.requests.length} Gesuche</small></div><button type="button" data-action="createRequest"><i class="fa-solid fa-plus"></i> Gesuch erstellen</button>`;
    const search = content.querySelector("[name=search]"); if (search) search.placeholder = "Handelsgesuche durchsuchen …";
    const category = content.querySelector("[name=category]");
    if (category) category.innerHTML = `<option value="">Alle Typen</option>${context.requestCategories.map(entry => `<option value="${esc(entry.id)}" ${entry.id === this.category ? "selected" : ""}>${esc(entry.label)}</option>`).join("")}`;
    const list = content.querySelector(".tovf-auction-list"); if (!list) return;
    list.className = "tovf-request-list";
    const rows = context.requests.map(request => `<article><button type="button" class="tovf-shop-item-open" data-action="openRequestItem" data-request-id="${request.id}"><img src="${esc(request.wantedItem.img ?? "icons/svg/item-bag.svg")}"><span><b>${request.wantedQuantity}× ${esc(request.wantedItem.name)}</b><small>${esc(request.categoryLabel)}</small></span></button><span class="tovf-auction-seller">${esc(request.requester)}</span><div class="tovf-request-offer">${request.hasMoney ? `<strong class="tovf-shop-price">${request.offeredCoins.map(coin => `<span><b>${coin.quantity}</b><img src="${coin.img}" alt="${coin.id}"></span>`).join("")}</strong>` : ""}${request.offerItemsLabel ? `<small><i class="fa-solid fa-box"></i> ${esc(request.offerItemsLabel)}</small>` : ""}</div><div class="tovf-shop-actions">${request.canFulfill ? `<button type="button" data-action="fulfillRequest" data-request-id="${request.id}"><i class="fa-solid fa-handshake"></i> Verkaufen</button>` : ""}${request.canCancel ? `<button type="button" data-action="cancelRequest" data-request-id="${request.id}" title="Gesuch zurückziehen"><i class="fa-solid fa-trash"></i></button>` : ""}</div></article>`).join("");
    list.innerHTML = `<header><span>Gesucht</span><span>Suchender</span><span>Gegenleistung</span><span></span></header>${rows || '<p class="tovf-shop-empty">Keine offenen Handelsgesuche.</p>'}`;
  }
  _renderLiveTrade(context) {
    const panel = this.element.querySelector(".tovf-commerce-panel"); if (!panel) return;
    const trade = context.activeTrade, esc = foundry.utils.escapeHTML;
    if (!trade) {
      panel.innerHTML = `<div class="tovf-commerce-empty"><i class="fa-solid fa-handshake fa-2xl"></i><h2>Spielertausch</h2><p>Starte einen direkten, live synchronisierten Handel mit einem anderen Spieler.</p><button type="button" data-action="createTrade"><i class="fa-solid fa-user-plus"></i> Handelsanfrage stellen</button></div>`;
      return;
    }
    if (trade.status === "pending") {
      panel.innerHTML = `<div class="tovf-commerce-empty"><i class="fa-solid fa-hourglass-half fa-2xl"></i><h2>Handelsanfrage</h2><p>${trade.isRecipient ? `${esc(trade.fromName)} möchte mit dir handeln.` : `Warte auf die Antwort von ${esc(trade.toName)}.`}</p><div class="tovf-shop-actions">${trade.isRecipient ? `<button type="button" data-action="acceptTradeInvite" data-trade-id="${trade.id}"><i class="fa-solid fa-check"></i> Annehmen</button>` : ""}<button type="button" data-action="cancelTrade" data-trade-id="${trade.id}"><i class="fa-solid fa-xmark"></i> ${trade.isRecipient ? "Ablehnen" : "Zurückziehen"}</button></div></div>`;
      return;
    }
    const side = entry => {
      const itemRows = entry.items.map(item => `<article><button type="button" class="tovf-shop-item-open" data-action="openTradeItem" data-actor-id="${entry.actorId}" data-item-id="${item.itemId}"><img src="${esc(item.img)}"><span><b>${esc(item.name)}</b></span></button>${entry.editable ? `<input class="tovf-live-trade-quantity" data-trade-quantity data-item-id="${item.itemId}" type="number" value="${item.quantity}" min="1" aria-label="Menge"><button type="button" data-action="tradeRemoveItem" data-item-id="${item.itemId}" title="Aus dem Handel entfernen"><i class="fa-solid fa-xmark"></i></button>` : `<strong>${item.quantity}×</strong>`}</article>`).join("");
      const goldRow = Number(entry.gold) > 0 ? `<article class="tovf-live-trade-gold"><span class="tovf-shop-item-open"><img src="${COIN_FALLBACKS.gp}" alt="Gold"><span><b>Gold</b></span></span><strong>${entry.gold}×</strong></article>` : "";
      return `<section class="tovf-live-trade-side ${entry.confirmed ? "confirmed" : ""}"><header class="tovf-live-trade-name">${entry.confirmed ? '<i class="fa-solid fa-circle-check" title="Bestätigt" aria-label="Bestätigt"></i>' : ""}<h2>${esc(entry.name)}</h2></header><div class="tovf-live-trade-profile"><img src="${esc(entry.img)}" alt="${esc(entry.name)}"><div class="tovf-live-trade-controls"><label>Geldangebot</label><div class="tovf-live-trade-money"><input name="tradeGold" type="number" value="${entry.gold}" min="0" step="0.01" ${entry.editable ? "" : "disabled"}><span>gp</span>${entry.editable ? `<button type="button" data-action="tradeSetMoney" title="Geldangebot speichern"><i class="fa-solid fa-floppy-disk"></i></button>` : ""}</div>${entry.editable ? `<div class="tovf-live-trade-drop" data-trade-drop data-actor-id="${entry.actorId}"><i class="fa-solid fa-box-open"></i><span>Eigene Items hierher ziehen</span></div>` : ""}</div></div><div class="tovf-live-trade-items">${goldRow}${itemRows}${!goldRow && !itemRows ? '<p class="tovf-shop-empty">Keine Gegenstände angeboten.</p>' : ""}</div></section>`;
    };
    panel.innerHTML = `<div class="tovf-live-trade">${side(trade.from)}<div class="tovf-live-trade-exchange"><i class="fa-solid fa-arrow-right-arrow-left"></i></div>${side(trade.to)}</div><footer class="tovf-live-trade-confirm"><button type="button" data-action="confirmTrade" data-trade-id="${trade.id}" ${trade.myConfirmed ? "disabled" : ""}><i class="fa-solid fa-circle-check"></i> ${trade.myConfirmed ? "Bestätigt – warte auf Gegenüber" : "Handel bestätigen"}</button><button type="button" data-action="cancelTrade" data-trade-id="${trade.id}"><i class="fa-solid fa-xmark"></i> Abbrechen</button></footer>`;
    const drop = panel.querySelector("[data-trade-drop]");
    if (drop) {
      drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("dragover"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
      drop.addEventListener("drop", async event => {
        event.preventDefault(); drop.classList.remove("dragover"); const item = await itemFromDrop(event);
        if (!item || item.parent?.id !== drop.dataset.actorId) return ui.notifications.warn("Bitte einen eigenen handelbaren Gegenstand ablegen.");
        const offer = this._myTradeOffer(); if (!offer) return;
        const existing = offer.items.find(entry => entry.itemId === item.id);
        if (existing) existing.quantity = Math.min(itemQuantity(item), existing.quantity + 1);
        else offer.items.push({ itemId: item.id, quantity: 1 });
        updatePeerOffer(offer.trade, offer.side, offer.items, offer.copper);
        await this.render({ force: true });
      });
    }
    panel.querySelector("[data-trade-quantity]")?.closest(".tovf-live-trade-items")?.addEventListener("change", async event => {
      const input = event.target.closest("[data-trade-quantity]"); if (!input) return;
      const offer = this._myTradeOffer(); if (!offer) return;
      const entry = offer.items.find(item => item.itemId === input.dataset.itemId); if (!entry) return;
      entry.quantity = Math.max(1, Math.floor(Number(input.value) || 1));
      updatePeerOffer(offer.trade, offer.side, offer.items, offer.copper);
      await this.render({ force: true });
    });
  }
  _owned() { return ownedCharacters(); }
  _actor() { return game.actors.get(this.actorId) ?? this._owned()[0] ?? null; }
  _merchant() {
    const selected = game.actors.get(this.merchantId);
    if (selected && merchantConfig(selected).enabled && merchantAvailableToUser(selected, game.user, merchantAccessOptions())) return selected;
    return game.actors.find(actor => merchantConfig(actor).enabled && merchantAvailableToUser(actor, game.user, merchantAccessOptions())) ?? null;
  }
  _auctionHouse() { return game.actors.get(this.auctionHouseId) ?? game.actors.find(actor => isAuctionHouse(actor)) ?? null; }
  async _prepareContext() {
    const allCharacters = this._owned();
    const merchants = game.actors.filter(actor => merchantConfig(actor).enabled && merchantAvailableToUser(actor, game.user, merchantAccessOptions()));
    const shop = this._merchant(); this.merchantId = shop?.id ?? null;
    const config = merchantConfig(shop);
    const characters = shop && !game.user.isGM
      ? allCharacters.filter(actor => merchantAllowsActor(shop, actor, game.user, merchantAccessOptions()))
      : allCharacters;
    let selectedActor = game.actors.get(this.actorId);
    if (!characters.some(actor => actor.id === selectedActor?.id)) selectedActor = characters[0] ?? null;
    this.actorId = selectedActor?.id ?? null;
    const management = this.shopPage === "management" && game.user.isGM;
    const shopAll = inventoryEntries(shop, config.buyModifier, config, { management, discounts: true });
    const actorAll = inventoryEntries(selectedActor, config.sellModifier, config);
    const sourceEntries = this.shopPage === "sell" ? actorAll : shopAll;
    const visibleEntries = filtered(sourceEntries, this.category, this.search);
    const state = commerceState();
    const auctionHouse = this._auctionHouse(); this.auctionHouseId = auctionHouse?.id ?? null;
    const auctionFlagDescription = auctionHouse?.getFlag(MODULE_ID, AUCTION_HOUSE_FLAG)?.description;
    const auctionDescription = auctionHouse ? (typeof auctionFlagDescription === "string" ? auctionFlagDescription : "")
      || merchantConfig(auctionHouse).description || auctionHouse.system?.description?.value || "" : "";
    let auctions = state.auctions.filter(e => e.status === "active").map(e => {
      const category = categoryData(e.itemData ?? {}); const currentCopper = Math.max(e.startCopper, e.highestBid);
      return { ...e, categoryId: category.id, categoryLabel: category.label, currentCopper,
        currentCoins: copperPriceCoins(currentCopper), buyoutCoins: e.buyoutCopper ? copperPriceCoins(e.buyoutCopper) : [],
        seller: game.actors.get(e.sellerActorId)?.name ?? "Unbekannt", remaining: remainingTime(e.endsAt),
        canCancel: game.user.isGM || actorOwned(e.sellerActorId) };
    });
    const auctionCategories = categories(auctions);
    auctions = auctions.filter(entry => (!this.category || entry.categoryId === this.category)
      && (!this.search || entry.itemName.toLocaleLowerCase().includes(this.search.toLocaleLowerCase())));
    auctions.sort(this.sort === "price" ? (a,b) => a.currentCopper-b.currentCopper : this.sort === "name"
      ? (a,b) => a.itemName.localeCompare(b.itemName,"de") : (a,b) => a.categoryLabel.localeCompare(b.categoryLabel,"de") || a.itemName.localeCompare(b.itemName,"de"));
    let requests = state.requests.filter(entry => entry.status === "active").map(entry => {
      const category = categoryData(entry.wantedItem);
      const matches = selectedActor?.items.filter(item => item.type === entry.wantedItem.type
        && item.name.trim().toLocaleLowerCase() === entry.wantedItem.name.trim().toLocaleLowerCase()
        && itemQuantity(item) >= entry.wantedQuantity) ?? [];
      return { ...entry, categoryId: category.id, categoryLabel: category.label,
        requester: game.actors.get(entry.requesterActorId)?.name ?? "Unbekannt",
        offeredCoins: copperPriceCoins(entry.offeredCopper), hasMoney: entry.offeredCopper > 0,
        offerItemsLabel: entry.offeredItems.map(item => `${item.quantity}× ${item.name}`).join(", "),
        canFulfill: selectedActor?.id !== entry.requesterActorId && matches.length > 0,
        canCancel: game.user.isGM || actorOwned(entry.requesterActorId) };
    });
    const requestCategories = categories(requests);
    requests = requests.filter(entry => (!this.category || entry.categoryId === this.category)
      && (!this.search || entry.wantedItem.name.toLocaleLowerCase().includes(this.search.toLocaleLowerCase())));
    const trades = [...liveTrades.values()].filter(e => ["pending", "active", "finalizing"].includes(e.status) && (actorOwned(e.fromActorId) || actorOwned(e.toActorId))).map(e => ({ ...e,
      fromName: game.actors.get(e.fromActorId)?.name ?? "Unbekannt", toName: game.actors.get(e.toActorId)?.name ?? "Unbekannt",
      fromMoney: formatCopper(e.fromCopper), toMoney: formatCopper(e.toCopper), canAccept: actorOwned(e.toActorId),
      canCancel: actorOwned(e.fromActorId) || actorOwned(e.toActorId) }));
    let activeTrade = trades.find(entry => entry.id === this.tradeId) ?? trades[0] ?? null;
    if (activeTrade) {
      this.tradeId = activeTrade.id;
      const fromActor = game.actors.get(activeTrade.fromActorId), toActor = game.actors.get(activeTrade.toActorId);
      const mySide = actorOwned(activeTrade.fromActorId) ? "from" : "to";
      const sideData = (side, owner) => ({ actorId: owner.id, name: owner.name, img: owner.img,
        items: activeTrade[`${side}Items`] ?? [], gold: (Number(activeTrade[`${side}Copper`]) || 0) / 100,
        confirmed: activeTrade.confirmations?.[side] === true, editable: side === mySide,
        inventory: owner.items.filter(item => TRADEABLE_TYPES.has(item.type)).map(item => ({ id: item.id, name: item.name, quantity: itemQuantity(item) })) });
      activeTrade = { ...activeTrade, mySide, myConfirmed: activeTrade.confirmations?.[mySide] === true,
        isRecipient: mySide === "to", from: sideData("from", fromActor), to: sideData("to", toActor) };
    }
    return { merchantMode: this.mode === "merchant", auctionMode: this.mode === "auction", tradeMode: this.mode === "trade",
      buyPage: this.shopPage === "buy", sellPage: this.shopPage === "sell", managementPage: management,
      characters: characters.map(a => ({ id: a.id, name: a.name })), selectedActorId: this.actorId,
      selectedActor: selectedActor && { id: selectedActor.id, name: selectedActor.name, wallet: wallet(selectedActor) },
      merchants: merchants.map(a => ({ id: a.id, name: a.name })), selectedMerchantId: this.merchantId,
      selectedMerchant: shop && { id: shop.id, uuid: shop.uuid, name: shop.name, img: shop.img, description: config.description,
        inventoryGroups: groupedInventory(visibleEntries, this.sort), hasInventory: visibleEntries.length > 0, itemCount: shopAll.length },
      config, categories: categories(sourceEntries), selectedCategory: this.category, search: this.search, selectedSort: this.sort,
      auctions, auctionCategories, requests, requestCategories, auctionPageAuctions: this.auctionPage === "auctions",
      auctionPageRequests: this.auctionPage === "requests", auctionHouse: auctionHouse && { id: auctionHouse.id, name: auctionHouse.name,
        img: auctionHouse.img, description: auctionDescription }, trades, activeTrade, isGM: game.user.isGM,
      canSell: !config.purchaseOnly, rollTables: game.tables.map(t => ({ id: t.id, name: t.name })) };
  }
  async _run(operation) { try { const result = await operation(); if (result?.message) ui.notifications.info(result.message);
      if (this.mode === "trade" && ["accepted", "cancelled"].includes(result?.sync?.status)) { await this.close(); return result; }
      await this.render({ force: true }); return result; }
    catch (error) { console.error(`${MODULE_ID} | Commerce operation failed`, error); ui.notifications.error(error.message); } }
  static async #changeMode(_event, target) { this.mode = target.dataset.mode; await this.render({ force: true }); }
  static async #changeShopPage(_event, target) { this.shopPage = target.dataset.page; this.category = ""; this.search = ""; await this.render({ force: true }); }
  static async #changeAuctionPage(_event, target) { this.auctionPage = target.dataset.page; this.category = ""; this.search = ""; await this.render({ force: true }); }
  static async #buy(_event, target) { const item = this._merchant()?.items.get(target.dataset.itemId); const bundle = quantityForPrice(item);
    const quantity = await numberPrompt({ title: "Kaufen", label: bundle > 1 ? `Menge (${bundle} Stück je Preiseinheit)` : "Menge" }); if (!quantity) return;
    await this._run(() => commerceRequest("merchantBuy", { merchantId: this.merchantId, actorId: this.actorId,
      itemId: target.dataset.itemId, quantity, sessionId: this.merchantSessionId, sceneId: merchantAccessOptions().sceneId })); }
  static async #sell(_event, target) { const item = this._actor()?.items.get(target.dataset.itemId); const bundle = quantityForPrice(item);
    const quantity = await numberPrompt({ title: "Verkaufen", label: bundle > 1 ? `Menge (${bundle} Stück je Preiseinheit)` : "Menge" }); if (!quantity) return;
    await this._run(() => commerceRequest("merchantSell", { merchantId: this.merchantId, actorId: this.actorId, itemId: target.dataset.itemId,
      quantity, sceneId: merchantAccessOptions().sceneId })); }
  static async #saveMerchantSettings() {
    const actor = this._merchant(); const form = this.element.querySelector(".tovf-merchant-settings"); if (!actor || !form) return;
    const data = Object.fromEntries(new FormData(form)); const current = merchantConfig(actor);
    await actor.setFlag(MODULE_ID, "merchant", { ...current, enabled: true,
      buyModifier: Number(data.buyModifier), sellModifier: Number(data.sellModifier), infiniteStock: form.elements.infiniteStock.checked,
      infiniteCurrency: form.elements.infiniteCurrency.checked, purchaseOnly: form.elements.purchaseOnly.checked,
      keepSoldItems: form.elements.keepSoldItems.checked, hideNewItems: form.elements.hideNewItems.checked,
      displayQuantity: form.elements.displayQuantity.checked, showZeroQuantity: form.elements.showZeroQuantity.checked,
      requireInteractionRange: form.elements.requireInteractionRange.checked,
      interactionRange: Math.max(1, Math.floor(Number(data.interactionRange) || 1)) });
    ui.notifications.info("Händlereinstellungen gespeichert."); await this.render({ force: true });
  }
  static async #selectMerchantCharacters() {
    const actor = this._merchant(); if (!actor || !game.user.isGM) return;
    const current = merchantConfig(actor);
    const allowedActorIds = await selectCharacters({
      selectedIds: current.allowedActorIds,
      title: `Händlerzugriff: ${actor.name}`,
      hint: "Ohne Auswahl ist der Händler für alle Charaktere verfügbar."
    });
    if (!allowedActorIds) return;
    await actor.setFlag(MODULE_ID, "merchant", { ...current, enabled: true, allowedActorIds });
    await this.render({ force: true });
  }
  static async #configureMerchantRequirements() {
    const actor = this._merchant(); if (!actor || !game.user.isGM) return;
    const current = merchantConfig(actor);
    const requirements = await configureMerchantRequirements(actor);
    if (!requirements) return;
    await actor.setFlag(MODULE_ID, "merchant", { ...current, ...requirements, enabled: true });
    await this.render({ force: true });
  }
  static #chooseMerchantImage() {
    if (!game.user.isGM) return;
    const actor = this.mode === "auction" ? this._auctionHouse() : this._merchant(); if (!actor) return;
    const Picker = foundry.applications.apps.FilePicker.implementation;
    new Picker({ type: "image", current: actor.img, callback: async path => {
      await actor.update({ img: path });
      await this.render({ force: true });
    }}).render(true);
  }
  static #openMerchantItem(_event, target) {
    const actor = game.actors.get(target.dataset.actorId);
    const item = actor?.items.get(target.dataset.itemId);
    if (!item) return ui.notifications.warn("Der Gegenstand wurde nicht gefunden.");
    openItemPreview(item);
  }
  static #openAuctionItem(_event, target) {
    const auction = commerceState().auctions.find(entry => entry.id === target.dataset.auctionId);
    if (!auction?.itemData) return ui.notifications.warn("Der Auktionsgegenstand wurde nicht gefunden.");
    openItemPreview(auction.itemData);
  }
  static #openRequestItem(_event, target) {
    const request = commerceState().requests.find(entry => entry.id === target.dataset.requestId);
    if (!request?.wantedItem) return ui.notifications.warn("Der gesuchte Gegenstand wurde nicht gefunden.");
    openItemPreview(request.wantedItem);
  }
  static async #toggleMerchantItem(_event, target) { const item = this._merchant()?.items.get(target.dataset.itemId); if (!item) return;
    await item.setFlag(MODULE_ID, "merchantItem", { hidden: target.dataset.hidden !== "true" }); await this.render({ force: true }); }
  static async #setItemDiscount(_event, target) {
    const item = this._merchant()?.items.get(target.dataset.itemId); if (!item) return;
    const discountPercent = await numberPrompt({ title: `Rabatt für ${item.name}`, label: "Rabatt in Prozent", value: Number(target.dataset.discount) || 0, min: 0, step: 1 });
    if (discountPercent == null) return;
    const current = item.getFlag(MODULE_ID, "merchantItem") ?? {};
    await item.setFlag(MODULE_ID, "merchantItem", { ...current, discountPercent: Math.clamp(Math.round(discountPercent), 0, 100) });
    await this.render({ force: true });
  }
  static async #setItemPriceQuantity(_event, target) {
    const item = this._merchant()?.items.get(target.dataset.itemId); if (!item || !game.user.isGM) return;
    const quantity = await numberPrompt({ title: `Preiseinheit: ${item.name}`, label: "Stück pro angezeigtem Preis", value: quantityForPrice(item), min: 1, step: 1 });
    if (!quantity) return;
    const priceQuantity = Math.max(1, Math.floor(quantity));
    await item.setFlag(MODULE_ID, "commerce.quantityForPrice", priceQuantity);
    ui.notifications.info(`Der Preis von ${item.name} gilt jetzt für ${priceQuantity} Stück.`);
    await this.render({ force: true });
  }
  static async #deleteMerchantItem(_event, target) { const actor = this._merchant(); if (!actor) return;
    await actor.deleteEmbeddedDocuments("Item", [target.dataset.itemId]); await this.render({ force: true }); }
  static async #clearMerchantItems() { const actor = this._merchant(); if (!actor) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({ classes: ["tovf-commerce-dialog"], window: { title: "Händlerinventar leeren" }, content: "<p>Alle handelbaren Gegenstände dieses Händlers entfernen?</p>" });
    if (!confirmed) return; const ids = actor.items.filter(i => i.type !== "currency" && TRADEABLE_TYPES.has(i.type)).map(i => i.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids); await this.render({ force: true }); }
  static async #populateFromTable() { const actor = this._merchant(); const tableId = this.element.querySelector("[name=rollTableId]")?.value;
    const count = Math.max(1, Math.floor(Number(this.element.querySelector("[name=rollCount]")?.value) || 1));
    const quantityMin = Math.max(1, Math.floor(Number(this.element.querySelector("[name=rollQuantityMin]")?.value) || 1));
    const quantityMax = Math.max(quantityMin, Math.floor(Number(this.element.querySelector("[name=rollQuantityMax]")?.value) || 1));
    const table = game.tables.get(tableId); if (!actor || !table) return;
    const items = await itemsFromTable(table, count, { quantityMin, quantityMax }); if (!items.length) return ui.notifications.warn("Die Tabelle hat keine Item-Ergebnisse geliefert.");
    let total = 0;
    for (const { document, quantity } of items) { await addItem(actor, cleanTransferredItem(document, quantity), quantity, { stackWeapons: true }); total += quantity; }
    ui.notifications.info(`${total} Gegenstände aus ${count} Würfen hinzugefügt (${items.length} verschiedene Items).`); await this.render({ force: true }); }
  static async #configureMerchant() { if (!game.user.isGM) return; const actors = game.actors.map(a => `<option value="${a.id}">${a.name}</option>`).join("");
    const id = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: "Händler einrichten" }, content: `<select name="actorId">${actors}</select>`,
      ok: { label: "Einrichten", callback: (_e, b) => b.form.elements.actorId.value }, rejectClose: false }); if (id) await configureMerchantActor(game.actors.get(id)); }
  static async #createAuction() { const actor = this._actor(); if (!actor) return; const items = actor.items.filter(i => TRADEABLE_TYPES.has(i.type));
    const data = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: "Auktion erstellen" }, content: `<div class="standard-form"><select name="itemId">${items.map(i => `<option value="${i.id}">${i.name}</option>`).join("")}</select><label>Menge<input name="quantity" type="number" value="1" min="1"></label><label>Startpreis (gp)<input name="start" type="number" value="1" min="0.01" step="0.01"></label><label>Sofortkauf (gp)<input name="buyout" type="number" value="0" min="0" step="0.01"></label><label>Stunden<input name="hours" type="number" value="24" min="1"></label></div>`, ok: { label: "Einstellen", callback: (_e,b) => Object.fromEntries(new FormData(b.form)) }, rejectClose:false });
    if (data) await this._run(() => commerceRequest("auctionCreate", { actorId: actor.id, itemId:data.itemId, quantity:Number(data.quantity), startCopper:Math.round(Number(data.start)*100), buyoutCopper:Math.round(Number(data.buyout)*100), durationMs:Number(data.hours)*3600000 })); }
  static async #bid(_e,target) { const gp=await numberPrompt({title:"Gebot",label:"Gebot in gp",value:Number(target.dataset.minimum)/100,min:.01,step:.01}); if(gp) await this._run(()=>commerceRequest("auctionBid",{auctionId:target.dataset.auctionId,actorId:this.actorId,copper:Math.round(gp*100)})); }
  static async #buyout(_e,target) { await this._run(()=>commerceRequest("auctionBuyout",{auctionId:target.dataset.auctionId,actorId:this.actorId})); }
  static async #editAuctionDescription() {
    const actor = this._auctionHouse(); if (!actor || !game.user.isGM) return;
    const current = actor.getFlag(MODULE_ID, AUCTION_HOUSE_FLAG) ?? {};
    const initial = typeof current.description === "string" ? current.description : merchantConfig(actor).description;
    const description = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: `Beschreibung: ${actor.name}` },
      position: { width: 680, height: 560 },
      content: `<div class="tovf-auction-description-dialog"><prose-mirror name="description" value="${foundry.utils.escapeHTML(initial)}" data-document-uuid="${actor.uuid}" class="description"></prose-mirror></div>`,
      ok: { label: "Speichern", callback: (_event, button) => button.form.querySelector('prose-mirror[name="description"]')?.value ?? "" }, rejectClose: false });
    if (description == null) return;
    await actor.update({ [`flags.${MODULE_ID}.${AUCTION_HOUSE_FLAG}`]: { ...current, enabled: true, description: String(description) } });
    const saved = actor.getFlag(MODULE_ID, AUCTION_HOUSE_FLAG)?.description;
    if (saved !== String(description)) throw new Error("Die Auktionshausbeschreibung konnte nicht gespeichert werden.");
    ui.notifications.info("Auktionshausbeschreibung gespeichert."); await this.render({ force: true });
  }
  static async #editMerchantDescription() {
    const actor = this._merchant(); if (!actor || !game.user.isGM) return;
    const current = merchantConfig(actor);
    const description = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: `Beschreibung: ${actor.name}` },
      position: { width: 680, height: 560 },
      content: `<div class="tovf-auction-description-dialog"><prose-mirror name="description" value="${foundry.utils.escapeHTML(current.description ?? "")}" data-document-uuid="${actor.uuid}" class="description"></prose-mirror></div>`,
      ok: { label: "Speichern", callback: (_event, button) => button.form.querySelector('prose-mirror[name="description"]')?.value ?? "" }, rejectClose: false });
    if (description == null) return;
    await actor.setFlag(MODULE_ID, "merchant", { ...current, enabled: true, description: String(description) });
    const saved = actor.getFlag(MODULE_ID, "merchant")?.description;
    if (saved !== String(description)) throw new Error("Die Händlerbeschreibung konnte nicht gespeichert werden.");
    ui.notifications.info("Händlerbeschreibung gespeichert."); await this.render({ force: true });
  }
  static async #cancelAuction(_event,target) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({ classes: ["tovf-commerce-dialog"], window: { title: "Auktion zurückziehen" },
      content: "<p>Der Gegenstand wird zurückgegeben. Ein bestehendes Höchstgebot wird vollständig erstattet.</p>" });
    if (confirmed) await this._run(() => commerceRequest("auctionCancel", { auctionId: target.dataset.auctionId }));
  }
  static async #createRequest() {
    const actor = this._actor(); if (!actor) return;
    const data = await composeTradeRequest(actor);
    if (!data) return;
    const wantedItem = foundry.utils.deepClone(data.wanted.toObject());
    delete wantedItem._id; delete wantedItem._stats;
    await this._run(() => commerceRequest("requestCreate", { actorId: actor.id, wantedItem,
      wantedQuantity: data.wantedQuantity, offeredCopper: Math.round(data.gold * 100), offeredItems: data.offeredItems }));
  }
  static async #fulfillRequest(_event, target) {
    const actor = this._actor(); const request = commerceState().requests.find(entry => entry.id === target.dataset.requestId);
    if (!actor || !request) return;
    const matches = actor.items.filter(item => item.type === request.wantedItem.type
      && item.name.trim().toLocaleLowerCase() === request.wantedItem.name.trim().toLocaleLowerCase()
      && itemQuantity(item) >= request.wantedQuantity);
    if (!matches.length) return ui.notifications.warn("Du besitzt keinen passenden Gegenstand in ausreichender Menge.");
    let itemId = matches[0].id;
    if (matches.length > 1) itemId = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: "Gegenstand verkaufen" },
      content: `<select name="itemId">${matches.map(item => `<option value="${item.id}">${foundry.utils.escapeHTML(item.name)}</option>`).join("")}</select>`,
      ok: { label: "Verkaufen", callback: (_event,button) => button.form.elements.itemId.value }, rejectClose: false });
    if (itemId) await this._run(() => commerceRequest("requestFulfill", { requestId: request.id, actorId: actor.id, itemId }));
  }
  static async #cancelRequest(_event, target) {
    const confirmed = await foundry.applications.api.DialogV2.confirm({ classes: ["tovf-commerce-dialog"], window: { title: "Handelsgesuch zurückziehen" }, content: "<p>Die reservierte Gegenleistung wird zurückgegeben.</p>" });
    if (confirmed) await this._run(() => commerceRequest("requestCancel", { requestId: target.dataset.requestId }));
  }
  static async #createTrade() {
    const ownActors = this._owned();
    if (!ownActors.length) return ui.notifications.warn("Du besitzt keinen Charakter, mit dem du handeln kannst.");
    const ownActorIds = new Set(ownActors.map(actor => actor.id));
    const targetOwners = new Map();
    for (const user of game.users.filter(user => user.active && !user.isGM && user.id !== game.user.id)) {
      for (const actor of game.actors.filter(actor => actor.type === "pc"
        && (user.character?.id === actor.id || actor.testUserPermission(user, "OWNER")))) {
        if (ownActorIds.has(actor.id)) continue;
        if (!targetOwners.has(actor.id)) targetOwners.set(actor.id, []);
        targetOwners.get(actor.id).push(user);
      }
    }
    const targets = [...targetOwners.keys()].map(id => game.actors.get(id)).filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name, "de"));
    if (!targets.length) return ui.notifications.warn("Kein anderer Charakter verfügbar.");
    const esc = foundry.utils.escapeHTML;
    const selection = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: "Handelsanfrage stellen" },
      content: `<div class="standard-form"><div class="form-group"><label for="tovf-trade-source">Dein Charakter</label><select id="tovf-trade-source" name="source">${ownActors.map(actor => `<option value="${actor.id}" ${actor.id === this.actorId ? "selected" : ""}>${esc(actor.name)}</option>`).join("")}</select></div><div class="form-group"><label for="tovf-trade-target">Zielcharakter</label><select id="tovf-trade-target" name="target">${targets.map(actor => `<option value="${actor.id}">${esc(actor.name)} (${targetOwners.get(actor.id).map(user => esc(user.name)).join(", ")})</option>`).join("")}</select></div></div>`,
      ok: { label: "Anfrage senden", icon: "fa-solid fa-handshake", callback: (_event, button) => ({
        fromActorId: button.form.elements.source.value,
        toActorId: button.form.elements.target.value,
        toUserId: targetOwners.get(button.form.elements.target.value)?.[0]?.id
      }) }, rejectClose: false });
    if (selection) await startPeerTrade(selection);
  }
  static async #acceptTrade(_e,t) { await acceptPeerTrade(t.dataset.tradeId); }
  static async #acceptTradeInvite(_e,t) { await acceptPeerTrade(t.dataset.tradeId); }
  _myTradeOffer() {
    const trade = liveTrades.get(this.tradeId); if (!trade) return null;
    const side = tradeOwnedSide(trade); if (!side) return null;
    return { trade, side, items: foundry.utils.deepClone(trade[`${side}Items`] ?? []), copper: Number(trade[`${side}Copper`]) || 0 };
  }
  static async #tradeRemoveItem(_event,target) {
    const offer = this._myTradeOffer(); if (!offer) return;
    offer.items = offer.items.filter(entry => entry.itemId !== target.dataset.itemId);
    updatePeerOffer(offer.trade, offer.side, offer.items, offer.copper); await this.render({ force: true });
  }
  static async #tradeSetMoney() {
    const offer = this._myTradeOffer(); if (!offer) return;
    const copper = Math.max(0, Math.round((Number(this.element.querySelector("[name=tradeGold]:not([disabled])")?.value) || 0) * 100));
    updatePeerOffer(offer.trade, offer.side, offer.items, copper); await this.render({ force: true });
  }
  static async #confirmTrade(_event,target) { await confirmPeerTrade(target.dataset.tradeId); }
  static #openTradeItem(_event,target) {
    const item = game.actors.get(target.dataset.actorId)?.items.get(target.dataset.itemId);
    if (!item || !openItemPreview(item)) ui.notifications.warn("Der Gegenstand wurde nicht gefunden.");
  }
  static async #cancelTrade(_e,t) { cancelPeerTrade(t.dataset.tradeId); }
}

function actorOwned(id) { return game.actors.get(id)?.testUserPermission(game.user, "OWNER") === true; }
let app;
const promptedTrades = new Set();
export function openCommerce(options = {}) {
  if (options.merchantId) {
    const merchant = game.actors.get(options.merchantId);
    if (merchant && !merchantAvailableToUser(merchant, game.user, merchantAccessOptions())) {
      void showMerchantAccessDenied(merchant);
      return null;
    }
  }
  app ??= new CommerceApp(options);
  Object.assign(app, Object.fromEntries(Object.entries(options).filter(([,v])=>v!=null)));
  if (options.mode === "merchant" || options.merchantId) app.merchantSessionId = foundry.utils.randomID();
  return app.render({ force: true });
}
async function handleTradeSync(sync) {
  if (sync?.kind !== "trade") return;
  const involved = actorOwned(sync.fromActorId) || actorOwned(sync.toActorId); if (!involved) return;
  if (["accepted", "cancelled"].includes(sync.status)) {
    if (app?.mode === "trade" && app.tradeId === sync.tradeId) { app.tradeId = null; await app.close(); }
    return;
  }
  openCommerce({ mode: "trade", tradeId: sync.tradeId });
}

async function handlePeerTrade(message) {
  if (message?.senderId === game.user.id) return;
  const incoming = message?.trade;
  if (game.user.isGM) return;
  if (![incoming?.fromUserId, incoming?.toUserId].includes(game.user.id)) return;
  if (!incoming?.id || !tradeOwnedSide(incoming)) return;
  const current = liveTrades.get(incoming.id);
  let trade;
  if (current && message.event === "update" && ["from", "to"].includes(message.side)) {
    const side = message.side;
    current[`${side}Items`] = foundry.utils.deepClone(incoming[`${side}Items`] ?? []);
    current[`${side}Copper`] = Number(incoming[`${side}Copper`]) || 0;
    current.confirmations = { from: false, to: false };
    current.revision = Math.max(Number(current.revision) || 0, Number(incoming.revision) || 0);
    trade = storePeerTrade(current);
  } else if (current && message.event === "confirm" && ["from", "to"].includes(message.side)) {
    current.confirmations ??= { from: false, to: false };
    current.confirmations[message.side] = true;
    current.revision = Math.max(Number(current.revision) || 0, Number(incoming.revision) || 0);
    trade = storePeerTrade(current);
  } else {
    if (current && Number(current.revision) > Number(incoming.revision)) return;
    trade = storePeerTrade(incoming);
  }
  if (message.event === "invite" && game.user.id === trade.toUserId && actorOwned(trade.toActorId) && !promptedTrades.has(trade.id)) {
    promptedTrades.add(trade.id);
    const fromName = game.actors.get(trade.fromActorId)?.name ?? "Ein anderer Spieler";
    const accepted = await foundry.applications.api.DialogV2.confirm({ classes: ["tovf-commerce-dialog"], window: { title: "Handelsanfrage" },
      content: `<div class="tovf-trade-invitation"><i class="fa-solid fa-handshake fa-2xl"></i><p><strong>${foundry.utils.escapeHTML(fromName)}</strong> möchte mit dir handeln.</p></div>`,
      yes: { label: "Handel annehmen" }, no: { label: "Ablehnen" } });
    if (accepted) await acceptPeerTrade(trade.id); else cancelPeerTrade(trade.id);
    return;
  }
  if (["cancelled", "accepted"].includes(trade.status)) {
    liveTrades.delete(trade.id);
    if (app?.mode === "trade" && app.tradeId === trade.id) { app.tradeId = null; await app.close(); }
    return;
  }
  if (message.event === "confirm" && trade.confirmations?.from && trade.confirmations?.to && game.user.id === trade.fromUserId) {
    await confirmPeerTrade(trade.id);
    return;
  }
  if (trade.status === "active") openCommerce({ mode: "trade", tradeId: trade.id });
  else if (app?.mode === "trade" && app.tradeId === trade.id) await app.render({ force: true });
}

async function startPeerTrade({ fromActorId, toActorId, toUserId = null, itemId = null, quantity = 1 }) {
  const fromActor = game.actors.get(fromActorId), toActor = game.actors.get(toActorId);
  if (!fromActor || !toActor || !actorOwned(fromActor.id) || fromActor.id === toActor.id) return ui.notifications.warn("Die Handelscharaktere sind nicht gültig.");
  const initialItems = [];
  const item = itemId ? fromActor.items.get(itemId) : null;
  if (item && TRADEABLE_TYPES.has(item.type)) initialItems.push({ itemId: item.id, name: item.name, img: item.img,
    quantity: Math.min(itemQuantity(item), Math.max(1, Math.floor(Number(quantity) || 1))) });
  const trade = { id: foundry.utils.randomID(), status: "pending", fromActorId, toActorId, fromUserId: game.user.id, toUserId,
    fromItems: initialItems, toItems: [], fromCopper: 0, toCopper: 0, confirmations: { from: false, to: false }, revision: 0, createdAt: Date.now() };
  storePeerTrade(trade); publishPeerTrade("invite", trade);
  ui.notifications.info(`Handelsanfrage an ${toActor.name} gesendet.`);
}

async function acceptPeerTrade(tradeId) {
  const trade = liveTrades.get(tradeId); if (!trade || !actorOwned(trade.toActorId)) return;
  trade.status = "active"; trade.acceptedAt = Date.now(); publishPeerTrade("accept", trade);
  await openCommerce({ mode: "trade", tradeId });
}

function updatePeerOffer(trade, side, items, copper) {
  trade[`${side}Items`] = foundry.utils.deepClone(items);
  trade[`${side}Copper`] = Math.max(0, Math.round(Number(copper) || 0));
  trade.confirmations = { from: false, to: false };
  publishPeerTrade("update", trade, side);
}

async function confirmPeerTrade(tradeId) {
  const trade = liveTrades.get(tradeId), side = tradeOwnedSide(trade); if (!trade || !side || trade.status !== "active") return;
  trade.confirmations[side] = true;
  if (!trade.confirmations.from || !trade.confirmations.to) { publishPeerTrade("confirm", trade, side); await app?.render({ force: true }); return; }
  trade.status = "finalizing"; publishPeerTrade("finalizing", trade); await app?.render({ force: true });
  try {
    const result = await commerceRequest("tradeFinalize", { trade });
    trade.status = "accepted"; publishPeerTrade("accepted", trade); liveTrades.delete(trade.id);
    ui.notifications.info(result.message ?? "Der Handel wurde abgeschlossen.");
    if (app?.tradeId === trade.id) { app.tradeId = null; await app.close(); }
  } catch (error) {
    trade.status = "active"; trade.confirmations = { from: false, to: false }; publishPeerTrade("update", trade);
    console.error(`${MODULE_ID} | Commerce operation failed`, error); ui.notifications.error(error.message);
  }
}

function cancelPeerTrade(tradeId) {
  const trade = liveTrades.get(tradeId); if (!trade) return;
  trade.status = "cancelled"; publishPeerTrade("cancel", trade); liveTrades.delete(tradeId);
  if (app?.tradeId === tradeId) { app.tradeId = null; void app.close(); }
}

async function startTradeWithUser(user, { sourceActor = null, item = null, quantity = 1 } = {}) {
  const sources = sourceActor ? [sourceActor] : ownedCharacters();
  const targets = game.actors.filter(actor => actor.type === "pc" && (user?.character?.id === actor.id || actor.testUserPermission(user, "OWNER")))
    .filter(actor => !sources.some(source => source.id === actor.id));
  if (!sources.length || !targets.length) return ui.notifications.warn("Für diesen Spieler konnte kein geeigneter Charakter gefunden werden.");
  const esc = foundry.utils.escapeHTML;
  const selection = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: "Handelsanfrage stellen" },
    content: `<div class="standard-form"><div class="form-group"><label for="tovf-trade-source">Dein Charakter</label><select id="tovf-trade-source" name="source">${sources.map(actor => `<option value="${actor.id}">${esc(actor.name)}</option>`).join("")}</select></div><div class="form-group"><label for="tovf-trade-target">Zielcharakter</label><select id="tovf-trade-target" name="target">${targets.map(actor => `<option value="${actor.id}">${esc(actor.name)}</option>`).join("")}</select></div></div>`,
    ok: { label: "Anfrage senden", callback: (_event, button) => ({ fromActorId: button.form.elements.source.value, toActorId: button.form.elements.target.value }) }, rejectClose: false });
  if (selection) await startPeerTrade({ ...selection, toUserId: user.id, itemId: item?.id, quantity });
}

async function chooseTradePartnerForItem(item) {
  const users = game.users.filter(user => user.active && !user.isGM && user.id !== game.user.id && user.character?.id !== item.parent?.id);
  if (!users.length) return ui.notifications.warn("Kein anderer Spieler ist für einen Handel verfügbar.");
  const data = await foundry.applications.api.DialogV2.prompt({ classes: ["tovf-commerce-dialog"], window: { title: `${item.name} zum Handel anbieten` },
    content: `<div class="standard-form"><div class="form-group"><label>Spieler</label><select name="userId">${users.map(user => `<option value="${user.id}">${foundry.utils.escapeHTML(user.name)}</option>`).join("")}</select></div><div class="form-group"><label>Menge</label><input name="quantity" type="number" value="1" min="1" max="${itemQuantity(item)}"></div></div>`,
    ok: { label: "Handelsanfrage senden", callback: (_event,button) => Object.fromEntries(new FormData(button.form)) }, rejectClose: false });
  if (data) await startTradeWithUser(game.users.get(data.userId), { sourceActor: item.parent, item, quantity: data.quantity });
}

async function deleteOwnedActor(actor) {
  if (!actor || game.user.isGM || !actor.testUserPermission(game.user, "OWNER")) return;
  const confirmed = await foundry.applications.api.DialogV2.confirm({ classes: ["tovf-commerce-dialog"],
    window: { title: `${actor.name} löschen` },
    content: `<p><strong>${foundry.utils.escapeHTML(actor.name)}</strong> und alle enthaltenen Items wirklich dauerhaft löschen?</p><p class="hint">Diese Aktion kann nicht rückgängig gemacht werden.</p>`,
    yes: { label: "Endgültig löschen", icon: "fa-solid fa-trash" }, no: { label: "Abbrechen" } });
  if (!confirmed) return;
  try { const result = await commerceRequest("ownerDeleteActor", { actorId: actor.id }); ui.notifications.info(result.message); }
  catch (error) { console.error(`${MODULE_ID} | Owner actor deletion failed`, error); ui.notifications.error(error.message); }
}

export function registerCommerceControls() {
  Hooks.on(`${MODULE_ID}.commerceSync`, handleTradeSync);
  Hooks.on(`${MODULE_ID}.peerTrade`, handlePeerTrade);
  Hooks.on("getUserContextOptions", (_html, options) => options.push({ label: "Handel starten", icon: '<i class="fa-solid fa-handshake"></i>',
    visible: element => { const user = game.users.get(element.dataset.userId); return user?.active && !user.isGM && user.id !== game.user.id; },
    onClick: (_event,element) => void startTradeWithUser(game.users.get(element.dataset.userId)) }));
  Hooks.on("blackFlag.getInventoryContext", (_inventory, item, _activity, options) => {
    if (!item?.parent || !actorOwned(item.parent.id) || !TRADEABLE_TYPES.has(item.type)) return;
    options.push({ label: "Zum Handel anbieten", icon: '<i class="fa-solid fa-handshake"></i>', group: "action",
      onClick: () => void chooseTradePartnerForItem(item) });
  });
  Hooks.on("getActorContextOptions", (_html, options) => options.push({ label: "Actor löschen",
    icon: '<i class="fa-solid fa-trash destructive"></i>',
    visible: element => { const actor = game.actors.get(element.dataset.entryId ?? element.dataset.documentId); return !game.user.isGM && actor?.testUserPermission(game.user, "OWNER"); },
    onClick: (_event, element) => void deleteOwnedActor(game.actors.get(element.dataset.entryId ?? element.dataset.documentId)) }));
}
export { CommerceApp };
