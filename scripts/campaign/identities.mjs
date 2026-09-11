/** Campaign people can have separate player and GM logins. */
export function personAccountIds(state, personId) {
  return [state.personLinks[personId]].filter(Boolean);
}

export function linkedPerson(state, user) {
  return (state.snapshot?.people ?? []).find(p => personAccountIds(state, p.id).includes(user.id))?.id;
}

export function personName(state, personId) {
  return state.personNames?.[personId]?.trim()
    || game.users.get(state.personLinks[personId])?.name
    || personAccountIds(state, personId).map(id => game.users.get(id)?.name).find(Boolean)
    || "Spieler noch nicht zugeordnet";
}

/** Match only unique character names, then explicit player ownership. Never GM-wide permissions. */
export function detectCampaignLinks(state) {
  const normalize = name => {
    const value = String(name ?? "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("de");
    // Dotted initials may omit their final dot in Foundry. Keep all other punctuation.
    return /^(?:\p{L}\.)+\p{L}\.?$/u.test(value) ? value.replace(/\.$/, "") : value;
  };
  const characters = state.snapshot?.characters ?? [];
  const actors = game.actors.filter(a => ["pc", "character", "player-character"].includes(a.type));
  const characterLinks = { ...state.characterLinks };
  const personLinks = { ...state.personLinks };
  const newCharacters = []; const newPeople = [];
  for (const character of characters) {
    if (characterLinks[character.id]) continue;
    const name = normalize(character.name);
    if (!name || characters.filter(c => normalize(c.name) === name).length !== 1) continue;
    const matches = actors.filter(a => normalize(a.name) === name);
    if (matches.length !== 1 || Object.values(characterLinks).includes(matches[0].uuid)) continue;
    characterLinks[character.id] = matches[0].uuid;
    newCharacters.push(character.id);
  }
  const proposals = new Map();
  for (const person of state.snapshot?.people ?? []) {
    if (personLinks[person.id]) continue;
    const ownedActors = characters.filter(c => c.userId === person.id).map(c => actors.find(a => a.uuid === characterLinks[c.id])).filter(Boolean);
    const candidates = game.users.filter(user => ownedActors.some(actor => (
      Number(actor.ownership?.[user.id] ?? 0) >= 3 || (user.character?.id ?? user.character) === actor.id
    )));
    if (candidates.length !== 1) continue;
    const userId = candidates[0].id;
    if ((state.snapshot?.people ?? []).some(p => p.id !== person.id && personAccountIds(state, p.id).includes(userId))) continue;
    proposals.set(person.id, userId);
  }
  for (const [personId, userId] of proposals) {
    if ([...proposals.values()].filter(id => id === userId).length !== 1) continue;
    personLinks[personId] = userId;
    newPeople.push(personId);
  }
  return { characterLinks, personLinks, newCharacters, newPeople };
}

export function charactersForPerson(state, personId) {
  if (!personId) return [];
  const mapped = new Set((state.snapshot?.characters ?? [])
    .filter(c => c.userId === personId).map(c => state.characterLinks[c.id]).filter(Boolean));
  const accounts = personAccountIds(state, personId).map(id => game.users.get(id)).filter(Boolean);
  return game.actors.filter(actor => ["pc", "character", "player-character"].includes(actor.type) && (
    mapped.has(actor.uuid) || accounts.some(user => {
      // isGM/testUserPermission would grant every character to every GM login.
      const selected = user.character?.id ?? user.character;
      return selected === actor.id || Number(actor.ownership?.[user.id] ?? 0) >= 3;
    })
  )).sort((a, b) => a.name.localeCompare(b.name));
}
