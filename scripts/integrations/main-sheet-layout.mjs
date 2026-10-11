function rootOf(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function swapArmorClassAndLuck(root) {
  const main = root?.querySelector?.('[data-tab="main"]');
  const armorClass = main?.querySelector?.('.armor-class');
  const luck = main?.querySelector?.('.luck');
  const left = main?.querySelector?.('.left');
  const center = main?.querySelector?.('.center');
  if (!armorClass || !luck || !left || !center) return;
  left.prepend(luck);
  center.prepend(armorClass);
}

function placeArmorClassAboveLuck(app, element) {
  const actor = app?.document;
  if (actor?.documentName !== "Actor" || actor.type !== "pc") return;
  const root = rootOf(element);
  swapArmorClassAndLuck(root);
  // Application V2 can finish composing tab parts after the render hook. Run
  // once more on the next frame so the swap survives that composition.
  requestAnimationFrame(() => swapArmorClassAndLuck(root));
}

export function installMainSheetLayout() {
  Hooks.on("renderApplicationV2", placeArmorClassAboveLuck);
  Hooks.on("renderActorSheet", placeArmorClassAboveLuck);
  return { status: "completed" };
}
