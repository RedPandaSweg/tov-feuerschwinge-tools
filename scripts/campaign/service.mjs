import { uiText } from "../core/localization.mjs";
import { MODULE_ID, FLAGS } from "../downtime/constants.mjs";
import { compareSnapshots, validateSnapshot, sessionDate, effectiveSessionStatus } from "./data.mjs";
import { defaultRules, validateRules, settlementPreview, ruleForDate } from "./rules.mjs";
import { levelFromMilestones, milestoneEntries, sessionProgress, rewardForLevel, sessionRewardDetails, isoWeekKey, SessionService } from "../downtime/session-service.mjs";
import { GoldService } from "../downtime/gold-service.mjs";
import { RewardService } from "../downtime/reward-service.mjs";
import { getSystemAdapter } from "../downtime/system-adapter.mjs";
import { linkedPerson, charactersForPerson, personAccountIds, detectCampaignLinks } from "./identities.mjs";
import { reconciliationPlan, reconcileEntries } from "./reconciliation.mjs";
import { weeklyPreview } from "./weekly.mjs";
import { rewardNote } from "./reward-label.mjs";
import { autoLinkSessions } from "./session-links.mjs";

export const CAMPAIGN_SETTING = "campaignLedger";
const REQUEST = "campaignRequest";
const RESPONSE = "campaignResponse";
export const fullGM = (user = game.user) => user?.role === CONST.USER_ROLES.GAMEMASTER;
export const isCampaignWorld = () => game.settings.get(MODULE_ID, "worldRole") === "primary";
// Keep one writer for the ledger, including when only normal game masters are online.
// Request authorization remains in execute/redemptionPreview, independent of the writer.
const coordinator = () => game.users.filter(u => u.active && u.isGM && u.can("SETTINGS_MODIFY"))
  .sort((a, b) => Number(fullGM(b)) - Number(fullGM(a)) || a.id.localeCompare(b.id))[0];
const clone = value => foundry.utils.deepClone(value);

export function campaignState() {
  const state = Object.assign({ schemaVersion: 1, revision: 0, snapshot: null, rules: [defaultRules()], personLinks: {}, personAccounts: {}, personNames: {}, characterLinks: {}, sessionReviews: {}, recipients: {}, allocations: {}, settlements: {}, claims: [], redemptions: [], audit: [] }, clone(game.settings.get(MODULE_ID, CAMPAIGN_SETTING) ?? {}));
  // Only the untouched, never-used initial preset follows the new defaults.
  // Named/saved rules and existing claims keep their historical behavior.
  state.rules = state.rules.map(rule => rule.id === "initial" && !rule.gm.reward.mode && !rule.community.reward.mode
    && !state.claims.some(c => c.ruleId === rule.id) && !Object.keys(state.settlements).length
    ? { ...defaultRules(), effectiveFrom: rule.effectiveFrom, timeZone: rule.timeZone } : rule);
  if (!ruleForDate(state.rules, "2026-08-01")) state.rules.push({ ...defaultRules(), id: "retro-august-2026", effectiveFrom: "2026-08-01" });
  return state;
}

function primaryWorld() {
  if (!isCampaignWorld()) throw new Error(uiText("TOVF.Interface.RewardManagementIsOnlyAvailableInThe_62a9e7", "Belohnungsverwaltung ist nur in der Hauptwelt verfügbar."));
}

function requiredGM(user) {
  if (!fullGM(user)) throw new Error(uiText("TOVF.Interface.OnlyTheFullGMRoleMayMake_c446ad", "Diese Änderung darf nur die Rolle Spielleiter vornehmen."));
}

async function save(state) {
  state.revision++;
  await game.settings.set(MODULE_ID, CAMPAIGN_SETTING, state);
}

export async function redemptionPreview(state, user, claimId, actorUuid) {
  primaryWorld();
  const claim = state.claims.find(c => c.id === claimId);
  if (!claim || (!fullGM(user) && claim.personId !== linkedPerson(state, user))) throw new Error(uiText("TOVF.Interface.ThisBalanceDoesNotBelongToYour_d172a0", "Dieses Guthaben gehört nicht zu deinem Nutzer."));
  const used = state.redemptions.filter(r => r.claimId === claim.id && r.status !== "void").length;
  if (used >= claim.count) throw new Error(uiText("TOVF.Interface.ThisBalanceHasAlreadyBeenUsedOr_523940", "Dieses Guthaben ist bereits verbraucht oder reserviert."));
  const actor = actorUuid ? await fromUuid(actorUuid) : null;
  if (!actor || actor.documentName !== "Actor" || !charactersForPerson(state, claim.personId).some(a => a.uuid === actor.uuid)) throw new Error(uiText("TOVF.Interface.SelectACharacterBelongingToThePerson_54499e", "Bitte einen Charakter der Person wählen, der dieses Guthaben gehört."));
  const progress = sessionProgress(actor);
  const level = levelFromMilestones(progress.milestones);
  let reward = clone(claim.reward);
  if (reward.mode === "session") {
    const configured = rewardForLevel(level);
    await RewardService.validateItems(configured.items);
    const details = await sessionRewardDetails(configured, 1);
    reward = { mode: "session", milestones: 1, items: details.items };
    return { actor, level, milestonesBefore: progress.milestones, gold: details.gold, reward, claim, separateGold: false };
  }
  if (reward.goldMode === "level") await RewardService.validateItems(rewardForLevel(level).items);
  const gold = reward.goldMode === "fixed" ? reward.gold * reward.goldFactor : reward.goldMode === "level"
    ? (await sessionRewardDetails(rewardForLevel(level), 1)).gold * reward.goldFactor : 0;
  if (!Number.isFinite(gold) || gold < 0) throw new Error(uiText("TOVF.Interface.InvalidGoldAmount_0fc43c", "Ungültiger Goldbetrag."));
  await RewardService.validateItems(reward.items);
  if (gold > 0 && !getSystemAdapter().canAddGold(actor, gold)) throw new Error(uiText("TOVF.Interface.GoldCannotBeAddedToThisCharacter_a42849", "Gold kann diesem Charakter nicht gutgeschrieben werden. Goldgegenstand prüfen."));
  return { actor, level, milestonesBefore: progress.milestones, gold: Math.round(gold * 100) / 100, reward, claim, separateGold: true };
}

async function redeem(state, user, payload, requestId) {
  if (state.redemptions.some(r => r.id === requestId)) return;
  const preview = await redemptionPreview(state, user, payload.claimId, payload.actorUuid);
  if (preview.level !== payload.level || preview.gold !== payload.gold || preview.milestonesBefore !== payload.milestonesBefore) throw new Error(uiText("TOVF.Interface.TheCharacterSStateHasChangedReview_46a0f7", "Der Charakterstand hat sich geändert. Bitte die Einlösung erneut prüfen."));
  if (preview.reward.mode === "session" && payload.rewardSignature !== JSON.stringify(preview.reward)) throw new Error(uiText("TOVF.Interface.TheSessionRewardHasChangedReviewThe_4cc01d", "Die Sessionbelohnung hat sich geändert. Bitte die Einlösung erneut prüfen."));
  const { actor, claim, reward } = preview;
  const entry = { id: requestId, claimId: claim.id, personId: claim.personId, requestedBy: user.id, actorUuid: actor.uuid, actorName: actor.name, ruleId: claim.ruleId, kind: claim.kind, sourceId: claim.sourceId, rewardMode: reward.mode ?? "custom", level: preview.level, milestonesBefore: preview.milestonesBefore, milestones: reward.milestones, gold: preview.gold, items: reward.items, createdAt: Date.now(), status: "processing", steps: [] };
  state.redemptions.push(entry);
  await save(state); // Reserve before touching the Actor; interrupted attempts cannot spend twice.
  try {
    if (reward.milestones) {
      const progress = sessionProgress(actor);
      progress.milestoneEntries = milestoneEntries(actor);
      for (let i = 0; i < reward.milestones; i++) progress.milestoneEntries.push({ source: claim.kind, note: rewardNote(state, claim, SessionService.historyEntries()), week: isoWeekKey(), timestamp: entry.createdAt, rewardId: entry.id });
      progress.milestones += reward.milestones;
      await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, progress);
      entry.steps.push("milestones"); await save(state);
    }
    if (preview.separateGold && preview.gold) { await GoldService.addGold(actor, preview.gold); entry.steps.push("gold"); await save(state); }
    for (const [index, item] of reward.items.entries()) {
      await RewardService.grantItems(actor, [item]); entry.steps.push(`item:${index}`); await save(state);
    }
    entry.status = "redeemed";
    await save(state);
  } catch (error) {
    entry.status = "review";
    entry.error = String(error.message);
    await save(state);
    throw new Error(uiText("TOVF.Interface.RedemptionInterruptedTheBalanceRemainsReservedThe_347cb9", "Einlösung unterbrochen. Das Guthaben bleibt reserviert; die Projektleitung muss die dokumentierten Schritte prüfen."));
  }
}

function saveRecipients(state, payload) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.month)) throw new Error(uiText("TOVF.Interface.InvalidMonth_11dc51", "Ungültiger Monat."));
    const valid = new Set(state.snapshot?.people.map(p => p.id) ?? []);
    // Foundry users without an exported character/session may also receive community rewards.
    for (const userId of payload.localUsers ?? []) {
      if (!game.users.has(userId)) throw new Error(uiText("TOVF.Interface.UserIsMissing_05c6c2", "Nutzer fehlt."));
      const personId = `foundry:${userId}`;
      if (state.snapshot?.people.some(p => p.id !== personId && personAccountIds(state, p.id).includes(userId))) throw new Error(uiText("TOVF.Interface.ThisUserAlreadyHasAWestmarchesAssignment_1197cf", "Dieser Nutzer hat bereits eine Westmarches-Zuordnung. Bitte diese auswählen."));
      if (!state.snapshot) throw new Error(uiText("TOVF.Interface.ImportCampaignDataFirst_ef7541", "Zuerst Kampagnendaten importieren."));
      if (!state.snapshot.people.some(p => p.id === personId)) state.snapshot.people.push({ id: personId, discordId: null });
      state.personLinks[personId] = userId; valid.add(personId);
      payload.people.push(personId);
    }
    if (payload.people.some(id => !valid.has(id))) throw new Error(uiText("TOVF.Interface.RecipientIsMissing_339ca3", "Empfänger fehlt."));
    state.serverteam = [...new Set(payload.people)];
    state.allocations[payload.month] = clone(payload.allocations ?? {});
}

async function execute(user, request) {
  primaryWorld();
  const state = campaignState();
  const { action, payload = {}, id } = request;
  if (action === "redeem") return redeem(state, user, payload, id);
  // Assistants can finish sessions. This request only books the reward from
  // persisted history; changing recipients or other ledger data remains GM-only.
  const automaticCompletion = action === "completedGM" && !payload.personId;
  if (!(automaticCompletion && user?.role === CONST.USER_ROLES.ASSISTANT)) requiredGM(user);
  if (state.audit.some(row => row.requestId === id)) return;
  if (!automaticCompletion && payload.revision !== state.revision) throw new Error(uiText("TOVF.Interface.CampaignDataHasChangedRefreshTheView_833e72", "Die Kampagnendaten wurden inzwischen geändert. Ansicht aktualisieren und erneut prüfen."));
  if (action === "assignHistorical") {
    const entry = state.redemptions.find(r => r.id === payload.redemptionId);
    const actor = await fromUuid(payload.actorUuid);
    const count = Number(payload.milestones);
    if (!entry?.historical || entry.status !== "redeemed" || entry.actorUuid
      || !Number.isSafeInteger(count) || count < 1 || count > 100
      || !actor || !charactersForPerson(state, entry.personId).some(a => a.uuid === actor.uuid)) {
      throw new Error(game.i18n.localize("TOVF.HistoricalAssignment.Invalid"));
    }
    Object.assign(entry, { actorUuid: actor.uuid, actorName: actor.name, milestones: count,
      assignment: { userId: user.id, at: Date.now() } });
  } else if (action === "import") {
    const next = validateSnapshot(payload.snapshot);
    const difference = compareSnapshots(state.snapshot, next);
    // Review must be repeated if an adventure's source facts changed.
    for (const sessionId of [...difference.sessions.changed, ...difference.sessions.absent]) delete state.sessionReviews[sessionId];
    const localPeople = [...(state.snapshot?.people.filter(p => p.id.startsWith("foundry:")) ?? []), ...(state.pendingTransferPeople ?? [])];
    state.snapshot = clone(next);
    for (const person of localPeople) if (!state.snapshot.people.some(row => row.id === person.id)) state.snapshot.people.push(person);
    delete state.snapshot.raw;
    const detected = detectCampaignLinks(state);
    state.characterLinks = detected.characterLinks;
    state.personLinks = detected.personLinks;
    autoLinkSessions(state, SessionService.historyEntries(), user.id);
  } else if (action === "autoSessionLinks") {
    autoLinkSessions(state, SessionService.historyEntries(), user.id);
  } else if (action === "sessionLinks") {
    const history = SessionService.historyEntries();
    if (JSON.stringify(history) !== payload.historySignature) throw new Error(uiText("TOVF.Interface.SessionHistoryHasChangedReopenThePreview_40c8ba", "Sessionhistorie geändert. Vorschau neu öffnen."));
    state.historyGms ??= {}; state.sessionLinks ??= {};
    for (const [historyId, personId] of Object.entries(payload.gms ?? {})) {
      if (!history.some(r => String(r.id) === historyId) || (personId && !state.snapshot?.people.some(p => p.id === personId))) throw new Error(uiText("TOVF.Interface.InvalidGMAssignment_df2368", "Ungültige Spielleiterzuordnung."));
      if (state.sessionLinks[historyId] && state.historyGms[historyId] !== personId) throw new Error(uiText("TOVF.Interface.RemoveTheExistingSessionLinkFirst_ea1759", "Zuerst die bestehende Sessionverbindung lösen."));
      if (personId) state.historyGms[historyId] = personId;
      else delete state.historyGms[historyId];
    }
    for (const [historyId, remoteId] of Object.entries(payload.links ?? {})) {
      if (!history.some(r => String(r.id) === historyId)) throw new Error(uiText("TOVF.Interface.UnknownFoundrySession_579f28", "Unbekannte Foundry-Session."));
      if (!remoteId) { delete state.sessionLinks[historyId]; continue; }
      if (state.sessionLinks[historyId]?.westmarchesId === remoteId) continue;
      const remote = state.snapshot?.sessions.find(s => s.id === remoteId);
      if (!remote || remote.gmUserId !== state.historyGms[historyId]) throw new Error(uiText("TOVF.Interface.SessionAndGMDoNotMatch_d5e48e", "Session und Spielleiter passen nicht zusammen."));
      const localClaims = state.claims.filter(c => c.historyId === historyId);
      if (localClaims.length && state.claims.some(c => c.key === `gm:${remoteId}` && c.historyId !== historyId)) throw new Error(uiText("TOVF.Interface.BothSessionsAlreadyHaveGMClaimsReview_143120", "Für beide Sessions bestehen bereits SL-Ansprüche. Guthaben vor dem Verknüpfen prüfen."));
      for (const claim of localClaims) {
        if (claim.personId !== remote.gmUserId) throw new Error(uiText("TOVF.Interface.TheExistingGMClaimBelongsToAnother_0a14ad", "Der vorhandene SL-Anspruch gehört einer anderen Person. Zuordnung zuerst prüfen."));
        claim.key = claim.key.replace(`gm:foundry:${historyId}`, `gm:${remoteId}`); claim.sourceId = remoteId;
      }
      state.sessionLinks[historyId] = { westmarchesId: remoteId, userId: user.id, at: Date.now() };
    }
    const ids = Object.values(state.sessionLinks).map(l => l.westmarchesId);
    if (new Set(ids).size !== ids.length) throw new Error(uiText("TOVF.Interface.AWestmarchesSessionCanOnlyBeLinked_64952c", "Eine Westmarches-Session kann nur einmal verknüpft werden."));
  } else if (action === "reconcile") {
    const character = state.snapshot?.characters.find(c => c.id === payload.characterId);
    const actor = character && await fromUuid(state.characterLinks[character.id]);
    if (!actor || actor.documentName !== "Actor") throw new Error(uiText("TOVF.Interface.AssignTheCharacterFirst_d5d9fc", "Zuerst den Charakter zuordnen."));
    const entries = milestoneEntries(actor);
    const plan = reconciliationPlan(state, character, entries);
    if (payload.signature !== plan.signature) throw new Error(uiText("TOVF.Interface.MilestonesHaveChangedReopenThePreview_f7d2fb", "Meilensteine wurden geändert. Vorschau neu öffnen."));
    const updated = reconcileEntries(plan, entries, payload.sessionIds, user.id);
    const progress = sessionProgress(actor);
    progress.milestoneEntries = updated;
    await actor.setFlag(MODULE_ID, FLAGS.SESSION_PROGRESS, progress);
  } else if (action === "autoLinks") {
    const detected = detectCampaignLinks(state);
    if (!detected.newCharacters.length && !detected.newPeople.length) return;
    state.characterLinks = detected.characterLinks;
    state.personLinks = detected.personLinks;
  } else if (action === "links") {
    const people = new Set(state.snapshot?.people.map(p => p.id) ?? []);
    const characters = new Set(state.snapshot?.characters.map(c => c.id) ?? []);
    const users = new Set(); const actors = new Set();
    const accounts = {};
    if (Object.values(payload.accounts ?? {}).some(ids => ids.length)) throw new Error(uiText("TOVF.Interface.OnlyOneFoundryUserIsAllowedPer_c19b46", "Pro Person ist nur ein Foundry-Benutzer vorgesehen."));
    const names = payload.names ?? state.personNames;
    for (const personId of new Set([...Object.keys(payload.people), ...Object.keys(accounts)])) {
      if (!people.has(personId) || !Array.isArray(accounts[personId] ?? [])) throw new Error(uiText("TOVF.Interface.InvalidPersonAssignment_1290e4", "Ungültige Personenzuordnung."));
      for (const userId of new Set([payload.people[personId], ...(accounts[personId] ?? [])].filter(Boolean))) {
        if (!game.users.has(userId) || users.has(userId)) throw new Error(uiText("TOVF.Interface.AFoundryUserCanOnlyBeAssigned_9c252b", "Ein Foundry-Benutzer kann nur einer Person zugeordnet werden."));
        users.add(userId);
      }
    }
    for (const [personId, name] of Object.entries(names)) {
      if (!people.has(personId) || typeof name !== "string" || name.length > 120) throw new Error(uiText("TOVF.Interface.InvalidDisplayName_dd404f", "Ungültiger Anzeigename."));
    }
    for (const [characterId, uuid] of Object.entries(payload.characters)) {
      const actor = await fromUuid(uuid);
      if (!characters.has(characterId) || actor?.documentName !== "Actor" || actors.has(uuid)) throw new Error(uiText("TOVF.Interface.InvalidOrDuplicateCharacterAssignment_1c8754", "Ungültige oder doppelte Charakterzuordnung."));
      actors.add(uuid);
    }
    state.personLinks = clone(payload.people); state.personAccounts = clone(accounts); state.personNames = clone(names); state.characterLinks = clone(payload.characters);
    if (payload.serverteam) saveRecipients(state, clone(payload.serverteam));
  } else if (action === "review") {
    for (const [sessionId, status] of Object.entries(payload.reviews)) {
      const session = state.snapshot?.sessions.find(s => s.id === sessionId);
      if (!session || !["played", "excluded", ""].includes(status)) throw new Error(uiText("TOVF.Interface.InvalidSessionReview_57ddfc", "Ungültige Sessionprüfung."));
      if (status === "played" && (session.status === "cancelled" || Date.parse(session.endTime) > Date.now() || !Number.isFinite(Date.parse(session.endTime)))) throw new Error(uiText("TOVF.Interface.CancelledSessionsOrSessionsThatHaveNot_24e71b", "Abgesagte oder noch nicht beendete Sessions können nicht als gespielt zählen."));
      if (status) state.sessionReviews[sessionId] = { status, userId: user.id, at: Date.now() };
      else delete state.sessionReviews[sessionId];
    }
  } else if (action === "rules") {
    const rule = validateRules(clone(payload.rules));
    if (state.rules.some(r => r.effectiveFrom === rule.effectiveFrom && state.claims.some(c => c.ruleId === r.id))) throw new Error(uiText("TOVF.Interface.ThisRuleVersionHasAlreadyBeenBooked_2510ef", "Diese Regelversion wurde bereits gebucht. Bitte ein neues Gültigkeitsdatum verwenden."));
    rule.id = foundry.utils.randomID();
    state.rules = state.rules.filter(r => r.effectiveFrom !== rule.effectiveFrom).concat(rule);
  } else if (action === "recipients") {
    saveRecipients(state, payload);
  } else if (action === "completedGM") {
    const record = SessionService.historyEntries().find(r => String(r.id) === payload.historyId);
    if (payload.personId) {
      if (!record || !state.snapshot?.people.some(p => p.id === payload.personId) || !state.personLinks[payload.personId]) {
        throw new Error(game.i18n.localize("TOVF.GMBackfill.AssignFirst"));
      }
      const existing = state.claims.find(c => c.historyId === payload.historyId
        || c.key === `gm:${state.sessionLinks?.[payload.historyId]?.westmarchesId}`);
      if (existing) return;
      state.historyGms ??= {};
      state.historyGms[payload.historyId] = payload.personId;
    }
    const personId = state.historyGms?.[payload.historyId] || Object.keys(state.personLinks).find(p => state.personLinks[p] === record?.gmUserId);
    if (!record || !personId) throw new Error(uiText("TOVF.Interface.SelectAGMAndLinkThemUnder_ec1ff5", "Spielleiter auswählen und unter Spielerzuordnung zuordnen."));
    const remoteId = state.sessionLinks?.[payload.historyId]?.westmarchesId;
    const remote = state.snapshot?.sessions.find(s => s.id === remoteId);
    const rule = ruleForDate(state.rules, sessionDate(remote?.startTime ?? record.awardedAt));
    if (!rule?.gm.enabled || !rule.gm.count) throw new Error(game.i18n.localize("TOVF.GMBackfill.NoRule"));
    const key = remoteId ? `gm:${remoteId}` : `gm:foundry:${record.id}`;
    if (!state.claims.some(c => c.key === key || c.historyId === String(record.id))) state.claims.push({ id: foundry.utils.randomID(), key, historyId: String(record.id), kind: "gm", sourceId: remoteId ?? record.title, personId, count: rule.gm.count, ruleId: rule.id, reward: clone(rule.gm.reward), createdAt: Date.now() });
  } else if (action === "correctClaim") {
    const claim = state.claims.find(c => c.id === payload.claimId);
    const total = Number(payload.total), historicalUsed = Number(payload.historicalUsed);
    if (!claim || !Number.isSafeInteger(total) || total < 0 || total > 10000 || !Number.isSafeInteger(historicalUsed) || historicalUsed < 0 || !payload.reason?.trim()) throw new Error(uiText("TOVF.Interface.EnterAValidCount010000And_e65627", "Gültige Anzahl (0–10000) und eine Korrekturbegründung angeben."));
    const actual = state.redemptions.filter(r => r.claimId === claim.id && r.status !== "void" && !r.historical).length;
    if (total < actual + historicalUsed) throw new Error(uiText("TOVF.Interface.TheTotalCannotBeLowerThanThe_c079c8", "Gesamtanzahl darf bereits verwendete oder reservierte Belohnungen nicht unterschreiten."));
    const old = state.redemptions.filter(r => r.claimId === claim.id && r.status !== "void" && r.historical);
    state.claimCorrections ??= [];
    state.claimCorrections.push({ claimId: claim.id, before: { total: claim.count, historicalUsed: old.length }, after: { total, historicalUsed }, reason: payload.reason.trim(), userId: user.id, at: Date.now() });
    claim.count = total;
    for (const entry of old.slice(historicalUsed)) { entry.status = "void"; entry.resolution = { reason: payload.reason.trim(), userId: user.id, at: Date.now() }; }
    for (let i = old.length; i < historicalUsed; i++) state.redemptions.push({ id: foundry.utils.randomID(), claimId: claim.id, personId: claim.personId, requestedBy: user.id, actorName: uiText("TOVF.Interface.AlreadyUsedCharacterUnknown_54602c", "Bereits verwendet – Charakter unbekannt"), kind: claim.kind, sourceId: claim.sourceId, status: "redeemed", historical: true, createdAt: Date.now(), steps: [payload.reason.trim()] });
  } else if (action === "settleWeek") {
    const week = weeklyPreview(state, payload.month).find(w => w.week === payload.week);
    if (!week || !week.closed || week.booked) throw new Error(uiText("TOVF.Interface.ThisWeekHasNotEndedIsUnavailable_af74ce", "Diese Woche ist nicht abgeschlossen, nicht verfügbar oder bereits gebucht."));
    if (payload.recipients !== undefined) {
      if (!Array.isArray(payload.recipients) || payload.recipients.some(id => !state.snapshot?.people.some(p => p.id === id))) throw new Error(uiText("TOVF.Interface.InvalidServerTeamSelection_ebd60d", "Ungültige Serverteam-Auswahl."));
      week.recipients = [...new Set(payload.recipients)];
    }
    if (!week.recipients.length || week.recipients.some(p => !state.personLinks[p])) throw new Error(uiText("TOVF.Interface.AssignActiveServerTeamMembersAndTheir_9b3463", "Aktive Serverteam-Mitglieder und ihre Benutzer zuerst zuordnen."));
    for (const personId of week.recipients) if (week.count) state.claims.push({ id: foundry.utils.randomID(), key: `community:week:${week.week}:${personId}`, kind: "community", sourceId: week.week, personId, count: week.count, ruleId: week.ruleId, reward: clone(week.reward), createdAt: Date.now() });
    state.weeklySettlements ??= {};
    state.weeklySettlements[week.week] = { ...week, userId: user.id, at: Date.now() };
  } else if (action === "grantGM") {
    const s = state.snapshot?.sessions.find(s => s.id === payload.sessionId);
    if (!s || effectiveSessionStatus(state, s) !== "played" || !s.gmUserId) throw new Error(uiText("TOVF.Interface.FirstConfirmASessionWithAGM_706089", "Zuerst eine Session mit Spielleiter als gespielt bestätigen."));
    const latest = [...state.rules].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    const rule = ruleForDate(state.rules, sessionDate(s.startTime, latest.timeZone));
    if (!rule?.gm.enabled || !rule.gm.count) throw new Error(uiText("TOVF.Interface.NoGMRewardIsConfiguredForThis_947345", "Für diese Session ist keine SL-Belohnung konfiguriert."));
    if (!state.personLinks[s.gmUserId]) throw new Error(uiText("TOVF.Interface.TheGMSFoundryUserIsMissing_a0e751", "Foundry-Nutzer des Spielleiters fehlt."));
    if (payload.baselineReviewed !== true) throw new Error(uiText("TOVF.Interface.ReviewPreviousAwardsFirst_d0baab", "Bisherige Vergabe zuerst prüfen."));
    const used = Number(payload.alreadyUsed ?? 0);
    if (!Number.isSafeInteger(used) || used < 0 || used > rule.gm.count) throw new Error(uiText("TOVF.Interface.InvalidCountOfGMRewardsAlreadyUsed_8aaf7a", "Ungültige Anzahl bereits verwendeter SL-Belohnungen."));
    if (!state.claims.some(c => c.key === `gm:${s.id}`)) {
      const claim = { id: foundry.utils.randomID(), key: `gm:${s.id}`, kind: "gm", sourceId: s.id, personId: s.gmUserId, count: rule.gm.count, ruleId: rule.id, reward: clone(rule.gm.reward), createdAt: Date.now() };
      state.claims.push(claim);
      for (let i = 0; i < used; i++) state.redemptions.push({ id: foundry.utils.randomID(), claimId: claim.id, personId: claim.personId, requestedBy: user.id, actorName: uiText("TOVF.Interface.AlreadyUsedCharacterUnknown_54602c", "Bereits verwendet – Charakter unbekannt"), kind: "gm", sourceId: s.id, status: "redeemed", historical: true, createdAt: Date.now(), steps: [uiText("TOVF.Interface.HistoricalUsageConfirmedNoRewardGrantedBy_6452c8", "Historischen Verbrauch bestätigt; keine Auszahlung durch das Modul")] });
    }
  } else if (action === "settle") {
    if (Object.values(state.weeklySettlements ?? {}).some(w => w.month === payload.month)) throw new Error(uiText("TOVF.Interface.ServerTeamRewardsForThisMonthAre_22ee5d", "Für diesen Monat werden Serverteam-Belohnungen bereits wochenweise gebucht."));
    if (Object.hasOwn(state.settlements, payload.month)) throw new Error(uiText("TOVF.Interface.ThisMonthIsAlreadyBooked_fffc5c", "Dieser Monat ist bereits gebucht."));
    const preview = settlementPreview(state, payload.month);
    const rule = state.rules.find(r => r.id === preview.ruleId);
    const currentMonth = new Intl.DateTimeFormat("en-CA", { timeZone: rule.timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date());
    const now = ["year", "month"].map(k => currentMonth.find(p => p.type === k).value).join("-");
    if (payload.month >= now) throw new Error(uiText("TOVF.Interface.MonthlySettlementIsOnlyAvailableAfterThe_4429d6", "Monatsabrechnung erst nach Monatsende möglich."));
    if (preview.unresolved.length) throw new Error(uiText("TOVF.Interface.ReviewAllSessionsInThisMonthAs_796204", "Zuerst alle Sessions dieses Monats als gespielt oder ausgeschlossen prüfen."));
    if (preview.community.amount && (!preview.recipients.length || preview.community.unassigned)) throw new Error(uiText("TOVF.Interface.ServerTeamRecipientsOrPoolAllocationsAre_7ebb1c", "Serverteamempfänger beziehungsweise Poolverteilung sind noch unvollständig."));
    const newClaims = preview.claims.filter(c => c.kind === "community" && !state.claims.some(old => old.key === c.key));
    if (newClaims.some(c => !state.personLinks[c.personId])) throw new Error(uiText("TOVF.Interface.AtLeastOneRecipientIsMissingA_0cedf1", "Für mindestens einen Empfänger fehlt die Foundry-Nutzerzuordnung."));
    // Imported past rewards may already exist: historical months require an explicit baseline acknowledgement.
    if (payload.baselineReviewed !== true) throw new Error(uiText("TOVF.Interface.ConfirmThatTheseClaimsHaveNotAlready_b933d3", "Bitte bestätigen, dass diese Ansprüche noch nicht anderweitig vergeben wurden."));
    for (const c of newClaims) state.claims.push({ ...clone(c), id: foundry.utils.randomID(), createdAt: Date.now() });
    state.settlements[payload.month] = { ...preview, userId: user.id, at: Date.now(), baselineReviewed: true };
  } else if (action === "openRewards") {
    const rule = state.rules.find(r => r.id === payload.ruleId);
    if (!rule) throw new Error(uiText("TOVF.Interface.RuleVersionIsMissing_d75856", "Regelversion fehlt."));
    for (const claim of state.claims.filter(c => c.kind === payload.kind && c.ruleId !== rule.id)) {
      const used = state.redemptions.filter(r => r.claimId === claim.id && r.status !== "void").length;
      const remaining = claim.count - used;
      if (remaining <= 0) continue;
      claim.count = used;
      state.claims.push({ ...clone(claim), id: foundry.utils.randomID(), key: `${claim.key}:revision:${id}`, count: remaining, reward: clone(rule[claim.kind === "gm" ? "gm" : "community"].reward), ruleId: rule.id, createdAt: Date.now() });
    }
  } else if (action === "resolve") {
    const entry = state.redemptions.find(r => r.id === payload.redemptionId);
    if (!entry || !["processing", "review"].includes(entry.status) || !["redeemed", "void"].includes(payload.status) || !payload.reason?.trim()) throw new Error(uiText("TOVF.Interface.InvalidReviewOfTheInterruptedRedemption_4afa66", "Ungültige Prüfung der unterbrochenen Einlösung."));
    entry.status = payload.status; entry.resolution = { reason: payload.reason.trim(), userId: user.id, at: Date.now() };
  } else throw new Error(uiText("TOVF.Interface.UnknownCampaignAction_1a9c9b", "Unbekannte Kampagnenaktion."));
  state.audit.push({ requestId: id, action, userId: user.id, at: Date.now() });
  await save(state);
}

let queue = Promise.resolve();
const pendingIds = new Set();

function enqueue(user, request) {
  if (coordinator()?.id !== game.user.id) return;
  if (!request?.id || user.getFlag(MODULE_ID, RESPONSE)?.id === request.id || pendingIds.has(request.id)) return;
  pendingIds.add(request.id);
  queue = queue.then(async () => {
    if (coordinator()?.id !== game.user.id) return;
    let error = null;
    try { await execute(user, request); } catch (e) { error = String(e.message); }
    await user.setFlag(MODULE_ID, RESPONSE, { id: request.id, error, at: Date.now() });
  }).catch(e => console.error(`${MODULE_ID} | Campaign request failed`, e)).finally(() => pendingIds.delete(request.id));
}

export function registerCampaignService() {
  game.settings.register(MODULE_ID, CAMPAIGN_SETTING, { scope: "world", config: false, type: Object, default: {} });
  // Assistants can edit other users' flags. Authenticate the server-provided updater ID,
  // not the owner of the modified document, and capture this update's payload.
  Hooks.on("updateUser", (user, changes, _options, updaterId) => {
    if (user.id !== updaterId) return;
    const request = foundry.utils.getProperty(changes, `flags.${MODULE_ID}.${REQUEST}`);
    if (request) enqueue(user, clone(request));
  });
}

let sending = false;
export async function campaignAction(action, payload = {}) {
  primaryWorld();
  if (!coordinator()) throw new Error(uiText("TOVF.Interface.CampaignWriterRequired", "Eine Spielleitung mit dem Recht zum Ändern der Welteneinstellungen muss verbunden sein."));
  if (sending) throw new Error(uiText("TOVF.Interface.ACampaignActionIsAlreadyBeingProcessed_19c9a3", "Eine Kampagnenaktion wird bereits verarbeitet."));
  const previous = game.user.getFlag(MODULE_ID, REQUEST);
  const unanswered = previous?.id && game.user.getFlag(MODULE_ID, RESPONSE)?.id !== previous.id;
  if (unanswered && (previous.action !== action || JSON.stringify(previous.payload) !== JSON.stringify(payload))) throw new Error(uiText("TOVF.Interface.AnEarlierRequestIsStillPendingCheck_8a3822", "Eine frühere Anfrage ist noch offen. Zuerst deren Buchungsstand prüfen beziehungsweise dieselbe Anfrage erneut senden."));
  sending = true;
  const id = unanswered ? previous.id : foundry.utils.randomID(24);
  try {
    // Remove first, including retries, so Foundry emits the complete request rather
    // than only a sentAt diff. Retry keeps the same id for idempotency.
    if (previous) await game.user.unsetFlag(MODULE_ID, REQUEST);
    await game.user.setFlag(MODULE_ID, REQUEST, { id, action, payload, sentAt: Date.now() });
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      const response = game.user.getFlag(MODULE_ID, RESPONSE);
      if (response?.id === id) {
        if (response.error) throw new Error(response.error);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(uiText("TOVF.Interface.NoResponseYetCheckTheBookingStatus_251306", "Noch keine Antwort. Vor einer Wiederholung den Buchungsstand prüfen; es erfolgt keine automatische Wiederholung."));
  } finally { sending = false; }
}
