/** Resolve display text without exposing internal session IDs. */
export function rewardNote(state, reward, history = []) {
  return `${reward.kind === "gm" ? "Spielleitung" : "Serverteam"}: ${rewardSourceLabel(state, reward, history)}`;
}

export function rewardSourceLabel(state, reward, history = []) {
  if (reward.kind !== "gm") return reward.sourceId;
  const claim = state.claims?.find(c => c.id === reward.claimId) ?? reward;
  const sourceId = claim.sourceId ?? reward.sourceId;
  const session = state.snapshot?.sessions?.find(s => s.id === sourceId);
  const record = history.find(r => String(r.id) === String(claim.historyId)
    || state.sessionLinks?.[r.id]?.westmarchesId === sourceId);
  const localTitle = claim.historyId && claim.key === `gm:foundry:${claim.historyId}` ? sourceId : null;
  const title = session?.title || record?.title || reward.sourceTitle || claim.sourceTitle || localTitle;
  return title || "Session nicht zugeordnet";
}

export function readableRewardEntry(entry, state, history = []) {
  if (!["gm", "community"].includes(entry.source)) return entry;
  const reward = state.redemptions?.find(r => r.id === entry.rewardId);
  if (reward && entry.note === `SL-Belohnung: ${reward.sourceId}`) return { ...entry, note: rewardNote(state, reward, history) };
  const oldPrefix = entry.source === "gm" ? "SL-Belohnung: " : "Serverteam-Belohnung: ";
  const prefix = entry.source === "gm" ? "Spielleitung: " : "Serverteam: ";
  return entry.note?.startsWith(oldPrefix) ? { ...entry, note: prefix + entry.note.slice(oldPrefix.length) } : entry;
}
