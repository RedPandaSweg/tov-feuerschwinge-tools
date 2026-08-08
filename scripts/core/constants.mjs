export const MODULE_ID = "tov-feuerschwinge-tools";
export const CONTENT_MODULE_ID = "tov-feuerschwinge";
export const LEGACY_MODULE_SCOPE = CONTENT_MODULE_ID;
export const LEGACY_MODULE_ID = "black-flag-improvements";
export const TRANSFER_FORMAT = "tov-feuerschwinge-compendium-folder-bundle";
export const TRANSFER_FORMAT_VERSION = 1;
export const SCHEMA_VERSION = 13;
export const WORLD_ROLES = Object.freeze({
  PRIMARY: "primary",
  SESSION: "session"
});

export function modulePath(path) {
  return `modules/${MODULE_ID}/${path}`;
}
