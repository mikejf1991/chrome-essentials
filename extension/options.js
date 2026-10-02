const $ = (id) => document.getElementById(id);
const rowsByGroup = new Map();
const groupButtons = new Map();
const groupDrafts = new Map();
const addDrafts = new Map();
const colors = ["blue", "grey", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
let selectedWorkspaceId = "essentials";
let state = { entries: [], groups: [], active: false, ownerWindowId: null, warning: null };
let busy = false;
let loaded = false;
let refreshing = false;
let refreshAgain = false;
let operationVersion = 0;
let tabsRequestVersion = 0;
let openTabs = [];
let pendingDelete = null;

async function request(type, fields = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...fields });
  if (!result?.ok) throw new Error(result?.error || "Essentials could not complete that action. Try again.");
  return result;
}

async function requestState(workspaceId) {
  try {
    return await request("getState", { workspaceId });
  } catch (error) {
    if (workspaceId === "essentials") throw error;
    // Another settings page may have deleted this group while this page was open.
    const fallback = await request("getState", { workspaceId: "essentials" });
    if (fallback.groups.some((group) => group.id === workspaceId)) throw error;
    return fallback;
  }
}

function showFeedback(message, isError = false) {
  $("feedback").textContent = message;
  $("feedback").classList.toggle("is-error", isError);
}

function hostname(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function make(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function field(label, id, { multiline = false, hint = "", wide = false } = {}) {
  const wrapper = make("div", `field${wide ? " field-wide" : ""}`);
  const caption = make("label", "", label);
  caption.htmlFor = id;
  const input = make(multiline ? "textarea" : "input");
  input.id = id;
  input.name = id;
  input.autocomplete = "off";
  input.spellcheck = false;
  if (!multiline) { input.type = "text"; input.maxLength = 100; }
  wrapper.append(caption, input);
  if (hint) {
    const help = make("p", "field-hint", hint);
    help.id = `${id}-hint`;
    input.setAttribute("aria-describedby", help.id);
    wrapper.append(help);
  }
  return { wrapper, input };
}

function parseHosts(value) {
  return [...new Set(value.split(/[\s,]+/).map((host) => host.trim().toLowerCase()).filter(Boolean))];
}

function currentRows() {
  if (!rowsByGroup.has(selectedWorkspaceId)) rowsByGroup.set(selectedWorkspaceId, new Map());
  return rowsByGroup.get(selectedWorkspaceId);
}

function syncControls() {
  document.querySelectorAll("button, input, select, textarea").forEach((control) => {
    control.disabled = busy || !loaded;
  });
  $("launch").disabled = busy || !loaded || state.entries.length === 0;
  $("close").disabled = busy || !loaded || !state.active;
  $("add-tab").disabled = busy || !loaded || !$("open-tabs").value;
  $("open-tabs").disabled = busy || !loaded || openTabs.length === 0;
  const dirty = groupDrafts.get(selectedWorkspaceId)?.dirty;
  $("save-group").disabled = busy || !loaded || !dirty;
  $("cancel-group").disabled = busy || !loaded || !dirty;
  $("delete-group").disabled = busy || !loaded || selectedWorkspaceId === "essentials";
  const rows = currentRows();
  state.entries.forEach((entry, index) => {
    const row = rows.get(entry.id);
    if (!row) return;
    row.up.disabled = busy || index === 0;
    row.down.disabled = busy || index === state.entries.length - 1;
    row.save.disabled = busy || !row.dirty;
    row.cancel.disabled = busy || !row.dirty;
  });
}

async function operation(task, successMessage = "") {
  if (busy) return;
  operationVersion += 1;
  busy = true;
  syncControls();
  showFeedback("Working…");
  try {
    await task();
    showFeedback(successMessage);
  } catch (error) {
    showFeedback(error.message || String(error), true);
  } finally {
    busy = false;
    syncControls();
    if (refreshAgain) { refreshAgain = false; void refreshState(); }
  }
}

function fillDraft(row, entry) {
  row.label.input.value = entry.label;
  row.allowed.input.value = entry.allowedHosts.join("\n");
  row.auth.input.value = entry.authHosts.join("\n");
  row.dirty = false;
  row.editState.textContent = "";
}

function createRow(entry, workspaceId) {
  const li = make("li", "entry");
  const main = make("div", "entry-main");
  const number = make("span", "entry-number");
  const identity = make("div", "entry-identity");
  const title = make("span", "entry-title");
  const host = make("span", "entry-host");
  identity.append(title, host);
  const order = make("div", "order-actions");
  const up = make("button", "order-button", "↑");
  const down = make("button", "order-button", "↓");
  up.type = down.type = "button";
  order.append(up, down);
  const remove = make("button", "text-button remove-button", "Remove");
  remove.type = "button";
  remove.title = "Remove from this saved group and leave the page open";
  main.append(number, identity, order, remove);

  const details = make("details", "entry-details");
  const summary = make("summary", "", "Website settings");
  const form = make("form", "entry-form");
  const grid = make("div", "settings-grid");
  const suffix = `${workspaceId}-${entry.id}`;
  const label = field("Name", `name-${suffix}`, { wide: true });
  label.input.required = true;
  const allowed = field("Allowed websites", `allowed-${suffix}`, {
    multiline: true,
    hint: "One exact hostname per line, such as mail.example.com. Include the website of the last saved address.",
  });
  allowed.input.required = true;
  const auth = field("Sign-in websites", `auth-${suffix}`, {
    multiline: true,
    hint: "Optional. Exact hostnames used to sign in. Visits here keep the tab in its saved group without replacing its saved address.",
  });
  const lastField = make("div", "field field-wide");
  const lastLabel = make("span", "field-label", "Last saved address");
  const lastUrl = make("p", "last-address");
  lastField.append(lastLabel, lastUrl);
  grid.append(label.wrapper, allowed.wrapper, auth.wrapper, lastField);
  const actions = make("div", "edit-actions");
  const save = make("button", "button button-secondary", "Save settings");
  save.type = "submit";
  const cancel = make("button", "button button-quiet", "Cancel");
  cancel.type = "button";
  const editState = make("span", "edit-state");
  actions.append(save, cancel, editState);
  form.append(grid, actions);
  details.append(summary, form);
  li.append(main, details);
  const row = { li, number, title, host, up, down, remove, details, label, allowed, auth, lastUrl, save, cancel, editState, dirty: false };

  form.addEventListener("input", () => {
    row.dirty = true;
    editState.textContent = "Unsaved changes";
    syncControls();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const fields = {
      workspaceId,
      id: entry.id,
      label: label.input.value.trim(),
      allowedHosts: parseHosts(allowed.input.value),
      authHosts: parseHosts(auth.input.value),
    };
    void operation(async () => {
      const next = await request("updateEntry", fields);
      row.dirty = false;
      render(next);
    }, "Website settings saved.");
  });
  cancel.addEventListener("click", () => {
    const current = state.entries.find((item) => item.id === entry.id);
    if (selectedWorkspaceId === workspaceId && current) fillDraft(row, current);
    syncControls();
  });
  up.addEventListener("click", () => void reorder(workspaceId, entry.id, -1));
  down.addEventListener("click", () => void reorder(workspaceId, entry.id, 1));
  remove.addEventListener("click", () => void operation(async () => {
    render(await request("remove", { workspaceId, id: entry.id }));
  }, "Removed from the saved group. Any open page stays open."));
  return row;
}

function saveVisibleDrafts() {
  if (!loaded) return;
  const draft = groupDrafts.get(selectedWorkspaceId);
  if (draft) draft.open = $("group-settings").open;
  addDrafts.set(selectedWorkspaceId, {
    url: $("new-url").value,
    label: $("new-label").value,
    open: $("add-address-details").open,
    tabId: $("open-tabs").value,
  });
}

function fillGroupSettings(next, switched) {
  const old = groupDrafts.get(selectedWorkspaceId);
  if (!old?.dirty) {
    groupDrafts.set(selectedWorkspaceId, {
      name: next.groupName,
      color: next.groupColor,
      acceptDrops: next.acceptDrops,
      dirty: false,
      open: old?.open || false,
    });
  }
  const draft = groupDrafts.get(selectedWorkspaceId);
  if (!old?.dirty || switched) {
    $("group-name").value = draft.name;
    $("group-color").value = draft.color;
    $("accept-drops").checked = draft.acceptDrops;
  }
  $("group-edit-state").textContent = draft.dirty ? "Unsaved changes" : "";
  const isEssentials = selectedWorkspaceId === "essentials";
  $("group-name").readOnly = isEssentials;
  $("group-name-hint").hidden = !isEssentials;
  $("delete-group").hidden = isEssentials;
  if (switched) $("group-settings").open = draft.open;
}

function renderGroupPicker() {
  const retained = new Set(state.groups.map((group) => group.id));
  for (const [id, row] of groupButtons) {
    if (!retained.has(id)) {
      row.button.remove();
      groupButtons.delete(id);
      rowsByGroup.delete(id);
      groupDrafts.delete(id);
      addDrafts.delete(id);
    }
  }
  const ordered = [...state.groups].sort((a, b) => Number(b.id === "essentials") - Number(a.id === "essentials"));
  ordered.forEach((group, index) => {
    let row = groupButtons.get(group.id);
    if (!row) {
      const button = make("button", "group-choice");
      button.type = "button";
      const dot = make("span", "color-dot");
      dot.setAttribute("aria-hidden", "true");
      const label = make("span", "group-choice-name");
      const meta = make("span", "group-choice-meta");
      button.append(dot, label, meta);
      button.addEventListener("click", () => void selectGroup(group.id));
      row = { button, dot, label, meta };
      groupButtons.set(group.id, row);
    }
    row.dot.dataset.color = group.color;
    row.label.textContent = group.name;
    row.meta.textContent = `${group.entryCount}${group.active ? " · Active" : ""}`;
    row.button.setAttribute("aria-label", `${group.name}, ${group.entryCount} saved ${group.entryCount === 1 ? "tab" : "tabs"}${group.active ? ", active" : ""}`);
    row.button.classList.toggle("is-selected", group.id === selectedWorkspaceId);
    if (group.id === selectedWorkspaceId) row.button.setAttribute("aria-current", "page");
    else row.button.removeAttribute("aria-current");
    const position = $("group-picker").children[index];
    if (position !== row.button) $("group-picker").insertBefore(row.button, position || null);
  });
}

function render(next) {
  const nextId = next.selectedGroupId || "essentials";
  const switched = nextId !== selectedWorkspaceId;
  if (switched) {
    saveVisibleDrafts();
    $("entries").replaceChildren();
  }
  selectedWorkspaceId = nextId;
  state = next;
  loaded = true;
  $("current-group-title").textContent = state.groupName;
  $("selected-color").dataset.color = state.groupColor;
  $("group-status").textContent = state.active ? "Active" : "Ready";
  $("group-status").classList.toggle("is-active", state.active);
  $("launch").textContent = `${state.active ? "Show" : "Launch"} ${state.groupName}`;
  $("close").textContent = `Close ${state.groupName}`;
  $("entry-count").textContent = String(state.entries.length);
  $("warning").textContent = state.warning || "";
  $("warning").hidden = !state.warning;
  $("empty").hidden = state.entries.length !== 0;
  $("empty-help").textContent = state.acceptDrops
    ? "Add an open tab below, or enter a website address. Once the group is running, you can also drop tabs into it to save them."
    : "Add an open tab below, or enter a website address. This group saves tabs only when you use an Add command.";
  renderGroupPicker();
  fillGroupSettings(next, switched);

  if (switched) {
    const draft = addDrafts.get(selectedWorkspaceId);
    $("new-url").value = draft?.url || "";
    $("new-label").value = draft?.label || "";
    $("add-address-details").open = draft?.open || false;
    $("open-tabs").value = draft?.tabId || "";
  }
  const rows = currentRows();
  const retained = new Set(state.entries.map((entry) => entry.id));
  for (const [id, row] of rows) {
    if (!retained.has(id)) { row.li.remove(); rows.delete(id); }
  }
  state.entries.forEach((entry, index) => {
    let row = rows.get(entry.id);
    if (!row) { row = createRow(entry, selectedWorkspaceId); rows.set(entry.id, row); }
    row.number.textContent = String(index + 1).padStart(2, "0");
    row.title.textContent = entry.label;
    row.host.textContent = hostname(entry.lastValidUrl);
    row.up.setAttribute("aria-label", `Move ${entry.label} up`);
    row.down.setAttribute("aria-label", `Move ${entry.label} down`);
    row.remove.setAttribute("aria-label", `Remove ${entry.label} from ${state.groupName}`);
    row.lastUrl.textContent = entry.lastValidUrl;
    if (!row.dirty) fillDraft(row, entry);
    // Reuse each group's elements, preserving site drafts and open disclosures across switches.
    const position = $("entries").children[index];
    if (position !== row.li) $("entries").insertBefore(row.li, position || null);
  });
  syncControls();
}

async function selectGroup(workspaceId) {
  if (workspaceId === selectedWorkspaceId) return;
  await operation(async () => {
    render(await requestState(workspaceId));
    await refreshTabs();
  });
}

async function reorder(workspaceId, id, offset) {
  if (workspaceId !== selectedWorkspaceId) return;
  const ids = state.entries.map((entry) => entry.id);
  const index = ids.indexOf(id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  await operation(async () => {
    render(await request("reorder", { workspaceId, ids }));
  }, "Tab order saved.");
}

async function refreshState() {
  if (busy || refreshing) { refreshAgain = true; return; }
  refreshing = true;
  const version = operationVersion;
  const workspaceId = selectedWorkspaceId;
  try {
    const next = await requestState(workspaceId);
    if (busy || version !== operationVersion || workspaceId !== selectedWorkspaceId) refreshAgain = true;
    else {
      render(next);
      if (next.selectedGroupId !== workspaceId) {
        showFeedback("That saved group was removed. Showing Essentials.");
        await refreshTabs();
      }
    }
  } catch (error) {
    showFeedback(error.message || String(error), true);
  } finally {
    refreshing = false;
    if (refreshAgain && !busy) { refreshAgain = false; void refreshState(); }
  }
}

async function refreshTabs() {
  const workspaceId = selectedWorkspaceId;
  const version = ++tabsRequestVersion;
  const previous = $("open-tabs").value;
  let result;
  try {
    result = await request("getOpenTabs", { workspaceId });
  } catch (error) {
    if (version !== tabsRequestVersion || workspaceId !== selectedWorkspaceId) return;
    throw error;
  }
  if (version !== tabsRequestVersion || workspaceId !== selectedWorkspaceId) return;
  openTabs = result.tabs;
  const placeholder = make("option", "", openTabs.length ? "Select an open tab…" : "No website tabs are open");
  placeholder.value = "";
  $("open-tabs").replaceChildren(placeholder);
  for (const tab of openTabs) {
    const host = hostname(tab.url);
    const option = make("option", "", `${tab.title || host}${host && tab.title ? ` — ${host}` : ""}`);
    option.value = String(tab.id);
    $("open-tabs").append(option);
  }
  if (openTabs.some((tab) => String(tab.id) === previous)) $("open-tabs").value = previous;
  syncControls();
}

for (const id of ["group-color", "new-group-color"]) {
  for (const color of colors) {
    const option = make("option", "", color[0].toUpperCase() + color.slice(1));
    option.value = color;
    option.defaultSelected = color === "blue";
    $(id).append(option);
  }
}

$("launch").addEventListener("click", () => {
  const workspaceId = selectedWorkspaceId;
  const name = state.groupName;
  void operation(async () => render(await request("launch", { workspaceId })), `Opened ${name}.`);
});

$("close").addEventListener("click", () => {
  const workspaceId = selectedWorkspaceId;
  const name = state.groupName;
  void operation(async () => render(await request("close", { workspaceId })), `Closed ${name}. Your saved tabs are ready for next time.`);
});

$("group-settings-form").addEventListener("input", () => {
  groupDrafts.set(selectedWorkspaceId, {
    name: $("group-name").value,
    color: $("group-color").value,
    acceptDrops: $("accept-drops").checked,
    dirty: true,
    open: $("group-settings").open,
  });
  $("group-edit-state").textContent = "Unsaved changes";
  syncControls();
});

$("group-settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const workspaceId = selectedWorkspaceId;
  const fields = {
    workspaceId,
    name: $("group-name").value.trim(),
    color: $("group-color").value,
    acceptDrops: $("accept-drops").checked,
  };
  void operation(async () => {
    const next = await request("updateGroup", fields);
    const draft = groupDrafts.get(workspaceId);
    if (draft) draft.dirty = false;
    render(next);
  }, "Group settings saved.");
});

$("cancel-group").addEventListener("click", () => {
  const draft = groupDrafts.get(selectedWorkspaceId);
  if (draft) draft.dirty = false;
  fillGroupSettings(state, false);
  syncControls();
});

$("new-group-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = { name: $("new-group-name").value.trim(), color: $("new-group-color").value, acceptDrops: true };
  void operation(async () => {
    render(await request("createGroup", fields));
    $("new-group-form").reset();
    $("new-group-details").open = false;
    await refreshTabs();
  }, `Created ${fields.name}. Add a tab to get started.`);
});

$("delete-group").addEventListener("click", () => {
  if (selectedWorkspaceId === "essentials") return;
  pendingDelete = { workspaceId: selectedWorkspaceId, name: state.groupName };
  $("delete-heading").textContent = `Delete ${state.groupName}?`;
  $("delete-description").textContent = `This removes the group and its ${state.entries.length} saved ${state.entries.length === 1 ? "tab" : "tabs"}. Open pages stay open as ordinary tabs. This cannot be undone.`;
  $("delete-dialog").showModal();
  $("cancel-delete").focus();
});

$("cancel-delete").addEventListener("click", () => $("delete-dialog").close());
$("delete-dialog").addEventListener("close", () => { pendingDelete = null; });
$("confirm-delete").addEventListener("click", () => {
  if (!pendingDelete) return;
  const { workspaceId, name } = pendingDelete;
  $("delete-dialog").close();
  void operation(async () => {
    render(await request("deleteGroup", { workspaceId }));
    await refreshTabs();
  }, `Deleted ${name}. Any open pages stay open.`);
});

$("open-tabs").addEventListener("change", syncControls);
$("refresh-tabs").addEventListener("click", () => void operation(refreshTabs, "Open tabs refreshed."));

$("add-tab-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("open-tabs").value) return;
  const workspaceId = selectedWorkspaceId;
  const name = state.groupName;
  const tabId = Number($("open-tabs").value);
  void operation(async () => {
    render(await request("addTab", { workspaceId, tabId }));
    $("open-tabs").value = "";
    await refreshTabs();
  }, `Tab added to ${name}.`);
});

$("add-url-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const workspaceId = selectedWorkspaceId;
  const name = state.groupName;
  const url = $("new-url").value.trim();
  const label = $("new-label").value.trim();
  void operation(async () => {
    render(await request("addUrl", { workspaceId, url, ...(label ? { label } : {}) }));
    $("add-url-form").reset();
  }, `Website saved to ${name}.`);
});

window.addEventListener("focus", () => {
  void refreshState();
  void refreshTabs().catch((error) => showFeedback(error.message || String(error), true));
});
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local" || area === "session") void refreshState();
});

await refreshState();
try { await refreshTabs(); } catch (error) { showFeedback(error.message || String(error), true); }
