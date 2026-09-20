import { uiText } from "../core/localization.mjs";
import { exportUsers, validateUserBundle, planUserImport, importUserBundle, roleLabel } from "./user-transfer.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const escape = value => foundry.utils.escapeHTML(String(value ?? ""));

export class UserTransferApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = { id: "tovf-user-transfer", tag: "form", classes: ["downtime-manager", "tovf-campaign"], position: { width: 980, height: 800 }, window: { title: "TOVF.Interface.ImportExportUsers_006bc8", icon: "fa-solid fa-users", resizable: true }, actions: { export: this.#export, preview: this.#preview, import: this.#import } };
  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/transfer/users.hbs" } };
  _bundle = null;
  _onRender(context, options) {
    super._onRender(context, options);
    this.element.addEventListener("submit", event => event.preventDefault());
  }
  async _prepareContext() {
    if (!game.user.isGM) throw new Error(uiText("TOVF.Interface.UserTransferRequiresTheFullGMRole_a818c7", "Benutzertransfer erfordert mindestens die Rolle Spielleiter-Assistent."));
    const plan = this._bundle ? planUserImport(this._bundle) : null;
    return {
      users: game.users.map(u => ({ id: u.id, name: u.name, role: roleLabel(u.role) })),
      plan: plan && {
        rows: plan.rows.map(row => ({ ...row, targets: game.users.map(u => ({ id: u.id, name: `${u.name} · ${roleLabel(u.role)}`, selected: row.targetId === u.id })), create: row.targetId === "new" })),
        actors: plan.actors.map(row => ({ ...row, targets: game.actors.filter(a => a.type === row.source.type).map(a => ({ id: a.id, name: a.name, selected: row.targetId === a.id })), skipped: row.targetId === "skip" }))
      }
    };
  }
  static async #export() {
    try { exportUsers(new FormData(this.element).getAll("exportUsers")); } catch (error) { ui.notifications.error(error.message); }
  }
  static async #preview() {
    try {
      const file = this.element.querySelector('[name="usersFile"]')?.files?.[0];
      if (!file) throw new Error(uiText("TOVF.Interface.PleaseSelectAUserExportFile_e68b0a", "Bitte eine Benutzerexport-Datei auswählen."));
      this._bundle = validateUserBundle(JSON.parse(await file.text()));
      await this.render({ force: true });
    } catch (error) { ui.notifications.error(error.message); }
  }
  static async #import() {
    try {
      const form = new FormData(this.element);
      const choices = Object.fromEntries(this._bundle.users.map(u => [u.id, form.get(`user.${u.id}`)]));
      const actorChoices = Object.fromEntries(this._bundle.actors.map(a => [a.id, form.get(`actor.${a.id}`)]));
      const plan = planUserImport(this._bundle, choices, actorChoices);
      const accepted = await foundry.applications.api.DialogV2.confirm({ window: { title: uiText("TOVF.Interface.ApplyUserImport_e85511", "Benutzerimport übernehmen") }, content: `<p>${uiText("TOVF.Interface.ApplyP0NewUsersP1ExistingAssignments_71f839", "{p0} neue Benutzer, {p1} bestehende Zuordnungen und {p2} Charakterzuordnungen übernehmen?", { p0: (plan.rows.filter(r => r.targetId === "new").length), p1: (plan.rows.filter(r => r.target).length), p2: (plan.actors.filter(a => a.target).length) })}</p><p>${uiText("TOVF.Interface.NewUsersReceiveTheDisplayedRoleAnd_1a8534", "Neue Benutzer erhalten die angezeigte Rolle. Neue Benutzer werden ohne Passwort angelegt. Bestehende Rollen und Zugangsdaten bleiben erhalten.")}</p>` });
      if (!accepted) return;
      const result = await importUserBundle(this._bundle, { choices, actorChoices });
      ui.notifications.info(`${result.created} Benutzer angelegt, ${result.linked} bestehende Benutzer zugeordnet.`);
      await this.render({ force: true });
    } catch (error) { ui.notifications.error(error.message); }
  }
}

/** Optional identity import before session content is mutated. */
export async function reviewSessionUsers(bundle) {
  const plan = planUserImport(bundle);
  for (const row of plan.rows) if (row.target && row.target.role !== 1) row.targetId = "new";
  const rows = plan.rows.map(row => `<tr><td>${escape(row.source.name)}</td><td>Player</td><td><select name="user.${escape(row.source.id)}"><option value="new" ${row.targetId === "new" ? "selected" : ""}>${uiText("TOVF.Interface.CreateNew_d095db", "Neu anlegen")}</option><option value="skip">${uiText("TOVF.Interface.Skip_3af1d9", "Überspringen")}</option>${game.users.filter(u => u.role === 1).map(u => `<option value="${escape(u.id)}" ${row.targetId === u.id ? "selected" : ""}>${escape(u.name)} · ${escape(roleLabel(u.role))}</option>`).join("")}</select><small>${escape(row.reason)}</small></td></tr>`).join("");
  return foundry.applications.api.DialogV2.wait({
    window: { title: uiText("TOVF.Interface.AssignSessionUsers_9e1efc", "Sessionbenutzer zuordnen") }, position: { width: 760 },
    content: `<p>${uiText("TOVF.Interface.SessionUsersAlwaysReceiveThePlayerRole_17ad1e", "Sessionbenutzer erhalten immer die Rolle Player. Charakterrechte werden zugeordnet. Bestehende Spielleiterzugänge werden nicht verwendet. Neue Benutzer werden ohne Passwort angelegt.")}</p><table><thead><tr><th>${uiText("TOVF.Interface.SourceUser_dae5d5", "Quellbenutzer")}</th><th>${uiText("TOVF.Interface.RoleForNewAccount_dccfd4", "Rolle bei Neuanlage")}</th><th>Zielbenutzer</th></tr></thead><tbody>${rows}</tbody></table>`,
    buttons: [
      { action: "import", label: uiText("TOVF.Interface.IncludeUsers_3bb4a2", "Benutzer mitnehmen"), callback: (_event, button) => ({ choices: Object.fromEntries(bundle.users.map(u => [u.id, new FormData(button.form).get(`user.${u.id}`)])) }) },
      { action: "skip", label: uiText("TOVF.Interface.ContinueWithoutUsers_85ba3f", "Ohne Benutzer fortfahren"), callback: () => ({ skip: true }) },
      { action: "cancel", label: uiText("TOVF.Interface.Cancel_07af7c", "Abbrechen"), callback: () => null }
    ], rejectClose: false
  });
}
