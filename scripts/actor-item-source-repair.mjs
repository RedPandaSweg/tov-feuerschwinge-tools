import { CONTENT_MODULE_ID, MODULE_ID } from "./core/constants.mjs";

function normalized(value) {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

function packageIdFor(pack) {
  return pack.metadata?.packageName ?? pack.metadata?.package ?? "";
}

function identifierValue(document) {
  return String(
    document?.system?.identifier?.value
    ?? document?.system?.identifier
    ?? document?.identifier
    ?? ""
  ).trim();
}

function matchKey(type, value) {
  value = normalized(value);
  return value ? `${normalized(type)}\u0000${value}` : "";
}

function addCandidate(index, key, candidate) {
  if (!key) return;
  const candidates = index.get(key) ?? [];
  candidates.push(candidate);
  index.set(key, candidates);
}

function sourceUuidsOf(item) {
  return new Set([
    item.getFlag?.(MODULE_ID, "preferredCompendiumSource"),
    item.getFlag?.("core", "sourceId"),
    item._stats?.compendiumSource
  ].map(value => String(value ?? "").trim()).filter(Boolean));
}

async function buildFeuerschwingeCatalog() {
  const catalog = { byUuid: new Map(), byIdentifier: new Map(), byName: new Map() };
  const packs = game.packs.filter(pack => (
    pack.documentName === "Item" && packageIdFor(pack) === CONTENT_MODULE_ID
  ));
  for (const pack of packs) {
    const index = await pack.getIndex({ fields: ["type", "system.identifier"] });
    for (const entry of index) {
      const candidate = {
        uuid: pack.getUuid(entry._id),
        name: entry.name,
        type: entry.type,
        identifier: foundry.utils.deepClone(entry.system?.identifier),
        identifierValue: identifierValue(entry),
        pack: pack.title
      };
      catalog.byUuid.set(candidate.uuid, candidate);
      addCandidate(catalog.byIdentifier, matchKey(candidate.type, candidate.identifierValue), candidate);
      addCandidate(catalog.byName, matchKey(candidate.type, candidate.name), candidate);
    }
  }
  return catalog;
}

function unique(candidates = []) {
  return candidates.length === 1 ? candidates[0] : null;
}

function findCandidate(item, catalog) {
  const origins = sourceUuidsOf(item);
  for (const uuid of origins) {
    const direct = catalog.byUuid.get(uuid);
    if (direct) return { candidate: direct, method: "source" };
  }

  const identifierCandidates = catalog.byIdentifier.get(matchKey(item.type, identifierValue(item))) ?? [];
  const nameCandidates = catalog.byName.get(matchKey(item.type, item.name)) ?? [];
  const identifier = unique(identifierCandidates);
  const name = unique(nameCandidates);

  if (identifier && name && identifier.uuid !== name.uuid) {
    return { ambiguous: true, reason: "identifier-name-conflict", identifierCandidates, nameCandidates };
  }
  if (identifier) return { candidate: identifier, method: "identifier" };
  if (name) return { candidate: name, method: "name" };
  if (identifierCandidates.length || nameCandidates.length) {
    return { ambiguous: true, reason: "multiple-candidates", identifierCandidates, nameCandidates };
  }
  return { reason: "no-candidate", identifierCandidates, nameCandidates };
}

function candidateSummary(candidate) {
  return {
    uuid: candidate.uuid,
    name: candidate.name,
    type: candidate.type,
    identifier: candidate.identifierValue,
    pack: candidate.pack
  };
}

function unresolvedEntry(actor, item, result) {
  return {
    actorUuid: actor.uuid,
    actorName: actor.name,
    itemUuid: item.uuid,
    itemName: item.name,
    itemType: item.type,
    identifier: identifierValue(item),
    origins: [...sourceUuidsOf(item)],
    reason: result.reason,
    identifierCandidates: (result.identifierCandidates ?? []).map(candidateSummary),
    nameCandidates: (result.nameCandidates ?? []).map(candidateSummary)
  };
}

function saveScanReport(plans, ambiguous, unmatched) {
  if (!ambiguous.length && !unmatched.length) return;
  const generatedAt = new Date().toISOString();
  foundry.utils.saveDataToFile(
    JSON.stringify({
      format: "tov-feuerschwinge-actor-item-source-report",
      version: 1,
      generatedAt,
      summary: {
        proposed: plans.length,
        ambiguous: ambiguous.length,
        unmatched: unmatched.length
      },
      proposed: plans.map(({ actor, item, source, method }) => ({
        actorUuid: actor.uuid,
        actorName: actor.name,
        itemUuid: item.uuid,
        itemName: item.name,
        itemType: item.type,
        identifier: identifierValue(item),
        method,
        source: candidateSummary(source)
      })),
      ambiguous,
      unmatched
    }, null, 2),
    "application/json",
    `tov-feuerschwinge-actor-item-quellen-report-${generatedAt.slice(0, 10)}.json`
  );
}

function identityDiffers(item, candidate) {
  return item.name !== candidate.name
    || identifierValue(item) !== candidate.identifierValue
    || item.getFlag("core", "sourceId") !== candidate.uuid
    || item.getFlag(MODULE_ID, "preferredCompendiumSource") !== candidate.uuid;
}

function updateFor(item, candidate) {
  const update = {
    _id: item.id,
    name: candidate.name,
    "flags.core.sourceId": candidate.uuid,
    [`flags.${MODULE_ID}.preferredCompendiumSource`]: candidate.uuid
  };
  if (candidate.identifier !== undefined) {
    update["system.identifier"] = foundry.utils.deepClone(candidate.identifier);
  }
  return update;
}

export async function repairActorItemSources() {
  if (!game.user.isGM) return;
  ui.notifications.info(game.i18n.localize("TOVF.LinkTools.SourcesScanning"));
  const catalog = await buildFeuerschwingeCatalog();
  const plans = [];
  const ambiguous = [];
  const unmatched = [];

  for (const actor of game.actors) {
    for (const item of actor.items) {
      if (item.getFlag(game.system.id, "cachedFor")) continue;
      const result = findCandidate(item, catalog);
      if (result.ambiguous) {
        ambiguous.push(unresolvedEntry(actor, item, result));
        continue;
      }
      if (!result.candidate) {
        unmatched.push(unresolvedEntry(actor, item, result));
        continue;
      }
      if (!identityDiffers(item, result.candidate)) continue;
      plans.push({ actor, item, source: result.candidate, method: result.method });
    }
  }

  saveScanReport(plans, ambiguous, unmatched);

  if (!plans.length) {
    ui.notifications.info(game.i18n.format("TOVF.LinkTools.SourcesNone", {
      ambiguous: ambiguous.length,
      unmatched: unmatched.length
    }));
    return { actors: 0, items: 0, ambiguous: ambiguous.length, unmatched: unmatched.length };
  }

  const actors = new Set(plans.map(plan => plan.actor.id)).size;
  const byIdentifier = plans.filter(plan => plan.method === "identifier").length;
  const byName = plans.filter(plan => plan.method === "name").length;
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("TOVF.LinkTools.SourcesTitle") },
    content: `<p>${game.i18n.format("TOVF.LinkTools.SourcesConfirm", {
      actors,
      items: plans.length,
      identifier: byIdentifier,
      name: byName,
      ambiguous: ambiguous.length,
      unmatched: unmatched.length
    })}</p>`,
    yes: { label: game.i18n.localize("TOVF.LinkTools.SourcesRepair") },
    no: { label: game.i18n.localize("Cancel") },
    modal: true,
    rejectClose: false
  });
  if (!confirmed) return;

  foundry.utils.saveDataToFile(
    JSON.stringify({
      format: "tov-feuerschwinge-actor-item-source-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: plans.map(({ actor, item, source, method }) => ({
        actorUuid: actor.uuid,
        actorName: actor.name,
        sourceUuid: source.uuid,
        method,
        data: item.toObject()
      }))
    }, null, 2),
    "application/json",
    `tov-feuerschwinge-actor-item-quellen-${new Date().toISOString().slice(0, 10)}.json`
  );

  const byActor = new Map();
  for (const plan of plans) {
    const updates = byActor.get(plan.actor) ?? [];
    updates.push(updateFor(plan.item, plan.source));
    byActor.set(plan.actor, updates);
  }
  for (const [actor, updates] of byActor) {
    await actor.updateEmbeddedDocuments("Item", updates);
  }

  ui.notifications.info(game.i18n.format("TOVF.LinkTools.SourcesComplete", {
    actors,
    items: plans.length,
    ambiguous: ambiguous.length,
    unmatched: unmatched.length
  }));
  return { actors, items: plans.length, ambiguous: ambiguous.length, unmatched: unmatched.length };
}
