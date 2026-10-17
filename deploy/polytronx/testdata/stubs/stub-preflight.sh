#!/usr/bin/env bash
# Test stand-in for preflight.sh: records the call and exits with $STUB_PREFLIGHT_EXIT.
printf 'preflight %s\n' "$*" >>"$STUB_LOG"
exit "${STUB_PREFLIGHT_EXIT:-0}"
