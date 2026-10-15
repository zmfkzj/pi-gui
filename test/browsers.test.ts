// Worker desktops open web browsers only with a disposable profile: classification of desktop entries (in-memory files).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_PROFILE_ID, agentProfileBusy, checkWorkerLaunch, classifyLaunch, execProgram, isBrowserEntry, listBrowsers, NO_BROWSER_ID, SNAP_CHROMIUM_ID, SNAP_CHROMIUM_SUPERVISOR,
  snapChromiumEntry, snapChromiumShim, webDefaultsEnv, webDefaultsFiles,
  type BrowserEnv, type BrowserFs, type BrowserVerdict,
} from "../src/browsers.ts";
import { routeToolCall } from "../src/policy.ts";

const entry = (fields: Record<string, string>, actions = "") =>
  `[Desktop Entry]\nType=Application\n${Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n")}\n${actions}`;

function memoryEnv(files: Record<string, string>, links: Record<string, string> = {}): BrowserEnv {
  const fs: BrowserFs = {
    readFile: path => { if (!(path in files)) throw new Error(`ENOENT ${path}`); return files[path]!; },
    realpath: path => links[path] ?? path,
    isFile: path => path in files,
    readdir: dir => [...new Set(Object.keys(files).filter(path => path.startsWith(`${dir}/`)).map(path => path.slice(dir.length + 1).split("/")[0]!))],
  };
  return { dataDirs: ["/usr/share", "/var/lib/snapd/desktop"], path: ["/usr/bin"], fs };
}

const http = "text/html;x-scheme-handler/http;x-scheme-handler/https;";
const files = {
  "/usr/share/applications/google-chrome.desktop": entry({ Name: "Google Chrome", Exec: "/usr/bin/google-chrome-stable %U", MimeType: http, Categories: "Network;WebBrowser;" }, "[Desktop Action new-window]\nExec=/usr/bin/google-chrome-stable --user-data-dir=/elsewhere\n"),
  "/usr/bin/google-chrome-stable": "#!/bin/bash\nexec -a \"$0\" /opt/google/chrome/chrome \"$@\"\n",
  "/opt/google/chrome/google-chrome": "#!/bin/bash\nexec -a \"$0\" /opt/google/chrome/chrome \"$@\"\n",
  "/usr/share/applications/chromium.desktop": entry({ Exec: "env GDK_BACKEND=wayland chromium %U", MimeType: http }),
  "/usr/bin/chromium": "#!/bin/sh\nexec /usr/lib/chromium/chromium \"$@\"\n",
  "/usr/share/applications/firefox.desktop": entry({ Exec: "firefox %u", MimeType: http, Categories: "Network;WebBrowser;" }),
  "/usr/bin/firefox": "#!/bin/sh\nexec /usr/lib/firefox/firefox \"$@\"\n",
  "/usr/share/applications/chromium-browser.desktop": entry({ Exec: "chromium-browser %U", Categories: "Network;WebBrowser;", NoDisplay: "true" }),
  "/usr/bin/chromium-browser": "#!/bin/sh\nif ! [ -x /snap/bin/chromium ]; then exit 1; fi\nexec /snap/bin/chromium \"$@\"\n",
  "/var/lib/snapd/desktop/applications/firefox_firefox.desktop": entry({ Exec: "/snap/bin/firefox %u", MimeType: http, "X-SnapInstanceName": "firefox" }),
  "/usr/share/applications/org.mozilla.firefox.desktop": entry({ Exec: "/usr/bin/flatpak run org.mozilla.firefox @@u %u @@", MimeType: http, "X-Flatpak": "org.mozilla.firefox" }),
  "/usr/share/applications/chrome-work.desktop": entry({ Exec: "google-chrome-stable --user-data-dir=/home/u/.config/google-chrome %U", MimeType: http }),
  "/usr/share/applications/chrome-profile.desktop": entry({ Exec: "google-chrome-stable --profile-directory=Default %U", MimeType: http }),
  "/usr/share/applications/kde-konqbrowser.desktop": entry({ Exec: "konqueror %u", Categories: "Qt;KDE;Network;WebBrowser;" }),
  "/usr/bin/konqueror": "\x7fELF",
  "/usr/share/applications/org.kde.keditbookmarks.desktop": entry({ Exec: "keditbookmarks", Categories: "Qt;KDE;Network;WebBrowser;" }),
  "/usr/share/applications/lost.desktop": entry({ Exec: "/usr/bin/lost-browser %U", MimeType: http }),
  "/usr/share/applications/org.kde.kwrite.desktop": entry({ Exec: "kwrite %U", MimeType: "text/plain;", Categories: "Utility;TextEditor;" }),
};
const env = memoryEnv(files, { "/usr/bin/google-chrome-stable": "/opt/google/chrome/google-chrome" });

test("browsers: Chromium-family browsers outside snap/Flatpak have a disposable profile on a private desktop", () => {
  for (const id of ["google-chrome.desktop", "chromium.desktop", "chrome-profile.desktop", "google-chrome"]) {
    const verdict = classifyLaunch(id, env);
    assert.equal(verdict.browser && verdict.disposable, true, `${id}: ${JSON.stringify(verdict)}`);
  }
});

test("browsers: browsers that would open the user's own profile are refused, each with its reason", () => {
  const reasons: Record<string, RegExp> = {
    "firefox.desktop": /may open the user's profile under \$HOME/,
    "chromium-browser.desktop": /starts a snap/,
    "firefox_firefox.desktop": /is a snap/,
    "org.mozilla.firefox.desktop": /Flatpak/,
    "chrome-work.desktop": /fixed profile/,
    "kde-konqbrowser.desktop": /may open the user's profile/,
    "lost.desktop": /program \/usr\/bin\/lost-browser was not found/,
  };
  for (const [id, reason] of Object.entries(reasons)) {
    const verdict = classifyLaunch(id, env);
    assert.ok(verdict.browser && !verdict.disposable, `${id}: ${JSON.stringify(verdict)}`);
    assert.match((verdict as { reason: string }).reason, reason, id);
  }
});

test("browsers: other apps are not browsers (a bookmark editor, an editor, an unknown ID)", () => {
  for (const id of ["org.kde.keditbookmarks.desktop", "org.kde.kwrite.desktop"]) {
    const verdict = classifyLaunch(id, env);
    assert.equal(verdict.browser, false, id);
    assert.equal(verdict.entry?.id, id);
  }
  assert.deepEqual(classifyLaunch("missing.desktop", env), { browser: false }, "no entry");
  for (const id of ["../applications/google-chrome.desktop", "x/../../share/applications/google-chrome.desktop", ".hidden.desktop"]) {
    assert.deepEqual(classifyLaunch(id, env), { browser: false }, `${id}: not a desktop ID`);
  }
});

test("browsers: listing and Exec parsing", () => {
  const listed = listBrowsers(env).map(verdict => `${verdict.entry.id}:${verdict.disposable}`).sort();
  assert.deepEqual(listed, [
    "chrome-profile.desktop:true", "chrome-work.desktop:false", "chromium-browser.desktop:false", "chromium.desktop:true", "firefox.desktop:false",
    "firefox_firefox.desktop:false", "google-chrome.desktop:true", "kde-konqbrowser.desktop:false", "lost.desktop:false", "org.mozilla.firefox.desktop:false",
  ]);
  assert.equal(execProgram("env BAMF=1 /snap/bin/chromium %U"), "/snap/bin/chromium");
  assert.equal(execProgram("\"/opt/My Browser/chrome\" %U"), "/opt/My Browser/chrome");
  assert.equal(isBrowserEntry({ id: "x", path: "x", categories: ["WebBrowser"], mimeTypes: [], snap: false, flatpak: false }), false);
});

test("policy: a worker's launch check refuses on both tool surfaces (direct and compact dispatch)", () => {
  const checkLaunch = (id: string) => id.startsWith("firefox") ? "refused: user profile" : undefined;
  const options = { allowPhysicalDesktop: false, checkLaunch };
  assert.equal(routeToolCall("launch_application", { desktop_id: "firefox.desktop" }, options), "refused: user profile");
  assert.equal(routeToolCall("dispatch", { action: "launch_application", arguments: { desktop_id: "firefox.desktop" } }, options), "refused: user profile");
  const allowed = { desktop_id: "google-chrome.desktop" };
  assert.equal(routeToolCall("launch_application", allowed, options), undefined);
  assert.equal((allowed as Record<string, unknown>).desktop, "background");
  // The physical-desktop refusal still comes first; the main session (no check) is unchanged.
  assert.match(routeToolCall("launch_application", { desktop_id: "google-chrome.desktop", desktop: "foreground" }, options)!, /private desktop/);
  assert.equal(routeToolCall("launch_application", { desktop_id: "firefox.desktop" }, { allowPhysicalDesktop: false }), undefined);
});

const more = {
  ...files,
  "/usr/share/applications/org.kde.konsole.desktop": entry({ Exec: "konsole", Categories: "Qt;KDE;System;TerminalEmulator;" }),
  "/usr/share/applications/xterm.desktop": entry({ Exec: "xterm", Categories: "System;" }),
  "/usr/share/applications/run-link.desktop": entry({ Exec: "sh -c 'xdg-open https://example.com'" }),
  "/usr/share/applications/py.desktop": entry({ Exec: "/usr/bin/python3 -c 'import webbrowser'" }),
  "/usr/share/applications/org.kde.krunner.desktop": entry({ Exec: "krunner" }),
  "/usr/share/applications/systemsettings.desktop": entry({ Exec: "systemsettings" }),
  "/usr/share/applications/chrome-home.desktop": entry({ Exec: "env HOME=/home/u google-chrome-stable %U", MimeType: http }),
  "/usr/share/applications/chrome-xdg.desktop": entry({ Exec: "env XDG_CONFIG_HOME=/home/u/.config google-chrome-stable %U", MimeType: http }),
  "/usr/share/applications/chrome-sh.desktop": entry({ Exec: "sh -c 'google-chrome-stable --user-data-dir=$HOME/.config/google-chrome'", MimeType: http }),
  "/usr/share/applications/org.gnome.Epiphany.desktop": entry({ Exec: "epiphany %U", MimeType: http, DBusActivatable: "true" }),
  "/usr/share/applications/noexec.desktop": entry({ Name: "No exec" }),
};
const env2 = memoryEnv(more, { "/usr/bin/google-chrome-stable": "/opt/google/chrome/google-chrome" });

test("worker launches: unknown IDs, program launchers, command wrappers and moved profiles are refused", () => {
  const reasons: Record<string, RegExp> = {
    "missing.desktop": /no such application entry was found/,
    "org.kde.konsole.desktop": /it is a terminal/,
    "xterm.desktop": /it is a terminal/,
    "run-link.desktop": /runs a command line through sh/,
    "py.desktop": /runs a command line through python3/,
    "org.kde.krunner.desktop": /starts programs or changes the desktop's default applications \(krunner\)/,
    "systemsettings.desktop": /\(systemsettings\)/,
    "chrome-home.desktop": /sets environment variables that can move the profile/,
    "chrome-xdg.desktop": /sets environment variables that can move the profile/,
    "chrome-sh.desktop": /launcher names a fixed profile|runs a command through sh/,
    "org.gnome.Epiphany.desktop": /started through D-Bus/,
    "noexec.desktop": /no Exec line/,
    "firefox.desktop": /only Chromium-family browsers/,
  };
  for (const [id, reason] of Object.entries(reasons)) assert.match(checkWorkerLaunch(id, env2) ?? "allowed", reason, id);
  for (const id of ["google-chrome.desktop", "chromium.desktop", "org.kde.kwrite.desktop", "org.kde.keditbookmarks.desktop"]) assert.equal(checkWorkerLaunch(id, env2), undefined, id);
});

test("worker web defaults: a disposable browser, or a no-op handler, and every other browser removed", () => {
  const verdicts = listBrowsers(env);
  const withChrome = webDefaultsFiles(verdicts, "/usr/bin/true");
  const chrome = verdicts.find(verdict => verdict.disposable)!.entry.id;
  for (const type of ["x-scheme-handler/http", "x-scheme-handler/https", "text/html", "application/xhtml+xml"]) assert.match(withChrome.mimeapps, new RegExp(`\\[Default Applications\\][^[]*${type.replace(/[/+]/g, "\\$&")}=${chrome.replace(".", "\\.")};`));
  assert.match(withChrome.mimeapps, /\[Removed Associations\]\nx-scheme-handler\/http=[^\n]*firefox_firefox\.desktop;/);
  assert.equal(withChrome.noBrowser, undefined);
  assert.doesNotMatch(withChrome.kdeMimeapps, /Removed|Added/, "desktop-specific files may only set defaults");
  const none = webDefaultsFiles(verdicts.filter(verdict => !verdict.disposable), "/usr/bin/true");
  assert.match(none.mimeapps, new RegExp(`x-scheme-handler/https=${NO_BROWSER_ID.replace(".", "\\.")};`));
  assert.match(none.noBrowser!, /^Exec=\/usr\/bin\/true %u$/m);
});

/** GIO and xdg-mime, as the private desktop's apps see them: an empty XDG_CONFIG_HOME/XDG_DATA_HOME plus the pinned dirs. */
const gioAvailable = existsSync("/usr/bin/gio") && existsSync("/usr/bin/xdg-mime");
test("worker web defaults: GIO and xdg-mime resolve web links to the pinned handler, not the system default", { skip: !gioAvailable && "gio/xdg-mime not installed" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-gui-webdefaults-"));
  const hostEnv = { ...process.env, XDG_DATA_DIRS: process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share" };
  const browsers: BrowserVerdict[] = listBrowsers({ dataDirs: hostEnv.XDG_DATA_DIRS.split(":"), path: (process.env.PATH ?? "").split(":") }).filter(verdict => !verdict.disposable);
  const pinned = webDefaultsEnv(join(scratch, "root"), browsers, hostEnv);
  assert.ok(pinned.XDG_DATA_DIRS, "no allowed browser here: the no-op handler's data dir is added");
  const sessionEnv = { ...hostEnv, ...pinned, XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"), XDG_CURRENT_DESKTOP: "KDE" };
  for (const type of ["x-scheme-handler/https", "x-scheme-handler/http", "text/html"]) {
    const gio = execFileSync("gio", ["mime", type], { env: sessionEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.match(gio, new RegExp(`Default application for “${type}”: ${NO_BROWSER_ID.replace(".", "\\.")}`), gio);
    assert.doesNotMatch(gio.split("Registered applications:")[1] ?? "", /firefox|chromium/i, "other browsers are removed from the associations");
    const xdg = execFileSync("xdg-mime", ["query", "default", type], { env: sessionEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    assert.equal(xdg, NO_BROWSER_ID);
  }
  assert.ok(existsSync(pinned.BROWSER!), "BROWSER is an absolute no-op program");
  assert.match(readFileSync(join(pinned.XDG_CONFIG_DIRS!.split(":")[0]!, "kde-mimeapps.list"), "utf8"), /^\[Default Applications\]$/m);
});

test("policy: read-only workers may only observe, on both tool surfaces, failing closed", () => {
  const options = { allowPhysicalDesktop: false, readOnlyRole: "verify" };
  assert.match(routeToolCall("act", { operation: {} }, options)!, /act is refused: this worker's role \(verify\) is read-only/);
  assert.match(routeToolCall("dispatch", { action: "act", arguments: {} }, options)!, /act is refused/);
  assert.match(routeToolCall("dispatch", { action: "act" }, options)!, /dispatch "act" is refused/);
  assert.match(routeToolCall("dispatch", { arguments: {} }, options)!, /dispatch null is refused/);
  assert.match(routeToolCall("future_tool", {}, options)!, /future_tool is refused/);
  for (const operation of ["list_desktop", "launch_application", "activate_window", "observe", "wait_for"]) {
    assert.equal(routeToolCall(operation, {}, options), undefined, operation);
    assert.equal(routeToolCall("dispatch", { action: operation, arguments: {} }, options), undefined, operation);
  }
  assert.equal(routeToolCall("help", { action: "act" }, options), undefined, "help only describes");
  assert.equal(routeToolCall("act", {}, { allowPhysicalDesktop: false }), undefined, "writing roles act");
});

test("snap Chromium: only pi-gui's temporary-profile entry, when offered; the snap's own entries stay refused with a pointer to it", () => {
  const snapEnv = memoryEnv({ ...files, "/var/lib/snapd/desktop/applications/chromium_chromium.desktop": entry({ Exec: "/snap/bin/chromium %U", MimeType: http, "X-SnapInstanceName": "chromium", Categories: "Network;WebBrowser;" }, "[Desktop Action TempProfile]\nExec=/snap/bin/chromium --temp-profile\n") });
  for (const id of [SNAP_CHROMIUM_ID, "pi-gui-chromium-temp-profile"]) {
    assert.equal(checkWorkerLaunch(id, snapEnv, { snapChromium: true }), undefined, id);
    assert.match(checkWorkerLaunch(id, snapEnv)!, /not offered here/, id);
  }
  // The snap's own entry (its TempProfile action included: an action is not a launchable desktop ID) and the wrapper.
  for (const id of ["chromium_chromium.desktop", "chromium-browser.desktop"]) {
    assert.match(checkWorkerLaunch(id, snapEnv, { snapChromium: true })!, /snap.*launch pi-gui-chromium-temp-profile\.desktop: the same snap Chromium with a temporary profile/s, id);
  }
  assert.match(checkWorkerLaunch("firefox_firefox.desktop", snapEnv, { snapChromium: true })!, /is a snap/, "other snaps stay refused");
  // Entry and shim: one program for launches, links and $BROWSER.
  const launch = { node: "/usr/bin/node", supervisor: SNAP_CHROMIUM_SUPERVISOR, log: "/a/gui-snap-chromium.log" };
  assert.equal(snapChromiumShim(launch), `#!/bin/sh\n# Written by pi-gui: snap Chromium with a temporary profile on a worker's private desktop.\nPI_GUI_SNAP_CHROMIUM_PROFILE='' PI_GUI_SNAP_CHROMIUM_LOG='/a/gui-snap-chromium.log' exec '/usr/bin/node' '${SNAP_CHROMIUM_SUPERVISOR}' "$@"\n`, "the temporary entry clears any inherited agent profile");
  assert.match(snapChromiumShim({ ...launch, log: "/it's/log" }), /PI_GUI_SNAP_CHROMIUM_LOG='\/it'\\''s\/log'/);
  assert.match(snapChromiumEntry("/x/shim"), /^Exec=\/x\/shim %U$/m);
  assert.throws(() => snapChromiumEntry("/x/a b/shim"), /needs quoting/, "xdg-mime would skip a quoted program");
  assert.doesNotMatch(snapChromiumEntry("/x/shim"), /DBusActivatable|Actions=|snap\/bin/);
  // Links: pi-gui's entry is the handler when no non-snap browser is disposable; the snap's entries are removed.
  const verdicts = listBrowsers(snapEnv).filter(verdict => !verdict.disposable);
  const pinned = webDefaultsFiles(verdicts, "/usr/bin/true", "/x/shim");
  assert.match(pinned.mimeapps, /\[Default Applications\]\nx-scheme-handler\/http=pi-gui-chromium-temp-profile\.desktop;/);
  assert.match(pinned.mimeapps, /\[Removed Associations\][^[]*x-scheme-handler\/https=[^\n]*chromium_chromium\.desktop;/);
  assert.equal(pinned.noBrowser, undefined);
  assert.match(pinned.snapChromium!, /^Exec=\/x\/shim %U$/m);
  // A disposable non-snap browser stays the handler; pi-gui's entry is still written (launchable).
  const withChrome = webDefaultsFiles(listBrowsers(snapEnv), "/usr/bin/true", "/x/shim");
  assert.match(withChrome.mimeapps, /x-scheme-handler\/http=(google-chrome|chromium|chrome-profile)\.desktop;/);
  assert.ok(withChrome.snapChromium);
});

test("agent profile entry: offered only when given, never a link handler; busy refusals name the holder and what to do", () => {
  const snapEnv = memoryEnv(files);
  // Not offered (no workerBrowserProfile, read-only role or no snap Chromium): refused with the reason.
  for (const id of [AGENT_PROFILE_ID, "pi-gui-chromium-agent-profile"]) {
    assert.match(checkWorkerLaunch(id, snapEnv, { snapChromium: true })!, /agent browser profile is not offered here.*workerBrowserProfile/, id);
    assert.equal(checkWorkerLaunch(id, snapEnv, { snapChromium: true, agentProfile: () => undefined }), undefined, id);
    assert.equal(checkWorkerLaunch(id, snapEnv, { snapChromium: true, agentProfile: () => "busy" }), "busy", id);
  }
  assert.equal(checkWorkerLaunch(SNAP_CHROMIUM_ID, snapEnv, { snapChromium: true, agentProfile: () => "busy" }), undefined, "the temporary entry is not affected");
  const launch = { node: "/usr/bin/node", supervisor: SNAP_CHROMIUM_SUPERVISOR, log: "/a/log" };
  assert.match(snapChromiumShim(launch, "work"), /^PI_GUI_SNAP_CHROMIUM_PROFILE='work' PI_GUI_SNAP_CHROMIUM_LOG='\/a\/log' exec /m);
  const entryText = snapChromiumEntry("/x/agent", "work");
  assert.match(entryText, /^Exec=\/x\/agent %U$/m);
  assert.doesNotMatch(entryText, /MimeType/, "links never open in the agent profile");
  // Busy: on this desktop (its own tag), on another worker's, elsewhere, a left browser, a lock being taken.
  const owner = (tag?: string) => ({ owner: { pid: 1, runtime: "/r", profile: "/p", agentProfile: "work", display: "wayland-virtual-7", ...(tag ? { tag } : {}) }, dir: "/d" });
  assert.equal(agentProfileBusy("work", undefined, "t1"), undefined);
  assert.match(agentProfileBusy("work", owner("t1"), "t1")!, /already open on this desktop .*Use that window: list_desktop/);
  const other = agentProfileBusy("work", owner("t2"), "t1", tag => tag === "t2" ? "W3" : undefined)!;
  assert.match(other, /already open on worker W3's private desktop\. A profile can be open on one desktop at a time.*Wait until.*pi-gui-chromium-temp-profile\.desktop \(signed out\)/);
  assert.match(agentProfileBusy("work", owner("t9"), "t1")!, /another private desktop \(wayland-virtual-7, not a worker of this Pi session\)/);
  assert.match(agentProfileBusy("work", { pid: 42 }, "t1")!, /browser process \(42\)/);
  assert.match(agentProfileBusy("work", { lock: true }, "t1")!, /a launch with it is starting/);
});

test("snap Chromium web defaults: GIO and xdg-mime resolve links to pi-gui's entry; $BROWSER is its shim", { skip: !gioAvailable && "gio/xdg-mime not installed" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "pi-gui-snapweb-"));
  const hostEnv = { ...process.env, XDG_DATA_DIRS: process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share" };
  const browsers = listBrowsers({ dataDirs: hostEnv.XDG_DATA_DIRS.split(":"), path: (process.env.PATH ?? "").split(":") }).filter(verdict => !verdict.disposable);
  const pinned = webDefaultsEnv(join(scratch, "root"), browsers, hostEnv, { node: process.execPath, supervisor: SNAP_CHROMIUM_SUPERVISOR, log: join(scratch, "log"), agentProfile: "work" });
  const sessionEnv = { ...hostEnv, ...pinned, XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"), XDG_CURRENT_DESKTOP: "KDE" };
  for (const type of ["x-scheme-handler/https", "x-scheme-handler/http", "text/html"]) {
    const gio = execFileSync("gio", ["mime", type], { env: sessionEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    assert.match(gio, new RegExp(`Default application for “${type}”: ${SNAP_CHROMIUM_ID.replace(/\./g, "\\.")}`), gio);
    assert.doesNotMatch(gio.split("Registered applications:")[1] ?? "", /chromium_chromium|chromium-browser|firefox/i);
    assert.equal(execFileSync("xdg-mime", ["query", "default", type], { env: sessionEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), SNAP_CHROMIUM_ID);
  }
  const shim = pinned.BROWSER!;
  assert.ok(existsSync(shim) && readFileSync(shim, "utf8").includes(SNAP_CHROMIUM_SUPERVISOR), shim);
  assert.match(readFileSync(join(pinned.XDG_DATA_DIRS!.split(":")[0]!, "applications", SNAP_CHROMIUM_ID), "utf8"), new RegExp(`^Exec=${shim.replace(/[.]/g, "\\.")} %U$`, "m"));
  // The agent-profile entry is launchable (its own shim names the profile) but handles no link: links stay signed out.
  const agentEntry = readFileSync(join(pinned.XDG_DATA_DIRS!.split(":")[0]!, "applications", AGENT_PROFILE_ID), "utf8");
  const agentShim = /^Exec=(\S+) %U$/m.exec(agentEntry)?.[1];
  assert.ok(agentShim && agentShim !== shim && readFileSync(agentShim, "utf8").includes("PI_GUI_SNAP_CHROMIUM_PROFILE='work'"), agentEntry);
  assert.ok(readFileSync(shim, "utf8").includes("PI_GUI_SNAP_CHROMIUM_PROFILE=''"));
});
