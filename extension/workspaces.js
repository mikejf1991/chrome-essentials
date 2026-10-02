import { EssentialsController } from './controller.js';
import { normalizeConfig, normalizeRuntime, createGroup, updateGroup, PRIMARY_GROUP_ID, MAX_GROUPS } from './workspaces-model.js';

// Owns the single durable configuration while each group owns its runtime slots.
// background.js serializes all mutations, including events from native gestures.
export class WorkspacesController {
  constructor(api, { now = () => Date.now(), requestReconcile = () => {} } = {}) {
    this.api = api;
    this.now = now;
    this.requestReconcile = requestReconcile;
    this.groups = [];
    this.controllers = new Map();
    this.globalWarning = null;
    this.reloadRecoveryPending = false;
    // Native events can wake the worker while storage is still loading. Retain
    // their evidence now so the first reconciliation interprets closure correctly.
    this.closingWindows = new Set();
    this.detachedFrom = new Map();
  }

  async init() {
    const [saved, session] = await Promise.all([
      this.api.storage.local.get('config'), this.api.storage.session.get('runtime'),
    ]);
    const config = normalizeConfig(saved.config);
    const runtime = normalizeRuntime(session.runtime, config.groups.map(group => group.id));
    this.groups = config.groups;
    for (const group of this.groups) this.attach(group, runtime.groups[group.id]);
    // Preserve the exact pre-upgrade configuration once, before the schema changes.
    // It stays local to the extension and is never added to the source repository.
    if (saved.config && saved.config.version !== 2) {
      const existing = await this.api.storage.local.get('migrationBackupV1');
      if (!existing.migrationBackupV1) await this.api.storage.local.set({ migrationBackupV1: saved.config });
    }
    await this.saveConfig();
    await this.saveRuntime();
  }

  attach(group, runtime) {
    const controller = new EssentialsController(this.api, {
      now: this.now, name: group.name, color: group.color, acceptDrops: group.acceptDrops,
      requestReconcile: this.requestReconcile,
      persistEntries: async entries => { group.entries = entries; await this.saveConfig(); },
      persistSession: async () => this.saveRuntime(),
      isClaimedElsewhere: tabId => [...this.controllers.entries()].some(([id, other]) =>
        id !== group.id && Boolean(other.entryForTab(tabId))),
      isGroupClaimedElsewhere: nativeId => [...this.controllers.entries()].some(([id, other]) =>
        id !== group.id && other.runtime.active && other.runtime.groupId === nativeId),
    });
    controller.hydrate(group.entries, runtime);
    for (const windowId of this.closingWindows) controller.markWindowClosing(windowId);
    for (const [tabId, windowId] of this.detachedFrom) controller.markDetached(tabId, windowId);
    group.entries = controller.entries;
    this.controllers.set(group.id, controller);
    return controller;
  }

  selected(id = PRIMARY_GROUP_ID) {
    const controller = this.controllers.get(id);
    if (!controller) throw new Error('That saved group no longer exists. Select another group.');
    return controller;
  }

  state(selectedGroupId = PRIMARY_GROUP_ID) {
    const controller = this.selected(selectedGroupId);
    const group = this.groups.find(group => group.id === selectedGroupId);
    return { ...controller.state(), selectedGroupId, groupName: group.name, groupColor: group.color,
      acceptDrops: group.acceptDrops,
      warning: [this.globalWarning, controller.state().warning].filter(Boolean).join(' ') || null,
      groups: this.groups.map(group => {
        const current = this.controllers.get(group.id).state();
        return { id: group.id, name: group.name, color: group.color, acceptDrops: group.acceptDrops,
          entryCount: current.entries.length, active: current.active, warning: current.warning };
      }) };
  }

  async saveConfig() {
    await this.api.storage.local.set({ config: { version: 2, groups: this.groups.map(group => ({
      ...group, entries: this.controllers.get(group.id)?.entries ?? group.entries,
    })) } });
  }

  async saveRuntime() {
    const groups = Object.fromEntries([...this.controllers].map(([id, controller]) => [id, controller.runtime]));
    await this.api.storage.session.set({ runtime: { version: 2, groups } });
    const states = [...this.controllers.values()].map(controller => controller.state());
    const active = states.filter(state => state.active).length;
    const warning = this.globalWarning || states.some(state => state.warning);
    await this.api.action.setBadgeText({ text: warning ? '!' : active > 1 ? String(active) : active ? 'ON' : '' });
    await this.api.action.setBadgeBackgroundColor({ color: warning ? '#A45218' : '#2458D3' });
    await this.api.action.setTitle({ title: this.controllers.get(PRIMARY_GROUP_ID)?.runtime.active
      ? 'Show Essentials · right-click for saved groups' : 'Open Essentials · right-click for saved groups' });
    if (active) {
      if (!await this.api.alarms.get('essentials-reconcile')) {
        await this.api.alarms.create('essentials-reconcile', { periodInMinutes: 0.5 });
      }
    } else await this.api.alarms.clear('essentials-reconcile');
  }

  findTab(tabId) {
    for (const [workspaceId, controller] of this.controllers) {
      const entry = controller.entryForTab(tabId);
      if (entry) return { workspaceId, controller, entry };
    }
    return null;
  }

  markWindowClosing(windowId) {
    this.closingWindows.add(windowId);
    for (const controller of this.controllers.values()) controller.markWindowClosing(windowId);
  }
  markDetached(tabId, oldWindowId) {
    this.detachedFrom.set(tabId, oldWindowId);
    for (const controller of this.controllers.values()) controller.markDetached(tabId, oldWindowId);
  }
  markTabActivity(tabId) {
    for (const controller of this.controllers.values()) controller.markTabActivity(tabId);
  }

  async navigation(tabId, url) {
    await this.findTab(tabId)?.controller.navigation(tabId, url);
  }
  async replaced(added, removed) {
    await this.findTab(removed)?.controller.replaced(added, removed);
  }
  async created(tab) {
    if (this.findTab(tab.id)) return;
    for (const controller of this.controllers.values()) await controller.created(tab);
  }
  async windowClosed() { await this.reconcile(); }

  async deactivate() {
    this.reloadRecoveryPending = false;
    for (const controller of this.controllers.values()) await controller.deactivate();
    this.globalWarning = null;
    await this.saveRuntime();
  }

  async reportError(error) {
    this.globalWarning = error?.message || String(error);
    await this.saveRuntime();
  }

  async resumeOpenGroups() {
    // An extension reload clears storage.session while leaving Chrome's groups
    // open. Rebind those groups without launching saved groups that are closed.
    this.reloadRecoveryPending = true;
    return this.reconcile();
  }

  async reconcile() {
    let firstError;
    if (this.reloadRecoveryPending) {
      let retryRecovery = false;
      for (const controller of this.controllers.values()) {
        if (controller.runtime.active || !controller.entries.length) continue;
        try {
          await controller.adoptRestoredGroup(undefined, { recoverAfterReload: true });
        } catch (error) {
          retryRecovery = true;
          firstError ??= error;
        }
      }
      this.reloadRecoveryPending = retryRecovery;
      await this.saveRuntime();
    }
    // A failure while repairing one group must not stop unrelated groups working.
    for (const controller of this.controllers.values()) {
      try { await controller.reconcile(); } catch (error) { firstError ??= error; }
    }
    await this.arrangeGroups();
    if (firstError) throw firstError;
    return this.state();
  }

  async arrangeGroups() {
    const byWindow = new Map();
    // This.groups always starts with Essentials. Other saved groups follow in
    // creation order; unrelated native groups retain their relative order.
    for (const group of this.groups) {
      const controller = this.controllers.get(group.id);
      if (!controller.runtime.active || controller.runtime.groupId === null) continue;
      const windowId = controller.runtime.ownerWindowId;
      if (!byWindow.has(windowId)) byWindow.set(windowId, []);
      byWindow.get(windowId).push({ group, controller });
    }
    for (const [windowId, managed] of byWindow) {
      let tabs = await this.api.tabs.query({ windowId });
      let cursor = tabs.filter(tab => tab.pinned).length;
      for (const { group, controller } of managed) {
        const nativeId = controller.runtime.groupId;
        let nativeTabs = tabs.filter(tab => tab.groupId === nativeId).sort((a, b) => a.index - b.index);
        if (!nativeTabs.length) continue;
        if (nativeTabs[0].index !== cursor) {
          await this.api.tabGroups.move(nativeId, { index: cursor });
          tabs = await this.api.tabs.query({ windowId });
          nativeTabs = tabs.filter(tab => tab.groupId === nativeId).sort((a, b) => a.index - b.index);
        }
        controller.runtime.anchor = cursor;
        const native = await this.api.tabGroups.get(nativeId).catch(() => null);
        if (native && (native.title !== group.name || native.color !== group.color)) {
          await this.api.tabGroups.update(nativeId, { title: group.name, color: group.color });
        }
        cursor += nativeTabs.length;
      }
    }
    await this.saveRuntime();
  }

  uniqueName(name, exceptId) {
    if (this.groups.some(group => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase())) {
      throw new Error('Choose a different name; a saved group already uses that name.');
    }
  }

  async createGroup(message) {
    if (this.groups.length >= MAX_GROUPS) throw new Error(`You can save up to ${MAX_GROUPS} groups.`);
    let group = createGroup(message.name, message.color);
    if ('acceptDrops' in message) group = updateGroup(group, { acceptDrops: message.acceptDrops });
    this.uniqueName(group.name);
    this.groups.push(group);
    this.attach(group);
    await this.saveConfig();
    await this.saveRuntime();
    return this.state(group.id);
  }

  async updateGroup(id, message) {
    const index = this.groups.findIndex(group => group.id === id);
    if (index === -1) throw new Error('That saved group no longer exists.');
    const next = updateGroup(this.groups[index], message);
    this.uniqueName(next.name, id);
    // Keep this metadata object's identity: persistence hooks refer to it.
    Object.assign(this.groups[index], next);
    const controller = this.selected(id);
    Object.assign(controller, { name: next.name, color: next.color, acceptDrops: next.acceptDrops });
    await this.saveConfig();
    await this.reconcile();
    return this.state(id);
  }

  async deleteGroup(id) {
    if (id === PRIMARY_GROUP_ID) throw new Error('Essentials is the default group and cannot be deleted.');
    const controller = this.selected(id);
    const nativeId = controller.runtime.groupId;
    const tabs = nativeId === null ? [] : await this.api.tabs.query({ groupId: nativeId });
    await controller.deactivate();
    this.controllers.delete(id);
    this.groups = this.groups.filter(group => group.id !== id);
    await this.saveConfig();
    await this.saveRuntime();
    if (tabs.length) await this.api.tabs.ungroup(tabs.map(tab => tab.id));
    await this.arrangeGroups();
    return this.state();
  }

  async dispatch(message, preferredWindowId) {
    const id = message.workspaceId ?? PRIMARY_GROUP_ID;
    if (message.type === 'createGroup') return this.createGroup(message);
    if (message.type === 'updateGroup') return this.updateGroup(id, message);
    if (message.type === 'deleteGroup') return this.deleteGroup(id);
    if (message.type === 'getState') return this.state(id);
    const controller = this.selected(id);
    if (message.type === 'getOpenTabs') return { tabs: await controller.openTabs() };
    // A page can belong to several saved lists, but each needs its own live tab.
    // Adding it elsewhere must not forget the original protected membership.
    if (message.type === 'addTab') {
      const existing = this.findTab(message.tabId);
      if (existing && existing.workspaceId !== id) {
        if (!controller.entries.some(entry => entry.lastValidUrl === existing.entry.lastValidUrl)) {
          controller.entries.push({ ...structuredClone(existing.entry), id: crypto.randomUUID() });
          await controller.saveEntries();
        }
        await controller.launch(preferredWindowId, false);
        await this.arrangeGroups();
        return this.state(id);
      }
    }
    if (message.type === 'launch') this.globalWarning = null;
    const result = await controller.dispatch(message, preferredWindowId);
    await this.arrangeGroups();
    return { ...this.state(id), ...(result.needsSetup ? { needsSetup: true } : {}) };
  }
}
