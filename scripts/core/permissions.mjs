export function isOperationalGM(user = game.user) {
  return user?.isGM === true;
}

export function isAssistantGM(user = game.user) {
  return user?.role === CONST.USER_ROLES.ASSISTANT;
}

export function isProjectAdministrator(user = game.user) {
  return user?.role === CONST.USER_ROLES.GAMEMASTER;
}

export function canModifyWorldSettings(user = game.user) {
  return isOperationalGM(user) && user.can?.("SETTINGS_MODIFY") === true;
}

export function requireOperationalGM(user = game.user, message = "This operation requires a game master.") {
  if (!isOperationalGM(user)) throw new Error(message);
  return user;
}

export function requireProjectAdministrator(user = game.user, message = "This operation requires a full game master.") {
  if (!isProjectAdministrator(user)) throw new Error(message);
  return user;
}
