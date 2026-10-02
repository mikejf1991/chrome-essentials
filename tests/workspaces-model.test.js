import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntry } from '../extension/model.js';
import {
  PRIMARY_GROUP_ID, GROUP_COLORS, MAX_GROUPS, createGroup, updateGroup,
  normalizeConfig, normalizeRuntime,
} from '../extension/workspaces-model.js';

const gmail = () => createEntry('https://mail.google.com/mail/u/1/#inbox/42', 'Work Gmail', 'gmail');
const odoo = () => createEntry('https://acme.odoo.com/web#action=17', 'Odoo', 'odoo');
const activeRuntime = (overrides = {}) => ({ active: true, ownerWindowId: 1, groupId: 10,
  anchor: 2, slots: { gmail: 101 }, restoring: {}, attaching: {}, paused: {},
  recent: {}, fresh: {}, candidates: {}, warning: null, ...overrides });

test('empty or damaged config always has the primary workspace with drag-to-add enabled', () => {
  for (const raw of [undefined, null, [], 12, {}, { version: 2, groups: null }]) {
    assert.deepEqual(normalizeConfig(raw), { version: 2, groups: [{
      id: PRIMARY_GROUP_ID, name: 'Essentials', color: 'blue', acceptDrops: true, entries: [],
    }] });
  }
  assert.equal(MAX_GROUPS, 50);
});

test('v1 migration preserves valid entry identity, exact URLs, boundaries, and saved order', () => {
  const entry = { ...gmail(), allowedHosts: ['mail.google.com', 'chat.google.com'], authHosts: ['accounts.google.com'] };
  const original = { version: 1, entries: [entry, { invalid: true }, odoo()] };
  const snapshot = structuredClone(original);
  const config = normalizeConfig(original);
  assert.deepEqual(config.groups[0].entries, [entry, odoo()]);
  assert.deepEqual(original, snapshot);
  assert.equal(config.groups[0].acceptDrops, true);
  assert.deepEqual(normalizeConfig(config), config);
});

test('valid v2 workspaces preserve distinct saved sets and explicit drag preferences', () => {
  const primary = { ...createGroup('Essentials', 'green', PRIMARY_GROUP_ID), entries: [gmail()], acceptDrops: false };
  const research = { ...createGroup('Research', 'purple', 'research'), entries: [odoo()] };
  const config = normalizeConfig({ version: 2, groups: [primary, research] });
  assert.deepEqual(config.groups, [primary, research]);
  config.groups[0].entries[0].allowedHosts.push('chat.google.com');
  assert.deepEqual(primary.entries[0].allowedHosts, ['mail.google.com']);
  assert.deepEqual(config.groups[1].entries, [odoo()]);
});

test('primary identity and name are repaired without discarding its entries or editable color', () => {
  const config = normalizeConfig({ version: 2, groups: [
    { id: 'research', name: 'Research', color: 'pink', entries: [odoo()] },
    { id: PRIMARY_GROUP_ID, name: 'Renamed', color: 'orange', entries: [gmail()], acceptDrops: false },
  ] });
  assert.equal(config.groups[0].name, 'Essentials');
  assert.equal(config.groups[0].id, PRIMARY_GROUP_ID);
  assert.equal(config.groups[0].color, 'orange');
  assert.equal(config.groups[0].acceptDrops, false);
  assert.deepEqual(config.groups[0].entries, [gmail()]);
  assert.deepEqual(config.groups[1].entries, [odoo()]);
});

test('damaged names, colors, and identifiers are repaired while valid entries survive', () => {
  const raw = { version: 2, groups: [
    { id: '__proto__', name: '', color: 'invalid', acceptDrops: 'false', entries: [gmail()] },
    { id: 'constructor', name: 'r'.repeat(80), color: null, entries: [odoo()] },
    null,
  ] };
  const config = normalizeConfig(raw);
  assert.equal(config.groups.length, 3);
  assert.match(config.groups[1].id, /^[a-f\d-]{36}$/);
  assert.equal(config.groups[1].name, 'Group 2');
  assert.equal(config.groups[1].color, 'blue');
  assert.equal(config.groups[1].acceptDrops, true);
  assert.deepEqual(config.groups[1].entries, [gmail()]);
  assert.equal(config.groups[2].name.length, 60);
  assert.deepEqual(config.groups[2].entries, [odoo()]);
  assert.deepEqual(normalizeConfig(config), config);
});

test('duplicate IDs and case-insensitive names are repaired without merging different workspaces', () => {
  const config = normalizeConfig({ version: 2, groups: [
    { id: PRIMARY_GROUP_ID, name: 'Essentials', entries: [gmail()] },
    { id: 'work', name: '  Work  ', entries: [gmail()] },
    { id: 'work', name: 'WORK', entries: [odoo()] },
    { id: PRIMARY_GROUP_ID, name: 'essentials', entries: [odoo()] },
  ] });
  assert.equal(new Set(config.groups.map(g => g.id)).size, 4);
  assert.deepEqual(config.groups.map(g => g.name), ['Essentials', 'Work', 'WORK (2)', 'essentials (2)']);
  assert.deepEqual(config.groups.map(g => g.entries.map(e => e.id)), [['gmail'], ['gmail'], ['odoo'], ['odoo']]);
  assert.deepEqual(normalizeConfig(config), config);
});

test('loading already-saved workspaces never truncates them at the new-group creation limit', () => {
  const groups = Array.from({ length: MAX_GROUPS + 1 }, (_, i) => ({
    ...createGroup(`Group ${i}`, 'blue', `group-${i}`), entries: [gmail()],
  }));
  const config = normalizeConfig({ version: 2, groups });
  assert.equal(config.groups.length, MAX_GROUPS + 2);
  assert.equal(config.groups.at(-1).entries[0].lastValidUrl, gmail().lastValidUrl);
});

test('new groups validate metadata, reject unsafe keys, and enable drag-to-add', () => {
  assert.deepEqual(createGroup(' Research ', 'purple', 'research'), {
    id: 'research', name: 'Research', color: 'purple', acceptDrops: true, entries: [],
  });
  assert.match(createGroup('Work').id, /^[a-f\d-]{36}$/);
  for (const color of GROUP_COLORS) assert.equal(createGroup('Work', color).color, color);
  for (const id of ['__proto__', 'prototype', 'constructor', 'toString', 'hasOwnProperty', '', 'a/b', 'has space', null]) {
    assert.throws(() => createGroup('Work', 'blue', id), /identifier/);
  }
  assert.throws(() => createGroup(''), /name/);
  assert.throws(() => createGroup('x'.repeat(61)), /60/);
  assert.throws(() => createGroup('Work', 'teal'), /color/);
  assert.throws(() => createGroup('Work', 'blue', PRIMARY_GROUP_ID), /always named/);
});

test('group settings preserve identity and entries and forbid renaming Essentials', () => {
  const group = { ...createGroup('Research', 'purple', 'research'), entries: [gmail()] };
  const snapshot = structuredClone(group);
  const updated = updateGroup(group, { name: ' Reading ', color: 'cyan', acceptDrops: false,
    id: 'stolen', entries: [odoo()], extra: true });
  assert.deepEqual(updated, { id: 'research', name: 'Reading', color: 'cyan', acceptDrops: false, entries: [gmail()] });
  assert.deepEqual(group, snapshot);
  const primary = createGroup('Essentials', 'blue', PRIMARY_GROUP_ID);
  assert.throws(() => updateGroup(primary, { name: 'Work' }), /always named/);
  assert.equal(updateGroup(primary, { color: 'red' }).color, 'red');
  assert.throws(() => updateGroup(group, { acceptDrops: 'false' }), /on or off/);
  assert.throws(() => updateGroup(group, { name: null }), /name/);
  assert.throws(() => updateGroup(group, { color: 'invalid' }), /color/);
  assert.throws(() => updateGroup(null), /object/);
});

test('legacy live runtime migrates to Essentials only without losing native bindings', () => {
  const legacy = activeRuntime({ restoring: { gmail: true }, recent: { gmail: [120, 150] }, fresh: { 102: 200 },
    candidates: { 103: { since: 100, index: 3, groupId: 10 } } });
  const snapshot = structuredClone(legacy);
  const runtime = normalizeRuntime(legacy, [PRIMARY_GROUP_ID, 'research']);
  assert.deepEqual(runtime.groups.essentials, legacy);
  assert.equal(runtime.version, 2);
  assert.equal(runtime.groups.research.active, false);
  assert.deepEqual(runtime.groups.research.slots, {});
  assert.deepEqual(legacy, snapshot);
});

test('v2 runtime binds only known workspace keys and keeps their slots independent', () => {
  const primary = activeRuntime();
  const research = activeRuntime({ ownerWindowId: 2, groupId: 11, slots: { odoo: 201 } });
  const runtime = normalizeRuntime({ version: 2, groups: {
    essentials: primary, research, deleted: activeRuntime({ slots: { ghost: 999 } }),
  } }, [PRIMARY_GROUP_ID, 'research']);
  assert.deepEqual(Object.keys(runtime.groups), [PRIMARY_GROUP_ID, 'research']);
  assert.deepEqual(runtime.groups.essentials, primary);
  assert.deepEqual(runtime.groups.research, research);
  runtime.groups.research.slots.odoo = 202;
  assert.equal(research.slots.odoo, 201);
  assert.equal(runtime.groups.essentials.slots.gmail, 101);
});

test('unsafe and inherited storage keys cannot become workspace or tab bindings', () => {
  const pollutedGroups = JSON.parse('{"__proto__":{"active":true,"ownerWindowId":1},"constructor":{"active":true,"ownerWindowId":1}}');
  const inherited = Object.create({ essentials: activeRuntime() });
  assert.equal(normalizeRuntime({ version: 2, groups: inherited }).groups.essentials.active, false);
  const config = Object.create({ entries: [gmail()], groups: [{ id: 'inherited', entries: [odoo()] }] });
  assert.deepEqual(normalizeConfig(config).groups[0].entries, []);
  const runtime = normalizeRuntime({ version: 2, groups: pollutedGroups }, ['__proto__', 'constructor', 'safe']);
  assert.deepEqual(Object.keys(runtime.groups), [PRIMARY_GROUP_ID, 'safe']);
  const slots = JSON.parse('{"gmail":101,"__proto__":102,"constructor":103,"bad":-1,"notNumber":"104"}');
  assert.deepEqual(normalizeRuntime(activeRuntime({ slots })).groups.essentials.slots, { gmail: 101 });
  assert.equal(Object.getPrototypeOf(runtime.groups), Object.prototype);
  assert.equal({}.active, undefined);
});

test('damaged runtime values are sanitized and inactive sessions cannot claim tabs', () => {
  const runtime = normalizeRuntime(activeRuntime({
    groupId: '10', anchor: -1, restoring: { gmail: true, bad: 'true' }, attaching: [],
    paused: { gmail: 'Sign in', blank: '', bad: 1 }, recent: { gmail: [10, -1, Infinity, '20', 30], bad: 10 },
    fresh: { 105: 500, '-1': 500, bad: 20 }, candidates: {
      106: { since: 100, index: 3, groupId: 10 }, 107: { since: 100, index: -1, groupId: 10 },
      108: { since: '100', index: 3, groupId: 10 }, bad: { since: 100, index: 3, groupId: 10 },
    },
  })).groups.essentials;
  assert.equal(runtime.groupId, null);
  assert.equal(runtime.anchor, 0);
  assert.deepEqual(runtime.restoring, { gmail: true });
  assert.deepEqual(runtime.attaching, {});
  assert.deepEqual(runtime.paused, { gmail: 'Sign in' });
  assert.deepEqual(runtime.recent, { gmail: [10, 30] });
  assert.deepEqual(runtime.fresh, { 105: 500 });
  assert.deepEqual(runtime.candidates, { 106: { since: 100, index: 3, groupId: 10 } });
  for (const malformed of [activeRuntime({ active: false }), activeRuntime({ ownerWindowId: null }),
    activeRuntime({ ownerWindowId: -1 }), null]) {
    const normalized = normalizeRuntime(malformed).groups.essentials;
    assert.equal(normalized.active, false);
    assert.deepEqual(normalized.slots, {});
  }
});
