#!/bin/sh
# Downloads the latest GitHub release and installs it for Cursor.
# The repository is private, so GITHUB_TOKEN or GH_TOKEN must grant contents read.
set -eu

token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
if [ -z "$token" ]; then
  echo "GITHUB_TOKEN or GH_TOKEN is required to download the release." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

repo="srmlcn/qa-agent"
api="https://api.github.com/repos/${repo}"
workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

curl -fsSL \
  -H "Authorization: Bearer ${token}" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "${api}/releases/latest" \
  -o "${workdir}/release.json"

asset_id=$(node -e '
const fs = require("node:fs");
const release = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const assets = Array.isArray(release.assets) ? release.assets : [];
const asset = assets.find((item) => item && item.name === "autonomous-qa.tgz");
if (asset === undefined || typeof asset.id !== "number") {
  console.error("Latest release has no autonomous-qa.tgz asset.");
  process.exit(1);
}
process.stdout.write(String(asset.id));
' "${workdir}/release.json")

curl -fsSL \
  -H "Authorization: Bearer ${token}" \
  -H "Accept: application/octet-stream" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "${api}/releases/assets/${asset_id}" \
  -o "${workdir}/autonomous-qa.tgz"

tar -xzf "${workdir}/autonomous-qa.tgz" -C "$workdir"
node "${workdir}/dist/cli/main.js" install
