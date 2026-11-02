let installed = false;

function luckRerollContext(event) {
  const button = event.target?.closest?.('[data-action="luck-reroll"]');
  const element = button?.closest?.("blackflag-messageluck");
  const message = element?.message;
  if (!button || !message) return null;

  const roll = message.rolls?.find(candidate => candidate instanceof CONFIG.Dice.ChallengeRoll);
  const die = roll?.challengeDie;
  return die ? { die, message } : null;
}

function animationRoll(die, result) {
  const visualDie = new foundry.dice.terms.Die({
    number: 1,
    faces: die.faces,
    modifiers: [],
    results: [{ result: result.result, active: true }],
    options: foundry.utils.deepClone(die.options ?? {})
  });
  return CONFIG.Dice.rolls[0].fromTerms([visualDie]);
}

async function animateReroll(die, previousResultCount, message) {
  const addedResults = die.results.slice(previousResultCount);
  const result = addedResults.find(candidate => candidate.active && !candidate.discarded)
    ?? addedResults[0];
  const showForRoll = game.dice3d?.showForRoll;
  if (!result || typeof showForRoll !== "function") return;

  const roll = animationRoll(die, result);
  await showForRoll.call(game.dice3d, roll, game.user, true, null, message.blind === true);
}

function prepareLuckRerollAnimation(event) {
  const context = luckRerollContext(event);
  if (!context || typeof game.dice3d?.showForRoll !== "function") return;

  const { die, message } = context;
  if (Object.hasOwn(die, "reroll")) return;
  const inheritedReroll = die.reroll;
  if (typeof inheritedReroll !== "function") return;

  Object.defineProperty(die, "reroll", {
    configurable: true,
    value: async function(...args) {
      delete this.reroll;
      const previousResultCount = this.results.length;
      const outcome = await inheritedReroll.apply(this, args);
      try {
        await animateReroll(this, previousResultCount, message);
      } catch (error) {
        console.warn("tov-feuerschwinge-tools | Dice So Nice Luck re-roll animation failed.", error);
      }
      return outcome;
    }
  });
}

/** Animate Black Flag's in-place Luck die re-roll before its chat card is updated. */
export function installLuckRerollDiceSoNice() {
  if (installed) return { status: "already-installed" };
  if (game.system.id !== "black-flag") {
    return { status: "inactive", reason: "Requires the black-flag system." };
  }
  if (!game.modules.get("dice-so-nice")?.active) {
    return { status: "inactive", reason: "Dice So Nice is not active." };
  }
  if (!CONFIG.Dice?.ChallengeRoll || !foundry.dice?.terms?.Die) {
    return { status: "incompatible", reason: "The required Black Flag or Foundry dice API is unavailable." };
  }

  document.addEventListener("click", prepareLuckRerollAnimation, { capture: true });
  installed = true;
  return { status: "completed" };
}
