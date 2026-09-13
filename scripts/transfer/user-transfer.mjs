import { uiText } from "../core/localization.mjs";
import { MODULE_ID } from "../core/constants.mjs";

const FORMAT = "tov-feuerschwinge-users";
const IDENTITIES = "userTransferIds";
const copy = value => foundry.utils.deepClone(value);
const assertGM = () => { if (game.user.role !== CONST.USER_ROLES.GAMEMASTER) throw new Error(uiText("TOVF.Interface.UserImportsAndExportsRequireTheFull_1770f8", "Benutzerimporte und -exporte erfordern die Rolle Spielleiter.")); };
const actorId = actor => actor.getFlag(MODULE_ID, "transfer")?.id ?? `world:${game.world.id}:Actor:${actor.id}`;
export const userIdentity = user => user.getFlag(MODULE_ID, IDENTITIES)?.[0] ?? `world:${game.world.id}:User:${user.id}`;
export const roleLabel = role => ({ 0: "Deaktiviert", 1: uiText("TOVF.Interface.Player_1f52fa", "Spieler"), 2: uiText("TOVF.Interface.TrustedPlayer_5b60ca", "Vertrauenswürdiger Spieler"), 3: "Spielleiterassistent", 4: uiText("TOVF.Interface.GM_016a67", "Spielleiter") }[role] ?? uiText("TOVF.Interface.Unknown_d0b00a", "Unbekannt"));

export function createUserBundle({ actors = game.actors.contents, userIds = null } = {}) {
  const state = game.settings.get(MODULE_ID, "campaignLedger") ?? {};
  const selected = userIds ? new Set(userIds) : null;
  const users = game.users.filter(u => !selected || selected.has(u.id));
  const actorRef = a => a ? { id: actorId(a), sourceId: a.id, name: a.name, type: a.type } : null;
  const bundle = {
    format: FORMAT, version: 1, sourceWorld: game.world.id, system: game.system.id, exportedAt: new Date().toISOString(),
    users: users.map(u => ({
      id: userIdentity(u), identities: [...new Set([userIdentity(u), ...(u.getFlag(MODULE_ID, IDENTITIES) ?? [])])], sourceId: u.id, name: u.name, role: u.role,
      color: String(u.color ?? "#888888"), avatar: u.avatar ?? "", pronouns: u.pronouns ?? "",
      character: actorRef(actors.find(a => a.id === (u.character?.id ?? u.character))),
      people: (state.snapshot?.people ?? []).filter(p => state.personLinks?.[p.id] === u.id).map(p => ({
        id: p.id, name: state.personNames?.[p.id] ?? "", primary: state.personLinks?.[p.id] === u.id,
        // Enough data to recreate a manual Foundry person even before campaign import.
        local: p.id.startsWith("foundry:")
      }))
    })),
    actors: actors.map(a => ({
      ...actorRef(a),
      ownership: users.filter(u => Object.hasOwn(a.ownership ?? {}, u.id)).map(u => ({ userId: userIdentity(u), level: a.ownership[u.id] })),
      campaignCharacterIds: Object.entries(state.characterLinks ?? {}).filter(([, uuid]) => uuid === a.uuid).map(([id]) => id)
    })).filter(a => a.ownership.length || a.campaignCharacterIds.length || users.some(u => (u.character?.id ?? u.character) === a.sourceId))
  };
  return validateUserBundle(bundle);
}

export function createSessionUserBundle(actors, participants = actors) {
  const state = game.settings.get(MODULE_ID, "campaignLedger") ?? {};
  const users = new Set();
  for (const actor of participants.filter(a => ["pc", "character", "player-character"].includes(a.type))) {
    const sourceCharacters = (state.snapshot?.characters ?? []).filter(c => state.characterLinks?.[c.id] === actor.uuid);
    const assigned = sourceCharacters.map(c => state.personLinks?.[c.userId]).filter(id => game.users.get(id));
    if (assigned.length) assigned.forEach(id => users.add(id));
    else for (const user of game.users) {
      const mainCharacter = (user.character?.id ?? user.character) === actor.id;
      const playerOwner = [1, 2].includes(user.role) && Number(actor.ownership?.[user.id] ?? 0) >= 3;
      if (mainCharacter || playerOwner) users.add(user.id);
    }
  }
  return createUserBundle({ actors, userIds: [...users] });
}

export function validateUserBundle(bundle) {
  if (bundle?.format !== FORMAT || bundle.version !== 1 || !Array.isArray(bundle.users) || !Array.isArray(bundle.actors) || typeof bundle.sourceWorld !== "string") throw new Error(uiText("TOVF.Interface.InvalidUserPackage_ddef48", "Ungültiges Benutzerpaket."));
  for (const [kind, rows] of [["users", bundle.users], ["actors", bundle.actors]]) {
    const ids = new Set(); const sourceIds = new Set();
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id || ids.has(row.id) || typeof row.sourceId !== "string" || !row.sourceId || sourceIds.has(row.sourceId) || ["__proto__", "constructor", "prototype", "default"].includes(row.sourceId)) throw new Error(uiText("TOVF.Interface.MissingOrDuplicateTransferID_031a7f", "Fehlende oder doppelte Transferkennung."));
      ids.add(row.id); sourceIds.add(row.sourceId);
      if (typeof row.name !== "string" || !row.name.trim()) throw new Error(uiText("TOVF.Interface.NameIsMissing_b4d6b5", "Name fehlt."));
      if (kind === "users" && (!Number.isInteger(row.role) || row.role < 0 || row.role > 4 || !Array.isArray(row.people))) throw new Error(uiText("TOVF.Interface.InvalidUserRoleOrPersonAssignment_89f28b", "Ungültige Benutzerrolle oder Personenzuordnung."));
      if (kind === "users" && (![row.color, row.avatar, row.pronouns].every(v => typeof v === "string") || (row.identities !== undefined && (!Array.isArray(row.identities) || row.identities.some(id => typeof id !== "string" || !id))))) throw new Error(uiText("TOVF.Interface.InvalidUserProfile_e22027", "Ungültiges Benutzerprofil."));
      if (kind === "users") for (const p of row.people) {
        if (typeof p.id !== "string" || !p.id || ["__proto__", "constructor", "prototype"].includes(p.id) || typeof p.name !== "string" || typeof p.primary !== "boolean") throw new Error(uiText("TOVF.Interface.InvalidPersonAssignment_1290e4", "Ungültige Personenzuordnung."));
      }
      if (kind === "actors" && (!Array.isArray(row.ownership) || !Array.isArray(row.campaignCharacterIds))) throw new Error(uiText("TOVF.Interface.InvalidCharacterPermissions_9b56e1", "Ungültige Charakterrechte."));
      if (kind === "actors" && (typeof row.type !== "string" || row.campaignCharacterIds.some(id => typeof id !== "string" || !id || ["__proto__", "constructor", "prototype"].includes(id)))) throw new Error(uiText("TOVF.Interface.InvalidCharacterIdentifier_d3b2f6", "Ungültige Charakterkennung."));
    }
  }
  const userIds = new Set(bundle.users.map(u => u.id));
  const actorIds = new Set(bundle.actors.map(a => a.id));
  for (const u of bundle.users) if (u.character && !actorIds.has(u.character.id)) throw new Error(uiText("TOVF.Interface.TheSelectedCharacterIsMissingFromThe_d6a22f", "Gewählter Charakter fehlt im Benutzerpaket."));
  for (const actor of bundle.actors) for (const owner of actor.ownership) {
    if (!userIds.has(owner.userId) || !Number.isInteger(owner.level) || owner.level < 0 || owner.level > 3) throw new Error(uiText("TOVF.Interface.InvalidCharacterOwner_b9dfb0", "Ungültiger Charakterbesitzer."));
  }
  return bundle;
}

function identityMatches(user, id) {
  return userIdentity(user) === id || (user.getFlag(MODULE_ID, IDENTITIES) ?? []).includes(id);
}

export function knownUserMapping(bundle) {
  const mapping = new Map();
  if (!bundle) return mapping;
  validateUserBundle(bundle);
  for (const source of bundle.users) {
    const matches = game.users.filter(user => [source.id, ...(source.identities ?? [])].some(id => identityMatches(user, id)));
    if (matches.length === 1) mapping.set(source.sourceId, matches[0].id);
  }
  return mapping;
}

function mergePersonAssignments(state, bundle, identityMap) {
  state.personLinks ??= {}; state.personAccounts ??= {}; state.personNames ??= {}; state.characterLinks ??= {};
  state.pendingTransferPeople ??= [];
  for (const source of bundle.users) {
    const userId = identityMap.get(source.id); if (!userId) continue;
    for (const p of source.people) {
      const existingOwner = Object.entries(state.personLinks).find(([id, linked]) => id !== p.id && linked === userId);
      if (!p.primary) continue;
      if (existingOwner || (state.personLinks[p.id] && state.personLinks[p.id] !== userId)) throw new Error(uiText("TOVF.Interface.ThePersonAssignmentConflictsWithTheTarget_d6e0ee", "Personenzuordnung widerspricht der Zielwelt. Bitte vorhandene Zuordnung zuerst prüfen."));
      if (p.primary) state.personLinks[p.id] = userId;
      else state.personAccounts[p.id] = [...new Set([...(state.personAccounts[p.id] ?? []), userId])];
      if (p.name && !state.personNames[p.id]) state.personNames[p.id] = p.name;
      if (!state.pendingTransferPeople.some(row => row.id === p.id)) state.pendingTransferPeople.push({ id: p.id, discordId: null });
      if (state.snapshot && !state.snapshot.people.some(row => row.id === p.id)) state.snapshot.people.push({ id: p.id, discordId: null });
    }
  }
  return state;
}

export function planUserImport(bundle, choices = {}, actorChoices = {}) {
  validateUserBundle(bundle);
  const rows = bundle.users.map(source => {
    const identity = game.users.filter(u => [source.id, ...(source.identities ?? [])].some(id => identityMatches(u, id)));
    const byName = game.users.filter(u => u.name === source.name && u.role === source.role);
    const suggested = identity.length === 1 ? identity[0] : identity.length === 0 && byName.length === 1 ? byName[0] : null;
    const targetId = choices[source.id] ?? (suggested?.id ?? "new");
    const target = game.users.get(targetId);
    if (!["new", "skip"].includes(targetId) && !target) throw new Error(uiText("TOVF.Interface.TheSelectedTargetUserIsMissing_b09af0", "Gewählter Zielbenutzer fehlt."));
    return { source, targetId, target, reason: identity.length === 1 ? "Transferkennung" : suggested ? uiText("TOVF.Interface.NameAndRoleReviewAssignment_280d25", "Name und Rolle – Zuordnung prüfen") : uiText("TOVF.Interface.CreateNew_d095db", "Neu anlegen"), role: roleLabel(source.role) };
  });
  const targets = rows.filter(r => !["new", "skip"].includes(r.targetId)).map(r => r.targetId);
  if (new Set(targets).size !== targets.length) throw new Error(uiText("TOVF.Interface.MultipleSourceUsersAreAssignedToThe_e5adec", "Mehrere Quellbenutzer sind demselben Zielbenutzer zugeordnet."));
  const actors = bundle.actors.map(source => {
    const matches = game.actors.filter(a => actorId(a) === source.id);
    const byName = game.actors.filter(a => a.name === source.name && a.type === source.type);
    const suggested = matches.length === 1 ? matches[0] : matches.length === 0 && byName.length === 1 ? byName[0] : null;
    const targetId = actorChoices[source.id] ?? suggested?.id ?? "skip";
    const target = game.actors.get(targetId);
    if (targetId !== "skip" && !target) throw new Error(uiText("TOVF.Interface.TheSelectedTargetCharacterIsMissing_caa0bb", "Gewählter Zielcharakter fehlt."));
    return { source, targetId, target, reason: matches.length === 1 ? "Transferkennung" : suggested ? uiText("TOVF.Interface.NameAndTypeReviewAssignment_a05af2", "Name und Typ – Zuordnung prüfen") : uiText("TOVF.Interface.CharacterIsMissing_99d80e", "Charakter fehlt") };
  });
  const targetActors = actors.filter(a => a.target).map(a => a.targetId);
  if (new Set(targetActors).size !== targetActors.length) throw new Error(uiText("TOVF.Interface.MultipleSourceCharactersAreAssignedToThe_306b1d", "Mehrere Quellcharaktere sind demselben Zielcharakter zugeordnet."));
  return { rows, actors };
}

export function remapUserOwnership(ownership, mapping) {
  const result = { default: Number.isInteger(ownership?.default) && ownership.default >= 0 && ownership.default <= 3 ? ownership.default : 0 };
  for (const [sourceId, targetId] of mapping) {
    const level = ownership?.[sourceId];
    if (Number.isInteger(level) && level >= 0 && level <= 3) result[targetId] = level;
  }
  return result;
}

let busy = false;
export async function importUserBundle(bundle, { choices = {}, actorChoices = {}, applyActors = true, sessionPlayers = false } = {}) {
  assertGM();
  if (busy) throw new Error(uiText("TOVF.Interface.AUserImportIsAlreadyRunning_fda359", "Ein Benutzerimport läuft bereits."));
  const plan = planUserImport(bundle, choices, actorChoices);
  if (sessionPlayers && plan.rows.some(r => r.target && r.target.role !== 1)) throw new Error(uiText("TOVF.Interface.ForSessionUsersSelectANewAccount_f22f95", "Für Sessionbenutzer bitte einen neuen Zugang oder einen bestehenden Player auswählen. Spielleiterzugänge der Sessionwelt bleiben erhalten."));
  // Detect conflicts before creating a user or changing any Actor.
  mergePersonAssignments(copy(game.settings.get(MODULE_ID, "campaignLedger") ?? {}), bundle,
    new Map(plan.rows.filter(r => r.targetId !== "skip").map(r => [r.source.id, r.target?.id ?? `new:${r.source.id}`])));
  busy = true;
  try {
    const mapping = new Map(); const identityMap = new Map(); const createdUserIds = [];
    for (const row of plan.rows) {
      if (row.targetId === "skip") continue;
      let user = row.target;
      if (!user) {
        // Whitelist only profile fields. Passwords, permission overrides and arbitrary flags never cross worlds.
        user = await User.create({ name: row.source.name, role: sessionPlayers ? 1 : row.source.role, color: row.source.color, avatar: row.source.avatar, pronouns: row.source.pronouns, password: "", flags: { [MODULE_ID]: { [IDENTITIES]: [...new Set([row.source.id, ...(row.source.identities ?? [])])], ...(sessionPlayers ? { sessionImportedUser: true } : {}) } } });
        createdUserIds.push(user.id);
      } else {
        const identities = [...new Set([userIdentity(user), ...(user.getFlag(MODULE_ID, IDENTITIES) ?? []), row.source.id, ...(row.source.identities ?? [])])];
        await user.setFlag(MODULE_ID, IDENTITIES, identities);
      }
      mapping.set(row.source.sourceId, user.id); identityMap.set(row.source.id, user.id);
    }
    if (applyActors) await applyUserAssignments(bundle, identityMap, new Map(plan.actors.filter(a => a.target).map(a => [a.source.id, a.target])));
    return { mapping, identityMap, createdUserIds, created: plan.rows.filter(r => r.targetId === "new").length, linked: plan.rows.filter(r => r.target).length };
  } finally { busy = false; }
}

export async function applyUserAssignments(bundle, identityMap, actorMap) {
  assertGM();
  const state = mergePersonAssignments(copy(game.settings.get(MODULE_ID, "campaignLedger") ?? {}), bundle, identityMap);
  for (const source of bundle.users) {
    const userId = identityMap.get(source.id); if (!userId) continue;
    const user = game.users.get(userId);
    const actor = source.character ? actorMap.get(source.character.id) : null;
    if (actor) await user.update({ character: actor.id });
  }
  for (const source of bundle.actors) {
    const actor = actorMap.get(source.id); if (!actor) continue;
    const updates = {};
    for (const owner of source.ownership) {
      const userId = identityMap.get(owner.userId);
      if (userId) updates[`ownership.${userId}`] = owner.level;
    }
    if (Object.keys(updates).length) await actor.update(updates);
    for (const id of source.campaignCharacterIds) state.characterLinks[id] = actor.uuid;
  }
  state.revision = Number(state.revision ?? 0) + 1;
  await game.settings.set(MODULE_ID, "campaignLedger", state);
}

export function exportUsers(userIds = null) {
  assertGM();
  const bundle = createUserBundle({ userIds });
  foundry.utils.saveDataToFile(JSON.stringify(bundle, null, 2), "application/json", `feuerschwinge-benutzer-${game.world.id}-${bundle.exportedAt.slice(0, 10)}.json`);
  return bundle;
}
