const normalize = title => String(title ?? "").normalize("NFKC").toLowerCase()
  .replace(/\b(?:teil|part|episode)\s+(i{1,3}|iv|v|vi{0,3}|ix|x)\b/g, (_, n) => `teil ${["i","ii","iii","iv","v","vi","vii","viii","ix","x"].indexOf(n) + 1}`)
  .replace(/\b(?:part|episode)\b/g, "teil").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
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
    return { id, title: record.title, awardedAt: record.awardedAt, gm, link, candidates, reason: link ? "Gespeicherte Verbindung" : !gm ? "Spielleiter fehlt" : "Manuell prüfen", proposed: null };
  });
  for (const row of rows.filter(r => !r.link && r.candidates.length)) {
    const best = row.candidates[0];
    const tied = row.candidates.filter(c => c.score === best.score);
    const competitors = rows.filter(r => !r.link && r.gm === row.gm && r.candidates[0]?.score >= .8 && r.candidates.filter(c => c.score === r.candidates[0].score).some(c => c.id === best.id));
    if (best.score >= .8 && tied.length === 1 && competitors.length === 1) {
      row.proposed = best.id; row.reason = "Spielleiter und eindeutiger Titel";
    } else if (best.score >= .8 && tied.length > 1) {
      const ids = tied.map(c => c.id).sort().join("|");
      const group = competitors.filter(r => r.candidates.filter(c => c.score === r.candidates[0].score).map(c => c.id).sort().join("|") === ids);
      const ordered = [...group].sort((a, b) => a.awardedAt - b.awardedAt);
      if (group.length === tied.length && competitors.length === group.length && ordered.every(r => Number.isFinite(r.awardedAt)) && new Set(ordered.map(r => r.awardedAt)).size === group.length) {
        row.proposed = [...tied].sort((a, b) => a.date.localeCompare(b.date))[ordered.indexOf(row)]?.id;
        row.reason = "Mehrteiler: Vorschlag nach Reihenfolge – bitte prüfen";
      }
    }
  }
  // A proposal is never allowed to reserve the same remote session twice.
  const duplicates = new Set(rows.filter(row => row.proposed && rows.filter(r => r.proposed === row.proposed).length > 1).map(r => r.proposed));
  for (const row of rows) if (duplicates.has(row.proposed)) { row.reason = "Mehrdeutiger Treffer"; row.proposed = null; }
  return rows;
}
