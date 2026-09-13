import { uiText } from "../core/localization.mjs";
/** Resolve display text without exposing internal session IDs. */
export function rewardNote(state, reward, history = [], localized = false) {
  // Notes participate in saved provenance and optimistic-lock signatures.
  // Localize display labels only, never the canonical data used by another client.
  const prefix = localized
    ? reward.kind === "gm" ? uiText("TOVF.Interface.GM_fa2c48", "Spielleitung") : uiText("TOVF.Interface.ServerTeam_d71b1b", "Serverteam")
    : reward.kind === "gm" ? "Spielleitung" : "Serverteam";
  return `${prefix}: ${rewardSourceLabel(state, reward, history, localized)}`;
}

export function rewardSourceLabel(state, reward, history = [], localized = true) {
  if (reward.kind !== "gm") return reward.sourceId;
  const claim = state.claims?.find(c => c.id === reward.claimId) ?? reward;
  const sourceId = claim.sourceId ?? reward.sourceId;
  const session = state.snapshot?.sessions?.find(s => s.id === sourceId);
  const record = history.find(r => String(r.id) === String(claim.historyId)
    || state.sessionLinks?.[r.id]?.westmarchesId === sourceId);
  const localTitle = claim.historyId && claim.key === `gm:foundry:${claim.historyId}` ? sourceId : null;
  const title = session?.title || record?.title || reward.sourceTitle || claim.sourceTitle || localTitle;
  return title || (localized ? uiText("TOVF.Interface.SessionNotAssigned_2a475d", "Session nicht zugeordnet") : "Session nicht zugeordnet");
}

export function readableRewardEntry(entry, state, history = []) {
  if (!["gm", "community"].includes(entry.source)) return entry;
  const reward = state.redemptions?.find(r => r.id === entry.rewardId);
  if (reward && entry.note === `SL-Belohnung: ${reward.sourceId}`) return { ...entry, note: rewardNote(state, reward, history) };
  const oldPrefix = entry.source === "gm" ? "SL-Belohnung: " : "Serverteam-Belohnung: ";
  const prefix = entry.source === "gm" ? "Spielleitung: " : "Serverteam: ";
  return entry.note?.startsWith(oldPrefix) ? { ...entry, note: prefix + entry.note.slice(oldPrefix.length) } : entry;
}
