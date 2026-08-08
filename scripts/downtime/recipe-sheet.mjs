import { FLAGS, MODULE_ID, ROLL_TABLE_PRESETS, SETTINGS } from "./constants.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";
import { addCategorySelection, categorySelectionView, defaultRecipeData, defaultStationData, itemIdentifier, parseCategories, recipeData, removeCategorySelection } from "./utils.mjs";
import { StationEngine } from "./station-engine.mjs";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ItemSheetV2 } = foundry.applications.sheets;

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class ProjectSheet extends HandlebarsApplicationMixin(ItemSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["downtime-manager", "recipe-sheet"],
    position: { width: 720, height: 820 },
    window: { title: "DOWNTIME_MANAGER.Project.ConfigTitle", resizable: true },
    form: { handler: ProjectSheet.#submit, closeOnSubmit: false },
    actions: {
      addDefaultCostItem: ProjectSheet.#addDefaultCostItem,
      removeEntry: ProjectSheet.#removeEntry,
      chooseImage: ProjectSheet.#chooseImage,
      addRollRow: ProjectSheet.#addRollRow,
      removeRollRow: ProjectSheet.#removeRollRow,
      toggleNaturalRow: ProjectSheet.#toggleNaturalRow,
      toggleChecks: ProjectSheet.#toggleChecks,
      resetRollTable: ProjectSheet.#resetRollTable,
      clearRollTable: ProjectSheet.#clearRollTable,
      discardDraft: ProjectSheet.#discardDraft,
      addCategorySelection: ProjectSheet.#addCategorySelection,
      removeCategorySelection: ProjectSheet.#removeCategorySelection,
      addCharacterReward: ProjectSheet.#addCharacterReward,
      removeCharacterReward: ProjectSheet.#removeCharacterReward
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/recipe-config.hbs" }
  };

  constructor(options = {}) {
    const { creationDraft, createDocument, ...sheetOptions } = options;
    super(sheetOptions);
    this._creationDraft = creationDraft
      ? foundry.utils.deepClone(creationDraft)
      : null;
    this._createDocument = createDocument ?? null;
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const project = this._creationDraft?.project ?? recipeData(this.item);
    const hydrate = async entries => Promise.all((entries ?? []).map(async entry => {
      const item = entry.uuid ? await fromUuid(entry.uuid) : null;
      return { ...entry, name: entry.name ?? item?.name ?? entry.uuid, img: entry.img ?? item?.img ?? "icons/svg/item-bag.svg" };
    }));
    const defaultCostUuid = String(
      game.settings.get(MODULE_ID, SETTINGS.DEFAULT_COST_ITEM_UUID) ?? ""
    ).trim();
    const defaultCostItem = defaultCostUuid ? await fromUuid(defaultCostUuid) : null;
    const selectedChecks = new Set((project.allowedChecks ?? []).map(StationEngine.checkId));
    const categoryPicker = categorySelectionView(project.categories);
    const checkGroups = ["ability", "skill", "tool"].map(type => ({
      type,
      label: game.i18n.localize(`DOWNTIME_MANAGER.Checks.Groups.${type}`),
      checks: getSystemAdapter().getCheckDefinitions()
        .filter(check => check.type === type)
        .map(check => ({
          ...check,
          id: StationEngine.checkId(check),
          label: check.localized ? check.label : game.i18n.localize(check.label),
          selected: selectedChecks.has(StationEngine.checkId(check))
        }))
    })).filter(group => group.checks.length);
    const adapter = getSystemAdapter();
    const rewardOptions = adapter.getCharacterRewardOptions();
    const typeDefinitions = ["language", "skill", "tool", "weapon", "armor"]
      .filter(type => (rewardOptions[type] ?? []).length)
      .map(type => ({ type, label: game.i18n.localize(`DOWNTIME_MANAGER.Project.CharacterRewardTypes.${type}`) }));
    const characterRewards = (project.characterRewards ?? []).map((reward, index) => ({
      ...reward,
      index,
      supportsExpertise: ["skill", "tool"].includes(reward.type),
      types: typeDefinitions.map(type => ({ ...type, selected: type.type === reward.type })),
      options: (rewardOptions[reward.type] ?? []).map(option => ({ ...option, selected: option.key === reward.key }))
    }));
    return {
      ...context,
      project,
      categoryPicker,
      itemName: this._creationDraft?.name ?? this.item.name,
      itemImg: this._creationDraft?.img ?? this.item.img,
      creationDraft: Boolean(this._creationDraft),
      defaultCostItem: defaultCostItem?.documentName === "Item"
        ? { name: defaultCostItem.name, img: defaultCostItem.img }
        : null,
      supportsChecks: getSystemAdapter().capabilities.checks,
      supportsCharacterRewards: adapter.capabilities.characterRewards,
      characterRewards,
      checkGroups,
      rollTablePresets: ROLL_TABLE_PRESETS.map(preset => ({
        id: preset.id,
        labelKey: preset.labelKey,
        descriptionKey: preset.descriptionKey,
        selected: preset.id === project.rollTablePreset
      })),
      rollTableConfigured: project.rollTable.length > 0,
      requiredTools: await hydrate(project.requiredTools),
      ingredients: await hydrate(project.ingredients),
      completionCosts: await hydrate(project.completionCosts),
      rewards: await hydrate(project.rewards)
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    for (const zone of this.element.querySelectorAll(".item-drop-zone")) {
      zone.addEventListener("dragover", event => event.preventDefault());
      zone.addEventListener("drop", event => this.#dropEntry(event, zone.dataset.list));
    }
    for (const select of this.element.querySelectorAll('[name^="characterRewards."][name$=".type"]')) {
      select.addEventListener("change", event => this.#changeCharacterRewardType(event));
    }
    this.element.querySelector('[name="rollTablePreset"]')?.addEventListener("change", event => this.#applyRollTablePreset(event));
    this.#restoreView();
  }

  #captureView() {
    this._viewState = {
      scrollTop: this.element.querySelector(".sc-body")?.scrollTop ?? 0,
      sections: Object.fromEntries(
        Array.from(
          this.element.querySelectorAll(".sc-config-section[data-section]")
        ).map(section => [section.dataset.section, section.open])
      )
    };
  }

  #restoreView() {
    if (!this._viewState) return;
    for (const section of this.element.querySelectorAll(
      ".sc-config-section[data-section]"
    )) {
      if (Object.hasOwn(this._viewState.sections, section.dataset.section)) {
        section.open = this._viewState.sections[section.dataset.section];
      }
    }
    const scrollTop = this._viewState.scrollTop;
    requestAnimationFrame(() => {
      const body = this.element?.querySelector(".sc-body");
      if (body) body.scrollTop = scrollTop;
    });
  }

  #readProject() {
    const project = foundry.utils.deepClone(this._creationDraft?.project ?? recipeData(this.item));
    delete project.startCosts;
    delete project.intervalValueChange;
    delete project.completionValueChange;
    delete project.scope;
    delete project.intervalCosts;
    delete project.intervalCostMode;
    const value = name => this.element.querySelector(`[name="${name}"]`)?.value;
    const checked = name => Boolean(this.element.querySelector(`[name="${name}"]`)?.checked);
    project.enabled = true;
    project.rollTablePreset = String(value("rollTablePreset") ?? "").trim();
    project.description = String(value("description") ?? "");
    project.categories = parseCategories(Array.from(this.element.querySelectorAll('[name="categories"]'), input => input.value));
    project.requiredProgress = Math.max(0.000001, numberOr(value("requiredProgress"), 1));
    project.repeatable = checked("repeatable");
    project.collaborative = checked("collaborative");
    project.completionCheck = {
      enabled: checked("completionCheck.enabled"),
      dc: Math.max(0, numberOr(value("completionCheck.dc"), 10)),
      retryDowntime: Math.max(0, numberOr(value("completionCheck.retryDowntime"), 1))
    };
    project.allowedChecks = Array.from(
      this.element.querySelectorAll('[name="allowedChecks"]:checked'),
      input => {
        const [type, key] = input.value.split(":");
        return { type, key };
      }
    );
    project.rollTable = (project.rollTable ?? []).map((row, index) => ({
      id: row.id ?? foundry.utils.randomID(),
      enabled: row.natural1 || row.natural20
        ? (this.element.querySelector(`[name="rollTable.${index}.enabled"]`)?.checked ?? row.enabled !== false)
        : true,
      minimum: row.natural1 || row.natural20 ? row.minimum : numberOr(value(`rollTable.${index}.minimum`), 0),
      maximum: row.natural1 || row.natural20 ? row.maximum : value(`rollTable.${index}.maximum`) === "" ? null : numberOr(value(`rollTable.${index}.maximum`)),
      label: String(value(`rollTable.${index}.label`) ?? ""),
      addition: numberOr(value(`rollTable.${index}.addition`)),
      multiplier: numberOr(value(`rollTable.${index}.multiplier`), 1),
      rewardAddition: numberOr(value(`rollTable.${index}.rewardAddition`)),
      rewardMultiplier: numberOr(value(`rollTable.${index}.rewardMultiplier`), 1),
      actorValueChange: numberOr(value(`rollTable.${index}.actorValueChange`)),
      natural1: Boolean(row.natural1),
      natural20: Boolean(row.natural20)
    }));
    for (const list of ["requiredTools", "ingredients", "completionCosts", "rewards"]) {
      const minimum = list === "rewards" ? 0 : 0.000001;
      project[list] = (project[list] ?? []).map((entry, index) => ({
        ...entry,
        quantity: Math.max(minimum, numberOr(value(`${list}.${index}.quantity`), 1))
      }));
    }
    project.characterRewards = (project.characterRewards ?? []).map((reward, index) => ({
      type: String(value(`characterRewards.${index}.type`) ?? reward.type ?? ""),
      key: String(value(`characterRewards.${index}.key`) ?? reward.key ?? ""),
      rank: ["skill", "tool"].includes(String(value(`characterRewards.${index}.type`) ?? reward.type))
        ? Math.min(2, Math.max(1, numberOr(value(`characterRewards.${index}.rank`), 1)))
        : 1
    })).filter(reward => reward.type && reward.key);
    return project;
  }

  async #changeCharacterRewardType(event) {
    const index = Number(event.currentTarget.dataset.index);
    const project = this.#readProject();
    const options = getSystemAdapter().getCharacterRewardOptions()[event.currentTarget.value] ?? [];
    project.characterRewards[index] = { type: event.currentTarget.value, key: options[0]?.key ?? "", rank: 1 };
    await this.#saveDraft(project);
  }

  async #saveDraft(project) {
    this.#captureView();
    if (this._creationDraft) {
      this._creationDraft.project = foundry.utils.deepClone(project);
      this._creationDraft.name = String(this.element.querySelector('[name="name"]')?.value ?? this._creationDraft.name);
      this._creationDraft.img = String(this.element.querySelector('[name="img"]')?.value ?? this._creationDraft.img);
      this.render();
      return;
    }
    await this.item.setFlag(MODULE_ID, FLAGS.RECIPE, project);
    this.render();
  }

  #descriptionHtml(project) {
    const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
    const checksById = new Map(
      getSystemAdapter().getCheckDefinitions().map(check => [StationEngine.checkId(check), check])
    );
    const checkLabels = project.allowedChecks.map(check => {
      const definition = checksById.get(StationEngine.checkId(check));
      return definition
        ? (definition.localized ? definition.label : game.i18n.localize(definition.label))
        : StationEngine.checkId(check);
    });
    const rewardRollSummary = entry => {
      if (Number(entry.quantity ?? 1) !== 0) return null;
      const rows = (project.rollTable ?? []).filter(row => !row.natural1 && !row.natural20 || row.enabled !== false);
      if (!rows.length) return game.i18n.localize("DOWNTIME_MANAGER.Project.RewardStationDetermined");
      const quantities = rows.map(row => StationEngine.calculateRewardQuantity(0, row, 1));
      const minimum = Math.min(...quantities);
      const maximum = Math.max(...quantities);
      return game.i18n.format("DOWNTIME_MANAGER.Project.RewardRollRange", { minimum, maximum });
    };
    const itemList = (labelKey, entries, rewards = false) => {
      if (!entries?.length) return "";
      const items = entries.map(entry => {
        const name = escape(entry.name ?? entry.uuid);
        const rollSummary = rewards ? rewardRollSummary(entry) : null;
        return rollSummary
          ? `<li>${name}: ${escape(rollSummary)}</li>`
          : `<li>${name} × ${escape(entry.quantity ?? 1)}</li>`;
      }).join("");
      return `<h4>${escape(game.i18n.localize(labelKey))}</h4><ul>${items}</ul>`;
    };
    const characterOptions = getSystemAdapter().getCharacterRewardOptions();
    const characterRewardList = () => {
      if (!project.characterRewards?.length) return "";
      const entries = project.characterRewards.map(reward => {
        const label = characterOptions[reward.type]?.find(option => option.key === reward.key)?.label ?? reward.key;
        const rank = reward.rank > 1 ? ` (${game.i18n.localize("DOWNTIME_MANAGER.Project.Expertise")})` : "";
        return `<li>${escape(label)}${escape(rank)}</li>`;
      }).join("");
      return `<h4>${escape(game.i18n.localize("DOWNTIME_MANAGER.Project.CharacterRewards"))}</h4><ul>${entries}</ul>`;
    };
    const text = escape(project.description).replace(/\r?\n/g, "<br>");
    const repeatable = game.i18n.localize(
      project.repeatable
        ? "DOWNTIME_MANAGER.Common.Yes"
        : "DOWNTIME_MANAGER.Common.No"
    );
    const parts = [
      `<section class="downtime-manager-project-description">`,
      text ? `<p>${text}</p>` : "",
      `<hr>`,
      `<dl>`,
      `<dt>${escape(game.i18n.localize("DOWNTIME_MANAGER.Project.RequiredProgress"))}</dt><dd>${escape(project.requiredProgress)}</dd>`,
      `<dt>${escape(game.i18n.localize("DOWNTIME_MANAGER.Project.Repeatable"))}</dt><dd>${escape(repeatable)}</dd>`,
      `</dl>`,
      checkLabels.length
        ? `<h4>${escape(game.i18n.localize("DOWNTIME_MANAGER.Project.AllowedChecks"))}</h4><p>${checkLabels.map(escape).join(", ")}</p>`
        : "",
      itemList("DOWNTIME_MANAGER.Project.RequiredTools", project.requiredTools),
      itemList("DOWNTIME_MANAGER.Project.RequiredItems", project.ingredients),
      itemList("DOWNTIME_MANAGER.Project.CompletionCosts", project.completionCosts),
      itemList("DOWNTIME_MANAGER.Project.Rewards", project.rewards, true),
      characterRewardList(),
      `</section>`
    ];
    return parts.join("");
  }

  async #dropEntry(event, list) {
    event.preventDefault();
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    const item = data.type === "Item" ? await Item.implementation.fromDropData(data) : null;
    if (!item?.uuid || !["requiredTools", "ingredients", "completionCosts", "rewards"].includes(list)) {
      return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Errors.DropItem"));
    }
    const project = this.#readProject();
    if (!project[list].some(entry => entry.uuid === item.uuid)) {
      project[list].push({
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        identifier: itemIdentifier(item),
        quantity: 1
      });
    }
    if (list === "rewards" && !project.resultUuid) {
      project.resultUuid = item.uuid;
      project.resultQuantity = 1;
    }
    await this.#saveDraft(project);
  }

  static async #removeEntry(event, target) {
    const project = this.#readProject();
    const list = target.dataset.list;
    project[list]?.splice(Number(target.dataset.index), 1);
    await this.#saveDraft(project);
  }

  static #addCategorySelection(event, target) { addCategorySelection(target); }
  static #removeCategorySelection(event, target) { removeCategorySelection(target); }

  static async #addCharacterReward() {
    const project = this.#readProject();
    const options = getSystemAdapter().getCharacterRewardOptions();
    const type = ["language", "skill", "tool", "weapon", "armor"].find(entry => options[entry]?.length);
    if (!type) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Errors.CharacterRewardsUnsupported"));
    project.characterRewards ??= [];
    project.characterRewards.push({ type, key: options[type][0].key, rank: 1 });
    await this.#saveDraft(project);
  }

  static async #removeCharacterReward(event, target) {
    event.preventDefault();
    const project = this.#readProject();
    const index = Number(target.closest?.("[data-index]")?.dataset.index ?? target.dataset.index);
    if (!Number.isInteger(index) || index < 0) return;
    project.characterRewards?.splice(index, 1);
    await this.#saveDraft(project);
  }

  static async #addDefaultCostItem() {
    const uuid = String(
      game.settings.get(MODULE_ID, SETTINGS.DEFAULT_COST_ITEM_UUID) ?? ""
    ).trim();
    if (!uuid) {
      return ui.notifications.warn(
        game.i18n.localize("DOWNTIME_MANAGER.Errors.DefaultCostItemMissing")
      );
    }
    const item = await fromUuid(uuid);
    if (!item || item.documentName !== "Item") {
      return ui.notifications.warn(
        game.i18n.localize("DOWNTIME_MANAGER.Errors.DefaultCostItemInvalid")
      );
    }
    const project = this.#readProject();
    if (!project.ingredients.some(entry => entry.uuid === item.uuid)) {
      project.ingredients.push({
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        identifier: itemIdentifier(item),
        quantity: 1
      });
    }
    await this.#saveDraft(project);
  }

  static #chooseImage() {
    const input = this.element.querySelector('[name="img"]');
    const preview = this.element.querySelector(".sc-project-image-picker img");
    const Picker = foundry.applications.apps.FilePicker.implementation;
    new Picker({ type: "image", current: input?.value || this.item.img, callback: path => {
      if (input) input.value = path;
      if (preview) preview.src = path;
    }}).render(true);
  }

  static async #resetRollTable() {
    const project = this.#readProject();
    const preset = ROLL_TABLE_PRESETS.find(entry => entry.id === String(this.element.querySelector('[name="rollTablePreset"]')?.value ?? "").trim());
    project.rollTable = preset?.rollTable ? foundry.utils.deepClone(preset.rollTable) : [];
    project.rollTablePreset = preset?.id ?? "";
    await this.#saveDraft(project);
  }
  async #applyRollTablePreset(event) {
    const project = this.#readProject();
    const preset = ROLL_TABLE_PRESETS.find(entry => entry.id === String(event.currentTarget?.value ?? "").trim());
    project.rollTablePreset = preset?.id ?? "";
    project.rollTable = preset?.rollTable ? foundry.utils.deepClone(preset.rollTable) : [];
    await this.#saveDraft(project);
  }
  static async #clearRollTable() {
    const project = this.#readProject();
    project.rollTable = [];
    project.rollTablePreset = "";
    await this.#saveDraft(project);
  }
  static async #addRollRow() {
    const project = this.#readProject();
    project.rollTable.push({ id: foundry.utils.randomID(), minimum: 0, maximum: null, label: "", addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0, natural1: false, natural20: false });
    await this.#saveDraft(project);
  }
  static async #removeRollRow(event, target) {
    const project = this.#readProject();
    const index = Number(target.dataset.index);
    if (!project.rollTable[index]?.natural1 && !project.rollTable[index]?.natural20) project.rollTable.splice(index, 1);
    await this.#saveDraft(project);
  }
  static async #toggleNaturalRow(event, target) {
    const project = this.#readProject();
    const row = project.rollTable[Number(target.dataset.index)];
    if (row?.natural1 || row?.natural20) row.enabled = row.enabled === false;
    await this.#saveDraft(project);
  }

  static #toggleChecks(event, target) {
    const type = target.dataset.checkType;
    const selector = type === "all"
      ? 'input[name="allowedChecks"]'
      : `input[name="allowedChecks"][value^="${type}:"]`;
    const checks = Array.from(this.element.querySelectorAll(selector));
    const selectAll = checks.some(input => !input.checked);
    for (const input of checks) input.checked = selectAll;
  }

  static #discardDraft() { this.close(); }

  static async #submit() {
    this.#captureView();
    const project = this.#readProject();
    if (!project.rewards.length && !project.characterRewards.length) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RewardRequired"));
    }
    if (project.rollTable.length && StationEngine.validateRollTable(project.rollTable).length) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.InvalidRollTable"));
    }
    const name = String(this.element.querySelector('[name="name"]')?.value ?? this.item.name).trim();
    const img = String(this.element.querySelector('[name="img"]')?.value ?? this.item.img);
    const update = { name: name || this.item.name, img };
    const description = this.#descriptionHtml(project);
    if (foundry.utils.hasProperty(this.item, "system.description.value")) {
      update["system.description.value"] = description;
    } else {
      update["system.description"] = description;
    }
    if (this._creationDraft) {
      try {
        const created = await this._createDocument?.({ update, project });
        if (!created) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectCreateFailed"));
        ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.ProjectSaved"));
        await this.close();
      } catch (error) {
        ui.notifications.error(error.message);
      }
      return;
    }
    await this.item.update(update);
    await this.item.setFlag(MODULE_ID, FLAGS.RECIPE, project);
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.ProjectSaved"));
    this.render();
  }
}
