#!/usr/bin/env bash
# Test stand-in for backup.sh, used by deploy tests: records the call and exits with $STUB_BACKUP_EXIT.
printf 'backup %s\n' "$*" >>"$STUB_LOG"
exit "${STUB_BACKUP_EXIT:-0}"
