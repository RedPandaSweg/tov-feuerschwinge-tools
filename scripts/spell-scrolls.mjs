import { MODULE_ID } from "./core/constants.mjs";
import { markedSpellName } from "./spell-name-markers.mjs?v=3.5.0-spell-markers-1";

const BASE_ITEM_PACK = "black-flag.items";
const OFFER_FLAG = "merchantSpellScrollOffers";

export const SPELL_SCROLL_LEVELS = Object.freeze([
  { circle: 0, baseName: "Spell Scroll (Cantrip)", rarity: "common", save: 13, attack: 5, price: 10 },
  { circle: 1, baseName: "Spell Scroll (1st Circle)", rarity: "common", save: 13, attack: 5, price: 50 },
  { circle: 2, baseName: "Spell Scroll (2nd Circle)", rarity: "uncommon", save: 13, attack: 5, price: 100 },
  { circle: 3, baseName: "Spell Scroll (3rd Circle)", rarity: "uncommon", save: 15, attack: 7, price: 200 },
  { circle: 4, baseName: "Spell Scroll (4th Circle)", rarity: "rare", save: 15, attack: 7, price: 350 },
  { circle: 5, baseName: "Spell Scroll (5th Circle)", rarity: "rare", save: 17, attack: 9, price: 650 },
  { circle: 6, baseName: "Spell Scroll (6th Circle)", rarity: "veryRare", save: 17, attack: 9, price: 1500 },
  { circle: 7, baseName: "Spell Scroll (7th Circle)", rarity: "veryRare", save: 18, attack: 10, price: 2500 },
  { circle: 8, baseName: "Spell Scroll (8th Circle)", rarity: "veryRare", save: 18, attack: 10, price: 5000 },
  { circle: 9, baseName: "Spell Scroll (9th Circle)", rarity: "legendary", save: 19, attack: 11, price: 10500 }
]);

export function spellCircle(spell) {
  const value = Number(spell?.system?.circle?.base ?? spell?.system?.circle?.value ?? spell?.system?.level);
  return Number.isInteger(value) && value >= 0 && value <= 9 ? value : null;
}

export function spellScrollLevel(spellOrCircle) {
  const circle = typeof spellOrCircle === "number" ? spellOrCircle : spellCircle(spellOrCircle);
  return SPELL_SCROLL_LEVELS[circle] ?? null;
}

function canonicalSpellUuid(spell) {
  if (spell?.pack || !spell?.parent) return spell?.uuid;
  const source = String(spell?._stats?.compendiumSource ?? spell?.getFlag?.("core", "sourceId") ?? "").trim();
  return source.startsWith("Compendium.") ? source : spell?.uuid;
}

async function baseScroll(level) {
  const pack = game.packs.get(BASE_ITEM_PACK);
  if (!pack) return null;
  const index = await pack.getIndex({ fields: ["name", "type"] });
  const names = new Set([level.baseName, level.baseName.replace(" Circle)", " Level)")]);
  const entry = index.find(item => names.has(item.name) && item.type === "consumable");
  return entry ? pack.getDocument(entry._id) : null;
}

function fallbackScrollData(level) {
  return {
    name: level.baseName,
    type: "consumable",
    img: "icons/sundries/scrolls/scroll-bound-orange-tan.webp",
    system: {
      activities: {},
      type: { category: "scroll", base: "" },
      quantity: 1,
      price: { value: level.price, denomination: "gp" },
      rarity: level.rarity,
      properties: ["magical"],
      uses: { spent: 0, max: "", consumeQuantity: true, recovery: [] }
    }
  };
}

function cleanCreationData(data) {
  const copy = foundry.utils.deepClone(data);
  delete copy._id;
  delete copy._stats;
  delete copy.folder;
  delete copy.ownership;
  foundry.utils.deleteProperty(copy, "flags.core.sourceId");
  return copy;
}

function spellScrollDescription(spell, level) {
  const description = String(spell?.system?.description?.value ?? "");
  const statistics = `<hr><p><strong>Spell Scroll</strong><br>Save DC ${level.save} · Spell Attack Bonus +${level.attack}</p>`;
  return `${description}${statistics}`;
}

export async function createSpellScrollData(spell, { quantity = 1 } = {}) {
  if (spell?.documentName !== "Item" || spell.type !== "spell") throw new Error("Es wurde kein Spell ausgewählt.");
  const level = spellScrollLevel(spell);
  if (!level) throw new Error(`Der Spell-Circle von ${spell.name} konnte nicht bestimmt werden.`);
  const spellUuid = canonicalSpellUuid(spell);
  if (!spellUuid) throw new Error(`${spell.name} besitzt keine verwendbare UUID.`);
  const template = await baseScroll(level);
  const data = cleanCreationData(template?.toObject() ?? fallbackScrollData(level));
  // A stable ID keeps separately purchased scrolls stack-compatible.
  const activityId = spell.id ?? foundry.utils.randomID();
  const displayName = markedSpellName(spell);
  data.name = `Spell Scroll: ${displayName}`;
  data.img = spell.img || data.img;
  data.system ??= {};
  data.system.type = { ...(data.system.type ?? {}), category: "scroll" };
  data.system.quantity = Math.max(1, Math.floor(Number(quantity) || 1));
  data.system.price = { ...(data.system.price ?? {}), value: level.price, denomination: "gp" };
  data.system.rarity = level.rarity;
  data.system.description = { ...(data.system.description ?? {}), value: spellScrollDescription(spell, level) };
  data.system.uses = { ...(data.system.uses ?? {}), spent: 0, max: "", consumeQuantity: true, recovery: [] };
  data.system.activities = {
    [activityId]: {
      _id: activityId,
      type: "cast",
      name: `Cast ${displayName}`,
      img: spell.img,
      activation: { primary: true },
      consumption: { targets: [{ type: "item", target: "", value: "1", scaling: { mode: "", formula: "" } }] },
      system: {
        spell: {
          uuid: spellUuid,
          circle: level.circle,
          ability: "",
          challenge: { override: true, save: level.save, attack: level.attack },
          properties: ["verbal", "somatic", "material"],
          spellbook: false
        }
      }
    }
  };
  data.flags ??= {};
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.spellScroll`, {
    spellUuid, spellName: displayName, circle: level.circle, save: level.save, attack: level.attack
  });
  return data;
}

export async function createWorldSpellScroll(spell, { folder = null } = {}) {
  if (!game.user.isGM) throw new Error("Nur eine Spielleitung kann World Items erstellen.");
  const data = await createSpellScrollData(spell);
  if (folder) data.folder = folder.id ?? folder;
  return Item.create(data, { renderSheet: true });
}

export function merchantSpellScrollOffers(actor) {
  const source = actor?.getFlag?.(MODULE_ID, OFFER_FLAG);
  if (!Array.isArray(source)) return [];
  return source.filter(offer => offer && offer.id && offer.spellUuid).map(offer => foundry.utils.deepClone(offer));
}

export async function saveMerchantSpellScrollOffers(actor, offers) {
  if (!actor || !game.user.isGM) throw new Error("Nur eine Spielleitung kann Spellscroll-Angebote bearbeiten.");
  const clean = offers.slice(0, 2000).map(offer => ({
    id: String(offer.id), spellUuid: String(offer.spellUuid), name: String(offer.name), img: String(offer.img ?? ""),
    circle: Math.clamp(Math.floor(Number(offer.circle) || 0), 0, 9), rarity: String(offer.rarity ?? ""),
    price: Math.max(0, Number(offer.price) || 0), quantity: Math.max(0, Math.floor(Number(offer.quantity) || 0)),
    hidden: offer.hidden === true, discountPercent: Math.clamp(Math.round(Number(offer.discountPercent) || 0), 0, 100),
    createdAt: Number(offer.createdAt) || Date.now()
  }));
  await actor.setFlag(MODULE_ID, OFFER_FLAG, clean);
  return clean;
}

export function spellScrollOffer(spell, quantity = 1) {
  const level = spellScrollLevel(spell);
  const spellUuid = canonicalSpellUuid(spell);
  if (!level || !spellUuid) throw new Error(`${spell?.name ?? "Der Spell"} kann nicht als Spellscroll angeboten werden.`);
  return {
    id: foundry.utils.randomID(), spellUuid, name: `Spell Scroll: ${markedSpellName(spell)}`, img: spell.img,
    circle: level.circle, rarity: level.rarity, price: level.price,
    quantity: Math.max(1, Math.floor(Number(quantity) || 1)), hidden: false, discountPercent: 0, createdAt: Date.now()
  };
}

export async function addMerchantSpellScrollOffer(actor, spell, quantity = 1) {
  const offers = merchantSpellScrollOffers(actor);
  const candidate = spellScrollOffer(spell, quantity);
  const existing = offers.find(offer => offer.spellUuid === candidate.spellUuid);
  if (existing) existing.quantity += candidate.quantity;
  else offers.push(candidate);
  await saveMerchantSpellScrollOffers(actor, offers);
  return existing ?? candidate;
}

export async function resolveSpellScrollOffer(offer) {
  const spell = offer?.spellUuid ? await fromUuid(offer.spellUuid) : null;
  if (spell?.documentName !== "Item" || spell.type !== "spell") return null;
  return spell;
}

export function installSpellScrollTools() {
  const module = game.modules.get(MODULE_ID);
  module.api ??= {};
  module.api.spellScrolls = { createData: createSpellScrollData, createWorldItem: createWorldSpellScroll };
}
