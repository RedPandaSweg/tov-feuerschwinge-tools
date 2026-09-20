import { uiText } from "../core/localization.mjs";
import { sessionMonth, milestoneWeek } from "./data.mjs";
import { activeServerteam } from "./serverteam.mjs";

export function defaultRules() {
  const reward = { mode: "session", milestones: 1, goldMode: "level", gold: 0, goldFactor: 1, items: [] };
  return {
    id: "initial", effectiveFrom: "2026-09-01", timeZone: "Europe/Berlin",
    gm: { enabled: true, count: 1, reward: structuredClone(reward) },
    community: { enabled: true, mode: "activeWeeks", fixed: 1, factor: 1, rounding: "ceil", minimum: 0, maximum: null, distribution: "each", reward: structuredClone(reward) }
  };
}

function number(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error(uiText("TOVF.Interface.InvalidValueP0_27c131", "Ungültiger Wert: {p0}", { p0: (label) }));
}

export function validateRules(rules) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rules.effectiveFrom) || new Date(rules.effectiveFrom).toISOString().slice(0, 10) !== rules.effectiveFrom) throw new Error(uiText("TOVF.Interface.InvalidEffectiveDate_0d181f", "Ungültiges Gültigkeitsdatum."));
  new Intl.DateTimeFormat("de", { timeZone: rules.timeZone }).format();
  number(rules.gm.count, "SL-Belohnungen", true);
  if (typeof rules.gm.enabled !== "boolean" || typeof rules.community.enabled !== "boolean") throw new Error(uiText("TOVF.Interface.InvalidActivation_27a723", "Ungültige Aktivierung."));
  const c = rules.community;
  if (!["activeWeeks", "ratio", "fixed", "sessions"].includes(c.mode) || !["ceil", "floor", "round"].includes(c.rounding) || !["each", "pool"].includes(c.distribution)) throw new Error(uiText("TOVF.Interface.InvalidServerTeamRule_df7afc", "Ungültige Serverteamregel."));
  for (const key of ["fixed", "factor", "minimum"]) number(c[key], key, key !== "factor");
  if (c.maximum !== null) { number(c.maximum, "Maximum", true); if (c.maximum < c.minimum) throw new Error(uiText("TOVF.Interface.MaximumIsBelowMinimum_4b484d", "Maximum liegt unter Minimum.")); }
  for (const r of [rules.gm.reward, c.reward]) {
    if (![undefined, "session", "custom"].includes(r.mode)) throw new Error(uiText("TOVF.Interface.InvalidRewardSource_f225e6", "Ungültige Belohnungsquelle."));
    number(r.milestones, uiText("TOVF.Interface.Milestones_a38757", "Meilensteine"), true);
    if (r.milestones > 1000) throw new Error(uiText("TOVF.Interface.AtMost1000MilestonesPerReward_db94aa", "Höchstens 1000 Meilensteine je Belohnung."));
    number(r.gold, uiText("TOVF.Interface.Gold_c57604", "Gold")); number(r.goldFactor, uiText("TOVF.Interface.GoldFactor_b491a7", "Goldfaktor"));
    if (!["level", "fixed", "none"].includes(r.goldMode) || !Array.isArray(r.items)) throw new Error(uiText("TOVF.Interface.InvalidRewardContents_d13e19", "Ungültiger Belohnungsinhalt."));
    for (const item of r.items) { if (!item.uuid?.trim()) throw new Error(uiText("TOVF.Interface.ItemUUIDIsMissing_4263cb", "Gegenstands-UUID fehlt.")); number(item.quantity, "Gegenstandsanzahl"); }
  }
  return rules;
}

export function communityAmount(sessions, gms, rule, activeWeeks = 0) {
  if (!rule.enabled) return { base: 0, amount: 0 };
  const base = rule.mode === "activeWeeks" ? activeWeeks : rule.mode === "fixed" ? rule.fixed : rule.mode === "sessions" ? sessions : gms > 0 ? sessions / gms : 0;
  // An empty ratio month has no award, even if a minimum is configured.
  const amount = (rule.mode === "ratio" && gms === 0) || (rule.mode === "activeWeeks" && activeWeeks === 0) ? 0
    : Math.min(rule.maximum ?? Infinity, Math.max(rule.minimum, Math[rule.rounding](base * rule.factor)));
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(uiText("TOVF.Interface.RewardCountIsOutsideTheValidRange_b8303e", "Belohnungsanzahl außerhalb des gültigen Bereichs."));
  return { base, amount };
}

export function ruleForDate(versions, date) {
  return [...versions].filter(r => r.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export function sessionRelevantToMonth(session, month, rule) {
  try {
    return sessionMonth(session.startTime, rule.timeZone) === month
      || (rule.community.mode === "activeWeeks" && milestoneWeek(session.startTime, rule.timeZone).month === month);
  } catch { return false; }
}

export function settlementPreview(state, month, history = []) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(uiText("TOVF.Interface.InvalidMonth_11dc51", "Ungültiger Monat."));
  const rule = ruleForDate(state.rules, `${month}-01`);
  if (!rule) throw new Error(uiText("TOVF.Interface.NoRuleVersionExistsForThisMonth_b14ba9", "Für diesen Monat fehlt eine Regelversion."));
  const reviewed = history.filter(s => Number.isFinite(Number(s.awardedAt))
    && sessionMonth(s.awardedAt, rule.timeZone) === month
    && state.sessionReviews?.[String(s.id)]?.status !== "excluded");
  const missingGms = reviewed.filter(s => !s.gmUserId);
  if (missingGms.length) throw new Error(uiText("TOVF.Interface.PlayedSessionsWithoutAGMMustBe_7f1fd1", "Gespielte Sessions ohne Spielleiter müssen zuerst korrigiert werden."));
  const gms = new Set(reviewed.map(s => s.gmUserId));
  const counts = new Map();
  for (const s of reviewed) counts.set(s.gmUserId, (counts.get(s.gmUserId) ?? 0) + 1);
  const claims = [];
  const weeks = [...new Set(reviewed.map(s => milestoneWeek(s.awardedAt, rule.timeZone))
    .filter(w => w.month === month).map(w => w.key))].sort();
  const community = communityAmount(reviewed.length, gms.size, rule.community, weeks.length);
  const recipients = [...new Set(state.settlements?.[month]?.recipients ?? activeServerteam(state))];
  if (community.amount) {
    if (rule.community.distribution === "each") {
      for (const personId of recipients) claims.push({ key: `community:${month}:${personId}`, kind: "community", sourceId: month, personId, count: community.amount, ruleId: rule.id, reward: rule.community.reward });
    } else {
      const allocation = state.allocations[month] ?? {};
      let sum = 0;
      for (const [personId, count] of Object.entries(allocation)) {
        number(count, "Poolzuweisung", true);
        if (!recipients.includes(personId)) throw new Error(uiText("TOVF.Interface.PoolAssignedToAnIneligibleRecipient_730853", "Poolzuweisung an nicht berechtigten Empfänger."));
        sum += count;
        if (count) claims.push({ key: `community:${month}:${personId}`, kind: "community", sourceId: month, personId, count, ruleId: rule.id, reward: rule.community.reward });
      }
      if (sum > community.amount) throw new Error(uiText("TOVF.Interface.PoolAllocationsExceedTheAvailablePool_ba976c", "Poolzuweisungen übersteigen den verfügbaren Pool."));
      community.unassigned = community.amount - sum;
    }
  }
  return { month, ruleId: rule.id, sessions: reviewed.length, gms: gms.size, weeks, activeWeeks: weeks.length, weekly: rule.community.mode === "activeWeeks", counts: Object.fromEntries(counts), community, recipients, unresolved: [], claims };
}
