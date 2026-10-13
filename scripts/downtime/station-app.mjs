import { craftingAccess } from "./crafting-access.mjs";
import { ITEM_RARITY_COLORS, ITEM_RARITY_ORDER } from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { GoldService } from "./gold-service.mjs";
import { ProjectService } from "./project-service.mjs?v=3.8.5-applied-roll-progress-1";
import { ResourceService } from "./resource-service.mjs";
import { RewardService } from "./reward-service.mjs";
import { StationConfigApp } from "./station-config-app.mjs?v=3.4.2-progress-item-controls-1";
import { StationEngine } from "./station-engine.mjs";
import { SharedProjectService } from "./shared-project-service.mjs?v=3.8.5-applied-roll-progress-1";
import { sharedProjectAction } from "./shared-project-socket.mjs?v=3.8.5-applied-roll-progress-1";
import { getSystemAdapter } from "./system-adapter.mjs";
import {
  actorKnowsSpell,
  getActiveCrafter,
  categoriesMatch,
  getStationData,
  hasRequiredTool,
  isRecipeItem,
  recipeData,
  round,
  spellScrollRecipeData,
  spellScrollReference,
  spellScrollScribingRecipeData
} from "./utils.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

function lastResultView(result, actorValueEnabled, actorValueLabel, showRewardSummary = true) {
  if (!result?.calculation) return null;
  const calculation = result.calculation;
  const appliedProgress = Number.isFinite(Number(calculation.appliedProgress))
    ? Number(calculation.appliedProgress)
    : Number(calculation.progress);
  const showsAppliedProgress = Number.isFinite(Number(calculation.appliedProgress));
  const parts = [];
  const addPart = (key, value, neutral, label) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number === neutral) return;
    parts.push({
      key,
      label: label ?? game.i18n.localize(`DOWNTIME_MANAGER.Calculation.${key}`),
      explanation: game.i18n.localize(`DOWNTIME_MANAGER.Calculation.${key}Help`),
      value: number,
      operation: neutral === 0 ? "add" : "multiply"
    });
  };
  addPart("BaseProgress", calculation.baseProgress, 0);
  addPart("RollAddition", calculation.rollAddition, 0);
  addPart("ActorValueAddition", calculation.flagAddition, 0, game.i18n.format(
    "DOWNTIME_MANAGER.Calculation.ActorValueAdditionLabel",
    { label: actorValueLabel }
  ));
  addPart("LevelAddition", calculation.levelAddition, 0);
  addPart("ProficiencyAddition", calculation.proficiencyAddition, 0);
  addPart("CheckProficiencyAddition", calculation.checkProficiencyAddition, 0);
  addPart("RollMultiplier", calculation.rollMultiplier, 1);
  addPart("ActorValueMultiplier", calculation.flagMultiplier, 1, game.i18n.format(
    "DOWNTIME_MANAGER.Calculation.ActorValueMultiplierLabel",
    { label: actorValueLabel }
  ));
  for (const modifier of calculation.modifierDetails ?? []) {
    const multiply = modifier.operation === "multiply";
    addPart(
      multiply ? "OtherMultipliers" : "Additional",
      modifier.value,
      multiply ? 1 : 0,
      modifier.label || game.i18n.localize(`DOWNTIME_MANAGER.Calculation.${multiply ? "OtherMultipliers" : "Additional"}`)
    );
  }
  // Base progress and character sources were awarded on investment already.
  // After a roll, only its increment belongs in this result explanation.
  const displayParts = showsAppliedProgress
    ? parts.filter(part => ["RollAddition", "RollMultiplier"].includes(part.key))
    : parts;
  const additions = displayParts.filter(part => part.operation === "add");
  const multipliers = displayParts.filter(part => part.operation === "multiply");
  const additiveFormula = additions.length
    ? additions.map((part, index) => {
      if (!index) return String(part.value);
      return part.value < 0 ? `− ${Math.abs(part.value)}` : `+ ${part.value}`;
    }).join(" ")
    : "0";
  const multiplierFormula = multipliers.map(part => ` × ${part.value}`).join("");
  const actorValueChange = Number(result.actorValueChange ?? 0);
  return {
    downtime: calculation.downtime,
    rollTotal: result.total,
    natural: result.natural,
    hasRoll: Number.isFinite(Number(result.total)),
    label: result.label,
    progress: appliedProgress,
    rewards: Array.isArray(result.rewards) ? result.rewards : [],
    formula: showsAppliedProgress
      ? `${calculation.rollAddition} + ${calculation.intervalBaseProgress} × (${calculation.rollMultiplier} − 1) = ${appliedProgress}`
      : `${calculation.downtime} × (${additiveFormula})${multiplierFormula} = ${calculation.progress}`,
    parts: displayParts,
    actorValueEnabled,
    hasActorValueResult: Number.isFinite(Number(result.actorValueAfter)),
    actorValueBefore: result.actorValueBefore,
    actorValueAfter: result.actorValueAfter,
    actorValueChange: actorValueChange > 0 ? `+${actorValueChange}` : actorValueChange,
    showRewardSummary
  };
}
function sharedPayload(app, target, actor) { return { stationUuid: app.stationActor.uuid, projectUuid: target.dataset.uuid, actorUuid: actor.uuid }; }

const KNOWN_ITEM_TYPES = new Set([
  "ammunition", "armor", "consumable", "container", "currency", "gear",
  "script", "siege", "sundry", "tool", "vehicle", "weapon"
]);
const KNOWN_ITEM_SUBTYPES = new Set(["food", "poison", "potion", "scroll"]);

function humanize(value) {
  const text = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim();
  return text ? text.replace(/\b\w/g, letter => letter.toUpperCase()) : "";
}

function configuredLabel(key, fallback) {
  const configured = CONFIG.Item?.typeLabels?.[key];
  if (configured) {
    const localized = game.i18n.localize(configured);
    if (localized && localized !== configured) return localized;
  }
  return fallback;
}

function rarityLabel(item) {
  const rawRarity = item?.system?.rarity;
  const rarity = String(rawRarity?.value ?? rawRarity ?? "").trim();
  if (!rarity) {
    return {
      id: "",
      label: "",
      rarityClass: "mundane",
      rarityColor: "",
      rarityOrder: ITEM_RARITY_ORDER.mundane
    };
  }
  const configured = CONFIG.BlackFlag?.rarities?.localized ?? CONFIG.BlackFlag?.rarities ?? {};
  const entry = configured[rarity];
  const localization = entry?.label ?? entry?.localization ?? entry;
  const localized = typeof localization === "string" ? game.i18n.localize(localization) : "";
  const normalized = rarity.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  const rarityClass = {
    mundane: "mundane",
    common: "common",
    uncommon: "uncommon",
    rare: "rare",
    veryrare: "very-rare",
    legendary: "legendary",
    artifact: "artifact",
    fabled: "fabled"
  }[normalized] ?? "";
  return {
    id: rarity,
    label: localized && localized !== localization ? localized : humanize(rarity),
    rarityClass,
    rarityColor: ITEM_RARITY_COLORS[rarityClass] ?? "",
    rarityOrder: ITEM_RARITY_ORDER[rarityClass] ?? ITEM_RARITY_ORDER.mundane
  };
}

async function craftQuantity(name, img, repeatable) {
  if (!repeatable) return 1;
  return foundry.applications.api.DialogV2.prompt({
    classes: ["downtime-manager", "sc-crafting-quantity-dialog"],
    window: { title: game.i18n.localize("DOWNTIME_MANAGER.Actions.Start") },
    position: { width: 280, height: "auto" },
    content: `<div class="standard-form"><header class="sc-crafting-quantity-header"><img src="${foundry.utils.escapeHTML(img || "icons/svg/item-bag.svg")}" alt=""><strong>${foundry.utils.escapeHTML(name)}</strong></header><div class="form-group"><label>${game.i18n.localize("DOWNTIME_MANAGER.Project.Quantity")}:</label><div class="form-fields"><input type="number" name="quantity" value="1" min="1" step="1" autofocus></div></div></div>`,
    ok: {
      label: game.i18n.localize("DOWNTIME_MANAGER.Actions.Start"),
      callback: (_event, button) => button.form?.elements.quantity?.value ?? 1
    },
    render: (_event, dialog) => {
      const row = dialog.element.querySelector(".form-group");
      const footer = dialog.element.querySelector(".form-footer");
      const button = footer?.querySelector('button[data-action="ok"]');
      if (row && button) row.append(button);
      footer?.remove();
    },
    rejectClose: false
  });
}

function projectClassification(item) {
  if (!item || item.documentName !== "Item") {
    return {
      type: "project",
      typeLabel: game.i18n.localize("DOWNTIME_MANAGER.Catalog.OtherProjects"),
      subtype: "",
      subtypeLabel: "",
      rarity: "",
      rarityLabel: "",
      rarityClass: "",
      rarityColor: "",
      rarityOrder: ITEM_RARITY_ORDER.mundane
    };
  }
  const type = String(item.type || "other");
  const typeFallback = KNOWN_ITEM_TYPES.has(type)
    ? game.i18n.localize(`DOWNTIME_MANAGER.Catalog.Types.${type}`)
    : humanize(type) || game.i18n.localize("DOWNTIME_MANAGER.Catalog.Types.sundry");
  const typeLabel = configuredLabel(type, typeFallback);
  const subtypeValues = [
    foundry.utils.getProperty(item, "system.type.base"),
    foundry.utils.getProperty(item, "system.type.category"),
    foundry.utils.getProperty(item, "system.type.value")
  ].map(value => String(value ?? "").trim()).filter(Boolean);
  const subtype = subtypeValues[0] || "";
  const rarity = rarityLabel(item);
  return {
    type,
    typeLabel,
    subtype,
    subtypeLabel: KNOWN_ITEM_SUBTYPES.has(subtype)
      ? game.i18n.localize(`DOWNTIME_MANAGER.Catalog.Subtypes.${subtype}`)
      : humanize(subtype),
    rarity: rarity.id,
    rarityLabel: rarity.label,
    rarityClass: rarity.rarityClass,
    rarityColor: rarity.rarityColor,
    rarityOrder: rarity.rarityOrder
  };
}

export class StationApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-station-{id}",
    classes: ["downtime-manager", "station-app"],
    position: { width: 700, height: 800 },
    window: { title: "DOWNTIME_MANAGER.Station.Title", resizable: true },
    actions: {
      start: StationApp.#start,
      cancel: StationApp.#cancel,
      invest: StationApp.#invest,
      useProgressItem: StationApp.#useProgressItem,
      roll: StationApp.#roll,
      completionRoll: StationApp.#completionRoll,
      openProject: StationApp.#openProject,
      craftProject: StationApp.#craftProject,
      configure: StationApp.#configure,
      sharedStart: StationApp.#sharedStart,
      sharedJoin: StationApp.#sharedJoin,
      sharedLeave: StationApp.#sharedLeave,
      sharedCancel: StationApp.#sharedCancel,
      sharedInvest: StationApp.#sharedInvest,
      sharedUseProgressItem: StationApp.#sharedUseProgressItem,
      sharedRoll: StationApp.#sharedRoll,
      sharedCompletionRoll: StationApp.#sharedCompletionRoll
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/station.hbs" }
  };

  constructor(stationActor, options = {}) {
    super({ ...options, id: `downtime-manager-station-${stationActor.id}` });
    this.stationActor = stationActor;
    this._catalogState = { search: "", type: "", subtype: "", status: "all" };
    this._viewState = null;
    this._documentUpdateHooks = [
      ["updateActor", Hooks.on("updateActor", actor => {
        const crafter = getActiveCrafter();
        if (this.rendered && (actor.id === this.stationActor.id || actor.id === crafter?.id)) {
          this.render();
        }
      })],
      ...["createItem", "updateItem", "deleteItem"].map(hook => [
        hook,
        Hooks.on(hook, item => {
          const crafter = getActiveCrafter();
          if (this.rendered && item.parent?.id === crafter?.id) this.render();
        })
      ])
    ];
  }

  render(options = {}) {
    if (this.rendered && this.element) {
      const body = this.element.querySelector(".sc-body");
      this._viewState = {
        scrollTop: body?.scrollTop ?? 0,
        openProjects: new Set(Array.from(this.element.querySelectorAll("[data-project-entry][open]"), entry => entry.dataset.projectSearch))
      };
    }
    return super.render(options);
  }

  _onRender(context, options) {
    super._onRender(context, options);
    const catalog = this.element.querySelector("[data-project-catalog]");
    if (!catalog) return;

    const search = catalog.querySelector('[data-project-filter="search"]');
    const type = catalog.querySelector('[data-project-filter="type"]');
    const subtype = catalog.querySelector('[data-project-filter="subtype"]');
    const status = catalog.querySelector('[data-project-filter="status"]');
    search.value = this._catalogState.search;
    type.value = this._catalogState.type;
    status.value = this._catalogState.status;

    const apply = ({ rebuildSubtypes = false, selectedSubtype = subtype.value } = {}) => {
      this._catalogState = {
        search: search.value.trim().toLocaleLowerCase(),
        type: type.value,
        subtype: selectedSubtype,
        status: status.value
      };
      if (rebuildSubtypes) {
        const allowedSubtypes = new Map();
        for (const project of catalog.querySelectorAll("[data-project-entry]")) {
          if (!type.value || project.dataset.projectType === type.value) {
            const key = project.dataset.projectSubtype;
            if (key) allowedSubtypes.set(key, project.dataset.projectSubtypeLabel);
          }
        }
        subtype.replaceChildren(new Option(game.i18n.localize("DOWNTIME_MANAGER.Catalog.AllSubtypes"), ""));
        for (const [value, label] of [...allowedSubtypes].sort((a, b) => a[1].localeCompare(b[1]))) {
          subtype.add(new Option(label, value));
        }
        subtype.value = allowedSubtypes.has(selectedSubtype) ? selectedSubtype : "";
        this._catalogState.subtype = subtype.value;
      }

      let visible = 0;
      for (const project of catalog.querySelectorAll("[data-project-entry]")) {
        const matchesSearch = !this._catalogState.search ||
          project.dataset.projectSearch.includes(this._catalogState.search);
        const matchesType = !this._catalogState.type ||
          project.dataset.projectType === this._catalogState.type;
        const matchesSubtype = !this._catalogState.subtype ||
          project.dataset.projectSubtype === this._catalogState.subtype;
        const matchesStatus = this._catalogState.status === "all" ||
          project.dataset.projectStatus === this._catalogState.status;
        project.hidden = !(matchesSearch && matchesType && matchesSubtype && matchesStatus);
        if (!project.hidden) visible++;
      }
      for (const group of catalog.querySelectorAll("[data-project-type-group]")) {
        group.hidden = !group.querySelector("[data-project-entry]:not([hidden])");
      }
      catalog.querySelector("[data-project-empty]").hidden = visible > 0;
    };
    search.addEventListener("input", apply);
    type.addEventListener("change", () => apply({ rebuildSubtypes: true, selectedSubtype: "" }));
    subtype.addEventListener("change", apply);
    status.addEventListener("change", apply);
    apply({ rebuildSubtypes: true, selectedSubtype: this._catalogState.subtype });
    if (this._viewState) {
      const view = this._viewState;
      this._viewState = null;
      for (const project of catalog.querySelectorAll("[data-project-entry]")) {
        project.open = view.openProjects.has(project.dataset.projectSearch);
      }
      requestAnimationFrame(() => {
        const body = this.element?.querySelector(".sc-body");
        if (body) body.scrollTop = view.scrollTop;
      });
    }
  }

  async close(options = {}) {
    for (const [hook, id] of this._documentUpdateHooks ?? []) {
      Hooks.off(hook, id);
    }
    this._documentUpdateHooks = [];
    return super.close(options);
  }

  async _prepareContext() {
    const actor = getActiveCrafter();
    const station = getStationData(this.stationActor);
    const adapter = getSystemAdapter();
    const stationDescription = station.description
      ? await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        String(station.description),
        { async: true, secrets: this.stationActor.isOwner, relativeTo: this.stationActor }
      )
      : "";
    const base = {
      station,
      stationName: station.displayName || this.stationActor.name,
      stationDescription,
      isGM: game.user.isGM,
      disabled: !station.enabled
    };
    if (!actor) return { ...base, noActor: true };

    const progressItems = (await Promise.all(station.progressItems.map(async entry => {
      const document = await fromUuid(entry.uuid).catch(() => null);
      return { ...entry, name: entry.name || document?.name || entry.uuid, img: entry.img || document?.img || "icons/svg/item-bag.svg", available: round(ResourceService.available(actor, entry), 6) };
    }))).filter(entry => entry.available > 0);

    const sources = new Map();
    for (const uuid of station.recipes) sources.set(uuid, { uuid, personal: false });
    for (const item of actor.items.filter(isRecipeItem)) {
      if (sources.has(item.uuid)) continue;
      const definition = recipeData(item, { sourceUuid: item.uuid });
      if (!categoriesMatch(station.categories, definition.categories)) continue;
      sources.set(item.uuid, { uuid: item.uuid, item, personal: true });
    }
    if (station.spellScrollRecipes) {
      for (const item of actor.items) {
        const reference = spellScrollReference(item);
        if (!reference || reference.circle < 1 || sources.has(item.uuid)) continue;
        sources.set(item.uuid, { uuid: item.uuid, item, personal: true, spellScroll: true });
      }
    }
    if (station.spellScrollScribing) {
      for (const item of actor.items) {
        if (item.type !== "spell" || sources.has(item.uuid)) continue;
        sources.set(item.uuid, { uuid: item.uuid, item, personal: true, spellScrollScribing: true });
      }
    }

    const projects = [];
    for (const source of sources.values()) {
      const item = source.item ?? await fromUuid(source.uuid);
      if (!item || item.documentName !== "Item") continue;
      const scrollProject = source.spellScroll ? await spellScrollRecipeData(item) : null;
      const scribingProject = source.spellScrollScribing ? spellScrollScribingRecipeData(item) : null;
      if (source.spellScroll && !scrollProject) continue;
      if (source.spellScrollScribing && !scribingProject) continue;
      const definition = scrollProject?.definition ?? scribingProject?.definition ?? recipeData(item, { sourceUuid: source.uuid });
      const projectStation = StationEngine.projectConfiguration(station, definition);
      const resultUuid = definition.resultUuid || definition.rewards?.[0]?.uuid || "";
      const resultItem = definition.isCustom && resultUuid
        ? await fromUuid(resultUuid).catch(() => null)
        : item;
      const knownSpell = definition.spellScrollScribing
        ? false
        : actorKnowsSpell(actor, resultItem, definition.spellScroll ? { origin: "wizard" } : {});
      const classification = projectClassification(resultItem);
      const descriptionDocument = scrollProject?.spell ?? item;
      const description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(
        String(definition.description ?? ""),
        { async: true, secrets: descriptionDocument.isOwner, relativeTo: descriptionDocument }
      );
      const state = ProjectService.findState(actor, this.stationActor, source.uuid);
      const sharedState = definition.collaborative ? SharedProjectService.find(this.stationActor, source.uuid) : null;
      const rollInterval = Math.max(0.000001, Number(station.rollInterval) || 1);
      if (state?.pendingRoll && Number(state.intervalProgress ?? 0) < rollInterval - 1e-9) state.pendingRoll = false;
      if (sharedState?.pendingRoll && Number(sharedState.intervalProgress ?? 0) < rollInterval - 1e-9) sharedState.pendingRoll = false;
      const sharedJoined = Boolean(sharedState?.participantUuids?.includes(actor.uuid));
      const sharedParticipants = [];
      for (const uuid of sharedState?.participantUuids ?? []) {
        const participant = await fromUuid(uuid);
        const contribution = Array.isArray(sharedState.contributions)
          ? sharedState.contributions.find(entry => entry.actorUuid === uuid) ?? {}
          : sharedState.contributions?.[uuid] ?? {};
        sharedParticipants.push({ uuid, name: participant?.name ?? uuid, leader: uuid === sharedState.leaderUuid, contribution: {
          downtime: round(Math.max(0, Number(contribution.downtime) || 0), 6),
          progress: round(Math.max(0, Number(contribution.progress) || 0), 6)
        } });
      }
      const checks = StationEngine.checkDefinitions(
        StationEngine.availableChecks(projectStation, definition)
      );
      const checkSelectionRequired = Boolean(projectStation.progressSources?.checkProficiency?.enabled);
      const stationToolOk = hasRequiredTool(actor, station.requiredTool);
      const projectToolsOk = (definition.requiredTools ?? []).every(tool => hasRequiredTool(actor, tool));
      const startItemsOk = await ResourceService.has(actor, definition.ingredients ?? []);
      const startGoldOk = !adapter.capabilities.currency || GoldService.getGold(actor) + 1e-9 >= Number(definition.goldCost ?? 0);
      const projectCurrencyCost = adapter.capabilities.currency
        ? await ResourceService.currencyCost(definition.ingredients ?? [])
        : 0;
      const displayedGoldCost = round(Number(definition.goldCost ?? 0) + projectCurrencyCost, 4);
      const progress = Number(state?.progress ?? 0);
      const requiredProgress = Number(state?.requiredProgress ?? definition.requiredProgress);
      const maxInvestment = state
        ? StationEngine.maxInvestment(projectStation, state, DowntimeService.get(actor))
        : 0;
      const sharedMaxInvestment = sharedState && sharedJoined
        ? StationEngine.maxInvestment(projectStation, sharedState, DowntimeService.get(actor))
        : 0;
      const levelAccess = await craftingAccess(actor, item, definition);
      if (definition.spellScroll && (state?.completed || (!state && (knownSpell || levelAccess.blocked)))) continue;
      const sharedEligible = !levelAccess.blocked && station.enabled && stationToolOk && projectToolsOk && !knownSpell;
      const active = Boolean(state && !state.completed && state.active !== false);
      const paused = Boolean(state && !state.completed && state.active === false);
      const projectStatus = active || paused || sharedState
        ? "active"
        : state?.completed ? "completed" : "available";
      projects.push({
        levelBlocked: levelAccess.blocked, levelMessage: levelAccess.message,
        uuid: source.uuid,
        name: definition.projectName || item.name,
        img: item.img,
        description,
        goldCost: displayedGoldCost,
        showGoldCost: adapter.capabilities.currency && displayedGoldCost > 0,
        personal: source.personal,
        repeatable: definition.repeatable,
        singleQuantity: Boolean(definition.spellScroll),
        knownSpell,
        classification,
        projectStatus,
        expanded: projectStatus === "active",
        searchText: `${item.name} ${definition.description ?? ""} ${classification.typeLabel} ${classification.subtypeLabel}`.toLocaleLowerCase(),
        collaborative: Boolean(definition.collaborative),
        sharedState,
        sharedJoined,
        sharedLeader: sharedState?.leaderUuid === actor.uuid,
        sharedEligible,
        sharedCanInvest: sharedEligible && sharedMaxInvestment > 0,
        sharedCanRoll: !levelAccess.blocked && sharedState?.lastContributorUuid === actor.uuid,
        sharedParticipants,
        sharedMaxInvestment,
        sharedInvestmentDefault: Math.min(1, sharedMaxInvestment),
        sharedProgress: round(Number(sharedState?.progress ?? 0), 6),
        sharedRequiredProgress: round(Number(sharedState?.requiredProgress ?? definition.requiredProgress), 6),
        sharedPercent: Math.max(0, Math.min(100, Math.floor(Number(sharedState?.progress ?? 0) / Number(sharedState?.requiredProgress ?? definition.requiredProgress) * 100))),
        progressItems: definition.spellScroll ? [] : progressItems,
        state,
        lastResult: lastResultView(
          state?.lastResult,
          Boolean(projectStation.actorValue.enabled),
          station.actorValue.label || station.actorValue.key || game.i18n.localize("DOWNTIME_MANAGER.Station.ActorValue"),
          definition.isCustom
        ),
        active,
        paused,
        completed: Boolean(state?.completed),
        progress: round(progress, 6),
        requiredProgress: round(requiredProgress, 6),
        percent: requiredProgress > 0 ? Math.max(0, Math.min(100, Math.floor(progress / requiredProgress * 100))) : 100,
        intervalProgress: round(Number(state?.intervalProgress ?? 0), 6),
        rollInterval: station.rollInterval,
        pendingRoll: Boolean(state?.pendingRoll),
        awaitingCompletionCheck: Boolean(state?.awaitingCompletionCheck),
        completionDC: Number(definition.completionCheck?.dc ?? 10),
        completionRetryCost: state?.completionCheckFailed ? Number(definition.completionCheck?.retryDowntime ?? 1) : 0,
        completionCheckFailed: Boolean(state?.completionCheckFailed),
        lastCompletionCheck: state?.lastCompletionCheck ?? null,
        maxInvestment,
        investmentDefault: Math.min(1, maxInvestment),
        checks,
        requiresRoll: projectStation.requiresRoll !== false,
        showCheckSelection: checkSelectionRequired,
        canStart: !levelAccess.blocked && !knownSpell && station.enabled && stationToolOk && projectToolsOk &&
          Boolean(definition.rewards?.length || definition.characterRewards?.length) &&
          (paused || (startItemsOk && startGoldOk && (!state || (state.completed && definition.repeatable)))),
        canInvest: !levelAccess.blocked && station.enabled && Boolean(active && !state.pendingRoll && !state.awaitingCompletionCheck && maxInvestment > 0 && (!checkSelectionRequired || checks.length)),
        canRoll: !levelAccess.blocked && station.enabled && Boolean(active && state.pendingRoll && checks.length),
        canCompletionRoll: !levelAccess.blocked && station.enabled && Boolean(active && state.awaitingCompletionCheck && checks.length && DowntimeService.get(actor) + 1e-9 >= (state.completionCheckFailed ? Number(definition.completionCheck?.retryDowntime ?? 1) : 0))
      });
    }
    projects.sort((a, b) => a.classification.rarityOrder - b.classification.rarityOrder || a.name.localeCompare(b.name, game.i18n.lang));
    const projectTypes = [...new Map(projects.map(project => [
      project.classification.type,
      project.classification.typeLabel
    ]))].map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const projectGroups = Array.from(projects.reduce((groups, project) => {
      const key = project.classification.type;
      const group = groups.get(key) ?? {
        key,
        label: project.classification.typeLabel,
        projects: []
      };
      group.projects.push(project);
      groups.set(key, group);
      return groups;
    }, new Map()).values())
      .map(group => ({
        ...group,
        projects: group.projects.sort((a, b) =>
          a.classification.rarityOrder - b.classification.rarityOrder ||
          a.name.localeCompare(b.name, game.i18n.lang))
      }))
      .sort((a, b) => a.label.localeCompare(b.label, game.i18n.lang));
    return {
      ...base,
      actorName: actor.name,
      actorImg: actor.img,
      downtime: DowntimeService.get(actor),
      gold: round(GoldService.getGold(actor), 2),
      showGold: adapter.capabilities.currency,
      actorValue: RewardService.getStationValue(actor, this.stationActor, station),
      actorValueLabel: station.actorValue.label || station.actorValue.key,
      actorValueEnabled: Boolean(station.actorValue.enabled),
      projectTypes,
      projectGroups,
      projects
    };
  }

  static #configure() {
    if (game.user.isGM) new StationConfigApp(this.stationActor).render(true);
  }

  static async #openProject(event, target) {
    event.preventDefault();
    const item = await globalThis.fromUuid?.(target.dataset.uuid).catch(() => null);
    if (!item) return;
    const { openItemPreview } = await import("../commerce/app.mjs?v=3.8.5-merchant-interactor-avatar-1");
    const opened = await openItemPreview(item, getActiveCrafter());
    if (!opened) ui.notifications.warn(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
  }

  static async #craftProject(event, target) {
    event.preventDefault();
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    const card = target.closest("[data-project-entry]");
    const quantity = await craftQuantity(
      card?.dataset.projectName ?? "",
      card?.querySelector("img")?.src,
      target.dataset.repeatable === "true"
    );
    if (quantity === null || quantity === undefined) return;
    try {
      if (target.dataset.collaborative === "true") {
        await sharedProjectAction("start", {
          stationUuid: this.stationActor.uuid,
          projectUuid: target.dataset.uuid,
          leaderUuid: actor.uuid,
          batches: quantity
        });
        ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.SharedProjectStarted"));
      } else {
        await ProjectService.start(actor, this.stationActor, target.dataset.uuid, quantity);
        ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.ProjectStarted"));
      }
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #start(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    try {
      const quantity = this.element.querySelector(`[data-quantity-for="${CSS.escape(target.dataset.uuid)}"]`)?.value ?? 1;
      await ProjectService.start(actor, this.stationActor, target.dataset.uuid, quantity);
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.ProjectStarted"));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #invest(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    try {
      const input = this.element.querySelector(`[data-downtime-for="${CSS.escape(target.dataset.uuid)}"]`);
      const select = this.element.querySelector(`[data-check-for="${CSS.escape(target.dataset.uuid)}"]`);
      const [type, key] = String(select?.value ?? "").split(":");
      const result = await ProjectService.invest(actor, this.stationActor, target.dataset.uuid, input?.value, { type, key });
      ui.notifications.info(game.i18n.format(
        result.pendingRoll ? "DOWNTIME_MANAGER.Notifications.DowntimeInvestedRoll" : "DOWNTIME_MANAGER.Notifications.DowntimeInvested",
        { amount: result.used }
      ));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #useProgressItem(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    try {
      const quantity = target.closest("[data-progress-item]")?.querySelector("[data-progress-item-quantity]")?.value ?? 1;
      const result = await ProjectService.useProgressItem(actor, this.stationActor, target.dataset.uuid, target.dataset.itemUuid, quantity);
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Notifications.ProgressItemUsed", result)); this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #cancel(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    try {
      const { item } = await ProjectService.project(target.dataset.uuid);
      const confirmed = await foundry.applications.api.DialogV2.confirm({
        window: { title: game.i18n.localize("DOWNTIME_MANAGER.Dashboard.RemoveProject") },
        content: `<p>${game.i18n.format("DOWNTIME_MANAGER.Dashboard.RemoveProjectConfirm", {
          project: foundry.utils.escapeHTML(item.name || ""),
          actor: foundry.utils.escapeHTML(actor.name || "")
        })}</p>`
      });
      if (!confirmed) return;
      await ProjectService.cancel(actor, this.stationActor, target.dataset.uuid);
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Dashboard.ProjectRemoved"));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #roll(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    const select = this.element.querySelector(`[data-check-for="${CSS.escape(target.dataset.uuid)}"]`);
    const [type, key] = String(select?.value ?? "").split(":");
    try {
      const result = await ProjectService.resolveRoll(actor, this.stationActor, target.dataset.uuid, { type, key });
      if (!result) return;
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Notifications.RollResolved", {
        result: result.row.label || result.rolled.total,
        progress: result.calculation.appliedProgress ?? result.calculation.progress
      }));
      if (result.actorValueChange) {
        ui.notifications.info(game.i18n.format(
          "DOWNTIME_MANAGER.Notifications.ActorValueChanged",
          {
            label: getStationData(this.stationActor).actorValue?.label
              || game.i18n.localize("DOWNTIME_MANAGER.Station.ActorValue"),
            change: result.actorValueChange > 0
              ? `+${result.actorValueChange}`
              : result.actorValueChange,
            value: result.actorValueAfter
          }
        ));
      }
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #completionRoll(event, target) {
    const actor = getActiveCrafter();
    if (!actor) return ui.notifications.error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    const select = this.element.querySelector(`[data-completion-check-for="${CSS.escape(target.dataset.uuid)}"]`);
    const [type, key] = String(select?.value ?? "").split(":");
    try {
      const result = await ProjectService.resolveCompletionCheck(actor, this.stationActor, target.dataset.uuid, { type, key });
      if (!result) return;
      ui.notifications.info(game.i18n.format(result.success
        ? "DOWNTIME_MANAGER.Notifications.CompletionCheckPassed"
        : "DOWNTIME_MANAGER.Notifications.CompletionCheckFailed", { total: result.rolled.total, dc: result.dc }));
      this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }

  static async #sharedStart(event, target) {
    const actor = getActiveCrafter(); if (!actor) return;
    try {
      const batches = this.element.querySelector(`[data-shared-quantity-for="${CSS.escape(target.dataset.uuid)}"]`)?.value ?? 1;
      await sharedProjectAction("start", { stationUuid: this.stationActor.uuid, projectUuid: target.dataset.uuid, leaderUuid: actor.uuid, batches });
      ui.notifications.info(game.i18n.localize("DOWNTIME_MANAGER.Notifications.SharedProjectStarted")); this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedJoin(event, target) { const actor = getActiveCrafter(); try { await sharedProjectAction("join", sharedPayload(this, target, actor)); this.render(); } catch (error) { ui.notifications.error(error.message); } }
  static async #sharedLeave(event, target) { const actor = getActiveCrafter(); try { await sharedProjectAction("leave", sharedPayload(this, target, actor)); this.render(); } catch (error) { ui.notifications.error(error.message); } }
  static async #sharedCancel(event, target) {
    const actor = getActiveCrafter();
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Project.CancelShared") },
      content: `<p>${game.i18n.localize("DOWNTIME_MANAGER.Project.CancelSharedConfirm")}</p>`
    });
    if (!confirmed) return;
    try { await sharedProjectAction("cancel", sharedPayload(this, target, actor)); this.render(); }
    catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedInvest(event, target) {
    const actor = getActiveCrafter();
    try {
      const amount = this.element.querySelector(`[data-shared-downtime-for="${CSS.escape(target.dataset.uuid)}"]`)?.value;
      const select = this.element.querySelector(`[data-shared-check-for="${CSS.escape(target.dataset.uuid)}"]`); const [type, key] = String(select?.value ?? "").split(":");
      await sharedProjectAction("invest", { ...sharedPayload(this, target, actor), amount, check: { type, key } }); this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedUseProgressItem(event, target) {
    const actor = getActiveCrafter();
    try {
      const quantity = target.closest("[data-progress-item]")?.querySelector("[data-progress-item-quantity]")?.value ?? 1;
      const result = await sharedProjectAction("useProgressItem", { ...sharedPayload(this, target, actor), itemUuid: target.dataset.itemUuid, quantity });
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Notifications.ProgressItemUsed", result)); this.render();
    } catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedRoll(event, target) {
    const actor = getActiveCrafter(); const select = this.element.querySelector(`[data-shared-check-for="${CSS.escape(target.dataset.uuid)}"]`); const [type, key] = String(select?.value ?? "").split(":");
    try { const rolled = await StationEngine.roll(actor, { type, key }); if (!rolled) return; await sharedProjectAction("resolveRoll", { ...sharedPayload(this, target, actor), check: { type, key }, rolled: { total: rolled.total, natural: rolled.natural } }); this.render(); } catch (error) { ui.notifications.error(error.message); }
  }
  static async #sharedCompletionRoll(event, target) {
    const actor = getActiveCrafter(); const select = this.element.querySelector(`[data-shared-completion-check-for="${CSS.escape(target.dataset.uuid)}"]`); const [type, key] = String(select?.value ?? "").split(":");
    try { const rolled = await StationEngine.roll(actor, { type, key }); if (!rolled) return; await sharedProjectAction("completionRoll", { ...sharedPayload(this, target, actor), check: { type, key }, rolled: { total: rolled.total, natural: rolled.natural } }); this.render(); } catch (error) { ui.notifications.error(error.message); }
  }
}
