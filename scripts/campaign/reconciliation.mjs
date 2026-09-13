import { uiText } from "../core/localization.mjs";
import { milestoneWeek } from "./data.mjs";

/** Proposals only: registration does not establish attendance or a payout. */
export function reconciliationPlan(state, character, entries, now = Date.now()) {
  const empty = entries.flatMap((e, index) => e.source === "start" && !e.note && !e.week && !e.historyId && !e.rewardId && !e.westmarchesSessionId ? [index] : []);
  const groups = new Map();
  for (const s of state.snapshot?.sessions ?? []) {
    const status = state.sessionReviews[s.id]?.status ?? s.status;
    if (["cancelled", "excluded"].includes(status) || !(Date.parse(s.endTime) <= now)) continue;
    const participant = s.participants.find(p => p.characterId === character.id);
    if (!participant) continue;
    const week = milestoneWeek(s.startTime).key;
    const existing = entries.some(e => e.westmarchesSessionId === s.id || (e.historyId && state.sessionLinks?.[e.historyId]?.westmarchesId === s.id) || (e.source === "session" && (e.week === week || (e.note && e.note.trim() === s.title.trim()))));
    const group = groups.get(week) ?? { week, candidates: [], documented: false };
    group.documented ||= existing;
    group.candidates.push({ id: s.id, title: s.title, date: s.startTime.slice(0, 10), registration: participant.registrationStatus, played: status === "played" });
    groups.set(week, group);
  }
  return { characterId: character.id, name: character.name, total: entries.length, remoteTotal: character.milestones, empty: empty.length, slots: empty,
    signature: JSON.stringify(entries), groups: [...groups.values()].sort((a, b) => a.week.localeCompare(b.week)) };
}

export function reconcileEntries(plan, entries, sessionIds, userId, now = Date.now()) {
  if (plan.signature !== JSON.stringify(entries)) throw new Error(uiText("TOVF.Interface.MilestonesHaveChangedReopenThePreview_f7d2fb", "Meilensteine wurden geändert. Vorschau neu öffnen."));
  if (!Array.isArray(sessionIds) || !sessionIds.length || new Set(sessionIds).size !== sessionIds.length || sessionIds.length > plan.empty) throw new Error(uiText("TOVF.Interface.SelectNoMoreSessionsThanThereAre_345952", "Bitte höchstens so viele Sessions auswählen, wie ungeklärte Meilensteine vorhanden sind."));
  const weeks = new Set();
  const selected = sessionIds.map(id => {
    const group = plan.groups.find(g => g.candidates.some(s => s.id === id));
    if (!group || group.documented || weeks.has(group.week)) throw new Error(uiText("TOVF.Interface.ThisMilestoneWeekIsAlreadyAssignedOr_25c978", "Diese Meilensteinwoche ist bereits belegt oder nicht verfügbar."));
    weeks.add(group.week);
    return { group, session: group.candidates.find(s => s.id === id) };
  }).sort((a, b) => a.group.week.localeCompare(b.group.week));
  const result = structuredClone(entries);
  selected.forEach(({ group, session }, index) => {
    result[plan.slots[index]] = { source: "session", note: session.title, week: group.week, westmarchesSessionId: session.id, sessionDate: session.date, reconciliation: { userId, at: now, characterId: plan.characterId } };
  });
  return result;
}
