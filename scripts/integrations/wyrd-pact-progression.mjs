import { MODULE_ID } from "../core/constants.mjs";

const WYRD_SOURCE = "wyrd";
let installed = false;

function isWyrdSpellcasting(spellcasting) {
  const sources = spellcasting?.sources;
  if (typeof sources?.has === "function") return sources.has(WYRD_SOURCE);
  return Array.isArray(sources) && sources.includes(WYRD_SOURCE);
}

function wyrdCasterLevel(level) {
  const numericLevel = Number(level);
  if (!Number.isFinite(numericLevel)) return null;
  if (numericLevel < 2) return 0;
  return Math.max(Math.ceil(numericLevel / 2), 0);
}

function hasCorrectWyrdPactProgression(SpellcastingTemplate) {
  const progression = { cantrips: false, leveled: 0, pact: { circle: null, slots: 0 } };
  const spellcasting = {
    sources: new Set([WYRD_SOURCE]),
    maxCircle: 1,
    slots: { scaleValue: { valueForLevel: () => 2 } },
    cantrips: {}
  };
  SpellcastingTemplate.computePactProgression(progression, null, {
    levels: 3,
    spellcasting,
    count: 1
  });
  return progression.leveled === 2 && Number(progression.pact?.slots ?? 0) === 2;
}

/**
 * Black Flag 3.0.078 rounds the leveled half-caster contribution of pact
 * casting down. Wyrd Pact Casting requires that contribution to round up from
 * class level 3 onward. Its independent Pact Slot pool remains unchanged.
 */
export function installWyrdPactProgression() {
  if (installed) return { status: "already-installed" };

  const SpellcastingTemplate = globalThis.BlackFlag?.data?.actor?.SpellcastingTemplate;
  const missing = [];
  if (typeof SpellcastingTemplate?.computePactProgression !== "function") {
    missing.push("SpellcastingTemplate.computePactProgression");
  }
  if (typeof Hooks?.on !== "function") missing.push("Hooks.on");
  if (missing.length) {
    return { status: "incompatible", reason: `Missing Black Flag APIs: ${missing.join(", ")}.` };
  }

  if (hasCorrectWyrdPactProgression(SpellcastingTemplate)) {
    return {
      status: "inactive",
      reason: "Black Flag already provides the Wyrd Pact Casting progression."
    };
  }

  Hooks.on("blackFlag.computePactProgression", (progression, _cls, { levels = 1, spellcasting } = {}) => {
    if (!isWyrdSpellcasting(spellcasting)) return;
    const casterLevel = wyrdCasterLevel(levels);
    if (casterLevel === null) return;

    const systemCasterLevel = Math.max(Math.floor(Number(levels) / 2), 0);
    progression.leveled = Number(progression.leveled ?? 0) + casterLevel - systemCasterLevel;
  });

  installed = true;
  console.debug(`${MODULE_ID} | Applied Wyrd Pact Casting progression compatibility fix.`);
  return { status: "completed" };
}
