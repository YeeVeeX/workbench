<#
.SYNOPSIS
Restore a verified saved Workbench generation, or recover an interrupted activation.
.DESCRIPTION
-Generation restores that generation's saved configuration and launchers after
checking all runtime hashes and database compatibility. It never downgrades or
restores a database. -Recover only restores incomplete activation transactions.
Use the same InstallRoot and BinRoot that were used for installation.
#>
[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Workbench'),
    [string]$BinRoot = (Join-Path $env:USERPROFILE '.local\bin'),
    [string]$Generation,
    [switch]$Recover
)

# Dot-source only definitions; the installer's CLI guard prevents installation.
# Explicit arguments avoid replacing this script's parameter values in scope.
$rollbackParameters = @{} + $PSBoundParameters
$rollbackParameters['InstallRoot'] = $InstallRoot
$rollbackParameters['BinRoot'] = $BinRoot
. (Join-Path $PSScriptRoot 'install-workbench.ps1') -InstallRoot $InstallRoot -BinRoot $BinRoot

function Invoke-WbRollback {
    param([string]$InstallRoot, [string]$BinRoot, [string]$Generation, [switch]$Recover,
        [switch]$Fixture, [scriptblock]$TestHook)
    if ($Recover.IsPresent -eq [bool]$Generation) { throw 'Choose exactly one of -Generation or -Recover.' }
    $context = Get-WbContext $InstallRoot $BinRoot
    $locks = Open-WbLocks $context
    $transaction = $null
    try {
        New-WbDirectory $context.backups $context.install
        Repair-WbInterrupted $context
        if ($Recover) {
            Write-Host 'Interrupted Workbench activations have been restored; saved generations and databases were retained.'
            return
        }
        $null = Assert-WbOwnership $context -Fixture:$Fixture
        $saved = Get-WbSavedGeneration $context $Generation -Fixture:$Fixture
        $transaction = New-WbTransaction $context ('rollback-' + [guid]::NewGuid().ToString('N')) 'rollback' $Generation
        $null = Assert-WbOwnership $context -Transaction $transaction -Fixture:$Fixture
        $proof = Invoke-WbRuntimeChecks $context $saved.runtime $saved.manifest.node.path $saved.manifest.version `
            (Join-Path $transaction.root 'rollback-checks') (Join-Path $saved.runtime 'saved-config.json') -Rollback
        if ($proof.compatibility.configVersion -ne $saved.manifest.compatibility.configVersion -or
            $proof.compatibility.databaseSchema -ne $saved.manifest.compatibility.databaseSchema) {
            throw 'Saved generation compatibility proof changed.'
        }
        Set-WbDesired $context $transaction $saved $proof.config
        if ($TestHook) { & $TestHook 'before-activation' $context $transaction }
        $null = Get-WbSavedGeneration $context $Generation -Fixture:$Fixture
        Invoke-WbActivation $context $transaction $TestHook
        Write-Host "Workbench restored to generation: $Generation"
        Write-Host "Configuration restored: $($context.install)\config.json"
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
    $null = Invoke-WbRollback @rollbackParameters
}
