const PATCH_FLAG = "__tovfToolProficiencyRemoval";

/**
 * Black Flag 3.0.078 routes the selector change through a complete form
 * submission. In Foundry v14 that submission can reapply the selector's old
 * form value after the removal update. Update only the changed proficiency
 * collection directly instead.
 */
export function installToolProficiencyRemoval() {
  const ToolConfig = BlackFlag?.applications?.actor?.ToolConfig;
  const original = ToolConfig?.prototype?._onChangeTools;
  if (typeof original !== "function") {
    return { status: "incompatible", reason: "Missing BlackFlag.applications.actor.ToolConfig._onChangeTools." };
  }
  if (original[PATCH_FLAG]) return { status: "already-installed" };

  async function onChangeTools(event) {
    if (event.target.open) return;
    const trait = this.options?.trait;
    const current = this.document?.system?.proficiencies?.[trait];
    if (!trait || !current || !event.target?.value) return original.call(this, event);

    const selected = new Set(event.target.value);
    const updates = {};
    for (const key of selected) {
      if (!(key in current)) updates[key] = {};
    }
    for (const key of Object.keys(current)) {
      if (!selected.has(key)) updates[key] = new foundry.data.operators.ForcedDeletion();
    }
    return this.document.update({
      system: { proficiencies: { [trait]: updates } }
    });
  }

  Object.defineProperty(onChangeTools, PATCH_FLAG, { value: true });
  ToolConfig.prototype._onChangeTools = onChangeTools;
  return { status: "completed" };
}
