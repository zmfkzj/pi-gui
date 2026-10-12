#!/bin/bash
# A stand-in for `/usr/bin/snap run --shell chromium -c SCRIPT NAME ARGS…`: it sets the environment snapd and the
# chromium app set (CHROME_CONFIG_HOME=$SNAP_USER_COMMON, i.e. the user's profile root; HOME=$SNAP_USER_DATA;
# TMPDIR=/tmp), then runs the script with bash, as the snap's shell does after the command chain.
# FAKE_SNAP_CALLS: appended on every call. FAKE_BEFORE_SCRIPT: shell code run first, with $launch_dir set (races).
# FAKE_BYPASS=1: run the browser directly with FAKE_BYPASS_ARGS instead of the script (a broken snap).
printf 'call %s\n' "$$" >> "$FAKE_SNAP_CALLS"
[ "$1 $2 $3 $4" = "run --shell chromium -c" ] || { echo "fake snap: unexpected arguments $*" >&2; exit 2; }
script=$5; shift 5
launch_dir=$3
export SNAP="$FAKE_SNAP_ROOT" SNAP_REVISION="${FAKE_SNAP_REVISION:-1}" SNAP_INSTANCE_NAME=chromium
export CHROME_CONFIG_HOME="$FAKE_USER_COMMON" HOME="$FAKE_SNAP_USER_DATA" XDG_CACHE_HOME="$FAKE_USER_COMMON/.cache" TMPDIR="$FAKE_TMP"
if [ -n "${FAKE_BEFORE_SCRIPT:-}" ]; then eval "$FAKE_BEFORE_SCRIPT"; fi
if [ -n "${FAKE_BYPASS:-}" ]; then exec "$SNAP/usr/lib/chromium-browser/chrome" $FAKE_BYPASS_ARGS; fi
exec bash -c "$script" "$@"
