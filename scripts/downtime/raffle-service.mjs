import { FLAGS, MODULE_ID } from "./constants.mjs";
import { GoldService } from "./gold-service.mjs";
import { DowntimeService } from "./downtime-service.mjs";
import { RewardService } from "./reward-service.mjs";

const copy = value => foundry.utils.deepClone(value);
const now = () => Date.now();
const identity = character => `character:${character.uuid}`;
export const defaultRaffle = () => ({ enabled: true, title: "Neue Verlosung", description: "", ticketPrice: 0, currency: "gold", limit: 1, closesAt: "", status: "open", participationScope: "character", allowRepeatWinners: false, prizes: [], entries: [], history: [] });

function normalizeReward(reward, index) {
  return {
    ...reward,
    id: reward.id || `reward-${index}`,
    kind: reward.kind || "text",
    amount: Math.max(1, Number(reward.amount) || 1),
    name: String(reward.name ?? ""),
    uuid: String(reward.uuid ?? ""),
    img: String(reward.img ?? "")
  };
}

function normalizePrize(prize, status, index) {
  const legacy = !Array.isArray(prize.rewards);
  const legacyAmount = Math.max(1, Number(prize.amount ?? prize.quantity) || 1);
  const quantity = legacy && !prize.id ? 1 : Math.max(1, Number(prize.quantity) || 1);
  return {
    ...prize,
    id: prize.id || `legacy-prize-${index}`,
    category: String(prize.category || "Nebenpreis"),
    name: String(prize.packageName ?? prize.name ?? ""),
    quantity,
    remaining: Math.max(0, Number(prize.remaining ?? (status === "drawn" ? 0 : quantity)) || 0),
    rewards: (legacy ? [{
      id: `legacy-reward-${index}`,
      kind: prize.kind || "text",
      amount: prize.kind === "text" ? 1 : legacyAmount,
      name: prize.name ?? "",
      uuid: prize.uuid ?? "",
      img: prize.img ?? ""
    }] : prize.rewards).map(normalizeReward)
  };
}
export function raffleData(actor) {
  const data = foundry.utils.mergeObject(defaultRaffle(), actor?.getFlag(MODULE_ID, FLAGS.RAFFLE) ?? {}, { inplace: false, recursive: true });
  data.prizes = data.prizes.map((prize, index) => normalizePrize(prize, data.status, index));
  data.entries = data.entries.map(entry => {
    if (entry.userId && entry.playerName) return entry;
    const character = globalThis.fromUuidSync?.(entry.characterUuid) ?? game.actors.get(String(entry.characterUuid).split(".").at(-1));
    const user = character ? rafflePlayerForCharacter(character) : null;
    return { ...entry, userId: entry.userId || user?.id || "", playerName: entry.playerName || user?.name || "" };
  });
  return data;
}
export const isRaffle = actor => Boolean(actor?.getFlag?.(MODULE_ID, FLAGS.RAFFLE));
const participant = (data, character) => data.entries.find(entry => entry.characterUuid === character.uuid);
export function rafflePlayerForCharacter(character) {
  const ownership = character._source?.ownership ?? character.ownership ?? {};
  const owners = Object.entries(ownership)
    .filter(([userId, level]) => userId !== "default" && Number(level) >= CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)
    .map(([userId]) => game.users.get(userId))
    .filter(Boolean);
  if (owners.length === 1) return owners[0];
  return game.users.find(user => user.character?.uuid === character.uuid
    || String(user.character?.id ?? user.character ?? "") === character.id) ?? null;
}
const playerForCharacter = rafflePlayerForCharacter;
function assertParticipantAvailable(data, character, user) {
  if (participant(data, character)) throw new Error("Dieser Charakter nimmt bereits teil.");
  if (data.participationScope !== "player") return;
  const playerId = user?.isGM ? rafflePlayerForCharacter(character)?.id : user?.id;
  if (playerId && data.entries.some(entry => entry.userId === playerId)) throw new Error("Dieser Spieler nimmt bereits mit einem anderen Charakter teil.");
}
function assertOpen(data) { if (!data.enabled || data.status !== "open") throw new Error("Diese Verlosung ist derzeit nicht geöffnet."); }

export class RaffleService {
  static async save(actor, data) { await actor.setFlag(MODULE_ID, FLAGS.RAFFLE, copy(data)); return data; }
  static async leave(actor, character, user = game.user) { const data = raffleData(actor); assertOpen(data); if (!character?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Du darfst diese Teilnahme nicht zurückziehen."); const before = data.entries.length; data.entries = data.entries.filter(entry => entry.characterUuid !== character.uuid || entry.userId !== user.id); if (data.entries.length === before) throw new Error("Für diesen Charakter wurde keine eigene Teilnahme gefunden."); return this.save(actor, data); }
  static async join(actor, character, user = game.user) { const data = raffleData(actor); assertOpen(data); if (!character?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Wähle einen eigenen Charakter."); assertParticipantAvailable(data, character, user); data.entries.push({ identity: identity(character), userId: user.id, playerName: user.name, characterUuid: character.uuid, characterName: character.name, tickets: 1, joinedAt: now() }); return this.save(actor, data); }
  static async addParticipant(actor, character) { const data = raffleData(actor); if (!game.user.isGM || !character) throw new Error("Wähle einen Charakter."); const user = playerForCharacter(character); assertParticipantAvailable(data, character, user); data.entries.push({ identity: identity(character), userId: user?.id ?? "", playerName: user?.name ?? "", characterUuid: character.uuid, characterName: character.name, tickets: 1, joinedAt: now() }); return this.save(actor, data); }
  static async removeParticipant(actor, uuid) { const data = raffleData(actor); if (!game.user.isGM) throw new Error("Nur die Spielleitung kann Teilnehmende entfernen."); data.entries = data.entries.filter(entry => entry.characterUuid !== uuid); return this.save(actor, data); }
  static async buy(actor, character, quantity, user = game.user) { const data = raffleData(actor); assertOpen(data); if (!character?.testUserPermission?.(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) throw new Error("Wähle einen eigenen Charakter."); quantity = Math.max(1, Math.floor(Number(quantity) || 1)); const entry = participant(data, character); if (!entry) assertParticipantAvailable(data, character, user); const held = Number(entry?.tickets ?? 0); if (data.limit > 0 && held + quantity > data.limit) throw new Error("Das Loslimit ist erreicht."); const cost = data.ticketPrice * quantity; const paid = data.currency === "downtime" ? await DowntimeService.spend(character, cost) : await GoldService.spendGold(character, cost); if (!paid) throw new Error("Nicht genügend Guthaben."); if (entry) entry.tickets += quantity; else data.entries.push({ identity: identity(character), userId: user.id, playerName: user.name, characterUuid: character.uuid, characterName: character.name, tickets: quantity, joinedAt: now() }); return this.save(actor, data); }
  static async draw(actor, prizeId) {
    const data = raffleData(actor); if (!game.user.isGM) throw new Error("Nur die Spielleitung kann ziehen."); assertOpen(data);
    const prize = data.prizes.find(entry => entry.id === prizeId && entry.remaining > 0); if (!prize) throw new Error("Dieser Preis ist nicht mehr verfügbar.");
    const previous = new Set(data.history.map(entry => entry.winner.characterUuid));
    const eligible = data.entries.filter(entry => data.allowRepeatWinners || !previous.has(entry.characterUuid));
    const pool = eligible.flatMap(entry => Array.from({ length: Math.max(1, Number(entry.tickets) || 1) }, () => entry)); if (!pool.length) throw new Error("Es gibt keine berechtigten Teilnehmenden mehr.");
    const winner = pool[Math.floor(Math.random() * pool.length)]; const character = await fromUuid(winner.characterUuid);
    const labels = [];
    for (const reward of prize.rewards) {
      if (reward.kind === "gold") await GoldService.addGold(character, reward.amount);
      else if (reward.kind === "downtime") await DowntimeService.add(character, reward.amount);
      else if (reward.kind === "item") {
        if (!reward.uuid) throw new Error("Für einen Item-Preis wurde kein Item ausgewählt.");
        await RewardService.grantItems(character, [{ uuid: reward.uuid, quantity: reward.amount }]);
      }
      labels.push(reward.name || ({ gold: `${reward.amount} Gold`, downtime: `${reward.amount} Downtime`, item: reward.uuid, text: "Sachpreis" }[reward.kind]));
    }
    const label = prize.name || labels.filter(Boolean).join(", ") || prize.category;
    prize.remaining -= 1; data.history.unshift({ id: foundry.utils.randomID(), at: now(), winner: copy(winner), prizeId: prize.id, prize: label, rewards: labels });
    if (!data.prizes.some(entry => entry.remaining > 0)) data.status = "drawn";
    await this.save(actor, data); return { winner, prize: label };
  }
  static async startNew(actor) { const data = raffleData(actor); if (!game.user.isGM) throw new Error("Nur die Spielleitung kann eine neue Verlosung starten."); data.entries = []; data.history = []; data.status = "open"; data.ticketPrice = 0; data.prizes = data.prizes.map(prize => ({ ...prize, remaining: prize.quantity })); return this.save(actor, data); }
}
