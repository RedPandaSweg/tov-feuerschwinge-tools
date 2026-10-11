import { emitModuleEvent, subscribeModuleEvent } from "./core/events.mjs?v=3.7.8-module-events-1";
import { isProjectAdministrator } from "./core/permissions.mjs?v=3.7.8-permissions-1";

const EVENT_TYPE = "serverUpdateWarning";
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 2000;
let activated = false;

function text(key) {
  return game.i18n.localize(`TOVF.ServerUpdateWarning.${key}`);
}

function presets() {
  return {
    update: { title: text("Presets.Update.Title"), message: text("Presets.Update.Message") },
    restart: { title: text("Presets.Restart.Title"), message: text("Presets.Restart.Message") },
    complete: { title: text("Presets.Complete.Title"), message: text("Presets.Complete.Message") },
    custom: { title: "", message: "" }
  };
}

function cleanWarning(source = {}) {
  return {
    title: String(source.title ?? "").trim().slice(0, MAX_TITLE_LENGTH),
    message: String(source.message ?? "").trim().slice(0, MAX_MESSAGE_LENGTH)
  };
}

function warningContent(warning) {
  const message = foundry.utils.escapeHTML(warning.message).replace(/\r?\n/g, "<br>");
  return `<section class="tovf-server-warning-card">
    <i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>
    <div><h2>${foundry.utils.escapeHTML(warning.title)}</h2><p>${message}</p></div>
  </section>`;
}

async function composeWarning() {
  const result = await foundry.applications.api.DialogV2.wait({
    window: { title: text("ComposerTitle") },
    position: { width: 560 },
    content: `<div class="standard-form">
      <div class="form-group"><label>${text("Preset")}</label><div class="form-fields"><select name="preset">
        <option value="restart">${text("Presets.Restart.Label")}</option>
        <option value="update">${text("Presets.Update.Label")}</option>
        <option value="complete">${text("Presets.Complete.Label")}</option>
        <option value="custom">${text("Presets.Custom.Label")}</option>
      </select></div></div>
      <p class="hint">${text("OverrideHint")}</p>
      <div class="form-group"><label>${text("CustomTitle")}</label><div class="form-fields"><input type="text" name="title" maxlength="${MAX_TITLE_LENGTH}" placeholder="${text("CustomTitlePlaceholder")}"></div></div>
      <div class="form-group stacked"><label>${text("CustomMessage")}</label><textarea name="message" rows="7" maxlength="${MAX_MESSAGE_LENGTH}" placeholder="${text("CustomMessagePlaceholder")}"></textarea></div>
    </div>`,
    buttons: [
      {
        action: "preview",
        label: text("Preview"),
        icon: "<i class='fa-solid fa-eye'></i>",
        default: true,
        callback: (_event, button) => new foundry.applications.ux.FormDataExtended(button.form).object
      },
      { action: "cancel", label: game.i18n.localize("Cancel"), callback: () => null }
    ],
    rejectClose: false
  });
  if (!result) return null;
  const preset = presets()[result.preset] ?? presets().custom;
  return cleanWarning({
    title: String(result.title ?? "").trim() || preset.title,
    message: String(result.message ?? "").trim() || preset.message
  });
}

export async function sendServerUpdateWarning() {
  if (!isProjectAdministrator()) {
    ui.notifications.error(text("FullGMOnly"));
    return;
  }
  const recipients = game.users.filter(user => user.active && !user.isGM);
  const warning = await composeWarning();
  if (!warning) return;
  if (!warning.title || !warning.message) {
    ui.notifications.warn(text("MissingContent"));
    return;
  }
  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: text("PreviewTitle") },
    content: `${warningContent(warning)}<p>${game.i18n.format("TOVF.ServerUpdateWarning.Confirm", { count: recipients.length })}</p>`,
    yes: { label: text("Send"), icon: "<i class='fa-solid fa-paper-plane'></i>" },
    no: { label: game.i18n.localize("Cancel") }
  });
  if (!confirmed) return;
  emitModuleEvent(EVENT_TYPE, warning);
  ui.notifications.info(game.i18n.format("TOVF.ServerUpdateWarning.Sent", { count: recipients.length }));
}

async function showWarning(payload, event) {
  if (game.user.isGM) return;
  const sender = game.users.get(event?.senderId);
  if (!isProjectAdministrator(sender)) return;
  const warning = cleanWarning(payload);
  if (!warning.title || !warning.message) return;
  await foundry.applications.api.DialogV2.wait({
    classes: ["tovf-server-update-warning"],
    window: { title: warning.title },
    position: { width: 560 },
    content: warningContent(warning),
    buttons: [{
      action: "acknowledge",
      label: text("Acknowledge"),
      icon: "<i class='fa-solid fa-check'></i>",
      default: true,
      callback: () => true
    }],
    rejectClose: false
  });
}

export function activateServerUpdateWarning() {
  if (activated) return;
  activated = true;
  subscribeModuleEvent(EVENT_TYPE, (payload, event) => {
    void showWarning(payload, event).catch(error => {
      console.error("tov-feuerschwinge-tools | Server update warning could not be displayed.", error);
    });
  });
}
