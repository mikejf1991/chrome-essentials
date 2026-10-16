import { createEntry, classifyUrl, sanitizeEntries, validateEntryUpdate } from './model.js';

export const GROUP_TITLE = 'Essentials';
export const FRESH_TAB_MS = 1200;
export const DROP_SETTLE_MS = 900;
const REPLACEMENT_WINDOW_MS = 30000;
const emptyRuntime = () => ({ active: false, ownerWindowId: null, groupId: null, anchor: 0,
  slots: {}, restoring: {}, attaching: {}, paused: {}, recent: {}, fresh: {}, candidates: {}, warning: null });

// All public operations are serialized by background.js. Saved entries are independent
// of Chrome's transient tab/group IDs; session storage survives service-worker restarts.
export class EssentialsController {
  constructor(api, { now = () => Date.now(), name = GROUP_TITLE, color = 'blue', acceptDrops = true,
    persistEntries, persistSession, requestReconcile = () => {}, isClaimedElsewhere = () => false,
    isGroupClaimedElsewhere = () => false } = {}) {
    this.api = api;
    this.now = now;
    this.name = name;
    this.color = color;
    this.acceptDrops = acceptDrops;
    this.persistEntries = persistEntries;
    this.persistSession = persistSession;
    this.requestReconcile = requestReconcile;
    this.isClaimedElsewhere = isClaimedElsewhere;
    this.isGroupClaimedElsewhere = isGroupClaimedElsewhere;
    this.entries = [];
    this.runtime = emptyRuntime();
    this.closingWindows = new Set();
    this.detachedFrom = new Map();
  }

  async init() {
    const [saved, session] = await Promise.all([
      this.api.storage.local.get('config'), this.api.storage.session.get('runtime'),
    ]);
    this.hydrate(saved.config?.entries ?? [], session.runtime);
    await this.saveSession();
  }

  hydrate(entries, runtime) {
    this.entries = sanitizeEntries(entries);
    this.runtime = { ...emptyRuntime(), ...runtime };
    for (const key of ['slots', 'restoring', 'attaching', 'paused', 'recent', 'fresh', 'candidates']) {
      if (!this.runtime[key] || typeof this.runtime[key] !== 'object') this.runtime[key] = {};
    }
  }

  state() {
    const warnings = Object.entries(this.runtime.paused).map(([id, reason]) => {
      const entry = this.entries.find(e => e.id === id);
      return entry ? `${entry.label}: ${reason}` : '';
    }).filter(Boolean);
    return { entries: structuredClone(this.entries), active: this.runtime.active,
      ownerWindowId: this.runtime.ownerWindowId, groupId: this.runtime.groupId,
      slots: { ...this.runtime.slots },
      warning: [this.runtime.warning, ...warnings].filter(Boolean).join(' ') || null };
  }

  async saveEntries() {
    if (this.persistEntries) return this.persistEntries(this.entries);
    await this.api.storage.local.set({ config: { version: 1, entries: this.entries } });
  }

  async saveSession() {
    if (this.persistSession) return this.persistSession(this.runtime);
    await this.api.storage.session.set({ runtime: this.runtime });
    const paused = Object.keys(this.runtime.paused).length || this.runtime.warning;
    await this.api.action.setBadgeText({ text: paused ? '!' : this.runtime.active ? 'ON' : '' });
    await this.api.action.setBadgeBackgroundColor({ color: paused ? '#A45218' : '#2458D3' });
    await this.api.action.setTitle({ title: this.runtime.active ? 'Show Essentials' : 'Open Essentials' });
    if (this.runtime.active) {
      const alarm = await this.api.alarms.get('essentials-reconcile');
      if (!alarm) await this.api.alarms.create('essentials-reconcile', { periodInMinutes: 0.5 });
    } else {
      await this.api.alarms.clear('essentials-reconcile');
    }
  }

  markWindowClosing(windowId) { this.closingWindows.add(windowId); }
  markDetached(tabId, oldWindowId) { this.detachedFrom.set(tabId, oldWindowId); }
  markTabActivity(tabId) {
    if (this.runtime.candidates[tabId]) this.runtime.candidates[tabId].since = this.now();
  }

  async deactivate() {
    this.runtime = emptyRuntime();
    await this.saveSession();
  }

  async windowClosed(windowId) {
    if (this.runtime.ownerWindowId === windowId) await this.reconcile();
  }

  async reportError(error) {
    this.runtime.warning = error?.message || String(error);
    await this.saveSession();
  }

  async normalWindow(preferred) {
    const windows = (await this.api.windows.getAll({ windowTypes: ['normal'] }))
      .filter(w => !w.incognito && !this.closingWindows.has(w.id));
    const window = windows.find(w => w.id === preferred) || windows.find(w => w.focused) || windows[0];
    if (!window) throw new Error('Open a regular Chrome window first.');
    return window.id;
  }

  async getTab(tabId) {
    try { return await this.api.tabs.get(tabId); } catch { return null; }
  }

  entryForTab(tabId) {
    return this.entries.find(entry => this.runtime.slots[entry.id] === tabId);
  }

  async openTabs() {
    const tabs = await this.api.tabs.query({ windowType: 'normal' });
    return tabs.filter(tab => !tab.incognito && /^https?:\/\//.test(tab.url || ''))
      .map(({ id, title, url, windowId }) => ({ id, title, url, windowId }));
  }

  async ensureGroup(tabId) {
    let group;
    if (this.runtime.groupId !== null) {
      try { group = await this.api.tabGroups.get(this.runtime.groupId); } catch { /* group emptied */ }
    }
    if (group && group.windowId === this.runtime.ownerWindowId) {
      await this.api.tabs.group({ tabIds: [tabId], groupId: group.id });
    } else {
      const groupId = await this.api.tabs.group({ tabIds: [tabId],
        createProperties: { windowId: this.runtime.ownerWindowId } });
      this.runtime.groupId = groupId;
      await this.api.tabGroups.update(groupId, { title: this.name, color: this.color, collapsed: false });
    }
  }

  async focus(canFocus = () => true) {
    if (!this.runtime.active || !canFocus()) return false;
    if (this.runtime.groupId !== null) {
      try { await this.api.tabGroups.update(this.runtime.groupId, { collapsed: false }); } catch { /* reconciliation repairs */ }
    }
    const first = this.entries.map(e => this.runtime.slots[e.id]).find(id => Number.isInteger(id));
    if (first === undefined || !await this.getTab(first) || !canFocus()) return false;
    canFocus.expectActivation?.(first);
    await this.api.tabs.update(first, { active: true });
    if (canFocus()) await this.api.windows.update(this.runtime.ownerWindowId, { focused: true });
    return true;
  }

  // Manual launches can adopt exact saved URLs from a native restored group.
  // An extension reload can additionally rebind existing groups whose pages
  // changed while protection was offline; it never launches absent groups here.
  async adoptRestoredGroup(preferredWindowId, { recoverAfterReload = false } = {}) {
    if (!this.entries.length) return false;
    const groups = (await this.api.tabGroups.query({})).filter(group =>
      group.title === this.name && !this.isGroupClaimedElsewhere(group.id))
      .sort((a, b) => Number(b.windowId === preferredWindowId) - Number(a.windowId === preferredWindowId));
    const candidates = [];
    for (const group of groups) {
      const window = await this.api.windows.get(group.windowId).catch(() => null);
      if (!window || window.incognito || window.type !== 'normal' || this.closingWindows.has(window.id)) continue;
      const tabs = await this.api.tabs.query({ groupId: group.id });
      if (!tabs.length) continue;
      const available = [...tabs];
      const bindings = {};
      // Complete all exact matches before allowing any app-host fallback. Several
      // accounts can share a hostname, so a fallback must not steal an exact tab.
      for (const entry of this.entries) {
        const index = available.findIndex(tab => tab.url === entry.lastValidUrl && !this.isClaimedElsewhere(tab.id));
        if (index !== -1) bindings[entry.id] = available.splice(index, 1)[0].id;
      }
      const exactMatches = Object.keys(bindings).length;
      if (!recoverAfterReload && !exactMatches) continue;
      candidates.push({ group, tabs, available, bindings, exactMatches });
      if (!recoverAfterReload) break;
    }
    if (!candidates.length) return false;
    if (recoverAfterReload) {
      candidates.sort((a, b) => b.exactMatches - a.exactMatches);
      // A unique visible group can be recognized by its saved name even if every
      // page changed while disabled. Multiple equally plausible groups cannot.
      if (candidates.length > 1 && candidates[0].exactMatches === candidates[1].exactMatches) return false;
      const candidate = candidates[0];
      const unmatched = this.entries.filter(entry => !Object.hasOwn(candidate.bindings, entry.id));
      const available = candidate.available.filter(tab => !this.isClaimedElsewhere(tab.id));
      for (const entry of unmatched) {
        const matches = available.filter(tab => classifyUrl(entry, tab.url) === 'app');
        if (matches.length !== 1) continue;
        const tab = matches[0];
        if (unmatched.filter(other => classifyUrl(other, tab.url) === 'app').length !== 1) continue;
        candidate.bindings[entry.id] = tab.id;
        candidate.available.splice(candidate.available.findIndex(item => item.id === tab.id), 1);
      }
    }
    const { group, tabs, available, bindings } = candidates[0];
    this.runtime.active = true;
    this.runtime.ownerWindowId = group.windowId;
    this.runtime.groupId = group.id;
    this.runtime.slots = bindings;
    this.runtime.anchor = tabs[0]?.index ?? 0;
    // Preserve unmatched working pages without attributing their current URL to
    // a saved account. Reconciliation will recreate only the missing saved slots.
    const unmatchedTabs = available.filter(tab => !this.isClaimedElsewhere(tab.id));
    if (recoverAfterReload) {
      // If Chrome rejects ungrouping during a drag, ordinary reconciliation must
      // eject these pages on retry rather than saving them as fresh membership.
      for (const tab of unmatchedTabs) this.runtime.fresh[tab.id] = this.now() + FRESH_TAB_MS;
    }
    for (const tab of unmatchedTabs) await this.api.tabs.ungroup(tab.id);
    return true;
  }

  async launch(preferredWindowId, focus = true, canFocus = () => true) {
    this.runtime.warning = null;
    if (!this.entries.length) return { ...this.state(), needsSetup: true };
    const owner = this.runtime.active
      ? await this.api.windows.get(this.runtime.ownerWindowId).catch(() => null) : null;
    if (!owner || this.closingWindows.has(owner.id)) {
      this.runtime = emptyRuntime();
      if (!await this.adoptRestoredGroup(preferredWindowId)) {
        this.runtime.active = true;
        this.runtime.ownerWindowId = await this.normalWindow(preferredWindowId);
      }
    }
    let focused = false;
    const focusOnce = async () => {
      if (!focus || focused || !canFocus() || !this.entries.some(e => Number.isInteger(this.runtime.slots[e.id]))) return;
      focused = await this.focus(canFocus);
    };
    // Show an existing/first restored slot without waiting for every saved app.
    await focusOnce();
    await this.reconcile({ onRestored: focusOnce });
    return this.state();
  }

  async addTab(tabId) {
    const tab = await this.getTab(tabId);
    if (!tab || tab.incognito) throw new Error('Choose a regular web tab to add.');
    const window = await this.api.windows.get(tab.windowId);
    if (window.type !== 'normal') throw new Error('Choose a tab in a regular Chrome window.');
    if (this.entryForTab(tab.id)) return this.state();
    const entry = createEntry(tab.url, tab.title?.trim().slice(0, 100));
    if (!this.runtime.active) {
      this.runtime = emptyRuntime();
      this.runtime.active = true;
      this.runtime.ownerWindowId = tab.windowId;
      this.runtime.anchor = tab.index;
    }
    if (tab.pinned) await this.api.tabs.update(tab.id, { pinned: false });
    if (tab.windowId !== this.runtime.ownerWindowId) {
      await this.api.tabs.move(tab.id, { windowId: this.runtime.ownerWindowId, index: -1 });
    }
    await this.ensureGroup(tab.id);
    await this.api.tabs.update(tab.id, { autoDiscardable: false });
    this.entries.push(entry);
    this.runtime.slots[entry.id] = tab.id;
    delete this.runtime.fresh[tab.id];
    delete this.runtime.candidates[tab.id];
    await this.saveEntries();
    await this.saveSession();
    await this.reconcile();
    return this.state();
  }

  async addUrl(url, label, preferredWindowId) {
    const entry = createEntry(url, label);
    const existing = this.entries.find(e => e.lastValidUrl === entry.lastValidUrl);
    if (!existing) {
      this.entries.push(entry);
      await this.saveEntries();
    }
    return this.launch(preferredWindowId, false);
  }

  async remove(id) {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) throw new Error('That essential is no longer saved.');
    const tabId = this.runtime.slots[id];
    this.entries = this.entries.filter(e => e.id !== id);
    for (const key of ['slots', 'restoring', 'attaching', 'paused', 'recent']) delete this.runtime[key][id];
    await this.saveEntries();
    await this.saveSession();
    const tab = await this.getTab(tabId);
    if (tab && tab.groupId === this.runtime.groupId) await this.api.tabs.ungroup(tab.id);
    if (!this.entries.length) await this.deactivate();
    else await this.reconcile();
    return this.state();
  }

  async updateEntry(id, changes) {
    const index = this.entries.findIndex(e => e.id === id);
    if (index === -1) throw new Error('That essential is no longer saved.');
    this.entries[index] = validateEntryUpdate(this.entries[index], changes);
    await this.saveEntries();
    await this.reconcile();
    return this.state();
  }

  async reorder(ids) {
    if (!Array.isArray(ids) || ids.length !== this.entries.length || new Set(ids).size !== ids.length ||
      ids.some(id => !this.entries.some(entry => entry.id === id))) {
      throw new Error('The list changed. Refresh it and try again.');
    }
    this.entries = ids.map(id => this.entries.find(entry => entry.id === id));
    await this.saveEntries();
    if (this.runtime.active) {
      const tabs = this.runtime.groupId === null ? [] : await this.api.tabs.query({ groupId: this.runtime.groupId });
      const start = tabs[0]?.index ?? this.runtime.anchor;
      // Moving right-to-left to one anchor gives stable order without splitting groups.
      for (const entry of [...this.entries].reverse()) {
        const tabId = this.runtime.slots[entry.id];
        if (Number.isInteger(tabId)) await this.api.tabs.move(tabId, { index: start });
      }
    }
    await this.saveSession();
    return this.state();
  }

  async close() {
    const groupId = this.runtime.groupId;
    const tabs = groupId === null ? [] : await this.api.tabs.query({ groupId });
    // Disable first, so the resulting onRemoved events never resurrect these tabs.
    await this.deactivate();
    if (tabs.length) await this.api.tabs.remove(tabs.map(t => t.id));
    return this.state();
  }

  async created(tab) {
    if (!this.runtime.active || this.entryForTab(tab.id)) return;
    this.runtime.fresh[tab.id] = this.now() + FRESH_TAB_MS;
    await this.saveSession();
  }

  async navigation(tabId, url) {
    const entry = this.entryForTab(tabId);
    if (!entry || !this.runtime.active) return;
    // Only background.js main-frame committed/history/fragment events call this.
    // Updating the last allowed URL before reconciliation preserves fast app -> outside chains.
    if (classifyUrl(entry, url) === 'app') {
      if (entry.lastValidUrl !== url) {
        entry.lastValidUrl = url;
        await this.saveEntries();
      }
      delete this.runtime.restoring[entry.id];
      delete this.runtime.paused[entry.id];
      await this.saveSession();
    }
  }

  async replaced(addedTabId, removedTabId) {
    const entry = this.entryForTab(removedTabId);
    if (entry) {
      this.runtime.slots[entry.id] = addedTabId;
      await this.saveSession();
    }
  }

  async restore(entry, groupStart) {
    if (this.closingWindows.has(this.runtime.ownerWindowId)) return;
    const index = Math.max(0, groupStart + this.entries.indexOf(entry));
    const tab = await this.api.tabs.create({ windowId: this.runtime.ownerWindowId,
      url: entry.lastValidUrl, active: false, index });
    this.runtime.slots[entry.id] = tab.id;
    this.runtime.restoring[entry.id] = true;
    this.runtime.attaching[entry.id] = true;
    delete this.runtime.fresh[tab.id];
    // Persist before grouping: a worker interruption can recover this tab instead of
    // creating a second replacement on every wake.
    await this.saveSession();
    await this.ensureGroup(tab.id);
    delete this.runtime.attaching[entry.id];
    await this.api.tabs.update(tab.id, { autoDiscardable: false });
  }

  async reconcile({ onRestored = async () => {} } = {}) {
    if (!this.runtime.active) return this.state();
    if (!this.entries.length) { await this.deactivate(); return this.state(); }
    const owner = this.runtime.ownerWindowId;
    let tabs = (await this.api.tabs.query({ windowType: 'normal' })).filter(t => !t.incognito);
    let byId = new Map(tabs.map(tab => [tab.id, tab]));
    const mappedTabs = this.entries.map(e => byId.get(this.runtime.slots[e.id])).filter(Boolean);

    // Moving a whole native group between windows recreates its group ID. Follow
    // the intact named group; individual detached tabs have no matching group.
    if (mappedTabs.length === this.entries.length && mappedTabs.length &&
      mappedTabs.every(t => t.groupId >= 0 && t.groupId === mappedTabs[0].groupId) &&
      mappedTabs[0].windowId !== owner) {
      const movedGroup = await this.api.tabGroups.get(mappedTabs[0].groupId).catch(() => null);
      if (movedGroup?.title === this.name && !this.isGroupClaimedElsewhere(movedGroup.id)) {
        this.runtime.ownerWindowId = movedGroup.windowId;
        this.runtime.groupId = movedGroup.id;
      }
    }

    const ownerExists = await this.api.windows.get(this.runtime.ownerWindowId).catch(() => null);
    if (this.closingWindows.has(this.runtime.ownerWindowId) || !ownerExists) {
      // Detaching the last tab automatically closes its source window. In that
      // specific case retain the detached working tab and replace the Essentials
      // window in the background. Actual window-close removals always win.
      const lastTabsDetached = !ownerExists && !this.closingWindows.has(this.runtime.ownerWindowId) &&
        mappedTabs.length > 0 && mappedTabs.every(tab => tab.windowId !== owner &&
          this.detachedFrom.get(tab.id) === owner);
      if (lastTabsDetached) {
        const replacement = await this.api.windows.create({ url: 'about:blank', type: 'normal', focused: false });
        this.runtime.ownerWindowId = replacement.id;
        this.runtime.groupId = null;
        this.runtime.anchor = 0;
      } else {
        await this.deactivate();
        return this.state();
      }
    }

    let groupTabs = tabs.filter(t => t.groupId === this.runtime.groupId && t.windowId === this.runtime.ownerWindowId)
      .sort((a, b) => a.index - b.index);
    if (groupTabs.length) this.runtime.anchor = groupTabs[0].index;
    // Chrome clamps insertion indices below pinned tabs. Start after them so
    // successive replacements retain saved order instead of sharing one index.
    const pinnedCount = tabs.filter(tab => tab.windowId === this.runtime.ownerWindowId && tab.pinned).length;
    const groupStart = Math.max(pinnedCount, this.runtime.anchor);
    let changed = false;
    let hadMissing = false;
    const missingEntries = new Set();

    for (const entry of this.entries) {
      const tab = byId.get(this.runtime.slots[entry.id]);
      if (!tab || tab.windowId !== this.runtime.ownerWindowId || tab.groupId !== this.runtime.groupId) {
        // Recover our own half-finished create/group operation without taking back
        // a user-detached tab: only a new pending restore in the owner can be adopted.
        if (tab && tab.windowId === this.runtime.ownerWindowId && this.runtime.attaching[entry.id]) {
          await this.ensureGroup(tab.id);
          delete this.runtime.attaching[entry.id];
        } else {
          // Keep the old binding until a replacement is actually created. Chrome
          // can reject tab creation during a drag; if the user returns the same
          // tab before retry, it must still be recognized as this saved entry.
          missingEntries.add(entry.id);
          delete this.runtime.restoring[entry.id];
          delete this.runtime.attaching[entry.id];
          delete this.runtime.paused[entry.id];
          hadMissing = true;
          continue;
        }
      }
      const url = tab?.url;
      if (!url || (url === 'about:blank' && this.runtime.restoring[entry.id])) continue;
      const classification = classifyUrl(entry, url);
      if (classification === 'app') {
        if (entry.lastValidUrl !== url) { entry.lastValidUrl = url; changed = true; }
        delete this.runtime.restoring[entry.id];
        delete this.runtime.paused[entry.id];
      } else if (classification === 'auth') {
        // Authentication can use a different host but never becomes the remembered app URL.
        delete this.runtime.paused[entry.id];
      } else if (!this.runtime.paused[entry.id]) {
        const recent = (this.runtime.recent[entry.id] || []).filter(t => this.now() - t < REPLACEMENT_WINDOW_MS);
        if (this.runtime.restoring[entry.id] || recent.length >= 3) {
          this.runtime.paused[entry.id] = 'Restoration paused on an unexpected site. Return to the app or edit its allowed sites.';
        } else {
          this.runtime.recent[entry.id] = [...recent, this.now()];
          // Keep the original live tab (and its form/navigation state) outside the
          // group; do not cancel, replay, or replace its destination navigation.
          await this.api.tabs.ungroup(tab.id);
          const remaining = await this.api.tabs.query({ groupId: this.runtime.groupId });
          if (remaining.length) {
            await this.api.tabs.move(tab.id, { index: Math.max(...remaining.map(t => t.index)) + 1 });
          }
          missingEntries.add(entry.id);
          hadMissing = true;
        }
      }
    }

    // Membership while dragging is provisional. Wait for a quiet position, verify
    // the native tab strip is editable (Chrome rejects moves during mouse drag),
    // and re-read membership before committing a saved entry.
    groupTabs = this.runtime.groupId === null ? [] : await this.api.tabs.query({ groupId: this.runtime.groupId });
    const present = new Set(groupTabs.map(tab => tab.id));
    for (const tabId of Object.keys(this.runtime.candidates)) {
      if (!present.has(Number(tabId))) delete this.runtime.candidates[tabId];
    }
    for (const tab of groupTabs) {
      if (this.entryForTab(tab.id)) continue;
      // A different managed group first releases/replaces its own saved slot.
      // Do not steal or eject its live tab while those ownership updates settle.
      if (this.isClaimedElsewhere(tab.id)) continue;
      const freshUntil = this.runtime.fresh[tab.id];
      if (freshUntil || !this.acceptDrops) {
        await this.api.tabs.ungroup(tab.id);
        delete this.runtime.candidates[tab.id];
        continue;
      }
      const previous = this.runtime.candidates[tab.id];
      if (!previous || previous.index !== tab.index || previous.groupId !== tab.groupId) {
        this.runtime.candidates[tab.id] = { since: this.now(), index: tab.index, groupId: tab.groupId };
      }
      const candidate = this.runtime.candidates[tab.id];
      const candidateSince = candidate.since;
      const candidateIndex = candidate.index;
      const wait = DROP_SETTLE_MS - (this.now() - candidateSince);
      if (wait > 0) { this.requestReconcile(wait + 30); continue; }
      // This no-op is deliberately outside the validation catch: edit failures
      // during dragging must be retried, never mistaken for an invalid web URL.
      await this.api.tabs.move(tab.id, { index: tab.index });
      const settled = await this.getTab(tab.id);
      if (!settled || settled.groupId !== this.runtime.groupId || settled.windowId !== this.runtime.ownerWindowId) {
        delete this.runtime.candidates[tab.id];
        continue;
      }
      const currentCandidate = this.runtime.candidates[tab.id];
      if (settled.index !== candidateIndex || currentCandidate !== candidate ||
        currentCandidate.since !== candidateSince) {
        // Native drag events can arrive while the editability probe is pending.
        // A successful probe does not establish that the tab stayed in place.
        this.runtime.candidates[tab.id] = { since: this.now(), index: settled.index, groupId: settled.groupId };
        this.requestReconcile(DROP_SETTLE_MS + 30);
        continue;
      }
      let entry;
      try {
        entry = createEntry(settled.url, settled.title?.trim().slice(0, 100));
      } catch {
        // Settings/new-tab/internal pages are not app essentials.
        await this.api.tabs.ungroup(tab.id);
        delete this.runtime.candidates[tab.id];
        continue;
      }
      // Chrome edit failures are retryable; don't commit partial membership or
      // mistake those failures for an unsupported page address.
      await this.api.tabs.update(tab.id, { autoDiscardable: false });
      this.entries.push(entry);
      this.runtime.slots[entry.id] = tab.id;
      changed = true;
      delete this.runtime.candidates[tab.id];
    }
    for (const [tabId, until] of Object.entries(this.runtime.fresh)) {
      const tab = byId.get(Number(tabId));
      if (!tab || (until <= this.now() && tab.groupId !== this.runtime.groupId)) delete this.runtime.fresh[tabId];
    }

    if (changed) await this.saveEntries();
    for (const entry of this.entries) {
      if (!missingEntries.has(entry.id) && Number.isInteger(this.runtime.slots[entry.id])) continue;
      // The user may already have returned a retained tab while another API
      // operation was awaiting. Reuse it instead of manufacturing a duplicate.
      const returned = await this.getTab(this.runtime.slots[entry.id]);
      if (returned && returned.windowId === this.runtime.ownerWindowId &&
        returned.groupId === this.runtime.groupId && classifyUrl(entry, returned.url) !== 'outside') continue;
      await this.restore(entry, groupStart);
      await onRestored();
    }

    tabs = this.runtime.groupId === null ? [] : await this.api.tabs.query({ groupId: this.runtime.groupId });
    byId = new Map(tabs.map(tab => [tab.id, tab]));
    // User order is authoritative. Restoration uses the saved order, so wait
    // until the repair cycle finishes before learning a new physical order.
    if (!hadMissing && this.entries.every(e => byId.has(this.runtime.slots[e.id]))) {
      const ordered = [...this.entries].sort((a, b) =>
        byId.get(this.runtime.slots[a.id]).index - byId.get(this.runtime.slots[b.id]).index);
      if (ordered.some((entry, i) => entry.id !== this.entries[i].id)) {
        this.entries = ordered;
        await this.saveEntries();
      }
    }
    this.runtime.anchor = tabs[0]?.index ?? groupStart;
    await this.saveSession();
    return this.state();
  }

  async dispatch(message, preferredWindowId, canFocus) {
    switch (message.type) {
      case 'getState': return this.state();
      case 'getOpenTabs': return { tabs: await this.openTabs() };
      case 'launch': return this.launch(preferredWindowId, true, canFocus);
      case 'close': return this.close();
      case 'addTab': return this.addTab(message.tabId);
      case 'addUrl': return this.addUrl(message.url, message.label, preferredWindowId);
      case 'remove': return this.remove(message.id);
      case 'updateEntry': return this.updateEntry(message.id, message);
      case 'reorder': return this.reorder(message.ids);
      default: throw new Error('Unknown Essentials action.');
    }
  }
}
