<#
.SYNOPSIS
  Trigon ERP - one-command Microsoft 365 setup for the business integration (SharePoint documents, Outlook, Teams).

.DESCRIPTION
  Run from an Administrator PowerShell on the admin / office PC. Signs in interactively (browser) to Microsoft Graph.
  DEFAULT IS A DRY RUN: discovery and validation only, no Microsoft 365 change. Add -Apply to make the changes.

  What -Apply does (only what is missing; re-running changes nothing):
   1. Entra app registration (found by M365_CLIENT_ID in C:\ERP\.env, or -ClientId): ADDS Microsoft Graph Sites.Selected
      (Application) and Mail.Send (Delegated). Existing permissions are kept. Grants admin consent for Sites.Selected.
   2. SharePoint: reuses the dedicated site (/sites/TrigonERP or the one in .env) after showing it, or creates a PRIVATE site
      "Trigon ERP Documents". Ensures exactly one document library "ERP Documents". No project folders (the ERP creates them).
   3. Grants the app WRITE on that one site only (Sites.Selected resource-specific permission) and reads it back.
   4. Verifies everything (PASS / FAIL report) and prints the .env lines (IDs only, never secrets).
  Never added: Sites.ReadWrite.All, Files.ReadWrite.All, Mail.ReadWrite, application Mail.Send, Teams Graph permissions.
  Never printed: client secret, tokens, encryption key, Teams webhook URL.
  Teams Workflows webhook: the one manual step (instructions are printed).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\ERP\scripts\setup-m365-production.ps1
  powershell -ExecutionPolicy Bypass -File C:\ERP\scripts\setup-m365-production.ps1 -Apply

.NOTES
  Required role: Global Administrator (or Privileged Role Administrator + Application Administrator + SharePoint Administrator
  + Groups Administrator). The first sign-in may ask to consent for "Microsoft Graph Command Line Tools" (Microsoft's own app).
  Exit codes: 0 PASS, 1 FAIL (see report), 2 stopped by an error, 3 cancelled.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Apply,
    [switch]$DryRun,
    [string]$TenantId,
    [string]$ClientId,
    [string]$EnvPath = 'C:\ERP\.env',
    [string]$StatePath = 'C:\ERP\data\m365-provisioning-state.json',
    [string]$SiteName = 'TrigonERP',
    [string]$SiteDisplayName = 'Trigon ERP Documents',
    [string]$LibraryName = 'ERP Documents',
    [string]$SharePointRoot = 'Trigon Civil Projects',
    [switch]$AssumeYes,
    [switch]$SkipSiteScan,
    [switch]$InstallMissingModules
)
$ErrorActionPreference = 'Stop'
$doApply = $Apply -and -not $DryRun -and -not $WhatIfPreference
if ($Apply -and -not $doApply) { Write-Host 'Both -Apply and -DryRun/-WhatIf given: running as a DRY RUN.' }

Import-Module (Join-Path $PSScriptRoot 'm365-provisioning.psm1') -Force

# --- tooling
Write-Host "PowerShell $($PSVersionTable.PSVersion)"
$mod = Get-Module -ListAvailable -Name Microsoft.Graph.Authentication | Sort-Object Version -Descending | Select-Object -First 1
if (-not $mod) {
    if ($InstallMissingModules) {
        Write-Host 'Installing Microsoft.Graph.Authentication for the current user (PowerShell Gallery)...'
        Install-Module Microsoft.Graph.Authentication -Scope CurrentUser -Force -AllowClobber
        $mod = Get-Module -ListAvailable -Name Microsoft.Graph.Authentication | Select-Object -First 1
    } else {
        Write-Host 'MISSING: the Microsoft Graph PowerShell module (Microsoft.Graph.Authentication).'
        Write-Host 'Install it once:  Install-Module Microsoft.Graph.Authentication -Scope CurrentUser'
        Write-Host 'or run this script again with -InstallMissingModules.'
        exit 2
    }
}
Write-Host "Module Microsoft.Graph.Authentication $($mod.Version): available"
Import-Module Microsoft.Graph.Authentication

# --- sign in (interactive; token kept in this PowerShell process only, not cached on disk)
if (-not $TenantId -and (Test-Path -LiteralPath $EnvPath)) { $TenantId = (Read-TrigonEnvSafe $EnvPath).Values['M365_TENANT_ID'] }
if ($doApply) {
    $scopes = @('Application.ReadWrite.All', 'AppRoleAssignment.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All', 'Directory.Read.All', 'Sites.FullControl.All', 'Group.ReadWrite.All')
} else {
    $scopes = @('Application.Read.All', 'Directory.Read.All', 'Sites.FullControl.All', 'Group.Read.All')
}
Write-Host ('Signing in to Microsoft Graph (a browser window opens) with administrator scopes: ' + ($scopes -join ', '))
$cp = @{ Scopes = $scopes; ContextScope = 'Process'; NoWelcome = $true }
if ($TenantId) { $cp.TenantId = $TenantId }
Connect-MgGraph @cp | Out-Null
$ctx = Get-MgContext
if (-not $ctx) { Write-Host 'Sign-in failed.'; exit 2 }
if ($TenantId -and $ctx.TenantId -ne $TenantId) { Write-Host "Signed in to tenant $($ctx.TenantId), expected $TenantId. Stopping."; Disconnect-MgGraph | Out-Null; exit 2 }

$cfg = @{
    Apply = $doApply; ClientId = $ClientId; EnvPath = $EnvPath; StatePath = $StatePath; SiteName = $SiteName
    SiteDisplayName = $SiteDisplayName; LibraryName = $LibraryName; SharePointRoot = $SharePointRoot; AssumeYes = [bool]$AssumeYes; SkipSiteScan = [bool]$SkipSiteScan
}
$code = 2
try {
    $r = Invoke-TrigonM365Setup -Cfg $cfg
    $code = $r.ExitCode
} catch {
    Write-Host ('STOPPED: ' + (Protect-TrigonText ([string]$_.Exception.Message)))
    Write-Host 'No change was made by this run unless "done:" lines appear above. Re-run is safe; see the state file for what exists.'
} finally {
    try { Disconnect-MgGraph | Out-Null } catch { }
}
exit $code
