#!/bin/sh
set -eu

REPOSITORY="${CODEGRAPH_REPOSITORY:-lzehrung/codegraph}"
VERSION="${CODEGRAPH_VERSION:-latest}"
REQUESTED_VERSION=
if [ -n "${CODEGRAPH_VERSION:-}" ] && [ "$CODEGRAPH_VERSION" != latest ]; then
  REQUESTED_VERSION=$CODEGRAPH_VERSION
fi
YES=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || { echo "--version requires a value" >&2; exit 2; }
      VERSION=$2
      if [ "$VERSION" = latest ]; then REQUESTED_VERSION=; else REQUESTED_VERSION=$VERSION; fi
      shift 2
      ;;
    --latest) VERSION=latest; REQUESTED_VERSION=; shift ;;
    --yes) YES=1; shift ;;
    *) echo "Usage: install.sh [--latest | --version VERSION] [--yes]" >&2; exit 2 ;;
  esac
done
if [ -n "$REQUESTED_VERSION" ]; then
  case "$REQUESTED_VERSION" in v*) REQUESTED_VERSION=${REQUESTED_VERSION#v} ;; esac
  case "$REQUESTED_VERSION" in
    ''|*[!0-9A-Za-z._-]*)
      echo "Requested version is unsafe: $REQUESTED_VERSION" >&2
      exit 2
      ;;
  esac
fi

SYSTEM=$(uname -s)
MACHINE=$(uname -m)
case "$SYSTEM-$MACHINE" in
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Darwin-arm64) TARGET=darwin-arm64 ;;
  *) echo "Unsupported platform. Use the package or source installation path: https://github.com/$REPOSITORY/blob/main/docs/installation.md" >&2; exit 2 ;;
esac
if [ "$SYSTEM" = Linux ]; then
  LDD_VERSION=$(ldd --version 2>&1 || true)
  case "$LDD_VERSION" in
    *musl*|*MUSL*)
      echo "Standalone Linux bundles require glibc and do not support musl. Use the package or source installation path: https://github.com/$REPOSITORY/blob/main/docs/installation.md" >&2
      exit 2
      ;;
  esac
  for MUSL_LOADER in /lib/ld-musl-*.so.1 /usr/lib/ld-musl-*.so.1; do
    if [ -e "$MUSL_LOADER" ]; then
      echo "Standalone Linux bundles require glibc and do not support musl. Use the package or source installation path: https://github.com/$REPOSITORY/blob/main/docs/installation.md" >&2
      exit 2
    fi
  done
fi
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
LOCK_DIR=
LOCK_OWNER=
STAGING=
LAUNCHER_TMP=
INSTALL_MANIFEST_TMP=

release_install_lock() {
  if [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ] && [ -f "$LOCK_DIR/owner" ] && [ ! -L "$LOCK_DIR/owner" ]; then
    LOCK_CONTENT=$(cat "$LOCK_DIR/owner" 2>/dev/null || true)
    if [ "$LOCK_CONTENT" = "$LOCK_OWNER" ]; then rm -rf "$LOCK_DIR"; fi
  fi
}

cleanup() {
  if [ -n "$STAGING" ] && { [ -e "$STAGING" ] || [ -L "$STAGING" ]; }; then rm -rf "$STAGING"; fi
  if [ -n "$LAUNCHER_TMP" ]; then rm -f "$LAUNCHER_TMP"; fi
  if [ -n "$INSTALL_MANIFEST_TMP" ]; then rm -f "$INSTALL_MANIFEST_TMP"; fi
  release_install_lock
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT HUP INT TERM

assert_safe_directory() {
  if [ -L "$1" ] || [ ! -d "$1" ]; then
    echo "Unsafe $2 directory: $1" >&2
    exit 1
  fi
}

assert_regular_file_or_absent() {
  if [ -L "$1" ] || { [ -e "$1" ] && [ ! -f "$1" ]; }; then
    echo "Unsafe $2 path: $1" >&2
    exit 1
  fi
}

lock_owner_is_live() {
  [ -f "$LOCK_DIR/owner" ] && [ ! -L "$LOCK_DIR/owner" ] || return 1
  IFS=' ' read -r LOCK_PID LOCK_STARTED LOCK_ID < "$LOCK_DIR/owner" || return 1
  case "$LOCK_PID" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$LOCK_PID" 2>/dev/null
}

reclaim_stale_install_lock() {
  STALE_LOCK="$INSTALL_BASE/.install.lock.stale-$LOCK_TOKEN"
  if mv "$LOCK_DIR" "$STALE_LOCK" 2>/dev/null; then rm -rf "$STALE_LOCK"; fi
}

acquire_install_lock() {
  LOCK_WAIT_SECONDS=${CODEGRAPH_INSTALL_LOCK_WAIT_SECONDS:-60}
  LOCK_STALE_SECONDS=${CODEGRAPH_INSTALL_LOCK_STALE_SECONDS:-10}
  case "$LOCK_WAIT_SECONDS" in ''|0|*[!0-9]*) LOCK_WAIT_SECONDS=60 ;; esac
  case "$LOCK_STALE_SECONDS" in ''|0|*[!0-9]*) LOCK_STALE_SECONDS=10 ;; esac
  LOCK_STARTED=$(date +%s)
  LOCK_TOKEN="$$.$LOCK_STARTED"
  LOCK_OWNER="$$ $LOCK_STARTED $LOCK_TOKEN"
  LOCK_DIR="$INSTALL_BASE/.install.lock"
  LOCK_ATTEMPTS=0
  while :; do
    if mkdir "$LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "$LOCK_OWNER" > "$LOCK_DIR/owner"; then return; fi
      rm -rf "$LOCK_DIR"
      echo "Unable to initialize Codegraph installer lock." >&2
      exit 1
    fi
    if [ -L "$LOCK_DIR" ] || { [ -e "$LOCK_DIR" ] && [ ! -d "$LOCK_DIR" ]; }; then
      echo "Unsafe Codegraph installer lock: $LOCK_DIR" >&2
      exit 1
    fi
    if [ ! -e "$LOCK_DIR" ] && [ ! -L "$LOCK_DIR" ]; then
      echo "Unable to create Codegraph installer lock: $LOCK_DIR" >&2
      exit 1
    fi
    if [ "$LOCK_ATTEMPTS" -ge "$LOCK_STALE_SECONDS" ] && ! lock_owner_is_live; then
      reclaim_stale_install_lock
      continue
    fi
    if [ "$LOCK_ATTEMPTS" -ge "$LOCK_WAIT_SECONDS" ]; then
      echo "Timed out waiting for the Codegraph installer lock: $LOCK_DIR" >&2
      exit 1
    fi
    sleep 1
    LOCK_ATTEMPTS=$((LOCK_ATTEMPTS + 1))
  done
}

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
verify_standalone_bundle() {
  INCOMING_ROOT=$1
  CLI_VERSION=$2
  EXISTING_ROOT=$3
  CODEGRAPH_EXPECTED_TARGET="$TARGET" CODEGRAPH_REQUESTED_VERSION="$REQUESTED_VERSION" CODEGRAPH_CLI_VERSION="$CLI_VERSION" "$INCOMING_ROOT/node" --input-type=module - "$INCOMING_ROOT" "$EXISTING_ROOT" <<'NODE'
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [incomingRoot, installedRoot] = process.argv.slice(2);
const expectedTarget = process.env.CODEGRAPH_EXPECTED_TARGET;
const requestedVersion = process.env.CODEGRAPH_REQUESTED_VERSION;
const cliVersion = process.env.CODEGRAPH_CLI_VERSION;
const nativeSuffixes = {
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc"
};

function fail(message) {
  throw new Error(`Standalone bundle verification failed: ${message}`);
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function collectFiles(root) {
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail(`unsafe root: ${root}`);
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) fail(`unsafe symlink: ${relative}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else fail(`unsafe file type: ${relative}`);
    }
  }
  visit(root);
  return files.sort();
}

function readManifest(root) {
  const manifestPath = path.join(root, "manifest.json");
  let manifest;
  try {
    if (!fs.lstatSync(manifestPath).isFile()) fail(`invalid manifest: ${root}`);
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail(`invalid manifest: ${root}`);
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    manifest.channel !== "standalone-preview" ||
    typeof manifest.version !== "string" ||
    !/^[0-9A-Za-z][0-9A-Za-z._-]*$/u.test(manifest.version) ||
    typeof manifest.target !== "string" ||
    !manifest.target ||
    typeof manifest.nativeSuffix !== "string" ||
    !/^[0-9A-Za-z._-]+$/u.test(manifest.nativeSuffix) ||
    typeof manifest.nodeVersion !== "string" ||
    !manifest.nodeVersion ||
    (manifest.sourceRevision !== null && typeof manifest.sourceRevision !== "string") ||
    !Array.isArray(manifest.files)
  ) {
    fail(`invalid manifest: ${root}`);
  }
  const expected = new Map();
  for (const entry of manifest.files) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      fail(`invalid file record: ${root}`);
    }
    const normalized = entry.path.replaceAll("\\", "/");
    if (
      normalized !== entry.path ||
      !normalized ||
      normalized.includes("\0") ||
      normalized.startsWith("/") ||
      /^[A-Za-z]:\//u.test(normalized) ||
      normalized.split("/").includes("..") ||
      expected.has(entry.path)
    ) {
      fail(`invalid manifest path: ${entry.path}`);
    }
    expected.set(entry.path, entry);
  }
  for (const relative of collectFiles(root)) {
    if (relative === "manifest.json") continue;
    const entry = expected.get(relative);
    if (!entry) fail(`unmanifested file: ${relative}`);
    const absolute = path.resolve(root, relative);
    const rootRelative = path.relative(root, absolute);
    if (!rootRelative || rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
      fail(`unsafe file path: ${relative}`);
    }
    const stat = fs.statSync(absolute);
    if (stat.size !== entry.size || sha256File(absolute) !== entry.sha256) {
      fail(`file mismatch: ${relative}`);
    }
    expected.delete(relative);
  }
  if (expected.size) fail(`missing file: ${expected.keys().next().value}`);
  return manifest;
}

function verifyIncomingIdentity(manifest) {
  const expectedNativeSuffix = nativeSuffixes[expectedTarget];
  if (!expectedNativeSuffix) fail(`unsupported selected target: ${expectedTarget}`);
  if (manifest.target !== expectedTarget) fail(`manifest target ${manifest.target} does not match selected target ${expectedTarget}`);
  if (manifest.nativeSuffix !== expectedNativeSuffix) {
    fail(`manifest native suffix ${manifest.nativeSuffix} does not match selected target ${expectedTarget}`);
  }
  if (requestedVersion && manifest.version !== requestedVersion) {
    fail(`manifest version ${manifest.version} does not match requested version ${requestedVersion}`);
  }
  if (cliVersion && manifest.version !== cliVersion) {
    fail(`manifest version ${manifest.version} does not match bundled CLI version ${cliVersion}`);
  }
}

const incoming = readManifest(incomingRoot);
verifyIncomingIdentity(incoming);
if (installedRoot) {
  const installed = readManifest(installedRoot);
  for (const field of ["version", "target", "nativeSuffix", "sourceRevision", "nodeVersion"]) {
    if (incoming[field] !== installed[field]) fail(`existing standalone installation provenance mismatch: ${field}`);
  }
  if (incoming.files.length !== installed.files.length) fail("existing standalone installation provenance mismatch: files");
  const installedFiles = new Map(installed.files.map((entry) => [entry.path, entry]));
  for (const incomingFile of incoming.files) {
    const installedFile = installedFiles.get(incomingFile.path);
    if (
      !installedFile ||
      incomingFile.size !== installedFile.size ||
      incomingFile.sha256 !== installedFile.sha256
    ) {
      fail(`existing standalone installation provenance mismatch: ${incomingFile.path}`);
    }
  }
}
NODE
}

verify_native_doctor() {
  "$BUNDLE/node" --input-type=module - "$BUNDLE/manifest.json" "$TMP_ROOT/doctor.json" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [manifestPath, doctorPath] = process.argv.slice(2);
function fail(message) {
  throw new Error(`Bundled Codegraph doctor verification failed: ${message}`);
}
let manifest;
let doctor;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  doctor = JSON.parse(fs.readFileSync(doctorPath, "utf8"));
} catch {
  fail("invalid JSON output");
}
let nativePackage;
try {
  const nativePackageName = `@lzehrung/codegraph-native-${manifest.nativeSuffix}`;
  const nativePackagePath = path.join(
    path.dirname(manifestPath),
    "node_modules",
    ...nativePackageName.split("/")
  );
  nativePackage = JSON.parse(fs.readFileSync(path.join(nativePackagePath, "package.json"), "utf8"));
} catch {
  fail("target native package metadata is unreadable");
}
const native = doctor && typeof doctor === "object" && !Array.isArray(doctor) ? doctor.native : null;
if (!native || typeof native !== "object" || Array.isArray(native) || typeof native.available !== "boolean" || !native.available) {
  fail("native runtime is unavailable");
}
const origin = native.origin;
if (!origin || typeof origin !== "object" || Array.isArray(origin)) fail("native runtime origin is missing");
if (origin.target !== manifest.nativeSuffix) {
  fail(`native origin target ${String(origin.target)} does not match ${manifest.nativeSuffix}`);
}
const expectedPackageName = `@lzehrung/codegraph-native-${manifest.nativeSuffix}`;
if (nativePackage.name !== expectedPackageName || typeof nativePackage.version !== "string") {
  fail("target native package metadata does not match the bundle manifest");
}
if (origin.packageName !== nativePackage.name || origin.packageVersion !== nativePackage.version) {
  fail(`native origin package ${String(origin.packageName)}@${String(origin.packageVersion)} does not match installed target metadata`);
}
NODE
}

verify_standalone_bundle "$BUNDLE" "" ""
INSTALLED_VERSION=$("$BUNDLE/node" "$BUNDLE/dist/cli.js" version)
case "$INSTALLED_VERSION" in
  ''|*[!0-9A-Za-z._-]*) echo "Bundled Codegraph returned an unsafe version: $INSTALLED_VERSION" >&2; exit 1 ;;
esac
verify_standalone_bundle "$BUNDLE" "$INSTALLED_VERSION" ""
"$BUNDLE/node" "$BUNDLE/dist/cli.js" doctor --json > "$TMP_ROOT/doctor.json"
verify_native_doctor
VERSION_ROOT="$INSTALL_BASE/$INSTALLED_VERSION"
mkdir -p "$INSTALL_BASE"
assert_safe_directory "$INSTALL_BASE" "install base"
acquire_install_lock
mkdir -p "$BIN_DIR"
assert_safe_directory "$BIN_DIR" "launcher"
if [ -e "$VERSION_ROOT" ] || [ -L "$VERSION_ROOT" ]; then
  verify_standalone_bundle "$BUNDLE" "$INSTALLED_VERSION" "$VERSION_ROOT"
else
  STAGING="$INSTALL_BASE/.installing-$INSTALLED_VERSION-$LOCK_TOKEN"
  if [ -e "$STAGING" ] || [ -L "$STAGING" ]; then
    echo "Unsafe existing Codegraph staging path: $STAGING" >&2
    exit 1
  fi
  if ! mv "$BUNDLE" "$STAGING"; then
    echo "Unable to stage Codegraph $INSTALLED_VERSION." >&2
    exit 1
  fi
  if "$STAGING/node" --input-type=module -e 'import fs from "node:fs"; const [source, destination] = process.argv.slice(1); fs.renameSync(source, destination);' "$STAGING" "$VERSION_ROOT"; then
    STAGING=
  elif [ -e "$VERSION_ROOT" ] || [ -L "$VERSION_ROOT" ]; then
    verify_standalone_bundle "$STAGING" "$INSTALLED_VERSION" "$VERSION_ROOT"
    rm -rf "$STAGING"
    STAGING=
  else
    echo "Unable to publish Codegraph $INSTALLED_VERSION." >&2
    exit 1
  fi
fi
shell_single_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\"'\"'/g"
  printf "'"
}

LAUNCHER_TMP="$BIN_DIR/.codegraph.tmp.$$"
NODE_EXECUTABLE=$(shell_single_quote "$VERSION_ROOT/node")
CLI_SCRIPT=$(shell_single_quote "$VERSION_ROOT/dist/cli.js")
{
  printf '%s\n' '#!/bin/sh' '# codegraph standalone installer'
  printf 'exec %s %s "$@"\n' "$NODE_EXECUTABLE" "$CLI_SCRIPT"
} > "$LAUNCHER_TMP"
chmod 755 "$LAUNCHER_TMP"
INSTALL_MANIFEST="$INSTALL_BASE/install-manifest.json"
INSTALL_MANIFEST_TMP="$INSTALL_MANIFEST.tmp-$$"
assert_regular_file_or_absent "$BIN_DIR/codegraph" "existing launcher"
assert_regular_file_or_absent "$INSTALL_MANIFEST" "existing install manifest"
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
