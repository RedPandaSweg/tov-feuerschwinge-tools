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
    catalog.push({ key: `history:${record.id}`, aliases: remoteId ? [`westmarches:${remoteId}`] : [], source: "session", label: `Session: ${record.title} · ${record.week || ""} (Foundry-Nachweis)`, capacity: count,
      fields: { historyId: String(record.id), ...(remoteId ? { westmarchesSessionId: remoteId } : {}), note: record.title, week: record.week || "", timestamp: record.awardedAt } });
  }
  const characterIds = new Set(Object.entries(state.characterLinks ?? {}).filter(([, uuid]) => uuid === actorUuid).map(([id]) => id));
  for (const session of state.snapshot?.sessions ?? []) {
    if (represented.has(session.id) || session.status === "cancelled" || state.sessionReviews?.[session.id]?.status === "excluded" || !(Date.parse(session.endTime) <= now)
      || !session.participants.some(p => characterIds.has(p.characterId))) continue;
    catalog.push({ key: `westmarches:${session.id}`, source: "session", label: `Session: ${session.title} · ${session.startTime.slice(0, 10)} (Teilnahme prüfen)`, capacity: 1,
      fields: { westmarchesSessionId: session.id, sessionDate: session.startTime.slice(0, 10), note: session.title, week: milestoneWeek(session.startTime).key } });
  }
  for (const redemption of state.redemptions ?? []) {
    if (redemption.actorUuid !== actorUuid || redemption.status !== "redeemed" || redemption.historical || !(redemption.milestones > 0)) continue;
    const note = rewardNote(state, redemption, history);
    catalog.push({ key: `reward:${redemption.id}`, source: redemption.kind, label: `${note} · ${new Date(redemption.createdAt).toISOString().slice(0, 10)}`, capacity: redemption.milestones,
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
  const weeks = new Map();
  return entries.map((entry, index) => {
    const row = rows[index], original = originals[Number(row.originalIndex)];
    if (entry.source === "correction" && !entry.note?.trim()) throw new Error("Für eine manuelle Korrektur bitte eine Begründung eintragen.");
    const key = row.evidenceKey ?? evidenceKey(entry);
    const match = catalog.find(c => c.key === key || c.aliases?.includes(key));
    if (key && !match) {
      if (row.originalIndex === "" || !original || evidenceKey(original) !== key || entry.source !== original.source) throw new Error("Dieser Nachweis ist nicht mehr verfügbar. Auswahl aktualisieren.");
      const used = (counts.get(key) ?? 0) + 1; counts.set(key, used);
      if (used > originals.filter(e => evidenceKey(e) === key).length) throw new Error("Bestehenden Nachweis nicht duplizieren.");
      return entry; // Retain existing references when old source data is absent.
    }
    if (match) {
      if (entry.source !== match.source) throw new Error("Herkunft und Nachweis passen nicht zusammen.");
      const used = (counts.get(match.key) ?? 0) + 1; counts.set(match.key, used);
      if (used > match.capacity) throw new Error("Dieser Nachweis ist bereits vollständig zugeordnet.");
      if (match.source === "session" && match.fields.week) {
        if (weeks.has(match.fields.week) && weeks.get(match.fields.week) !== match.key) throw new Error("Diese Meilensteinwoche ist bereits einer anderen Session zugeordnet.");
        weeks.set(match.fields.week, match.key);
      }
      const result = { ...entry };
      for (const field of provenance) delete result[field];
      return { ...result, ...match.fields, evidenceKey: match.key, note: entry.note || match.fields.note };
    }
    const result = { ...entry };
    if (row.evidenceKey === "" || (original && entry.source !== original.source)) for (const field of provenance) delete result[field];
    return result;
  });
}
