import { getSystemAdapter } from "./system-adapter.mjs";
import { round } from "./utils.mjs";

const EPSILON = 1e-9;

export class StationEngine {
  static normalizeValueTiers(tiers) {
    const normalized = (Array.isArray(tiers) ? tiers : []).map(tier => ({ ...tier }));
    const minimums = [...new Set(normalized
      .map(tier => Number(tier.minimum))
      .filter(Number.isFinite))]
      .sort((a, b) => a - b);

    for (const tier of normalized) {
      const minimum = Number(tier.minimum);
      const nextMinimum = minimums.find(candidate => candidate > minimum);
      tier.maximum = nextMinimum === undefined ? null : nextMinimum - 1;
    }
    return normalized;
  }

  static actorProgressSources(actor, check) {
    return getSystemAdapter().getActorProgressSources(actor, check);
  }

  static checkId(check) {
    return `${check?.type ?? ""}:${check?.key ?? ""}`;
  }

  static availableChecks(station, project) {
    const stationChecks = Array.isArray(station.allowedChecks)
      ? station.allowedChecks
      : [];
    const projectIds = new Set(
      (project.allowedChecks ?? []).map(check => this.checkId(check))
    );
    return stationChecks.filter(check =>
      !projectIds.size || projectIds.has(this.checkId(check))
    );
  }

  static checkDefinitions(checks) {
    const definitions = new Map(
      getSystemAdapter().getCheckDefinitions().map(check => [this.checkId(check), check])
    );
    return checks.map(check => ({
      ...check,
      id: this.checkId(check),
      label: (() => {
        const definition = definitions.get(this.checkId(check));
        return definition?.localized
          ? definition.label
          : game.i18n.localize(definition?.label ?? this.checkId(check));
      })()
    }));
  }

  static async roll(actor, check) {
    return getSystemAdapter().rollCheck(actor, check);
  }

  static validateRollTable(rows) {
    const errors = [];
    const normalRows = rows.filter(row => !row.natural1 && !row.natural20);
    for (const row of normalRows) {
      const minimum = Number(row.minimum);
      const maximum = row.maximum === null || row.maximum === ""
        ? null
        : Number(row.maximum);
      if (!Number.isFinite(minimum) || (maximum !== null && !Number.isFinite(maximum))) {
        errors.push("invalid");
      } else if (maximum !== null && maximum < minimum) {
        errors.push("range");
      }
    }
    const sorted = [...normalRows].sort((a, b) => Number(a.minimum) - Number(b.minimum));
    for (let index = 1; index < sorted.length; index++) {
      const previousMax = sorted[index - 1].maximum === null || sorted[index - 1].maximum === ""
        ? Infinity
        : Number(sorted[index - 1].maximum);
      if (Number(sorted[index].minimum) <= previousMax) errors.push("overlap");
    }
    if (rows.filter(row => row.natural1).length > 1 || rows.filter(row => row.natural20).length > 1) {
      errors.push("natural");
    }
    return [...new Set(errors)];
  }

  static resolveRoll(station, { total, natural }) {
    const rows = Array.isArray(station.rollTable) ? station.rollTable : [];
    const naturalRow = natural === 1
      ? rows.find(row => row.natural1 && row.enabled !== false)
      : natural === 20
        ? rows.find(row => row.natural20 && row.enabled !== false)
        : null;
    if (naturalRow) return naturalRow;
    const value = station.evaluationMode === "natural" ? natural : total;
    return rows.find(row => {
      if (row.natural1 || row.natural20) return false;
      const minimum = Number(row.minimum);
      const maximum = row.maximum === null || row.maximum === ""
        ? Infinity
        : Number(row.maximum);
      return value >= minimum && value <= maximum;
    }) ?? null;
  }

  static rollConfiguration(station, project) {
    return Array.isArray(project?.rollTable) && project.rollTable.length
      ? { ...station, rollTable: project.rollTable }
      : station;
  }

  static actorValueModifier(station, value) {
    if (!station.actorValue?.enabled) {
      return { addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1 };
    }
    const tiers = this.normalizeValueTiers(station.actorValue?.tiers)
      .sort((a, b) => Number(a.minimum) - Number(b.minimum));
    const tier = tiers.find(entry => {
      const minimum = Number(entry.minimum ?? -Infinity);
      const maximum = entry.maximum === null || entry.maximum === ""
        ? Infinity
        : Number(entry.maximum);
      return value >= minimum && value <= maximum;
    });
    return {
      addition: Number(tier?.addition ?? 0),
      multiplier: Number(tier?.multiplier ?? 1),
      rewardAddition: Number(tier?.rewardAddition ?? 0),
      rewardMultiplier: Number(tier?.rewardMultiplier ?? 1)
    };
  }

  static calculateProgress({ station, downtime, rollRow, actorValue, actorSources = {} }) {
    const modifiers = Array.isArray(station.modifiers) ? station.modifiers : [];
    const additional = modifiers
      .filter(modifier => modifier.operation !== "multiply")
      .reduce((sum, modifier) => sum + Number(modifier.value ?? 0), 0);
    const multipliers = modifiers
      .filter(modifier => modifier.operation === "multiply")
      .map(modifier => Number(modifier.value ?? 1));
    const modifierDetails = modifiers.map(modifier => ({
      label: String(modifier.label ?? ""),
      operation: modifier.operation === "multiply" ? "multiply" : "add",
      value: Number(modifier.value ?? (modifier.operation === "multiply" ? 1 : 0))
    }));
    const flagModifier = this.actorValueModifier(station, actorValue);
    const sourceConfig = station.progressSources ?? {};
    const levelAddition = sourceConfig.level?.enabled
      ? Number(actorSources.level ?? 0) * Number(sourceConfig.level.multiplier ?? 1) : 0;
    const proficiencyAddition = sourceConfig.proficiency?.enabled
      ? Number(actorSources.proficiency ?? 0) * Number(sourceConfig.proficiency.multiplier ?? 1) : 0;
    const checkProficiencyAddition = sourceConfig.checkProficiency?.enabled
      ? Number(actorSources.checkProficiency ?? 0) * Number(sourceConfig.checkProficiency.multiplier ?? 1) : 0;

    // Calculation order is intentionally explicit:
    // downtime × additive subtotal × roll multiplier × flag multiplier × other multipliers.
    const additiveSubtotal =
      Number(station.baseProgress ?? 0) +
      Number(rollRow?.addition ?? 0) +
      additional +
      flagModifier.addition +
      levelAddition + proficiencyAddition + checkProficiencyAddition;
    const rollMultiplier = Number(rollRow?.multiplier ?? 1);
    const multiplierProduct = multipliers.reduce((value, multiplier) => value * multiplier, 1);
    const progress = Number(downtime) * additiveSubtotal * rollMultiplier *
      flagModifier.multiplier * multiplierProduct;

    return {
      downtime: Number(downtime),
      baseProgress: Number(station.baseProgress ?? 0),
      rollAddition: Number(rollRow?.addition ?? 0),
      additional,
      flagAddition: flagModifier.addition,
      levelAddition,
      proficiencyAddition,
      checkProficiencyAddition,
      modifierDetails,
      additiveSubtotal,
      rollMultiplier,
      flagMultiplier: flagModifier.multiplier,
      multiplierProduct,
      progress: round(progress, 6)
    };
  }

  static maxInvestment(station, state, availableDowntime) {
    if (state.pendingRoll) return 0;
    const interval = Math.max(EPSILON, Number(station.rollInterval) || 1);
    const missing = Math.max(0, interval - Number(state.intervalProgress ?? 0));
    return round(Math.min(missing, Math.max(0, Number(availableDowntime) || 0)), 6);
  }

  static calculateRewardQuantity(baseQuantity, rollRow, batches = 1) {
    return round(
      Math.max(
        0,
        (Number(baseQuantity ?? 0) + Number(rollRow?.rewardAddition ?? 0)) *
          Number(rollRow?.rewardMultiplier ?? 1) *
          Number(batches ?? 1)
      ),
      6
    );
  }
}
