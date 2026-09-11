/** Portable Westmarches snapshot model. No Foundry globals or inferred attendance. */
export const SNAPSHOT_VERSION = 1;
export function effectiveSessionStatus(state, session) {
  if (state.sessionReviews[session.id]?.status === "excluded") return "excluded";
  if (session.status === "cancelled") return "cancelled";
  if (state.sessionReviews[session.id]?.status === "played") return "played";
  const end = Date.parse(session.endTime);
  if (!Number.isFinite(end) || !Number.isFinite(Date.parse(session.startTime))) return "unknown";
  return end <= Date.parse(state.snapshot?.exportedAt) ? "played" : "scheduled";
}
const array = value => Array.isArray(value) ? value : [];

export function normalizeSnapshot(raw, exportedAt = new Date().toISOString()) {
  const issues = [];
  const people = new Map();
  function person(user) {
    if (!user?.id) return null;
    const id = String(user.id);
    const previous = people.get(id);
    people.set(id, { id, discordId: user.discordId ?? previous?.discordId ?? null });
    return id;
  }
  const characters = array(raw.characters).map(c => ({
    id: String(c.id), name: String(c.name ?? c.id), userId: person(c.user),
    level: c.level, milestones: c.experience, status: c.status,
    approved: c.isApproved === true, currencies: array(c.currencies),
    dataTables: array(c.dataTables)
  }));
  const characterIds = new Set(characters.map(c => c.id));
  const sessions = array(raw.adventures).map(s => {
    const gmUserId = person(s.gm);
    if (!gmUserId) issues.push({ code: "missing-gm", sessionId: String(s.id) });
    const participants = array(s.participants).map(p => {
      if (!characterIds.has(String(p.characterId))) issues.push({ code: "missing-character", sessionId: String(s.id), characterId: String(p.characterId) });
      return { characterId: String(p.characterId), registrationStatus: p.status, attendance: "unknown" };
    });
    const validDate = Number.isFinite(Date.parse(s.startTime)) && Number.isFinite(Date.parse(s.endTime));
    if (!validDate) issues.push({ code: "invalid-date", sessionId: String(s.id) });
    return {
      id: String(s.id), title: String(s.title ?? s.id), startTime: s.startTime,
      endTime: s.endTime, gmUserId, participants,
      status: s.isCancelled ? "cancelled" : !validDate ? "unknown"
        : Date.parse(s.endTime) <= Date.parse(exportedAt) ? "needs-review" : "scheduled"
    };
  });
  for (const c of characters) {
    if (!c.userId) issues.push({ code: "missing-owner", characterId: c.id });
    if (!Number.isSafeInteger(c.milestones) || c.milestones < 0) issues.push({ code: "invalid-milestones", characterId: c.id });
  }
  return {
    schemaVersion: SNAPSHOT_VERSION, source: "westmarches.games", exportedAt,
    complete: raw.complete === true, characters, people: [...people.values()], sessions,
    issues, limitations: ["No explicit played status", "Registration is not attendance", "People derived from characters and adventures; no full member directory", "No reward ledger endpoint in installed client", "Character list excludes deleted characters"],
    raw
  };
}

export function validateSnapshot(snapshot) {
  if (snapshot?.schemaVersion !== SNAPSHOT_VERSION || snapshot?.source !== "westmarches.games"
    || !Number.isFinite(Date.parse(snapshot.exportedAt))) throw new Error("Ungültiges Westmarches-Exportformat.");
  for (const key of ["characters", "people", "sessions"]) {
    if (!Array.isArray(snapshot[key])) throw new Error(`Export enthält keine gültige Liste: ${key}`);
    const ids = new Set();
    for (const row of snapshot[key]) {
      if (typeof row.id !== "string" || !row.id || ids.has(row.id) || ["__proto__", "constructor", "prototype"].includes(row.id)) throw new Error(`Fehlende oder doppelte ID in ${key}.`);
      ids.add(row.id);
    }
  }
  for (const c of snapshot.characters) {
    if (typeof c.name !== "string" || !Number.isSafeInteger(c.milestones) || c.milestones < 0 || !Array.isArray(c.currencies)) throw new Error("Ungültige Charakterdaten.");
  }
  for (const s of snapshot.sessions) {
    if (typeof s.title !== "string" || !Array.isArray(s.participants) || !["cancelled", "needs-review", "scheduled", "unknown"].includes(s.status)) throw new Error("Ungültige Sessiondaten.");
  }
  if (snapshot.complete !== true) throw new Error("Der Export ist unvollständig. Bitte fehlende Abrufe nachholen.");
  return snapshot;
}

export function compareSnapshots(previous, next) {
  validateSnapshot(next);
  const result = {};
  for (const key of ["characters", "people", "sessions"]) {
    const old = new Map(array(previous?.[key]).map(row => [row.id, row]));
    const current = new Set(next[key].map(row => row.id));
    result[key] = { added: [], changed: [], absent: [] };
    for (const row of next[key]) {
      if (!old.has(row.id)) result[key].added.push(row.id);
      else if (JSON.stringify(old.get(row.id)) !== JSON.stringify(row)) result[key].changed.push(row.id);
    }
    result[key].absent = [...old.keys()].filter(id => !current.has(id));
  }
  return result;
}

export function sessionMonth(startTime, timeZone = "Europe/Berlin") {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(new Date(startTime));
  return `${parts.find(p => p.type === "year").value}-${parts.find(p => p.type === "month").value}`;
}

export function sessionDate(startTime, timeZone = "Europe/Berlin") {
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(startTime));
  return ["year", "month", "day"].map(k => parts.find(p => p.type === k).value).join("-");
}

/** ISO milestone week, assigned to the month in which it ends (Sunday). */
export function milestoneWeek(startTime, timeZone = "Europe/Berlin") {
  const date = new Date(`${sessionDate(startTime, timeZone)}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  const sunday = new Date(date); sunday.setUTCDate(date.getUTCDate() + 7 - day);
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear();
  const week = Math.ceil(((date - new Date(Date.UTC(year, 0, 1))) / 86400000 + 1) / 7);
  return { key: `${year}-W${String(week).padStart(2, "0")}`, month: sunday.toISOString().slice(0, 7) };
}
