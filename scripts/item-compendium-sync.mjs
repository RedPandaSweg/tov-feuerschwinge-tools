function sourceUuidOf(item) {
  return String(
    item?._stats?.compendiumSource
    ?? item?.getFlag?.("core", "sourceId")
    ?? ""
  ).trim();
}

export function isCompendiumItem(item) {
  return item?.documentName === "Item" && String(item.uuid ?? "").startsWith("Compendium.");
}

export function matchingActorItems(source) {
  if (!isCompendiumItem(source)) return [];

  const uuidMatches = game.actors.contents.flatMap(actor => actor.items
    .filter(item => sourceUuidOf(item) === source.uuid)
    .map(item => ({ actor, item })));

  return uuidMatches.filter(({ item }) => item.name === source.name);
}

function replacementData(source, target) {
  const data = source.toObject();
  const targetQuantity = Number(target.system?.quantity?.value ?? target.system?.quantity);
  delete data.folder;
  delete data.ownership;
  delete data.sort;
  delete data._stats;
  for (const effect of data.effects ?? []) {
    // Compendium documents can retain legacy raw effect data even when their
    // prepared client document is usable. Black Flag 3 migrated the former
    // "standard" effect type to "base"; sending the legacy value back as part
    // of an Item replacement is rejected by Foundry v14 on the server.
    CONFIG.ActiveEffect.documentClass.migrateData(effect);
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
  return data;
}

export async function synchronizeCompendiumItem(source) {
  if (!game.user.isGM || !isCompendiumItem(source)) return;

  const matches = matchingActorItems(source);
  if (!matches.length) {
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.ItemSync.NoMatches"));
    return { actors: 0, items: 0 };
  }

  const actorCount = new Set(matches.map(({ actor }) => actor.id)).size;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("DOWNTIME_MANAGER.ItemSync.Title") },
    content: `<p>${game.i18n.format("DOWNTIME_MANAGER.ItemSync.Confirm", {
      name: foundry.utils.escapeHTML(source.name),
      items: matches.length,
      actors: actorCount
    })}</p>`,
    modal: true,
    rejectClose: false
  });
  if (!confirmed) return;

  const byActor = new Map();
  for (const { actor, item } of matches) {
    if (!byActor.has(actor)) byActor.set(actor, []);
    byActor.get(actor).push(replacementData(source, item));
  }
  for (const [actor, updates] of byActor) {
    await actor.updateEmbeddedDocuments("Item", updates, { diff: false, recursive: false });
  }

  ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.ItemSync.Complete", {
    items: matches.length,
    actors: actorCount
  }));
  return { actors: actorCount, items: matches.length };
}
