const MAX_HOSTS = 32;
const MAX_LABEL_LENGTH = 100;

/** Return a canonical web URL while retaining its path, query, and fragment. */
export function normalizeWebUrl(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Enter a complete http:// or https:// address.");
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid, complete http:// or https:// address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http:// and https:// addresses can be Essentials.");
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error("Use a web address without a username or password in the URL.");
  }
  return url.href;
}

function normalizeHostname(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Each site must be a hostname, such as mail.google.com.");
  }
  const raw = input.trim();
  // These are hostname fields, never URL patterns or suffix matches. Reject URL
  // syntax before parsing so a port, path, or credentials cannot be hidden here.
  if (/[\s/\\:@?#%*\[\]]/u.test(raw)) {
    throw new Error(`Use only a hostname for “${raw}”, without a protocol, port, path, or wildcard.`);
  }
  let hostname;
  try {
    hostname = new URL(`https://${raw}/`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new Error(`“${raw}” is not a valid hostname.`);
  }
  const labels = hostname.split(".");
  if (hostname.length > 253 || labels.some((label) =>
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error(`“${raw}” is not a valid hostname.`);
  }
  return hostname;
}

/** Accept hostnames separated by whitespace or commas, or an array of hosts. */
export function normalizeHosts(input) {
  const values = typeof input === "string"
    ? input.trim().split(/[\s,]+/u).filter(Boolean)
    : input;
  if (!Array.isArray(values)) {
    throw new Error("Sites must be a list of hostnames.");
  }
  const hosts = [...new Set(values.map(normalizeHostname))];
  if (hosts.length > MAX_HOSTS) {
    throw new Error(`Use no more than ${MAX_HOSTS} sites in each list.`);
  }
  return hosts;
}

function hostnameOf(url) {
  return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * Match exact hostnames only. HTTP/HTTPS and their ports share the app boundary;
 * subdomains do not. Authentication hosts are temporary transit, never saved.
 */
export function classifyUrl(entry, input) {
  let hostname;
  try {
    hostname = hostnameOf(normalizeWebUrl(input));
  } catch {
    return "outside";
  }
  if (Array.isArray(entry?.allowedHosts) && entry.allowedHosts.includes(hostname)) return "app";
  if (Array.isArray(entry?.authHosts) && entry.authHosts.includes(hostname)) return "auth";
  return "outside";
}

export function defaultAuthHosts(host) {
  const hostname = normalizeHostname(host);
  const googleApps = [
    "mail.google.com", "calendar.google.com", "drive.google.com",
    "docs.google.com", "messages.google.com",
  ];
  const outlookApps = ["outlook.office.com", "outlook.office365.com", "outlook.live.com"];
  if (googleApps.includes(hostname)) return ["accounts.google.com"];
  if (outlookApps.includes(hostname)) {
    return ["login.microsoftonline.com", "login.live.com", "login.microsoft.com"];
  }
  return [];
}

function normalizeLabel(label) {
  if (typeof label !== "string" || !label.trim()) {
    throw new Error("Give this essential a name.");
  }
  const value = label.trim();
  if (value.length > MAX_LABEL_LENGTH) {
    throw new Error(`Names must be ${MAX_LABEL_LENGTH} characters or fewer.`);
  }
  return value;
}

function validateId(id) {
  if (typeof id !== "string" || !id.trim()) {
    throw new Error("This essential has an invalid identifier.");
  }
  return id;
}

export function createEntry(input, label, id) {
  const lastValidUrl = normalizeWebUrl(input);
  const host = normalizeHostname(hostnameOf(lastValidUrl));
  return {
    id: id === undefined ? crypto.randomUUID() : validateId(id),
    label: label === undefined || (typeof label === "string" && !label.trim())
      ? host : normalizeLabel(label),
    lastValidUrl,
    allowedHosts: [host],
    authHosts: defaultAuthHosts(host),
  };
}

/** Settings can change the name and boundaries, but never identity or history. */
export function validateEntryUpdate(entry, changes = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("This essential is invalid.");
  }
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    throw new Error("Essential settings must be an object.");
  }
  const lastValidUrl = normalizeWebUrl(entry.lastValidUrl);
  const allowedHosts = normalizeHosts(changes.allowedHosts ?? entry.allowedHosts);
  const authHosts = normalizeHosts(changes.authHosts ?? entry.authHosts ?? []);
  if (!allowedHosts.length) {
    throw new Error("Keep at least one app hostname.");
  }
  if (!allowedHosts.includes(hostnameOf(lastValidUrl))) {
    throw new Error("App sites must include the hostname of the last saved address.");
  }
  if (authHosts.some((host) => allowedHosts.includes(host))) {
    throw new Error("A site cannot be both an app site and a sign-in site.");
  }
  return {
    id: validateId(entry.id),
    label: normalizeLabel(changes.label ?? entry.label),
    lastValidUrl,
    allowedHosts,
    authHosts,
  };
}

/** Recover valid stored entries independently; damaged records cannot crash startup. */
export function sanitizeEntries(records) {
  if (!Array.isArray(records)) return [];
  const seen = new Set();
  const entries = [];
  for (const record of records) {
    try {
      const entry = validateEntryUpdate(record);
      if (!seen.has(entry.id)) {
        entries.push(entry);
        seen.add(entry.id);
      }
    } catch {
      // Keep remaining valid entries in their original order.
    }
  }
  return entries;
}
