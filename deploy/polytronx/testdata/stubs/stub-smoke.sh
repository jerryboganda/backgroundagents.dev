#!/usr/bin/env bash
# Test stand-in for smoke.sh, used by deploy and rollback tests: records the call and exits with $STUB_SMOKE_EXIT.
printf 'smoke %s\n' "$*" >>"$STUB_LOG"
exit "${STUB_SMOKE_EXIT:-0}"
