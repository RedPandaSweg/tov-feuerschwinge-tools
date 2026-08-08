import { FLAGS, MODULE_ID } from "./constants.mjs";
import { getSystemAdapter } from "./system-adapter.mjs";
import {
  getQuantity,
  quantityUpdate,
  round,
  sourceUuid
} from "./utils.mjs";

function stableIdentifier(item) {
  return String(
    item?.system?.identifier?.value ??
    item?.system?.identifier ??
    item?.system?.slug ??
    ""
  ).trim().toLowerCase();
}

export class RewardService {
  static #stationValueBucket(values, stationActor) {
    return values?.[stationActor.id]
      ?? values?.[stationActor.uuid]
      ?? values?.Actor?.[stationActor.id]
      ?? null;
  }

  static async validateItems(rewards) {
    for (const reward of rewards ?? []) {
      const source = reward.uuid ? await fromUuid(reward.uuid) : null;
      if (!source || source.documentName !== "Item") {
        throw new Error(game.i18n.format("DOWNTIME_MANAGER.Errors.RewardMissing", {
          uuid: reward.uuid ?? "?"
        }));
      }
    }
  }

  static validateCharacterRewards(rewards) {
    if (!(rewards ?? []).length) return;
    const adapter = getSystemAdapter();
    if (!adapter.capabilities.characterRewards) throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CharacterRewardsUnsupported"));
    const options = adapter.getCharacterRewardOptions();
    for (const reward of rewards) {
      if (!(options[reward.type] ?? []).some(option => option.key === reward.key)) {
        throw new Error(game.i18n.localize("DOWNTIME_MANAGER.Errors.CharacterRewardInvalid"));
      }
    }
  }

  static async grantCharacterRewards(actor, rewards) {
    this.validateCharacterRewards(rewards);
    const adapter = getSystemAdapter();
    const options = adapter.getCharacterRewardOptions();
    const granted = [];
    for (const reward of rewards ?? []) {
      const changed = await adapter.grantCharacterReward(actor, reward);
      const label = options[reward.type]?.find(option => option.key === reward.key)?.label ?? reward.key;
      granted.push({ type: reward.type, key: reward.key, label, rank: Number(reward.rank) || 1, changed });
    }
    return granted;
  }

  static getStationValue(actor, stationActor, station) {
    if (!station.actorValue?.enabled) return 0;
    const values = actor.getFlag(MODULE_ID, FLAGS.STATION_VALUES) ?? {};
    const stored = station.actorValue.scope === "category"
      ? values.categoryValues?.[station.actorValue.category]
      : this.#stationValueBucket(values, stationActor)?.[station.actorValue?.key];
    return Number.isFinite(Number(stored))
      ? Number(stored)
      : Number(station.actorValue?.defaultValue ?? 0);
  }

  static async changeStationValue(actor, stationActor, station, change) {
    if (!station.actorValue?.enabled) return 0;
    const values = foundry.utils.deepClone(
      actor.getFlag(MODULE_ID, FLAGS.STATION_VALUES) ?? {}
    );
    const current = this.getStationValue(actor, stationActor, station);
    let next = current + Number(change ?? 0);
    const minimum = station.actorValue?.minimum;
    const maximum = station.actorValue?.maximum;
    if (minimum !== null && minimum !== "" && Number.isFinite(Number(minimum))) {
      next = Math.max(Number(minimum), next);
    }
    if (maximum !== null && maximum !== "" && Number.isFinite(Number(maximum))) {
      next = Math.min(Number(maximum), next);
    }
    if (station.actorValue.scope === "category") {
      values.categoryValues = { ...(values.categoryValues ?? {}) };
      values.categoryValues[station.actorValue.category] = round(next, 6);
    } else {
      const existing = this.#stationValueBucket(values, stationActor) ?? {};
      values[stationActor.id] = { ...existing };
      delete values[stationActor.uuid];
      if (values.Actor?.[stationActor.id]) {
        delete values.Actor[stationActor.id];
        if (!Object.keys(values.Actor).length) delete values.Actor;
      }
      values[stationActor.id][station.actorValue.key] = round(next, 6);
    }
    await actor.setFlag(MODULE_ID, FLAGS.STATION_VALUES, values);
    return station.actorValue.scope === "category"
      ? values.categoryValues[station.actorValue.category]
      : values[stationActor.id][station.actorValue.key];
  }

  static async grantItems(actor, rewards) {
    await this.validateItems(rewards);
    const created = [];
    for (const reward of rewards ?? []) {
      const quantity = Number(reward.quantity ?? 1);
      if (!reward.uuid || !Number.isFinite(quantity) || quantity <= 0) continue;
      const source = await fromUuid(reward.uuid);
      if (!source || source.documentName !== "Item") {
        throw new Error(game.i18n.format("DOWNTIME_MANAGER.Errors.RewardMissing", { uuid: reward.uuid }));
      }
      const wantedUuid = String(reward.uuid).toLowerCase();
      const wantedIdentifier = stableIdentifier(source);
      const existing = actor.items.find(item => {
        if (item.type !== source.type) return false;
        const itemSource = String(sourceUuid(item)).toLowerCase();
        const rewardSource = String(
          item.getFlag?.(MODULE_ID, "rewardSourceUuid") ?? ""
        ).toLowerCase();
        if (
          (itemSource && itemSource === wantedUuid) ||
          (rewardSource && rewardSource === wantedUuid)
        ) return true;
        const identifier = stableIdentifier(item);
        return Boolean(
          wantedIdentifier && identifier === wantedIdentifier
        );
      });
      if (existing) {
        await existing.update(quantityUpdate(existing, round(getQuantity(existing) + quantity, 6)));
        created.push(existing.name);
        continue;
      }
      const data = source.toObject();
      delete data._id;
      foundry.utils.setProperty(
        data,
        `flags.${MODULE_ID}.rewardSourceUuid`,
        reward.uuid
      );
      if (foundry.utils.hasProperty(data, "system.quantity.value")) {
        data.system.quantity.value = quantity;
      } else {
        data.system.quantity = quantity;
      }
      const documents = await actor.createEmbeddedDocuments("Item", [data]);
      created.push(documents[0]?.name ?? source.name);
    }
    return created;
  }
}
