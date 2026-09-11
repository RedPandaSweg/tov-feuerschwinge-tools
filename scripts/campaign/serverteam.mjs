/** Legacy monthly selections seed the persistent roster from the latest saved month. */
export function activeServerteam(state) {
  if (Array.isArray(state.serverteam)) return [...new Set(state.serverteam)];
  const month = Object.keys(state.recipients ?? {}).sort().at(-1);
  return [...new Set(state.recipients?.[month] ?? [])];
}
