import test from 'node:test';
import assert from 'node:assert/strict';
import { LaunchIntent } from '../extension/launch-intent.js';
import { createEventQueue } from '../extension/event-queue.js';
import { WorkspacesController } from '../extension/workspaces.js';

test('navigation, user activation and newer launches cancel queued focus immediately', () => {
  let now = 0;
  const intent = new LaunchIntent(() => now);
  const first = intent.begin(4);
  intent.navigation(10);
  assert.equal(first(), true);
  intent.navigation(4);
  assert.equal(first(), false);
  const second = intent.begin(4);
  intent.cancel();
  assert.equal(second(), false);
  const third = intent.begin(4);
  intent.begin(4);
  assert.equal(third(), false);
  const slow = intent.begin(4);
  now = 30001;
  assert.equal(slow(), false, 'a 30-second backlog must never focus a tab');
  intent.activate(22);
  const fromBackgroundSettings = intent.begin(4);
  intent.navigation(22);
  assert.equal(fromBackgroundSettings(), false, 'the active working tab also invalidates a settings-page launch');
  const own = intent.begin(4);
  own.expectActivation(10);
  intent.activate(10);
  assert.equal(own(), true, 'our own activation can finish focusing its owner window');
  intent.activate(22);
  assert.equal(own(), false, 'a different user activation still cancels focus');
});

test('repair storms coalesce while ordered user operations and error recovery survive', async () => {
  let release;
  const enqueue = createEventQueue(new Promise(resolve => { release = resolve; }));
  const events = [];
  const pending = Array.from({length:1000}, () => enqueue(() => events.push('repair'), 'repair'));
  const user = enqueue(() => events.push('user'));
  release();
  await Promise.all([...pending, user]);
  assert.deepEqual(events, ['repair', 'user']);
  await assert.rejects(enqueue(() => { throw new Error('retry'); }));
  await enqueue(() => events.push('recovered'));
  assert.equal(events.at(-1), 'recovered');
});

test('unchanged runtime incurs no IPC and failed storage writes retry', async () => {
  const calls = [];
  const record = name => async () => calls.push(name);
  const api = {storage:{session:{set:record('storage')}},action:{setBadgeText:record('badge'),
    setBadgeBackgroundColor:record('color'),setTitle:record('title')},alarms:{get:record('get'),create:record('create'),clear:record('clear')}};
  const controller = new WorkspacesController(api);
  await controller.saveRuntime();
  calls.length = 0;
  for (let i=0; i<100; i++) await controller.saveRuntime();
  assert.deepEqual(calls, []);
  controller.controllers.set('essentials', {runtime:{active:true},state:()=>({active:true})});
  let fail = true;
  api.storage.session.set = async () => { calls.push('storage'); if (fail) throw new Error('storage unavailable'); };
  await assert.rejects(controller.saveRuntime());
  fail = false;
  await controller.saveRuntime();
  assert.equal(calls.filter(name=>name==='storage').length, 2);
});
