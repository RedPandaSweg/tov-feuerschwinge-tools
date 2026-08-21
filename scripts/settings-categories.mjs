import { MODULE_ID } from "./core/constants.mjs";

const SECTIONS = [
  {
    label: "TOVF.SettingsSections.Creatures",
    selector: `[data-key="${MODULE_ID}.creatureBuilder"]`
  },
  {
    label: "TOVF.SettingsSections.Transfer",
    selector: `[data-key="${MODULE_ID}.compendiumTransfer"]`
  },
  {
    label: "TOVF.SettingsSections.Items",
    selector: `[data-key="${MODULE_ID}.weaponCustomization"]`
  },
  {
    label: "TOVF.SettingsSections.Void",
    selector: `[data-key="${MODULE_ID}.voidTaint"]`
  },
  {
    label: "TOVF.SettingsSections.Downtime",
    selector: `[data-key="${MODULE_ID}.itemDefaults"]`
  },
  {
    label: "TOVF.SettingsSections.World",
    selector: `[name="${MODULE_ID}.worldRole"]`
  }
];

function settingsRoot(element) {
  if (element instanceof HTMLElement) return element;
  return element?.[0] ?? null;
}

function addSettingsCategories(_application, element) {
  const root = settingsRoot(element);
  const category = root?.querySelector(`[data-category="${MODULE_ID}"]`);
  if (!category) return;
  category.querySelectorAll(".tovf-settings-section").forEach(heading => heading.remove());
  for (const section of SECTIONS) {
    const anchor = category.querySelector(section.selector);
    const row = anchor?.closest(".form-group");
    if (!row) continue;
    const heading = document.createElement("h3");
    heading.className = "tovf-settings-section";
    heading.textContent = game.i18n.localize(section.label);
    row.before(heading);
  }
}

export function registerSettingsCategories() {
  Hooks.on("renderSettingsConfig", addSettingsCategories);
}

export async function openFeuerschwingeSettings() {
  const app = game.settings.sheet;
  await app.render({ force: true });
  const tab = app.element?.querySelector(`button[data-tab="${MODULE_ID}"]`);
  tab?.click();
  requestAnimationFrame(() => {
    app.element
      ?.querySelector(`[data-category="${MODULE_ID}"]`)
      ?.scrollIntoView({ block: "start" });
  });
}
