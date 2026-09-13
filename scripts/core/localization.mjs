/** Keep pure data tools and tests usable without a Foundry localization service. */
export function uiText(key, fallback, data = {}) {
  const i18n = globalThis.game?.i18n;
  const translated = i18n?.localize?.(key);
  const text = typeof translated === "string" && translated !== key ? translated : fallback;
  return text.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(data, name) ? String(data[name]) : match);
}
