import { CONTENT_MODULE_ID, MODULE_ID } from "./constants.mjs";
import { packageIdFor } from "./compendium-deduplication.mjs";

const KOBOLD_PRESS_OGL_MODULE_ID = "koboldpressogl-bf";
const DND5E_SOURCE_ID = "dnd5e";
const DND5E_SPELL_PACK = `${CONTENT_MODULE_ID}.dnd-spells`;
const IMPORT_SOURCE_FIELD = `flags.${MODULE_ID}.importedItem.sourceSystem`;
const sourceIndexPromises = new Map();

function collectionFromUuid(uuid) {
  return String(uuid ?? "").match(/^Compendium\.([^.]+\.[^.]+)\./)?.[1] ?? "";
}

export function spellCompendiumCollection(spell) {
  const pack = typeof spell?.pack === "string" ? spell.pack : spell?.pack?.collection;
  if (pack) return String(pack);

  const sourceUuid = spell?._stats?.compendiumSource
    ?? spell?.flags?.core?.sourceId
    ?? spell?.getFlag?.("core", "sourceId")
    ?? spell?.uuid;
  return collectionFromUuid(sourceUuid);
}

function importedSourceSystem(spell) {
  return String(
    foundry.utils.getProperty(spell, `flags.${MODULE_ID}.importedItem.sourceSystem`)
    ?? spell?.getFlag?.(MODULE_ID, "importedItem.sourceSystem")
    ?? ""
  ).trim();
}

export function blockedPlayerSpellSource(spell) {
  const collection = spellCompendiumCollection(spell);
  const packageId = packageIdFor(game.packs.get(collection)) || collection.split(".")[0];
  if (packageId === KOBOLD_PRESS_OGL_MODULE_ID) return "koboldPressOgl";
  if (collection === DND5E_SPELL_PACK || importedSourceSystem(spell) === DND5E_SOURCE_ID) return "dnd5e";
  return null;
}

export function isPlayerSelectableSpell(spell) {
  return blockedPlayerSpellSource(spell) === null;
}

async function sourceIndexFor(pack) {
  if (!sourceIndexPromises.has(pack.collection)) {
    sourceIndexPromises.set(pack.collection, pack.getIndex({ fields: [IMPORT_SOURCE_FIELD] }).catch(error => {
      sourceIndexPromises.delete(pack.collection);
      console.warn(`${MODULE_ID} | Could not inspect imported Spell sources in ${pack.collection}.`, error);
      return null;
    }));
  }
  return sourceIndexPromises.get(pack.collection);
}

/** Also checks index-only import metadata which is not part of Black Flag's default spell index. */
export async function isPlayerSelectableSpellAsync(spell) {
  if (!isPlayerSelectableSpell(spell)) return false;

  const collection = spellCompendiumCollection(spell);
  const pack = game.packs.get(collection);
  if (!pack || packageIdFor(pack) !== CONTENT_MODULE_ID) return true;

  const id = spell?._id ?? spell?.id ?? String(spell?.uuid ?? "").split(".").at(-1);
  if (!id) return true;
  const index = await sourceIndexFor(pack);
  const entry = index?.get?.(id) ?? index?.find?.(candidate => candidate._id === id);
  return importedSourceSystem(entry) !== DND5E_SOURCE_ID;
}
