import assert from "node:assert/strict";
import { auditActorSpellData } from "../scripts/actor-spell-audit.mjs";

const actor = {
  _id: "actor1",
  name: "Audit Test",
  system: {
    progression: {
      advancement: {
        class1: {
          advancement1: {
            added: {
              1: [{ document: "tracked", uuid: "Compendium.test.spells.Item.tracked" }]
            }
          }
        }
      }
    }
  },
  items: [
    {
      _id: "class1",
      name: "Test Class",
      type: "class",
      system: { advancement: { advancement1: { title: "Learn Spells" } } }
    },
    {
      _id: "parent",
      name: "Cache Parent",
      type: "feature",
      system: { activities: { active: { _id: "active" } } }
    },
    { _id: "tracked", name: "Tracked", type: "spell", system: { circle: { base: 1 } }, flags: {} },
    {
      _id: "activeCache",
      name: "Active Cache",
      type: "spell",
      system: { circle: { base: 1 } },
      flags: { "black-flag": { cachedFor: ".Item.parent.Activity.active" } }
    },
    {
      _id: "orphanCache",
      name: "Orphan Cache",
      type: "spell",
      system: { circle: { base: 1 } },
      flags: { "black-flag": { cachedFor: ".Item.parent.Activity.removed" } }
    },
    { _id: "manual", name: "Manual", type: "spell", system: { circle: { base: 1 } }, flags: {} }
  ]
};

const report = auditActorSpellData(actor);
assert.deepEqual(report.summary, {
  spells: 4,
  keep: 2,
  review: 1,
  safeRemovalCandidates: 1,
  projectedAfterSafeRemoval: 3,
  categories: {
    "progression-tracked": 1,
    "active-cache": 1,
    "orphan-cache": 1,
    "manual-or-untracked": 1
  }
});
assert.deepEqual(report.safeRemovalIds, ["orphanCache"]);
assert.equal(report.spells.find(row => row.id === "tracked").references[0].advancementTitle, "Learn Spells");

console.log("Actor spell audit classification passed.");
