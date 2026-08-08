import { getSystemAdapter } from "./system-adapter.mjs";

export class GoldService {
  static getCopper(actor) { return Math.round(getSystemAdapter().getGold(actor) * 100); }
  static getGold(actor) { return getSystemAdapter().getGold(actor); }
  static async spendGold(actor, gold) { return getSystemAdapter().spendGold(actor, gold); }
  static async addGold(actor, gold) { return getSystemAdapter().addGold(actor, gold); }
}
