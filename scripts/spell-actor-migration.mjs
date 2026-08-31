import { MODULE_ID } from "./downtime/constants.mjs";
import { replacementData } from "./item-compendium-sync.mjs?v=3.5.0-cross-source-spell-sync-8";
import { canonicalSpellName } from "./spell-name-markers.mjs?v=3.5.0-spell-markers-1";

const FEUERSCHWINGE_CONTENT_MODULE_ID = "tov-feuerschwinge";

function spellCircle(item) {
  const value = item?.system?.circle?.base ?? item?.system?.circle?.value ?? item?.system?.level;
  if (value === "" || value == null) return null;
  const circle = Number(value);
  return Number.isInteger(circle) && circle >= 0 ? circle : null;
}

function spellKey(item) {
  const circle = spellCircle(item);
  if (circle == null) return null;
  return `${canonicalSpellName(item?.name).toLocaleLowerCase(game.i18n.lang)}\u0000${circle}`;
}

function sourceUuidOf(item) {
  return String(item?._stats?.compendiumSource ?? item?.getFlag?.("core", "sourceId") ?? "").trim();
}

function actorSpells() {
  return game.actors.contents.flatMap(actor => actor.items
    .filter(item => item.type === "spell" && !item.getFlag(game.system.id, "cachedFor"))
    .map(item => ({ actor, item })));
}

async function sourceIndex() {
  const packs = game.packs.filter(pack => pack.documentName === "Item"
    && pack.metadata?.packageName === FEUERSCHWINGE_CONTENT_MODULE_ID
    && (pack.metadata?.name === "spells" || pack.collection === `${FEUERSCHWINGE_CONTENT_MODULE_ID}.spells`));
  const sources = (await Promise.all(packs.map(pack => pack.getDocuments())))
    .flat()
    .filter(item => item.type === "spell");
  const index = new Map();
  for (const source of sources) {
    const key = spellKey(source);
    if (!key) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(source);
  }
  return { index, packs: packs.length, sources: sources.length };
}

export async function previewActorSpellMigration() {
  if (!game.user?.isGM) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.GMOnly"));
  const { index, packs, sources } = await sourceIndex();
  if (!packs || !sources) {
    throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.SpellMigration.NoSources"));
  }
  const result = { matches: [], missing: [], ambiguous: [], actors: new Set(), packs, sources };

  for (const { actor, item } of actorSpells()) {
    const candidates = index.get(spellKey(item)) ?? [];
    if (!candidates.length) {
      result.missing.push({ actor, item });
      continue;
    }
    let source = candidates.length === 1 ? candidates[0] : null;
    if (!source) {
      const itemSource = sourceUuidOf(item);
      const direct = candidates.filter(candidate => candidate.uuid === itemSource
        || (itemSource && sourceUuidOf(candidate) === itemSource));
      if (direct.length === 1) source = direct[0];
    }
    if (!source) {
      result.ambiguous.push({ actor, item, candidates });
      continue;
    }
    result.matches.push({ actor, item, source });
    result.actors.add(actor.id);
  }
  return result;
}

export async function applyActorSpellMigration(preview) {
  if (!game.user?.isGM) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.GMTools.Errors.GMOnly"));
  const backup = {
    module: MODULE_ID,
    kind: "actor-spell-migration-backup",
    exportedAt: new Date().toISOString(),
    spells: preview.matches.map(({ actor, item, source }) => ({
      actorUuid: actor.uuid,
      actorName: actor.name,
      sourceUuid: source.uuid,
      item: item.toObject()
    }))
  };
  foundry.utils.saveDataToFile(
    JSON.stringify(backup, null, 2),
    "application/json",
    `feuerschwinge-actor-spells-backup-${new Date().toISOString().slice(0, 10)}.json`
  );

  let migrated = 0;
  let processed = 0;
  const migratedActors = new Set();
  const failures = [];
  const showProgress = entry => {
    processed += 1;
    const pct = preview.matches.length ? Math.round((processed / preview.matches.length) * 100) : 100;
    const label = game.i18n.format("DOWNTIME_MANAGER.GMTools.SpellMigration.Progress", {
      current: processed,
      total: preview.matches.length,
      actor: entry.actor.name,
      spell: entry.item.name
    });
    if (globalThis.SceneNavigation?.displayProgressBar) {
      globalThis.SceneNavigation.displayProgressBar({ label, pct });
    } else if (processed === 1 || processed === preview.matches.length || processed % 25 === 0) {
      ui.notifications.info(label);
    }
  };
  for (const { actor, item, source } of preview.matches) {
    const original = item.toObject();
    const replacement = replacementData(source, item);
    replacement.sort = item.sort;
    // Validate the complete replacement, including embedded Effects, before
    // removing the existing Actor Item.
    try {
      new CONFIG.Item.documentClass(replacement, { parent: actor });
    } catch (error) {
      failures.push({ actor: actor.name, item: item.name, message: error.message });
      showProgress({ actor, item });
      continue;
    }

    await actor.deleteEmbeddedDocuments("Item", [item.id]);
    try {
      await actor.createEmbeddedDocuments("Item", [replacement], { keepId: true });
      migrated += 1;
      migratedActors.add(actor.id);
    } catch (error) {
      // A legacy backup may itself contain invalid `standard` Effects. It is
      // still the original Item, but normalized enough for Foundry v14 to
      // accept it during an emergency rollback.
      for (const effect of original.effects ?? []) {
        if (effect.type === "standard") effect.type = "base";
      }
      delete original._stats;
      delete original.folder;
      delete original.ownership;
      try {
        await actor.createEmbeddedDocuments("Item", [original], { keepId: true });
      } catch (rollbackError) {
        console.error(`${MODULE_ID} | Actor Spell rollback failed`, { actor: actor.uuid, item: item.id, rollbackError });
      }
      failures.push({ actor: actor.name, item: item.name, message: error.message });
      console.error(`${MODULE_ID} | Actor Spell replacement failed`, { actor: actor.uuid, item: item.id, source: source.uuid, error });
    }
    showProgress({ actor, item });
  }
  return {
    migrated,
    actors: migratedActors.size,
    failed: failures.length,
    failures,
    missing: preview.missing.length,
    ambiguous: preview.ambiguous.length
  };
}
