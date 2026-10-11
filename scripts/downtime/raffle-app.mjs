import { FLAGS, MODULE_ID } from "./constants.mjs";
import { isActiveCharacter, playerCharacters } from "./session-service.mjs";
import { RaffleService, raffleData, rafflePlayerForCharacter } from "./raffle-service.mjs?v=3.8.5-raffle-packages-2";
import { raffleBuy, raffleJoin, raffleLeave } from "./raffle-socket.mjs?v=3.8.5-raffle-withdraw-9";

const { ApplicationV2, HandlebarsApplicationMixin, DialogV2 } = foundry.applications.api;
const KIND_LABELS = { gold: "Gold", downtime: "Downtime", item: "Item", text: "Freitext" };
export class RaffleApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "tovf-raffle-{id}", classes: ["tovf-raffle"], position: { width: 790, height: "auto" },
    window: { title: "Feuerschwinge – Raffle", icon: "fa-solid fa-ticket", resizable: true },
    actions: {
      join: this.#join, leave: this.#leave, buy: this.#buy, draw: this.#draw, save: this.#save,
      addPrize: this.#addPrize, removePrize: this.#removePrize, addReward: this.#addReward, removeReward: this.#removeReward,
      addParticipant: this.#addParticipant, removeParticipant: this.#removeParticipant,
      startNew: this.#startNew
    }
  };
  static PARTS = { main: { template: "modules/tov-feuerschwinge-tools/templates/downtime/raffle.hbs" } };

  constructor(actor, options = {}) {
    super({ ...options, id: `tovf-raffle-${actor.id}` });
    this.actor = actor;
    this._hook = Hooks.on("updateActor", actor => { if (actor.id === this.actor.id && this.rendered) this.#renderPreservingView(); });
  }
  async close(options) { Hooks.off("updateActor", this._hook); return super.close(options); }

  async _prepareContext() {
    const raffle = raffleData(this.actor);
    const actors = playerCharacters().filter(isActiveCharacter);
    const mine = raffle.entries.find(entry => entry.userId === game.user.id);
    const open = raffle.enabled && raffle.status === "open";
    const joinedCharacters = new Set(raffle.entries.map(entry => entry.characterUuid));
    const joinedUsers = new Set(raffle.entries.map(entry => entry.userId).filter(Boolean));
    const available = actors.filter(actor => {
      if (joinedCharacters.has(actor.uuid)) return false;
      const user = rafflePlayerForCharacter(actor);
      return raffle.participationScope !== "player" || !user || !joinedUsers.has(user.id);
    });
    return {
      raffle, gm: game.user.isGM, actor: this.actor, mine,
      characters: available.filter(actor => actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)).map(actor => ({ uuid: actor.uuid, name: actor.name })),
      participantCharacters: available.map(actor => { const user = rafflePlayerForCharacter(actor); return { uuid: actor.uuid, name: actor.name, playerName: user?.name ?? "kein Spieler zugeordnet" }; }),
      canJoin: open && !mine, canBuy: open && Number(raffle.ticketPrice) > 0,
      canDraw: open && raffle.entries.length > 0,
      prizeRows: raffle.prizes.map((prize, index) => ({
        ...prize,
        index,
        categoryValue: prize.category === "Nebenpreis" ? "" : prize.category,
        displayName: prize.name || prize.category,
        featured: prize.category.trim().toLocaleLowerCase() === "hauptgewinn",
        exhausted: prize.remaining <= 0,
        rewards: prize.rewards.map((reward, rewardIndex) => ({
          ...reward,
          rewardIndex,
          kindLabel: KIND_LABELS[reward.kind] ?? "Preis",
          displayName: reward.name || ({ gold: `${reward.amount} Gold`, downtime: `${reward.amount} Downtime`, item: "Item", text: "Sachpreis" }[reward.kind])
        }))
      }))
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this.element.addEventListener("dragover", event => { if (event.target.closest("[data-item-drop]")) event.preventDefault(); });
    this.element.addEventListener("drop", event => this.#dropItem(event));
  }

  static async #join(event) { event.preventDefault(); try { const character = await fromUuid(this.element.querySelector('[name="character"]')?.value).catch(() => null); await raffleJoin({ actor: this.actor, character }); ui.notifications.info("Du nimmst an der Verlosung teil."); } catch (error) { ui.notifications.error(error.message); } }
  static async #leave(event) { event.preventDefault(); try { const character = await fromUuid(this.element.querySelector('[name="joinedCharacter"]')?.value).catch(() => null); await raffleLeave({ actor: this.actor, character }); ui.notifications.info("Deine Teilnahme wurde zurückgezogen."); } catch (error) { ui.notifications.error(error.message); } }
  static async #buy(event) { event.preventDefault(); try { const character = await fromUuid(this.element.querySelector('[name="character"]')?.value).catch(() => null); await raffleBuy({ actor: this.actor, character, quantity: this.element.querySelector('[name="quantity"]')?.value }); } catch (error) { ui.notifications.error(error.message); } }
  static async #draw(event, target) { event.preventDefault(); try { const result = await RaffleService.draw(this.actor, target.dataset.prizeId); ui.notifications.info(`${result.winner.characterName} gewinnt ${result.prize}.`); } catch (error) { ui.notifications.error(error.message); } }
  static async #addPrize(event) { event.preventDefault(); const data = this.#readForm(); data.prizes.push({ id: foundry.utils.randomID(), category: "Nebenpreis", name: "", quantity: 1, remaining: 1, rewards: [{ id: foundry.utils.randomID(), kind: "text", amount: 1, uuid: "", name: "", img: "" }] }); await RaffleService.save(this.actor, data); }
  static async #removePrize(event, target) { event.preventDefault(); const data = this.#readForm(); data.prizes.splice(Number(target.dataset.index), 1); await RaffleService.save(this.actor, data); }
  static async #addReward(event, target) { event.preventDefault(); const data = this.#readForm(); const prize = data.prizes.find(entry => entry.id === target.dataset.prizeId); prize?.rewards.push({ id: foundry.utils.randomID(), kind: "text", amount: 1, uuid: "", name: "", img: "" }); await RaffleService.save(this.actor, data); }
  static async #removeReward(event, target) { event.preventDefault(); const data = this.#readForm(); const prize = data.prizes.find(entry => entry.id === target.dataset.prizeId); if (prize && prize.rewards.length > 1) prize.rewards.splice(Number(target.dataset.rewardIndex), 1); await RaffleService.save(this.actor, data); }
  static async #addParticipant(event) { event.preventDefault(); try { const character = await fromUuid(this.element.querySelector('[name="participant"]')?.value).catch(() => null); await RaffleService.addParticipant(this.actor, character); } catch (error) { ui.notifications.error(error.message); } }
  static async #removeParticipant(event, target) { event.preventDefault(); await RaffleService.removeParticipant(this.actor, target.dataset.uuid); }
  static async #startNew(event) {
    event.preventDefault();
    const confirmed = await DialogV2.confirm({ window: { title: "Neue Verlosung starten" }, content: "<p>Teilnehmende und Ziehungshistorie werden geleert. Konfiguration und Preise bleiben erhalten.</p>" });
    if (confirmed) await RaffleService.startNew(this.actor);
  }
  static async #save(event) {
    event.preventDefault(); if (!game.user.isGM) return; const data = this.#readForm();
    await RaffleService.save(this.actor, data); ui.notifications.info("Verlosung gespeichert.");
  }
  #readForm() {
    const root = this.element; const data = raffleData(this.actor); const old = new Map(data.prizes.map(prize => [prize.id, prize]));
    Object.assign(data, {
      enabled: root.querySelector('[name="enabled"]').checked,
      title: root.querySelector('[name="title"]').value.trim() || this.actor.name,
      description: root.querySelector('[name="description"]').value,
      ticketPrice: Math.max(0, Number(root.querySelector('[name="ticketPrice"]').value) || 0),
      currency: root.querySelector('[name="currency"]').value,
      limit: Math.max(0, Math.floor(Number(root.querySelector('[name="limit"]').value) || 0)),
      participationScope: root.querySelector('[name="participationScope"]').value,
      allowRepeatWinners: root.querySelector('[name="allowRepeatWinners"]').checked
    });
    data.prizes = [...root.querySelectorAll('[data-prize]')].map(row => {
      const id = row.dataset.prizeId || foundry.utils.randomID(); const previous = old.get(id);
      const quantity = Math.max(1, Math.floor(Number(row.querySelector('[name="prizeQuantity"]').value) || 1));
      const alreadyDrawn = previous ? Math.max(0, previous.quantity - previous.remaining) : 0;
      const rewards = [...row.querySelectorAll('[data-reward]')].map(reward => ({
        id: reward.dataset.rewardId || foundry.utils.randomID(),
        kind: reward.querySelector('[name="kind"]').value,
        amount: Math.max(1, Math.floor(Number(reward.querySelector('[name="amount"]').value) || 1)),
        name: reward.querySelector('[name="rewardName"]').value.trim(),
        uuid: reward.querySelector('[name="uuid"]').value.trim(),
        img: reward.querySelector('[name="itemImg"]').value.trim()
      }));
      return { id, category: row.querySelector('[name="category"]').value.trim() || "Nebenpreis", name: row.querySelector('[name="packageName"]').value.trim(), quantity, remaining: Math.max(0, quantity - alreadyDrawn), rewards };
    });
    return data;
  }
  async #dropItem(event) {
    const zone = event.target.closest("[data-item-drop]"); if (!zone) return;
    event.preventDefault();
    try {
      const dragData = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
      const item = dragData.uuid ? await fromUuid(dragData.uuid) : null;
      if (item?.documentName !== "Item") throw new Error("Bitte ein Item aus einem Kompendium oder Verzeichnis hineinziehen.");
      const reward = zone.closest("[data-reward]");
      reward.querySelector('[name="uuid"]').value = item.uuid;
      reward.querySelector('[name="itemImg"]').value = item.img ?? "";
      const name = reward.querySelector('[name="rewardName"]'); if (!name.value.trim()) name.value = item.name;
      const kind = reward.querySelector('[name="kind"]'); kind.value = "item";
      zone.classList.add("has-item");
      zone.querySelector("img").src = item.img || CONST.DEFAULT_TOKEN;
      zone.querySelector("span").textContent = item.name;
    } catch (error) { ui.notifications.error(error.message); }
  }
  async #renderPreservingView() {
    const content = this.element.closest?.(".window-content") ?? this.element; const scrollTop = content?.scrollTop ?? 0;
    await this.render({ force: true });
    const updated = this.element.closest?.(".window-content") ?? this.element; if (updated) updated.scrollTop = scrollTop;
  }
}

export async function configureRaffle(actor) {
  if (!actor.getFlag(MODULE_ID, FLAGS.RAFFLE)) await actor.setFlag(MODULE_ID, FLAGS.RAFFLE, raffleData());
  new RaffleApp(actor).render(true);
}
