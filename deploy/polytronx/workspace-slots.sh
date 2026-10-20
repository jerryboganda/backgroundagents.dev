#!/usr/bin/env bash
#
# Workspace slots for the VPS executor: 10 GiB ext4 images, each loop-mounted at
# /srv/vps-ws/slots/<k>. A sandbox binds one slot as its /workspace (packages/vps-executor/src/workspace.ts).
# EXECUTOR_WORKSPACE_SLOTS controls the host count (3-16, default 16); configure it before
# provisioning and use the same value in the executor release.env. Existing slots are never shrunk.
#
#   workspace-slots.sh --check   read-only: one PASS or FAIL line per item; exit 1 on any FAIL
#   workspace-slots.sh --apply   as root, once: creates what is missing and mounts each slot
#
# --apply judges the whole host first, so a refusal changes no image and no fstab line. It never
# formats, overwrites or removes an existing image or file. It mounts each slot by its own path,
# never with mount -a, and it never runs fsck. It backs up /etc/fstab, then appends only
# the missing slot lines. Re-running it is safe: an expected existing slot is left alone.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MAX_SLOT_COUNT=16
SLOT_COUNT="${EXECUTOR_WORKSPACE_SLOTS:-16}"
# The default free-slot reserve is 2; leave at least one other workspace usable.
if [[ ! "$SLOT_COUNT" =~ ^([3-9]|1[0-6])$ ]]; then
  echo "FAIL  EXECUTOR_WORKSPACE_SLOTS must be an integer from 3 through 16" >&2
  exit 2
fi
SLOT_BYTES=10737418240          # 10 GiB, the size of every image (fallocate -l 10G)
FS_MIN_BYTES=9663676416         # 9 GiB: the filesystem inside an image is a little smaller than the image
HOST_FREE_MIN_BYTES=32212254720 # 30 GiB that must stay free on the images' filesystem
# nofail alone only wants the mount from local-fs.target; x-systemd.before orders it ahead of docker.service.
MOUNT_OPTS="loop,nosuid,nodev,noatime,nofail,x-systemd.before=docker.service"
# The base path can move only so the tests can run against a scratch directory.
BASE="${POLYTRONX_WS_BASE:-/srv/vps-ws}"
IMAGE_DIR="$BASE/images"
SLOT_ROOT="$BASE/slots"
FSTAB="${POLYTRONX_FSTAB:-/etc/fstab}"

image_of() { echo "$IMAGE_DIR/slot-$1.img"; }
dir_of() { echo "$SLOT_ROOT/$1"; }
fstab_line() { printf '%s %s ext4 %s 0 0\n' "$(image_of "$1")" "$(dir_of "$1")" "$MOUNT_OPTS"; }

# The state functions below print one word or a reason, and always succeed, so callers can capture them.

# ok, missing, or why the image is not the expected ext4 image.
image_state() {
  local img
  img="$(image_of "$1")"
  if [ -L "$img" ]; then echo "is a symlink"
  elif [ ! -e "$img" ]; then echo missing
  elif [ ! -f "$img" ]; then echo "is not a regular file"
  elif [ "$(stat -c '%u %g %a %s' "$img")" != "0 0 600 $SLOT_BYTES" ]; then echo "is not root 0600 at 10 GiB"
  elif [ "$(blkid -p -s TYPE -o value "$img" 2>/dev/null || true)" != ext4 ]; then echo "holds no ext4 filesystem"
  else echo ok
  fi
}

# ok, missing, empty (a root 0700 directory with nothing in it), or why it is not.
empty_dir_state() {
  local dir="$1"
  if [ -L "$dir" ]; then echo "is a symlink"
  elif [ ! -e "$dir" ]; then echo missing
  elif [ ! -d "$dir" ]; then echo "is not a directory"
  elif [ "$(stat -c '%u %g %a' "$dir")" != "0 0 700" ]; then echo "is not root 0700"
  elif [ -n "$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)" ]; then echo "is not empty"
  else echo empty
  fi
}

# absent, ok (exactly the expected line), or differs (another entry for this slot's image or mountpoint).
fstab_state() {
  local found
  found="$(awk -v d="$(dir_of "$1")" -v i="$(image_of "$1")" \
    '!/^[ \t]*#/ && ($1 == i || $2 == d) { $1 = $1; print }' "$FSTAB" 2>/dev/null || true)"
  if [ -z "$found" ]; then echo absent
  elif [ "$found" = "$(fstab_line "$1")" ]; then echo ok
  else echo differs
  fi
}

# unmounted, ok, or why the filesystem mounted at this slot's path is not the expected one.
mount_state() {
  local dir img line src fstype opts backing magic bsize blocks
  dir="$(dir_of "$1")"
  img="$(image_of "$1")"
  line="$(findmnt -rn -o TARGET,SOURCE,FSTYPE,OPTIONS --target "$dir" 2>/dev/null || true)"
  if [ "$(awk '{ print $1 }' <<<"$line")" != "$dir" ]; then
    echo unmounted
    return 0
  fi
  read -r _ src fstype opts <<<"$line" || true
  backing="$(losetup -n -O BACK-FILE "$src" 2>/dev/null || true)"
  read -r magic bsize blocks <<<"$(stat -f -c '%t %S %b' "$dir")" || true
  if [ "$fstype" != ext4 ]; then echo "is $fstype, not ext4"
  elif [[ ",$opts," != *,nosuid,* || ",$opts," != *,nodev,* || ",$opts," != *,noatime,* ]]; then
    echo "lacks nosuid, nodev or noatime"
  elif [ "$backing" != "$img" ]; then echo "is not mounted from its image"
  elif [ "$(stat -c '%u %g %a' "$dir")" != "1000 1000 700" ]; then echo "root is not 1000:1000 mode 700"
  elif [ "$magic" != ef53 ]; then echo "is not ext4 on disk"
  elif ((blocks * bsize < FS_MIN_BYTES || blocks * bsize > SLOT_BYTES)); then echo "filesystem is outside 9 to 10 GiB"
  else echo ok
  fi
}

# Sets PLAN_CREATE, PLAN_FSTAB and PLAN_MOUNT for slot $1. Returns 1, with PLAN_WHY, for any state
# this script does not expect; that slot is then left alone and the run stops before any change.
plan_slot() {
  local k="$1" img_s fst_s mnt_s dir_s
  img_s="$(image_state "$k")"
  fst_s="$(fstab_state "$k")"
  mnt_s="$(mount_state "$k")"
  PLAN_CREATE=0 PLAN_FSTAB=0 PLAN_MOUNT=0 PLAN_WHY=""
  if [ "$img_s" = missing ]; then
    PLAN_CREATE=1
  elif [ "$img_s" != ok ]; then
    PLAN_WHY="image $(image_of "$k") $img_s"
    return 1
  fi
  case "$fst_s" in
    absent) PLAN_FSTAB=1 ;;
    ok) [ "$img_s" = ok ] || { PLAN_WHY="fstab entry without an image"; return 1; } ;;
    *) PLAN_WHY="fstab differs from the expected line for this slot"; return 1 ;;
  esac
  case "$mnt_s" in
    unmounted)
      PLAN_MOUNT=1
      dir_s="$(empty_dir_state "$(dir_of "$k")")"
      case "$dir_s" in
        missing | empty) ;;
        *) PLAN_WHY="directory $(dir_of "$k") $dir_s"; return 1 ;;
      esac
      ;;
    ok) ;;
    *) PLAN_WHY="mount $mnt_s"; return 1 ;;
  esac
  return 0
}

# PASS or FAIL for a root-owned real directory with exactly this mode. Returns 1 on FAIL.
check_dir() {
  local facts
  if [ -L "$1" ] || [ ! -d "$1" ]; then
    echo "FAIL  $1 is missing or not a real directory"
    return 1
  fi
  facts="$(stat -c '%u %g %a' "$1")"
  if [ "$facts" = "0 0 $2" ]; then
    echo "PASS  $1 is root-owned, mode $2"
    return 0
  fi
  echo "FAIL  $1 is $facts (uid gid mode), want 0 0 $2"
  return 1
}

# PASS or FAIL for the free space on the images' filesystem once $1 more bytes are allocated.
free_check() {
  local free_kb free
  free_kb="$(df -Pk "$IMAGE_DIR" 2>/dev/null | awk 'NR == 2 { print $4 }' || true)"
  if [ -z "$free_kb" ]; then
    echo "FAIL  cannot read the free space on $IMAGE_DIR"
    return 1
  fi
  free=$((free_kb * 1024 - $1))
  if [ "$free" -ge "$HOST_FREE_MIN_BYTES" ]; then
    echo "PASS  $((free / 1073741824)) GiB free on $IMAGE_DIR after allocation; 30 GiB must stay free"
    return 0
  fi
  echo "FAIL  $((free / 1073741824)) GiB free on $IMAGE_DIR after allocation; 30 GiB must stay free"
  return 1
}

# PASS or FAIL for one slot: its image, its fstab line and its mount must all be as expected.
check_slot() {
  local k="$1" img_s fst_s mnt_s
  img_s="$(image_state "$k")"
  fst_s="$(fstab_state "$k")"
  mnt_s="$(mount_state "$k")"
  if [ "$img_s" = ok ] && [ "$fst_s" = ok ] && [ "$mnt_s" = ok ]; then
    echo "PASS  slot $k: mounted at $(dir_of "$k") from $(image_of "$k"), fstab matches"
    return 0
  fi
  echo "FAIL  slot $k: image $img_s; fstab $fst_s; mount $mnt_s"
  return 1
}

# A smaller host setting may never hide previously provisioned higher slots.
# Refuse a shrink even if the executor database has not been opened yet.
check_unconfigured_slots() {
  local k rc=0
  for ((k = SLOT_COUNT; k < MAX_SLOT_COUNT; k++)); do
    if [ -e "$(image_of "$k")" ] || [ -L "$(image_of "$k")" ] ||
      [ -e "$(dir_of "$k")" ] || [ -L "$(dir_of "$k")" ] ||
      [ "$(fstab_state "$k")" != absent ]; then
      echo "FAIL  slot $k exists outside configured EXECUTOR_WORKSPACE_SLOTS=$SLOT_COUNT; refusing to shrink a provisioned host"
      rc=1
    fi
  done
  return "$rc"
}

# Every check, one line each. Returns 1 when any line is a FAIL.
check_all() {
  local k rc=0
  check_dir "$BASE" 755 || rc=1
  check_dir "$IMAGE_DIR" 700 || rc=1
  check_dir "$SLOT_ROOT" 755 || rc=1
  free_check 0 || rc=1
  check_unconfigured_slots || rc=1
  for ((k = 0; k < SLOT_COUNT; k++)); do
    check_slot "$k" || rc=1
  done
  return "$rc"
}

# A new image, formatted once. Only called for a slot whose image does not exist.
create_image() {
  local img
  img="$(image_of "$1")"
  [ ! -e "$img" ] || die "refusing to create over $img"
  (umask 077 && fallocate -l 10G "$img")
  mkfs.ext4 -q -F -m 0 -N 262144 -E root_owner=1000:1000 "$img"
  info "slot $1: image created and formatted"
}

# Mounts one slot by its own path, through its fstab line. $2 is 1 when its image was made in this run.
mount_slot() {
  local dir
  dir="$(dir_of "$1")"
  [ -e "$dir" ] || { mkdir "$dir" && chmod 700 "$dir"; }
  mount "$dir" || die "mount of $dir failed; the run stops here. Fix the cause and re-run."
  if [ "$2" = 1 ]; then chmod 700 "$dir"; fi
  [ "$(mount_state "$1")" = ok ] || die "slot $1 mounted but is not as expected: $(mount_state "$1")"
  info "slot $1: mounted at $dir"
}

backup_fstab() {
  local bak="$FSTAB.polytronx-workspace-$(date -u +%Y%m%dT%H%M%SZ).bak"
  cp -p -n "$FSTAB" "$bak"
  info "fstab backed up to $bak"
}

append_fstab() { # $1 slot
  if [ -s "$FSTAB" ] && [ -n "$(tail -c 1 "$FSTAB")" ]; then printf '\n' >>"$FSTAB"; fi
  fstab_line "$1" >>"$FSTAB"
  info "slot $1: fstab line added"
}

apply() {
  local dirs=("$BASE" "$IMAGE_DIR" "$SLOT_ROOT") modes=(755 700 755)
  local -a CREATE=() FSTAB_ADD=() MOUNT_NOW=()
  local i k failed=0 missing=0 fstab_changes=0
  [ "$(id -u)" = 0 ] || die "--apply runs as root"
  [ -f "$FSTAB" ] || die "fstab not found: $FSTAB"

  # Everything is judged before anything changes.
  check_unconfigured_slots || failed=1
  for ((i = 0; i < 3; i++)); do
    if [ -e "${dirs[i]}" ] || [ -L "${dirs[i]}" ]; then
      check_dir "${dirs[i]}" "${modes[i]}" || failed=1
    fi
  done
  for ((k = 0; k < SLOT_COUNT; k++)); do
    if plan_slot "$k"; then
      CREATE[k]=$PLAN_CREATE
      FSTAB_ADD[k]=$PLAN_FSTAB
      MOUNT_NOW[k]=$PLAN_MOUNT
      missing=$((missing + PLAN_CREATE))
      fstab_changes=$((fstab_changes + PLAN_FSTAB))
    else
      echo "FAIL  slot $k: $PLAN_WHY"
      failed=1
    fi
  done
  [ "$failed" = 0 ] || die "nothing was changed; resolve the FAIL lines above"

  for ((i = 0; i < 3; i++)); do
    [ -e "${dirs[i]}" ] || { mkdir "${dirs[i]}" && chmod "${modes[i]}" "${dirs[i]}"; }
  done
  free_check $((missing * SLOT_BYTES)) || die "no image or fstab line was changed"

  if [ "$fstab_changes" -gt 0 ]; then backup_fstab; fi
  for ((k = 0; k < SLOT_COUNT; k++)); do
    if [ "${CREATE[k]}" = 1 ]; then create_image "$k"; fi
    if [ "${FSTAB_ADD[k]}" = 1 ]; then append_fstab "$k"; fi
    if [ "${MOUNT_NOW[k]}" = 1 ]; then mount_slot "$k" "${CREATE[k]}"; fi
  done
  if [ "$fstab_changes" -gt 0 ] && command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload; fi

  if check_all; then
    echo "workspace slots: provisioned; all checks pass"
  else
    die "a check still fails after --apply; see the FAIL lines above"
  fi
}

mode="${1:-}"
case "$mode" in
  --check | --apply) ;;
  *)
    echo "usage: workspace-slots.sh --check | --apply" >&2
    exit 2
    ;;
esac
require_cmd findmnt losetup blkid stat df awk find id fallocate mkfs.ext4 mount chmod

if [ "$mode" = --apply ]; then
  apply
  exit 0
fi
if check_all; then
  echo "workspace slots: all checks pass"
  exit 0
fi
echo "workspace slots: not as expected; --apply (as root, once) provisions what is missing" >&2
exit 1
