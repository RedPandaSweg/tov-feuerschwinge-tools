function formatChatTimestamp(timestamp) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - Number(timestamp)) / 1000));
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 60) {
    return game.i18n.localize("TOVF.Chat.Timestamp.JustNow");
  }
  const formatter = new Intl.RelativeTimeFormat(game.i18n.lang, { numeric: "always", style: "narrow" });
  if (elapsedSeconds < 3600) return formatter.format(-Math.floor(elapsedSeconds / 60), "minute");
  if (elapsedSeconds < 86400) return formatter.format(-Math.floor(elapsedSeconds / 3600), "hour");
  if (elapsedSeconds < 2592000) return formatter.format(-Math.floor(elapsedSeconds / 86400), "day");
  if (elapsedSeconds < 31536000) return formatter.format(-Math.floor(elapsedSeconds / 2592000), "month");
  return formatter.format(-Math.floor(elapsedSeconds / 31536000), "year");
}

function updateTimestamp(element, message = null) {
  const candidate = element instanceof HTMLElement ? element : element?.[0];
  const root = candidate?.closest?.(".chat-message[data-message-id]") ?? candidate;
  const timestamp = root?.querySelector?.(".message-timestamp");
  const document = message ?? game.messages.get(root?.dataset?.messageId);
  if (!timestamp || !document?.timestamp) return;
  const value = formatChatTimestamp(document.timestamp);
  if (timestamp.textContent !== value) timestamp.textContent = value;
}

export function installChatTimestamps() {
  Hooks.on("renderChatMessageHTML", (message, html) => updateTimestamp(html, message));

  Hooks.once("ready", () => {
    for (const message of document.querySelectorAll(".chat-message[data-message-id]")) updateTimestamp(message);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const timestamp = record.target.nodeType === Node.TEXT_NODE
          ? record.target.parentElement?.closest?.(".message-timestamp")
          : record.target.closest?.(".message-timestamp");
        if (timestamp) updateTimestamp(timestamp);
        for (const node of record.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches?.(".chat-message[data-message-id]")) updateTimestamp(node);
          for (const message of node.querySelectorAll?.(".chat-message[data-message-id]") ?? []) updateTimestamp(message);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  });
}
