#!/usr/bin/env python3
# Stand-in for xdg-desktop-portal-kde in test/portal-activation.test.ts: it never touches Wayland or Qt. It logs its start
# ("start <pid> <arguments>") to $FAKE_PORTAL_LOG and asks the session bus for the backend's name like a KDBusService would:
# allowing replacement, replacing an owner only with --replace, never queueing. Primary owner: "owner <pid>", then it
# serves until killed or the name is taken ("lost <pid>", exit 0). Otherwise "refused <pid>" and exit 1.
import os
import sys

import gi

gi.require_version("Gio", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

NAME = "org.freedesktop.impl.portal.desktop.kde"
ALLOW_REPLACEMENT, REPLACE_EXISTING, DO_NOT_QUEUE = 1, 2, 4


def log(event: str, args: str = "") -> None:
    with open(os.environ["FAKE_PORTAL_LOG"], "a", encoding="utf-8") as file:
        file.write(f"{event} {os.getpid()} {args}".rstrip() + "\n")


log("start", " ".join(sys.argv[1:]))
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
flags = ALLOW_REPLACEMENT | DO_NOT_QUEUE | (REPLACE_EXISTING if "--replace" in sys.argv[1:] else 0)
reply = bus.call_sync(
    "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "RequestName",
    GLib.Variant("(su)", (NAME, flags)), GLib.VariantType("(u)"), Gio.DBusCallFlags.NONE, -1, None,
)
if reply.unpack()[0] != 1:
    log("refused")
    sys.exit(1)
log("owner")
loop = GLib.MainLoop()


def lost(*_args) -> None:
    log("lost")
    loop.quit()


bus.signal_subscribe("org.freedesktop.DBus", "org.freedesktop.DBus", "NameLost", "/org/freedesktop/DBus", NAME,
                     Gio.DBusSignalFlags.NONE, lost)
loop.run()
