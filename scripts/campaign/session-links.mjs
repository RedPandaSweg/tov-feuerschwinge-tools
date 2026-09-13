import { uiText } from "../core/localization.mjs";
const normalize = title => String(title ?? "").normalize("NFKC").toLowerCase()
  .replace(/\b(?:teil|part|episode)\s+(i{1,3}|iv|v|vi{0,3}|ix|x)\b/g, (_, n) => `teil ${["i","ii","iii","iv","v","vi","vii","viii","ix","x"].indexOf(n) + 1}`)
  .replace(/\b(?:part|episode)\b/g, "teil").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Link only unambiguous evidence; never create or redeem rewards. */
export function autoLinkSessions(state, history, userId, now = Date.now()) {
  state.historyGms ??= {};
  state.sessionLinks ??= {};
  const used = new Set(Object.values(state.sessionLinks).map(link => link.westmarchesId));
  const proposals = history.filter(record => !state.sessionLinks[String(record.id)]).map(record => {
    const id = String(record.id);
    const people = (state.snapshot?.people ?? []).filter(p => state.personLinks?.[p.id] === record.gmUserId && record.gmUserId);
    const gm = state.historyGms[id] || record.gmPersonId || (people.length === 1 ? people[0].id : null);
    let candidates = (state.snapshot?.sessions ?? []).filter(s => !used.has(s.id) && s.status !== "cancelled"
      && state.sessionReviews?.[s.id]?.status !== "excluded" && (!gm || s.gmUserId === gm)
      && titleSimilarity(record.title, s.title) === 1);
    // A close completion date distinguishes repeated titles and supplies missing GM identity.
    if (!gm || candidates.length > 1) candidates = candidates.filter(s =>
      Number.isFinite(record.awardedAt) && Math.abs(record.awardedAt - Date.parse(s.endTime || s.startTime)) <= 36 * 3600000);
    return { id, remote: candidates.length === 1 ? candidates[0] : null };
  });
  let count = 0;
  for (const { id, remote } of proposals) {
    if (!remote || proposals.filter(p => p.remote?.id === remote.id).length !== 1
      || !(state.snapshot?.people ?? []).some(p => p.id === remote.gmUserId)) continue;
    const claims = (state.claims ?? []).filter(c => c.historyId === id);
    if (claims.some(c => c.personId !== remote.gmUserId)
      || (claims.length && state.claims.some(c => c.key === `gm:${remote.id}` && c.historyId !== id))) continue;
    for (const claim of claims) {
      claim.key = claim.key.replace(`gm:foundry:${id}`, `gm:${remote.id}`);
      claim.sourceId = remote.id;
    }
    state.historyGms[id] = remote.gmUserId;
    state.sessionLinks[id] = { westmarchesId: remote.id, userId, at: now, automatic: true };
    count++;
  }
  return count;
}
export function titleSimilarity(a, b) {
  a = normalize(a); b = normalize(b);
  const part = s => s.match(/\bteil (\d+)\b/)?.[1];
  if (part(a) && part(b) && part(a) !== part(b)) return 0;
  if (a && a === b) return 1;
  const left = new Set(a.split(" ").filter(Boolean)), right = new Set(b.split(" ").filter(Boolean));
  return 2 * [...left].filter(w => right.has(w)).length / (left.size + right.size || 1);
}

export function sessionLinkPreview(state, history) {
  const links = state.sessionLinks ?? {}, gms = state.historyGms ?? {};
  const sessions = state.snapshot?.sessions ?? [];
  const used = new Set(Object.values(links).map(l => l.westmarchesId));
  const rows = history.map(record => {
    const id = String(record.id), link = links[id];
    const gm = gms[id] || record.gmPersonId || (record.gmUserId && (state.snapshot?.people ?? []).find(p => state.personLinks[p.id] === record.gmUserId)?.id);
    const candidates = gm ? sessions.filter(s => s.gmUserId === gm && !used.has(s.id) && s.status !== "cancelled")
      .map(s => ({ id: s.id, title: s.title, date: s.startTime, score: titleSimilarity(record.title, s.title) }))
      .filter(s => s.score >= .45).sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)) : [];
    return { id, title: record.title, awardedAt: record.awardedAt, gm, link, candidates, reason: link ? uiText("TOVF.Interface.SavedLink_6d640b", "Gespeicherte Verbindung") : !gm ? uiText("TOVF.Interface.GMIsMissing_0194a4", "Spielleiter fehlt") : uiText("TOVF.Interface.ReviewManually_9fa56d", "Manuell prüfen"), proposed: null };
  });
  for (const row of rows.filter(r => !r.link && r.candidates.length)) {
    const best = row.candidates[0];
    const tied = row.candidates.filter(c => c.score === best.score);
    const competitors = rows.filter(r => !r.link && r.gm === row.gm && r.candidates[0]?.score >= .8 && r.candidates.filter(c => c.score === r.candidates[0].score).some(c => c.id === best.id));
    if (best.score >= .8 && tied.length === 1 && competitors.length === 1) {
      row.proposed = best.id; row.reason = uiText("TOVF.Interface.GMAndUniqueTitle_ce21a3", "Spielleiter und eindeutiger Titel");
    } else if (best.score >= .8 && tied.length > 1) {
      const ids = tied.map(c => c.id).sort().join("|");
      const group = competitors.filter(r => r.candidates.filter(c => c.score === r.candidates[0].score).map(c => c.id).sort().join("|") === ids);
      const ordered = [...group].sort((a, b) => a.awardedAt - b.awardedAt);
      if (group.length === tied.length && competitors.length === group.length && ordered.every(r => Number.isFinite(r.awardedAt)) && new Set(ordered.map(r => r.awardedAt)).size === group.length) {
        row.proposed = [...tied].sort((a, b) => a.date.localeCompare(b.date))[ordered.indexOf(row)]?.id;
        row.reason = uiText("TOVF.Interface.MultiPartSessionSuggestedByOrderPlease_5c78d4", "Mehrteiler: Vorschlag nach Reihenfolge – bitte prüfen");
      }
    }
  }
  // A proposal is never allowed to reserve the same remote session twice.
  const duplicates = new Set(rows.filter(row => row.proposed && rows.filter(r => r.proposed === row.proposed).length > 1).map(r => r.proposed));
  for (const row of rows) if (duplicates.has(row.proposed)) { row.reason = uiText("TOVF.Interface.AmbiguousMatch_0923c5", "Mehrdeutiger Treffer"); row.proposed = null; }
  return rows;
}
