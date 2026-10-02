import { FRESH_TAB_MS } from './controller.js';
import { WorkspacesController } from './workspaces.js';

const controller = new WorkspacesController(chrome, { requestReconcile: schedule });
let queue = controller.init();
let reconcileTimer;
let reconcileAt = Infinity;
let browserStarting = false;

function enqueue(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

function schedule(delay = 180) {
  const due = Date.now() + delay;
  if (reconcileTimer && reconcileAt <= due) return;
  clearTimeout(reconcileTimer);
  reconcileAt = due;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = undefined;
    reconcileAt = Infinity;
    runEvent(() => controller.reconcile());
  }, delay);
}

function runEvent(operation) {
  return enqueue(operation).catch(error => {
    // Chrome temporarily rejects edits during native tab dragging. Keep saved
    // state intact and retry after the drag instead of manufacturing extra tabs.
    if (/cannot be edited|dragging|being dragged|not editable/i.test(error.message || '')) {
      schedule(500);
    } else {
      console.error('Essentials operation failed:', error);
      return enqueue(() => controller.reportError(error)).catch(console.error);
    }
  });
}

async function setupMenus() {
  await chrome.contextMenus.removeAll();
  const definitions = [
    { id: 'add', title: 'Add this tab to saved group', contexts: ['tab', 'page'] },
    { id: 'remove', title: 'Remove this tab from saved group', contexts: ['tab', 'page'] },
    { id: 'launch', title: 'Open saved group', contexts: ['action'] },
    { id: 'close', title: 'Close saved group', contexts: ['action'] },
    { id: 'settings', title: 'Manage saved groups', contexts: ['action'] },
  ];
  for (const group of controller.groups) {
    for (const parentId of ['add', 'launch', 'close']) {
      definitions.push({ id: `${parentId}:${group.id}`, parentId, title: group.name,
        contexts: parentId === 'add' ? ['tab', 'page'] : ['action'] });
    }
  }
  for (const item of definitions) {
    await new Promise((resolve, reject) => chrome.contextMenus.create(item, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve();
    }));
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only extension pages can operate the saved list. There are no content scripts
  // or externally_connectable surfaces.
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) return false;
  if (!message || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Missing Essentials action.' });
    return false;
  }
  enqueue(async () => {
    const state = await controller.dispatch(message, sender.tab?.windowId);
    if (['createGroup', 'updateGroup', 'deleteGroup'].includes(message.type)) await setupMenus();
    return state;
  })
    .then(state => sendResponse({ ok: true, ...state }))
    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

chrome.action.onClicked.addListener(tab => runEvent(async () => {
  const state = await controller.dispatch({ type: 'launch' }, tab.windowId);
  if (state.needsSetup) await chrome.runtime.openOptionsPage();
}));

chrome.contextMenus.onClicked.addListener((info, tab) => runEvent(async () => {
  const menuId = String(info.menuItemId);
  if (menuId === 'settings') return chrome.runtime.openOptionsPage();
  if (menuId === 'remove') {
    const existing = controller.findTab(tab?.id);
    if (existing) await controller.dispatch({ type: 'remove', workspaceId: existing.workspaceId, id: existing.entry.id });
    return;
  }
  const separator = menuId.indexOf(':');
  if (separator === -1) return;
  const action = menuId.slice(0, separator);
  const workspaceId = menuId.slice(separator + 1);
  if (action === 'add') await controller.dispatch({ type: 'addTab', workspaceId, tabId: tab?.id }, tab?.windowId);
  if (action === 'close') await controller.dispatch({ type: 'close', workspaceId });
  if (action === 'launch') {
    const state = await controller.dispatch({ type: 'launch', workspaceId }, tab?.windowId);
    if (state.needsSetup) await chrome.runtime.openOptionsPage();
  }
}));

chrome.tabs.onCreated.addListener(tab => {
  runEvent(() => controller.created(tab)).then(() => schedule());
  // Observe an ordinary new tab outside the group once its initial grouping settles,
  // so a later deliberate drag-in is eligible even if there are no more tab events.
  setTimeout(() => schedule(), FRESH_TAB_MS + 100);
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if ('groupId' in change) controller.markTabActivity(id);
  if ('groupId' in change || 'url' in change || 'status' in change || 'pinned' in change) schedule();
});
chrome.tabs.onMoved.addListener((id, info) => {
  if (info.fromIndex === info.toIndex) return;
  controller.markTabActivity(id);
  schedule();
});
chrome.tabs.onAttached.addListener(() => schedule(350));
chrome.tabs.onDetached.addListener((tabId, info) => {
  controller.markDetached(tabId, info.oldWindowId);
  schedule(350);
});
chrome.tabs.onRemoved.addListener((_tabId, info) => {
  if (info.isWindowClosing) controller.markWindowClosing(info.windowId);
  schedule(250);
});
chrome.tabs.onReplaced.addListener((added, removed) => {
  runEvent(() => controller.replaced(added, removed)).then(() => schedule());
});
chrome.windows.onRemoved.addListener(windowId => {
  runEvent(() => controller.windowClosed(windowId));
});
chrome.tabGroups.onRemoved.addListener(() => schedule(350));
chrome.tabGroups.onMoved.addListener(() => schedule(350));
chrome.tabGroups.onUpdated.addListener(() => schedule());

function navigated(details) {
  if (details.frameId !== 0 || details.documentLifecycle === 'prerender' || details.documentLifecycle === 'cached') return;
  runEvent(() => controller.navigation(details.tabId, details.url)).then(() => schedule());
}
chrome.webNavigation.onCommitted.addListener(navigated);
chrome.webNavigation.onHistoryStateUpdated.addListener(navigated);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(navigated);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'essentials-reconcile') runEvent(() => controller.reconcile());
});
chrome.runtime.onStartup.addListener(() => {
  browserStarting = true;
  runEvent(() => controller.deactivate());
});
chrome.runtime.onInstalled.addListener(details => runEvent(async () => {
  await setupMenus();
  // Unpacked Reload is an extension update, not a browser startup. Its existing
  // groups must keep protection even though Chrome discarded session storage.
  if (details.reason === 'update' && !browserStarting) await controller.resumeOpenGroups();
  if (details.reason === 'install') await chrome.runtime.openOptionsPage();
}));

runEvent(async () => {
  await setupMenus();
  await controller.reconcile();
});
