import { FLAGS, MODULE_ID } from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { GoldService } from "./gold-service.mjs";
import { ResourceService } from "./resource-service.mjs";
import { RewardService } from "./reward-service.mjs";
import { StationEngine } from "./station-engine.mjs";
import { actorKnowsSpell, categoriesMatch, getStationData, hasRequiredTool, recipeData, round } from "./utils.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";

export class ProjectService {
  static get(actor) {
    const stored = actor.getFlag(MODULE_ID, FLAGS.PROJECTS);
    return Array.isArray(stored) ? foundry.utils.deepClone(stored) : [];
  }

  static findState(actor, stationActor, projectUuid) {
    return this.get(actor).find(state =>
      state.stationUuid === stationActor.uuid &&
      (state.projectUuid === projectUuid || state.recipeUuid === projectUuid)
    ) ?? null;
  }

  static async project(projectUuid) {
    const item = await fromUuid(projectUuid);
    if (!item || item.documentName !== "Item") {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectMissing"));
    }
    return { item, definition: recipeData(item, { sourceUuid: projectUuid }) };
  }

  static async start(actor, stationActor, projectUuid, batchQuantity = 1) {
    const { item, definition } = await this.project(projectUuid);
    const station = getStationData(stationActor);
    if (!station.enabled) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.StationDisabled"));
    }
    if (!hasRequiredTool(actor, station.requiredTool)) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.StationToolMissing"));
    }
    if (!(definition.requiredTools ?? []).every(tool => hasRequiredTool(actor, tool))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectToolMissing"));
    }
    const resultUuid = definition.resultUuid || definition.rewards?.[0]?.uuid || "";
    const resultItem = definition.isCustom && resultUuid
      ? await fromUuid(resultUuid).catch(() => null)
      : item;
    if (actorKnowsSpell(actor, resultItem)) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SpellAlreadyKnown"));
    }
    const isPublic = station.recipes.includes(projectUuid);
    const isPersonal = (item.actor ?? item.parent)?.uuid === actor.uuid;
    if (!isPublic && (!isPersonal || !categoriesMatch(station.categories, definition.categories))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectCategoryMismatch"));
    }
    const states = this.get(actor);
    const existing = states.find(state =>
      state.stationUuid === stationActor.uuid && state.projectUuid === projectUuid
    );
    if (existing && !existing.completed) {
      existing.active = true;
      await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states);
      return existing;
    }
    if (existing?.completed && !definition.repeatable) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectAlreadyCompleted"));
    }

    const batches = Math.max(1, Math.floor(Number(batchQuantity) || 1));
    if (!(definition.rewards ?? []).length && !(definition.characterRewards ?? []).length) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RewardRequired"));
    }
    if (!(await ResourceService.has(actor, definition.ingredients ?? [], batches))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ResourcesMissing"));
    }
    const startGold = round(Number(definition.goldCost ?? 0) * batches, 6);
    if (getSystemAdapter().capabilities.currency && startGold > 0 && !(await GoldService.spendGold(actor, startGold))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.GoldMissing"));
    }
    if (!(await ResourceService.spend(actor, definition.ingredients ?? [], batches))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ResourcesMissing"));
    }

    const state = {
      id: foundry.utils.randomID(),
      projectUuid,
      projectName: item.name,
      stationUuid: stationActor.uuid,
      stationName: stationActor.name,
      progress: 0,
      intervalProgress: 0,
      pendingRoll: false,
      completed: false,
      active: true,
      batches,
      requiredProgress: round(Number(definition.requiredProgress) * batches, 6),
      createdAt: Date.now()
    };
    if (existing) Object.assign(existing, state);
    else states.push(state);
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states);
    return state;
  }

  static async invest(actor, stationActor, projectUuid, requestedDowntime, check = null) {
    const station = getStationData(stationActor);
    const { definition } = await this.project(projectUuid);
    const states = this.get(actor);
    const state = states.find(entry =>
      entry.stationUuid === stationActor.uuid &&
      (entry.projectUuid === projectUuid || entry.recipeUuid === projectUuid)
    );
    if (!state || state.completed || state.active === false) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectNotActive"));
    }
    const interval = Math.max(0.000001, Number(station.rollInterval) || 1);
    if (state.pendingRoll && Number(state.intervalProgress ?? 0) < interval - 1e-9) {
      state.pendingRoll = false;
      const recovered = StationEngine.calculateProgress({
        station,
        downtime: Number(state.intervalProgress ?? 0),
        rollRow: { addition: 0, multiplier: 1 },
        actorValue: RewardService.getStationValue(actor, stationActor, station),
        actorSources: StationEngine.actorProgressSources(actor, check)
      });
      state.progress = round(Math.max(0, Number(state.progress) + recovered.progress), 6);
    }
    if (state.pendingRoll) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RollRequired"));
    }
    const maximum = StationEngine.maxInvestment(station, state, DowntimeService.get(actor));
    const requested = Number(requestedDowntime);
    if (!Number.isFinite(requested) || requested <= 0 || requested > maximum + 1e-9) {
      throw new Error(game.i18n.format("DOWNTIME_MANAGER.Errors.InvalidDowntime", { maximum }));
    }
    if (station.progressSources?.checkProficiency?.enabled) {
      this.#validateCheck(station, definition, check);
    }
    if (!(await DowntimeService.spend(actor, requested))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.DowntimeMissing"));
    }
    state.intervalProgress = round(state.intervalProgress + requested, 6);
    const neutralRow = { label: "", addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 };
    const neutralCalculation = StationEngine.calculateProgress({
      station,
      downtime: requested,
      rollRow: neutralRow,
      actorValue: RewardService.getStationValue(actor, stationActor, station),
      actorSources: StationEngine.actorProgressSources(actor, check)
    });
    state.progress = round(Math.max(0, Number(state.progress) + neutralCalculation.progress), 6);
    const completesBeforeRoll = state.progress >= state.requiredProgress - 1e-9;
    const reachesInterval = state.intervalProgress >= interval - 1e-9;
    state.pendingRoll = !completesBeforeRoll && reachesInterval && station.requiresRoll !== false;
    if (completesBeforeRoll || station.requiresRoll === false) {
      const resolved = await this.#resolveInterval({
        actor, stationActor, station, definition, states, state, check,
        row: neutralRow,
        rolled: null,
        progressPrecalculated: true
      });
      return { used: requested, pendingRoll: false, resolved, state };
    }
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states);
    return { used: requested, pendingRoll: state.pendingRoll, state };
  }

  static #validateCheck(station, definition, check) {
    const allowedIds = new Set(
      StationEngine.availableChecks(station, definition).map(entry => StationEngine.checkId(entry))
    );
    if (!allowedIds.has(StationEngine.checkId(check))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CheckNotAllowed"));
    }
  }

  static async resolveRoll(actor, stationActor, projectUuid, check) {
    const station = getStationData(stationActor);
    const { definition } = await this.project(projectUuid);
    const states = this.get(actor);
    const state = states.find(entry =>
      entry.stationUuid === stationActor.uuid &&
      (entry.projectUuid === projectUuid || entry.recipeUuid === projectUuid)
    );
    if (state?.active === false || !state?.pendingRoll) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RollNotReady"));
    }
    this.#validateCheck(station, definition, check);
    const rolled = await StationEngine.roll(actor, check);
    if (!rolled) return null;
    const rollSource = StationEngine.rollConfiguration(station, definition);
    const row = StationEngine.resolveRoll(rollSource, rolled);
    if (!row) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RollResultMissing"));
    return this.#resolveInterval({ actor, stationActor, station, definition, states, state, check, row, rolled, progressPrecalculated: true });
  }

  static async #resolveInterval({ actor, stationActor, station, definition, states, state, check, row, rolled, progressPrecalculated = false }) {
    const actorValue = RewardService.getStationValue(actor, stationActor, station);
    const calculation = StationEngine.calculateProgress({
      station,
      downtime: state.intervalProgress,
      rollRow: row,
      actorValue,
      actorSources: StationEngine.actorProgressSources(actor, check)
    });
    const actorValueModifier = StationEngine.actorValueModifier(station, actorValue);
    const rewardRow = {
      ...row,
      rewardAddition: Number(row.rewardAddition ?? 0) + actorValueModifier.rewardAddition,
      rewardMultiplier: Number(row.rewardMultiplier ?? 1) * actorValueModifier.rewardMultiplier
    };
    const intervalBaseProgress = round(Number(station.baseProgress ?? 0) * Number(state.intervalProgress ?? 0), 6);
    const progressChange = progressPrecalculated
      ? round(Number(row?.addition ?? 0) + intervalBaseProgress * (Number(row?.multiplier ?? 1) - 1), 6)
      : calculation.progress;
    if (progressPrecalculated) {
      calculation.progress = progressChange;
      calculation.bonusOnly = true;
      calculation.intervalBaseProgress = intervalBaseProgress;
    }
    const nextProgress = round(Math.max(0, Number(state.progress) + progressChange), 6);
    const reachedTarget = nextProgress >= state.requiredProgress - 1e-9;
    const requiresCompletionCheck = reachedTarget && definition.completionCheck?.enabled === true;
    let completed = reachedTarget && !requiresCompletionCheck;
    let rewards = [];
    let rewardSummary = [];
    const rewardAddition = rewardRow.rewardAddition;
    const rewardMultiplier = rewardRow.rewardMultiplier;
    if (completed) {
      const rewardItems = (definition.rewards ?? []).map(reward => ({
        ...reward,
        quantity: StationEngine.calculateRewardQuantity(
          reward.quantity ?? 1,
          rewardRow,
          state.batches
        )
      }));
      await RewardService.validateItems(rewardItems);
      RewardService.validateCharacterRewards(definition.characterRewards ?? []);
      if (!(await ResourceService.has(actor, definition.completionCosts ?? [], state.batches))) {
        throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CompletionCostsMissing"));
      }
      await ResourceService.spend(actor, definition.completionCosts ?? [], state.batches);
    }

    state.progress = requiresCompletionCheck ? state.requiredProgress : nextProgress;
    state.intervalProgress = 0;
    state.pendingRoll = false;
    state.lastResult = {
      total: rolled?.total,
      natural: rolled?.natural,
      label: row.label,
      calculation,
      rewardAddition,
      rewardMultiplier
    };
    if (requiresCompletionCheck) {
      state.awaitingCompletionCheck = true;
      state.completionCheckFailed = false;
      state.completionRow = foundry.utils.deepClone(rewardRow);
      delete state.lastCompletionCheck;
    }
    const actorValueBefore = RewardService.getStationValue(actor, stationActor, station);
    await RewardService.changeStationValue(
      actor,
      stationActor,
      station,
      Number(row.actorValueChange ?? 0)
    );

    if (completed) {
      const rewardItems = (definition.rewards ?? []).map(reward => ({
        ...reward,
        quantity: StationEngine.calculateRewardQuantity(
          reward.quantity ?? 1,
          rewardRow,
          state.batches
        )
      }));
      rewards = await RewardService.grantItems(actor, rewardItems);
      const characterRewards = await RewardService.grantCharacterRewards(actor, definition.characterRewards ?? []);
      rewardSummary = rewardItems
        .filter(reward => Number(reward.quantity ?? 0) > 0)
        .map((reward, index) => ({
          name: reward.name ?? rewards[index] ?? reward.uuid,
          quantity: reward.quantity
        }));
      rewardSummary.push(...characterRewards.map(reward => ({
        name: reward.changed ? reward.label : game.i18n.format("DOWNTIME_MANAGER.Project.AlreadyKnown", { name: reward.label }),
        quantity: reward.rank > 1 ? reward.rank : 1
      })));
      await RewardService.changeStationValue(
        actor,
        stationActor,
        station,
        Number(station.actorValue?.completionChange ?? 0)
      );
      if (definition.repeatable) {
        state.progress = 0;
        completed = true;
      } else {
        state.completed = true;
      }
    }
    const actorValueAfter = RewardService.getStationValue(actor, stationActor, station);
    state.lastResult.actorValueBefore = actorValueBefore;
    state.lastResult.actorValueAfter = actorValueAfter;
    state.lastResult.actorValueChange = round(actorValueAfter - actorValueBefore, 6);
    state.lastResult.rewards = rewardSummary;
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states);
    return {
      rolled,
      row,
      calculation,
      rewardAddition,
      rewardMultiplier,
      actorValueBefore,
      actorValueAfter,
      actorValueChange: state.lastResult.actorValueChange,
      completed,
      rewards,
      state
    };
  }

  static async resolveCompletionCheck(actor, stationActor, projectUuid, check) {
    const station = getStationData(stationActor);
    const { definition } = await this.project(projectUuid);
    const states = this.get(actor);
    const state = states.find(entry => entry.stationUuid === stationActor.uuid && (entry.projectUuid === projectUuid || entry.recipeUuid === projectUuid));
    if (!state?.awaitingCompletionCheck || state.completed || state.active === false) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CompletionCheckNotReady"));
    }
    this.#validateCheck(station, definition, check);
    const retryCost = state.completionCheckFailed ? Math.max(0, Number(definition.completionCheck?.retryDowntime ?? 1)) : 0;
    if (retryCost > 0 && DowntimeService.get(actor) + 1e-9 < retryCost) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.DowntimeMissing"));
    }
    const rewardItems = (definition.rewards ?? []).map(reward => ({
      ...reward,
      quantity: StationEngine.calculateRewardQuantity(reward.quantity ?? 1, state.completionRow ?? {}, state.batches)
    }));
    await RewardService.validateItems(rewardItems);
    RewardService.validateCharacterRewards(definition.characterRewards ?? []);
    if (!(await ResourceService.has(actor, definition.completionCosts ?? [], state.batches))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CompletionCostsMissing"));
    }
    const rolled = await StationEngine.roll(actor, check);
    if (!rolled) return null;
    if (retryCost > 0 && !(await DowntimeService.spend(actor, retryCost))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.DowntimeMissing"));
    }
    const dc = Math.max(0, Number(definition.completionCheck?.dc ?? 10));
    const success = Number(rolled.total) >= dc;
    state.lastCompletionCheck = { total: Number(rolled.total), natural: Number(rolled.natural), dc, success, retryCost, check: foundry.utils.deepClone(check) };
    if (!success) {
      state.completionCheckFailed = true;
      await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states);
      return { rolled, dc, success: false, retryCost, state };
    }

    if (!(await ResourceService.spend(actor, definition.completionCosts ?? [], state.batches))) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CompletionCostsMissing"));
    }
    const rewardNames = await RewardService.grantItems(actor, rewardItems);
    const characterRewards = await RewardService.grantCharacterRewards(actor, definition.characterRewards ?? []);
    const rewardSummary = rewardItems.filter(reward => Number(reward.quantity ?? 0) > 0).map((reward, index) => ({ name: reward.name ?? rewardNames[index] ?? reward.uuid, quantity: reward.quantity }));
    rewardSummary.push(...characterRewards.map(reward => ({ name: reward.changed ? reward.label : game.i18n.format("DOWNTIME_MANAGER.Project.AlreadyKnown", { name: reward.label }), quantity: reward.rank > 1 ? reward.rank : 1 })));
    await RewardService.changeStationValue(actor, stationActor, station, Number(station.actorValue?.completionChange ?? 0));
    state.awaitingCompletionCheck = false;
    state.completionCheckFailed = false;
    delete state.completionRow;
    state.lastResult ??= {};
    state.lastResult.rewards = rewardSummary;
    if (definition.repeatable) state.progress = 0;
    else state.completed = true;
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states);
    return { rolled, dc, success: true, retryCost, rewards: rewardNames, state };
  }

  static async cancel(actor, stationActor, projectUuid) {
    const states = this.get(actor);
    const index = states.findIndex(entry =>
      entry.stationUuid === stationActor.uuid &&
      (entry.projectUuid === projectUuid || entry.recipeUuid === projectUuid)
    );
    if (index < 0 || states[index].completed) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectNotActive"));
    }
    const [state] = states.splice(index, 1);
    await actor.setFlag(MODULE_ID, FLAGS.PROJECTS, states);
    return state;
  }
}
