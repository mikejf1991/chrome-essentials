# Essentials for Chrome

A toolbar button for your everyday apps, with additional named groups for different activities. Launch Essentials when you want it, then edit it by dropping tabs into the group. The extension remembers the order and each app's latest valid address.

## Install

Requires Chrome 150 or newer. No build step or Node installation is required to use the extension.

1. Open `chrome://extensions` in your usual Chrome profile.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the **extension** folder inside your downloaded or cloned copy of this project.
4. Open Chrome's Extensions menu (the puzzle piece) and pin **Essentials**.
5. Open Gmail or another app, right-click its tab, and choose **Add this tab to saved group → Essentials**. This creates the group. Drop other existing tabs into it, or add them from **Manage saved groups**.

The list starts empty so you choose the correct accounts and your actual Odoo, Outlook, and Messages addresses. The settings page can add existing open tabs or a full website address.

Keep this project folder in place while the unpacked extension is installed. After a code update, click the extension's **Reload** button on `chrome://extensions`. Protection resumes automatically for existing matching saved groups; groups you closed remain closed. Existing saved entries migrate automatically to the new group format; the original configuration is also retained once in local extension storage as a migration backup. If using the ZIP from `dist`, extract it to a permanent folder and load that folder instead.

If you used version 0.2.0 and a visible group stopped replacing tabs after Reload, update to 0.2.1 and reload again. If the whole group is already gone, click Essentials or use **Open saved group** to launch its saved tabs.

## Named groups

Right-click the extension's toolbar button → **Manage saved groups** → **New group**. Give it a name and color, then add open tabs or website addresses. Each group keeps its own saved list, app boundaries, order, and active window. All groups use the same restoration behavior.

The main toolbar button always opens Essentials. Open or close another group from its settings controls or the toolbar's **Open saved group** / **Close saved group** submenu. Each saved group can run once per profile, and different groups can live in different windows.

Essentials stays first in its window, immediately after individually pinned tabs. Other active saved groups follow in creation order, ahead of ordinary tabs and unrelated native groups. Group settings let you rename custom groups, change colors, or disable drag-to-add for a particular group. Essentials keeps its name and cannot be deleted.

Deleting a custom group forgets its saved list and leaves its open pages as ordinary tabs. Closing a group retains its saved list for later. Adding an already-protected tab to another group copies its saved entry and opens a separate tab; the original group retains its membership.

## Everyday behavior

| Action | Result |
| --- | --- |
| Click the toolbar button | Launch Essentials in the current window, or show its existing window |
| Drop an existing tab into a saved group | Save it and its position after it stays put for about a second and Chrome permits tab edits |
| Drag past a group and leave it again | Keep the saved list unchanged |
| Rearrange the group | Save the new order automatically |
| Browse within an app's allowed hostname | Remember the full latest address, including query and fragment |
| Navigate an essential outside its allowed sites | Keep that live tab outside the group and open its last valid app address in the saved slot |
| Drag a tab out of the group or to another window | Keep the moved tab usable and restore its saved slot |
| Close an individual essential | Reopen its last valid app address |
| Right-click **Remove this tab from saved group** | Forget that entry, ungroup its tab, and leave the page open |
| Right-click the toolbar button → **Close saved group** → choose a name | Turn that group's protection off and close it while keeping its saved list |
| Close its browser window | Close normally; do not recreate the group elsewhere |

New link tabs stay outside the group until you deliberately add them. Clicking a launcher repeatedly does not duplicate its saved tabs. Dropping a protected tab into another saved group restores its source slot and, after settling, saves the moved tab in the destination too.

Moving the entire group to another window carries Essentials with it. If dragging an individual tab away empties its original window, the extension creates a replacement Essentials window in the background while keeping the detached tab separate. Actual window-closing events do not create a replacement window.

Chrome's built-in **Remove from group** is treated like dragging out, so a replacement appears. Use the extension's **Remove this tab from saved group** command to remove a saved entry. Tab-menu actions apply to the tab you right-clicked.

## App boundaries and sign-in

Each entry starts with the exact hostname where you added it, such as `mail.google.com`. Other subdomains are separate. HTTP/HTTPS and different ports on the same hostname count as the same app boundary. Paths, queries, and fragments are retained in the saved address.

Right-click the Essentials toolbar button → **Manage saved groups**, select a group, then use **Website settings** to change an entry's name, allowed app hostnames, or sign-in hostnames. App hosts update its remembered address; sign-in hosts let authentication finish without replacing that address. Common Google and Outlook sign-in hosts are supplied automatically. Add your organization's SSO host if needed.

If a restored app unexpectedly redirects to an unrecognized site, that entry pauses in place and the toolbar shows **!**. This prevents a loop of replacement tabs. Return that tab to its app or add the appropriate hostname in its settings. The warning clears once the page is allowed again.

Restoration opens the saved URL afresh. It does not restore unsaved form contents or other page memory. The original tab you drag out or navigate away remains intact. Chrome controls its native drag preview, so a tab may temporarily appear inside a group while crossing it; that preview does not immediately save membership. A tab created and immediately dragged into a group during its initial settling period may be moved back out; **Add this tab to saved group** is the direct alternative.

## Startup

Essentials does not automatically launch at browser startup. Your saved list remains ready for the toolbar button. Chrome's own **Continue where you left off** setting can still restore its native tabs; choose **Open the New Tab page** in `chrome://settings/onStartup` if you want a bare startup. Essentials does not change that preference.

Protection resumes separately for each group when you launch it. A native restored group with its saved name and matching addresses is reused where possible.

An extension update or Reload is handled separately from browser startup: open saved groups regain protection automatically. Exact saved addresses are matched first; a changed app address is reused only when it uniquely identifies one saved entry. When account identity is ambiguous or a tab has left its allowed websites, that live page stays open outside the group and the saved address is reopened. Multiple equally matching native groups with the same name require a manual launch instead of guessing which one to protect.

## Data and permissions

All configuration stays in this Chrome profile's extension storage. The extension does not use a server, analytics, external scripts, or page content scripts. Removing the extension removes its saved list.

| Permission | Purpose |
| --- | --- |
| `tabs` | Read tab addresses/titles and manage their positions and lifetimes |
| `tabGroups` | Manage saved groups and their positions |
| `storage` | Save the list and retain active bindings across worker restarts |
| `contextMenus` | Add tab and toolbar right-click actions |
| `webNavigation` | Track committed addresses and in-app URL changes |
| `alarms` | Recover missed changes while the group is active |

Only regular browsing windows are supported; incognito is disabled. Group tabs are marked non-discardable to reduce automatic unloading, but this does not guarantee uninterrupted notifications or prevent websites from expiring login sessions.

## Development and checks

The runtime extension is plain JavaScript with no build dependencies. Node and Playwright are development tools only.

```powershell
npm install
npm run check
npm test
npx playwright install chromium
npm run test:browser
npm run test:groups
npm run test:reload
npm run package
```

The packaging command uses Python's standard library and produces `dist/essentials-0.2.1.zip`. Browser checks create disposable profiles and local fixture pages under `output/playwright`; they never attach to the user's Chrome profile. Set `HEADED=1` to see the test browser. Set `PLAYWRIGHT_MODULE_PATH` only if using a separately installed Playwright runtime.

The real-browser suites cover navigation and SPA/hash history, inherited new-tab exclusion, settled drops and transient crossings, explicit add/remove, ordering after pinned tabs, independent groups, migration, tab detachment and replacement, whole-group moves, sign-in redirects, service-worker restart, extension reload, window closure, and browser startup. Native mouse-drag gesture feel and your apps' particular login flows should also be checked during the first personal trial.

## Implementation references

- [Chrome tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome navigation events](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)
- [Chrome 150 tab-strip context menus](https://developer.chrome.com/docs/extensions/whats-new#chrome_150_tab_strip_context_menus)

Chrome reports closure after it occurs; this extension restores closed tabs rather than canceling the close.
