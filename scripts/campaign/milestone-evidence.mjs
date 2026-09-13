import { uiText } from "../core/localization.mjs";
import { MODULE_ID } from "../downtime/constants.mjs";
import { milestoneWeek } from "./data.mjs";
import { SessionService } from "../downtime/session-service.mjs";
import { rewardNote } from "./reward-label.mjs";

export function evidenceKey(entry) {
  return entry.evidenceKey || (entry.rewardId ? `reward:${entry.rewardId}` : entry.westmarchesSessionId ? `westmarches:${entry.westmarchesSessionId}` : entry.historyId ? `history:${entry.historyId}` : "");
}

export function buildMilestoneEvidence(state, history, actorUuid, now = Date.now()) {
  const catalog = [];
  const represented = new Set();
  for (const record of history) {
    const count = (record.participants ?? []).filter(p => p.actorUuid === actorUuid).reduce((n, p) => n + Number(p.milestone || 0), 0);
    if (!(count > 0)) continue;
    const remoteId = state.sessionLinks?.[record.id]?.westmarchesId;
    if (remoteId) represented.add(remoteId);
    catalog.push({ key: `history:${record.id}`, aliases: remoteId ? [`westmarches:${remoteId}`] : [], source: "session", label: uiText("TOVF.Interface.SessionP0P1FoundryEvidence_df5247", "Session: {p0} · {p1} (Foundry-Nachweis)", { p0: (record.title), p1: (record.week || "") }), capacity: count,
      fields: { historyId: String(record.id), ...(remoteId ? { westmarchesSessionId: remoteId } : {}), note: record.title, week: record.week || "", timestamp: record.awardedAt } });
  }
  const characterIds = new Set(Object.entries(state.characterLinks ?? {}).filter(([, uuid]) => uuid === actorUuid).map(([id]) => id));
  for (const session of state.snapshot?.sessions ?? []) {
    if (represented.has(session.id) || session.status === "cancelled" || state.sessionReviews?.[session.id]?.status === "excluded" || !(Date.parse(session.endTime) <= now)
      || !session.participants.some(p => characterIds.has(p.characterId))) continue;
    catalog.push({ key: `westmarches:${session.id}`, source: "session", label: uiText("TOVF.Interface.SessionP0P1VerifyAttendance_f1e1e0", "Session: {p0} · {p1} (Teilnahme prüfen)", { p0: (session.title), p1: (session.startTime.slice(0, 10)) }), capacity: 1,
      fields: { westmarchesSessionId: session.id, sessionDate: session.startTime.slice(0, 10), note: session.title, week: milestoneWeek(session.startTime).key } });
  }
  for (const redemption of state.redemptions ?? []) {
    if (redemption.actorUuid !== actorUuid || redemption.status !== "redeemed" || !(redemption.milestones > 0)) continue;
    const note = rewardNote(state, redemption, history);
    catalog.push({ key: `reward:${redemption.id}`, source: redemption.kind, label: `${rewardNote(state, redemption, history, true)} · ${new Date(redemption.createdAt).toISOString().slice(0, 10)}`, capacity: redemption.milestones,
      fields: { rewardId: redemption.id, note, timestamp: redemption.createdAt, week: "" } });
  }
  return catalog;
}

export function milestoneEvidence(actorUuid) {
  const state = game.settings.get(MODULE_ID, "worldRole") === "primary" ? game.settings.get(MODULE_ID, "campaignLedger") ?? {} : {};
  return buildMilestoneEvidence(state, SessionService.historyEntries(), actorUuid);
}

const provenance = ["evidenceKey", "historyId", "westmarchesSessionId", "rewardId", "timestamp", "sessionDate", "reconciliation"];
export function assignMilestoneEvidence(entries, rows, originals, catalog) {
  const counts = new Map();
  return entries.map((entry, index) => {
    const row = rows[index], original = originals[Number(row.originalIndex)];
    if (entry.source === "correction" && !entry.note?.trim()) throw new Error(uiText("TOVF.Interface.PleaseProvideAReasonForAManual_2640e8", "Für eine manuelle Korrektur bitte eine Begründung eintragen."));
    const key = row.evidenceKey ?? evidenceKey(entry);
    const match = catalog.find(c => c.key === key || c.aliases?.includes(key));
    if (key && !match) {
      if (row.originalIndex === "" || !original || evidenceKey(original) !== key || entry.source !== original.source) throw new Error(uiText("TOVF.Interface.ThisEvidenceIsNoLongerAvailableRefresh_17439b", "Dieser Nachweis ist nicht mehr verfügbar. Auswahl aktualisieren."));
      const used = (counts.get(key) ?? 0) + 1; counts.set(key, used);
      if (used > originals.filter(e => evidenceKey(e) === key).length) throw new Error(uiText("TOVF.Interface.DoNotDuplicateExistingEvidence_7c77c8", "Bestehenden Nachweis nicht duplizieren."));
      return entry; // Retain existing references when old source data is absent.
    }
    if (match) {
      if (entry.source !== match.source) throw new Error(uiText("TOVF.Interface.SourceAndEvidenceDoNotMatch_dee5f5", "Herkunft und Nachweis passen nicht zusammen."));
      const used = (counts.get(match.key) ?? 0) + 1; counts.set(match.key, used);
      if (used > match.capacity) throw new Error(uiText("TOVF.Interface.ThisEvidenceHasAlreadyBeenFullyAssigned_7681c4", "Dieser Nachweis ist bereits vollständig zugeordnet."));
      // Historical catch-up allows multiple sessions per week; source capacities still apply.
      const result = { ...entry };
      for (const field of provenance) delete result[field];
      return { ...result, ...match.fields, evidenceKey: match.key, note: entry.note || match.fields.note };
    }
    const result = { ...entry };
    if (row.evidenceKey === "" || (original && entry.source !== original.source)) for (const field of provenance) delete result[field];
    return result;
  });
}
