import { milestoneWeek, sessionDate } from "./data.mjs";
import { ruleForDate, communityAmount } from "./rules.mjs";
import { activeServerteam } from "./serverteam.mjs";

export function weeklyPreview(state, month, history = [], now = Date.now()) {
  const rule = ruleForDate(state.rules, `${month}-01`);
  if (!rule || rule.community.mode !== "activeWeeks" || rule.community.distribution !== "each") return [];
  const groups = new Map();
  for (const session of history) {
    if (!Number.isFinite(Number(session.awardedAt))) continue;
    if (state.sessionReviews?.[String(session.id)]?.status === "excluded") continue;
    const week = milestoneWeek(session.awardedAt, rule.timeZone);
    if (week.month !== month) continue;
    const start = new Date(`${sessionDate(session.awardedAt, rule.timeZone)}T00:00:00Z`);
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 7 - (start.getUTCDay() || 7));
    const closed = end.toISOString().slice(0, 10) < sessionDate(now, rule.timeZone);
    groups.set(week.key, { week: week.key, month, closed, ruleId: rule.id,
      count: communityAmount(0, 0, rule.community, 1).amount,
      reward: rule.community.reward, recipients: [...new Set(state.weeklySettlements?.[week.key]?.recipients ?? state.settlements?.[month]?.recipients ?? activeServerteam(state))],
      booked: !!state.weeklySettlements?.[week.key] || !!state.settlements?.[month] });
  }
  return [...groups.values()].sort((a, b) => a.week.localeCompare(b.week));
}
