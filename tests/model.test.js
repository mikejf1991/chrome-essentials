import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWebUrl, normalizeHosts, classifyUrl, defaultAuthHosts,
  createEntry, validateEntryUpdate, sanitizeEntries,
} from "../extension/model.js";

test("web URL normalization preserves the last app route, query, and fragment", () => {
  assert.equal(
    normalizeWebUrl(" HTTPS://MAIL.GOOGLE.COM:443/mail/u/1/?search=a%2Bb#inbox/123 "),
    "https://mail.google.com/mail/u/1/?search=a%2Bb#inbox/123",
  );
  assert.equal(normalizeWebUrl("http://localhost:3000/app#draft"), "http://localhost:3000/app#draft");
});

test("only complete web URLs without embedded credentials are accepted", () => {
  for (const input of [undefined, null, 42, {}, "", "mail.google.com", "//mail.google.com",
    "javascript:alert(1)", "data:text/html,hello", "file:///tmp/index.html", "chrome://newtab",
    "https://user:secret@mail.google.com/", "https://user@mail.google.com/"]) {
    assert.throws(() => normalizeWebUrl(input), Error, String(input));
  }
});

test("hostname lists canonicalize case, IDNA, terminal DNS dots, and duplicate values", () => {
  assert.deepEqual(normalizeHosts(" Mail.Google.com, MAIL.google.com.\nlocalhost\tbücher.example "),
    ["mail.google.com", "localhost", "xn--bcher-kva.example"]);
  assert.deepEqual(normalizeHosts(["example.com", " EXAMPLE.COM "]), ["example.com"]);
  assert.deepEqual(normalizeHosts(""), []);
});

test("hostnames cannot smuggle URL syntax, wildcards, or invalid DNS labels", () => {
  for (const host of ["https://mail.google.com", "mail.google.com:443", "mail.google.com/path",
    "mail.google.com?x=y", "mail.google.com#hash", "*.google.com", "mail.google.com@evil.com",
    "mail.google.com\\evil.com", "mail.google.com%2eevil.com", "-mail.google.com",
    "mail-.google.com", ".google.com", "google..com", "google.com..", "a".repeat(64) + ".com",
    "mail_google.com", "", 123, null]) {
    assert.throws(() => normalizeHosts([host]), Error, String(host));
  }
  assert.throws(() => normalizeHosts({ hostname: "mail.google.com" }), /list/);
  assert.throws(() => normalizeHosts(Array.from({ length: 33 }, (_, i) => `h${i}.example.com`)), /32/);
});

test("domain classification uses an exact hostname boundary", () => {
  const entry = createEntry("https://mail.google.com/mail/u/0/#inbox", "Mail", "gmail");
  for (const url of ["https://mail.google.com/mail/u/0/#inbox/456", "http://mail.google.com/",
    "https://MAIL.GOOGLE.COM:8443/mail", "https://mail.google.com./mail"]) {
    assert.equal(classifyUrl(entry, url), "app", url);
  }
  for (const url of ["https://mail.google.com.evil.example/", "https://evilmail.google.com/",
    "https://google.com/", "https://docs.google.com/", "https://sub.mail.google.com/",
    "https://mail.google.com@evil.example/", "https://evil.example/?return=https://mail.google.com",
    "javascript:location='https://mail.google.com'", "chrome://newtab", "about:blank", undefined]) {
    assert.equal(classifyUrl(entry, url), "outside", String(url));
  }
  assert.equal(classifyUrl({ allowedHosts: "mail.google.com.evil.example" }, "https://mail.google.com/"), "outside");
  assert.equal(classifyUrl(null, "https://mail.google.com/"), "outside");
});

test("recognized sign-in hosts are transit sites, not saved app addresses", () => {
  const gmail = createEntry("https://mail.google.com/", undefined, "gmail");
  assert.equal(classifyUrl(gmail, "https://accounts.google.com/ServiceLogin?continue=https://mail.google.com"), "auth");
  assert.equal(classifyUrl(gmail, "https://accounts.google.com.evil.example/"), "outside");
  assert.equal(classifyUrl(gmail, "https://sub.accounts.google.com/"), "outside");
  assert.equal(classifyUrl(gmail, "https://user:secret@accounts.google.com/"), "outside");
  const outlook = createEntry("https://outlook.office.com/mail/", undefined, "outlook");
  for (const host of ["login.microsoftonline.com", "login.live.com", "login.microsoft.com"]) {
    assert.equal(classifyUrl(outlook, `https://${host}/signin`), "auth");
  }
});

test("implicit auth sites are limited to explicitly recognized app hosts", () => {
  for (const host of ["mail.google.com", "calendar.google.com", "drive.google.com", "docs.google.com", "messages.google.com"]) {
    assert.deepEqual(defaultAuthHosts(host), ["accounts.google.com"]);
  }
  for (const host of ["outlook.office.com", "outlook.office365.com", "outlook.live.com"]) {
    assert.equal(defaultAuthHosts(host).length, 3);
  }
  for (const host of ["google.com", "my.google.com", "mail.google.com.evil.example", "office.com", "acme.odoo.com", "localhost"]) {
    assert.deepEqual(defaultAuthHosts(host), []);
  }
});

test("new entries derive boundaries and names without losing the exact web route", () => {
  const entry = createEntry("https://mail.google.com/mail/u/1/#inbox/123", " Work Gmail ", "work-mail");
  assert.deepEqual(entry, {
    id: "work-mail", label: "Work Gmail", lastValidUrl: "https://mail.google.com/mail/u/1/#inbox/123",
    allowedHosts: ["mail.google.com"], authHosts: ["accounts.google.com"],
  });
  assert.equal(createEntry("https://example.com", " ", "example").label, "example.com");
  assert.match(createEntry("https://example.com").id, /^[\da-f-]{36}$/i);
  assert.throws(() => createEntry("https://example.com", "a".repeat(101)), /100/);
  assert.throws(() => createEntry("https://example.com", undefined, ""), /identifier/);
});

test("settings updates preserve identity and last valid address and do not mutate input", () => {
  const entry = createEntry("https://acme.odoo.com/web#action=123", "Odoo", "odoo");
  const before = structuredClone(entry);
  const updated = validateEntryUpdate(entry, {
    id: "replaced", lastValidUrl: "https://evil.example/", label: " Work ERP ",
    allowedHosts: "ACME.odoo.com, reports.acme.com", authHosts: ["login.acme.com"], extra: "discard",
  });
  assert.deepEqual(updated, {
    id: "odoo", label: "Work ERP", lastValidUrl: entry.lastValidUrl,
    allowedHosts: ["acme.odoo.com", "reports.acme.com"], authHosts: ["login.acme.com"],
  });
  assert.deepEqual(entry, before);
  assert.equal(classifyUrl(updated, "https://reports.acme.com/monthly"), "app");
  assert.equal(classifyUrl(updated, "https://login.acme.com/sign-in"), "auth");
});

test("settings reject boundaries that remove the saved site or mix app and auth roles", () => {
  const entry = createEntry("https://mail.google.com/mail/#inbox", "Gmail", "gmail");
  assert.throws(() => validateEntryUpdate(entry, { allowedHosts: [] }), /at least one/);
  assert.throws(() => validateEntryUpdate(entry, { allowedHosts: ["docs.google.com"] }), /last saved/);
  assert.throws(() => validateEntryUpdate(entry, { authHosts: ["mail.google.com"] }), /both/);
  assert.throws(() => validateEntryUpdate(entry, { label: " " }), /name/);
  assert.throws(() => validateEntryUpdate(entry, { label: "a".repeat(101) }), /100/);
  assert.throws(() => validateEntryUpdate(null), /invalid/);
  assert.throws(() => validateEntryUpdate(entry, []), /object/);
  assert.deepEqual(validateEntryUpdate(entry, { authHosts: [] }).authHosts, []);
});

test("storage recovery skips damaged and duplicate entries while retaining order", () => {
  const gmail = createEntry("https://mail.google.com/#inbox", "Gmail", "gmail");
  const odoo = createEntry("https://acme.odoo.com/web", "Odoo", "odoo");
  const records = [null, gmail, { ...gmail, lastValidUrl: "javascript:alert(1)" },
    { ...odoo, allowedHosts: ["evil.example"] }, { ...gmail, label: "duplicate" }, odoo, {}];
  assert.deepEqual(sanitizeEntries(records), [gmail, odoo]);
  assert.deepEqual(sanitizeEntries(undefined), []);
  assert.deepEqual(sanitizeEntries({}), []);
});
