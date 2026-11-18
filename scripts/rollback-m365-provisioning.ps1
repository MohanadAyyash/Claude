<#
.SYNOPSIS
  Trigon ERP - undo the Microsoft 365 provisioning done by setup-m365-production.ps1.

.DESCRIPTION
  Removes ONLY what the setup recorded as created by it in the state file (C:\ERP\data\m365-provisioning-state.json):
   - the app's write grant on the Trigon site (or the old read grant restored if the setup had upgraded it);
   - the admin consent for Sites.Selected;
   - Mail.Send from the tenant-wide delegated consent (only if the setup added it);
   - the Sites.Selected / Mail.Send entries the setup added to the app registration.
  Never deletes: the production Entra app registration, existing SharePoint content, uploaded ERP documents.
  The library / site the setup created are removed only with -RemoveCreatedSharePoint, only when EMPTY, and only after
  typing the confirmation (DELETE <name>). DEFAULT IS A DRY RUN; add -Apply to remove.
  Before an Apply: set M365_SHAREPOINT_ENABLED=0 and M365_OUTLOOK_ENABLED=0 in C:\ERP\.env and restart the ERP.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\ERP\scripts\rollback-m365-provisioning.ps1
  powershell -ExecutionPolicy Bypass -File C:\ERP\scripts\rollback-m365-provisioning.ps1 -Apply
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Apply,
    [switch]$DryRun,
    [string]$TenantId,
    [string]$StatePath = 'C:\ERP\data\m365-provisioning-state.json',
    [switch]$RemoveCreatedSharePoint
)
$ErrorActionPreference = 'Stop'
$doApply = $Apply -and -not $DryRun -and -not $WhatIfPreference
Import-Module (Join-Path $PSScriptRoot 'm365-provisioning.psm1') -Force
if (-not (Test-Path -LiteralPath $StatePath)) { Write-Host "No provisioning state at ${StatePath}: nothing to roll back."; exit 0 }
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) { Write-Host 'Install first: Install-Module Microsoft.Graph.Authentication -Scope CurrentUser'; exit 2 }
Import-Module Microsoft.Graph.Authentication
$state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
if (-not $TenantId) { $TenantId = $state.tenantId }
if ($doApply) { $scopes = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All', 'Directory.Read.All', 'Sites.FullControl.All', 'Group.ReadWrite.All') }
else { $scopes = @('Application.Read.All', 'Directory.Read.All', 'Sites.FullControl.All', 'Group.Read.All') }
$cp = @{ Scopes = $scopes; ContextScope = 'Process'; NoWelcome = $true }
if ($TenantId) { $cp.TenantId = $TenantId }
Connect-MgGraph @cp | Out-Null
$code = 2
try {
    $r = Invoke-TrigonM365Rollback -Cfg @{ Apply = $doApply; StatePath = $StatePath; RemoveCreatedSharePoint = [bool]$RemoveCreatedSharePoint }
    $code = $r.ExitCode
} catch {
    Write-Host ('STOPPED: ' + (Protect-TrigonText ([string]$_.Exception.Message)))
} finally {
    try { Disconnect-MgGraph | Out-Null } catch { }
}
exit $code
