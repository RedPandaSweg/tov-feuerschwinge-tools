import { FLAGS, MODULE_ID } from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { GoldService } from "./gold-service.mjs";
import { ProjectService } from "./project-service.mjs";
import { ResourceService } from "./resource-service.mjs";
import { RewardService } from "./reward-service.mjs";
import { StationEngine } from "./station-engine.mjs";
import { actorKnowsSpell, getStationData, round } from "./utils.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";

export class SharedProjectService {
  static async #assertSpellUnknown(actor, item, definition) {
    const resultUuid = definition.resultUuid || definition.rewards?.[0]?.uuid || "";
    const resultItem = definition.isCustom && resultUuid
      ? await fromUuid(resultUuid).catch(() => null)
      : item;
    if (actorKnowsSpell(actor, resultItem)) {
      throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SpellAlreadyKnown"));
    }
  }

  static get(stationActor) {
    const stored = stationActor.getFlag(MODULE_ID, FLAGS.SHARED_PROJECTS);
    return Array.isArray(stored) ? foundry.utils.deepClone(stored) : [];
  }

  static find(stationActor, projectUuid) {
    return this.get(stationActor).find(state => state.projectUuid === projectUuid && !state.completed) ?? null;
  }

  static async #documents(stationUuid, projectUuid, actorUuid = "") {
    const stationActor = await fromUuid(stationUuid);
    const actor = actorUuid ? await fromUuid(actorUuid) : null;
    const { item, definition } = await ProjectService.project(projectUuid);
    if (!stationActor || stationActor.documentName !== "Actor") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.NotStation"));
    return { stationActor, station: getStationData(stationActor), actor, item, definition };
  }

  static #state(states, projectUuid) {
    const state = states.find(entry => entry.projectUuid === projectUuid && !entry.completed);
    if (!state) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SharedProjectMissing"));
    return state;
  }

  static async start({ stationUuid, projectUuid, leaderUuid, batches = 1 }) {
    const { stationActor, actor: leader, item, definition } = await this.#documents(stationUuid, projectUuid, leaderUuid);
    if (!leader) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    await this.#assertSpellUnknown(leader, item, definition);
    if (!definition.collaborative) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectNotCollaborative"));
    const states = this.get(stationActor);
    if (states.some(state => state.projectUuid === projectUuid && !state.completed)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SharedProjectExists"));
    if (!definition.repeatable && states.some(state => state.projectUuid === projectUuid && state.completed && state.leaderUuid === leaderUuid)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ProjectAlreadyCompleted"));
    const quantity = Math.max(1, Math.floor(Number(batches) || 1));
    if (!(definition.rewards?.length || definition.characterRewards?.length)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RewardRequired"));
    if (!(await ResourceService.has(leader, definition.ingredients ?? [], quantity))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ResourcesMissing"));
    const gold = round(Number(definition.goldCost ?? 0) * quantity, 6);
    if (getSystemAdapter().capabilities.currency && gold > 0 && !(await GoldService.spendGold(leader, gold))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.GoldMissing"));
    if (!(await ResourceService.spend(leader, definition.ingredients ?? [], quantity))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ResourcesMissing"));
    const state = {
      id: foundry.utils.randomID(), projectUuid, projectName: item.name,
      leaderUuid, participantUuids: [leaderUuid], contributions: { [leaderUuid]: { downtime: 0, progress: 0 } },
      progress: 0, intervalProgress: 0, pendingRoll: false, awaitingCompletionCheck: false,
      completed: false, batches: quantity, requiredProgress: round(Number(definition.requiredProgress) * quantity, 6), createdAt: Date.now()
    };
    states.push(state);
    await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, states);
    return state;
  }

  static async join({ stationUuid, projectUuid, actorUuid }) {
    const { stationActor, actor, item, definition } = await this.#documents(stationUuid, projectUuid, actorUuid);
    if (!actor) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.ActorMissing"));
    await this.#assertSpellUnknown(actor, item, definition);
    const states = this.get(stationActor);
    const state = this.#state(states, projectUuid);
    if (!state.participantUuids.includes(actorUuid)) state.participantUuids.push(actorUuid);
    state.contributions[actorUuid] ??= { downtime: 0, progress: 0 };
    await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, states);
    return state;
  }

  static async leave({ stationUuid, projectUuid, actorUuid }) {
    const { stationActor } = await this.#documents(stationUuid, projectUuid);
    const states = this.get(stationActor);
    const state = this.#state(states, projectUuid);
    if (state.leaderUuid === actorUuid) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SharedLeaderCannotLeave"));
    state.participantUuids = state.participantUuids.filter(uuid => uuid !== actorUuid);
    await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, states);
    return state;
  }

  static async cancel({ stationUuid, projectUuid, actorUuid, isGM = false }) {
    const { stationActor } = await this.#documents(stationUuid, projectUuid);
    const states = this.get(stationActor);
    const state = this.#state(states, projectUuid);
    if (!isGM && state.leaderUuid !== actorUuid) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SharedLeaderRequired"));
    await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, states.filter(entry => entry.id !== state.id));
    return state;
  }

  static async invest({ stationUuid, projectUuid, actorUuid, amount, check = null }) {
    const { stationActor, station, actor, definition } = await this.#documents(stationUuid, projectUuid, actorUuid);
    const states = this.get(stationActor);
    const state = this.#state(states, projectUuid);
    if (!state.participantUuids.includes(actorUuid)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SharedParticipantRequired"));
    const interval = Math.max(0.000001, Number(station.rollInterval) || 1);
    if (state.pendingRoll && Number(state.intervalProgress ?? 0) < interval - 1e-9) {
      state.pendingRoll = false;
      const recovered = StationEngine.calculateProgress({ station, downtime: Number(state.intervalProgress ?? 0), rollRow: { addition: 0, multiplier: 1 }, actorValue: RewardService.getStationValue(actor, stationActor, station), actorSources: StationEngine.actorProgressSources(actor, check) });
      state.progress = round(Math.max(0, state.progress + recovered.progress), 6);
      state.contributions[actorUuid].progress = round(Math.max(0, state.contributions[actorUuid].progress + recovered.progress), 6);
    }
    if (state.pendingRoll || state.awaitingCompletionCheck) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RollRequired"));
    const maximum = StationEngine.maxInvestment(station, state, DowntimeService.get(actor));
    const requested = Number(amount);
    if (!Number.isFinite(requested) || requested <= 0 || requested > maximum + 1e-9) throw new Error(game.i18n.format("DOWNTIME_MANAGER.Errors.InvalidDowntime", { maximum }));
    if (!(await DowntimeService.spend(actor, requested))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.DowntimeMissing"));
    state.intervalProgress = round(state.intervalProgress + requested, 6);
    state.lastContributorUuid = actorUuid;
    state.contributions[actorUuid].downtime = round(state.contributions[actorUuid].downtime + requested, 6);
    const neutralRow = { label: "", addition: 0, multiplier: 1, rewardAddition: 0, rewardMultiplier: 1, actorValueChange: 0 };
    const neutralCalculation = StationEngine.calculateProgress({ station, downtime: requested, rollRow: neutralRow, actorValue: RewardService.getStationValue(actor, stationActor, station), actorSources: StationEngine.actorProgressSources(actor, check) });
    state.progress = round(Math.max(0, state.progress + neutralCalculation.progress), 6);
    state.contributions[actorUuid].progress = round(state.contributions[actorUuid].progress + neutralCalculation.progress, 6);
    const completesBeforeRoll = state.progress >= state.requiredProgress - 1e-9;
    const reachesInterval = state.intervalProgress >= interval - 1e-9;
    state.pendingRoll = !completesBeforeRoll && reachesInterval && station.requiresRoll !== false;
    if (completesBeforeRoll || station.requiresRoll === false) await this.#resolve({ stationActor, station, actor, definition, states, state, check, row: neutralRow, rolled: null, progressPrecalculated: true });
    else await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, states);
    return state;
  }

  static async resolveRoll({ stationUuid, projectUuid, actorUuid, check, rolled }) {
    const { stationActor, station, actor, definition } = await this.#documents(stationUuid, projectUuid, actorUuid);
    const states = this.get(stationActor);
    const state = this.#state(states, projectUuid);
    if (!state.participantUuids.includes(actorUuid) || !state.pendingRoll) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RollNotReady"));
    if (state.lastContributorUuid !== actorUuid) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.SharedContributorRollRequired"));
    const allowed = new Set(StationEngine.availableChecks(station, definition).map(StationEngine.checkId));
    if (!allowed.has(StationEngine.checkId(check))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CheckNotAllowed"));
    const row = StationEngine.resolveRoll(StationEngine.rollConfiguration(station, definition), rolled);
    if (!row) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.RollResultMissing"));
    return this.#resolve({ stationActor, station, actor, definition, states, state, check, row, rolled, progressPrecalculated: true });
  }

  static async #resolve({ stationActor, station, actor, definition, states, state, check, row, rolled, progressPrecalculated = false }) {
    const value = RewardService.getStationValue(actor, stationActor, station);
    const calculation = StationEngine.calculateProgress({ station, downtime: state.intervalProgress, rollRow: row, actorValue: value, actorSources: StationEngine.actorProgressSources(actor, check) });
    const valueModifier = StationEngine.actorValueModifier(station, value);
    const rewardRow = { ...row, rewardAddition: Number(row.rewardAddition ?? 0) + valueModifier.rewardAddition, rewardMultiplier: Number(row.rewardMultiplier ?? 1) * valueModifier.rewardMultiplier };
    const intervalBaseProgress = round(Number(station.baseProgress ?? 0) * Number(state.intervalProgress ?? 0), 6);
    const progressChange = progressPrecalculated ? round(Number(row?.addition ?? 0) + intervalBaseProgress * (Number(row?.multiplier ?? 1) - 1), 6) : calculation.progress;
    if (progressPrecalculated) { calculation.progress = progressChange; calculation.bonusOnly = true; calculation.intervalBaseProgress = intervalBaseProgress; }
    state.progress = round(Math.max(0, state.progress + progressChange), 6);
    state.contributions[actor.uuid].progress = round(Math.max(0, state.contributions[actor.uuid].progress + progressChange), 6);
    state.intervalProgress = 0; state.pendingRoll = false;
    state.lastResult = { total: rolled?.total, natural: rolled?.natural, label: row.label, calculation };
    await RewardService.changeStationValue(actor, stationActor, station, Number(row.actorValueChange ?? 0));
    if (state.progress >= state.requiredProgress - 1e-9) {
      if (definition.completionCheck?.enabled) {
        state.awaitingCompletionCheck = true; state.completionRow = foundry.utils.deepClone(rewardRow);
      } else await this.#complete({ stationActor, station, definition, states, state, row: rewardRow });
    }
    await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, states);
    return { state, row, calculation, rolled };
  }

  static async completionRoll({ stationUuid, projectUuid, actorUuid, check, rolled }) {
    const { stationActor, station, actor, definition } = await this.#documents(stationUuid, projectUuid, actorUuid);
    const states = this.get(stationActor); const state = this.#state(states, projectUuid);
    if (!state.participantUuids.includes(actorUuid) || !state.awaitingCompletionCheck) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CompletionCheckNotReady"));
    const allowed = new Set(StationEngine.availableChecks(station, definition).map(StationEngine.checkId));
    if (!allowed.has(StationEngine.checkId(check))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CheckNotAllowed"));
    const retry = state.completionCheckFailed ? Math.max(0, Number(definition.completionCheck?.retryDowntime ?? 1)) : 0;
    if (retry && !(await DowntimeService.spend(actor, retry))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.DowntimeMissing"));
    const dc = Math.max(0, Number(definition.completionCheck?.dc ?? 10));
    const success = Number(rolled.total) >= dc;
    state.lastCompletionCheck = { total: rolled.total, natural: rolled.natural, dc, success, actorUuid };
    if (success) await this.#complete({ stationActor, station, definition, states, state, row: state.completionRow ?? {} });
    else state.completionCheckFailed = true;
    await stationActor.setFlag(MODULE_ID, FLAGS.SHARED_PROJECTS, states);
    return { state, rolled, dc, success, retryCost: retry };
  }

  static async #complete({ stationActor, station, definition, states, state, row }) {
    const leader = await fromUuid(state.leaderUuid);
    const costs = definition.completionCosts ?? [];
    if (!(await ResourceService.has(leader, costs, state.batches))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CompletionCostsMissing"));
    const rewardItems = (definition.rewards ?? []).map(reward => ({ ...reward, quantity: StationEngine.calculateRewardQuantity(reward.quantity ?? 1, row, state.batches) }));
    await RewardService.validateItems(rewardItems); RewardService.validateCharacterRewards(definition.characterRewards ?? []);
    if (!(await ResourceService.spend(leader, costs, state.batches))) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CompletionCostsMissing"));
    await RewardService.grantItems(leader, rewardItems); await RewardService.grantCharacterRewards(leader, definition.characterRewards ?? []);
    await RewardService.changeStationValue(leader, stationActor, station, Number(station.actorValue?.completionChange ?? 0));
    state.awaitingCompletionCheck = false; state.completionCheckFailed = false;
    if (definition.repeatable) state.progress = 0;
    else state.completed = true;
  }
}
