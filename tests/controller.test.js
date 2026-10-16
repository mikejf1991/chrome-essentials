import test from 'node:test';
import assert from 'node:assert/strict';
import { DROP_SETTLE_MS, EssentialsController } from '../extension/controller.js';
import { createEntry } from '../extension/model.js';
import { LaunchIntent } from '../extension/launch-intent.js';

test('a slow Chrome response cannot focus over newer navigation or a second click', async () => {
  const chrome = fakeChrome([createEntry('https://mail.google.com/', 'Mail', 'mail')]);
  const controller = new EssentialsController(chrome.api);
  await controller.init();
  const intent = new LaunchIntent();
  const canFocus = intent.begin(7), update = chrome.api.tabs.update;
  const focused = [];
  chrome.api.tabs.update = async (id, values) => { if (values.active) focused.push(id); return update(id, values); };
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  const group = chrome.api.tabs.group;
  chrome.api.tabs.group = async options => { reached(); await gate; return group(options); };
  const launch = controller.launch(1, true, canFocus);
  await waiting;
  intent.navigation(7);
  intent.begin(7); // Repeated click supersedes, never revives, the first intent.
  release();
  await launch;
  assert.deepEqual(focused, []);
  assert.equal(chrome.tabs.size, 1);
  await controller.launch(1, true, intent.begin(7));
  assert.equal(chrome.tabs.size, 1);
  assert.equal(focused.length, 1);
});

test('focus rechecks intent after reading a tab and never rewrites its URL', async () => {
  const {controller,api,tabs} = await launched();
  const id = controller.state().slots.gmail, intent = new LaunchIntent();
  const canFocus = intent.begin(id), get = api.tabs.get, updates = [];
  api.tabs.get = async tabId => { const tab = await get(tabId); intent.cancel(); tabs.get(id).url = 'https://example.com/working'; return tab; };
  api.tabs.update = async (...args) => { updates.push(args); };
  await controller.focus(canFocus);
  assert.deepEqual(updates, []);
  assert.equal(tabs.get(id).url, 'https://example.com/working');
});

test('delayed repair preserves newer navigation in the actual restoring tab without any URL update', async () => {
  const chrome = fakeChrome([createEntry('https://mail.google.com/#inbox', 'Mail', 'mail')]);
  const controller = new EssentialsController(chrome.api);
  await controller.init();
  const intent = new LaunchIntent(), canFocus = intent.begin(7);
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; });
  const waiting = new Promise(resolve => { reached = resolve; });
  const group = chrome.api.tabs.group, update = chrome.api.tabs.update, extensionUpdates = [];
  chrome.api.tabs.group = async options => { reached(); await gate; return group(options); };
  chrome.api.tabs.update = async (id, values) => { extensionUpdates.push({id,values}); return update(id,values); };
  const launch = controller.launch(1,true,canFocus);
  await waiting; // Creation and session persistence are done; grouping is delayed.
  const id = controller.state().slots.mail;
  await update(id,{url:'https://example.com/newer-user-destination',active:true});
  intent.activate(id);intent.navigation(id);
  release();await launch;await controller.reconcile();
  assert.equal(chrome.tabs.get(id).url,'https://example.com/newer-user-destination');
  assert.equal(controller.entries[0].lastValidUrl,'https://mail.google.com/#inbox');
  assert.equal(chrome.tabs.size,1,'a redirected restoring tab pauses without a replacement loop');
  assert.equal(extensionUpdates.some(call=>Object.hasOwn(call.values,'url')),false);
});

// This models tab identity, groups, window ownership, and persisted state. Real
// Chrome integration tests cover event delivery and the native group API.
function fakeChrome(entries = [], initialTabs = []) {
  const data = { local: { config: { version: 1, entries: structuredClone(entries) } }, session: {} };
  const windows = new Map([[1, { id: 1, type: 'normal', focused: true }],
    [2, { id: 2, type: 'normal', focused: false }]]);
  const tabs = new Map(initialTabs.map(t => [t.id, { windowId: 1, groupId: -1, index: 0,
    active: false, incognito: false, title: t.url, ...t }]));
  const groups = new Map();
  const calls = [];
  const alarms = new Map();
  let nextTabId = 100;
  let nextGroupId = 10;
  let nextWindowId = 3;
  const copy = value => value === undefined ? undefined : structuredClone(value);
  const sort = windowId => [...tabs.values()].filter(t => t.windowId === windowId).sort((a, b) => a.index - b.index);
  const reindex = windowId => sort(windowId).forEach((t, index) => { t.index = index; });
  const deleteEmptyGroups = () => {
    for (const [id] of groups) if (![...tabs.values()].some(t => t.groupId === id)) groups.delete(id);
  };
  const get = id => {
    const tab = tabs.get(id);
    if (!tab) throw new Error(`No tab ${id}`);
    return tab;
  };
  const move = (id, options) => {
    const tab = get(id);
    const oldWindow = tab.windowId;
    const windowId = options.windowId ?? oldWindow;
    const peers = sort(windowId).filter(t => t.id !== id);
    const requestedIndex = options.index === -1 ? peers.length : Math.min(options.index, peers.length);
    const pinnedCount = peers.filter(peer => peer.pinned).length;
    const index = tab.pinned ? Math.min(requestedIndex, pinnedCount) : Math.max(requestedIndex, pinnedCount);
    if (oldWindow !== windowId) tab.groupId = -1;
    tab.windowId = windowId;
    peers.splice(index, 0, tab);
    peers.forEach((t, index) => { t.index = index; });
    if (oldWindow !== windowId) reindex(oldWindow);
    deleteEmptyGroups();
    return copy(tab);
  };
  const api = {
    storage: Object.fromEntries(['local', 'session'].map(area => [area, {
      get: async key => ({ [key]: copy(data[area][key]) }),
      set: async values => Object.assign(data[area], copy(values)),
    }])),
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
    alarms: { get: async name => alarms.get(name), create: async (name, config) => alarms.set(name, config),
      clear: async name => alarms.delete(name) },
    windows: {
      getAll: async () => copy([...windows.values()]),
      get: async id => { if (!windows.has(id)) throw new Error('Window is gone'); return copy(windows.get(id)); },
      update: async (id, values) => {
        if (values.focused) for (const window of windows.values()) window.focused = window.id === id;
        return Object.assign(windows.get(id), values);
      },
      create: async options => {
        calls.push({ ...options, operation: 'createWindow' });
        const window = { id: nextWindowId++, type: 'normal', focused: true, ...options };
        if (window.focused) for (const existing of windows.values()) existing.focused = false;
        windows.set(window.id, window);
        const tab = { id: nextTabId++, windowId: window.id, groupId: -1, incognito: false,
          index: 0, url: options.url ?? 'chrome://newtab/', active: true, title: options.url ?? 'New Tab' };
        tabs.set(tab.id, tab);
        return { ...copy(window), tabs: [copy(tab)] };
      },
    },
    tabs: {
      get: async id => copy(get(id)),
      query: async query => {
        if ('groupId' in query && !Number.isInteger(query.groupId)) throw new Error('groupId must be an integer');
        return copy([...tabs.values()].filter(t =>
          (query.groupId === undefined || t.groupId === query.groupId) &&
          (query.windowId === undefined || t.windowId === query.windowId))
          .sort((a, b) => a.windowId - b.windowId || a.index - b.index));
      },
      create: async options => {
        calls.push({ type: 'create', ...options });
        if (!windows.has(options.windowId)) throw new Error('Window is gone');
        const tab = { id: nextTabId++, groupId: -1, incognito: false, title: options.url,
          index: sort(options.windowId).length, ...options };
        tabs.set(tab.id, tab);
        move(tab.id, options);
        return copy(tab);
      },
      group: async options => {
        const ids = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
        const id = options.groupId ?? nextGroupId++;
        const existing = options.groupId === undefined ? undefined : groups.get(id);
        if (options.groupId !== undefined && !existing) throw new Error('Group is gone');
        // Chrome's createProperties defaults to the current window, which can
        // differ from the restored tab's owner while its user works elsewhere.
        const windowId = existing?.windowId ?? options.createProperties?.windowId ??
          [...windows.values()].find(w => w.focused)?.id;
        if (!windows.has(windowId)) throw new Error('Target group window is gone');
        for (const tabId of ids) if (get(tabId).windowId !== windowId) move(tabId, { windowId, index: -1 });
        if (!groups.has(id)) groups.set(id, { id, windowId, title: '' });
        ids.forEach(tabId => { get(tabId).groupId = id; });
        return id;
      },
      ungroup: async ids => {
        for (const id of Array.isArray(ids) ? ids : [ids]) get(id).groupId = -1;
        deleteEmptyGroups();
      },
      update: async (id, values) => { Object.assign(get(id), values); return copy(get(id)); },
      move: async (id, options) => move(id, options),
      remove: async ids => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const windowId = get(id).windowId;
          tabs.delete(id);
          reindex(windowId);
        }
        deleteEmptyGroups();
      },
    },
    tabGroups: {
      get: async id => { if (!groups.has(id)) throw new Error('Group is gone'); return copy(groups.get(id)); },
      query: async query => copy([...groups.values()].filter(g => !query.title || g.title === query.title)),
      update: async (id, values) => { Object.assign(groups.get(id), values); return copy(groups.get(id)); },
    },
  };
  return { api, data, tabs, groups, windows, calls };
}

async function launched(entries = [createEntry('https://mail.google.com/#inbox', 'Gmail', 'gmail')], options = {}) {
  const chrome = fakeChrome(entries);
  const controller = new EssentialsController(chrome.api, options);
  await controller.init();
  await controller.launch(1, false);
  return { ...chrome, controller };
}

function fakeClock() {
  let value = 1000;
  return { now: () => value, advance: milliseconds => { value += milliseconds; } };
}

async function reloadController(chrome, options = {}) {
  // Unlike a service-worker restart, an extension reload clears session storage
  // while its ordinary pages and native groups remain open.
  chrome.data.session = {};
  const controller = new EssentialsController(chrome.api, options);
  await controller.init();
  assert.equal(controller.state().active, false);
  return controller;
}

test('startup stays dormant; repeated explicit launches reuse one group and tab set', async () => {
  const entries = [createEntry('https://mail.google.com/', 'Gmail', 'gmail')];
  const chrome = fakeChrome(entries);
  const controller = new EssentialsController(chrome.api);
  await controller.init();
  assert.equal(controller.state().active, false);
  assert.equal(chrome.tabs.size, 0);
  await controller.launch(1, false);
  const groupId = controller.state().groupId;
  await controller.launch(2, false);
  assert.equal(chrome.tabs.size, 1);
  assert.equal(controller.state().ownerWindowId, 1);
  assert.equal(controller.state().groupId, groupId);
});

test('new groups target the owner window even when another window is current', async () => {
  const chrome = fakeChrome([createEntry('https://mail.google.com/', 'Gmail', 'gmail')]);
  const controller = new EssentialsController(chrome.api);
  await controller.init();
  await controller.launch(2, false);
  assert.equal(controller.state().ownerWindowId, 2);
  assert.equal(chrome.tabs.get(controller.state().slots.gmail).windowId, 2);
  assert.equal(chrome.groups.get(controller.state().groupId).windowId, 2);
  assert.equal(chrome.windows.get(1).focused, true);
});

test('launching after pinned tabs preserves the saved group order across reopening', async () => {
  const entries = [createEntry('https://mail.google.com/', 'Gmail', 'gmail'),
    createEntry('https://acme.odoo.com/', 'Odoo', 'odoo'),
    createEntry('https://messages.google.com/', 'Messages', 'messages')];
  const chrome = fakeChrome(entries, [
    { id: 1, url: 'https://pinned-one.example/', index: 0, pinned: true },
    { id: 2, url: 'https://pinned-two.example/', index: 1, pinned: true },
  ]);
  const controller = new EssentialsController(chrome.api);
  await controller.init();
  for (let launch = 0; launch < 2; launch++) {
    await controller.launch(1, false);
    const ordered = await chrome.api.tabs.query({ windowId: 1 });
    assert.deepEqual(ordered.map(tab => tab.id), [1, 2,
      ...entries.map(entry => controller.state().slots[entry.id])]);
    await controller.reconcile();
    assert.deepEqual(controller.state().entries.map(entry => entry.id), ['gmail', 'odoo', 'messages']);
    assert.deepEqual(chrome.data.local.config.entries.map(entry => entry.id), ['gmail', 'odoo', 'messages']);
    await controller.close();
    assert.equal(chrome.tabs.size, 2);
  }
});

test('closing an individual essential restores its latest in-app route', async () => {
  const { controller, api, tabs } = await launched();
  const original = controller.state().slots.gmail;
  await api.tabs.update(original, { url: 'https://mail.google.com/#inbox/message-42' });
  await controller.navigation(original, 'https://mail.google.com/#inbox/message-42');
  await api.tabs.remove(original);
  await controller.reconcile();
  const replacement = controller.state().slots.gmail;
  assert.notEqual(replacement, original);
  assert.equal(tabs.get(replacement).url, 'https://mail.google.com/#inbox/message-42');
  assert.equal(tabs.size, 1);
});

test('detaching leaves the moved tab usable and restores only its Essentials slot', async () => {
  const { controller, api, tabs } = await launched();
  const original = controller.state().slots.gmail;
  await api.tabs.move(original, { windowId: 2, index: -1 });
  await controller.reconcile();
  const replacement = controller.state().slots.gmail;
  assert.notEqual(replacement, original);
  assert.equal(tabs.get(original).windowId, 2);
  assert.equal(tabs.get(original).groupId, -1);
  assert.equal(tabs.get(replacement).windowId, 1);
  assert.equal(tabs.size, 2);
  await api.tabs.remove(original);
  await controller.reconcile();
  assert.equal(tabs.size, 1);
});

test('dragging a just-created essential out within the owner window does not take it back', async () => {
  const { controller, api, tabs } = await launched();
  const original = controller.state().slots.gmail;
  await api.tabs.ungroup(original);
  await controller.reconcile();
  assert.notEqual(controller.state().slots.gmail, original);
  assert.equal(tabs.get(original).groupId, -1);
  assert.equal(tabs.size, 2);
});

test('outside navigation preserves the destination and restores the last app URL once', async () => {
  const { controller, api, tabs } = await launched();
  const original = controller.state().slots.gmail;
  await api.tabs.update(original, { url: 'https://mail.google.com/#sent' });
  await controller.navigation(original, 'https://mail.google.com/#sent');
  await api.tabs.update(original, { url: 'https://example.com/article', active: true });
  await controller.reconcile();
  const replacement = controller.state().slots.gmail;
  assert.notEqual(replacement, original);
  assert.equal(tabs.get(original).url, 'https://example.com/article');
  assert.equal(tabs.get(original).groupId, -1);
  assert.equal(tabs.get(original).active, true);
  assert.equal(tabs.get(replacement).url, 'https://mail.google.com/#sent');
  assert.equal(tabs.get(replacement).active, false);
  assert.equal(controller.state().entries.length, 1);
  await controller.reconcile();
  assert.equal(tabs.size, 2);
});

test('sign-in transit remains grouped without overwriting the remembered app URL', async () => {
  const { controller, api, tabs } = await launched();
  const id = controller.state().slots.gmail;
  await api.tabs.update(id, { url: 'https://accounts.google.com/ServiceLogin' });
  await controller.navigation(id, 'https://accounts.google.com/ServiceLogin');
  await controller.reconcile();
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get(id).groupId, controller.state().groupId);
  assert.equal(controller.state().entries[0].lastValidUrl, 'https://mail.google.com/#inbox');
  assert.equal(controller.state().warning, null);
});

test('a restoration redirected outside its app pauses instead of spawning a tab loop', async () => {
  const { controller, api, tabs } = await launched();
  const id = controller.state().slots.gmail;
  await api.tabs.update(id, { url: 'https://unknown-login.example/signin' });
  await controller.reconcile();
  await controller.reconcile();
  assert.equal(tabs.size, 1);
  assert.match(controller.state().warning, /paused/);
  assert.equal(controller.state().entries[0].lastValidUrl, 'https://mail.google.com/#inbox');
});

test('explicit removal leaves a regular open tab and does not restore it', async () => {
  const { controller, api, tabs } = await launched();
  const id = controller.state().slots.gmail;
  await controller.remove('gmail');
  assert.equal(controller.state().entries.length, 0);
  assert.equal(controller.state().active, false);
  assert.equal(tabs.get(id).groupId, -1);
  await api.tabs.remove(id);
  await controller.reconcile();
  assert.equal(tabs.size, 0);
});

test('Close Essentials disables protection before closing; the saved launch set remains', async () => {
  const { controller, tabs } = await launched();
  await controller.close();
  await controller.reconcile();
  assert.equal(controller.state().active, false);
  assert.equal(controller.state().entries.length, 1);
  assert.equal(tabs.size, 0);
  await controller.launch(2, false);
  assert.equal(tabs.size, 1);
  assert.equal(controller.state().ownerWindowId, 2);
});

test('closing the owner window never resurrects Essentials in a different window', async () => {
  const { controller, api, windows, calls } = await launched();
  const count = calls.length;
  await api.tabs.remove(controller.state().slots.gmail);
  windows.delete(1);
  controller.markWindowClosing(1);
  await controller.reconcile();
  await controller.windowClosed(1);
  assert.equal(controller.state().active, false);
  assert.equal(calls.length, count);
});

test('detaching the last owner tab creates a background Essentials window and keeps the original ordinary', async () => {
  const { controller, api, tabs, groups, windows, calls } = await launched();
  const original = controller.state().slots.gmail;
  await api.tabs.update(original, { url: 'https://mail.google.com/#sent/last-message' });
  await controller.navigation(original, 'https://mail.google.com/#sent/last-message');
  controller.markDetached(original, 1);
  await api.tabs.move(original, { windowId: 2, index: -1 });
  await api.windows.update(2, { focused: true });
  windows.delete(1);
  await controller.windowClosed(1);
  const state = controller.state();
  assert.equal(state.active, true);
  assert.notEqual(state.ownerWindowId, 1);
  assert.notEqual(state.ownerWindowId, 2);
  assert.notEqual(state.slots.gmail, original);
  assert.equal(tabs.get(original).windowId, 2);
  assert.equal(tabs.get(original).groupId, -1);
  assert.equal(tabs.get(state.slots.gmail).windowId, state.ownerWindowId);
  assert.equal(tabs.get(state.slots.gmail).url, 'https://mail.google.com/#sent/last-message');
  assert.equal(groups.get(state.groupId).windowId, state.ownerWindowId);
  assert.equal(windows.get(state.ownerWindowId).focused, false);
  assert.equal(windows.get(2).focused, true);
  assert.equal(calls.filter(call => call.operation === 'createWindow').length, 1);
  await controller.reconcile();
  await controller.windowClosed(1);
  assert.equal(calls.filter(call => call.operation === 'createWindow').length, 1);
});

test('explicit window-close evidence takes precedence over a prior detach', async () => {
  const { controller, api, tabs, windows, calls } = await launched();
  const original = controller.state().slots.gmail;
  controller.markDetached(original, 1);
  await api.tabs.move(original, { windowId: 2, index: -1 });
  windows.delete(1);
  controller.markWindowClosing(1);
  const previousCalls = calls.length;
  await controller.windowClosed(1);
  await controller.reconcile();
  assert.equal(controller.state().active, false);
  assert.equal(calls.length, previousCalls);
  assert.equal(tabs.get(original).windowId, 2);
  assert.equal(tabs.get(original).groupId, -1);
});

test('a missing owner with no witnessed detach does not create a window', async () => {
  const { controller, api, windows, calls } = await launched();
  await api.tabs.move(controller.state().slots.gmail, { windowId: 2, index: -1 });
  windows.delete(1);
  const previousCalls = calls.length;
  await controller.windowClosed(1);
  assert.equal(controller.state().active, false);
  assert.equal(calls.length, previousCalls);
});

test('service-worker restart preserves bindings without creating duplicate tabs', async () => {
  const { controller, api, tabs } = await launched();
  const state = controller.state();
  const restarted = new EssentialsController(api);
  await restarted.init();
  await restarted.reconcile();
  assert.equal(tabs.size, 1);
  assert.deepEqual(restarted.state().slots, state.slots);
  assert.equal(restarted.state().groupId, state.groupId);
});

test('reload recovery rebinds existing tabs and restores drag-out and outside-navigation protection', async () => {
  const entries = [createEntry('https://mail.google.com/#inbox', 'Gmail', 'gmail'),
    createEntry('https://acme.odoo.com/web', 'Odoo', 'odoo')];
  const chrome = await launched(entries);
  const previous = chrome.controller.state();
  const controller = await reloadController(chrome);
  assert.equal(await controller.adoptRestoredGroup(undefined, { recoverAfterReload: true }), true);
  await controller.reconcile();
  assert.deepEqual(controller.state().slots, previous.slots);
  assert.equal(chrome.tabs.size, 2);
  await chrome.api.tabs.ungroup(previous.slots.gmail);
  await controller.reconcile();
  assert.notEqual(controller.state().slots.gmail, previous.slots.gmail);
  assert.equal(chrome.tabs.get(previous.slots.gmail).groupId, -1);
  await chrome.api.tabs.update(previous.slots.odoo, { url: 'https://outside.example/article' });
  await controller.reconcile();
  assert.notEqual(controller.state().slots.odoo, previous.slots.odoo);
  assert.equal(chrome.tabs.get(previous.slots.odoo).url, 'https://outside.example/article');
  assert.equal(chrome.tabs.get(previous.slots.odoo).groupId, -1);
  assert.equal(chrome.tabs.get(controller.state().slots.odoo).url, 'https://acme.odoo.com/web');
  assert.equal(controller.state().entries.length, 2);
});

test('recovery completes exact URL matches before binding one changed route on the same host', async () => {
  const entries = [createEntry('https://mail.google.com/mail/u/0/#inbox', 'First account', 'first'),
    createEntry('https://mail.google.com/mail/u/1/#inbox', 'Second account', 'second')];
  const chrome = await launched(entries);
  const old = chrome.controller.state().slots;
  await chrome.api.tabs.update(old.first, { url: entries[1].lastValidUrl });
  await chrome.api.tabs.update(old.second, { url: 'https://mail.google.com/mail/u/0/#sent' });
  const controller = await reloadController(chrome);
  assert.equal(await controller.adoptRestoredGroup(undefined, { recoverAfterReload: true }), true);
  assert.deepEqual(controller.state().slots, { second: old.first, first: old.second });
  await controller.reconcile();
  assert.equal(controller.state().entries.find(entry => entry.id === 'first').lastValidUrl,
    'https://mail.google.com/mail/u/0/#sent');
  assert.equal(controller.state().entries.find(entry => entry.id === 'second').lastValidUrl, entries[1].lastValidUrl);
  assert.equal(chrome.tabs.size, 2);
});

test('a unique named group with only outside or sign-in pages recovers without saving those URLs', async () => {
  for (const currentUrl of ['https://outside.example/article', 'https://accounts.google.com/ServiceLogin']) {
    const chrome = await launched();
    const original = chrome.controller.state().slots.gmail;
    await chrome.api.tabs.update(original, { url: currentUrl });
    const controller = await reloadController(chrome);
    assert.equal(await controller.adoptRestoredGroup(undefined, { recoverAfterReload: true }), true);
    assert.deepEqual(controller.state().slots, {});
    assert.equal(chrome.tabs.get(original).groupId, -1);
    assert.equal(chrome.tabs.get(original).url, currentUrl);
    assert.equal(chrome.tabs.size, 1, 'Adoption itself never launches tabs');
    await controller.reconcile();
    assert.equal(controller.state().entries[0].lastValidUrl, 'https://mail.google.com/#inbox');
    assert.equal(chrome.tabs.get(controller.state().slots.gmail).url, 'https://mail.google.com/#inbox');
    assert.equal(chrome.tabs.size, 2);
    assert.equal(chrome.windows.size, 2, 'Recovery never opens another browser window');
  }
});

test('ambiguous changed routes on one app host remain working tabs and keep saved account URLs intact', async () => {
  const entries = [createEntry('https://mail.google.com/mail/u/0/#inbox', 'First account', 'first'),
    createEntry('https://mail.google.com/mail/u/1/#inbox', 'Second account', 'second')];
  const chrome = await launched(entries);
  const old = chrome.controller.state().slots;
  await chrome.api.tabs.update(old.first, { url: 'https://mail.google.com/mail/u/0/#sent' });
  await chrome.api.tabs.update(old.second, { url: 'https://mail.google.com/mail/u/1/#drafts' });
  const controller = await reloadController(chrome);
  assert.equal(await controller.adoptRestoredGroup(undefined, { recoverAfterReload: true }), true);
  assert.deepEqual(controller.state().slots, {});
  assert.equal(chrome.tabs.get(old.first).groupId, -1);
  assert.equal(chrome.tabs.get(old.second).groupId, -1);
  await controller.reconcile();
  assert.deepEqual(controller.state().entries, entries);
  assert.equal(chrome.tabs.size, 4);
});

test('recovery picks the strongest exact match and leaves a weaker same-name native group alone', async () => {
  const entries = [createEntry('https://mail.google.com/', 'Gmail', 'gmail'),
    createEntry('https://acme.odoo.com/', 'Odoo', 'odoo')];
  const chrome = await launched(entries);
  const previous = chrome.controller.state();
  await chrome.api.tabs.update(previous.slots.odoo, { url: 'https://outside.example/' });
  const stronger = [];
  for (const entry of entries) stronger.push(await chrome.api.tabs.create({
    windowId: 2, url: entry.lastValidUrl, index: -1, active: false,
  }));
  const strongerId = await chrome.api.tabs.group({ tabIds: stronger.map(tab => tab.id), createProperties: { windowId: 2 } });
  await chrome.api.tabGroups.update(strongerId, { title: 'Essentials', color: 'blue' });
  const controller = await reloadController(chrome);
  assert.equal(await controller.adoptRestoredGroup(1, { recoverAfterReload: true }), true);
  assert.equal(controller.state().groupId, strongerId);
  assert.equal(controller.state().ownerWindowId, 2);
  assert.equal(chrome.tabs.get(previous.slots.gmail).groupId, previous.groupId);
  assert.equal(chrome.tabs.get(previous.slots.odoo).groupId, previous.groupId);
});

test('equally plausible same-name groups stay untouched instead of guessing ownership', async () => {
  const chrome = await launched();
  const previous = chrome.controller.state();
  const duplicate = await chrome.api.tabs.create({ windowId: 2,
    url: previous.entries[0].lastValidUrl, index: 0, active: false });
  const duplicateGroup = await chrome.api.tabs.group({ tabIds: [duplicate.id], createProperties: { windowId: 2 } });
  await chrome.api.tabGroups.update(duplicateGroup, { title: 'Essentials', color: 'blue' });
  const controller = await reloadController(chrome);
  assert.equal(await controller.adoptRestoredGroup(1, { recoverAfterReload: true }), false);
  assert.equal(controller.state().active, false);
  assert.equal(chrome.tabs.get(previous.slots.gmail).groupId, previous.groupId);
  assert.equal(chrome.tabs.get(duplicate.id).groupId, duplicateGroup);
  assert.equal(chrome.tabs.size, 2);
});

test('recovery leaves closed saved groups, unrelated native groups, and empty saved lists alone', async () => {
  const chrome = await launched();
  await chrome.controller.close();
  const unrelated = await chrome.api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 0, active: false });
  const unrelatedGroup = await chrome.api.tabs.group({ tabIds: [unrelated.id], createProperties: { windowId: 1 } });
  await chrome.api.tabGroups.update(unrelatedGroup, { title: 'Research', color: 'green' });
  const controller = await reloadController(chrome);
  const beforeCalls = chrome.calls.length;
  assert.equal(await controller.adoptRestoredGroup(undefined, { recoverAfterReload: true }), false);
  await controller.reconcile();
  assert.equal(chrome.calls.length, beforeCalls);
  assert.equal(chrome.tabs.get(unrelated.id).groupId, unrelatedGroup);
  await chrome.api.tabGroups.update(unrelatedGroup, { title: 'Essentials' });
  controller.entries = [];
  assert.equal(await controller.adoptRestoredGroup(undefined, { recoverAfterReload: true }), false);
  assert.equal(chrome.tabs.get(unrelated.id).groupId, unrelatedGroup);
});

test('manual adoption still requires an exact saved URL', async () => {
  const chrome = await launched();
  const original = chrome.controller.state().slots.gmail;
  await chrome.api.tabs.update(original, { url: 'https://mail.google.com/#sent' });
  const controller = await reloadController(chrome);
  assert.equal(await controller.adoptRestoredGroup(1), false);
  assert.equal(controller.state().active, false);
  assert.equal(chrome.tabs.get(original).groupId, chrome.controller.state().groupId);
});

test('interrupted reload cleanup retries without adding leftover working pages as new saved entries', async () => {
  const clock = fakeClock();
  const chrome = await launched();
  const original = chrome.controller.state().slots.gmail;
  await chrome.api.tabs.update(original, { url: 'https://outside.example/article' });
  const controller = await reloadController(chrome, { now: clock.now });
  const originalUngroup = chrome.api.tabs.ungroup;
  chrome.api.tabs.ungroup = async () => { throw new Error('Tabs cannot be edited while dragging.'); };
  await assert.rejects(controller.adoptRestoredGroup(undefined, { recoverAfterReload: true }), /dragging/);
  assert.ok(controller.runtime.fresh[original]);
  assert.equal(controller.state().entries.length, 1);
  clock.advance(5000);
  chrome.api.tabs.ungroup = originalUngroup;
  await controller.reconcile();
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  assert.equal(controller.state().entries[0].lastValidUrl, 'https://mail.google.com/#inbox');
  assert.equal(chrome.tabs.get(original).groupId, -1);
  assert.equal(chrome.tabs.size, 2);
});

test('dragging in an existing tab saves it at its physical position; reordering persists', async () => {
  const clock = fakeClock();
  const entries = [createEntry('https://mail.google.com/', 'Gmail', 'gmail'),
    createEntry('https://acme.odoo.com/', 'Odoo', 'odoo')];
  const { controller, api, data } = await launched(entries, { now: clock.now });
  const added = await api.tabs.create({ windowId: 1, url: 'https://messages.google.com/web', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS);
  await controller.reconcile();
  assert.equal(controller.state().entries[1].allowedHosts[0], 'messages.google.com');
  const ids = controller.state().entries.map(e => e.id).reverse();
  await controller.reorder(ids);
  await controller.reconcile();
  assert.deepEqual(controller.state().entries.map(e => e.id), ids);
  assert.deepEqual(data.local.config.entries.map(e => e.id), ids);
});

test('a dropped tab stays unsaved until its position has been quiet for the settle period', async () => {
  const clock = fakeClock();
  const requested = [];
  const { controller, api, data } = await launched(undefined, {
    now: clock.now, requestReconcile: delay => requested.push(delay),
  });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  assert.equal(data.local.config.entries.length, 1);
  assert.ok(requested[0] >= DROP_SETTLE_MS);
  clock.advance(DROP_SETTLE_MS - 1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  clock.advance(1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
  assert.equal(data.local.config.entries.length, 2);
  assert.equal(controller.runtime.candidates[added.id], undefined);
});

test('passing through the group without staying never adds a saved entry', async () => {
  const clock = fakeClock();
  const { controller, api, data } = await launched(undefined, { now: clock.now });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(400);
  await api.tabs.ungroup(added.id);
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  assert.equal(data.local.config.entries.length, 1);
  assert.equal(controller.runtime.candidates[added.id], undefined);
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS - 1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  clock.advance(1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
});

test('moving a pending tab within the group restarts its settle clock', async () => {
  const clock = fakeClock();
  const { controller, api } = await launched(undefined, { now: clock.now });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS - 1);
  await api.tabs.move(added.id, { index: 0 });
  controller.markTabActivity(added.id);
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS - 1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  clock.advance(1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
  assert.equal(controller.state().entries[0].lastValidUrl, 'https://example.com/');
});

test('Chrome rejecting tab edits during a drag keeps the candidate unsaved for a later retry', async () => {
  const clock = fakeClock();
  const { controller, api, tabs } = await launched(undefined, { now: clock.now });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS);
  const originalMove = api.tabs.move;
  api.tabs.move = async () => { throw new Error('Tabs cannot be edited right now (user may be dragging a tab).'); };
  await assert.rejects(controller.reconcile(), /dragging/);
  assert.equal(controller.state().entries.length, 1);
  assert.ok(controller.runtime.candidates[added.id]);
  assert.equal(tabs.get(added.id).groupId, controller.state().groupId);
  api.tabs.move = originalMove;
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
});

test('a failed candidate tab update commits no membership and succeeds once on retry', async () => {
  const clock = fakeClock();
  const { controller, api, tabs, data } = await launched(undefined, { now: clock.now });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  const before = controller.state();
  const savedBefore = structuredClone(data.local.config);
  clock.advance(DROP_SETTLE_MS);
  const originalUpdate = api.tabs.update;
  api.tabs.update = async (id, changes) => {
    if (id === added.id && changes.autoDiscardable === false) throw new Error('Tab update temporarily unavailable.');
    return originalUpdate(id, changes);
  };
  await assert.rejects(controller.reconcile(), /temporarily unavailable/);
  assert.deepEqual(controller.state().entries, before.entries);
  assert.deepEqual(controller.state().slots, before.slots);
  assert.deepEqual(data.local.config, savedBefore);
  assert.ok(controller.runtime.candidates[added.id]);
  assert.equal(tabs.get(added.id).groupId, before.groupId);
  api.tabs.update = originalUpdate;
  await controller.reconcile();
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
  assert.equal(Object.values(controller.state().slots).filter(id => id === added.id).length, 1);
  assert.equal(data.local.config.entries.length, 2);
  assert.equal(controller.runtime.candidates[added.id], undefined);
  assert.equal(tabs.size, 2);
});

test('a protected tab returned after Chrome rejects restoration retains its original binding', async () => {
  const clock = fakeClock();
  const entries = [createEntry('https://mail.google.com/', 'Gmail', 'gmail'),
    createEntry('https://acme.odoo.com/', 'Odoo', 'odoo')];
  const { controller, api, tabs } = await launched(entries, { now: clock.now });
  const original = controller.state().slots.gmail;
  const originalGroup = controller.state().groupId;
  await api.tabs.ungroup(original);
  const originalCreate = api.tabs.create;
  api.tabs.create = async () => { throw new Error('Tabs cannot be edited right now (user may be dragging a tab).'); };
  await assert.rejects(controller.reconcile(), /dragging/);
  await api.tabs.group({ tabIds: [original], groupId: originalGroup });
  api.tabs.create = originalCreate;
  clock.advance(DROP_SETTLE_MS);
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS);
  await controller.reconcile();
  assert.equal(controller.state().slots.gmail, original);
  assert.equal(controller.state().entries.length, 2);
  assert.equal(tabs.size, 2);
});

test('a tab that moves while the editability probe awaits must settle at its new position', async () => {
  const clock = fakeClock();
  const { controller, api, data } = await launched(undefined, { now: clock.now });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS);
  const originalMove = api.tabs.move;
  api.tabs.move = async (id, properties) => {
    await originalMove(id, properties);
    return originalMove(id, { index: 0 });
  };
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  assert.equal(data.local.config.entries.length, 1);
  assert.equal(controller.runtime.candidates[added.id].index, 0);
  api.tabs.move = originalMove;
  clock.advance(DROP_SETTLE_MS);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
  assert.equal(controller.state().entries[0].lastValidUrl, 'https://example.com/');
});

test('a movement event during the probe restarts settling even if the final index is unchanged', async () => {
  const clock = fakeClock();
  const { controller, api } = await launched(undefined, { now: clock.now });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS);
  const originalMove = api.tabs.move;
  api.tabs.move = async (id, properties) => {
    const tab = await originalMove(id, properties);
    clock.advance(1);
    controller.markTabActivity(id);
    return tab;
  };
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  api.tabs.move = originalMove;
  clock.advance(DROP_SETTLE_MS - 1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  clock.advance(1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
});

test('an interrupted replacement can retry while the original stays detached', async () => {
  const { controller, api, tabs } = await launched();
  const original = controller.state().slots.gmail;
  await api.tabs.move(original, { windowId: 2, index: -1 });
  const originalCreate = api.tabs.create;
  api.tabs.create = async () => { throw new Error('Tabs cannot be edited while dragging.'); };
  await assert.rejects(controller.reconcile(), /dragging/);
  assert.equal(controller.state().slots.gmail, original);
  api.tabs.create = originalCreate;
  await controller.reconcile();
  assert.notEqual(controller.state().slots.gmail, original);
  assert.equal(tabs.get(original).windowId, 2);
  assert.equal(tabs.get(original).groupId, -1);
  assert.equal(controller.state().entries.length, 1);
  assert.equal(tabs.size, 2);
});

test('reordering already-saved members persists immediately without a drop delay', async () => {
  const clock = fakeClock();
  const entries = [createEntry('https://mail.google.com/', 'Gmail', 'gmail'),
    createEntry('https://acme.odoo.com/', 'Odoo', 'odoo')];
  const { controller, api, data } = await launched(entries, { now: clock.now });
  await api.tabs.move(controller.state().slots.odoo, { index: 0 });
  await controller.reconcile();
  assert.deepEqual(controller.state().entries.map(entry => entry.id), ['odoo', 'gmail']);
  assert.deepEqual(data.local.config.entries.map(entry => entry.id), ['odoo', 'gmail']);
  assert.deepEqual(controller.runtime.candidates, {});
});

test('disabling drag-to-add ejects a dropped tab while explicit Add still works', async () => {
  const { controller, api, tabs } = await launched(undefined, { acceptDrops: false });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  assert.equal(tabs.get(added.id).groupId, -1);
  await controller.addTab(added.id);
  assert.equal(controller.state().entries.length, 2);
});

test('a different workspace must release a protected tab before this group can adopt it', async () => {
  const clock = fakeClock();
  let claimedTab;
  const { controller, api, tabs } = await launched(undefined, {
    now: clock.now, isClaimedElsewhere: id => id === claimedTab,
  });
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  claimedTab = added.id;
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS + 1);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 1);
  assert.equal(tabs.get(added.id).groupId, controller.state().groupId);
  assert.equal(controller.runtime.candidates[added.id], undefined);
  claimedTab = undefined;
  await controller.reconcile();
  clock.advance(DROP_SETTLE_MS);
  await controller.reconcile();
  assert.equal(controller.state().entries.length, 2);
});

test('a newly opened tab inherited into the group is routed out without being saved', async () => {
  const { controller, api, tabs } = await launched();
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await controller.created(added);
  await api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  await controller.reconcile();
  assert.equal(tabs.get(added.id).groupId, -1);
  assert.equal(controller.state().entries.length, 1);
});

test('new-tab protection survives a delayed first reconciliation', async () => {
  const chrome = fakeChrome([createEntry('https://mail.google.com/', 'Gmail', 'gmail')]);
  let now = 1000;
  const controller = new EssentialsController(chrome.api, { now: () => now });
  await controller.init();
  await controller.launch(1, false);
  const added = await chrome.api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await controller.created(added);
  await chrome.api.tabs.group({ tabIds: [added.id], groupId: controller.state().groupId });
  now = 3000;
  await controller.reconcile();
  assert.equal(chrome.tabs.get(added.id).groupId, -1);
  assert.equal(controller.state().entries.length, 1);
});

test('deliberate about:blank navigation from a settled app is outside its boundary', async () => {
  const { controller, api, tabs } = await launched();
  await controller.reconcile();
  const original = controller.state().slots.gmail;
  await api.tabs.update(original, { url: 'about:blank' });
  await controller.reconcile();
  assert.notEqual(controller.state().slots.gmail, original);
  assert.equal(tabs.get(original).url, 'about:blank');
  assert.equal(tabs.get(original).groupId, -1);
  assert.equal(tabs.get(controller.state().slots.gmail).url, 'https://mail.google.com/#inbox');
});

test('automatically derived long page titles do not block adding an essential', async () => {
  const { controller, api } = await launched();
  const added = await api.tabs.create({ windowId: 1, url: 'https://example.com/', index: 1, active: false });
  await api.tabs.update(added.id, { title: 'A long article or mail subject '.repeat(8) });
  await controller.addTab(added.id);
  assert.equal(controller.state().entries.length, 2);
  assert.ok(controller.state().entries[1].label.length <= 100);
});
