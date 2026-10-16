// Browser events invalidate focus immediately, even while the mutation queue is
// waiting on Chrome/storage. Intent is never persisted or retried after expiry.
export class LaunchIntent {
  constructor(now = () => Date.now(), lifetime = 1500) {
    this.now = now;
    this.lifetime = lifetime;
    this.generation = 0;
  }
  cancel() { this.generation++; this.expectedActivation = null; }
  activate(tabId) {
    this.activeTabId = tabId;
    const expected = this.expectedActivation;
    this.expectedActivation = null;
    if (expected?.generation !== this.generation || expected.tabId !== tabId) this.cancel();
  }
  navigation(tabId) { if (tabId === this.sourceTabId || tabId === this.activeTabId) this.cancel(); }
  begin(sourceTabId) {
    this.sourceTabId = sourceTabId;
    const generation = ++this.generation;
    this.expectedActivation = null;
    const deadline = this.now() + this.lifetime;
    const current = () => generation === this.generation && this.now() < deadline;
    current.expectActivation = tabId => { if (current()) this.expectedActivation = {generation, tabId}; };
    return current;
  }
}
