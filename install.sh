#!/bin/sh
set -eu

REPOSITORY="${CODEGRAPH_REPOSITORY:-lzehrung/codegraph}"
VERSION="${CODEGRAPH_VERSION:-latest}"
YES=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version) [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 2; }; VERSION=$2; shift 2 ;;
    --latest) VERSION=latest; shift ;;
    --yes) YES=1; shift ;;
    *) echo "Usage: install.sh [--latest | --version VERSION] [--yes]" >&2; exit 2 ;;
  esac
done

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Darwin-arm64) TARGET=darwin-arm64 ;;
  *) echo "Unsupported platform. Use the package or source installation path: https://github.com/$REPOSITORY/blob/main/docs/installation.md" >&2; exit 2 ;;
esac
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
INSTALL_BASE="$DATA_HOME/codegraph"
BIN_DIR="${CODEGRAPH_BIN_DIR:-$HOME/.local/bin}"
if [ "$YES" -ne 1 ]; then
  if [ ! -t 2 ] || [ ! -r /dev/tty ]; then
    echo "Noninteractive install requires --yes. Target: $TARGET. Install root: $INSTALL_BASE. Launcher: $BIN_DIR/codegraph." >&2
    exit 2
  fi
  printf 'Install Codegraph %s for %s under %s and write %s/codegraph? [y/N] ' "$VERSION" "$TARGET" "$INSTALL_BASE" "$BIN_DIR" > /dev/tty
  IFS= read -r ANSWER < /dev/tty || ANSWER=
  case "$ANSWER" in y|Y|yes|YES) ;; *) echo "Cancelled."; exit 0 ;; esac
fi

if [ -n "${CODEGRAPH_RELEASE_BASE_URL:-}" ]; then
  BASE_URL=${CODEGRAPH_RELEASE_BASE_URL%/}
elif [ "$VERSION" = latest ]; then
  BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
else
  case "$VERSION" in v*) TAG=$VERSION ;; *) TAG=v$VERSION ;; esac
  BASE_URL="https://github.com/$REPOSITORY/releases/download/$TAG"
fi
ARCHIVE="codegraph-$TARGET.tar.gz"
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/codegraph-install.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM

curl -fsSL "$BASE_URL/$ARCHIVE" -o "$TMP_ROOT/$ARCHIVE"
curl -fsSL "$BASE_URL/SHA256SUMS" -o "$TMP_ROOT/SHA256SUMS"
EXPECTED=$(awk -v name="$ARCHIVE" '$2 == name { print $1 }' "$TMP_ROOT/SHA256SUMS")
[ -n "$EXPECTED" ] || { echo "No checksum found for $ARCHIVE." >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP_ROOT/$ARCHIVE" | awk '{print $1}')
else
  ACTUAL=$(shasum -a 256 "$TMP_ROOT/$ARCHIVE" | awk '{print $1}')
fi
[ "$ACTUAL" = "$EXPECTED" ] || { echo "Checksum verification failed for $ARCHIVE." >&2; exit 1; }

tar -tf "$TMP_ROOT/$ARCHIVE" | awk '
  /^\// || /^[A-Za-z]:\// { exit 1 }
  { count=split($0, parts, "/"); for (i=1; i<=count; i++) if (parts[i] == "..") exit 1 }
' || { echo "Archive contains an unsafe path." >&2; exit 1; }
tar -tvf "$TMP_ROOT/$ARCHIVE" | awk 'substr($0,1,1) ~ /[lhbcp]/ { exit 1 }' || {
  echo "Archive contains an unsafe link or device." >&2; exit 1;
}
tar -xzf "$TMP_ROOT/$ARCHIVE" -C "$TMP_ROOT"
BUNDLE="$TMP_ROOT/codegraph-$TARGET"
[ -x "$BUNDLE/node" ] && [ -f "$BUNDLE/dist/cli.js" ] && [ -f "$BUNDLE/manifest.json" ] || {
  echo "Standalone archive is incomplete." >&2; exit 1;
}
INSTALLED_VERSION=$("$BUNDLE/node" "$BUNDLE/dist/cli.js" version)
case "$INSTALLED_VERSION" in
  ''|*[!0-9A-Za-z._-]*) echo "Bundled Codegraph returned an unsafe version: $INSTALLED_VERSION" >&2; exit 1 ;;
esac
"$BUNDLE/node" "$BUNDLE/dist/cli.js" doctor --json >/dev/null
VERSION_ROOT="$INSTALL_BASE/$INSTALLED_VERSION"

mkdir -p "$INSTALL_BASE" "$BIN_DIR"
if [ ! -e "$VERSION_ROOT" ]; then
  STAGING="$INSTALL_BASE/.installing-$INSTALLED_VERSION-$$"
  rm -rf "$STAGING"
  mv "$BUNDLE" "$STAGING"
  mv "$STAGING" "$VERSION_ROOT"
else
  [ -x "$VERSION_ROOT/node" ] && [ -f "$VERSION_ROOT/dist/cli.js" ] || {
    echo "Existing Codegraph $INSTALLED_VERSION installation is incomplete: $VERSION_ROOT" >&2; exit 1;
  }
  EXISTING_VERSION=$("$VERSION_ROOT/node" "$VERSION_ROOT/dist/cli.js" version)
  [ "$EXISTING_VERSION" = "$INSTALLED_VERSION" ] || {
    echo "Existing Codegraph installation failed version verification: $EXISTING_VERSION" >&2; exit 1;
  }
  "$VERSION_ROOT/node" "$VERSION_ROOT/dist/cli.js" doctor --json >/dev/null
fi
LAUNCHER_TMP="$BIN_DIR/.codegraph.tmp.$$"
cat > "$LAUNCHER_TMP" <<EOF
#!/bin/sh
# codegraph standalone installer
exec "$VERSION_ROOT/node" "$VERSION_ROOT/dist/cli.js" "\$@"
EOF
chmod 755 "$LAUNCHER_TMP"
INSTALL_MANIFEST="$INSTALL_BASE/install-manifest.json"
INSTALL_MANIFEST_TMP="$INSTALL_MANIFEST.tmp-$$"
PREVIOUS_VERSION=null
if [ -f "$INSTALL_MANIFEST" ]; then
  PREVIOUS_VERSION=$(CODEGRAPH_MANIFEST="$INSTALL_MANIFEST" "$VERSION_ROOT/node" --input-type=module -e 'import fs from "node:fs"; try { console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.env.CODEGRAPH_MANIFEST, "utf8")).currentVersion ?? null)); } catch { console.log("null"); }')
fi
CODEGRAPH_MANIFEST_OUTPUT="$INSTALL_MANIFEST_TMP" CODEGRAPH_VERSION="$INSTALLED_VERSION" CODEGRAPH_PREVIOUS="$PREVIOUS_VERSION" CODEGRAPH_TARGET="$TARGET" CODEGRAPH_ROOT="$VERSION_ROOT" CODEGRAPH_LAUNCHER="$BIN_DIR/codegraph" CODEGRAPH_URL="$BASE_URL/$ARCHIVE" CODEGRAPH_SHA256="$ACTUAL" "$VERSION_ROOT/node" --input-type=module -e '
import fs from "node:fs";
const output = process.env.CODEGRAPH_MANIFEST_OUTPUT;
fs.writeFileSync(output, `${JSON.stringify({
  schemaVersion: 1,
  channel: "standalone-preview",
  currentVersion: process.env.CODEGRAPH_VERSION,
  previousVersion: JSON.parse(process.env.CODEGRAPH_PREVIOUS),
  target: process.env.CODEGRAPH_TARGET,
  versionRoot: process.env.CODEGRAPH_ROOT,
  launchers: [process.env.CODEGRAPH_LAUNCHER],
  releaseUrl: process.env.CODEGRAPH_URL,
  archiveSha256: process.env.CODEGRAPH_SHA256,
  verification: "sha256-from-https-release",
  installedAt: new Date().toISOString()
}, null, 2)}\n`);
'
LAUNCHER_EXISTED=0
MANIFEST_EXISTED=0
if [ -f "$BIN_DIR/codegraph" ]; then cp -p "$BIN_DIR/codegraph" "$TMP_ROOT/launcher.backup"; LAUNCHER_EXISTED=1; fi
if [ -f "$INSTALL_MANIFEST" ]; then cp -p "$INSTALL_MANIFEST" "$TMP_ROOT/manifest.backup"; MANIFEST_EXISTED=1; fi
if ! { mv -f "$LAUNCHER_TMP" "$BIN_DIR/codegraph" && mv -f "$INSTALL_MANIFEST_TMP" "$INSTALL_MANIFEST"; }; then
  if [ "$LAUNCHER_EXISTED" -eq 1 ]; then cp -p "$TMP_ROOT/launcher.backup" "$BIN_DIR/codegraph"; else rm -f "$BIN_DIR/codegraph"; fi
  if [ "$MANIFEST_EXISTED" -eq 1 ]; then cp -p "$TMP_ROOT/manifest.backup" "$INSTALL_MANIFEST"; else rm -f "$INSTALL_MANIFEST"; fi
  echo "Unable to switch Codegraph installer state; previous launcher and manifest restored." >&2
  exit 1
fi
printf '%s\n' "Installed Codegraph $INSTALLED_VERSION to $VERSION_ROOT" "Verified SHA-256: $ACTUAL" "Launcher: $BIN_DIR/codegraph" "If that directory is not on PATH, add it explicitly." "Next: codegraph install"
