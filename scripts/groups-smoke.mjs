import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSites } from '../tests/fixtures/browser-sites.mjs';

// Isolated real-browser integration checks. Native tab-strip gestures are modeled
// with Chrome's own tab/group APIs; no personal Chrome profile is accessed.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.resolve(root, process.env.EXTENSION_DIR || 'extension');
const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
const artifactDir = path.join(root, 'output', 'playwright', `groups-${Date.now()}`);
await mkdir(artifactDir, { recursive: true });
const profileDir = await mkdtemp(path.join(artifactDir, 'profile-'));
const sites = await startFixtureSites();
const passed = [];
let context;
let control;
let extensionId;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const note = (label) => { passed.push(label); process.stdout.write(`PASS ${label}\n`); };
async function until(label, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
async function command(type, fields = {}) {
  const reply = await control.evaluate((payload) => chrome.runtime.sendMessage(payload), { type, ...fields });
  assert.equal(reply?.ok, true, `${type}: ${reply?.error || JSON.stringify(reply)}`);
  return reply;
}
const state = (workspaceId = 'essentials') => command('getState', { workspaceId });
const tabs = () => control.evaluate(() => chrome.tabs.query({}));
const tab = (id) => control.evaluate((tabId) => chrome.tabs.get(tabId).catch(() => null), id);
async function snapshot() {
  const overview = await state();
  return {
    states: await Promise.all(overview.groups.map((group) => state(group.id))),
    tabs: await tabs(),
    nativeGroups: await control.evaluate(() => chrome.tabGroups.query({})),
    storage: await control.evaluate(() => chrome.storage.local.get('config')),
  };
}
async function startBrowser() {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', headless: process.env.HEADED !== '1',
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
      '--no-proxy-server', '--host-resolver-rules=MAP *.localhost 127.0.0.1'],
  });
  context.setDefaultTimeout(15000);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/${manifest.options_ui?.page || manifest.options_page || 'options.html'}`);
}
async function stopBrowser(traceName) {
  await context.tracing.stop({ path: path.join(artifactDir, traceName) });
  await context.close();
  context = null;
}
async function ready(workspaceId) {
  return until(`ready ${workspaceId}`, async () => {
    const current = await state(workspaceId);
    const live = await Promise.all(current.entries.map((entry) => tab(current.slots[entry.id])));
    return current.active && live.length && live.every((item) => item?.groupId === current.groupId &&
      item.windowId === current.ownerWindowId && item.status === 'complete') ? current : false;
  });
}
async function ordered(windowId, workspaceIds) {
  return until(`managed order ${workspaceIds.join(',')}`, async () => {
    const states = await Promise.all(workspaceIds.map((id) => state(id)));
    const all = (await tabs()).filter((item) => item.windowId === windowId).sort((a, b) => a.index - b.index);
    let index = all.filter((item) => item.pinned).length;
    for (const current of states) {
      if (!current.active || current.ownerWindowId !== windowId) continue;
      const members = all.filter((item) => item.groupId === current.groupId);
      if (members.length !== current.entries.length || members[0]?.index !== index) return false;
      index += members.length;
    }
    return states;
  });
}
async function createGroup(name, color) {
  const reply = await command('createGroup', { name, color });
  const created = reply.groups.find((group) => group.name === name);
  assert.ok(created, `Created ${name} is listed`);
  return created.id;
}
async function stopWorker() {
  const cdp = await context.newCDPSession(control);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const item of updates) versions.set(item.versionId, item);
  });
  await cdp.send('ServiceWorker.enable');
  const version = await until('worker running', () => [...versions.values()].find((item) =>
    item.scriptURL.startsWith(`chrome-extension://${extensionId}/`) && item.runningStatus === 'running'));
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until('worker stopped', () => versions.get(version.versionId)?.runningStatus === 'stopped');
  await cdp.detach();
}

try {
  await startBrowser();
  await state();
  const legacyEntries = [
    { id: 'legacy-one', label: 'Legacy inbox', lastValidUrl: `${sites.app}/app/migrated?q=1#thread`, allowedHosts: ['app.localhost'], authHosts: ['auth.localhost'] },
    { id: 'legacy-two', label: 'Legacy work', lastValidUrl: `${sites.app}/app/migrated-second`, allowedHosts: ['app.localhost'], authHosts: [] },
  ];
  await control.evaluate((entries) => chrome.storage.local.set({ config: { version: 1, entries } }), legacyEntries);
  await stopBrowser('migration-seed-trace.zip');
  await startBrowser();
  let primary = await state();
  assert.deepEqual(primary.entries, legacyEntries);
  assert.equal(primary.selectedGroupId, 'essentials');
  assert.equal(primary.active, false);
  assert.equal(primary.acceptDrops, true);
  assert.equal(primary.groups.length, 1);
  note('version-one configuration migrates all saved values into primary Essentials');

  const ownerWindowId = await control.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
  const unmanaged = await control.evaluate(async ({ windowId, base }) => {
    const pinned = [];
    for (const name of ['pin-a', 'pin-b']) pinned.push(await chrome.tabs.create({ windowId, url: `${base}/${name}`, pinned: true, active: false }));
    const ordinary = [];
    for (const name of ['native-a', 'native-b', 'loose']) ordinary.push(await chrome.tabs.create({ windowId, url: `${base}/${name}`, active: false }));
    const nativeGroups = [];
    for (const [index, item] of ordinary.slice(0, 2).entries()) {
      const groupId = await chrome.tabs.group({ tabIds: [item.id], createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: index === 0 ? 'Other A' : 'Other B', color: 'grey' });
      nativeGroups.push(groupId);
    }
    return { pinned: pinned.map((item) => item.id), ordinary: ordinary.map((item) => item.id), nativeGroups };
  }, { windowId: ownerWindowId, base: sites.outside });
  await command('launch');
  primary = await ready('essentials');
  await ordered(ownerWindowId, ['essentials']);
  assert.equal((await tab(primary.slots['legacy-one'])).index, unmanaged.pinned.length);
  note('primary starts immediately after pinned tabs, ahead of ordinary/native groups');

  const alphaId = await createGroup('Research', 'purple');
  const betaId = await createGroup('Operations', 'green');
  await command('addUrl', { workspaceId: alphaId, url: `${sites.app}/app/research`, label: 'Research app' });
  // The same saved URL in different groups must have independent membership.
  await command('addUrl', { workspaceId: betaId, url: legacyEntries[0].lastValidUrl, label: 'Operations inbox' });
  let alpha = await ready(alphaId);
  let beta = await ready(betaId);
  await ordered(ownerWindowId, ['essentials', alphaId, betaId]);
  assert.equal(alpha.groupName, 'Research');
  assert.equal(alpha.groupColor, 'purple');
  assert.equal(beta.groupColor, 'green');
  assert.notEqual(beta.entries[0].id, primary.entries[0].id);
  assert.notEqual(beta.slots[beta.entries[0].id], primary.slots[primary.entries[0].id]);
  note('named groups have independent entries, colors, slots, and definition order');

  await control.evaluate(({ groupId, index }) => chrome.tabGroups.move(groupId, { index }), { groupId: beta.groupId, index: unmanaged.pinned.length });
  await ordered(ownerWindowId, ['essentials', alphaId, betaId]);
  await control.evaluate(({ tabId, index }) => chrome.tabs.move(tabId, { index }), { tabId: unmanaged.ordinary[2], index: unmanaged.pinned.length });
  await ordered(ownerWindowId, ['essentials', alphaId, betaId]);
  assert.equal((await state()).entries.length, 2);
  assert.equal((await state(alphaId)).entries.length, 1);
  assert.equal((await state(betaId)).entries.length, 1);
  note('ordinary tab and managed-group moves cannot displace primary priority or enroll passersby');

  await control.evaluate(({ groupId, index }) => chrome.tabGroups.move(groupId, { index }), { groupId: unmanaged.nativeGroups[1], index: unmanaged.pinned.length });
  await ordered(ownerWindowId, ['essentials', alphaId, betaId]);
  const nativePositions = await Promise.all(unmanaged.ordinary.slice(0, 2).map(tab));
  assert.ok(nativePositions[1].index < nativePositions[0].index, 'User-defined relative order of unrelated native groups survives');
  assert.equal(nativePositions[0].groupId, unmanaged.nativeGroups[0]);
  assert.equal(nativePositions[1].groupId, unmanaged.nativeGroups[1]);
  note('enforcing managed priority preserves unrelated native groups and their chosen order');

  await command('updateGroup', { workspaceId: alphaId, name: 'Research renamed', color: 'orange', acceptDrops: false });
  alpha = await state(alphaId);
  const visual = await control.evaluate((id) => chrome.tabGroups.get(id), alpha.groupId);
  assert.equal(visual.title, 'Research renamed');
  assert.equal(visual.color, 'orange');
  const ordinary = await control.evaluate(({ windowId, url }) => chrome.tabs.create({ windowId, url, active: false }), { windowId: ownerWindowId, url: `${sites.outside}/explicit-only` });
  await until('ordinary tab loaded', async () => (await tab(ordinary.id))?.status === 'complete');
  await sleep(1600);
  await control.evaluate(({ tabId, groupId }) => chrome.tabs.group({ tabIds: [tabId], groupId }), { tabId: ordinary.id, groupId: alpha.groupId });
  await until('explicit-only group excludes dropped tab', async () => (await tab(ordinary.id))?.groupId === -1);
  assert.equal((await state(alphaId)).entries.length, 1);
  await command('addTab', { workspaceId: alphaId, tabId: ordinary.id });
  alpha = await ready(alphaId);
  assert.equal(alpha.entries.length, 2);
  note('group rename/color update native UI; optional explicit-only mode rejects drops but accepts Add');

  const sourceBeforeCopy = await state();
  await command('addTab', { workspaceId: alphaId, tabId: sourceBeforeCopy.slots['legacy-two'] });
  alpha = await ready(alphaId);
  assert.equal(alpha.entries.length, 3);
  assert.deepEqual((await state()).entries, sourceBeforeCopy.entries);
  assert.deepEqual((await state()).slots, sourceBeforeCopy.slots);
  const copied = alpha.entries.find((entry) => entry.lastValidUrl === legacyEntries[1].lastValidUrl);
  assert.ok(copied);
  assert.notEqual(alpha.slots[copied.id], sourceBeforeCopy.slots['legacy-two']);
  note('explicit Add copies a protected tab to another group without taking its source slot');

  const foreignTabId = primary.slots['legacy-one'];
  await control.evaluate(({ tabId, groupId }) => chrome.tabs.group({ tabIds: [tabId], groupId }), { tabId: foreignTabId, groupId: beta.groupId });
  primary = await until('source group restores moved managed tab', async () => {
    const value = await state();
    return value.slots['legacy-one'] !== foreignTabId && Number.isInteger(value.slots['legacy-one']) ? value : false;
  });
  beta = await until('settled cross-group drop adds independent target membership', async () => {
    const value = await state(betaId);
    return value.entries.length === 2 ? value : false;
  });
  assert.equal((await state()).entries.length, 2);
  assert.equal((await tab(foreignTabId)).groupId, beta.groupId);
  assert.ok(Object.values(beta.slots).includes(foreignTabId));
  assert.equal(Object.values(primary.slots).includes(foreignTabId), false);
  note('a settled cross-group drop keeps source membership and adds an independent target slot');

  const destination = await control.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: false }));
  beta = await state(betaId);
  const betaSlots = { ...beta.slots };
  await control.evaluate(({ groupId, windowId }) => chrome.tabGroups.move(groupId, { windowId, index: -1 }), { groupId: beta.groupId, windowId: destination.id });
  beta = await until('separate group owner follows', async () => {
    const value = await state(betaId);
    return value.ownerWindowId === destination.id ? value : false;
  });
  assert.deepEqual(beta.slots, betaSlots);
  assert.equal((await state()).ownerWindowId, ownerWindowId);
  assert.equal((await state(alphaId)).ownerWindowId, ownerWindowId);
  await ordered(ownerWindowId, ['essentials', alphaId]);
  await ordered(destination.id, [betaId]);
  note('each active group follows its own window without moving other managed groups');

  const primaryBeforeExit = await state();
  const alphaBeforeExit = await state(alphaId);
  const exitEntryId = beta.entries[0].id;
  const exitedTabId = beta.slots[exitEntryId];
  await control.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: exitedTabId, url: `${sites.outside}/operations-exit` });
  beta = await until('outside navigation restores only owning group', async () => {
    const value = await state(betaId);
    return value.slots[exitEntryId] !== exitedTabId && Number.isInteger(value.slots[exitEntryId]) ? value : false;
  });
  beta = await ready(betaId);
  const exitedTab = await tab(exitedTabId);
  assert.equal(exitedTab.windowId, destination.id);
  assert.equal(exitedTab.groupId, -1);
  assert.equal(exitedTab.url, `${sites.outside}/operations-exit`);
  assert.deepEqual((await state()).slots, primaryBeforeExit.slots);
  assert.deepEqual((await state(alphaId)).slots, alphaBeforeExit.slots);
  assert.deepEqual((await state()).entries, primaryBeforeExit.entries);
  assert.deepEqual((await state(alphaId)).entries, alphaBeforeExit.entries);
  note('domain exits keep the original page and repair only their own group across windows');

  const primaryBeforeWake = await state();
  const alphaBeforeWake = await state(alphaId);
  const betaEntryId = beta.entries[0].id;
  const betaTabId = beta.slots[betaEntryId];
  await stopWorker();
  await control.evaluate((id) => chrome.tabs.remove(id), betaTabId);
  beta = await until('worker restores only affected workspace', async () => {
    const value = await state(betaId);
    return value.slots[betaEntryId] !== betaTabId && Number.isInteger(value.slots[betaEntryId]) ? value : false;
  });
  beta = await ready(betaId);
  assert.equal(beta.ownerWindowId, destination.id);
  assert.deepEqual((await state()).entries, primaryBeforeWake.entries);
  assert.deepEqual((await state()).slots, primaryBeforeWake.slots);
  assert.deepEqual((await state(alphaId)).entries, alphaBeforeWake.entries);
  assert.deepEqual((await state(alphaId)).slots, alphaBeforeWake.slots);
  note('worker suspension/restart restores one group without cross-writing another');

  await command('close', { workspaceId: betaId });
  assert.equal((await state(betaId)).active, false);
  assert.equal((await state()).active, true);
  assert.equal((await state(alphaId)).active, true);
  await command('launch', { workspaceId: betaId });
  beta = await ready(betaId);
  assert.equal(beta.entries.length, 2);
  note('group-scoped close and relaunch leave other groups running');

  alpha = await state(alphaId);
  const alphaOpenIds = Object.values(alpha.slots);
  const primaryBeforeDelete = await state();
  const betaBeforeDelete = await state(betaId);
  await command('deleteGroup', { workspaceId: alphaId });
  const afterDelete = await state();
  assert.equal(afterDelete.groups.some((group) => group.id === alphaId), false);
  for (const id of alphaOpenIds) assert.ok(await tab(id), 'Deleting saved group leaves its open page intact');
  assert.deepEqual(afterDelete.entries, primaryBeforeDelete.entries);
  assert.deepEqual((await state(betaId)).entries, betaBeforeDelete.entries);
  assert.deepEqual((await state(betaId)).slots, betaBeforeDelete.slots);
  note('deleting a saved group leaves pages open and preserves every other group');

  await control.screenshot({ path: path.join(artifactDir, 'groups.png'), fullPage: true });
  const persistedStates = await Promise.all((await state()).groups.map((group) => state(group.id)));
  await stopBrowser('trace.zip');
  await startBrowser();
  const restarted = await state();
  assert.equal(restarted.groups.length, persistedStates.length);
  for (const before of persistedStates) {
    const after = await state(before.selectedGroupId);
    assert.deepEqual(after.entries, before.entries);
    assert.equal(after.groupName, before.groupName);
    assert.equal(after.groupColor, before.groupColor);
    assert.equal(after.acceptDrops, before.acceptDrops);
    assert.equal(after.active, false);
  }
  note('browser restart retains independent saved groups/settings without auto-launching');
  await writeFile(path.join(artifactDir, 'result.json'), JSON.stringify({ ok: true, passed, browser: context.browser()?.version(), artifactDir }, null, 2));
  process.stdout.write(`Artifacts: ${artifactDir}\n`);
} catch (error) {
  const diagnostic = control && !control.isClosed() ? await snapshot().catch((failure) => ({ diagnosticError: failure.message })) : null;
  await writeFile(path.join(artifactDir, 'failure.json'), JSON.stringify({ error: error.stack, passed, diagnostic }, null, 2));
  await control?.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
  process.stderr.write(`${error.stack}\nArtifacts: ${artifactDir}\n`);
  process.exitCode = 1;
} finally {
  if (context) {
    await context.tracing.stop({ path: path.join(artifactDir, 'last-trace.zip') }).catch(() => {});
    await context.close().catch(() => {});
  }
  await sites.close();
}
