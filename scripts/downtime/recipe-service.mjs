import { FLAGS, MODULE_ID, PROJECT_TEMPLATES, SETTINGS } from "./constants.mjs";
import { ProjectSheet } from "./recipe-sheet.mjs";
import { defaultRecipeData, isRecipeItem } from "./utils.mjs";

async function getProjectFolder() {
  let folder = game.folders.find(candidate =>
    candidate.type === "Item" &&
    candidate.getFlag?.(MODULE_ID, FLAGS.PROJECT_FOLDER)
  );
  if (folder) return folder;
  folder = await Folder.create({
    name: game.i18n.localize("DOWNTIME_MANAGER.Project.FolderName"),
    type: "Item",
    folder: null,
    flags: {
      [MODULE_ID]: {
        [FLAGS.PROJECT_FOLDER]: true
      }
    }
  });
  if (!folder) {
    throw new Error(
      game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectFolderFailed")
    );
  }
  return folder;
}

export async function createRecipeDocumentFromTemplate(templateId, {
  name = "",
  categories = [],
  presetProjectId = ""
} = {}) {
  if (presetProjectId) {
    const existing = Array.from(game.items).find(item =>
      item.getFlag?.(MODULE_ID, "preset")?.projectId === presetProjectId
    );
    if (existing) return existing;
  }
  const uuid = String(game.settings.get(MODULE_ID, SETTINGS.RECIPE_BASE_ITEM_UUID) ?? "").trim();
  if (!uuid) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectBaseMissing"));
  const baseItem = await fromUuid(uuid);
  if (!baseItem || baseItem.documentName !== "Item") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectBaseInvalid"));
  const template = PROJECT_TEMPLATES.find(entry => entry.id === templateId);
  if (!template) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectTemplateMissing"));
  const project = foundry.utils.mergeObject(defaultRecipeData(), template.config, { inplace: false, recursive: true });
  project.categories = [...categories];
  project.description = game.i18n.localize(template.descriptionKey);
  const data = baseItem.toObject();
  const folder = await getProjectFolder();
  delete data._id;
  data.name = name || game.i18n.localize(template.nameKey);
  data.img = template.img ?? data.img;
  data.folder = folder.id;
  foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAGS.RECIPE}`, project);
  if (presetProjectId) foundry.utils.setProperty(data, `flags.${MODULE_ID}.preset`, { type: "project", projectId: presetProjectId, version: 1 });
  const item = await Item.create(data, { renderSheet: false });
  if (!item) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectCreateFailed"));
  return item;
}

export function openRecipeEditor(item) {
  if (!item || item.documentName !== "Item") return;
  new ProjectSheet({document: item}).render(true);
}

export async function configureAsRecipe(item) {
  if (!item || item.documentName !== "Item") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.NotItem"));
  if (item.getFlag(MODULE_ID, FLAGS.DOWNTIME_ITEM)) await item.unsetFlag(MODULE_ID, FLAGS.DOWNTIME_ITEM);
  if (!isRecipeItem(item)) await item.setFlag(MODULE_ID, FLAGS.RECIPE, defaultRecipeData());
  openRecipeEditor(item);
  return item;
}

export async function createRecipeFromBaseItem(templateId = "", { onCreate = null } = {}) {
  const uuid = String(game.settings.get(MODULE_ID, SETTINGS.RECIPE_BASE_ITEM_UUID) ?? "").trim();
  if (!uuid) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectBaseMissing"));

  const baseItem = await fromUuid(uuid);
  if (!baseItem || baseItem.documentName !== "Item") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectBaseInvalid"));

  const template = PROJECT_TEMPLATES.find(entry => entry.id === templateId) ?? null;
  const recipeConfig = foundry.utils.mergeObject(
    defaultRecipeData(),
    template?.config ?? {},
    { inplace: false, recursive: true }
  );
  if (template) recipeConfig.description = game.i18n.localize(template.descriptionKey);
  const name = template
    ? game.i18n.localize(template.nameKey)
    : game.i18n.format("DOWNTIME_MANAGER.Project.CreatedName", { name: baseItem.name });
  const img = template?.img ?? baseItem.img;
  const draftData = baseItem.toObject();
  delete draftData._id;
  draftData.name = name;
  draftData.img = img;
  foundry.utils.setProperty(draftData, `flags.${MODULE_ID}.${FLAGS.RECIPE}`, recipeConfig);
  const ItemClass = Item.implementation ?? Item;
  const draftItem = new ItemClass(draftData, { parent: null });
  const sheet = new ProjectSheet({
    document: draftItem,
    creationDraft: { name, img, project: recipeConfig },
    createDocument: async ({ update, project }) => {
      const data = baseItem.toObject();
      const folder = await getProjectFolder();
      delete data._id;
      for (const [path, value] of Object.entries(update)) {
        foundry.utils.setProperty(data, path, value);
      }
      foundry.utils.setProperty(data, `flags.${MODULE_ID}.${FLAGS.RECIPE}`, project);
      data.folder = folder.id;
      const recipe = await Item.create(data, { renderSheet: false });
      if (!recipe) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectCreateFailed"));
      await onCreate?.(recipe);
      return recipe;
    }
  });
  sheet.render(true);
  return sheet;
}
