// A stand-in for the snap's chrome. It chooses its profile as Chromium does (chrome/app/chrome_main_delegate.cc
// InitializeUserDataDir, chrome/common/chrome_paths_linux.cc GetDefaultUserDataDirectory):
//   1. the last --user-data-dir; when empty, the environment's CHROME_USER_DATA_DIR;
//   2. when that directory cannot be created, or none is given: the default, $CHROME_CONFIG_HOME/chromium (else
//      $XDG_CONFIG_HOME/chromium, else $HOME/.config/chromium);
//   3. when the default cannot be created either: exit (no profile).
// Every start is appended to $FAKE_STARTS (profile, relevant environment, arguments) before anything is written. It
// then writes into the profile, creates its singleton directory in $TMPDIR with the profile's SingletonSocket link, and
// on SIGTERM removes the singleton directory and exits. FAKE_STUBBORN=1: SIGTERM is ignored. FAKE_BREAK_PROFILE=1: before
// choosing, the profile directory given is removed and its parent made read-only (a failure after pi-gui's checks).
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const env = process.env;
const given = process.argv.filter(arg => arg.startsWith("--user-data-dir=")).map(arg => arg.slice("--user-data-dir=".length)).at(-1) ?? "";
if (env.FAKE_BREAK_PROFILE && given) {
  rmSync(given, { recursive: true, force: true });
  chmodSync(dirname(given), 0o500);
}
const create = dir => { try { mkdirSync(dir, { recursive: true }); return true; } catch { return false; } };
let profile = given || env.CHROME_USER_DATA_DIR || "";
if (!profile || !create(profile)) {
  const configHome = env.CHROME_CONFIG_HOME || env.XDG_CONFIG_HOME || join(env.HOME ?? "/", ".config");
  profile = join(configHome, "chromium");
  if (!create(profile)) profile = "";
}
const seen = Object.fromEntries(["CHROME_CONFIG_HOME", "CHROME_USER_DATA_DIR", "HOME", "XDG_CACHE_HOME", "TMPDIR", "BREAKPAD_DUMP_LOCATION", "CHROMIUM_FLAGS"].map(name => [name, env[name] ?? null]));
// `kept`: what an earlier start wrote into this profile was there (a persistent profile).
const kept = !!profile && existsSync(join(profile, "Default", "Cookies"));
appendFileSync(env.FAKE_STARTS, `${JSON.stringify({ pid: process.pid, profile: profile || null, given, kept, env: seen, args: process.argv.slice(2) })}\n`);
if (!profile) process.exit(21);
mkdirSync(join(profile, "Default"), { recursive: true });
writeFileSync(join(profile, "Default", "Cookies"), "worker cookies");
const singleton = mkdtempSync(join(env.TMPDIR || "/tmp", "org.chromium.Chromium."));
// A link left by an earlier start (its browser is gone) is replaced, as Chromium takes over a stale singleton.
rmSync(join(profile, "SingletonSocket"), { force: true });
symlinkSync(join(singleton, "SingletonSocket"), join(profile, "SingletonSocket"));
process.on("SIGTERM", () => {
  if (env.FAKE_STUBBORN) return;
  rmSync(singleton, { recursive: true, force: true });
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
