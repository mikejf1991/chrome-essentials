import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSites } from '../tests/fixtures/browser-sites.mjs';

// Plain Playwright library, not Playwright Test. This always creates a new profile
// under output/playwright, and never connects to a running/user browser.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = path.resolve(root, process.env.EXTENSION_DIR || 'extension');
const artifactDir = path.join(root, 'output', 'playwright', `smoke-${Date.now()}`);
await mkdir(artifactDir, { recursive: true });
const profileDir = await mkdtemp(path.join(artifactDir, 'profile-'));
const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
const sites = await startFixtureSites();
const passed = [];
let context;
let control;
let extensionId;
let cdp;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const note = (label) => {
  passed.push(label);
  process.stdout.write(`PASS ${label}\n`);
};
async function until(label, check, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await check();
    if (last) return last;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}; last result: ${JSON.stringify(last)}`);
}
async function message(type, args = {}) {
  const reply = await control.evaluate((payload) => chrome.runtime.sendMessage(payload), { type, ...args });
  assert.equal(reply?.ok, true, `${type}: ${reply?.error || JSON.stringify(reply)}`);
  return reply;
}
const state = () => message('getState');
const tabs = () => control.evaluate(() => chrome.tabs.query({}));
const tab = (tabId) => control.evaluate((id) => chrome.tabs.get(id).catch(() => null), tabId);
async function pageFor(tabId) {
  const info = await tab(tabId);
  assert.ok(info, `Tab ${tabId} exists`);
  // Restored fixture slots are always the newest page with their saved URL;
  // an older, detached working copy may deliberately remain open at that URL.
  return until(`page for tab ${tabId}`, () => context.pages().findLast((page) => page.url() === info.url));
}
async function slotChanged(entryId, previousTabId) {
  return until(`replacement for ${entryId}`, async () => {
    const current = await state();
    const id = current.slots[entryId];
    if (!id || id === previousTabId) return false;
    const live = await tab(id);
    return live?.groupId === current.groupId && live.windowId === current.ownerWindowId && live.status === 'complete' ? current : false;
  });
}
async function startBrowser() {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: process.env.HEADED !== '1',
    viewport: { width: 1440, height: 1000 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-proxy-server',
      '--host-resolver-rules=MAP *.localhost 127.0.0.1',
    ],
  });
  context.setDefaultTimeout(15000);
  await context.tracing.start({ screenshots: true, snapshots: true });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  control = await context.newPage();
  const optionsPath = manifest.options_ui?.page || manifest.options_page || 'options.html';
  await control.goto(`chrome-extension://${extensionId}/${optionsPath}`);
  await control.waitForLoadState('domcontentloaded');
}

async function stopWorker() {
  cdp = await context.newCDPSession(control);
  const versions = new Map();
  cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  const version = await until('extension worker version', () => [...versions.values()].find((item) =>
    item.scriptURL.startsWith(`chrome-extension://${extensionId}/`) && item.runningStatus === 'running'));
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until('worker stopped', () => versions.get(version.versionId)?.runningStatus === 'stopped');
  await cdp.detach();
  cdp = null;
}

try {
  await startBrowser();
  let current = await state();
  assert.equal(current.entries.length, 0);
  assert.equal(current.active, false);
  assert.equal(current.acceptDrops, true);
  note('fresh profile starts empty and inactive');

  current = await message('addUrl', { url: `${sites.app}/app`, label: 'Fixture app' });
  const firstId = current.entries[0].id;
  current = await until('initial protected tab', async () => {
    const value = await state();
    const live = await tab(value.slots[firstId]);
    return value.active && live?.groupId === value.groupId && live.status === 'complete' ? value : false;
  });
  const initialTabId = current.slots[firstId];
  let ownerWindowId = current.ownerWindowId;
  const initialGroupId = current.groupId;
  await message('launch');
  await message('launch');
  current = await state();
  assert.equal(current.slots[firstId], initialTabId);
  assert.equal(current.groupId, initialGroupId);
  assert.equal((await tabs()).filter((item) => item.groupId === initialGroupId).length, 1);
  note('manual launch creates one group; repeated launch reuses it');

  let appPage = await pageFor(initialTabId);
  await appPage.locator('#same-domain').click();
  await until('committed app URL saved', async () => (await state()).entries[0].lastValidUrl === `${sites.app}/app/detail?id=7#thread`);
  await appPage.locator('#spa').click();
  await until('SPA URL saved', async () => (await state()).entries[0].lastValidUrl === `${sites.app}/app/spa?item=42#detail`);
  await appPage.locator('#hash').click();
  const savedUrl = `${sites.app}/app/spa?item=42#thread-99`;
  await until('hash URL saved', async () => (await state()).entries[0].lastValidUrl === savedUrl);
  note('same-host navigation, SPA history, and hash update the saved URL');

  await appPage.locator('#outside-domain').click();
  current = await slotChanged(firstId, initialTabId);
  const escapedTab = await tab(initialTabId);
  assert.equal(escapedTab.groupId, -1);
  assert.equal(escapedTab.url, `${sites.outside}/outside`);
  assert.equal(current.entries.length, 1, 'Outside navigation must not enroll the escaped tab');
  assert.equal(current.entries[0].lastValidUrl, savedUrl);
  assert.equal((await tab(current.slots[firstId])).url, savedUrl);
  note('outside navigation keeps original tab and restores last valid URL');

  let protectedTabId = current.slots[firstId];
  await control.evaluate((id) => chrome.tabs.remove(id), protectedTabId);
  current = await slotChanged(firstId, protectedTabId);
  assert.equal(current.entries.length, 1);
  note('closing an individual essential recreates its slot');

  protectedTabId = current.slots[firstId];
  await control.evaluate((id) => chrome.tabs.ungroup(id), protectedTabId);
  current = await slotChanged(firstId, protectedTabId);
  assert.equal((await tab(protectedTabId)).groupId, -1);
  assert.equal(current.entries.length, 1);
  note('native ungroup/drag-out retains membership and restores the slot');

  protectedTabId = current.slots[firstId];
  appPage = await pageFor(protectedTabId);
  const popupPromise = context.waitForEvent('page');
  await appPage.locator('#new-link').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  await until('new working tab excluded', async () => {
    const created = (await tabs()).find((item) => item.url === `${sites.outside}/child`);
    return created && created.groupId === -1;
  });
  assert.equal((await state()).entries.length, 1);
  note('new link tab remains outside Essentials and is not saved');

  const existing = await control.evaluate((url) => chrome.tabs.create({ url, active: false }), `${sites.app}/app/second`);
  await until('existing tab loaded outside group', async () => (await tab(existing.id))?.status === 'complete');
  // Crossing the group briefly is not a completed drop.
  await sleep(1500);
  await control.evaluate(({ tabId, groupId }) => chrome.tabs.group({ tabIds: [tabId], groupId }), { tabId: existing.id, groupId: current.groupId });
  // Leave enough time for reconciliation to observe the candidate, but shorter
  // than the deliberate-drop dwell time, so this catches premature adoption.
  await sleep(450);
  await control.evaluate((tabId) => chrome.tabs.ungroup(tabId), existing.id);
  await sleep(1200);
  assert.equal((await state()).entries.length, 1);
  note('transient group crossing does not silently save an ordinary tab');
  await control.evaluate(({ tabId, groupId }) => chrome.tabs.group({ tabIds: [tabId], groupId }), { tabId: existing.id, groupId: current.groupId });
  current = await until('settled tab drop persisted', async () => {
    const value = await state();
    return value.entries.length === 2 ? value : false;
  });
  const secondId = current.entries.find((entry) => entry.id !== firstId).id;
  assert.equal(current.slots[secondId], existing.id);
  note('a settled drop saves an established tab into Essentials');

  const firstLive = await tab(current.slots[firstId]);
  await control.evaluate(({ tabId, index }) => chrome.tabs.move(tabId, { index }), { tabId: existing.id, index: firstLive.index });
  current = await until('reorder persisted', async () => {
    const value = await state();
    return value.entries[0].id === secondId ? value : false;
  });
  await control.screenshot({ path: path.join(artifactDir, 'options.png'), fullPage: true });
  note('reordering tabs persists their saved order');

  const groupDestination = await control.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: false }));
  const beforeGroupMove = { ...current.slots };
  await control.evaluate(({ groupId, windowId }) => chrome.tabGroups.move(groupId, { windowId, index: -1 }), { groupId: current.groupId, windowId: groupDestination.id });
  current = await until('whole group owner follows', async () => {
    const value = await state();
    return value.ownerWindowId === groupDestination.id ? value : false;
  });
  assert.deepEqual(current.slots, beforeGroupMove);
  assert.equal((await tabs()).filter((item) => item.groupId === current.groupId).length, 2);
  ownerWindowId = groupDestination.id;
  note('moving the intact group follows its owner without duplicating slots');

  await control.evaluate(async ({ windowId, groupId }) => {
    const extras = (await chrome.tabs.query({ windowId })).filter((item) => item.groupId !== groupId);
    if (extras.length) await chrome.tabs.remove(extras.map((item) => item.id));
  }, { windowId: ownerWindowId, groupId: current.groupId });
  const lastTabsDestination = await control.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: false }));
  const emptyingWindowId = ownerWindowId;
  await control.evaluate(({ groupId, windowId }) => chrome.tabGroups.move(groupId, { windowId, index: -1 }), { groupId: current.groupId, windowId: lastTabsDestination.id });
  current = await until('whole-group move closes source window safely', async () => {
    const value = await state();
    return value.active && value.ownerWindowId === lastTabsDestination.id ? value : false;
  });
  assert.deepEqual(current.slots, beforeGroupMove);
  assert.equal((await tabs()).some((item) => item.windowId === emptyingWindowId), false);
  ownerWindowId = lastTabsDestination.id;
  note('whole-group ownership follows even when moving its last tabs closes source');

  const detachedPage = await pageFor(existing.id);
  await detachedPage.locator('#note').fill('unsaved detached state');
  await control.evaluate((id) => chrome.windows.create({ tabId: id, focused: false }), existing.id);
  current = await slotChanged(secondId, existing.id);
  assert.equal(current.ownerWindowId, ownerWindowId);
  assert.equal(await detachedPage.locator('#note').inputValue(), 'unsaved detached state');
  assert.notEqual((await tab(existing.id)).windowId, ownerWindowId);
  assert.equal((await tab(current.slots[secondId])).windowId, ownerWindowId);
  note('detaching preserves original page state and restores the owner slot');

  const removedTabId = current.slots[secondId];
  await message('remove', { id: secondId });
  current = await until('explicit removal persisted', async () => {
    const value = await state();
    return value.entries.length === 1 && (await tab(removedTabId))?.groupId === -1 ? value : false;
  });
  assert.ok(await tab(removedTabId));
  note('explicit remove forgets membership and leaves its page open');

  await message('updateEntry', { id: firstId, label: 'Fixture app', allowedHosts: ['app.localhost'], authHosts: ['auth.localhost'] });
  protectedTabId = current.slots[firstId];
  appPage = await pageFor(protectedTabId);
  await appPage.goto(`${sites.app}/needs-auth`);
  await until('auth page visible in slot', async () => (await tab(protectedTabId))?.url === `${sites.auth}/login`);
  current = await state();
  assert.equal(current.slots[firstId], protectedTabId);
  assert.equal(current.entries[0].lastValidUrl, savedUrl);
  assert.equal((await tab(protectedTabId)).groupId, current.groupId);
  await appPage.locator('#return-home').click();
  await until('auth returns to app', async () => (await state()).entries[0].lastValidUrl === `${sites.app}/app/returned`);
  assert.equal((await state()).ownerWindowId, ownerWindowId, 'Owner remains stable before worker suspension');
  note('authentication host exception retains slot without saving login URL');

  await stopWorker();
  await control.evaluate((id) => chrome.tabs.remove(id), protectedTabId);
  current = await slotChanged(firstId, protectedTabId);
  assert.equal(current.ownerWindowId, ownerWindowId, 'Worker restart restores into the same owner');
  assert.equal(current.entries[0].lastValidUrl, `${sites.app}/app/returned`);
  note('service worker restarts on a tab event and retains protection/state');

  const controlTabId = await control.evaluate(async () => (await chrome.tabs.getCurrent()).id);
  await control.evaluate((id) => chrome.windows.create({ tabId: id, focused: false }), controlTabId);
  await control.evaluate((id) => chrome.windows.remove(id), ownerWindowId);
  current = await until('owner window closure respected', async () => {
    const value = await state();
    return !value.active ? value : false;
  });
  assert.equal(current.entries.length, 1);
  assert.equal((await tabs()).some((item) => item.windowId === ownerWindowId), false);
  note('closing owner window does not recreate it or forget saved entries');

  current = await message('launch');
  await until('manual relaunch after owner close', async () => (await state()).active);
  await message('close');
  await until('explicit group close', async () => !(await state()).active);
  assert.equal((await state()).entries.length, 1);
  note('manual relaunch and explicit Close Essentials preserve configuration');

  current = await message('launch');
  const workingWindowId = await control.evaluate(async () => (await chrome.tabs.getCurrent()).windowId);
  const singleWindow = await control.evaluate(() => chrome.windows.create({ url: 'about:blank', focused: false }));
  await control.evaluate(({ groupId, windowId }) => chrome.tabGroups.move(groupId, { windowId, index: -1 }), { groupId: current.groupId, windowId: singleWindow.id });
  current = await until('single-member group moved into its own window', async () => {
    const value = await state();
    return value.ownerWindowId === singleWindow.id ? value : false;
  });
  await control.evaluate(async ({ windowId, groupId }) => {
    const extras = (await chrome.tabs.query({ windowId })).filter((item) => item.groupId !== groupId);
    if (extras.length) await chrome.tabs.remove(extras.map((item) => item.id));
  }, { windowId: singleWindow.id, groupId: current.groupId });
  const soleTabId = current.slots[firstId];
  await stopWorker();
  await control.evaluate(({ tabId, windowId }) => chrome.tabs.move(tabId, { windowId, index: -1 }), { tabId: soleTabId, windowId: workingWindowId });
  current = await slotChanged(firstId, soleTabId);
  assert.notEqual(current.ownerWindowId, workingWindowId);
  assert.notEqual(current.ownerWindowId, singleWindow.id);
  assert.equal((await tab(soleTabId)).windowId, workingWindowId);
  assert.equal((await tabs()).some((item) => item.windowId === singleWindow.id), false);
  note('detaching the sole tab wakes the worker and recreates a separate owner');
  await stopWorker();
  await control.evaluate((id) => chrome.windows.remove(id), current.ownerWindowId);
  await until('explicitly closing a sole-tab owner stays closed', async () => !(await state()).active);
  note('closing a sole-tab owner wakes the worker and stays closed');

  await context.tracing.stop({ path: path.join(artifactDir, 'trace.zip') });
  await context.close();
  context = null;
  await startBrowser();
  current = await state();
  assert.equal(current.active, false);
  assert.equal(current.entries.length, 1);
  assert.equal((await tabs()).some((item) => item.groupId !== -1), false);
  note('full browser restart retains entries without automatically launching');

  await message('addUrl', { url: `${sites.app}/needs-auth`, label: 'Unexpected authentication' });
  current = await until('unexpected authentication pauses restoration', async () => {
    const value = await state();
    return /paused/i.test(value.warning || '') ? value : false;
  });
  const redirectedEntry = current.entries.find((entry) => entry.label === 'Unexpected authentication');
  const redirectedTab = await tab(current.slots[redirectedEntry.id]);
  assert.equal(redirectedTab.url, `${sites.auth}/login`);
  assert.equal(redirectedTab.groupId, current.groupId);
  const countBefore = (await tabs()).length;
  await sleep(1200);
  assert.equal((await tabs()).length, countBefore);
  assert.equal((await state()).entries.length, 2);
  note('unexpected authentication redirect pauses without a restoration loop');
  await writeFile(path.join(artifactDir, 'result.json'), JSON.stringify({ ok: true, passed, browser: context.browser()?.version(), artifactDir }, null, 2));
  process.stdout.write(`Artifacts: ${artifactDir}\n`);
} catch (error) {
  if (control && !control.isClosed()) {
    await control.screenshot({ path: path.join(artifactDir, 'failure.png'), fullPage: true }).catch(() => {});
    const diagnostic = await Promise.allSettled([state(), tabs()]);
    await writeFile(path.join(artifactDir, 'failure.json'), JSON.stringify({ error: error.stack, passed, diagnostic }, null, 2));
  }
  process.stderr.write(`${error.stack}\nArtifacts: ${artifactDir}\n`);
  process.exitCode = 1;
} finally {
  await cdp?.detach().catch(() => {});
  if (context) {
    await context.tracing.stop({ path: path.join(artifactDir, 'last-trace.zip') }).catch(() => {});
    await context.close().catch(() => {});
  }
  await sites.close();
}
