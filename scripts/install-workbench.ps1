<#
.SYNOPSIS
Prepare and activate an immutable Workbench runtime, separate from stock Pi.
.DESCRIPTION
Requires Node 24+ and development dependencies in this checkout. Dirty sources
require -AllowDirtySource; their actual hashes are saved. -PrepareOnly verifies
candidate integrity and current configuration/database compatibility without
changing configuration, launchers or active.json. Unchanged source gate/build
evidence can be reused for the same source and Node identities. Later use
-ActivateGeneration with the printed generation. -ResetLaunchers explicitly
permits backing up and replacing unrecognized workbench command files.
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Workbench'),
    [string]$BinRoot = (Join-Path $env:USERPROFILE '.local\bin'),
    [switch]$AllowDirtySource,
    [switch]$PrepareOnly,
    [string]$ActivateGeneration,
    [switch]$ResetLaunchers
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:WbSourceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:WbUtf8 = [Text.UTF8Encoding]::new($false, $true)

function Assert-WbNoLinks([string]$Path) {
    $cursor = $Path
    while ($cursor) {
        try {
            $attributes = [IO.File]::GetAttributes($cursor)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Installation paths must not traverse links or junctions: $cursor"
            }
            if ($cursor -ne $Path -and -not ($attributes -band [IO.FileAttributes]::Directory)) {
                throw "A parent path is not a directory: $cursor"
            }
        } catch [IO.FileNotFoundException] {
        } catch [IO.DirectoryNotFoundException] {
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Get-WbRoot([string]$Path) {
    # Drive-relative, device, UNC and volume-root destinations are deliberately
    # unsupported. Check every ancestor, including ancestors not created by us.
    if ($Path -notmatch '^[a-zA-Z]:[\\/]' -or $Path.Substring(2) -match '[:\x00-\x1f"]') {
        throw "Use an absolute local directory path: $Path"
    }
    foreach ($part in ($Path.Substring(3) -split '[\\/]')) {
        if ($part -and $part -notin @('.', '..') -and
            ($part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)')) {
            throw "Ambiguous Windows path component: $part"
        }
    }
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($full.Length -le 3) { throw 'A volume root cannot be an installation directory.' }
    Assert-WbNoLinks $full
    return $full
}

function Assert-WbPath([string]$Path, [string]$Root) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ne $Root -and -not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path escapes its destination root: $full"
    }
    Assert-WbNoLinks $full
    return $full
}

function New-WbDirectory([string]$Path, [string]$Root) {
    $full = Assert-WbPath $Path $Root
    [IO.Directory]::CreateDirectory($full) | Out-Null
    Assert-WbNoLinks $full
}

function Get-WbContext([string]$InstallRoot, [string]$BinRoot) {
    $install = Get-WbRoot $InstallRoot
    $bin = Get-WbRoot $BinRoot
    if ($install -eq $bin -or $install.StartsWith($bin + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $bin.StartsWith($install + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'InstallRoot and BinRoot must be separate, nonoverlapping directories.'
    }
    return [pscustomobject]@{
        install = $install; bin = $bin
        runtime = Join-Path $install 'runtime'
        backups = Join-Path $install 'installation-backups'
    }
}

function Get-WbHash([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-WbTextHash([string]$Text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($script:WbUtf8.GetBytes($Text))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Write-WbBytes([string]$Path, [byte[]]$Bytes, [string]$Root) {
    $full = Assert-WbPath $Path $Root
    $temp = Assert-WbPath ($full + '.' + [guid]::NewGuid().ToString('N') + '.tmp') $Root
    try {
        $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        Assert-WbNoLinks $full
        # Same-directory, literal, atomic file replacement; no running runtime
        # files are ever replaced. File.Replace also preserves destination ACLs.
        if ([IO.File]::Exists($full)) { [IO.File]::Replace($temp, $full, [NullString]::Value) }
        else { [IO.File]::Move($temp, $full) }
    } finally {
        if ([IO.File]::Exists($temp)) {
            $null = Assert-WbPath $temp $Root
            Remove-Item -LiteralPath $temp -Force
        }
    }
}

function Write-WbText([string]$Path, [string]$Text, [string]$Root) {
    Write-WbBytes $Path $script:WbUtf8.GetBytes($Text) $Root
}

function Write-WbJson([string]$Path, $Value, [string]$Root) {
    Write-WbText $Path (($Value | ConvertTo-Json -Depth 30) + "`n") $Root
}

function Read-WbJson([string]$Path) {
    Assert-WbNoLinks $Path
    return ([IO.File]::ReadAllText($Path, $script:WbUtf8) | ConvertFrom-Json)
}

function Get-WbApplication([string]$Name) {
    # Command discovery can return several installations of the same program.
    # Use the first PATH match and keep its concrete identity in receipts.
    $commands = @(Get-Command $Name -CommandType Application -ErrorAction Stop)
    $path = [IO.Path]::GetFullPath($commands[0].Source)
    Assert-WbNoLinks $path
    return $path
}

function Get-WbFiles([string]$Root) {
    Assert-WbNoLinks $Root
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count) {
        foreach ($path in [IO.Directory]::GetFileSystemEntries($pending.Pop())) {
            $attributes = [IO.File]::GetAttributes($path)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Runtime/source contains a link: $path" }
            if ($attributes -band [IO.FileAttributes]::Directory) { $pending.Push($path) }
            else { $path }
        }
    }
}

function Get-WbInventory([string]$Root, [string[]]$Paths = @(), [string[]]$Exclude = @()) {
    if (-not $Paths.Count) { $Paths = @(Get-WbFiles $Root) }
    foreach ($path in ($Paths | Sort-Object -Unique)) {
        $full = Assert-WbPath $path $Root
        $relative = $full.Substring($Root.Length + 1).Replace('\', '/')
        if ($relative -in $Exclude) { continue }
        [pscustomobject]@{ path = $relative; sha256 = Get-WbHash $full; bytes = ([IO.FileInfo]$full).Length }
    }
}

function Get-WbInventoryHash($Files) {
    [string[]]$lines = @(foreach ($file in $Files) { $file.path + "`t" + $file.bytes + "`t" + $file.sha256 + "`n" })
    # Windows PowerShell and PowerShell 7 use different culture collation
    # implementations. Receipt identity must not depend on either one.
    [Array]::Sort($lines, [StringComparer]::Ordinal)
    return Get-WbTextHash ($lines -join '')
}

function Copy-WbTree([string]$Source, [string]$Destination, [string]$Root) {
    foreach ($file in @(Get-WbFiles $Source)) {
        $relative = $file.Substring($Source.Length + 1)
        $target = Assert-WbPath (Join-Path $Destination $relative) $Root
        New-WbDirectory ([IO.Path]::GetDirectoryName($target)) $Root
        Copy-Item -LiteralPath $file -Destination $target
    }
}

function Get-WbSource([string]$Root, [switch]$Fixture) {
    $commit = $null
    $dirty = $true
    $paths = @()
    if (-not $Fixture) {
        $git = Get-WbApplication 'git.exe'
        $top = & $git -C $Root rev-parse --show-toplevel
        if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath([string]$top) -ne $Root) {
            throw 'Install from the Workbench checkout root.'
        }
        $commit = [string](& $git -C $Root rev-parse HEAD)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the source commit.' }
        $status = @(& $git -C $Root status --porcelain=v1 --untracked-files=all)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect source changes.' }
        $dirty = $status.Count -gt 0
        $names = @(& $git -c core.quotepath=false -C $Root ls-files --cached --others --exclude-standard)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inventory source files.' }
        $paths = @($names | ForEach-Object { Join-Path $Root $_ } | Where-Object { [IO.File]::Exists($_) })
    } else {
        $paths = @(Get-WbFiles $Root)
    }
    # Include build/gate inputs even if a caller has ignored them locally.
    $selectedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $paths) { $null = $selectedPaths.Add([IO.Path]::GetFullPath($path)) }
    foreach ($required in @('package.json', 'package-lock.json', 'tsconfig.json')) {
        $path = Join-Path $Root $required
        if (-not [IO.File]::Exists($path)) { throw "Missing source input: $required" }
        if ($selectedPaths.Add($path)) { $dirty = $true }
    }
    foreach ($directory in @('src', 'scripts', 'tests')) {
        $path = Join-Path $Root $directory
        if ($directory -ne 'src' -and -not [IO.Directory]::Exists($path)) { continue }
        foreach ($file in @(Get-WbFiles $path)) {
            if ($selectedPaths.Add($file)) { $dirty = $true }
        }
    }
    $files = @(Get-WbInventory $Root @($selectedPaths))
    return [pscustomobject]@{ commit = $commit; dirty = $dirty; sha256 = Get-WbInventoryHash $files; files = $files }
}

function Invoke-WbCommand([string]$Executable, [string[]]$Arguments, [string]$Cwd, [string]$Log, [string]$Root) {
    $null = Assert-WbPath $Log $Root
    Push-Location -LiteralPath $Cwd
    try {
        # Windows PowerShell represents native stderr as ErrorRecords. Preserve
        # it in the receipt without mistaking a warning for a nonzero exit.
        $priorPreference = $ErrorActionPreference
        $priorEncoding = [Console]::OutputEncoding
        $ErrorActionPreference = 'Continue'
        try {
            [Console]::OutputEncoding = $script:WbUtf8
            $output = @(& $Executable @Arguments 2>&1)
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $priorPreference
            [Console]::OutputEncoding = $priorEncoding
        }
        $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
        Write-WbText $Log ($text + "`n") $Root
        $receipt = [pscustomobject]@{
            executable = $Executable; arguments = $Arguments; cwd = $Cwd
            exitCode = $code; log = $Log; sha256 = Get-WbHash $Log
        }
        Write-WbJson ($Log + '.json') $receipt $Root
        if ($code -ne 0) { throw "Check failed (exit $code). Output retained: $Log" }
        return $receipt
    } finally { Pop-Location }
}

function Get-WbTargets($Context) {
    # This fixed allowlist, not paths supplied by a journal, controls recovery.
    foreach ($name in @('config.json', 'workbench.ps1', 'workbench.cmd', 'workbench', 'active.json')) {
        $root = if ($name -in @('config.json', 'active.json')) { $Context.install } else { $Context.bin }
        [pscustomobject]@{ name = $name; root = $root; path = Assert-WbPath (Join-Path $root $name) $root }
    }
}

function Get-WbFileState([string]$Path, [string]$Root) {
    $null = Assert-WbPath $Path $Root
    if (Test-Path -LiteralPath $Path) {
        if (-not [IO.File]::Exists($Path)) { throw "Expected a regular file: $Path" }
        return [pscustomobject]@{ exists = $true; sha256 = Get-WbHash $Path }
    }
    return [pscustomobject]@{ exists = $false; sha256 = $null }
}

function Test-WbState($Left, $Right) {
    return $Left.exists -eq $Right.exists -and $Left.sha256 -eq $Right.sha256
}

function New-WbTransaction($Context, [string]$Id, [string]$Action, [string]$Generation) {
    $root = Assert-WbPath (Join-Path $Context.backups $Id) $Context.backups
    if (Test-Path -LiteralPath $root) { throw "Transaction already exists: $root" }
    New-WbDirectory $root $Context.install
    foreach ($side in @('before', 'after', 'checks')) { New-WbDirectory (Join-Path $root $side) $Context.install }
    $entries = foreach ($target in @(Get-WbTargets $Context)) {
        $before = Get-WbFileState $target.path $target.root
        if ($before.exists) {
            $saved = Join-Path (Join-Path $root 'before') $target.name
            Write-WbBytes $saved ([IO.File]::ReadAllBytes($target.path)) $Context.install
            if ((Get-WbHash $saved) -ne $before.sha256) { throw "File changed while being backed up: $($target.path)" }
        }
        [pscustomobject]@{ name = $target.name; before = $before; after = $null }
    }
    $journal = [pscustomobject]@{
        format = 'workbench.transaction/1'; id = $Id; action = $Action; generation = $Generation
        installRoot = $Context.install; binRoot = $Context.bin
        state = 'preparing'; createdAt = [DateTime]::UtcNow.ToString('o'); error = $null; files = @($entries)
    }
    Write-WbJson (Join-Path $root 'transaction.json') $journal $Context.install
    return [pscustomobject]@{ root = $root; journal = $journal }
}

function Save-WbJournal($Context, $Transaction) {
    Write-WbJson (Join-Path $Transaction.root 'transaction.json') $Transaction.journal $Context.install
}

function Assert-WbJournal($Context, $Transaction, [switch]$BeforeOnly) {
    $journal = $Transaction.journal
    $null = Assert-WbPath $Transaction.root $Context.backups
    if ($journal.format -ne 'workbench.transaction/1' -or $journal.installRoot -ne $Context.install -or
        $journal.binRoot -ne $Context.bin -or $journal.id -ne [IO.Path]::GetFileName($Transaction.root)) {
        throw 'Recovery journal does not belong to these installation roots.'
    }
    $targets = @(Get-WbTargets $Context)
    if (@($journal.files).Count -ne $targets.Count) { throw 'Invalid recovery target inventory.' }
    $sides = if ($BeforeOnly) { @('before') } else { @('before', 'after') }
    for ($i = 0; $i -lt $targets.Count; $i++) {
        $entry = $journal.files[$i]
        if ($entry.name -cne $targets[$i].name) { throw 'Invalid recovery target name/order.' }
        foreach ($side in $sides) {
            $state = $entry.$side
            if ($null -eq $state -or $state.exists -isnot [bool]) { throw 'Incomplete recovery snapshot.' }
            $saved = Join-Path (Join-Path $Transaction.root $side) $entry.name
            $actual = Get-WbFileState $saved $Context.install
            if (-not (Test-WbState $actual $state)) { throw "Recovery snapshot hash mismatch: $saved" }
        }
    }
}

function Set-WbTarget($Context, $Transaction, $Target, $Entry, [string]$Side) {
    $state = $Entry.$Side
    if (Test-WbState (Get-WbFileState $Target.path $Target.root) $state) { return }
    if ($state.exists) {
        $saved = Join-Path (Join-Path $Transaction.root $Side) $Entry.name
        Write-WbBytes $Target.path ([IO.File]::ReadAllBytes($saved)) $Target.root
    } else {
        $null = Assert-WbPath $Target.path $Target.root
        if ([IO.File]::Exists($Target.path)) { Remove-Item -LiteralPath $Target.path -Force }
    }
}

function Restore-WbTransaction($Context, $Transaction) {
    Assert-WbJournal $Context $Transaction
    $targets = @(Get-WbTargets $Context)
    # Validate every target before restoring any. Unknown edits are preserved;
    # an interrupted transaction never grants authority to overwrite them.
    for ($i = 0; $i -lt $targets.Count; $i++) {
        $current = Get-WbFileState $targets[$i].path $targets[$i].root
        $entry = $Transaction.journal.files[$i]
        if (-not (Test-WbState $current $entry.before) -and -not (Test-WbState $current $entry.after)) {
            throw "Recovery found an external change; reconcile this file before retrying: $($targets[$i].path)"
        }
    }
    $Transaction.journal.state = 'recovery-required'
    Save-WbJournal $Context $Transaction
    for ($i = 0; $i -lt $targets.Count; $i++) {
        Set-WbTarget $Context $Transaction $targets[$i] $Transaction.journal.files[$i] 'before'
    }
    for ($i = 0; $i -lt $targets.Count; $i++) {
        if (-not (Test-WbState (Get-WbFileState $targets[$i].path $targets[$i].root) $Transaction.journal.files[$i].before)) {
            throw "Restoration readback failed: $($targets[$i].path)"
        }
    }
    $Transaction.journal.state = 'restored'
    Save-WbJournal $Context $Transaction
}

function Repair-WbInterrupted($Context, [switch]$PrepareOnly) {
    if (-not [IO.Directory]::Exists($Context.backups)) { return }
    foreach ($directory in Get-ChildItem -LiteralPath $Context.backups -Directory -Force) {
        $root = Assert-WbPath $directory.FullName $Context.backups
        $path = Join-Path $root 'transaction.json'
        if (-not [IO.File]::Exists($path)) { continue }
        $journal = Read-WbJson $path
        if ($journal.state -notin @('activating', 'recovery-required')) { continue }
        if ($PrepareOnly) { throw 'An activation is incomplete. Run rollback-workbench.ps1 -Recover with these roots first.' }
        Restore-WbTransaction $Context ([pscustomobject]@{ root = $root; journal = $journal })
        Write-Host "Restored interrupted activation: $root"
    }
}

function Open-WbLocks($Context, [switch]$PrepareOnly) {
    $locks = [Collections.Generic.List[IDisposable]]::new()
    try {
        $roots = @($Context.install)
        if (-not $PrepareOnly) { $roots += $Context.bin }
        foreach ($root in ($roots | Sort-Object)) {
            New-WbDirectory $root $root
            $path = Assert-WbPath (Join-Path $root '.workbench-install.lock') $root
            try { $locks.Add([IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)) }
            catch { throw "Another installer holds the lock, or the lock cannot be opened: $path" }
        }
        return ,$locks
    } catch {
        foreach ($lock in $locks) { $lock.Dispose() }
        throw
    }
}

function Get-WbLaunchers($Context, [string]$Runtime, [string]$Node, [switch]$Legacy) {
    $cli = Join-Path $Runtime 'dist\cli.js'
    if ($Legacy) {
        return @{
            'workbench.ps1' = '# Workbench managed launcher' + "`n" + '& node ''' + $cli.Replace("'", "''") + ''' @args' + "`nexit `$LASTEXITCODE`n"
            'workbench.cmd' = "@echo off`r`nnode `"$cli`" %*`r`nexit /b %errorlevel%`r`n"
            'workbench' = "#!/bin/sh`nexec node '" + $cli.Replace('\', '/').Replace("'", "'\''") + "' `"`$@`"`n"
        }
    }
    $owner = Get-WbTextHash $Context.install.ToLowerInvariant()
    $marker = "Workbench managed launcher v1 $owner"
    # A BOM keeps non-ASCII paths correct under Windows PowerShell 5.1.
    $ps = [string][char]0xfeff + "# $marker`n& '" + $Node.Replace("'", "''") + "' '" + $cli.Replace("'", "''") +
        "' --home '" + $Context.install.Replace("'", "''") + "' @args`nexit `$LASTEXITCODE`n"
    # Literal % must be doubled in batch files. Delayed expansion is disabled
    # so roots containing ! remain literal too.
    $cmd = "@echo off`r`nrem $marker`r`nsetlocal DisableDelayedExpansion`r`n" +
        "for /f `"tokens=2 delims=:`" %%c in ('chcp') do set `"_workbenchCodePage=%%c`"`r`nchcp 65001 >nul`r`n`"" + $Node.Replace('%', '%%') +
        '" "' + $cli.Replace('%', '%%') + '" --home "' + $Context.install.Replace('%', '%%') +
        "`" %*`r`nset `"_workbenchExit=%errorlevel%`"`r`nchcp %_workbenchCodePage% >nul`r`nexit /b %_workbenchExit%`r`n"
    $sh = "#!/bin/sh`n# $marker`nexec '" + $Node.Replace('\', '/').Replace("'", "'\''") + "' '" +
        $cli.Replace('\', '/').Replace("'", "'\''") + "' --home '" +
        $Context.install.Replace('\', '/').Replace("'", "'\''") + "' `"`$@`"`n"
    return @{ 'workbench.ps1' = $ps; 'workbench.cmd' = $cmd; 'workbench' = $sh }
}

function Assert-WbGenerationName([string]$Generation) {
    if ($Generation -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$' -or $Generation.EndsWith('.')) {
        throw 'Invalid saved generation name.'
    }
}

function Get-WbSavedGeneration($Context, [string]$Generation, [switch]$Fixture, [switch]$ManifestOnly) {
    Assert-WbGenerationName $Generation
    $runtime = Assert-WbPath (Join-Path $Context.runtime $Generation) $Context.runtime
    $receiptPath = Assert-WbPath (Join-Path (Join-Path $Context.backups $Generation) 'prepared.json') $Context.backups
    $receipt = Read-WbJson $receiptPath
    if ($receipt.format -ne 'workbench.prepared/1' -or $receipt.generation -ne $Generation -or
        $receipt.installRoot -ne $Context.install -or $receipt.binRoot -ne $Context.bin -or $receipt.runtime -ne $runtime) {
        throw 'Saved generation receipt does not match these installation roots.'
    }
    $manifestPath = Join-Path $runtime 'installed.json'
    Assert-WbNoLinks $manifestPath
    if ((Get-WbHash $manifestPath) -ne $receipt.manifestSha256) { throw 'Saved generation manifest hash mismatch.' }
    $manifest = Read-WbJson $manifestPath
    if ($manifest.format -ne 'workbench.runtime/1' -or $manifest.generation -ne $Generation -or
        $manifest.runtime -ne $runtime -or $manifest.installRoot -ne $Context.install -or $manifest.binRoot -ne $Context.bin) {
        throw 'Saved runtime identity does not match its receipt.'
    }
    if ($manifest.validationMode -ne 'production' -and -not $Fixture) {
        throw 'An offline fixture is not eligible for a real Workbench installation.'
    }
    if (-not $ManifestOnly) {
        $actual = @(Get-WbInventory $runtime -Exclude @('installed.json'))
        if ((Get-WbInventoryHash $actual) -ne (Get-WbInventoryHash $manifest.files)) { throw 'Saved runtime inventory/hash mismatch.' }
        Assert-WbNoLinks $manifest.node.path
        if ((Get-WbHash $manifest.node.path) -ne $manifest.node.sha256) {
            throw 'The Node executable changed. Prepare a new generation with the current Node runtime.'
        }
    }
    return [pscustomobject]@{ manifest = $manifest; receipt = $receipt; runtime = $runtime }
}

function Assert-WbOwnership($Context, [switch]$ResetLaunchers, [switch]$Fixture, $Transaction = $null) {
    # Preliminary inspection can select a generation, but replacement authority
    # comes from the exact before bytes whose hashes activation later checks.
    $snapshotRoot = $null
    if ($null -ne $Transaction) {
        Assert-WbJournal $Context $Transaction -BeforeOnly
        $snapshotRoot = Join-Path $Transaction.root 'before'
    }
    $activePath = if ($snapshotRoot) { Join-Path $snapshotRoot 'active.json' } else { Join-Path $Context.install 'active.json' }
    $expected = @{}
    $active = $null
    if ([IO.File]::Exists($activePath)) {
        $active = Read-WbJson $activePath
        Assert-WbGenerationName $active.generation
        $runtime = Assert-WbPath (Join-Path $Context.runtime $active.generation) $Context.runtime
        if ($active.runtime -ne $runtime) { throw 'The existing active pointer is not owned by this installation.' }
        if ($active.PSObject.Properties['format']) {
            if ($active.format -ne 'workbench.active/1' -or $active.installRoot -ne $Context.install -or $active.binRoot -ne $Context.bin) {
                throw 'The existing active pointer is not owned by this installation.'
            }
            $saved = Get-WbSavedGeneration $Context $active.generation -Fixture:$Fixture -ManifestOnly
            if ($active.manifestSha256 -ne $saved.receipt.manifestSha256) { throw 'Active pointer manifest hash mismatch.' }
            foreach ($name in @('workbench.ps1', 'workbench.cmd', 'workbench')) {
                $entry = @($saved.manifest.files | Where-Object { $_.path -ceq "launchers/$name" })
                if ($entry.Count -ne 1) { throw 'Saved launcher inventory is incomplete.' }
                $expected[$name] = $entry[0].sha256
            }
        } else {
            # Adopt only the exact original installer's templates, tied to its
            # own runtime marker. A copied comment alone does not prove ownership.
            $legacy = Read-WbJson (Join-Path $runtime 'installed.json')
            if ($legacy.runtime -ne $runtime -or $legacy.generation -ne $active.generation -or $legacy.version -ne $active.version) {
                throw 'Unrecognized legacy Workbench installation.'
            }
            $texts = Get-WbLaunchers $Context $runtime '' -Legacy
            foreach ($name in $texts.Keys) { $expected[$name] = Get-WbTextHash $texts[$name] }
        }
    }
    foreach ($target in @(Get-WbTargets $Context | Where-Object { $_.root -eq $Context.bin })) {
        $state = if ($snapshotRoot) {
            Get-WbFileState (Join-Path $snapshotRoot $target.name) $Context.install
        } else { Get-WbFileState $target.path $target.root }
        if ($state.exists -and (-not $expected.ContainsKey($target.name) -or $state.sha256 -ne $expected[$target.name]) -and -not $ResetLaunchers) {
            $description = if ($snapshotRoot) { 'Unrecognized or edited launcher in transaction snapshot' } else { 'Unrecognized or edited launcher' }
            throw "${description}: $($target.path). Reconcile the file and retry, or explicitly use install-workbench.ps1 -ResetLaunchers to back it up and replace it."
        }
    }
    return $active
}

function Invoke-WbRuntimeChecks($Context, [string]$Runtime, [string]$Node, [string]$Version,
    [string]$CheckRoot, [string]$ConfigSource = '', [switch]$Rollback) {
    New-WbDirectory $CheckRoot $Context.install
    $checkHome = Join-Path $CheckRoot 'home'
    New-WbDirectory $checkHome $Context.install
    if ($ConfigSource) {
        $null = Assert-WbPath $ConfigSource $Context.install
        Copy-Item -LiteralPath $ConfigSource -Destination (Join-Path $checkHome 'config.json')
    }
    $cli = Join-Path $Runtime 'dist\cli.js'
    $checks = @()
    foreach ($command in @('--version', '--help', 'init')) {
        $label = $command.TrimStart('-')
        $checks += Invoke-WbCommand $Node @($cli, $command, '--home', $checkHome) $Runtime (Join-Path $CheckRoot "$label.log") $Context.install
    }
    $versionText = [IO.File]::ReadAllText((Join-Path $CheckRoot 'version.log')).Trim()
    if ($versionText -notmatch ('(?m)^workbench ' + [regex]::Escape($Version) + '\r?$')) { throw 'Installed CLI version does not match package.json.' }
    if ([IO.File]::ReadAllText((Join-Path $CheckRoot 'help.log')) -notmatch '--home') { throw 'Installed CLI help is incomplete.' }
    # The candidate creates only a disposable database in CheckRoot. Existing
    # state is opened read-only through node:sqlite, never through Store.
    $probe = @'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const [runtime, install, home, selected, result, rollback] = process.argv.slice(1);
const { defaults, validateConfig, saveConfig } = await import(pathToFileURL(join(runtime, 'dist/config.js')).href);
const { Store } = await import(pathToFileURL(join(runtime, 'dist/store.js')).href);
const config = selected !== '-' ? JSON.parse(readFileSync(selected, 'utf8')) : defaults(install);
if (!isAbsolute(config.stateDir)) throw new Error('Configuration stateDir must be absolute before installation.');
const validated = validateConfig(config);
if (rollback === 'true' && existsSync(join(install, 'config.json'))) {
  const current = JSON.parse(readFileSync(join(install, 'config.json'), 'utf8'));
  if (typeof current.stateDir !== 'string' || !isAbsolute(current.stateDir) ||
      resolve(current.stateDir).toLowerCase() !== resolve(validated.stateDir).toLowerCase())
    throw new Error('Saved configuration uses a different stateDir. Reconcile configuration manually before rollback.');
}
saveConfig(validated, home);
const probeState = join(home, 'schema-probe');
const store = new Store(probeState);
store.close();
const probeDb = new DatabaseSync(toNamespacedPath(join(probeState, 'workbench.sqlite')), { readOnly: true });
let schema;
try { schema = probeDb.prepare('PRAGMA user_version').get().user_version; } finally { probeDb.close(); }
if (!Number.isSafeInteger(schema) || schema < 1) throw new Error('Candidate did not declare a database schema.');
const database = join(validated.stateDir, 'workbench.sqlite');
let observedSchema = null;
if (existsSync(database)) {
  const db = new DatabaseSync(toNamespacedPath(database), { readOnly: true });
  try { observedSchema = db.prepare('PRAGMA user_version').get().user_version; } finally { db.close(); }
  if (observedSchema !== schema)
    throw new Error('Database schema is incompatible with this generation. No database migration or rollback was performed.');
}
writeFileSync(result, JSON.stringify({ configVersion: validated.version, databaseSchema: schema,
  observedSchema, stateDir: validated.stateDir, database }) + '\n', { flag: 'wx' });
'@
    $result = Join-Path $CheckRoot 'compatibility.json'
    $selectedArgument = if ($ConfigSource) { $ConfigSource } else { '-' }
    $checks += Invoke-WbCommand $Node @('--input-type=module', '-e', $probe, $Runtime, $Context.install, $checkHome,
        $selectedArgument, $result, $Rollback.IsPresent.ToString().ToLowerInvariant()) $Runtime (Join-Path $CheckRoot 'compatibility.log') $Context.install
    $configPath = if ($ConfigSource) { $ConfigSource } else { Join-Path $checkHome 'config.json' }
    return [pscustomobject]@{ checks = $checks; config = $configPath; compatibility = Read-WbJson $result }
}

function Set-WbDesired($Context, $Transaction, $Saved, [string]$Config) {
    $afterRoot = Join-Path $Transaction.root 'after'
    Write-WbBytes (Join-Path $afterRoot 'config.json') ([IO.File]::ReadAllBytes($Config)) $Context.install
    foreach ($name in @('workbench.ps1', 'workbench.cmd', 'workbench')) {
        $source = Join-Path (Join-Path $Saved.runtime 'launchers') $name
        Write-WbBytes (Join-Path $afterRoot $name) ([IO.File]::ReadAllBytes($source)) $Context.install
    }
    $pointer = [ordered]@{
        format = 'workbench.active/1'; installRoot = $Context.install; binRoot = $Context.bin
        runtime = $Saved.runtime; generation = $Saved.manifest.generation; version = $Saved.manifest.version
        manifestSha256 = $Saved.receipt.manifestSha256; sourceSha256 = $Saved.manifest.source.sha256
        transaction = $Transaction.journal.id
    }
    $oldPointer = Join-Path (Join-Path $Transaction.root 'before') 'active.json'
    $samePointer = $false
    if ([IO.File]::Exists($oldPointer)) {
        $prior = Read-WbJson $oldPointer
        $samePointer = $prior.PSObject.Properties['format'] -and $prior.format -eq 'workbench.active/1' -and
            $prior.generation -eq $pointer.generation -and $prior.manifestSha256 -eq $pointer.manifestSha256
    }
    if ($samePointer) { Write-WbBytes (Join-Path $afterRoot 'active.json') ([IO.File]::ReadAllBytes($oldPointer)) $Context.install }
    else { Write-WbJson (Join-Path $afterRoot 'active.json') $pointer $Context.install }
    foreach ($entry in $Transaction.journal.files) {
        $entry.after = Get-WbFileState (Join-Path $afterRoot $entry.name) $Context.install
    }
    $Transaction.journal.state = 'prepared'
    Save-WbJournal $Context $Transaction
}

function Invoke-WbActivation($Context, $Transaction, [scriptblock]$TestHook) {
    Assert-WbJournal $Context $Transaction
    $targets = @(Get-WbTargets $Context)
    for ($i = 0; $i -lt $targets.Count; $i++) {
        if (-not (Test-WbState (Get-WbFileState $targets[$i].path $targets[$i].root) $Transaction.journal.files[$i].before)) {
            throw "Installation files changed during preparation: $($targets[$i].path)"
        }
    }
    $Transaction.journal.state = 'activating'
    Save-WbJournal $Context $Transaction
    try {
        for ($i = 0; $i -lt $targets.Count; $i++) {
            if (-not (Test-WbState (Get-WbFileState $targets[$i].path $targets[$i].root) $Transaction.journal.files[$i].before)) {
                throw "Installation file changed during activation: $($targets[$i].path)"
            }
            Set-WbTarget $Context $Transaction $targets[$i] $Transaction.journal.files[$i] 'after'
            if ($TestHook) { & $TestHook ("after-" + $targets[$i].name) $Context $Transaction }
        }
        for ($i = 0; $i -lt $targets.Count; $i++) {
            if (-not (Test-WbState (Get-WbFileState $targets[$i].path $targets[$i].root) $Transaction.journal.files[$i].after)) {
                throw "Activation readback failed: $($targets[$i].path)"
            }
        }
        if ($TestHook) { & $TestHook 'before-commit' $Context $Transaction }
        $Transaction.journal.state = 'committed'
        Save-WbJournal $Context $Transaction
    } catch {
        $failure = $_.Exception.Message
        $Transaction.journal.error = $failure
        try { Restore-WbTransaction $Context $Transaction }
        catch {
            $Transaction.journal.state = 'recovery-required'
            Save-WbJournal $Context $Transaction
            throw "Activation failed: $failure Recovery is incomplete: $($_.Exception.Message) Journal: $($Transaction.root)"
        }
        throw "Activation failed; previous configuration, pointer and launchers were restored. $failure Journal: $($Transaction.root)"
    }
}

function New-WbGeneration($Context, $Transaction, [string]$SourceRoot, $Source, [string]$FixtureRuntime,
    [scriptblock]$TestHook) {
    $package = Read-WbJson (Join-Path $SourceRoot 'package.json')
    $version = [string]$package.version
    if ($package.name -ne 'workbench-agent-harness' -or $version -notmatch '^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$') {
        throw 'Unexpected Workbench package name/version.'
    }
    $runtime = Assert-WbPath (Join-Path $Context.runtime $Transaction.journal.generation) $Context.runtime
    if (Test-Path -LiteralPath $runtime) { throw 'Runtime generation already exists.' }
    New-WbDirectory $runtime $Context.install
    $node = Get-WbApplication 'node.exe'
    $checkRoot = Join-Path $Transaction.root 'checks'
    $nodeCheck = Invoke-WbCommand $node @('--version') $SourceRoot (Join-Path $checkRoot 'node.log') $Context.install
    $nodeVersion = [IO.File]::ReadAllText($nodeCheck.log).Trim()
    if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) { throw 'Workbench requires Node 24 or newer.' }
    $nodeIdentity = [pscustomobject]@{ path = $node; version = $nodeVersion; sha256 = Get-WbHash $node }
    $checks = @($nodeCheck)
    Write-WbJson (Join-Path $Transaction.root 'source.json') $Source $Context.install
    if ($FixtureRuntime) {
        Copy-WbTree (Get-WbRoot $FixtureRuntime) $runtime $Context.install
        $mode = 'offline-fixture'
    } else {
        $mode = 'production'
        $npmShim = Get-WbApplication 'npm.cmd'
        $npmCli = Join-Path ([IO.Path]::GetDirectoryName($npmShim)) 'node_modules\npm\bin\npm-cli.js'
        Assert-WbNoLinks $npmCli
        if (-not [IO.File]::Exists($npmCli)) { throw "Cannot locate npm's CLI beside its launcher: $npmShim" }
        # Invoke npm's JS entrypoint with the selected Node executable. Passing
        # destination paths through npm.cmd would expand literal %NAME% in CMD.
        Write-Host 'Checking source, building a fresh runtime, and installing production dependencies...'
        $checks += Invoke-WbCommand $node @($npmCli, '--version') $SourceRoot (Join-Path $checkRoot 'npm-version.log') $Context.install
        $checks += Invoke-WbCommand $node @('scripts/check.mjs') $SourceRoot (Join-Path $checkRoot 'gate.log') $Context.install
        # Build directly into a new generation; stale dist files in the source
        # checkout cannot leak into the installation. npm receives literal argv
        # through Node and handles quoting for its own build subprocess.
        $checks += Invoke-WbCommand $node @($npmCli, 'run', 'build', '--', '--outDir', (Join-Path $runtime 'dist')) $SourceRoot (Join-Path $checkRoot 'build.log') $Context.install
        foreach ($name in @('package.json', 'package-lock.json')) {
            Copy-Item -LiteralPath (Join-Path $SourceRoot $name) -Destination (Join-Path $runtime $name)
        }
        $checks += Invoke-WbCommand $node @($npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') $runtime (Join-Path $checkRoot 'npm-ci.log') $Context.install
    }
    if (-not [IO.Directory]::Exists((Join-Path $runtime 'node_modules'))) { throw 'Prepared runtime is missing production dependencies.' }
    foreach ($name in @('package.json', 'package-lock.json')) {
        if ((Get-WbHash (Join-Path $runtime $name)) -ne (Get-WbHash (Join-Path $SourceRoot $name))) {
            throw "Runtime does not match its source input: $name"
        }
    }
    $beforeConfig = Join-Path (Join-Path $Transaction.root 'before') 'config.json'
    $selected = if ([IO.File]::Exists($beforeConfig)) { $beforeConfig } else { '' }
    $proof = Invoke-WbRuntimeChecks $Context $runtime $node $version (Join-Path $checkRoot 'runtime') $selected
    $checks += $proof.checks
    Write-WbBytes (Join-Path $runtime 'saved-config.json') ([IO.File]::ReadAllBytes($proof.config)) $Context.install
    $launchRoot = Join-Path $runtime 'launchers'
    New-WbDirectory $launchRoot $Context.install
    $launchers = Get-WbLaunchers $Context $runtime $node
    foreach ($name in $launchers.Keys) { Write-WbText (Join-Path $launchRoot $name) $launchers[$name] $Context.install }
    if ($TestHook) { & $TestHook 'before-source-readback' $Context $Transaction }
    $readback = Get-WbSource $SourceRoot -Fixture:([bool]$FixtureRuntime)
    if ($readback.sha256 -ne $Source.sha256 -or $readback.commit -ne $Source.commit -or $readback.dirty -ne $Source.dirty) {
        throw 'Source changed during preparation. This candidate cannot be activated.'
    }
    if ((Get-WbHash $node) -ne $nodeIdentity.sha256) { throw 'Node changed during preparation.' }
    $manifest = [ordered]@{
        format = 'workbench.runtime/1'; generation = $Transaction.journal.generation; version = $version
        runtime = $runtime; installRoot = $Context.install; binRoot = $Context.bin
        preparedAt = [DateTime]::UtcNow.ToString('o'); validationMode = $mode
        source = $Source; node = $nodeIdentity; checks = $checks
        compatibility = $proof.compatibility
        files = @(Get-WbInventory $runtime)
    }
    $manifestPath = Join-Path $runtime 'installed.json'
    Write-WbJson $manifestPath $manifest $Context.install
    $receipt = [ordered]@{
        format = 'workbench.prepared/1'; generation = $Transaction.journal.generation
        runtime = $runtime; installRoot = $Context.install; binRoot = $Context.bin
        manifestSha256 = Get-WbHash $manifestPath
    }
    Write-WbJson (Join-Path $Transaction.root 'prepared.json') $receipt $Context.install
    return Get-WbSavedGeneration $Context $Transaction.journal.generation -Fixture:([bool]$FixtureRuntime)
}

function Invoke-WbInstall {
    # FixtureRuntime, SourceRoot and TestHook are internal test seams. The script
    # CLI cannot bind them; fixture receipts cannot pass production activation.
    param([string]$InstallRoot, [string]$BinRoot, [switch]$AllowDirtySource, [switch]$PrepareOnly,
        [string]$ActivateGeneration, [switch]$ResetLaunchers,
        [string]$SourceRoot = $script:WbSourceRoot, [string]$FixtureRuntime = '', [scriptblock]$TestHook)
    if ($PrepareOnly -and $ActivateGeneration) { throw 'Choose -PrepareOnly or -ActivateGeneration.' }
    $context = Get-WbContext $InstallRoot $BinRoot
    $sourceRootFull = Get-WbRoot $SourceRoot
    if ($context.install -eq $sourceRootFull -or
        $context.install.StartsWith($sourceRootFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $sourceRootFull.StartsWith($context.install + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'InstallRoot must not overlap the source checkout.'
    }
    $locks = Open-WbLocks $context -PrepareOnly:$PrepareOnly
    $transaction = $null
    try {
        New-WbDirectory $context.runtime $context.install
        New-WbDirectory $context.backups $context.install
        Repair-WbInterrupted $context -PrepareOnly:$PrepareOnly
        $active = Assert-WbOwnership $context -ResetLaunchers:$ResetLaunchers -Fixture:([bool]$FixtureRuntime)
        $saved = $null
        if ($ActivateGeneration) {
            $saved = Get-WbSavedGeneration $context $ActivateGeneration -Fixture:([bool]$FixtureRuntime)
        } else {
            $source = Get-WbSource $sourceRootFull -Fixture:([bool]$FixtureRuntime)
            if ($source.dirty -and -not $AllowDirtySource) { throw 'Source has changes. Use -AllowDirtySource to prepare an explicitly identified candidate.' }
            if ($active -and $active.PSObject.Properties['format']) {
                $existing = Get-WbSavedGeneration $context $active.generation -Fixture:([bool]$FixtureRuntime) -ManifestOnly
                $currentNode = Get-WbApplication 'node.exe'
                if ($existing.manifest.source.sha256 -eq $source.sha256 -and
                    $existing.manifest.validationMode -eq $(if ($FixtureRuntime) { 'offline-fixture' } else { 'production' }) -and
                    $existing.manifest.node.path -eq $currentNode -and $existing.manifest.node.sha256 -eq (Get-WbHash $currentNode)) {
                    $saved = Get-WbSavedGeneration $context $active.generation -Fixture:([bool]$FixtureRuntime)
                }
            }
        }
        if ($saved) {
            $id = 'activate-' + [guid]::NewGuid().ToString('N')
            $transaction = New-WbTransaction $context $id 'activate' $saved.manifest.generation
        } else {
            $version = [string](Read-WbJson (Join-Path $sourceRootFull 'package.json')).version
            $generation = $version + '-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
            Assert-WbGenerationName $generation
            $transaction = New-WbTransaction $context $generation 'install' $generation
        }
        $null = Assert-WbOwnership $context -Transaction $transaction -ResetLaunchers:$ResetLaunchers -Fixture:([bool]$FixtureRuntime)
        if (-not $saved) {
            $saved = New-WbGeneration $context $transaction $sourceRootFull $source $FixtureRuntime $TestHook
        }
        $beforeConfig = Join-Path (Join-Path $transaction.root 'before') 'config.json'
        $selected = if ([IO.File]::Exists($beforeConfig)) { $beforeConfig } else { Join-Path $saved.runtime 'saved-config.json' }
        $checkName = if ($PrepareOnly) { 'preparation-checks' } else { 'activation-checks' }
        # Reused preparation still validates the current captured configuration
        # and live database; it does not rerun the source gate/build/npm branch.
        $proof = Invoke-WbRuntimeChecks $context $saved.runtime $saved.manifest.node.path $saved.manifest.version (Join-Path $transaction.root $checkName) $selected
        if ($PrepareOnly) {
            Assert-WbJournal $context $transaction -BeforeOnly
            $targets = @(Get-WbTargets $context)
            for ($i = 0; $i -lt $targets.Count; $i++) {
                if (-not (Test-WbState (Get-WbFileState $targets[$i].path $targets[$i].root) $transaction.journal.files[$i].before)) {
                    throw "Installation files changed during preparation: $($targets[$i].path)"
                }
            }
            $transaction.journal.state = 'prepared'
            Save-WbJournal $context $transaction
            Write-Host "Prepared Workbench $($saved.manifest.version). Generation: $($saved.manifest.generation)"
            Write-Host "Source SHA256: $($saved.manifest.source.sha256)"
            return $saved
        }
        Set-WbDesired $context $transaction $saved $proof.config
        if ($TestHook) { & $TestHook 'before-activation' $context $transaction }
        $null = Get-WbSavedGeneration $context $saved.manifest.generation -Fixture:([bool]$FixtureRuntime)
        # Reinstalling identical sources reuses the immutable generation. Only
        # missing/changed managed activation files need to be written.
        Invoke-WbActivation $context $transaction $TestHook
        Write-Host "Workbench $($saved.manifest.version) active: $($saved.runtime)"
        Write-Host "Home: $($context.install)"
        Write-Host "Source SHA256: $($saved.manifest.source.sha256)"
        Write-Host "Previous files and recovery journal: $($transaction.root)"
        return $saved
    } catch {
        if ($transaction -and $transaction.journal.state -in @('preparing', 'prepared')) {
            $transaction.journal.state = 'failed'
            $transaction.journal.error = $_.Exception.Message
            Save-WbJournal $context $transaction
        }
        throw
    } finally { foreach ($lock in $locks) { $lock.Dispose() } }
}

if ($MyInvocation.InvocationName -ne '.') {
    $null = Invoke-WbInstall -InstallRoot $InstallRoot -BinRoot $BinRoot -AllowDirtySource:$AllowDirtySource `
        -PrepareOnly:$PrepareOnly -ActivateGeneration $ActivateGeneration -ResetLaunchers:$ResetLaunchers
}
