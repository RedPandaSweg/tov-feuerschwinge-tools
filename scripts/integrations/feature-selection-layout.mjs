import { MODULE_ID } from "../core/constants.mjs";

function rootOf(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function selectionType(app) {
  return app?.options?.details?.type ?? app?.advancement?.configuration?.type ?? null;
}

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase(game.i18n.lang);
}

const PREREQUISITE_PATCH = Symbol.for(`${MODULE_ID}.talentPrerequisites`);
const ABILITY_GROUP_FLAG = "talentPrerequisites.anyAbility";

function anyAbilityEnabled(model) {
  return Boolean(foundry.utils.getProperty(model?.parent?.flags?.[MODULE_ID], ABILITY_GROUP_FLAG));
}

function normalizedValidation(result) {
  return Array.isArray(result) && result.length === 0 ? true : result;
}

function restrictionView(model, overrides) {
  const view = Object.create(model);
  Object.defineProperty(view, "restriction", {
    configurable: true,
    value: { ...model.restriction, ...overrides }
  });
  return view;
}

function expandedProficiencyActor(actor) {
  const proficiencies = actor?.system?.proficiencies;
  if (!proficiencies) return actor;

  const expanded = {};
  for (const trait of ["armor", "weapons"]) {
    const current = proficiencies[trait];
    const values = current?.value;
    if (!values?.[Symbol.iterator]) continue;

    const next = new Set(values);
    const configuration = CONFIG.BlackFlag?.[trait];
    for (const key of values) {
      for (const child of Object.keys(configuration?.[key]?.children ?? {})) next.add(child);
    }
    if (next.size > values.size) expanded[trait] = { ...current, value: next };
  }
  if (!Object.keys(expanded).length) return actor;

  const proficiencyView = new Proxy(proficiencies, {
    get(target, property) {
      return expanded[property] ?? Reflect.get(target, property, target);
    }
  });
  const systemView = new Proxy(actor.system, {
    get(target, property) {
      return property === "proficiencies" ? proficiencyView : Reflect.get(target, property, target);
    }
  });
  return new Proxy(actor, {
    get(target, property) {
      return property === "system" ? systemView : Reflect.get(target, property, target);
    }
  });
}

function nativeCategoryProficiencySupport(validatePrerequisites) {
  const category = Object.entries(CONFIG.BlackFlag?.weapons ?? {})
    .find(([, data]) => Object.keys(data?.children ?? {}).length);
  if (!category) return false;
  const [categoryKey, categoryData] = category;
  const weaponKey = Object.keys(categoryData.children)[0];
  const model = {
    restriction: {
      custom: [],
      filters: [{
        _id: "weaponsProficiency",
        k: "system.proficiencies.weapons.value",
        o: "hasAny",
        v: [weaponKey]
      }],
      items: new Set(),
      requireAll: true
    }
  };
  const actor = {
    sourcedItems: new Map(),
    system: { proficiencies: { weapons: { value: new Set([categoryKey]) } } }
  };
  try {
    return normalizedValidation(validatePrerequisites.call(model, actor)) === true;
  } catch {
    return false;
  }
}

function groupedRestrictions(model) {
  if (!model.restriction.requireAll || !anyAbilityEnabled(model)) return null;
  const abilities = model.restriction.filters.filter(filter => filter._id?.startsWith("ability-"));
  if (abilities.length < 2) return null;
  const otherFilters = model.restriction.filters.filter(filter => !filter._id?.startsWith("ability-"));
  return { abilities, otherFilters };
}

function mergeValidationResults(abilityResult, otherResult) {
  abilityResult = normalizedValidation(abilityResult);
  otherResult = normalizedValidation(otherResult);
  const abilityValid = abilityResult === true || abilityResult === null;
  const otherValid = otherResult === true || otherResult === null;
  if (abilityValid && otherValid) return abilityResult === null || otherResult === null ? null : true;
  return [
    ...(Array.isArray(abilityResult) ? abilityResult : []),
    ...(Array.isArray(otherResult) ? otherResult : [])
  ];
}

function installTalentPrerequisiteFixes() {
  const TalentData = CONFIG.Item.dataModels?.talent;
  const prototype = TalentData?.prototype;
  const PrerequisiteConfig = BlackFlag?.applications?.item?.PrerequisiteConfig;
  const configPrototype = PrerequisiteConfig?.prototype;
  const originalValidation = prototype?.validatePrerequisites;
  const originalLabel = prototype?.createPrerequisiteLabel;
  const originalGeneralContext = configPrototype?._prepareGeneralContext;
  if (![originalValidation, originalLabel, originalGeneralContext].every(method => typeof method === "function")) {
    return { status: "incompatible", reason: "Missing Black Flag talent prerequisite validation or configuration API." };
  }
  if (prototype[PREREQUISITE_PATCH] || configPrototype[PREREQUISITE_PATCH]) {
    return { status: "already-installed", reason: "Talent prerequisite compatibility patch is already installed." };
  }
  const nativeCategoryAware = nativeCategoryProficiencySupport(originalValidation);

  Object.defineProperty(prototype, PREREQUISITE_PATCH, {
    value: { originalValidation, originalLabel, nativeCategoryAware }
  });
  Object.defineProperty(configPrototype, PREREQUISITE_PATCH, { value: { originalGeneralContext } });
  Object.defineProperty(prototype, "validatePrerequisites", {
    configurable: true,
    writable: true,
    value(actor) {
      const actorView = nativeCategoryAware ? actor : expandedProficiencyActor(actor);
      const groups = groupedRestrictions(this);
      if (!groups) return normalizedValidation(originalValidation.call(this, actorView));

      const abilityView = restrictionView(this, {
        filters: groups.abilities,
        items: new Set(),
        custom: [],
        requireAll: false
      });
      const otherView = restrictionView(this, { filters: groups.otherFilters, requireAll: true });
      return mergeValidationResults(
        originalValidation.call(abilityView, actorView),
        originalValidation.call(otherView, actorView)
      );
    }
  });
  Object.defineProperty(prototype, "createPrerequisiteLabel", {
    configurable: true,
    writable: true,
    value(actor) {
      const actorView = nativeCategoryAware ? actor : expandedProficiencyActor(actor);
      const groups = groupedRestrictions(this);
      if (!groups) return originalLabel.call(this, actorView);

      const abilityView = restrictionView(this, {
        filters: groups.abilities,
        items: new Set(),
        custom: [],
        requireAll: false
      });
      const otherView = restrictionView(this, { filters: groups.otherFilters, requireAll: true });
      const abilityLabel = originalLabel.call(abilityView, actorView);
      const otherLabel = originalLabel.call(otherView, actorView);
      if (!otherLabel) return abilityLabel;
      if (!abilityLabel) return otherLabel;
      return game.i18n.getListFormatter({ type: "conjunction", style: "short" })
        .format([`(${abilityLabel})`, otherLabel]);
    }
  });
  Object.defineProperty(configPrototype, "_prepareGeneralContext", {
    configurable: true,
    writable: true,
    value(context, options) {
      context = originalGeneralContext.call(this, context, options);
      if (this.document?.type !== "talent") return context;
      context.fields.push({
        field: new foundry.data.fields.BooleanField({
          label: "TOVF.TalentPrerequisites.AnyAbility.Label",
          hint: "TOVF.TalentPrerequisites.AnyAbility.Hint"
        }),
        localize: true,
        name: `flags.${MODULE_ID}.${ABILITY_GROUP_FLAG}`,
        value: anyAbilityEnabled(this.document.system)
      });
      return context;
    }
  });
  return {
    status: "completed",
    reason: "Installed guarded category-aware proficiency validation and optional grouped ability prerequisites.",
    patches: {
      categoryAwareProficiencies: nativeCategoryAware ? "native" : "guarded-data-expansion-fallback",
      groupedAbilities: `flags.${MODULE_ID}.${ABILITY_GROUP_FLAG}`,
      emptyPrerequisites: "normalized"
    }
  };
}

function styleFeatureSelection(app, element) {
  const Dialog = BlackFlag?.applications?.advancement?.ChooseFeaturesDialog;
  if (!Dialog || !(app instanceof Dialog)) return;
  const type = selectionType(app);
  if (!["feature", "talent"].includes(type)) return;

  const root = rootOf(element);
  const contents = root?.matches?.(".contents") ? root : root?.querySelector?.(".contents");
  if (!contents || contents.querySelector("[data-tovf-feature-search]")) return;

  const application = root.closest(".application") ?? root;
  application.classList.add("tovf-feature-selection-dialog", `tovf-feature-selection-${type}`);

  const search = document.createElement("label");
  search.className = "tovf-feature-selection-search";
  const icon = document.createElement("i");
  icon.className = "fa-solid fa-magnifying-glass";
  icon.setAttribute("inert", "");
  const input = document.createElement("input");
  input.type = "search";
  input.dataset.tovfFeatureSearch = "true";
  input.placeholder = type === "talent" ? "Search Talents…" : "Search Class Features…";
  input.setAttribute("aria-label", input.placeholder);
  search.append(icon, input);

  const empty = document.createElement("p");
  empty.className = "tovf-feature-selection-empty hint";
  empty.textContent = "No matching options.";
  empty.hidden = true;

  const options = [...contents.querySelectorAll(":scope > .option")];
  for (const option of options) option.dataset.tovfSearch = normalize(option.querySelector(".name")?.textContent);
  input.addEventListener("input", () => {
    const needle = normalize(input.value);
    let visible = 0;
    for (const option of options) {
      const matches = !needle || option.dataset.tovfSearch.includes(needle);
      option.hidden = !matches;
      if (matches) visible += 1;
    }
    empty.hidden = visible > 0;
  });

  contents.prepend(search);
  search.after(empty);
}

/** Style Black Flag's class-feature and talent choices and add name filtering. */
export function installFeatureSelectionLayout() {
  if (!BlackFlag?.applications?.advancement?.ChooseFeaturesDialog) {
    return { status: "incompatible", reason: "Missing BlackFlag.applications.advancement.ChooseFeaturesDialog." };
  }
  const prerequisiteResult = installTalentPrerequisiteFixes();
  if (["incompatible", "already-installed"].includes(prerequisiteResult.status)) return prerequisiteResult;
  Hooks.on("renderApplicationV2", styleFeatureSelection);
  return prerequisiteResult;
}
