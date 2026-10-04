import { MODULE_ID } from "./core/constants.mjs";

function directoryRoot(element) {
  return element instanceof HTMLElement ? element : element?.[0] ?? null;
}

function markInactiveActors(_application, element) {
  const root = directoryRoot(element);
  if (!root) return;
  root.querySelectorAll(".tovf-inactive-actor").forEach(entry => entry.classList.remove("tovf-inactive-actor"));
  root.querySelectorAll("[data-tovf-inactive-actor]").forEach(badge => badge.remove());
  for (const actor of game.actors) {
    if (actor.getFlag(MODULE_ID, "active") !== false) continue;
    const selectors = [
      `[data-entry-id="${CSS.escape(actor.id)}"]`,
      `[data-document-id="${CSS.escape(actor.id)}"]`,
      `[data-actor-id="${CSS.escape(actor.id)}"]`,
      `[data-entry-uuid="${CSS.escape(actor.uuid)}"]`
    ].join(",");
    for (const entry of root.querySelectorAll(selectors)) {
      entry.classList.add("tovf-inactive-actor");
      const name = entry.querySelector(".entry-name, .document-name, h4, a");
      if (!name) continue;
      const badge = document.createElement("span");
      badge.className = "tovf-inactive-actor-badge";
      badge.dataset.tovfInactiveActor = "";
      badge.title = game.i18n.localize("TOVF.ActorDirectory.InactiveHint");
      badge.innerHTML = `<i class="fa-solid fa-user-slash" inert></i>${game.i18n.localize("TOVF.ActorDirectory.Inactive")}`;
      name.append(badge);
    }
  }
}

function markCurrentActorDirectory() {
  const directory = ui.actors ?? ui.sidebar?.tabs?.actors;
  if (directory?.element) markInactiveActors(directory, directory.element);
}

export function registerActorDirectoryActivity() {
  Hooks.on("renderActorDirectory", markInactiveActors);
  Hooks.on("renderApplicationV2", (application, element) => {
    if (application?.constructor?.name !== "ActorDirectory" && application?.tabName !== "actors") return;
    markInactiveActors(application, element);
  });
  Hooks.on("updateActor", (_actor, changes) => {
    const activityPath = `flags.${MODULE_ID}.active`;
    if (!Object.hasOwn(changes, activityPath) && !foundry.utils.hasProperty(changes, activityPath)) return;
    queueMicrotask(markCurrentActorDirectory);
  });
}

export function activateActorDirectoryActivity() {
  queueMicrotask(markCurrentActorDirectory);
}
