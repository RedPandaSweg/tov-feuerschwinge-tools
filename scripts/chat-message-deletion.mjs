import { MODULE_ID } from "./core/constants.mjs";

const SOCKET_SCOPE = "chat-message-deletion";
const pending = new Map();

function activeGM() {
  const connected = game.users.filter(user => user.active && user.isGM);
  const isBot = user => /\[bot\]/i.test(String(user.name ?? "")) || user.getFlag?.(MODULE_ID, "serviceBot") === true;
  return connected.find(user => !isBot(user) && user.viewedScene)
    ?? connected.find(user => !isBot(user))
    ?? connected.find(user => user.viewedScene)
    ?? connected[0]
    ?? null;
}

function messageIdFrom(element) {
  return element?.dataset?.messageId ?? element?.closest?.("[data-message-id]")?.dataset?.messageId ?? "";
}

function isOwnMessage(element) {
  if (game.user?.isGM) return false;
  const message = game.messages.get(messageIdFrom(element));
  return message?.author?.id === game.user?.id;
}

async function requestDeletion(_event, element) {
  const messageId = messageIdFrom(element);
  const message = game.messages.get(messageId);
  if (!message || message.author?.id !== game.user?.id) return;

  const confirmed = await foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("TOVF.ChatMessageDeletion.Title") },
    content: `<p>${game.i18n.localize("TOVF.ChatMessageDeletion.Confirm")}</p>`
  });
  if (!confirmed) return;

  const gm = activeGM();
  if (!gm) {
    ui.notifications.warn(game.i18n.localize("TOVF.ChatMessageDeletion.NoGM"));
    return;
  }

  const requestId = foundry.utils.randomID();
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(game.i18n.localize("TOVF.ChatMessageDeletion.Timeout")));
    }, 12000);
    pending.set(requestId, {
      resolve: value => { clearTimeout(timeout); resolve(value); },
      reject: error => { clearTimeout(timeout); reject(error); }
    });
  });
  game.socket.emit(`module.${MODULE_ID}`, {
    scope: SOCKET_SCOPE,
    type: "request",
    requestId,
    targetGMId: gm.id,
    messageId,
    userId: game.user.id
  });
  try {
    await result;
  } catch (error) {
    ui.notifications.error(error?.message ?? game.i18n.localize("TOVF.ChatMessageDeletion.Failed"));
  }
}

function addContextOption(_html, options) {
  if (game.user?.isGM) return;
  options.push({
    label: "TOVF.ChatMessageDeletion.Action",
    icon: "fa-solid fa-trash",
    visible: isOwnMessage,
    onClick: requestDeletion
  });
}

function addDeleteButton(message, html) {
  if (game.user?.isGM || message?.author?.id !== game.user?.id) return;
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root || root.querySelector("[data-tovf-delete-own-message]")) return;
  const header = root.querySelector(".message-header");
  if (!header) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "tovf-delete-own-message";
  button.dataset.tovfDeleteOwnMessage = "";
  button.title = game.i18n.localize("TOVF.ChatMessageDeletion.Action");
  button.setAttribute("aria-label", button.title);
  button.innerHTML = '<i class="fa-solid fa-trash" inert></i>';
  button.addEventListener("click", event => requestDeletion(event, root));
  header.append(button);
}

async function handleSocket(message) {
  if (message?.scope !== SOCKET_SCOPE) return;
  if (message.type === "response") {
    if (message.targetUserId !== game.user?.id) return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    pending.delete(message.requestId);
    if (message.error) entry.reject(new Error(message.error));
    else entry.resolve(true);
    return;
  }
  if (message.type !== "request" || message.targetGMId !== game.user?.id || !game.user?.isGM) return;

  const requester = game.users.get(message.userId);
  const chatMessage = game.messages.get(message.messageId);
  let error = "";
  if (!requester?.active || requester.isGM || !chatMessage || chatMessage.author?.id !== requester?.id) {
    error = game.i18n.localize("TOVF.ChatMessageDeletion.Rejected");
  } else {
    try {
      await chatMessage.delete();
    } catch (caught) {
      error = caught?.message ?? game.i18n.localize("TOVF.ChatMessageDeletion.Failed");
    }
  }
  game.socket.emit(`module.${MODULE_ID}`, {
    scope: SOCKET_SCOPE,
    type: "response",
    requestId: message.requestId,
    targetUserId: message.userId,
    ...(error ? { error } : { result: true })
  });
}

export function registerChatMessageDeletion() {
  Hooks.on("getChatMessageContextOptions", addContextOption);
  Hooks.on("renderChatMessageHTML", addDeleteButton);
  Hooks.once("ready", () => game.socket.on(`module.${MODULE_ID}`, socketMessage => {
    void handleSocket(socketMessage).catch(error => {
      console.error(`${MODULE_ID} | Deleting an author's chat message failed.`, error);
    });
  }));
}
