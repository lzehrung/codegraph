#!/usr/bin/env pwsh
# Exercises the install.ps1 directory-move retry helpers without running the installer.
# The helpers are lifted out of install.ps1 by name, so this fails loudly if either is renamed.
param([string]$InstallScript)

$ErrorActionPreference = "Stop"

if (-not $InstallScript) {
  $RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  $InstallScript = Join-Path $RepoRoot "install.ps1"
}

$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($InstallScript, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors) { throw "install.ps1 does not parse: $($ParseErrors[0])" }

$Definitions = $Ast.FindAll({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($Name in @("Move-CodegraphDirectory", "Test-CodegraphRetryableMoveError")) {
  $Definition = $Definitions | Where-Object { $_.Name -eq $Name }
  if (-not $Definition) { throw "install.ps1 no longer defines $Name" }
  . ([scriptblock]::Create($Definition.Extent.Text))
}

$script:MoveAttempts = 0
$script:MoveFailures = 0
$script:MoveError = $null

# Shadows the real cmdlet so a move can refuse a chosen number of times before it succeeds.
function Move-Item {
  param(
    [string]$LiteralPath,
    [string]$Destination,
    [string]$ErrorAction
  )
  $script:MoveAttempts += 1
  if ($script:MoveAttempts -le $script:MoveFailures) { throw $script:MoveError }
}

function Reset-MoveStub {
  param(
    [int]$Failures,
    $Error
  )
  $script:MoveAttempts = 0
  $script:MoveFailures = $Failures
  $script:MoveError = $Error
}

function Assert-Equal {
  param(
    $Expected,
    $Actual,
    [string]$Label
  )
  if ($Expected -ne $Actual) { throw "$Label`: expected $Expected, got $Actual" }
}

$Root = Join-Path ([System.IO.Path]::GetTempPath()) ("codegraph-move-retry-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $Root | Out-Null
$Locked = [System.IO.IOException]::new("staged tree is locked")
$Unexpected = [System.ArgumentException]::new("the move was asked for something impossible")

try {
  foreach ($Case in @(
      @{ Label = "an open handle"; Exception = $Locked; Expected = $true },
      @{ Label = "a denied directory"; Exception = [System.UnauthorizedAccessException]::new("denied"); Expected = $true },
      @{ Label = "a missing file"; Exception = [System.IO.FileNotFoundException]::new("gone"); Expected = $false },
      @{ Label = "a missing directory"; Exception = [System.IO.DirectoryNotFoundException]::new("gone"); Expected = $false },
      @{ Label = "an unexpected argument"; Exception = $Unexpected; Expected = $false },
      @{ Label = "a wrapped open handle"; Exception = [System.Exception]::new("outer", $Locked); Expected = $true }
    )) {
    Assert-Equal $Case.Expected (Test-CodegraphRetryableMoveError $Case.Exception) "classifying $($Case.Label)"
  }

  # A tree held open briefly is the failure this retry exists for.
  Reset-MoveStub -Failures 5 -Error $Locked
  $Watch = [System.Diagnostics.Stopwatch]::StartNew()
  Move-CodegraphDirectory (Join-Path $Root "held") (Join-Path $Root "held-moved")
  $Watch.Stop()
  Assert-Equal 6 $script:MoveAttempts "attempts before a transient lock clears"
  if ($Watch.ElapsedMilliseconds -lt 1500) {
    throw "retries did not back off: five refusals took $($Watch.ElapsedMilliseconds)ms"
  }

  # A tree held open for good must still fail, and must stop at the attempt ceiling.
  Reset-MoveStub -Failures 99 -Error $Locked
  $Failed = $false
  try { Move-CodegraphDirectory (Join-Path $Root "stuck") (Join-Path $Root "stuck-moved") } catch { $Failed = $true }
  Assert-Equal $true $Failed "an unrecoverable lock surfaces"
  Assert-Equal 10 $script:MoveAttempts "attempts before giving up"

  # Anything that is not a lock is a real error and must not cost nine seconds of retries.
  Reset-MoveStub -Failures 99 -Error $Unexpected
  $Failed = $false
  try { Move-CodegraphDirectory (Join-Path $Root "bad") (Join-Path $Root "bad-moved") } catch { $Failed = $true }
  Assert-Equal $true $Failed "an unexpected error surfaces"
  Assert-Equal 1 $script:MoveAttempts "attempts on an unexpected error"

  # Another installer winning the publish is not something to retry into.
  $Taken = Join-Path $Root "taken"
  New-Item -ItemType Directory -Path $Taken | Out-Null
  Reset-MoveStub -Failures 99 -Error $Locked
  $Failed = $false
  try { Move-CodegraphDirectory (Join-Path $Root "late") $Taken } catch { $Failed = $true }
  Assert-Equal $true $Failed "an occupied destination surfaces"
  Assert-Equal 1 $script:MoveAttempts "attempts against an occupied destination"

  # The real moves still relocate a tree, in both the cross-volume and the atomic form.
  Remove-Item -LiteralPath Function:\Move-Item
  $Plain = Join-Path $Root "plain"
  New-Item -ItemType Directory -Path $Plain | Out-Null
  Set-Content -LiteralPath (Join-Path $Plain "file.txt") -Value "bundle"
  $PlainMoved = Join-Path $Root "plain-moved"
  Move-CodegraphDirectory $Plain $PlainMoved
  if (-not (Test-Path -LiteralPath (Join-Path $PlainMoved "file.txt"))) { throw "a plain move did not relocate the tree" }

  $Atomic = Join-Path $Root "atomic"
  New-Item -ItemType Directory -Path $Atomic | Out-Null
  $AtomicMoved = Join-Path $Root "atomic-moved"
  Move-CodegraphDirectory $Atomic $AtomicMoved -Atomic
  if (-not (Test-Path -LiteralPath $AtomicMoved)) { throw "an atomic move did not relocate the tree" }
  if (Test-Path -LiteralPath $Atomic) { throw "an atomic move left the source behind" }

  $Failed = $false
  try { Move-CodegraphDirectory $PlainMoved $AtomicMoved -Atomic } catch { $Failed = $true }
  Assert-Equal $true $Failed "a real move onto an occupied destination surfaces"

  Write-Output "installer move retry recovered after 5 refusals and surfaced every unrecoverable failure"
} finally {
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}
