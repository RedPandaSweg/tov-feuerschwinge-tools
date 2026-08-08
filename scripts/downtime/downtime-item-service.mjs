import { FLAGS, MODULE_ID } from "./constants.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { getQuantity, quantityUpdate, round } from "./utils.mjs";

const redeeming = new WeakSet();
const DESCRIPTION_START = "<!-- downtime-manager:item:start -->";
const DESCRIPTION_END = "<!-- downtime-manager:item:end -->";

function descriptionPath(item) {
  if (foundry.utils.hasProperty(item, "system.description.value")) return "system.description.value";
  if (typeof item?.system?.description === "string") return "system.description";
  return null;
}

function stripDescriptionBlock(value) {
  const text = String(value ?? "");
  const start = text.indexOf(DESCRIPTION_START);
  const end = text.indexOf(DESCRIPTION_END);
  if (start < 0 || end < start) return text;
  return `${text.slice(0, start)}${text.slice(end + DESCRIPTION_END.length)}`.trim();
}

export async function updateDowntimeItemDescription(item, amount = null) {
  const path = descriptionPath(item);
  if (!path) return false;
  const current = foundry.utils.getProperty(item, path);
  const base = stripDescriptionBlock(current);
  const block = amount === null
    ? ""
    : `${DESCRIPTION_START}<p><strong>${game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.DescriptionTitle")}</strong> ${Number(amount) === 0
      ? game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.DescriptionCurrent")
      : game.i18n.format("DOWNTIME_MANAGER.DowntimeItem.Description", { amount })}</p>${DESCRIPTION_END}`;
  await item.update({ [path]: [base, block].filter(Boolean).join("\n") });
  return true;
}

export function downtimeItemData(item) {
  const stored = item?.getFlag?.(MODULE_ID, FLAGS.DOWNTIME_ITEM);
  return stored?.enabled ? {
    enabled: true,
    amount: Math.max(0, Number(stored.amount) || 0),
    consume: stored.consume !== false,
    chatMessage: stored.chatMessage !== false
  } : null;
}

export class DowntimeItemService {
  static async redeem(item, { consume = null } = {}) {
    const config = downtimeItemData(item);
    const actor = item?.actor ?? (item?.parent?.documentName === "Actor" ? item.parent : null);
    if (!config || !actor) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Errors.EmbeddedRequired"));
    if (!item.isOwner || !actor.isOwner) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Errors.Permission"));
    if (!Number.isFinite(config.amount) || config.amount < 0) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Errors.Amount"));
    if (redeeming.has(item)) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Errors.Busy"));

    redeeming.add(item);
    let previousQuantity = null;
    try {
      if (config.amount === 0) {
        const current = DowntimeService.get(actor);
        if (config.chatMessage) {
          await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content: `<p>${game.i18n.format("DOWNTIME_MANAGER.DowntimeItem.CurrentChat", { actor: foundry.utils.escapeHTML(actor.name), amount: current })}</p>`
          }).catch(error => console.warn(`${MODULE_ID} | Downtime display chat message failed`, error));
        }
        ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.DowntimeItem.CurrentNotification", { actor: actor.name, amount: current }));
        return current;
      }
      const shouldConsume = consume ?? config.consume;
      if (shouldConsume) {
        previousQuantity = getQuantity(item);
        if (!Number.isFinite(previousQuantity) || previousQuantity < 1) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Errors.Empty"));
        await item.update(quantityUpdate(item, round(previousQuantity - 1, 6)));
      }
      const added = await DowntimeService.add(actor, config.amount);
      if (!added) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.DowntimeItem.Errors.Amount"));
      if (config.chatMessage) {
        await ChatMessage.create({
          speaker: ChatMessage.getSpeaker({ actor }),
          content: `<p>${game.i18n.format("DOWNTIME_MANAGER.DowntimeItem.Chat", { actor: foundry.utils.escapeHTML(actor.name), amount: config.amount })}</p>`
        }).catch(error => console.warn(`${MODULE_ID} | Downtime redemption chat message failed`, error));
      }
      ui.notifications.info(game.i18n.format("DOWNTIME_MANAGER.Notifications.DowntimeAdded", { actor: actor.name, amount: config.amount }));
      return config.amount;
    } catch (error) {
      if (previousQuantity !== null) await item.update(quantityUpdate(item, previousQuantity)).catch(() => {});
      throw error;
    } finally {
      redeeming.delete(item);
    }
  }
}
