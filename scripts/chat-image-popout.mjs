const EXCLUDED_IMAGE_CONTAINERS = [
  ".message-header",
  ".chat-card",
  ".dice-roll",
  ".item-piles-chat-card",
  ".table-draw",
  ".card-tray"
].join(", ");

function chatMessageRoot(html) {
  if (html instanceof HTMLElement) return html;
  return html?.[0] instanceof HTMLElement ? html[0] : null;
}

function imageTitle(image, message) {
  return image.getAttribute("alt")?.trim()
    || image.getAttribute("title")?.trim()
    || message?.speaker?.alias
    || message?.author?.name
    || "Chat Image";
}

function openChatImage(image, message) {
  const src = image.currentSrc || image.getAttribute("src");
  if (!src) return;
  new foundry.applications.apps.ImagePopout({
    src,
    window: { title: imageTitle(image, message) }
  }).render({ force: true });
}

function activateChatImages(message, html) {
  const root = chatMessageRoot(html);
  if (!root) return;
  for (const image of root.querySelectorAll(".message-content img")) {
    if (image.dataset.tovfChatImage === "true" || image.closest(EXCLUDED_IMAGE_CONTAINERS)) continue;
    image.dataset.tovfChatImage = "true";
    image.tabIndex = 0;
    image.setAttribute("role", "button");
    image.setAttribute("aria-label", imageTitle(image, message));
    image.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openChatImage(image, message);
    });
    image.addEventListener("keydown", event => {
      if (!["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      openChatImage(image, message);
    });
  }
}

export function installChatImagePopouts() {
  Hooks.on("renderChatMessageHTML", activateChatImages);
}
