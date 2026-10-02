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
const artifactDir = path.join(root, 'output', 'playwright', `reload-${Date.now()}`);
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
async function startBrowser({ restoreLastSession = false } = {}) {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', headless: process.env.HEADED !== '1',
    viewport: { width: 1440, height: 1000 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
      '--no-proxy-server', '--host-resolver-rules=MAP *.localhost 127.0.0.1',
      ...(restoreLastSession ? ['--restore-last-session'] : [])],
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

async function reloadExtension() {
  await control.evaluate(() => chrome.runtime.reload()).catch((error) => {
    if (!/closed|context.*destroyed/i.test(error.message)) throw error;
  });
  control = await context.newPage();
  await until('reloaded extension options available', async () => {
    if (control.isClosed()) control = await context.newPage();
    return control.goto(`chrome-extension://${extensionId}/options.html`, { timeout: 2000 })
      .then(() => true, () => false);
  });
}

async function replacement(workspaceId, entryId, oldTabId) {
  return until(`replacement in ${workspaceId}`, async () => {
    const current = await state(workspaceId);
    const id = current.slots[entryId];
    const live = Number.isInteger(id) ? await tab(id) : null;
    return current.active && id !== oldTabId && live?.groupId === current.groupId &&
      live.windowId === current.ownerWindowId && live.status === 'complete' ? current : false;
  });
}

try {
  await startBrowser();
  // Command-line loading bypasses Developer Mode once. Reload is a genuine
  // unpacked update only with Developer Mode enabled in this throwaway profile.
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions');
  await extensions.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await extensions.close();
  await command('addUrl', { url: `${sites.app}/app/primary-a`, label: 'Primary A' });
  await command('addUrl', { url: `${sites.app}/app/primary-b`, label: 'Primary B' });
  const customId = await createGroup('Research', 'purple');
  await command('addUrl', { workspaceId: customId, url: `${sites.app}/app/research-a`, label: 'Research A' });
  await command('addUrl', { workspaceId: customId, url: `${sites.app}/app/research-b`, label: 'Research B' });
  const closedId = await createGroup('Closed saved group', 'grey');
  await command('addUrl', { workspaceId: closedId, url: `${sites.app}/app/closed`, label: 'Stay closed' });
  await command('close', { workspaceId: closedId });
  const destination = await control.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: false }));
  const custom = await ready(customId);
  await control.evaluate(({ groupId, windowId }) => chrome.tabGroups.move(groupId, { windowId, index: -1 }),
    { groupId: custom.groupId, windowId: destination.id });
  await until('custom owner settled', async () => (await state(customId)).ownerWindowId === destination.id);
  const beforeReload = await Promise.all(['essentials', customId].map(state));
  const closedBefore = await state(closedId);

  await reloadExtension();
  for (const before of beforeReload) {
    const after = await ready(before.selectedGroupId);
    assert.deepEqual(after.slots, before.slots);
    assert.deepEqual(after.entries, before.entries);
    assert.equal(after.ownerWindowId, before.ownerWindowId);
    assert.equal(after.groupId, before.groupId);
  }
  assert.equal((await state(closedId)).active, false);
  assert.deepEqual((await state(closedId)).entries, closedBefore.entries);
  note('unpacked reload resumes open primary/custom groups with the same tabs and owner windows');
  note('reload keeps saved groups that were closed inactive');

  for (const workspaceId of ['essentials', customId]) {
    let current = await state(workspaceId);
    const otherId = workspaceId === 'essentials' ? customId : 'essentials';
    const otherBefore = await state(otherId);
    const entryId = current.entries[0].id;
    const detachedId = current.slots[entryId];
    const ownerId = current.ownerWindowId;
    await control.evaluate(tabId => chrome.windows.create({ tabId, focused: false }), detachedId);
    current = await replacement(workspaceId, entryId, detachedId);
    assert.equal(current.ownerWindowId, ownerId);
    assert.ok(await tab(detachedId));
    const exitedId = current.slots[entryId];
    await control.evaluate(({ id, url }) => chrome.tabs.update(id, { url }),
      { id: exitedId, url: `${sites.outside}/exit-${workspaceId}` });
    current = await replacement(workspaceId, entryId, exitedId);
    assert.equal((await tab(exitedId)).groupId, -1);
    assert.equal((await tab(exitedId)).url, `${sites.outside}/exit-${workspaceId}`);
    assert.deepEqual((await state(otherId)).slots, otherBefore.slots);
    assert.deepEqual((await state(otherId)).entries, otherBefore.entries);
    note(`reload immediately protects drag-out and domain exits in ${current.groupName}`);
  }

  // Reproduce the aftermath of the old broken reload: visible native groups,
  // saved configuration, and no active session binding. Pages can change then.
  const primaryBeforeInactive = await state();
  const customBeforeInactive = await state(customId);
  await stopWorker();
  await control.evaluate(() => chrome.storage.session.clear());
  assert.equal((await state()).active, false);
  assert.equal((await state(customId)).active, false);
  const inactiveTargets = [];
  for (const [index, entry] of primaryBeforeInactive.entries.slice(0, 1).entries()) {
    const id = primaryBeforeInactive.slots[entry.id];
    const url = `${sites.app}/app/changed-${index}`;
    await control.evaluate(({ id, url }) => chrome.tabs.update(id, { url }),
      { id, url });
    inactiveTargets.push({ id, url });
  }
  for (const [index, entry] of customBeforeInactive.entries.entries()) {
    const id = customBeforeInactive.slots[entry.id];
    const url = `${sites.outside}/inactive-${index}`;
    await control.evaluate(({ id, url }) => chrome.tabs.update(id, { url }),
      { id, url });
    inactiveTargets.push({ id, url });
  }
  await until('inactive pages finish navigating', async () => {
    const pages = await Promise.all(inactiveTargets.map(target => tab(target.id)));
    return pages.every((page, index) => page?.status === 'complete' && page.url === inactiveTargets[index].url);
  });
  await reloadExtension();
  const primaryRecovered = await ready('essentials');
  assert.equal(primaryRecovered.ownerWindowId, primaryBeforeInactive.ownerWindowId);
  assert.deepEqual(primaryRecovered.slots, primaryBeforeInactive.slots);
  assert.deepEqual(primaryRecovered.entries.map(entry => entry.lastValidUrl),
    primaryBeforeInactive.entries.map((entry, index) => index === 0 ? `${sites.app}/app/changed-${index}` : entry.lastValidUrl));
  note('reload recovers live app tabs whose valid URLs changed while protection was inactive');
  const customRecovered = await ready(customId);
  assert.equal(customRecovered.ownerWindowId, customBeforeInactive.ownerWindowId);
  assert.deepEqual(customRecovered.entries, customBeforeInactive.entries);
  for (const entry of customBeforeInactive.entries) {
    const original = await tab(customBeforeInactive.slots[entry.id]);
    assert.ok(original);
    assert.equal(original.groupId, -1);
    assert.notEqual(customRecovered.slots[entry.id], original.id);
    assert.equal((await tab(customRecovered.slots[entry.id])).url, entry.lastValidUrl);
  }
  assert.equal((await state(closedId)).active, false);
  note('reload repairs an open group with only outside pages, preserving originals and closed groups');

  const persisted = (await snapshot()).states;
  await stopBrowser('trace.zip');
  await startBrowser({ restoreLastSession: true });
  const restoredNativeGroups = await control.evaluate(() => chrome.tabGroups.query({}));
  assert.ok(restoredNativeGroups.some(group => group.title === 'Essentials'), 'Chrome restored the native primary group');
  assert.ok(restoredNativeGroups.some(group => group.title === 'Research'), 'Chrome restored the native custom group');
  for (const before of persisted) {
    const after = await state(before.selectedGroupId);
    assert.equal(after.active, false);
    assert.deepEqual(after.entries, before.entries);
  }
  note('full browser session restore keeps native groups visible and protection dormant until launch');
  await writeFile(path.join(artifactDir, 'result.json'), JSON.stringify({ ok: true, passed,
    browser: context.browser()?.version(), artifactDir }, null, 2));
  process.stdout.write(`Artifacts: ${artifactDir}\n`);
} catch (error) {
  const diagnostic = control && !control.isClosed() ? await snapshot().catch(failure => ({ diagnosticError: failure.message })) : null;
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
