#!/bin/sh
# Downloads the latest GitHub release and installs it for Cursor.
# Default location is ~/.autonomous-qa. A terminal can choose another absolute path.
set -eu

default_home="${HOME}/.autonomous-qa"
asset_url="https://github.com/srmlcn/qa-agent/releases/latest/download/autonomous-qa.tgz"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

expand_path() {
  case "$1" in
    "~") printf '%s\n' "$HOME" ;;
    "~/"*) printf '%s\n' "${HOME}/${1#"~/"}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

require_absolute() {
  case "$1" in
    /*) return 0 ;;
    *)
      echo "Installation path must be absolute." >&2
      exit 1
      ;;
  esac
}

# test -r /dev/tty can succeed when opening it fails.
tty_available() {
  (: >/dev/tty) 2>/dev/null
}

# A positional path skips the question. Without a terminal, use the default.
choose_install_home() {
  if [ "${1:-}" != "" ]; then
    expand_path "$1"
    return
  fi
  if ! tty_available; then
    printf '%s\n' "$default_home"
    return
  fi

  while true; do
    printf 'Install autonomous-qa into %s? [Y/n] ' "$default_home" >/dev/tty
    read -r answer </dev/tty || exit 1
    case "$answer" in
      ""|y|Y|yes|YES)
        printf '%s\n' "$default_home"
        return
        ;;
      n|N|no|NO)
        printf 'Installation path: ' >/dev/tty
        read -r custom </dev/tty || exit 1
        if [ -z "$custom" ]; then
          echo "Installation path is required." >&2
          exit 1
        fi
        expand_path "$custom"
        return
        ;;
      *)
        echo "Answer y or n." >/dev/tty
        ;;
    esac
  done
}

install_home=$(choose_install_home "${1:-}")
require_absolute "$install_home"
export AUTONOMOUS_QA_HOME="$install_home"
echo "Installing into ${install_home}" >&2

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

curl -fsSL -o "${workdir}/autonomous-qa.tgz" "$asset_url"
tar -xzf "${workdir}/autonomous-qa.tgz" -C "$workdir"
(
  cd "$workdir"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)
node "${workdir}/dist/cli/main.js" install
