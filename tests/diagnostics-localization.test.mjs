import assert from "node:assert/strict";
import fs from "node:fs";

const template = fs.readFileSync(new URL("../templates/downtime/gm-tools.hbs", import.meta.url), "utf8");
const diagnosticsStart = template.indexOf('{{#if (eq tab "diagnostics")}}');
assert.notEqual(diagnosticsStart, -1, "diagnostics template section exists");
const diagnosticsTemplate = template.slice(diagnosticsStart);
const localizationKeys = new Set(
  [...diagnosticsTemplate.matchAll(/localize "([^"]+)"/g)].map(match => match[1])
);

function lookup(data, path) {
  return path.split(".").reduce((value, part) => value?.[part], data);
}

for (const language of ["de", "en"]) {
  const data = JSON.parse(fs.readFileSync(new URL(`../lang/${language}.json`, import.meta.url), "utf8"));
  for (const key of localizationKeys) {
    assert.equal(typeof lookup(data, key), "string", `${language} resolves ${key}`);
  }
  for (const key of [
    "TOVF.EffectCleanup.Title",
    "TOVF.EffectCleanup.Summary",
    "TOVF.EffectCleanup.Scope",
    "TOVF.EffectCleanup.Action"
  ]) {
    assert.equal(typeof lookup(data, key), "string", `${language} resolves ${key}`);
  }
  assert.equal(Object.hasOwn(data, "TOVF.TechnicalDiagnostics.Title"), false);
  assert.equal(Object.hasOwn(data, "TOVF.EffectCleanup.Title"), false);
}

const stack = [];
for (const match of template.matchAll(/{{([#\/]?)(if|each|unless)\b[^}]*}}/g)) {
  const [, marker, name] = match;
  if (marker === "#") stack.push(name);
  if (marker === "/") assert.equal(stack.pop(), name, `closes ${name} block`);
}
assert.deepEqual(stack, [], "all Handlebars blocks are closed");

console.log(`Diagnostics localization paths passed (${localizationKeys.size} template keys).`);
