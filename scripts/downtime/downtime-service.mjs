import { MODULE_ID, FLAGS } from "./constants.mjs";
import { round } from "./utils.mjs";

export class DowntimeService {
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
