import { sanitizeEntries } from './model.js';

export const PRIMARY_GROUP_ID = 'essentials';
export const MAX_GROUPS = 50;
export const GROUP_COLORS = Object.freeze([
  'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);
const MAX_NAME_LENGTH = 60;
const unsafeKeys = new Set(Object.getOwnPropertyNames(Object.prototype).map(key => key.toLowerCase()));
unsafeKeys.add('prototype');

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;

function safeId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value) &&
    !unsafeKeys.has(value.toLowerCase());
}

function validateId(value) {
  if (!safeId(value)) throw new Error('This group has an invalid identifier.');
  return value;
}

function validateName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Give this group a name.');
  const name = value.trim().normalize('NFC');
  if (name.length > MAX_NAME_LENGTH) throw new Error(`Group names must be ${MAX_NAME_LENGTH} characters or fewer.`);
  return name;
}

function validateColor(value) {
  if (!GROUP_COLORS.includes(value)) throw new Error('Choose one of Chrome’s supported group colors.');
  return value;
}

function validateAcceptDrops(value) {
  if (typeof value !== 'boolean') throw new Error('Drag-to-add must be on or off.');
  return value;
}

export function createGroup(name, color = 'blue', id = crypto.randomUUID()) {
  const groupId = validateId(id);
  const groupName = validateName(name);
  if (groupId === PRIMARY_GROUP_ID && groupName !== 'Essentials') {
    throw new Error('The primary group is always named Essentials.');
  }
  return { id: groupId, name: groupName, color: validateColor(color), acceptDrops: true, entries: [] };
}

/** Settings can change presentation and drag-to-add, never identity or tab entries. */
export function updateGroup(group, changes = {}) {
  if (!isRecord(group) || !isRecord(changes)) throw new Error('Group settings must be an object.');
  const id = validateId(own(group, 'id'));
  const requestedName = Object.hasOwn(changes, 'name') ? changes.name : group.name;
  const name = validateName(requestedName);
  if (id === PRIMARY_GROUP_ID && name !== 'Essentials') {
    throw new Error('The primary group is always named Essentials.');
  }
  return {
    id,
    name,
    color: validateColor(Object.hasOwn(changes, 'color') ? changes.color : group.color),
    acceptDrops: validateAcceptDrops(Object.hasOwn(changes, 'acceptDrops')
      ? changes.acceptDrops : (own(group, 'acceptDrops') ?? true)),
    entries: sanitizeEntries(own(group, 'entries')),
  };
}

function recoveredName(rawName, fallback, seen) {
  let name = typeof rawName === 'string' ? rawName.trim().normalize('NFC').slice(0, MAX_NAME_LENGTH) : '';
  if (!name) name = fallback;
  const base = name;
  let number = 2;
  while (seen.has(name.toLowerCase())) {
    const suffix = ` (${number++})`;
    name = base.slice(0, MAX_NAME_LENGTH - suffix.length).trimEnd() + suffix;
  }
  seen.add(name.toLowerCase());
  return name;
}

/**
 * Upgrade v1 without losing valid entries. Damaged group metadata is repaired
 * independently of its entries; duplicate groups receive new identities/names.
 * The creation limit is deliberately not a load limit on already-saved data.
 */
export function normalizeConfig(raw) {
  const candidates = Array.isArray(own(raw, 'groups')) ? raw.groups.filter(isRecord) : [];
  const primaryIndex = candidates.findIndex(group => own(group, 'id') === PRIMARY_GROUP_ID);
  const primary = primaryIndex === -1 ? null : candidates[primaryIndex];
  const legacyEntries = own(raw, 'entries');
  const primaryEntries = [
    ...(Array.isArray(own(primary, 'entries')) ? primary.entries : []),
    ...(Array.isArray(legacyEntries) ? legacyEntries : []),
  ];
  const groups = [{
    id: PRIMARY_GROUP_ID,
    name: 'Essentials',
    color: GROUP_COLORS.includes(own(primary, 'color')) ? primary.color : 'blue',
    acceptDrops: typeof own(primary, 'acceptDrops') === 'boolean' ? primary.acceptDrops : true,
    entries: sanitizeEntries(primaryEntries),
  }];
  const ids = new Set([PRIMARY_GROUP_ID]);
  const names = new Set(['essentials']);
  for (let index = 0; index < candidates.length; index++) {
    if (index === primaryIndex) continue;
    const candidate = candidates[index];
    let id = own(candidate, 'id');
    if (!safeId(id) || ids.has(id)) {
      do { id = crypto.randomUUID(); } while (ids.has(id));
    }
    ids.add(id);
    groups.push({
      id,
      name: recoveredName(own(candidate, 'name'), `Group ${groups.length + 1}`, names),
      color: GROUP_COLORS.includes(own(candidate, 'color')) ? candidate.color : 'blue',
      acceptDrops: typeof own(candidate, 'acceptDrops') === 'boolean' ? candidate.acceptDrops : true,
      entries: sanitizeEntries(own(candidate, 'entries')),
    });
  }
  return { version: 2, groups };
}

function emptyRuntime() {
  return { active: false, ownerWindowId: null, groupId: null, anchor: 0,
    slots: {}, restoring: {}, attaching: {}, paused: {}, recent: {}, fresh: {}, candidates: {}, warning: null };
}

const chromeId = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function mapValues(value, acceptsKey, transform) {
  if (!isRecord(value)) return {};
  const entries = [];
  for (const [key, item] of Object.entries(value)) {
    if (!acceptsKey(key)) continue;
    const normalized = transform(item);
    if (normalized !== undefined) entries.push([key, normalized]);
  }
  return Object.fromEntries(entries);
}

function normalizeGroupRuntime(raw) {
  const runtime = emptyRuntime();
  if (!isRecord(raw)) return runtime;
  const warning = own(raw, 'warning');
  runtime.warning = typeof warning === 'string' && warning.trim() ? warning : null;
  const ownerWindowId = own(raw, 'ownerWindowId');
  // An inactive or unusable session cannot claim native tabs on the next wake.
  if (own(raw, 'active') !== true || !chromeId(ownerWindowId)) return runtime;
  runtime.active = true;
  runtime.ownerWindowId = ownerWindowId;
  runtime.groupId = chromeId(own(raw, 'groupId')) ? raw.groupId : null;
  runtime.anchor = chromeId(own(raw, 'anchor')) ? raw.anchor : 0;
  runtime.slots = mapValues(own(raw, 'slots'), safeId, value => chromeId(value) ? value : undefined);
  for (const key of ['restoring', 'attaching']) {
    runtime[key] = mapValues(own(raw, key), safeId, value => value === true ? true : undefined);
  }
  runtime.paused = mapValues(own(raw, 'paused'), safeId,
    value => typeof value === 'string' && value.trim() ? value : undefined);
  runtime.recent = mapValues(own(raw, 'recent'), safeId,
    value => Array.isArray(value) ? value.filter(timestamp) : undefined);
  runtime.fresh = mapValues(own(raw, 'fresh'), key => /^\d+$/.test(key) && chromeId(Number(key)),
    value => timestamp(value) ? value : undefined);
  runtime.candidates = mapValues(own(raw, 'candidates'), key => /^\d+$/.test(key) && chromeId(Number(key)), value => {
    if (!isRecord(value) || !timestamp(own(value, 'since')) || !chromeId(own(value, 'index')) ||
      !chromeId(own(value, 'groupId'))) return undefined;
    return { since: value.since, index: value.index, groupId: value.groupId };
  });
  return runtime;
}

/** Migrate a single-group session and expose only known workspace identities. */
export function normalizeRuntime(raw, groupIds = [PRIMARY_GROUP_ID]) {
  const requested = Array.isArray(groupIds) || groupIds instanceof Set ? [...groupIds] : [];
  const ids = [...new Set([PRIMARY_GROUP_ID, ...requested.filter(safeId)])];
  const versionTwo = own(raw, 'version') === 2;
  const storedGroups = own(raw, 'groups');
  const groups = Object.fromEntries(ids.map(id => [id, normalizeGroupRuntime(versionTwo
    ? own(storedGroups, id) : id === PRIMARY_GROUP_ID ? raw : undefined)]));
  return { version: 2, groups };
}
