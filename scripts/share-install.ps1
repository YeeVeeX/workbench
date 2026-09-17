<#
.SYNOPSIS
Register a command for a verified, already extracted Workbench folder.
.DESCRIPTION
No downloads, key import or configuration changes. Keep the package in its final
location before running. Existing commands are never overwritten. AddToPath is
explicit; without it the script prints the launcher location.
#>
[CmdletBinding()]
param(
    [string]$BinRoot = (Join-Path $env:USERPROFILE '.local\bin'),
    [ValidatePattern('^[a-zA-Z][a-zA-Z0-9-]{0,39}$')]
    [string]$CommandName = 'workbench',
    [switch]$AddToPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-WbOrdinaryPath([string]$Path) {
    $wbCursor = $Path
    while ($wbCursor) {
        # GetAttributes sees dangling reparse points too; Test-Path can miss them.
        try { $wbAttributes = [IO.File]::GetAttributes($wbCursor) }
        catch [IO.FileNotFoundException] { $wbAttributes = 0 }
        catch [IO.DirectoryNotFoundException] { $wbAttributes = 0 }
        if ($wbAttributes -band [IO.FileAttributes]::ReparsePoint) {
            throw 'Package and command paths must not traverse links or junctions. Choose ordinary directories.'
        }
        $wbCursor = [IO.Path]::GetDirectoryName($wbCursor)
    }
}

function Get-WbUserPath {
    $wbKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    try {
        $wbValue = if ($null -ne $wbKey) { $wbKey.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
        $wbKind = if ($null -ne $wbValue) { $wbKey.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        if ($null -ne $wbValue -and $wbValue -isnot [string]) { throw 'User PATH is not text. Repair it before using AddToPath.' }
        return [pscustomobject]@{ Value = $wbValue; Kind = $wbKind }
    } finally { if ($null -ne $wbKey) { $wbKey.Dispose() } }
}

function Set-WbUserPath($Before, [string]$Value) {
    $wbCurrentPath = Get-WbUserPath
    if ($wbCurrentPath.Value -cne $Before.Value -or $wbCurrentPath.Kind -ne $Before.Kind) {
        throw 'User PATH changed during registration. Retry to preserve the new value.'
    }
    $wbKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try { $wbKey.SetValue('Path', $Value, $Before.Kind) }
    finally { $wbKey.Dispose() }
}

$wbPackageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($BinRoot -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\(?![?.]\\)[^\\]+\\[^\\]+\\)') {
    throw 'Choose a fully qualified command directory, such as C:\Tools\bin.'
}
$wbBin = [IO.Path]::GetFullPath($BinRoot).TrimEnd('\', '/')
if ($wbBin -eq [IO.Path]::GetPathRoot($wbBin).TrimEnd('\', '/')) { throw 'Choose a command directory below the drive or share root.' }
if ($wbBin -match '[. ](?:[\\/]|$)') { throw 'Command directory components must not end in a dot or space.' }
if ($CommandName -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') { throw 'Choose a command name that is not a Windows device name.' }
if ($AddToPath -and $wbBin -match '[;%"]') { throw 'PATH cannot safely represent this command directory. Omit AddToPath or choose a directory without semicolons, percent signs or quotes.' }
foreach ($wbPath in @($PSScriptRoot, $PSCommandPath, $wbPackageRoot, $wbBin)) { Assert-WbOrdinaryPath $wbPath }

$wbPs1 = Join-Path $wbBin ($CommandName + '.ps1')
$wbCmd = Join-Path $wbBin ($CommandName + '.cmd')
$wbExtensions = @('', '.ps1', '.cmd', '.bat', '.exe', '.com') + @($env:PATHEXT -split ';' | Where-Object { $_ -match '^\.[a-zA-Z0-9]+$' })
foreach ($wbExtension in ($wbExtensions | Select-Object -Unique)) {
    $wbExisting = Join-Path $wbBin ($CommandName + $wbExtension)
    Assert-WbOrdinaryPath $wbExisting
    if (Test-Path -LiteralPath $wbExisting) { throw 'Command already exists. Select another CommandName; no command was changed.' }
}
if (Get-Command -Name $CommandName -All -ErrorAction SilentlyContinue) {
    throw 'Command already exists on PATH or in this session. Select another CommandName; no command was changed.'
}
$wbCli = Join-Path $wbPackageRoot 'dist\cli.js'
Assert-WbOrdinaryPath $wbCli
if (-not (Test-Path -LiteralPath $wbCli -PathType Leaf)) { throw 'Build this source package first: npm ci --ignore-scripts; npm run build.' }
$wbBundledNode = Join-Path $wbPackageRoot 'node\node.exe'
$wbJunior = Join-Path $wbPackageRoot 'JUNIOR-PACKAGE.json'
foreach ($wbPath in @($wbBundledNode, $wbJunior)) { Assert-WbOrdinaryPath $wbPath }

# Manifests verify consistency, not publisher identity. Verify before running
# even the bundled Node version probe. Source build outputs are local inputs.
$wbManifestPath = Join-Path $wbPackageRoot 'RELEASE-MANIFEST.json'
$wbRuntime = Test-Path -LiteralPath $wbManifestPath
Assert-WbOrdinaryPath $wbManifestPath
if (-not $wbRuntime -and ((Test-Path -LiteralPath $wbBundledNode) -or (Test-Path -LiteralPath $wbJunior))) {
    throw 'Runtime package manifest is missing. Extract a fresh package.'
}
if (-not $wbRuntime) { $wbManifestPath = Join-Path $wbPackageRoot 'share-manifest.json' }
Assert-WbOrdinaryPath $wbManifestPath
if (Test-Path -LiteralPath $wbManifestPath) {
    $wbManifest = Get-Content -LiteralPath $wbManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $wbFormat = if ($wbRuntime) { 'workbench.runtime/1' } else { 'workbench.share-source/1' }
    if ($null -eq $wbManifest -or $wbManifest.format -ne $wbFormat -or
        $wbManifest.files -isnot [Array] -or $wbManifest.files.Count -eq 0) { throw 'Invalid package manifest. Extract a fresh package.' }
    $wbListed = @{}
    foreach ($wbEntry in $wbManifest.files) {
        if ($null -eq $wbEntry -or $wbEntry.path -isnot [string] -or
            $wbEntry.path -match '[\\:\x00-\x1f]' -or $wbEntry.path.StartsWith('/') -or
            $wbEntry.sha256 -isnot [string] -or $wbEntry.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
            $wbEntry.bytes -isnot [ValueType] -or $wbEntry.bytes -is [bool] -or
            $wbEntry.bytes -lt 0 -or [decimal]$wbEntry.bytes -ne [math]::Floor([decimal]$wbEntry.bytes)) {
            throw 'Invalid package manifest entry. Extract a fresh package.'
        }
        foreach ($wbPart in $wbEntry.path.Split('/')) {
            if (-not $wbPart -or $wbPart -match '[. ]$|[<>:"|?*]' -or
                $wbPart -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Invalid manifest path.' }
        }
        $wbTarget = [IO.Path]::GetFullPath((Join-Path $wbPackageRoot $wbEntry.path))
        if (-not $wbTarget.StartsWith($wbPackageRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes package.' }
        if ($wbListed.ContainsKey($wbTarget) -or $wbTarget -eq $wbManifestPath) { throw 'Duplicate or self-referencing manifest path.' }
        $wbListed[$wbTarget] = $true
        Assert-WbOrdinaryPath $wbTarget
        if (-not (Test-Path -LiteralPath $wbTarget -PathType Leaf)) { throw 'Missing package file. Extract a fresh package.' }
        if ((Get-Item -LiteralPath $wbTarget -Force).Length -ne $wbEntry.bytes -or
            (Get-FileHash -LiteralPath $wbTarget -Algorithm SHA256).Hash -ne $wbEntry.sha256) { throw 'Package integrity check failed. Extract a fresh package.' }
    }
    if (-not $wbListed.ContainsKey($PSCommandPath)) { throw 'The manifest does not cover this installer. Extract a fresh package.' }
    if ($wbRuntime) {
        # Refuse omitted runtime files and linked directories, including parents
        # of dependencies. Never recurse through a reparse point.
        $wbPending = [Collections.Generic.Stack[string]]::new()
        $wbPending.Push($wbPackageRoot)
        while ($wbPending.Count) {
            foreach ($wbItem in (Get-ChildItem -LiteralPath $wbPending.Pop() -Force)) {
                if ($wbItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime contains a link or junction. Extract a fresh package.' }
                if ($wbItem.PSIsContainer) { $wbPending.Push($wbItem.FullName) }
                elseif ($wbItem.FullName -ne $wbManifestPath -and -not $wbListed.ContainsKey($wbItem.FullName)) { throw 'Runtime contains an unlisted file. Extract a fresh package.' }
            }
        }
    }
}
$wbNode = $wbBundledNode
if (-not (Test-Path -LiteralPath $wbNode -PathType Leaf)) {
    $wbNode = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
}
Assert-WbOrdinaryPath $wbNode
$wbVersion = & $wbNode --version
if ($LASTEXITCODE -ne 0 -or $wbVersion -isnot [string] -or $wbVersion -notmatch '^v(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 24) { throw 'Node 24 or later is required.' }

$wbUserPath = $null
$wbNewPath = $null
if ($AddToPath) {
    # Preserve raw %VARIABLE% entries and their registry type.
    $wbUserPath = Get-WbUserPath
    $wbPathEntries = @(([string]$wbUserPath.Value -split ';') | ForEach-Object { $_.Trim().Trim('"').TrimEnd('\', '/') })
    if ($wbPathEntries -notcontains $wbBin) {
        $wbSeparator = if ([string]::IsNullOrEmpty($wbUserPath.Value) -or $wbUserPath.Value.EndsWith(';')) { '' } else { ';' }
        $wbNewPath = [string]$wbUserPath.Value + $wbSeparator + $wbBin
    }
}
$null = [IO.Directory]::CreateDirectory($wbBin)
Assert-WbOrdinaryPath $wbBin
$wbNodeLiteral = $wbNode.Replace("'", "''")
$wbCliLiteral = $wbCli.Replace("'", "''")
$wbHomeLine = ''
if (Test-Path -LiteralPath $wbJunior -PathType Leaf) {
    $wbHomeLine = 'if (-not $env:WORKBENCH_HOME) { $env:WORKBENCH_HOME = Join-Path $env:LOCALAPPDATA ''WorkbenchJunior'' }' + "`r`n"
}
$wbScript = $wbHomeLine + "& '$wbNodeLiteral' '$wbCliLiteral' @args`r`nexit `$LASTEXITCODE`r`n"
$wbUtf8 = [Text.UTF8Encoding]::new($true)
# BOM is necessary for non-ASCII paths under Windows PowerShell 5.1.
$wbScriptBytes = [byte[]]($wbUtf8.GetPreamble() + $wbUtf8.GetBytes($wbScript))
$wbCommand = "@echo off`r`nsetlocal DisableDelayedExpansion`r`n`"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -File `"%~dp0$CommandName.ps1`" %*`r`nexit /b %errorlevel%`r`n"
$wbCreated = @()
try {
    # CreateNew refuses replacement even if another installer raced this one.
    foreach ($wbLauncher in @(
        @{ Path = $wbPs1; Bytes = $wbScriptBytes },
        @{ Path = $wbCmd; Bytes = [Text.Encoding]::ASCII.GetBytes($wbCommand) }
    )) {
        Assert-WbOrdinaryPath $wbLauncher.Path
        $wbStream = [IO.File]::Open($wbLauncher.Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $wbCreated += $wbLauncher
        try { $wbStream.Write($wbLauncher.Bytes, 0, $wbLauncher.Bytes.Length) }
        catch {
            # Capture a failed partial write while this handle still excludes
            # other writers, so rollback can recognize and remove it too.
            $wbLauncher.Bytes = [byte[]]::new($wbStream.Length)
            $wbStream.Position = 0
            $null = $wbStream.Read($wbLauncher.Bytes, 0, $wbLauncher.Bytes.Length)
            throw
        }
        finally { $wbStream.Dispose() }
    }
    if ($null -ne $wbNewPath) {
        Set-WbUserPath $wbUserPath $wbNewPath
    }
} catch {
    # Only remove our own unchanged launchers. These checks are not an OS
    # sandbox against hostile concurrent filesystem changes.
    foreach ($wbOwned in $wbCreated) {
        Assert-WbOrdinaryPath $wbOwned.Path
        if (Test-Path -LiteralPath $wbOwned.Path -PathType Leaf) {
            $wbCurrent = [IO.File]::ReadAllBytes($wbOwned.Path)
            if ([Convert]::ToBase64String($wbCurrent) -ceq [Convert]::ToBase64String($wbOwned.Bytes)) {
                Remove-Item -LiteralPath $wbOwned.Path -Force
            }
        }
    }
    throw
}
Write-Output 'Keep the package in this location.'
if ($AddToPath) { Write-Output 'User PATH is saved. Sign out and back in to refresh it in all terminals.' }
Write-Output "Command registered: $wbPs1"
