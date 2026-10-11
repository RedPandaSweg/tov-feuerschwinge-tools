const PATCH_FLAG = "__tovfSpellLearningPersistence";

/**
 * Preserve unchanged Actor Spells when submitting Black Flag's spell manager.
 * Black Flag stores selections as `{ slot, slotNumber }` but compares `.type`,
 * causing unchanged embedded Items to be deleted and recreated.
 */
export function installSpellLearningPersistence() {
  const Dialog = BlackFlag?.applications?.advancement?.SpellcastingDialog;
  const actions = Dialog?.DEFAULT_OPTIONS?.actions;
  const originalLearn = actions?.learn;
  if (typeof originalLearn !== "function") {
    return { status: "incompatible", reason: "Missing BlackFlag SpellcastingDialog.actions.learn." };
  }
  if (originalLearn[PATCH_FLAG]) return { status: "already-installed" };

  async function learnSpells(event, target) {
    const toAdd = new Map();
    const toRemove = new Set();
    const visibleSlots = new Set();
    let replacement;

    for (const slot of this.slots) {
      visibleSlots.add(slot.type);
      if (!slot.selected) continue;
      if (slot.type === "replacement") {
        replacement = { original: slot.replaces, replacement: slot.selected };
      } else {
        toAdd.set(slot.selected, { slot: slot.type, slotNumber: slot.number });
      }
    }

    for (const spell of this.advancement._getAddedSpells(this.levels)) {
      if (!visibleSlots.has(spell.slot) || spell.slot === "replacement") continue;
      if (toAdd.get(spell.uuid)?.slot === spell.slot) toAdd.delete(spell.uuid);
      else toRemove.add(spell.document);
    }

    await this.close();
    if (toRemove.size) await this.advancement.reverse(this.levels, { deleteIds: toRemove });
    if (toAdd.size || replacement) {
      await this.advancement.apply(this.levels, {
        added: Array.from(toAdd.entries()).map(([uuid, { slot, slotNumber }]) => ({ uuid, slot, slotNumber })),
        replacement
      });
    }
  }

  Object.defineProperty(learnSpells, PATCH_FLAG, { value: true });
  actions.learn = learnSpells;
  return { status: "completed" };
}
