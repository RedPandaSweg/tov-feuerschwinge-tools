import { MODULE_ID, FLAGS } from "./constants.mjs";
import { round } from "./utils.mjs";

export class DowntimeService {
  static #investmentQueues = new Map();

  /** Serialize station investments for one actor on this client. */
  static async runInvestment(actor, operation) {
    const key = String(actor?.uuid ?? actor?.id ?? "");
    if (!key) return operation();

    const previous = this.#investmentQueues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(operation);
    this.#investmentQueues.set(key, current);

    try {
      return await current;
    } finally {
      if (this.#investmentQueues.get(key) === current) {
        this.#investmentQueues.delete(key);
      }
    }
  }

  static get(actor) {
    return round(
      Number(actor.getFlag(MODULE_ID, FLAGS.DOWNTIME) ?? 0),
      6
    );
  }

  static async add(actor, amount) {
    const value = round(Number(amount), 6);

    if (!Number.isFinite(value) || value <= 0) {
      return false;
    }

    const current = this.get(actor);

    await actor.setFlag(
      MODULE_ID,
      FLAGS.DOWNTIME,
      round(current + value, 6)
    );

    return true;
  }

  static async spend(actor, amount) {
    const value = round(Number(amount), 6);

    if (!Number.isFinite(value) || value <= 0) {
      return false;
    }

    const current = this.get(actor);

    if (current + 1e-9 < value) {
      return false;
    }

    await actor.setFlag(
      MODULE_ID,
      FLAGS.DOWNTIME,
      round(current - value, 6)
    );

    return true;
  }
}
