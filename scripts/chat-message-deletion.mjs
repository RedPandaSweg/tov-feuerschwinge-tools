import { MODULE_ID } from "./core/constants.mjs";

const SOCKET_SCOPE = "chat-message-deletion";

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

  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("TOVF.ChatMessageDeletion.NoGM"));
    return;
  }

  game.socket.emit(`module.${MODULE_ID}`, {
    scope: SOCKET_SCOPE,
    type: "request",
    messageId,
    userId: game.user.id
  });
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
  if (message?.scope !== SOCKET_SCOPE || message.type !== "request") return;
  if (game.users.activeGM?.id !== game.user?.id) return;

  const requester = game.users.get(message.userId);
  const chatMessage = game.messages.get(message.messageId);
  if (!requester?.active || requester.isGM || !chatMessage) return;
  if (chatMessage.author?.id !== requester.id) {
    console.warn(`${MODULE_ID} | Rejected unauthorized chat-message deletion request.`, {
      messageId: message.messageId,
      userId: message.userId
    });
    return;
  }

  await chatMessage.delete();
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
