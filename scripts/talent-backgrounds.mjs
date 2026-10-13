import { characterOptionsForTalent, ensureCharacterOptionIndex } from "./character-option-index.mjs";

function itemFromApp(app) {
  const item = app?.item ?? app?.document ?? app?.object;
  return item?.documentName === "Item" ? item : null;
}

async function showTalentBackgrounds(item) {
  await ensureCharacterOptionIndex();
  const backgrounds = characterOptionsForTalent(item);
  if (!backgrounds.length) return ui.notifications.info(game.i18n.localize("TOVF.TalentBackgrounds.None"));
  const selected = await foundry.applications.api.DialogV2.wait({
    window: { title: game.i18n.format("TOVF.TalentBackgrounds.Title", { talent: item.name }) },
    content: `<p>${game.i18n.localize("TOVF.TalentBackgrounds.Hint")}</p>`,
    buttons: backgrounds.map(background => ({ action: background.uuid, label: background.name, icon: "fa-solid fa-person-rays", callback: () => background.uuid })),
    rejectClose: false
  });
  if (!selected) return;
  (await fromUuid(selected).catch(() => null))?.sheet.render(true);
}

function addTalentBackgroundControl(app, controls) {
  const item = itemFromApp(app);
  if (item?.type !== "talent" || !Array.isArray(controls) || controls.some(control => control.action === "tovf-talent-backgrounds")) return;
  const count = characterOptionsForTalent(item).length;
  controls.unshift({ action: "tovf-talent-backgrounds", icon: "fa-solid fa-person-rays", label: game.i18n.format("TOVF.TalentBackgrounds.Control", { count }), visible: true, onClick: () => void showTalentBackgrounds(item) });
}

/** Uses the shared character-option index, including talent identities across compendium copies. */
export function registerTalentBackgrounds() {
  Hooks.on("getHeaderControlsItemSheetV2", addTalentBackgroundControl);
  Hooks.on("getHeaderControlsApplicationV2", addTalentBackgroundControl);
}
