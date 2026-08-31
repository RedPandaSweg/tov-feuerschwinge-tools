import { canonicalSpellName } from "./spell-name-markers.mjs?v=3.5.0-spell-markers-1";

function sourceUuidOf(item) {
  return String(
    item?.getFlag?.("core", "sourceId")
    ?? item?._stats?.compendiumSource
    ?? ""
  ).trim();
}

export function isCompendiumItem(item) {
  return item?.documentName === "Item" && String(item.uuid ?? "").startsWith("Compendium.");
}

function spellCircle(item) {
  const value = item?.system?.circle?.base ?? item?.system?.circle?.value ?? item?.system?.level;
  if (value === "" || value == null) return null;
  const circle = Number(value);
  return Number.isInteger(circle) && circle >= 0 ? circle : null;
}

function normalizedSpellName(item) {
  return canonicalSpellName(item?.name).toLocaleLowerCase(game.i18n.lang);
}

function equivalentSpell(source, item) {
  if (source.type !== "spell" || item.type !== "spell") return false;
  const sourceCircle = spellCircle(source);
  const itemCircle = spellCircle(item);
  return sourceCircle != null && sourceCircle === itemCircle
    && normalizedSpellName(source) === normalizedSpellName(item);
}

export function matchingActorItems(source, { includeEquivalent = false } = {}) {
  if (!isCompendiumItem(source)) return [];

  return game.actors.contents.flatMap(actor => actor.items.contents.flatMap(item => {
    if (item.getFlag(game.system.id, "cachedFor")) return [];
    const direct = sourceUuidOf(item) === source.uuid
      && (source.type === "spell" || item.name === source.name);
    if (direct) return [{ actor, item, match: "direct" }];
    if (includeEquivalent && equivalentSpell(source, item)) return [{ actor, item, match: "equivalent" }];
    return [];
  }));
}

export function replacementData(source, target) {
  const data = source.toObject();
  const targetQuantity = Number(target.system?.quantity?.value ?? target.system?.quantity);
  const relationshipPath = `flags.${game.system.id}.relationship`;
  const hasSpellRelationship = target.type === "spell" && foundry.utils.hasProperty(target, relationshipPath);
  const spellRelationship = hasSpellRelationship
    ? foundry.utils.deepClone(foundry.utils.getProperty(target, relationshipPath))
    : undefined;
  delete data.folder;
  delete data.ownership;
  delete data.sort;
  delete data._stats;
  data.effects = Array.from(data.effects ?? [], effect => {
    // Compendium documents can retain legacy raw effect data even when their
    // prepared client document is usable. Black Flag 3 migrated the former
    // "standard" effect type to "base"; sending the legacy value back as part
    // of an Item replacement is rejected by Foundry v14 on the server.
    const migrated = CONFIG.ActiveEffect.documentClass.migrateData(effect);
    if (migrated && migrated !== effect) effect = { ...effect, ...migrated };
    // Foundry v14 rejects the legacy effect type even when the system's
    // generic migration leaves the raw embedded source unchanged.
    if (effect.type === "standard") effect.type = "base";
    return effect;
  });
  const invalidEffect = data.effects.find(effect => effect.type === "standard");
  if (invalidEffect) {
    throw new Error(`Legacy Active Effect ${invalidEffect._id ?? "?"} on ${source.name} could not be migrated.`);
  }
  // Quantity belongs to the Actor's inventory state. Synchronizing the Item
  // definition must never reset an existing stack to the compendium's usual 1.
  if (Number.isFinite(targetQuantity)) {
    if (data.system?.quantity && typeof data.system.quantity === "object") {
      data.system.quantity.value = targetQuantity;
    } else {
      data.system.quantity = targetQuantity;
    }
  }
  data._id = target.id;
  foundry.utils.setProperty(data, "flags.core.sourceId", source.uuid);
  if (target.type === "spell" && data.flags?.[game.system.id]) {
    delete data.flags[game.system.id].relationship;
  }
  if (hasSpellRelationship) foundry.utils.setProperty(data, relationshipPath, spellRelationship);
  return data;
}

export async function normalizeLegacyItemEffects(item) {
  const effectIds = item.effects
    .filter(effect => effect.type === "standard" || effect._source?.type === "standard")
    .map(effect => effect.id);
  // Updating a legacy Effect causes Foundry v14 to validate its old invalid
  // source before applying `type: base`. Remove it first; the subsequent full
  // Item synchronization recreates the normalized source Effect.
  if (effectIds.length) await item.deleteEmbeddedDocuments("ActiveEffect", effectIds);
  return effectIds.length;
}

export async function synchronizeCompendiumItem(source) {
  if (!game.user.isGM || !isCompendiumItem(source)) return;

  const candidates = matchingActorItems(source, { includeEquivalent: source.type === "spell" });
  if (!candidates.length) {
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.ItemSync.NoMatches"));
    return { actors: 0, items: 0 };
  }

  const direct = candidates.filter(entry => entry.match === "direct");
  const equivalent = candidates.filter(entry => entry.match === "equivalent");
  let matches;
  if (source.type === "spell" && equivalent.length) {
    const action = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.ItemSync.Title") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.ItemSync.SpellSummary", {
        name: foundry.utils.escapeHTML(source.name), direct: direct.length, equivalent: equivalent.length
      })}</p>`,
      buttons: [
        ...(direct.length ? [{ action: "direct", icon: "fa-solid fa-link", label: game.i18n.format("DOWNTIME_MANAGER.ItemSync.DirectOnly", { count: direct.length }), callback: () => "direct" }] : []),
        { action: "all", icon: "fa-solid fa-arrows-rotate", label: game.i18n.format("DOWNTIME_MANAGER.ItemSync.AllVersions", { count: candidates.length }), callback: () => "all" }
      ],
      rejectClose: false
    });
    if (!action) return;
    matches = action === "all" ? candidates : direct;
  } else {
    matches = direct;
    const actorCount = new Set(matches.map(({ actor }) => actor.id)).size;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.ItemSync.Title") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.ItemSync.Confirm", {
        name: foundry.utils.escapeHTML(source.name), items: matches.length, actors: actorCount
      })}</p>`,
      modal: true,
      rejectClose: false
    });
    if (!confirmed) return;
  }

  const actorCount = new Set(matches.map(({ actor }) => actor.id)).size;

  const byActor = new Map();
  for (const { actor, item } of matches) {
    if (!byActor.has(actor)) byActor.set(actor, []);
    byActor.get(actor).push(replacementData(source, item));
  }
  for (const [actor, updates] of byActor) {
    const targets = matches.filter(entry => entry.actor === actor).map(entry => entry.item);
    for (const target of targets) await normalizeLegacyItemEffects(target);
    await actor.updateEmbeddedDocuments("Item", updates, { diff: false, recursive: false });
  }

  ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.ItemSync.Complete", {
    items: matches.length,
    actors: actorCount
  }));
  return { actors: actorCount, items: matches.length };
}
