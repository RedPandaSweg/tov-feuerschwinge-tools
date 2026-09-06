import { createDefaultSessionRewards, DEFAULT_MILESTONE_LEVEL_BANDS, DEFAULT_PASSIVE_DOWNTIME, DEFAULT_SESSION_PROGRESS, FLAGS, MODULE_ID, sessionDowntime, SETTINGS } from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { downtimeItemData } from "./downtime-item-service.mjs";
import { RewardService } from "./reward-service.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";
import { round } from "./utils.mjs";

export function isoWeekKey(value = new Date()) {
  const date = new Date(value);
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((utc - start) / 86400000) + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function monthKey(value = new Date()) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

export function playerCharacters() {
  const preferred = new Set(["pc", "character", "player-character"]);
  const strict = game.actors.contents.filter(actor => preferred.has(actor.type));
  const configured = game.settings.get(MODULE_ID, SETTINGS.PLAYER_ACTOR_FOLDERS) ?? {};
  const selectedFolderId = String(configured.folderId ?? configured.folderIds?.[0] ?? "");
  const isInSelectedFolder = actor => {
    if (!selectedFolderId) return true;
    let folder = actor.folder;
    const visited = new Set();
    while (folder && !visited.has(folder.id)) {
      if (selectedFolderId === String(folder.id)) return true;
      visited.add(folder.id);
      const parent = folder.folder;
      folder = typeof parent === "string" ? game.folders.get(parent) : parent;
    }
    return false;
  };
  return (strict.length ? strict : game.actors.contents.filter(actor => actor.type !== "npc" && actor.hasPlayerOwner))
    .filter(isInSelectedFolder)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), game.i18n.lang));
}

export function actorLevel(actor) {
  const adapted = Number(getSystemAdapter().getActorProgressSources(actor)?.level);
  if (Number.isFinite(adapted) && adapted > 0) return Math.min(20, Math.floor(adapted));
  const classes = actor.items?.filter(item => item.type === "class") ?? [];
  const total = classes.reduce((sum, item) => sum + Number(item.system?.levels ?? item.system?.level ?? 0), 0);
  return Math.min(20, Math.max(1, total || 1));
}

export function normalizeMilestoneLevelBands(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : raw;
  const normalized = (Array.isArray(entries) ? entries : [])
    .map(entry => ({
      minLevel: Math.floor(Number(entry?.minLevel)),
      maxLevel: Math.floor(Number(entry?.maxLevel)),
      sessions: Math.floor(Number(entry?.sessions))
    }))
    .sort((a, b) => a.minLevel - b.minLevel);
  const valid = normalized.length > 0
    && normalized[0].minLevel === 1
    && normalized.at(-1).maxLevel === 20
    && normalized.every((entry, index) => (
      entry.minLevel >= 1
      && entry.maxLevel >= entry.minLevel
      && entry.maxLevel <= 20
      && entry.sessions >= 1
      && (index === 0 || entry.minLevel === normalized[index - 1].maxLevel + 1)
    ));
  return valid ? normalized : foundry.utils.deepClone(DEFAULT_MILESTONE_LEVEL_BANDS);
}

export function milestoneLevelBands() {
  return normalizeMilestoneLevelBands(game.settings.get(MODULE_ID, SETTINGS.MILESTONE_LEVEL_BANDS));
}

/** Derive the campaign level from the total number of awarded session milestones. */
export function levelFromMilestones(milestones) {
  let remaining = Math.max(0, Math.floor(Number(milestones) || 0));
  let level = 1;
  const bands = milestoneLevelBands();
  while (level < 20) {
    const sessions = bands.find(band => level >= band.minLevel && level <= band.maxLevel)?.sessions ?? 1;
    if (remaining < sessions) break;
    remaining -= sessions;
    level += 1;
  }
  return level;
}

export function tierOfPlay(level) {
  const value = Math.max(1, Math.min(20, Math.floor(Number(level) || 1)));
  if (value <= 4) return 1;
  if (value <= 10) return 2;
  if (value <= 16) return 3;
  return 4;
}

export function milestoneCatchUpEnabled() {
  return game.settings.get(MODULE_ID, SETTINGS.MILESTONE_CATCH_UP)?.enabled !== false;
}

export function highestMilestoneProgress(actors = playerCharacters()) {
  const entries = actors.map(actor => {
    const milestones = Math.max(0, Math.floor(Number(sessionProgress(actor).milestones) || 0));
    const level = levelFromMilestones(milestones);
    return { actor, milestones, level, tier: tierOfPlay(level) };
  });
  const highestMilestones = Math.max(0, ...entries.map(entry => entry.milestones));
  const leaders = entries.filter(entry => entry.milestones === highestMilestones);
  const highestLevel = levelFromMilestones(highestMilestones);
  return { milestones: highestMilestones, level: highestLevel, tier: tierOfPlay(highestLevel), leaders };
}

export function normalizeSessionRewards(raw) {
  const defaults = createDefaultSessionRewards(getSystemAdapter().getDefaultGoldItemUuid());
  const savedLevels = raw?.schemaVersion === 1 ? [] : (Array.isArray(raw?.levels) ? raw.levels : []);
  const saved = new Map(savedLevels.map(row => [Number(row.level), row]));
  return {
    schemaVersion: 2,
    levels: defaults.levels.map(fallback => {
      const row = saved.get(fallback.level) ?? fallback;
      return {
        level: fallback.level,
        items: (Array.isArray(row.items) ? row.items : [])
          .map(item => ({ uuid: String(item.uuid ?? "").trim(), quantity: Math.max(0, Number(item.quantity) || 0) }))
          .filter(item => item.uuid)
      };
    })
  };
}

export function sessionRewards() {
  return normalizeSessionRewards(game.settings.get(MODULE_ID, SETTINGS.SESSION_REWARDS));
}

export function passiveDowntimeConfig() {
  const stored = game.settings.get(MODULE_ID, SETTINGS.PASSIVE_DOWNTIME) ?? {};
  return {
    enabled: stored.enabled !== false,
    period: stored.period === "week" ? "week" : "month",
    rate: Math.max(0, Number(stored.rate ?? DEFAULT_PASSIVE_DOWNTIME.rate) || 0),
    capMultiplier: Math.max(0, Number(stored.capMultiplier ?? DEFAULT_PASSIVE_DOWNTIME.capMultiplier) || 0)
  };
}

export function rewardForLevel(level) {
  const config = sessionRewards();
  return config.levels.find(row => row.level === Number(level)) ?? config.levels[0];
}

function selectedReward(reward, columns) {
  if (!Array.isArray(columns)) return reward;
  const selected = new Set(columns.map(Number));
  return { ...reward, items: (reward.items ?? []).map((item, index) => ({ ...item, columnIndex: index })).filter(item => selected.has(item.columnIndex)) };
}

export async function sessionRewardDetails(reward, multiplier = 1) {
  const items = [];
  let gold = 0;
  let downtime = 0;
  for (const [index, entry] of (reward.items ?? []).entries()) {
    const document = await fromUuid(entry.uuid).catch(() => null);
    const baseQuantity = Math.max(0, Number(entry.quantity) || 0);
    const quantity = getSystemAdapter().isGoldItem(document) ? round(baseQuantity * multiplier, 6) : baseQuantity;
    const downtimeConfig = downtimeItemData(document);
    if (getSystemAdapter().isGoldItem(document)) gold += quantity;
    if (downtimeConfig) downtime += quantity * downtimeConfig.amount;
    items.push({ uuid: entry.uuid, quantity, name: document?.name ?? entry.uuid, img: document?.img ?? "icons/svg/mystery-man.svg", columnIndex: Number(entry.columnIndex ?? index) });
  }
  return { items, gold: round(gold, 6), downtime: round(downtime, 6) };
}

export function sessionProgress(actor) {
  return foundry.utils.mergeObject(
    foundry.utils.deepClone(DEFAULT_SESSION_PROGRESS),
    actor.getFlag(MODULE_ID, FLAGS.SESSION_PROGRESS) ?? {},
    { inplace: false, recursive: true }
  );
}

async function setProgress(actor, progress) {
  await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, progress);
}

async function historyJournal() {
  const uuid = game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY_JOURNAL);
  const existing = uuid ? await fromUuid(uuid).catch(() => null) : null;
  if (existing) return existing;
  const journal = await JournalEntry.create({
    name: game.i18n.localize("DOWNTIME_MANAGER.Session.HistoryName"),
    ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }
  });
  await game.settings.set(MODULE_ID, SETTINGS.SESSION_HISTORY_JOURNAL, journal.uuid);
  return journal;
}

async function createHistoryPage(record, settlement = false) {
  const journal = await historyJournal();
  const content = historyPageContent(record, settlement);
  const [page] = await journal.createEmbeddedDocuments("JournalEntryPage", [{ name: record.title, type: "text", text: { content, format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.HTML } }]);
  return page;
}

export function milestoneHistoryContent(record) {
  const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
  const label = game.i18n.localize("DOWNTIME_MANAGER.Session.Milestones");
  const rows = (record.participants ?? []).map(entry => `<li><strong>${escape(entry.actorName)}</strong>: ${entry.milestone == null ? "?" : escape(entry.milestone)} ${label}</li>`).join("");
  return `<section data-tovf-milestones="1"><h3>${label}</h3><p>${escape(record.week)}</p><ul>${rows}</ul></section>`;
}

export function milestoneSources(actor, entries = structuredHistory().entries) {
  const sources = entries.flatMap(record => (record.participants ?? [])
    .filter(entry => entry.actorUuid === actor.uuid && Number(entry.milestone) > 0)
    .map(entry => ({ title: record.title, week: record.week, timestamp: record.awardedAt, source: "session", milestone: Number(entry.milestone) })));
  const adjustments = sessionProgress(actor).milestoneAdjustments;
  for (const entry of Array.isArray(adjustments) ? adjustments : []) {
    if (!Number.isFinite(Number(entry.delta))) continue;
    sources.push({ source: entry.source || "correction", title: entry.reason || game.i18n.localize("DOWNTIME_MANAGER.Session.MilestoneOrigin.NoReason"), timestamp: entry.timestamp, milestone: Number(entry.delta) });
  }
  sources.sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
  const documented = sources.reduce((sum, entry) => sum + entry.milestone, 0);
  const total = Number(sessionProgress(actor).milestones) || 0;
  return { sources, documented, total, difference: total - documented };
}

function historyPageContent(record, settlement = false) {
  const rows = (settlement ? record.recipients : record.participants).map(entry =>
    `<li><strong>${foundry.utils.escapeHTML(entry.actorName)}</strong>: ${settlement ? entry.amount : `${entry.downtime} ${game.i18n.localize("DOWNTIME_MANAGER.Session.Downtime")}, ${entry.gold} ${game.i18n.localize("DOWNTIME_MANAGER.Currency.GP")}`}</li>`
  ).join("");
  return `<h2>${foundry.utils.escapeHTML(record.title)}</h2>${record.summary ? `<p>${foundry.utils.escapeHTML(record.summary)}</p>` : ""}<ul>${rows}</ul>${settlement ? "" : milestoneHistoryContent(record)}`;
}

function structuredHistory() {
  const stored = game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY) ?? {};
  return {
    schemaVersion: 1,
    entries: Array.isArray(stored.entries) ? foundry.utils.deepClone(stored.entries) : []
  };
}

async function storeHistoryRecord(record, historyPageUuid = null) {
  const history = structuredHistory();
  const index = history.entries.findIndex(entry => String(entry.id) === String(record.id));
  const stored = { ...foundry.utils.deepClone(record), historyPageUuid };
  if (index === -1) history.entries.push(stored);
  else history.entries[index] = stored;
  await game.settings.set(MODULE_ID, SETTINGS.SESSION_HISTORY, history);
  await game.settings.set(MODULE_ID, SETTINGS.LAST_SESSION_RESULT, foundry.utils.deepClone(record));
  return stored;
}

export class SessionService {
  static busy = false;

  static async validate(active, actorUuids, multiplier, rewardColumns) {
    if (!actorUuids.length || !active?.title) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Required"));
    if (active.status === "awarded") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.AlreadyAwarded"));
    if (![1, 1.5, 2].includes(multiplier)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.InvalidMultiplier"));
    const actors = [];
    for (const uuid of actorUuids) {
      const actor = await fromUuid(uuid).catch(() => null);
      if (!actor || actor.documentName !== "Actor") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.ActorMissing"));
      const rewardLevel = levelFromMilestones(sessionProgress(actor).milestones);
      const reward = selectedReward(rewardForLevel(rewardLevel), rewardColumns);
      await RewardService.validateItems(reward.items);
      actors.push({ actor, reward });
    }
    return actors;
  }

  static async award({ active, actorUuids, multiplier, rewardColumns, awardMilestones = true }) {
    if (game.settings.get(MODULE_ID, "worldRole") !== "primary") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.PrimaryOnly"));
    if (this.busy) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Busy"));
    this.busy = true;
    let lockId = null;
    try {
      const selected = new Set(actorUuids);
      const validated = await this.validate(active, actorUuids, multiplier, rewardColumns);
      lockId = foundry.utils.randomID();
      await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, { ...active, status: "awarding", lockId });
      const locked = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
      if (locked.lockId !== lockId) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Busy"));
      const byUuid = new Map(validated.map(entry => [entry.actor.uuid, entry]));
      const week = isoWeekKey();
      const passiveConfig = passiveDowntimeConfig();
      const periodKey = passiveConfig.period === "week" ? isoWeekKey() : monthKey();
      const participants = [];
      const passiveRecipients = [];
      const guildProgress = highestMilestoneProgress();
      const catchUpEnabled = milestoneCatchUpEnabled();

      for (const actor of playerCharacters()) {
        const progress = sessionProgress(actor);
        if (selected.has(actor.uuid)) {
          const rewardLevel = levelFromMilestones(progress.milestones);
          const reward = byUuid.get(actor.uuid)?.reward ?? selectedReward(rewardForLevel(rewardLevel), rewardColumns);
          const details = await sessionRewardDetails(reward, multiplier);
          await RewardService.grantItems(actor, details.items);
          const actorTier = tierOfPlay(levelFromMilestones(progress.milestones));
          const mayCatchUp = catchUpEnabled && actorTier < guildProgress.tier;
          const milestone = awardMilestones && (progress.lastMilestoneWeek !== week || mayCatchUp) ? 1 : 0;
          await setProgress(actor, { ...progress, milestones: Number(progress.milestones) + milestone, sessionsPlayed: Number(progress.sessionsPlayed) + 1, lastMilestoneWeek: milestone ? week : progress.lastMilestoneWeek });
          participants.push({ actorUuid: actor.uuid, actorName: actor.name, gold: details.gold, downtime: details.downtime, rewards: details.items, milestone });
        } else {
          const passiveLevel = levelFromMilestones(progress.milestones);
          const baseDowntime = sessionDowntime(passiveLevel);
          const current = Number(progress.passiveDowntime?.[periodKey] ?? 0);
          const amount = passiveConfig.enabled
            ? Math.max(0, Math.min(baseDowntime * passiveConfig.rate, baseDowntime * passiveConfig.capMultiplier - current))
            : 0;
          const passiveDowntime = { ...progress.passiveDowntime, [periodKey]: round(current + amount, 6) };
          await setProgress(actor, { ...progress, passiveDowntime });
          passiveRecipients.push({ actorUuid: actor.uuid, actorName: actor.name, awarded: amount, milestones: Number(progress.milestones) || 0, level: passiveLevel, baseDowntime });
        }
      }

      const record = { title: active.title, summary: active.summary, id: active.id, week, periodKey, passivePeriod: passiveConfig.period, multiplier, rewardColumns: Array.isArray(rewardColumns) ? rewardColumns.map(Number) : null, awardMilestones: Boolean(awardMilestones), participants, passiveRecipients, awardedAt: Date.now() };
      const page = game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY_ENABLED) ? await createHistoryPage(record) : null;
      await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, { ...active, status: "awarded", awardedAt: record.awardedAt, historyPageUuid: page?.uuid ?? null });
      await storeHistoryRecord(record, page?.uuid ?? null);
      Hooks.callAll("downtimeManager.sessionCompleted", foundry.utils.deepClone(record));
      return record;
    } catch (error) {
      const current = game.settings.get(MODULE_ID, SETTINGS.ACTIVE_SESSION) ?? {};
      if (lockId && current.status === "awarding" && current.lockId === lockId) {
        await game.settings.set(MODULE_ID, SETTINGS.ACTIVE_SESSION, { ...current, status: "draft", lockId: null });
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  static async settle(month) {
    if (this.busy) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Busy"));
    this.busy = true;
    try {
      const recipients = [];
      for (const actor of playerCharacters()) {
        const progress = sessionProgress(actor);
        const amount = round(Number(progress.passiveDowntime?.[month] ?? 0), 6);
        if (amount <= 0) continue;
        await DowntimeService.add(actor, amount);
        await setProgress(actor, { ...progress, passiveDowntime: { ...progress.passiveDowntime, [month]: 0 } });
        recipients.push({ actorUuid: actor.uuid, actorName: actor.name, amount });
      }
      const record = { title: game.i18n.format("DOWNTIME_MANAGER.Session.SettlementFor", { month }), month, recipients, settledAt: Date.now() };
      if (game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY_ENABLED)) await createHistoryPage(record, true);
      return record;
    } finally {
      this.busy = false;
    }
  }

  static async grantDirectDowntime(actorUuids, amount, { allCharacters = false } = {}) {
    if (!game.user.isGM) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.GMOnly"));
    const value = round(Number(amount), 6);
    if (!Number.isFinite(value) || value <= 0) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Dashboard.Errors.InvalidDowntime"));
    const recipients = [];
    for (const uuid of [...new Set(actorUuids)]) {
      const actor = await fromUuid(uuid).catch(() => null);
      if (!actor || actor.documentName !== "Actor") throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.ActorMissing"));
      await DowntimeService.add(actor, value);
      recipients.push({ actorUuid: actor.uuid, actorName: actor.name, downtime: value, gold: 0 });
    }
    if (game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY_ENABLED) && recipients.length) {
      await createHistoryPage({
        title: game.i18n.localize("DOWNTIME_MANAGER.Dashboard.DirectDowntimeHistory"),
        summary: game.i18n.format("DOWNTIME_MANAGER.Dashboard.DirectDowntimeSummary", { amount: value, count: recipients.length }),
        participants: recipients
      }).catch(error => console.warn(`${MODULE_ID} | Direct downtime history entry failed`, error));
    }
    if (allCharacters && recipients.length) {
      await game.settings.set(MODULE_ID, SETTINGS.LAST_DIRECT_DOWNTIME_ALL, {
        timestamp: Date.now(),
        amount: value,
        count: recipients.length,
        userId: game.user.id,
        userName: game.user.name
      });
    }
    return { amount: value, recipients };
  }

  static historyEntries() {
    return structuredHistory().entries;
  }

  static async correctionDefaults(recordId) {
    const record = structuredHistory().entries.find(entry => String(entry.id) === String(recordId));
    if (!record) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.HistoryMissing"));
    const participants = new Map((record.participants ?? []).map(entry => [entry.actorUuid, entry]));
    const passive = new Map((record.passiveRecipients ?? []).map(entry => [entry.actorUuid, entry]));
    const actors = [];
    for (const actor of playerCharacters()) {
      const existing = participants.get(actor.uuid);
      const historicalMilestones = existing
        ? Math.max(0, Number(sessionProgress(actor).milestones) - Number(existing.milestone ?? 0))
        : Number(passive.get(actor.uuid)?.milestones ?? sessionProgress(actor).milestones);
      const reward = selectedReward(rewardForLevel(levelFromMilestones(historicalMilestones)), record.rewardColumns);
      const details = await sessionRewardDetails(reward, Number(record.multiplier) || 1);
      actors.push({ actorUuid: actor.uuid, actorName: actor.name, selected: Boolean(existing), gold: Number(existing?.gold ?? details.gold), downtime: details.downtime, defaultRewards: details.items });
    }
    return { record, actors };
  }

  static async correctSession({ recordId, actorUuids, goldByActor = {} }) {
    if (!game.user.isGM) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.GMOnly"));
    if (this.busy) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.Busy"));
    this.busy = true;
    try {
      const history = structuredHistory();
      const index = history.entries.findIndex(entry => String(entry.id) === String(recordId));
      if (index < 0) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Session.Errors.HistoryMissing"));
      const record = history.entries[index];
      const defaults = await this.correctionDefaults(recordId);
      const defaultsByUuid = new Map(defaults.actors.map(entry => [entry.actorUuid, entry]));
      const previous = new Map((record.participants ?? []).map(entry => [entry.actorUuid, entry]));
      const passive = new Map((record.passiveRecipients ?? []).map(entry => [entry.actorUuid, entry]));
      const selected = new Set(actorUuids);
      const participants = [];
      const otherMilestoneWeeks = actorUuid => history.entries
        .filter(entry => String(entry.id) !== String(record.id))
        .flatMap(entry => (entry.participants ?? [])
          .filter(participant => participant.actorUuid === actorUuid && Number(participant.milestone ?? 0) > 0)
          .map(() => entry.week))
        .filter(Boolean)
        .sort()
        .reverse();

      for (const actor of playerCharacters()) {
        const oldEntry = previous.get(actor.uuid);
        const shouldParticipate = selected.has(actor.uuid);
        if (!oldEntry && !shouldParticipate) continue;
        const progress = sessionProgress(actor);
        if (oldEntry && !shouldParticipate) {
          await RewardService.adjustItems(actor, (oldEntry.rewards ?? []).map(reward => ({ ...reward, quantity: -Number(reward.quantity ?? 0) })));
          await setProgress(actor, {
            ...progress,
            milestones: Math.max(0, Number(progress.milestones) - Number(oldEntry.milestone ?? 0)),
            sessionsPlayed: Math.max(0, Number(progress.sessionsPlayed) - 1),
            lastMilestoneWeek: Number(oldEntry.milestone ?? 0) > 0 && progress.lastMilestoneWeek === record.week
              ? (otherMilestoneWeeks(actor.uuid)[0] ?? null)
              : progress.lastMilestoneWeek
          });
          continue;
        }

        let nextEntry;
        if (!oldEntry) {
          const rewards = foundry.utils.deepClone(defaultsByUuid.get(actor.uuid)?.defaultRewards ?? []);
          const desiredGold = Math.max(0, Number(goldByActor[actor.uuid] ?? defaultsByUuid.get(actor.uuid)?.gold ?? 0));
          let remainingGold = desiredGold;
          for (const reward of rewards) {
            const source = await fromUuid(reward.uuid).catch(() => null);
            if (!getSystemAdapter().isGoldItem(source)) continue;
            reward.quantity = remainingGold;
            remainingGold = 0;
          }
          await RewardService.grantItems(actor, rewards);
          const passiveEntry = passive.get(actor.uuid);
          const passiveAward = Number(passiveEntry?.awarded ?? 0);
          const passiveDowntime = { ...progress.passiveDowntime };
          const storedPassive = Number(passiveDowntime[record.periodKey] ?? 0);
          const unsettledDeduction = Math.min(storedPassive, passiveAward);
          passiveDowntime[record.periodKey] = round(storedPassive - unsettledDeduction, 6);
          const settledDeduction = round(passiveAward - unsettledDeduction, 6);
          if (settledDeduction > 0 && !await DowntimeService.spend(actor, settledDeduction)) {
            throw new Error(game.i18n.format("DOWNTIME_MANAGER.Session.Errors.PassiveCorrectionInsufficient", { actor: actor.name, amount: settledDeduction }));
          }
          const milestone = record.awardMilestones !== false && !otherMilestoneWeeks(actor.uuid).includes(record.week) ? 1 : 0;
          const lastMilestoneWeek = milestone && (!progress.lastMilestoneWeek || record.week > progress.lastMilestoneWeek)
            ? record.week
            : progress.lastMilestoneWeek;
          await setProgress(actor, { ...progress, passiveDowntime, milestones: Number(progress.milestones) + milestone, sessionsPlayed: Number(progress.sessionsPlayed) + 1, lastMilestoneWeek });
          nextEntry = { actorUuid: actor.uuid, actorName: actor.name, gold: desiredGold, downtime: Number(defaultsByUuid.get(actor.uuid)?.downtime ?? 0), rewards, milestone };
          passive.delete(actor.uuid);
        } else {
          const desiredGold = Math.max(0, Number(goldByActor[actor.uuid] ?? oldEntry.gold ?? 0));
          const rewards = foundry.utils.deepClone(oldEntry.rewards ?? []);
          let oldGold = 0;
          let goldReward = null;
          for (const reward of rewards) {
            const source = await fromUuid(reward.uuid).catch(() => null);
            if (!getSystemAdapter().isGoldItem(source)) continue;
            oldGold += Number(reward.quantity ?? 0);
            if (!goldReward) {
              goldReward = reward;
              reward.quantity = desiredGold;
            } else reward.quantity = 0;
          }
          if (desiredGold !== oldGold && goldReward) await RewardService.adjustItems(actor, [{ ...goldReward, quantity: desiredGold - oldGold }]);
          nextEntry = { ...oldEntry, actorName: actor.name, gold: desiredGold, rewards };
        }
        participants.push(nextEntry);
      }

      const corrected = { ...record, participants, passiveRecipients: [...passive.values()], correctedAt: Date.now() };
      history.entries[index] = corrected;
      await game.settings.set(MODULE_ID, SETTINGS.SESSION_HISTORY, history);
      await game.settings.set(MODULE_ID, SETTINGS.LAST_SESSION_RESULT, foundry.utils.deepClone(corrected));
      const page = corrected.historyPageUuid ? await fromUuid(corrected.historyPageUuid).catch(() => null) : null;
      if (page) await page.update({ name: corrected.title, "text.content": historyPageContent(corrected) });
      return corrected;
    } finally {
      this.busy = false;
    }
  }

  static async openMilestoneHistory(actorUuid) {
    const actor = await fromUuid(actorUuid);
    if (!actor || (!game.user.isGM && !actor.isOwner)) return;
    const data = milestoneSources(actor);
    const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
    const key = "DOWNTIME_MANAGER.Session.MilestoneOrigin";
    const rows = data.sources.map(entry => {
      const date = entry.timestamp ? new Date(entry.timestamp) : null;
      const when = date && Number.isFinite(date.getTime()) ? date.toLocaleString(game.i18n.lang) : entry.week;
      const source = game.i18n.localize(`${key}.Types.${entry.source}`);
      return `<li><strong>${escape(source)}: ${escape(entry.title)}</strong> · ${escape(when)}: ${entry.milestone > 0 ? "+" : ""}${entry.milestone}</li>`;
    }).join("");
    return foundry.applications.api.DialogV2.wait({
      window: { title: `${actor.name} · ${game.i18n.localize(key + ".Title")}` },
      content: `<p>${game.i18n.format(key + ".Totals", data)}</p><ul>${rows}</ul>${data.difference ? `<p>${game.i18n.format(key + ".Difference", data)}</p>` : ""}`,
      buttons: [{ action: "close", label: game.i18n.localize("Close"), default: true }],
      rejectClose: false
    });
  }

  static async openHistory() {
    if (game.settings.get(MODULE_ID, SETTINGS.SESSION_HISTORY_ENABLED)) {
      const journal = await historyJournal();
      if (game.user.isGM) {
        for (const record of structuredHistory().entries) {
          if (!record.historyPageUuid) continue;
          const page = journal.pages.find(page => page.uuid === record.historyPageUuid);
          const content = page?.text?.content;
          if (typeof content === "string" && !content.includes('data-tovf-milestones="1"')) {
            await page.update({ "text.content": content + milestoneHistoryContent(record) });
          }
        }
      }
      return journal.sheet.render(true);
    }
    const entries = structuredHistory().entries.slice().reverse();
    const content = entries.length
      ? `<ol>${entries.map(entry => `<li><strong>${foundry.utils.escapeHTML(entry.title || game.i18n.localize("DOWNTIME_MANAGER.Session.Untitled"))}</strong><br><small>${new Date(entry.awardedAt).toLocaleString()}</small>${entry.summary ? `<p>${foundry.utils.escapeHTML(entry.summary)}</p>` : ""}${milestoneHistoryContent(entry)}</li>`).join("")}</ol>`
      : `<p>${game.i18n.localize("DOWNTIME_MANAGER.Session.HistoryEmpty")}</p>`;
    return foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("DOWNTIME_MANAGER.Session.History") },
      content,
      buttons: [{ action: "close", label: game.i18n.localize("Close"), default: true }],
      rejectClose: false
    });
  }
}
