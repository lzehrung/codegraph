param(
  [string]$Version = $env:CODEGRAPH_VERSION,
  [switch]$Latest,
  [switch]$Yes
)
$ErrorActionPreference = "Stop"

function Assert-SafeDirectory {
  param(
    [string]$Path,
    [string]$Description
  )
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $Item) {
    [System.IO.Directory]::CreateDirectory($Path) | Out-Null
    $Item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  }
  $IsReparsePoint = ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  if (-not $Item.PSIsContainer -or $IsReparsePoint) {
    throw "Unsafe $Description directory: $Path"
  }
}

function Assert-RegularFileOrAbsent {
  param(
    [string]$Path,
    [string]$Description
  )
  $Item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -eq $Item) { return }
  $IsReparsePoint = ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
  if ($Item.PSIsContainer -or $IsReparsePoint) {
    throw "Unsafe $Description path: $Path"
  }
}

function ConvertTo-PowerShellSingleQuoted {
  param([string]$Value)
  if ($Value.IndexOf([char]0) -ge 0 -or $Value.IndexOf("`r") -ge 0 -or $Value.IndexOf("`n") -ge 0) {
    throw "Codegraph launcher path contains an unsupported character."
  }
  return "'" + $Value.Replace("'", "''") + "'"
}

function Get-CodegraphInstallLock {
  param([string]$Base)
  $LockPath = Join-Path $Base ".install.lock"
  $Owner = "$PID $([guid]::NewGuid().ToString("N"))"
  $Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $Stream = $null
    try {
      if (Test-Path -LiteralPath $LockPath) {
        $Existing = Get-Item -LiteralPath $LockPath -Force
        $IsReparsePoint = ($Existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        if ($Existing.PSIsContainer -or $IsReparsePoint) {
          throw "Unsafe Codegraph installer lock: $LockPath"
        }
      }
      $Stream = [System.IO.File]::Open(
        $LockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
      )
      try {
        $Bytes = [System.Text.Encoding]::UTF8.GetBytes($Owner)
        $Stream.SetLength(0)
        $Stream.Write($Bytes, 0, $Bytes.Length)
        $Stream.Flush($true)
        return [pscustomobject]@{
          Path = $LockPath
          Owner = $Owner
          Stream = $Stream
        }
      } catch {
        $Stream.Dispose()
        throw
      }
    } catch [System.IO.IOException] {
      if ($Stopwatch.Elapsed.TotalSeconds -ge 60) {
        throw "Timed out waiting for the Codegraph installer lock: $LockPath"
      }
      Start-Sleep -Milliseconds 200
    }
  }
}

function Release-CodegraphInstallLock {
  param($Lock)
  if ($null -eq $Lock) { return }
  try {
    $Lock.Stream.Dispose()
  } finally {
    try {
      if (Test-Path -LiteralPath $Lock.Path) {
        $Item = Get-Item -LiteralPath $Lock.Path -Force
        $IsReparsePoint = ($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0
        if (-not $Item.PSIsContainer -and -not $IsReparsePoint) {
          $StoredOwner = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($Lock.Path))
          if ($StoredOwner -eq $Lock.Owner) {
            Remove-Item -LiteralPath $Lock.Path -Force -ErrorAction SilentlyContinue
          }
        }
      }
    } catch {
    }
  }
}
$Repository = if ($env:CODEGRAPH_REPOSITORY) { $env:CODEGRAPH_REPOSITORY } else { "lzehrung/codegraph" }
if (-not $Version) { $Version = "latest" }
if ($Latest) { $Version = "latest" }
$RequestedVersion = ""
if ($Version -ne "latest") {
  $RequestedVersion = $Version
  if ($RequestedVersion.StartsWith("v")) { $RequestedVersion = $RequestedVersion.Substring(1) }
  if ($RequestedVersion -notmatch "^[0-9A-Za-z][0-9A-Za-z._-]*$") {
    throw "Requested version is unsafe: $RequestedVersion"
  }
}

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($Architecture -eq "x64") { $Target = "win32-x64" }
elseif ($Architecture -eq "arm64") { $Target = "win32-arm64" }
else {
  throw "Unsupported Windows architecture '$Architecture'. Use the package or source installation path: https://github.com/$Repository/blob/main/docs/installation.md"
}
$LocalAppData = [Environment]::GetFolderPath("LocalApplicationData")
$InstallBase = if ($env:CODEGRAPH_INSTALL_BASE) { $env:CODEGRAPH_INSTALL_BASE } else { Join-Path $LocalAppData "Programs/codegraph" }
$BinDir = if ($env:CODEGRAPH_BIN_DIR) { $env:CODEGRAPH_BIN_DIR } else { Join-Path $LocalAppData "Programs/codegraph/bin" }
if (-not $Yes) {
  try {
    $Answer = Read-Host "Install Codegraph $Version for $Target under $InstallBase and write $BinDir/codegraph.cmd? [y/N]"
  } catch {
    throw "Noninteractive install requires -Yes. Target: $Target. Install root: $InstallBase. Launcher: $BinDir/codegraph.cmd."
  }
  if ($Answer -notin @("y", "Y", "yes", "YES")) {
    Write-Output "Cancelled."
    return
  }
}
$BaseUrl = if ($env:CODEGRAPH_RELEASE_BASE_URL) {
  $env:CODEGRAPH_RELEASE_BASE_URL.TrimEnd("/")
} elseif ($Version -eq "latest") {
  "https://github.com/$Repository/releases/latest/download"
} else {
  $Tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
  "https://github.com/$Repository/releases/download/$Tag"
}
$Archive = "codegraph-$Target.zip"
$TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("codegraph-install-" + [guid]::NewGuid().ToString("N"))
$Staging = $null
$LauncherTemp = $null
$InstallManifestTemp = $null
$InstallLock = $null
New-Item -ItemType Directory -Path $TempRoot | Out-Null
try {
  $ArchivePath = Join-Path $TempRoot $Archive
  $ChecksumsPath = Join-Path $TempRoot "SHA256SUMS"
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/$Archive" -OutFile $ArchivePath
  Invoke-WebRequest -UseBasicParsing "$BaseUrl/SHA256SUMS" -OutFile $ChecksumsPath
  $ChecksumLine = Get-Content $ChecksumsPath | Where-Object { $_ -match "\s+$([regex]::Escape($Archive))$" } | Select-Object -First 1
  if (-not $ChecksumLine) { throw "No checksum found for $Archive." }
  $Expected = ($ChecksumLine -split "\s+")[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 $ArchivePath).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) { throw "Checksum verification failed for $Archive." }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($Entry in $Zip.Entries) {
      $Name = $Entry.FullName.Replace("\", "/")
      if ([string]::IsNullOrWhiteSpace($Name) -or $Name.StartsWith("/") -or $Name -match "^[A-Za-z]:/" -or ($Name.Split("/") -contains "..")) {
        throw "Archive contains an unsafe path: $Name"
      }
      $UnixType = ($Entry.ExternalAttributes -shr 16) -band 0xF000
      if ($UnixType -eq 0xA000 -or $UnixType -eq 0x6000 -or $UnixType -eq 0x2000 -or $UnixType -eq 0x1000) {
        throw "Archive contains an unsafe link or device: $Name"
      }
    }
  } finally {
    $Zip.Dispose()
  }
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $TempRoot)
  $Bundle = Join-Path $TempRoot "codegraph-$Target"
  $Node = Join-Path $Bundle "node.exe"
  $Cli = Join-Path $Bundle "dist/cli.js"
  $Manifest = Join-Path $Bundle "manifest.json"
  if (-not (Test-Path $Node -PathType Leaf) -or -not (Test-Path $Cli -PathType Leaf) -or -not (Test-Path $Manifest -PathType Leaf)) {
    throw "Standalone archive is incomplete."
  }
  $BundleVerification = @'
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [incomingRoot, installedRoot, expectedTarget, requestedVersionArgument, cliVersionArgument] = process.argv.slice(2);
let requestedVersion = requestedVersionArgument;
let cliVersion = cliVersionArgument;
if (requestedVersion === "-") requestedVersion = "";
if (cliVersion === "-") cliVersion = "";
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
if (installedRoot !== "-") {
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
'@

  function Invoke-StandaloneBundleVerification {
    param(
      [string]$IncomingRoot,
      [string]$ExistingRoot,
      [string]$CliVersion
    )
    $RequestedVersionArgument = "-"
    if ($RequestedVersion) { $RequestedVersionArgument = $RequestedVersion }
    $CliVersionArgument = "-"
    if ($CliVersion) { $CliVersionArgument = $CliVersion }
    $BundleVerification | & (Join-Path $IncomingRoot "node.exe") '--input-type=module' '-' $IncomingRoot $ExistingRoot $Target $RequestedVersionArgument $CliVersionArgument
    if ($LASTEXITCODE -ne 0) { throw "Standalone bundle verification failed." }
  }

  $DoctorVerification = @'
import fs from "node:fs";
import path from "node:path";

const [manifestPath, doctorBase64] = process.argv.slice(2);
function fail(message) {
  throw new Error(`Bundled Codegraph doctor verification failed: ${message}`);
}
let manifest;
let doctor;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  doctor = JSON.parse(Buffer.from(doctorBase64, "base64").toString("utf8"));
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
'@

  function Invoke-StandaloneDoctorVerification {
    param([string]$DoctorJson)
    $DoctorBase64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($DoctorJson))
    $DoctorVerification | & $Node '--input-type=module' '-' $Manifest $DoctorBase64
    if ($LASTEXITCODE -ne 0) { throw "Bundled Codegraph doctor verification failed." }
  }

  Invoke-StandaloneBundleVerification $Bundle "-" ""
  $VersionOutput = & $Node $Cli version
  if ($LASTEXITCODE -ne 0) { throw "Bundled codegraph version failed." }
  if ($VersionOutput -is [array]) { throw "Bundled Codegraph returned multiple version lines." }
  $InstalledVersion = [string]$VersionOutput
  if ($InstalledVersion -ne $InstalledVersion.Trim() -or $InstalledVersion -notmatch "^[0-9A-Za-z][0-9A-Za-z._-]*$") {
    throw "Bundled Codegraph returned an unsafe version: $InstalledVersion"
  }
  Invoke-StandaloneBundleVerification $Bundle "-" $InstalledVersion
  $DoctorJsonLines = & $Node $Cli doctor --json
  if ($LASTEXITCODE -ne 0) { throw "Bundled codegraph doctor failed." }
  Invoke-StandaloneDoctorVerification ($DoctorJsonLines -join "`n")

  $VersionRoot = Join-Path $InstallBase $InstalledVersion
  Assert-SafeDirectory $InstallBase "install base"
  $InstallLock = Get-CodegraphInstallLock $InstallBase
  try {
    Assert-SafeDirectory $BinDir "launcher"
    if (Test-Path -LiteralPath $VersionRoot) {
      Invoke-StandaloneBundleVerification $Bundle $VersionRoot $InstalledVersion
    } else {
      $Staging = Join-Path $InstallBase (".installing-$InstalledVersion-" + [guid]::NewGuid().ToString("N"))
      if (Test-Path -LiteralPath $Staging) { throw "Unsafe existing Codegraph staging path: $Staging" }
      Move-Item -LiteralPath $Bundle -Destination $Staging -ErrorAction Stop
      try {
        [System.IO.Directory]::Move($Staging, $VersionRoot)
        $Staging = $null
      } catch {
        if (Test-Path -LiteralPath $VersionRoot) {
          Invoke-StandaloneBundleVerification $Staging $VersionRoot $InstalledVersion
          Remove-Item -LiteralPath $Staging -Recurse -Force
          $Staging = $null
        } else {
          throw
        }
      }
    }

    $Launcher = Join-Path $BinDir "codegraph.cmd"
    $LauncherScript = Join-Path $BinDir "codegraph-launcher.ps1"
    $LauncherTemp = "$Launcher.tmp-$PID-$([guid]::NewGuid().ToString("N"))"
    $LauncherScriptTemp = "$LauncherScript.tmp-$PID-$([guid]::NewGuid().ToString("N"))"
    $InstalledNode = Join-Path $VersionRoot "node.exe"
    $InstalledCli = Join-Path $VersionRoot "dist/cli.js"
    $PsNode = ConvertTo-PowerShellSingleQuoted $InstalledNode
    $PsCli = ConvertTo-PowerShellSingleQuoted $InstalledCli
    $LauncherContent = @'
@echo off
rem codegraph standalone installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codegraph-launcher.ps1" %*
'@
    $LauncherScriptContent = "# codegraph standalone installer`r`n`$ErrorActionPreference = `"Stop`"`r`n& $PsNode $PsCli @args`r`nexit `$LASTEXITCODE`r`n"
    [System.IO.File]::WriteAllText($LauncherTemp, $LauncherContent, [System.Text.Encoding]::ASCII)
    [System.IO.File]::WriteAllText($LauncherScriptTemp, $LauncherScriptContent, [System.Text.UTF8Encoding]::new($true))

    $InstallManifestPath = Join-Path $InstallBase "install-manifest.json"
    $InstallManifestTemp = "$InstallManifestPath.tmp-$PID-$([guid]::NewGuid().ToString("N"))"
    Assert-RegularFileOrAbsent $Launcher "existing launcher"
    Assert-RegularFileOrAbsent $LauncherScript "existing launcher script"
    Assert-RegularFileOrAbsent $InstallManifestPath "existing install manifest"
    $PreviousVersion = $null
    if (Test-Path -LiteralPath $InstallManifestPath -PathType Leaf) {
      try { $PreviousVersion = (Get-Content -LiteralPath $InstallManifestPath -Raw | ConvertFrom-Json).currentVersion } catch { $PreviousVersion = $null }
    }
    $InstallManifest = [ordered]@{
      schemaVersion = 1
      channel = "standalone-preview"
      currentVersion = $InstalledVersion
      previousVersion = $PreviousVersion
      target = $Target
      versionRoot = $VersionRoot
      launchers = @($Launcher, $LauncherScript)
      releaseUrl = "$BaseUrl/$Archive"
      archiveSha256 = $Actual
      verification = "sha256-from-https-release"
      installedAt = [DateTime]::UtcNow.ToString("o")
    }
    $InstallManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $InstallManifestTemp -Encoding UTF8
    $LauncherExisted = Test-Path -LiteralPath $Launcher -PathType Leaf
    $LauncherScriptExisted = Test-Path -LiteralPath $LauncherScript -PathType Leaf
    $ManifestExisted = Test-Path -LiteralPath $InstallManifestPath -PathType Leaf
    $LauncherBackup = Join-Path $TempRoot "launcher.backup"
    $LauncherScriptBackup = Join-Path $TempRoot "launcher-script.backup"
    $ManifestBackup = Join-Path $TempRoot "manifest.backup"
    if ($LauncherExisted) { Copy-Item -LiteralPath $Launcher -Destination $LauncherBackup }
    if ($LauncherScriptExisted) { Copy-Item -LiteralPath $LauncherScript -Destination $LauncherScriptBackup }
    if ($ManifestExisted) { Copy-Item -LiteralPath $InstallManifestPath -Destination $ManifestBackup }
    try {
      Move-Item -LiteralPath $LauncherScriptTemp -Destination $LauncherScript -Force
      Move-Item -LiteralPath $LauncherTemp -Destination $Launcher -Force
      Move-Item -LiteralPath $InstallManifestTemp -Destination $InstallManifestPath -Force
    } catch {
      if ($LauncherExisted) { Copy-Item -LiteralPath $LauncherBackup -Destination $Launcher -Force } else { Remove-Item -LiteralPath $Launcher -Force -ErrorAction SilentlyContinue }
      if ($LauncherScriptExisted) { Copy-Item -LiteralPath $LauncherScriptBackup -Destination $LauncherScript -Force } else { Remove-Item -LiteralPath $LauncherScript -Force -ErrorAction SilentlyContinue }
      if ($ManifestExisted) { Copy-Item -LiteralPath $ManifestBackup -Destination $InstallManifestPath -Force } else { Remove-Item -LiteralPath $InstallManifestPath -Force -ErrorAction SilentlyContinue }
      throw
    }
  } finally {
    Release-CodegraphInstallLock $InstallLock
    $InstallLock = $null
  }
  Write-Output "Installed Codegraph $InstalledVersion to $VersionRoot"
  Write-Output "Verified SHA-256: $Actual"
  Write-Output "Launcher: $Launcher"
  Write-Output "If that directory is not on PATH, add it explicitly."
  Write-Output "Next: codegraph install"
} finally {
  if ($InstallLock) {
    Release-CodegraphInstallLock $InstallLock
    $InstallLock = $null
  }
  if ($LauncherTemp -and (Test-Path -LiteralPath $LauncherTemp)) {
    Remove-Item -LiteralPath $LauncherTemp -Force -ErrorAction SilentlyContinue
  }
  if ($LauncherScriptTemp -and (Test-Path -LiteralPath $LauncherScriptTemp)) {
    Remove-Item -LiteralPath $LauncherScriptTemp -Force -ErrorAction SilentlyContinue
  }
  if ($InstallManifestTemp -and (Test-Path -LiteralPath $InstallManifestTemp)) {
    Remove-Item -LiteralPath $InstallManifestTemp -Force -ErrorAction SilentlyContinue
  }
  if ($Staging -and (Test-Path -LiteralPath $Staging)) {
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $Staging
  }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $TempRoot
}
