export const VOID_TAINT_FLAG = "voidTaint";

export const VOID_TAINT_SETTINGS = Object.freeze({
  ENABLED: "voidTaintEnabled",
  MINIMUM_THRESHOLD: "voidTaintMinimumThreshold",
  DREAD_TABLE: "voidTaintDreadTable",
  FLESH_WARP_TABLE: "voidTaintFleshWarpTable"
});

export const INDEFINITE_DREADS = Object.freeze([
  "I see secret messages and warnings in seemingly random objects, such as shards of smashed glass.",
  "All my memories of a specific event or person in my life are suddenly gone. I don’t know what took them, but I know someone stole them from me for some terrible reason.",
  "I hear alien voices whispering in a language I can’t understand. The whispers are loudest near corners of rooms.",
  "I constantly scrawl strange glyphs without realizing it, sometimes going so far as to cut them into my skin.",
  "When I’m excited or upset, some of my words come out in a different language that I don’t even understand.",
  "The trappings and symbol of a certain deity cause me great pain to look upon or touch.",
  "Ordered collections of objects are fascinating, and I have to study and count them.",
  "I collect strange or disgusting trinkets, such as teeth of creatures I kill or scrapings of dirt from everywhere I sleep.",
  "The music is always with me, and I must let it out. It doesn’t matter that no one else finds the song beautiful.",
  "I hear scratching just on the other side of interior walls."
]);

export const FLESH_WARPS = Object.freeze([
  ["Barbed Hide", "Spiny barbs protrude from your skin. Each time a creature hits you with a melee weapon attack, it takes 2d4 piercing damage. Additionally, while you are grappled by a creature, that creature takes 2d4 piercing damage at the start of each turn it maintains the grapple. The barbs make restrictive clothing and armor uncomfortable to wear. You have disadvantage on all DEX-based ability checks and DEX saves while wearing medium or heavy armor."],
  ["Eyeless", "Your eyes rot away, vanish (leaving behind smooth flesh), or otherwise become useless (you choose which). You can no longer see and you automatically fail any checks that require sight. Your other senses are enhanced by the Void, granting you keensense to a range of 20 feet (you are considered blinded beyond this radius)."],
  ["Gleaming Skin", "Your skin takes on a waxy, unnatural sheen. It might be pale, translucent, or even crystalline in appearance (you choose which). The gleam grants other creatures advantage on WIS (Perception) checks made to locate you via sight. When a creature within 5 feet of you attempts to hit you with a melee attack while you are in an area of bright light, you can use your reaction to impose disadvantage on the attack."],
  ["Pliant Bones", "Your skeleton becomes cartilaginous and pliable. You can move through a space as narrow as 6 inches without squeezing, but you have disadvantage on all STR-based ability checks and STR saves."],
  ["Prehensile Tail", "You grow a 3-foot-long prehensile tail. As a bonus action, you can use the tail to make a single unarmed strike that deals 1d4 + your STR modifier bludgeoning damage. You have disadvantage on DEX (Acrobatics) checks."],
  ["Proboscis", "Your mouth mutates into a long, tubular organ like the maw of a mosquito, moth, or worm. You lose the ability to speak. You can use the proboscis to make a blood-draining melee weapon attack. The attack roll can be made using STR or DEX (you choose which); a hit deals 1d4 + your STR modifier piercing damage and the target is grappled. While grappling a creature in this way, you can’t attack but you automatically deal 1d4 + your STR modifier piercing damage to the target at the start of each turn it remains grappled. You can automatically detach from the target by spending 5 feet of movement. The grappled target or one of its allies within 5 feet of it can free the creature from your proboscis automatically by expending an action."],
  ["Sentient Tumors", "Large cystic tumors sprout from your shoulder, arm, or back. These growths are sentient and emit a weak psychic field. While you have the tumors, your mind can’t be read telepathically and you are treated as if under the effects of a permanent nondetection spell. Every time you take an instance of psychic damage, you must make a WIS save or suffer the effects of a confusion spell for 1 minute (if affected you don’t get to repeat the save to end early). The DC for this save is equal to half the psychic damage you take, rounded up (minimum DC 10)."],
  ["Stench", "You exude the stink of rotting flesh, acrid chemicals, sickly sweet perfume, or some other odious aroma. A creature (other than you) that starts its turn within 5 feet of you must succeed on a DC 12 CON save or be poisoned until the start of its next turn. This stink clings to any objects that remain in your possession for at least 24 hours. Attempting to sell any such object might be impossible or yields only half the normal price at best. Food in your possession spoils after 24 hours."],
  ["Tentacles", "One of your hands twists into a nest of writhing tentacles. Any check or save you make to initiate a grapple, maintain a grapple, or maintain a grip on an item is made with advantage. Any DEX-based ability check or save you make involving fine motor control has disadvantage."],
  ["Tusks", "Your incisors grow into enormous curved tusks. You have difficulty speaking and must succeed on a DC 12 DEX check to cast a spell with a verbal component."]
]);

export const VOID_EXPOSURES = Object.freeze([
  ["Finishes a short or long rest on a dead world or a similar Near Void area without magical protection", "DC 10"],
  ["Witnesses a void cult ritual, reads a cultist tome, or otherwise learns void-tainted lore", "DC 12"],
  ["Attunes to a Void-tainted magic item", "DC 15"],
  ["Uses a spell scroll to cast a void magic spell", "DC 10 + spell circle"],
  ["Is targeted by a void magic spell of 6th circle or higher", "Caster’s spell save DC"],
  ["Is exposed to a Void hazard", "Hazard’s save DC"],
  ["First encounters a creature type with the Void tag or Void Dweller trait", "DC 10 + creature’s CHA modifier"],
  ["Spends one hour exposed to the atmosphere of the Deep Void", "DC 20"],
  ["Finishes a long rest in the Deep Void without magical protection", "DC 25"]
]);
