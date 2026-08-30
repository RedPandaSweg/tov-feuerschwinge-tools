const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const GROUPS = [
  ["TOVF.Help.Groups.General", "fa-solid fa-compass", [
    ["TOVF.Help.Overview", "overview", "fa-solid fa-fire-flame-curved", 5],
    ["DOWNTIME_MANAGER.Help.Settings", "settings", "fa-solid fa-gears", 8],
    ["DOWNTIME_MANAGER.Help.Troubleshooting", "troubleshooting", "fa-solid fa-life-ring", 8]
  ]],
  ["TOVF.Help.Groups.GameTools", "fa-solid fa-toolbox", [
    ["TOVF.Help.CreatureBuilder", "creature-builder", "fa-solid fa-dragon", 6],
    ["TOVF.Help.Weapons", "weapons", "fa-solid fa-swords", 4],
    ["TOVF.Help.Compendiums", "compendiums", "fa-solid fa-books", 4],
    ["TOVF.Help.Challenge", "challenge", "fa-solid fa-skull-crossbones", 6],
    ["TOVF.Help.Links", "links", "fa-solid fa-link", 4]
  ]],
  ["TOVF.Help.Groups.DowntimeProjects", "fa-solid fa-hourglass-half", [
    ["DOWNTIME_MANAGER.Help.QuickStart", "quickstart", "fa-solid fa-rocket", 6],
    ["DOWNTIME_MANAGER.Help.Downtime", "downtime", "fa-solid fa-hourglass-half", 4],
    ["DOWNTIME_MANAGER.Help.Stations", "stations", "fa-solid fa-screwdriver-wrench", 6],
    ["DOWNTIME_MANAGER.Help.Projects", "projects", "fa-solid fa-scroll", 9],
    ["DOWNTIME_MANAGER.Help.Templates", "templates", "fa-solid fa-wand-magic-sparkles", 6],
    ["DOWNTIME_MANAGER.Help.Progress", "progress", "fa-solid fa-bars-progress", 6],
    ["DOWNTIME_MANAGER.Help.Checks", "checks", "fa-solid fa-dice-d20", 5],
    ["DOWNTIME_MANAGER.Help.Completion", "completion", "fa-solid fa-flag-checkered", 5],
    ["DOWNTIME_MANAGER.Help.DowntimeItems", "downtime-items", "fa-solid fa-ticket", 6]
  ]],
  ["TOVF.Help.Groups.DowntimeManagement", "fa-solid fa-people-group", [
    ["DOWNTIME_MANAGER.Help.Dashboard", "dashboard", "fa-solid fa-table-columns", 6],
    ["DOWNTIME_MANAGER.Help.Sessions", "sessions", "fa-solid fa-scroll", 11],
    ["DOWNTIME_MANAGER.GMTools.Help", "gm-tools", "fa-solid fa-screwdriver-wrench", 7],
    ["DOWNTIME_MANAGER.Help.Passive", "passive", "fa-solid fa-calendar", 5]
  ]]
];

function sectionView([root, key, icon, count], open = false) {
  return { key, icon, open, title: game.i18n.localize(key === "quickstart" ? "TOVF.Help.QuickStartTitle" : `${root}.Title`), text: game.i18n.localize(`${root}.Text`), points: Array.from({ length: count }, (_, point) => game.i18n.localize(`${root}.Point${point + 1}`)) };
}

export class HelpApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "downtime-manager-help",
    classes: ["downtime-manager", "downtime-help"],
    position: { width: 760, height: 820 },
    window: { title: "DOWNTIME_MANAGER.Help.Title", resizable: true },
    actions: {
      scrollToSection: HelpApp.#scrollToSection
    }
  };

  static PARTS = {
    main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/help.hbs" }
  };

  static #scrollToSection(event, target) {
    event.preventDefault();
    const key = String(target.dataset.section ?? "");
    const section = this.element.querySelector(`#help-${CSS.escape(key)}`);
    if (!section) return;
    section.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    return {
      ...context,
      introduction: game.i18n.localize("DOWNTIME_MANAGER.Help.Introduction"),
      groups: GROUPS.map(([label, icon, sections], groupIndex) => ({
        label: game.i18n.localize(label), icon,
        sections: sections.map((section, sectionIndex) => sectionView(section, groupIndex === 0 && sectionIndex === 0))
      }))
    };
  }
}
