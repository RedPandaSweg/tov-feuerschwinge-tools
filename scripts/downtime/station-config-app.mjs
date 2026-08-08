import { DEFAULT_VALUE_TIERS, FLAGS, MODULE_ID, PROJECT_TEMPLATES, ROLL_TABLE_PRESETS } from "./constants.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";
import { createRecipeFromBaseItem } from "./recipe-service.mjs";
import { StationEngine } from "./station-engine.mjs";
import {
  addCategorySelection,
  categorySelectionView,
  configuredCategories,
  defaultStationData,
  getActiveCrafter,
  getStationData,
  itemIdentifier,
  isRecipeItem,
  parseCategories,
  recipeData,
  removeCategorySelection
} from "./utils.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function numberOr(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export class StationConfigApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-station-config-{id}",
    classes: ["downtime-manager", "station-config"],
    tag: "form",
    position: { width: 760, height: 820 },
    window: { title: "DOWNTIME_MANAGER.Station.ConfigTitle", resizable: true },
    form: { handler: StationConfigApp.#submit, closeOnSubmit: false },
    actions: {
      createRecipe: StationConfigApp.#createRecipe,
      createRecipeTemplate: StationConfigApp.#createRecipeTemplate,
      removeStationTool: StationConfigApp.#removeStationTool,
      removeRecipe: StationConfigApp.#removeRecipe,
      removeStation: StationConfigApp.#removeStation,
      addModifier: StationConfigApp.#addModifier,
      removeModifier: StationConfigApp.#removeModifier,
      addRollRow: StationConfigApp.#addRollRow,
      removeRollRow: StationConfigApp.#removeRollRow,
      toggleNaturalRow: StationConfigApp.#toggleNaturalRow,
      addTier: StationConfigApp.#addTier,
      removeTier: StationConfigApp.#removeTier,
      moveTier: StationConfigApp.#moveTier,
      toggleChecks: StationConfigApp.#toggleChecks,
      resetRollTable: StationConfigApp.#resetRollTable,
      resetValueTiers: StationConfigApp.#resetValueTiers,
      loadValueTierPreset: StationConfigApp.#loadValueTierPreset,
      addCategorySelection: StationConfigApp.#addCategorySelection,
      removeCategorySelection: StationConfigApp.#removeCategorySelection
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/station-config.hbs" }
  };

  constructor(actor, options = {}) {
    super({ ...options, id: `downtime-manager-station-config-${actor.id}` });
    this.actor = actor;
  }

  async _prepareContext() {
    const station = getStationData(this.actor);
    station.actorValue.tiers = StationEngine.normalizeValueTiers(station.actorValue.tiers);
    const categoryPicker = categorySelectionView(station.categories);
    const recipes = [];
    for (const uuid of station.recipes) {
      const item = await fromUuid(uuid);
      const custom = item ? isRecipeItem(item) : false;
      const data = item ? recipeData(item, { sourceUuid: uuid }) : null;
      const result = data?.rewards?.[0]?.uuid
        ? await fromUuid(data.rewards[0].uuid)
        : null;
      recipes.push({
        uuid,
        name: item?.name ?? uuid,
        img: result?.img ?? item?.img ?? "icons/svg/item-bag.svg",
        kind: game.i18n.localize(custom
          ? "DOWNTIME_MANAGER.Station.ProjectItem"
          : item?.type === "spell"
            ? "DOWNTIME_MANAGER.Station.SpellRecipe"
            : "DOWNTIME_MANAGER.Station.StandardItem")
      });
    }
    const selected = new Set(station.allowedChecks.map(StationEngine.checkId));
    const adapter = getSystemAdapter();
    const checks = adapter.getCheckDefinitions().map(check => ({
      ...check,
      id: StationEngine.checkId(check),
      label: check.localized ? check.label : game.i18n.localize(check.label),
      selected: selected.has(StationEngine.checkId(check))
    }));
    const checkGroups = ["ability", "skill", "tool"].map(type => ({
      type,
      label: game.i18n.localize(`DOWNTIME_MANAGER.Checks.Groups.${type}`),
      checks: checks.filter(check => check.type === type)
    })).filter(group => group.checks.length);
    const exampleActor = getActiveCrafter();
    const exampleCheck = station.allowedChecks[0] ?? null;
    const storedTool = station.requiredTool;
    const toolDocument = storedTool?.uuid ? await fromUuid(storedTool.uuid) : null;
    const tool = storedTool ? {
      ...storedTool,
      name: storedTool.name ?? toolDocument?.name ?? storedTool.identifier ?? storedTool.uuid,
      img: storedTool.img ?? toolDocument?.img ?? "icons/svg/item-bag.svg"
    } : null;
    return {
      actorName: this.actor.name,
      station,
      categoryPicker,
      characterValueCategories: categoryPicker.selected.map(category => ({ ...category, selected: category.id === station.actorValue.category })),
      recipes,
      checkGroups,
      tool,
      exampleSources: StationEngine.actorProgressSources(exampleActor, exampleCheck),
      formulaExampleLabel: exampleActor
        ? game.i18n.format("DOWNTIME_MANAGER.Station.FormulaExampleActor", { actor: exampleActor.name })
        : game.i18n.localize("DOWNTIME_MANAGER.Station.FormulaExampleNone"),
      capabilities: adapter.capabilities,
      rollTablePresets: ROLL_TABLE_PRESETS.map(preset => ({
        id: preset.id,
        labelKey: preset.labelKey,
        descriptionKey: preset.descriptionKey,
        selected: preset.id === station.rollTablePreset
      })),
      projectTemplates: PROJECT_TEMPLATES.map(template => ({
        id: template.id,
        name: game.i18n.localize(template.nameKey)
      }))
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.#bindDrop(".project-drop-zone", event => this.#dropProject(event));
    this.#bindDrop(".tool-drop-zone", event => this.#dropTool(event));
    this.element.querySelector('[name="actorValue.enabled"]')
      ?.addEventListener("change", event => {
        const options = this.element.querySelector("[data-actor-value-options]");
        if (options) options.hidden = !event.currentTarget.checked;
      });
    this.element.querySelector('[name="actorValue.scope"]')?.addEventListener("change", () => this.#updateCharacterValueScope());
    this.element.querySelector('[name="rollTablePreset"]')?.addEventListener("change", event => this.#applyRollTablePreset(event));
    this.element.addEventListener("input", () => {
      this.#updateConditionalSections();
      this.#updateFormulaPreview();
    });
    this.#updateConditionalSections();
    this.#updateCharacterValueScope();
    this.#updateFormulaPreview();
    this.#restoreView();
  }

  #updateCharacterValueScope() {
    const categoryMode = this.element.querySelector('[name="actorValue.scope"]')?.value === "category";
    const key = this.element.querySelector("[data-character-value-key]");
    const category = this.element.querySelector("[data-character-value-category]");
    if (key) key.hidden = categoryMode;
    if (category) category.hidden = !categoryMode;
  }

  #updateConditionalSections() {
    const requiresRoll = this.element.querySelector('[name="requiresRoll"]')?.checked;
    const usesCheck = this.element.querySelector('[name="progressSources.checkProficiency.enabled"]')?.checked;
    for (const element of this.element.querySelectorAll("[data-roll-option], [data-roll-options]")) {
      element.hidden = !requiresRoll;
    }
    const checkOptions = this.element.querySelector("[data-check-options]");
    if (checkOptions) checkOptions.hidden = !(requiresRoll || usesCheck);
  }

  #updateFormulaPreview() {
    const preview = this.element.querySelector("[data-formula-preview]");
    const container = preview?.closest(".sc-formula-preview");
    const breakdown = container?.querySelector("[data-formula-breakdown]");
    if (!preview || !container) return;
    const number = name => Number(this.element.querySelector(`[name="${name}"]`)?.value ?? 0) || 0;
    const enabled = name => Boolean(this.element.querySelector(`[name="${name}"]`)?.checked);
    const additions = [number("baseProgress")];
    const details = [`${container.dataset.labelBase}: ${additions[0]}`];
    const addSource = (enabledName, multiplierName, rawValue, label) => {
      if (!enabled(enabledName)) return;
      const multiplier = number(multiplierName);
      const contribution = rawValue * multiplier;
      additions.push(contribution);
      details.push(`${label}: ${rawValue} × ${multiplier} = ${contribution}`);
    };
    addSource("progressSources.level.enabled", "progressSources.level.multiplier", Number(container.dataset.level ?? 0), container.dataset.labelLevel);
    addSource("progressSources.proficiency.enabled", "progressSources.proficiency.multiplier", Number(container.dataset.proficiency ?? 0), container.dataset.labelProficiency);
    addSource("progressSources.checkProficiency.enabled", "progressSources.checkProficiency.multiplier", Number(container.dataset.checkProficiency ?? 0), container.dataset.labelCheckProficiency);
    const multipliers = [];
    for (const row of this.element.querySelectorAll(".modifier-row")) {
      const operation = row.querySelector('select[name*=".operation"]')?.value;
      const value = Number(row.querySelector('input[name*=".value"]')?.value ?? 0);
      const safeValue = Number.isFinite(value) ? value : operation === "multiply" ? 1 : 0;
      const label = row.querySelector('input[name*=".label"]')?.value.trim() || container.dataset.labelUnnamed;
      if (operation === "multiply") multipliers.push(safeValue);
      else additions.push(safeValue);
      details.push(`${label} (${operation === "multiply" ? container.dataset.labelMultiplier : container.dataset.labelAddition}): ${safeValue}`);
    }
    const subtotal = additions.reduce((sum, value) => sum + value, 0);
    const product = multipliers.reduce((total, value) => total * value, 1);
    preview.textContent = `1 × (${additions.join(" + ")})${multipliers.map(value => ` × ${value}`).join("")} = ${Math.round(subtotal * product * 1e6) / 1e6}`;
    if (breakdown) breakdown.innerHTML = details.map(detail => `<div>${foundry.utils.escapeHTML(detail)}</div>`).join("");
  }

  #captureView() {
    const body = this.element.querySelector(".sc-body");
    this._viewState = {
      scrollTop: body?.scrollTop ?? 0,
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

  #bindDrop(selector, handler) {
    const zone = this.element.querySelector(selector);
    zone?.addEventListener("dragover", event => event.preventDefault());
    zone?.addEventListener("drop", handler);
  }

  #readStation() {
    const station = getStationData(this.actor);
    const value = name => this.element.querySelector(`[name="${name}"]`)?.value;
    const checked = name => Boolean(this.element.querySelector(`[name="${name}"]`)?.checked);
    station.enabled = checked("enabled");
    station.displayName = String(value("displayName") ?? "").trim();
    station.description = String(value("description") ?? "");
    station.categories = parseCategories(Array.from(this.element.querySelectorAll('[name="categories"]'), input => input.value));
    station.baseProgress = numberOr(value("baseProgress"));
    station.requiresRoll = checked("requiresRoll");
    station.progressSources = {
      level: { enabled: checked("progressSources.level.enabled"), multiplier: numberOr(value("progressSources.level.multiplier"), 1) },
      proficiency: { enabled: checked("progressSources.proficiency.enabled"), multiplier: numberOr(value("progressSources.proficiency.multiplier"), 1) },
      checkProficiency: { enabled: checked("progressSources.checkProficiency.enabled"), multiplier: numberOr(value("progressSources.checkProficiency.multiplier"), 1) }
    };
    station.rollInterval = Math.max(0.000001, numberOr(value("rollInterval"), 1));
    station.evaluationMode = value("evaluationMode") === "natural" ? "natural" : "total";
    station.allowedChecks = Array.from(
      this.element.querySelectorAll('[name="allowedChecks"]:checked'),
      input => {
        const [type, key] = input.value.split(":");
        return { type, key };
      }
    );
    station.modifiers = station.modifiers.map((modifier, index) => ({
      id: modifier.id ?? foundry.utils.randomID(),
      label: String(value(`modifiers.${index}.label`) ?? ""),
      operation: value(`modifiers.${index}.operation`) === "multiply" ? "multiply" : "add",
      value: numberOr(value(`modifiers.${index}.value`), modifier.operation === "multiply" ? 1 : 0)
    }));
    station.rollTable = station.rollTable.map((row, index) => ({
      id: row.id ?? foundry.utils.randomID(),
      enabled: row.natural1 || row.natural20
        ? (this.element.querySelector(`[name="rollTable.${index}.enabled"]`)
          ? checked(`rollTable.${index}.enabled`)
          : row.enabled !== false)
        : true,
      minimum: row.natural1 || row.natural20
        ? row.minimum
        : numberOr(value(`rollTable.${index}.minimum`), 0),
      maximum: row.natural1 || row.natural20
        ? row.maximum
        : value(`rollTable.${index}.maximum`) === "" ? null : numberOr(value(`rollTable.${index}.maximum`)),
      label: String(value(`rollTable.${index}.label`) ?? ""),
      addition: numberOr(value(`rollTable.${index}.addition`)),
      multiplier: numberOr(value(`rollTable.${index}.multiplier`), 1),
      rewardAddition: numberOr(value(`rollTable.${index}.rewardAddition`)),
      rewardMultiplier: numberOr(value(`rollTable.${index}.rewardMultiplier`), 1),
      actorValueChange: numberOr(value(`rollTable.${index}.actorValueChange`)),
      natural1: Boolean(row.natural1),
      natural20: Boolean(row.natural20)
    }));
    station.rollTablePreset = String(value("rollTablePreset") ?? "").trim();
    station.actorValue = {
      ...station.actorValue,
      enabled: checked("actorValue.enabled"),
      scope: value("actorValue.scope") === "category" ? "category" : "station",
      category: String(value("actorValue.category") ?? ""),
      key: String(value("actorValue.key") ?? "").trim(),
      label: String(value("actorValue.label") ?? "").trim(),
      defaultValue: numberOr(value("actorValue.defaultValue")),
      minimum: value("actorValue.minimum") === "" ? null : numberOr(value("actorValue.minimum")),
      maximum: value("actorValue.maximum") === "" ? null : numberOr(value("actorValue.maximum")),
      completionChange: numberOr(value("actorValue.completionChange")),
      tiers: StationEngine.normalizeValueTiers(station.actorValue.tiers.map((tier, index) => ({
        id: tier.id ?? foundry.utils.randomID(),
        minimum: numberOr(value(`actorValue.tiers.${index}.minimum`)),
        maximum: value(`actorValue.tiers.${index}.maximum`) === "" ? null : numberOr(value(`actorValue.tiers.${index}.maximum`)),
        addition: numberOr(value(`actorValue.tiers.${index}.addition`)),
        multiplier: numberOr(value(`actorValue.tiers.${index}.multiplier`), 1),
        rewardAddition: numberOr(value(`actorValue.tiers.${index}.rewardAddition`)),
        rewardMultiplier: numberOr(value(`actorValue.tiers.${index}.rewardMultiplier`), 1)
      })))
    };
    delete station.type;
    delete station.working;
    delete station.modifier;
    return station;
  }

  async #persistDraft(mutator) {
    this.#captureView();
    const station = this.#readStation();
    mutator(station);
    await this.actor.setFlag(MODULE_ID, FLAGS.STATION, station);
    this.render();
  }

  async #dropTool(event) {
    event.preventDefault();
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    const item = data.type === "Item" ? await Item.implementation.fromDropData(data) : null;
    if (!item) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Errors.DropItem"));
    await this.#persistDraft(station => {
      station.requiredTool = {
        uuid: item.uuid,
        name: item.name,
        img: item.img,
        identifier: itemIdentifier(item)
      };
    });
  }

  async #dropProject(event) {
    event.preventDefault();
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    const item = data.type === "Item" ? await Item.implementation.fromDropData(data) : null;
    if (!item?.uuid) return ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Errors.DropItem"));
    await this.#persistDraft(station => {
      if (!station.recipes.includes(item.uuid)) station.recipes.push(item.uuid);
    });
  }

  static async #createRecipe() {
    try {
      await createRecipeFromBaseItem("", { onCreate: recipe => this.#persistDraft(station => {
        if (!station.recipes.includes(recipe.uuid)) station.recipes.push(recipe.uuid);
      }) });
    }
    catch (error) { ui.notifications.error(error.message); }
  }

  static async #createRecipeTemplate() {
    const templateId = this.element.querySelector("[data-project-template]")?.value;
    if (!templateId) return;
    try {
      await createRecipeFromBaseItem(templateId, { onCreate: recipe => this.#persistDraft(station => {
        if (!station.recipes.includes(recipe.uuid)) station.recipes.push(recipe.uuid);
      }) });
    } catch (error) {
      ui.notifications.error(error.message);
    }
  }

  static async #removeRecipe(event, target) {
    const current = getStationData(this.actor);
    const item = await fromUuid(target.dataset.uuid);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Station.RemoveProject") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Station.RemoveProjectConfirm", {
        project: foundry.utils.escapeHTML(item?.name || target.dataset.uuid || "")
      })}</p>`
    });
    if (!confirmed || !current.recipes.includes(target.dataset.uuid)) return;
    await this.#persistDraft(station => {
      station.recipes = station.recipes.filter(uuid => uuid !== target.dataset.uuid);
    });
  }

  static async #removeStationTool() {
    await this.#persistDraft(station => { station.requiredTool = null; });
  }

  static async #addModifier() {
    await this.#persistDraft(station => station.modifiers.push({
      id: foundry.utils.randomID(), label: "", operation: "add", value: 0
    }));
  }
  static async #removeModifier(event, target) {
    await this.#persistDraft(station => station.modifiers.splice(Number(target.dataset.index), 1));
  }
  static async #addRollRow() {
    await this.#persistDraft(station => station.rollTable.splice(-1, 0, {
      id: foundry.utils.randomID(), minimum: 0, maximum: null, label: "",
      addition: 0, multiplier: 1, rewardAddition: 0,
      rewardMultiplier: 1, actorValueChange: 0,
      natural1: false, natural20: false
    }));
  }
  static async #removeRollRow(event, target) {
    await this.#persistDraft(station => {
      const index = Number(target.dataset.index);
      const row = station.rollTable[index];
      if (row?.natural1 || row?.natural20) return;
      station.rollTable.splice(index, 1);
    });
  }
  static async #toggleNaturalRow(event, target) {
    await this.#persistDraft(station => {
      const row = station.rollTable[Number(target.dataset.index)];
      if (!row || (!row.natural1 && !row.natural20)) return;
      row.enabled = row.enabled === false;
    });
  }
  static async #addTier() {
    await this.#persistDraft(station => station.actorValue.tiers.push({
      id: foundry.utils.randomID(), minimum: 0, maximum: null,
      addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1
    }));
  }
  static async #removeTier(event, target) {
    await this.#persistDraft(station => station.actorValue.tiers.splice(Number(target.dataset.index), 1));
  }
  static async #moveTier(event, target) {
    await StationConfigApp.#move.call(this, "actorValue.tiers", target);
  }

  static async #resetRollTable() {
    const presetId = String(this.element.querySelector('[name="rollTablePreset"]')?.value ?? "").trim();
    const preset = ROLL_TABLE_PRESETS.find(entry => entry.id === presetId);
    await this.#persistDraft(station => {
      station.rollTable = preset?.rollTable ? foundry.utils.deepClone(preset.rollTable) : [];
      station.rollTablePreset = presetId;
    });
  }

  async #applyRollTablePreset(event) {
    const presetId = String(this.element.querySelector('[name="rollTablePreset"]')?.value ?? "").trim();
    const preset = ROLL_TABLE_PRESETS.find(entry => entry.id === presetId);
    await this.#persistDraft(station => {
      station.rollTablePreset = presetId;
      if (preset?.rollTable) station.rollTable = foundry.utils.deepClone(preset.rollTable);
    });
  }

  static async #resetValueTiers() {
    await this.#persistDraft(station => { station.actorValue.tiers = []; });
  }

  static async #loadValueTierPreset() {
    await this.#persistDraft(station => {
      station.actorValue.tiers = foundry.utils.deepClone(
        DEFAULT_VALUE_TIERS
      );
    });
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

  static async #move(path, target) {
    const index = Number(target.dataset.index);
    const direction = Number(target.dataset.direction);
    await this.#persistDraft(station => {
      const list = foundry.utils.getProperty(station, path);
      const destination = index + direction;
      if (destination < 0 || destination >= list.length) return;
      [list[index], list[destination]] = [list[destination], list[index]];
    });
  }

  static async #removeStation() {
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Station.Remove") },
      content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Station.RemoveConfirm", {
        name: foundry.utils.escapeHTML(this.actor.name)
      })}</p>`
    });
    if (!confirmed) return;
    await this.actor.unsetFlag(MODULE_ID, FLAGS.STATION);
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.StationRemoved"));
    await this.close();
  }

  static async #submit() {
    this.#captureView();
    const station = this.#readStation();
    if (station.actorValue.enabled && station.actorValue.scope === "station" && !station.actorValue.key) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorValueKeyMissing"));
    }
    if (station.actorValue.enabled && station.actorValue.scope === "category" && !station.actorValue.category) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CharacterValueCategoryMissing"));
    }
    if ((station.requiresRoll || station.progressSources.checkProficiency.enabled) && !station.allowedChecks.length) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CheckRequired"));
    }
    const errors = station.requiresRoll ? StationEngine.validateRollTable(station.rollTable) : [];
    if (errors.length) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.InvalidRollTable"));
    }
    const tierErrors = station.actorValue.enabled
      ? StationEngine.validateRollTable(
        station.actorValue.tiers.map(tier => ({ ...tier, natural1: false, natural20: false }))
      )
      : [];
    if (tierErrors.length) {
      return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.InvalidValueTiers"));
    }
    await this.actor.setFlag(MODULE_ID, FLAGS.STATION, station);
    ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.StationSaved"));
    this.render();
  }
  static #addCategorySelection(event, target) { addCategorySelection(target); }
  static #removeCategorySelection(event, target) { removeCategorySelection(target); }
}
