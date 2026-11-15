// a wrong _id count dresses her in the wrong mod item and nothing complains
// run: node --test .github/scripts/js
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';

register('./dom-stub-hooks.mjs', import.meta.url);
const { parseMod } = await import('../../../webapp/js/mods/parse.js');

const enc = (s) => new TextEncoder().encode(s);

function prefab(v, name, folder) {
  return `local ${v} = ModUtilities.CreateItemPrefab()
${v}.Name = '${name}'
${v}.Description = 'good for a run, then do it again'
${v}.PossibleEquipmentSlots = {'Skin'}
local ${v}_tex = ModUtilities.GetPackedTexture(CurrentModGuid, '/${folder}/tex 3 - interaction.json')
${v}.AddTexture(${v}_tex)
`;
}

const call = (v) => `ModUtilities.CreateNewItemAutoAssignId(CurrentModGuid, ${v})\n`;

function mod(luaFiles, folders = ['A', 'B', 'C']) {
  const files = { 'mod.json': enc('{}') };
  for (const f of folders) files[`${f}/tex 3 - interaction.json`] = enc('{}');
  for (const [path, src] of Object.entries(luaFiles)) files[path] = enc(src);
  return Object.fromEntries(parseMod('g', files).items.map(it => [it.folder, it.gameId]));
}

const three = prefab('p0', 'Zero', 'A') + prefab('p1', 'One', 'B') + prefab('p2', 'Two', 'C');

test('generated script: call order, set calls count too', () => {
  const src = 'do\n' + three + call('p1') + 'local set = ModUtilities.CreateItemPrefab()\nset.Name = "Set"\n'
    + call('set') + call('p0') + call('p2') + 'end\n';
  assert.deepEqual(mod({ 'script.lua': src }), { A: 2, B: 0, C: 3 });
});

test('commented out calls and keywords inside strings do not count', () => {
  const src = three + '-- ' + call('p2') + '--[[ ' + call('p1') + ' for i = 1, 2 do ]]\n'
    + call('p0') + call('p1') + call('p2');
  assert.deepEqual(mod({ 'script.lua': src }), { A: 0, B: 1, C: 2 });
});

test('SlotData closures are fine', () => {
  const src = three + "p0.SlotData = (function() local d = {} d.TargetSlotString = 'Skin' return d end)()\n"
    + call('p0') + call('p1') + call('p2');
  assert.deepEqual(mod({ 'script.lua': src }), { A: 0, B: 1, C: 2 });
});

test('a call in a loop, an if or a helper drops every number', () => {
  for (const wrap of [
    (c) => `for _, p in ipairs({p1, p2}) do ${c} end\n`,
    (c) => `if Something then ${c} end\n`,
    (c) => `local function add(prefab) ${c} end add(p1) add(p2)\n`,
    (c) => `while false do ${c} end\n`,
  ]) {
    const src = three + call('p0') + wrap(call('prefab'));
    assert.deepEqual(mod({ 'script.lua': src }), { A: null, B: null, C: null });
  }
});

test('several scripts side by side: no numbers, a stray deeper copy is ignored', () => {
  const src = three + call('p0') + call('p1') + call('p2');
  assert.deepEqual(mod({ 'a.lua': src, 'b.lua': src }), { A: null, B: null, C: null });
  assert.deepEqual(mod({ 'script.lua': src, 'old/script.lua': three + call('p2') }), { A: 0, B: 1, C: 2 });
});
