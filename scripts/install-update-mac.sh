#!/bin/sh
# This helper runs after the app has verified the signed update and prepared a
# replacement on the same filesystem. It never requests administrator access.
set -eu
umask 077
[ "$#" -eq 6 ] || exit 1
parent_pid=$1
target=$2
staging=$3
old_version=$4
new_version=$5
result_file=$6
case "$parent_pid" in ''|*[!0-9]*) exit 1;; esac
case "$target" in '/Applications/CC Connect.app'|"$HOME/Applications/CC Connect.app") ;; *) exit 1;; esac
parent_dir=${target%/*}
case "$staging" in "$parent_dir"/.cc-connect-update-*) ;; *) exit 1;; esac
case "$old_version$new_version" in ''|*[!0-9A-Za-z.+-]*) exit 1;; esac
case "$result_file" in /*/updates/install-result.json) ;; *) exit 1;; esac
[ -d "$staging" ] && [ ! -L "$staging" ] || exit 1
[ -d "$target" ] && [ ! -L "$target" ] || exit 1
next_app="$staging/CC Connect.app"
backup="$staging/previous.app"
lock="$parent_dir/.cc-connect-install.lock"
result_dir=${result_file%/*}
exec >> "$result_dir/install.log" 2>&1

locked=0
moved_old=0
replaced=0
success=0
finish() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$success" -eq 0 ]; then
    printf '{"ok":false}\n' > "$result_file"
    if [ "$moved_old" -eq 1 ]; then
      if [ "$replaced" -eq 1 ] && [ -d "$target" ]; then
        /bin/mv "$target" "$staging/failed.app" || true
      fi
      if [ ! -e "$target" ] && [ -d "$backup" ]; then
        /bin/mv "$backup" "$target" || true
      fi
      if [ -d "$target" ]; then /usr/bin/open -n "$target" || true; fi
    fi
    printf 'Update failed; original application retained when rollback was possible.\n'
  else
    printf '{"ok":true}\n' > "$result_file"
    printf 'Update installed successfully.\n'
  fi
  if [ "$locked" -eq 1 ]; then
    /bin/rm -f "$lock/pid"
    /bin/rmdir "$lock" || true
  fi
  # Keep a surviving backup on disk if rollback could not restore it.
  if [ "$success" -eq 1 ] || [ ! -e "$backup" ]; then /bin/rm -rf "$staging"; fi
  exit "$status"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

if ! /bin/mkdir "$lock" 2>/dev/null; then
  lock_pid=$(/bin/cat "$lock/pid" 2>/dev/null || true)
  case "$lock_pid" in ''|*[!0-9]*) exit 1;; esac
  if kill -0 "$lock_pid" 2>/dev/null; then exit 1; fi
  /bin/rm "$lock/pid"
  /bin/rmdir "$lock"
  /bin/mkdir "$lock"
fi
locked=1
printf '%s\n' "$$" > "$lock/pid"

attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -le 60 ] || exit 1
  /bin/sleep 1
done

[ -d "$next_app" ] && [ ! -L "$next_app" ] && [ ! -e "$backup" ] || exit 1
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist")" = 'app.jianping.desktop' ] || exit 1
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$target/Contents/Info.plist")" = "$old_version" ] || exit 1
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$next_app/Contents/Info.plist")" = 'app.jianping.desktop' ] || exit 1
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$next_app/Contents/Info.plist")" = "$new_version" ] || exit 1
/usr/bin/codesign --verify --deep --strict "$next_app"

/bin/mv "$target" "$backup"
moved_old=1
/bin/mv "$next_app" "$target"
replaced=1
/usr/bin/open -n "$target"
success=1
