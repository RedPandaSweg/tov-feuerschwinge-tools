import { FLAGS, MODULE_ID } from "./constants.mjs";
import { getStationData, isStation, recipeData } from "./utils.mjs";

/**
 * Gives every player role Observer access without replacing more permissive
 * ownership entries configured for individual users.
 */
async function enableViewerAccess(document) {
  if (!document || document.pack || document.parent || !game.user.isGM) return false;
  const observer = CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER;
  if (Number(document.ownership?.default ?? 0) >= observer) return true;
  await document.update({
    ownership: {
      ...foundry.utils.deepClone(document.ownership ?? {}),
      default: observer
    }
  });
  return true;
}

async function enableLinkedItemViewerAccess(project) {
  const definition = recipeData(project, { sourceUuid: project.uuid });
  const references = [
    ...(definition.rewards ?? []),
    ...(definition.ingredients ?? []),
    ...(definition.completionCosts ?? []),
    ...(definition.requiredTools ?? [])
  ];
  for (const reference of references) {
    if (!reference?.uuid) continue;
    try {
      const item = await globalThis.fromUuid?.(reference.uuid);
      await enableViewerAccess(item);
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not grant viewer access to linked station item ${reference.uuid}.`, error);
    }
  }
}

/** Make a station and its world-project documents readable for players. */
export async function enableStationViewerAccess(actor) {
  if (!actor || !isStation(actor) || !game.user.isGM) return;

  await enableViewerAccess(actor);
  const recipes = getStationData(actor).recipes ?? [];
  for (const uuid of recipes) {
    try {
      const item = await globalThis.fromUuid?.(uuid);
      // Compendium documents use their pack's visibility and cannot receive
      // individual world-document ownership entries.
      await enableViewerAccess(item);
      if (item?.documentName === "Item") await enableLinkedItemViewerAccess(item);
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not grant viewer access to station project ${uuid}.`, error);
    }
  }
}

/** Reconcile existing stations when the module becomes ready. */
export async function reconcileStationViewerAccess() {
  if (!game.user.isGM) return;
  for (const actor of game.actors.filter(isStation)) {
    try {
      await enableStationViewerAccess(actor);
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not grant viewer access to station ${actor.uuid}.`, error);
    }
  }
}
