# Tests for scripts/m365-provisioning.psm1 (setup + rollback) against an in-memory mock of Microsoft Graph.
#   pwsh -NoProfile -File scripts/tests/m365-provisioning.tests.ps1      (run by test-m365-provisioning.js in npm test)
# Fake tenant, fake IDs and fake secrets only; no network; nothing is signed in.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\m365-provisioning.psm1') -Force

$GRAPH = '00000003-0000-0000-c000-000000000000'
$CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
$TENANT = '11111111-2222-3333-4444-555555555555'
$R_SITES_SELECTED = '883ea226-0bf2-4a8f-9f9d-92c9162a727d'; $R_SITES_RW_ALL = '9492366f-7969-46a4-8d15-ed1a20078fff'; $R_MAIL_SEND_APP = 'b633e1c5-b582-4048-a93e-9f11b44c7e96'
$S_MAIL_SEND = 'e383f46e-2787-4529-855e-0e479a3ffac0'; $S_USER_READ = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
$S_OPENID = '37f7f235-527c-4136-accd-4a02d197296e'; $S_PROFILE = '14dad69e-099b-42c9-810b-d002981feec1'; $S_EMAIL = '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0'; $S_OFFLINE = '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
$FAKE_SECRET = 'FAKE-client-secret-value-0123456789'; $FAKE_KEY = 'RkFLRS1lbmNyeXB0aW9uLWtleS1mb3ItdGVzdHMtMTIzNDU='; $FAKE_SIG = 'FAKEwebhookSIGNATURE987654'
$FAKE_WEBHOOK = "https://prod-00.uaenorth.logic.azure.com:443/workflows/abc/triggers/manual/paths/invoke?api-version=2016-06-01&sp=%2Ftriggers&sv=1.0&sig=$FAKE_SIG"
$FAKE_BEARER = 'eyJhbGciOiJSUzI1NiJ9.eyJmYWtlIjoidG9rZW4ifQ.ZmFrZXNpZ25hdHVyZQ'

$script:pass = 0; $script:fail = 0; $script:failed = @()
function Assert { param([bool]$Cond, [string]$Msg) if ($Cond) { $script:pass++ } else { $script:fail++; $script:failed += $Msg; Write-Host "  FAIL: $Msg" } }
function Test-Case { param([string]$Name, [scriptblock]$Body) Write-Host "- $Name"; try { & $Body } catch { $script:fail++; $script:failed += "$Name threw: $($_.Exception.Message) $($_.ScriptStackTrace)"; Write-Host "  FAIL (threw): $($_.Exception.Message)"; Write-Host $_.ScriptStackTrace } }

function New-Guid2 { return [guid]::NewGuid().ToString() }
function New-Tenant {
    param([switch]$WithSite, [switch]$WithLibrary, [string]$GrantRoles = '', [switch]$Public, [switch]$BroadSites, [switch]$AppMailSend, [switch]$NoAdminConsent, [switch]$Configured)
    $t = @{
        calls = New-Object System.Collections.ArrayList; failOn = $null; siteDelay = 0
        app = @{ id = 'app-object-1'; appId = $CLIENT; displayName = 'Trigon ERP'
            requiredResourceAccess = @(@{ resourceAppId = $GRAPH; resourceAccess = @(
                        @{ id = $S_OPENID; type = 'Scope' }, @{ id = $S_PROFILE; type = 'Scope' }, @{ id = $S_EMAIL; type = 'Scope' }, @{ id = $S_OFFLINE; type = 'Scope' }, @{ id = $S_USER_READ; type = 'Scope' }) },
                @{ resourceAppId = '00000002-0000-0000-c000-000000000000'; resourceAccess = @(@{ id = '311a71cc-e848-46a1-bdf8-97ff7156d8e6'; type = 'Scope' }) })
            passwordCredentials = @(@{ hint = 'FAK'; secretText = $FAKE_SECRET }) }
        graphSp = @{ id = 'graph-sp'; appRoles = @(@{ id = $R_SITES_SELECTED; value = 'Sites.Selected' }, @{ id = $R_SITES_RW_ALL; value = 'Sites.ReadWrite.All' }, @{ id = $R_MAIL_SEND_APP; value = 'Mail.Send' })
            oauth2PermissionScopes = @(@{ id = $S_MAIL_SEND; value = 'Mail.Send' }, @{ id = $S_USER_READ; value = 'User.Read' }, @{ id = $S_OPENID; value = 'openid' }, @{ id = $S_PROFILE; value = 'profile' }, @{ id = $S_EMAIL; value = 'email' }, @{ id = $S_OFFLINE; value = 'offline_access' }) }
        appSp = @{ id = 'app-sp-1'; appId = $CLIENT; displayName = 'Trigon ERP' }
        assignments = New-Object System.Collections.ArrayList
        grants = New-Object System.Collections.ArrayList
        sites = New-Object System.Collections.ArrayList
        groups = New-Object System.Collections.ArrayList
        n = 0
    }
    if (-not $NoAdminConsent) { [void]$t.grants.Add(@{ id = 'grant-all-1'; clientId = 'app-sp-1'; consentType = 'AllPrincipals'; resourceId = 'graph-sp'; scope = 'openid profile email offline_access User.Read' }) }
    [void]$t.sites.Add((New-SiteObj 'contoso.sharepoint.com,aaaaaaaa-0000-0000-0000-000000000001,bbbbbbbb-0000-0000-0000-000000000001' 'Communication' 'Company Intranet'))
    if ($WithSite) {
        $s = New-SiteObj 'contoso.sharepoint.com,0f0f0f0f-1111-2222-3333-444444444444,5e5e5e5e-1111-2222-3333-444444444444' 'TrigonERP' 'Trigon ERP Documents'
        $vis = 'Private'; if ($Public) { $vis = 'Public' }
        [void]$t.groups.Add(@{ id = 'group-existing'; displayName = 'Trigon ERP Documents'; mailNickname = 'TrigonERP'; visibility = $vis; siteId = $s.id })
        if ($WithLibrary) { [void]$s.lists.Add(@{ id = 'list-erp'; displayName = 'ERP Documents'; template = 'documentLibrary'; driveId = 'b!ExistingDrive_ERP-1'; items = 0 }) }
        if ($GrantRoles) { [void]$s.permissions.Add(@{ id = 'perm-existing'; roles = @($GrantRoles.Split(',')); app = $CLIENT }) }
        [void]$t.sites.Add($s)
    }
    if ($BroadSites) { $t.app.requiredResourceAccess[0].resourceAccess += @{ id = $R_SITES_RW_ALL; type = 'Role' }; [void]$t.assignments.Add(@{ id = 'asg-broad'; principalId = 'app-sp-1'; resourceId = 'graph-sp'; appRoleId = $R_SITES_RW_ALL }) }
    if ($AppMailSend) { $t.app.requiredResourceAccess[0].resourceAccess += @{ id = $R_MAIL_SEND_APP; type = 'Role' } }
    if ($Configured) {
        $t.app.requiredResourceAccess[0].resourceAccess += @{ id = $R_SITES_SELECTED; type = 'Role' }
        $t.app.requiredResourceAccess[0].resourceAccess += @{ id = $S_MAIL_SEND; type = 'Scope' }
        [void]$t.assignments.Add(@{ id = 'asg-existing'; principalId = 'app-sp-1'; resourceId = 'graph-sp'; appRoleId = $R_SITES_SELECTED })
        $t.grants[0].scope += ' Mail.Send'
    }
    $global:T = $t
    return $t
}
function New-SiteObj { param($Id, $Name, $Display) $s = @{ id = $Id; name = $Name; displayName = $Display; webUrl = "https://contoso.sharepoint.com/sites/$Name"; lists = New-Object System.Collections.ArrayList; permissions = New-Object System.Collections.ArrayList }; [void]$s.lists.Add(@{ id = "list-docs-$Name"; displayName = 'Documents'; template = 'documentLibrary'; driveId = "b!DefaultDrive_$Name"; items = 0 }); return $s }
function J { param($o) if ($null -eq $o) { return $null }; return (ConvertTo-Json -InputObject $o -Depth 20 | ConvertFrom-Json) }
function NotFound { throw 'Response status code does not indicate success: 404 (Not Found) itemNotFound' }
function SiteOut { param($s) return @{ id = $s.id; name = $s.name; displayName = $s.displayName; webUrl = $s.webUrl } }
function DriveOut { param($s, $l) return @{ id = $l.driveId; name = $l.displayName; webUrl = $s.webUrl + '/' + ($l.displayName -replace ' ', '%20') } }
function Find-Site { param($id) return @($global:T.sites | Where-Object { $_.id -eq $id })[0] }

$Mock = {
    param($Method, $Uri, $Body)
    $t = $global:T
    [void]$t.calls.Add("$Method $Uri")
    if ($t.failOn -and ("$Method $Uri") -match $t.failOn) { throw "Response status code does not indicate success: 500 (Internal Server Error). Authorization: Bearer $FAKE_BEARER" }
    $path = $Uri; $qs = ''
    if ($Uri.Contains('?')) { $path = $Uri.Substring(0, $Uri.IndexOf('?')); $qs = $Uri.Substring($Uri.IndexOf('?') + 1) }
    $q = @{}; foreach ($kv in $qs.Split('&')) { if ($kv -match '^([^=]+)=(.*)$') { $q[$Matches[1]] = [uri]::UnescapeDataString($Matches[2]) } }
    $f = $q['$filter']
    $m = $null
    switch -regex ("$Method $path") {
        '^GET /organization$' { return J @{ value = @(@{ id = $TENANT; displayName = 'Contoso Test Tenant' }) } }
        '^GET /me$' { return J @{ id = 'admin-user-1'; userPrincipalName = 'admin@contoso.onmicrosoft.com'; displayName = 'Test Admin' } }
        '^GET /applications$' {
            if ($f -match "appId eq '([^']+)'") { if ($Matches[1] -eq $t.app.appId) { return J @{ value = @(@{ id = $t.app.id; appId = $t.app.appId; displayName = $t.app.displayName; requiredResourceAccess = $t.app.requiredResourceAccess }) } }; return J @{ value = @() } }
            if ($f -match 'startswith') { return J @{ value = @(@{ id = $t.app.id; appId = $t.app.appId; displayName = $t.app.displayName; requiredResourceAccess = $t.app.requiredResourceAccess }) } }
        }
        '^PATCH /applications/app-object-1$' { $t.app.requiredResourceAccess = @($Body.requiredResourceAccess); return $null }
        '^GET /servicePrincipals$' {
            if ($f -match [regex]::Escape($GRAPH)) { return J @{ value = @($t.graphSp) } }
            if ($f -match [regex]::Escape($CLIENT) -and $t.appSp) { return J @{ value = @($t.appSp) } }
            return J @{ value = @() }
        }
        '^POST /servicePrincipals$' { $t.appSp = @{ id = 'app-sp-new'; appId = $Body.appId; displayName = 'Trigon ERP' }; return J $t.appSp }
        '^GET /servicePrincipals/([^/]+)/appRoleAssignments$' { return J @{ value = @($t.assignments | Where-Object { $_.principalId -eq $Matches[1] }) } }
        '^POST /servicePrincipals/([^/]+)/appRoleAssignments$' { $a = @{ id = 'asg-' + (New-Guid2); principalId = $Body.principalId; resourceId = $Body.resourceId; appRoleId = $Body.appRoleId }; [void]$t.assignments.Add($a); return J $a }
        '^DELETE /servicePrincipals/([^/]+)/appRoleAssignments/(.+)$' { $id = $Matches[2]; $x = @($t.assignments | Where-Object { $_.id -eq $id }); if (-not $x.Count) { NotFound }; $t.assignments.Remove($x[0]); return $null }
        '^GET /oauth2PermissionGrants$' { return J @{ value = @($t.grants) } }
        '^GET /oauth2PermissionGrants/(.+)$' { $id = $Matches[1]; $g = @($t.grants | Where-Object { $_.id -eq $id })[0]; if (-not $g) { NotFound }; return J $g }
        '^PATCH /oauth2PermissionGrants/(.+)$' { $id = $Matches[1]; $g = @($t.grants | Where-Object { $_.id -eq $id })[0]; $g.scope = $Body.scope; return $null }
        '^GET /sites/root$' { return J @{ id = 'root'; webUrl = 'https://contoso.sharepoint.com'; siteCollection = @{ hostname = 'contoso.sharepoint.com' } } }
        '^GET /sites$' {
            $s = $q['search']
            $all = @($t.sites | Where-Object { $s -eq '*' -or $_.displayName -match [regex]::Escape($s) -or $_.name -match [regex]::Escape($s) })
            return J @{ value = @($all | ForEach-Object { SiteOut $_ }) }
        }
        '^GET /sites/contoso\.sharepoint\.com:/sites/(.+)$' { $n = $Matches[1]; $s = @($t.sites | Where-Object { $_.name -eq $n })[0]; if (-not $s) { NotFound }; return J (SiteOut $s) }
        '^GET /sites/([^/]+)/lists$' { $s = Find-Site $Matches[1]; return J @{ value = @($s.lists | ForEach-Object { @{ id = $_.id; displayName = $_.displayName; list = @{ template = $_.template } } }) } }
        '^POST /sites/([^/]+)/lists$' {
            $s = Find-Site $Matches[1]; $dn = $Body.displayName
            if (@($s.lists | Where-Object { $_.displayName -eq $dn }).Count) { $i = 1; while (@($s.lists | Where-Object { $_.displayName -eq "$($Body.displayName)$i" }).Count) { $i++ }; $dn = "$($Body.displayName)$i" }
            $l = @{ id = 'list-' + (New-Guid2); displayName = $dn; template = $Body.list.template; driveId = 'b!NewDrive_' + ($t.n++); items = 0 }; [void]$s.lists.Add($l); return J @{ id = $l.id; displayName = $l.displayName }
        }
        '^DELETE /sites/([^/]+)/lists/(.+)$' { $s = Find-Site $Matches[1]; $lid = $Matches[2]; $l = @($s.lists | Where-Object { $_.id -eq $lid })[0]; $s.lists.Remove($l); return $null }
        '^GET /sites/([^/]+)/lists/([^/]+)/drive$' { $s = Find-Site $Matches[1]; $lid = $Matches[2]; $l = @($s.lists | Where-Object { $_.id -eq $lid })[0]; return J (DriveOut $s $l) }
        '^GET /sites/([^/]+)/drives$' { $s = Find-Site $Matches[1]; return J @{ value = @($s.lists | ForEach-Object { @{ id = $_.driveId } }) } }
        '^GET /sites/([^/]+)/drives/(.+)$' { $s = Find-Site $Matches[1]; $did = $Matches[2]; $l = @($s.lists | Where-Object { $_.driveId -eq $did })[0]; if (-not $l) { NotFound }; return J @{ id = $l.driveId } }
        '^GET /drives/([^/]+)/root/children$' { $did = $Matches[1]; foreach ($s in $t.sites) { foreach ($l in $s.lists) { if ($l.driveId -eq $did) { $v = @(); for ($i = 0; $i -lt [Math]::Min(1, $l.items); $i++) { $v += @{ id = "item$i" } }; return J @{ value = $v } } } }; NotFound }
        '^GET /sites/([^/]+)/permissions$' { $s = Find-Site $Matches[1]; return J @{ value = @($s.permissions | ForEach-Object { @{ id = $_.id; grantedToIdentitiesV2 = @(@{ application = @{ id = $_.app; displayName = 'x' } }) } }) } }
        '^GET /sites/([^/]+)/permissions/(.+)$' { $s = Find-Site $Matches[1]; $pid2 = $Matches[2]; $p = @($s.permissions | Where-Object { $_.id -eq $pid2 })[0]; if (-not $p) { NotFound }; return J @{ id = $p.id; roles = $p.roles; grantedToIdentitiesV2 = @(@{ application = @{ id = $p.app } }) } }
        '^POST /sites/([^/]+)/permissions$' { $s = Find-Site $Matches[1]; $p = @{ id = 'perm-' + (New-Guid2); roles = @($Body.roles); app = $Body.grantedToIdentities[0].application.id }; [void]$s.permissions.Add($p); return J @{ id = $p.id; roles = $p.roles } }
        '^PATCH /sites/([^/]+)/permissions/(.+)$' { $s = Find-Site $Matches[1]; $pid2 = $Matches[2]; $p = @($s.permissions | Where-Object { $_.id -eq $pid2 })[0]; $p.roles = @($Body.roles); return J @{ id = $p.id; roles = $p.roles } }
        '^DELETE /sites/([^/]+)/permissions/(.+)$' { $s = Find-Site $Matches[1]; $pid2 = $Matches[2]; $p = @($s.permissions | Where-Object { $_.id -eq $pid2 })[0]; $s.permissions.Remove($p); return $null }
        '^GET /sites/([^/:]+)$' { $s = Find-Site $Matches[1]; if (-not $s) { NotFound }; return J (SiteOut $s) }
        '^GET /groups$' { $n = ''; if ($f -match "mailNickname eq '([^']+)'") { $n = $Matches[1] }; return J @{ value = @($t.groups | Where-Object { $_.mailNickname -eq $n } | ForEach-Object { @{ id = $_.id; displayName = $_.displayName; visibility = $_.visibility; mailNickname = $_.mailNickname } }) } }
        '^POST /groups$' {
            $gid = 'group-' + (New-Guid2)
            $s = New-SiteObj ('contoso.sharepoint.com,' + (New-Guid2) + ',' + (New-Guid2)) $Body.mailNickname $Body.displayName
            [void]$t.groups.Add(@{ id = $gid; displayName = $Body.displayName; mailNickname = $Body.mailNickname; visibility = $Body.visibility; siteId = $s.id; pendingSite = $s; owners = $Body.'owners@odata.bind' })
            return J @{ id = $gid }
        }
        '^GET /groups/([^/]+)/sites/root$' {
            $gid = $Matches[1]; $g = @($t.groups | Where-Object { $_.id -eq $gid })[0]; if (-not $g) { NotFound }
            if ($g.pendingSite) { if ($t.siteDelay -gt 0) { $t.siteDelay--; NotFound }; [void]$t.sites.Add($g.pendingSite); $g.pendingSite = $null }
            return J (SiteOut (Find-Site $g.siteId))
        }
        '^DELETE /groups/(.+)$' { $gid = $Matches[1]; $g = @($t.groups | Where-Object { $_.id -eq $gid })[0]; $t.groups.Remove($g); $s = Find-Site $g.siteId; if ($s) { $t.sites.Remove($s) }; return $null }
    }
    throw "Mock: unhandled $Method $Uri"
}

$script:lines = New-Object System.Collections.ArrayList
Set-TrigonProvisioningHooks -Invoker $Mock -Out { param($l) [void]$script:lines.Add($l) } -Sleep { param($s) } -Prompt { param($q) 'APPLY' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('trigon-prov-' + [guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $tmp)
$envPath = Join-Path $tmp '.env'
[IO.File]::WriteAllLines($envPath, @("M365_ENABLED=1", "M365_TENANT_ID=$TENANT", "M365_CLIENT_ID=$CLIENT", "M365_CLIENT_SECRET=$FAKE_SECRET", "M365_ENCRYPTION_KEY=$FAKE_KEY", "M365_TEAMS_WEBHOOK_URL=$FAKE_WEBHOOK"))
function Cfg { param([switch]$Apply, [string]$State, [switch]$NoEnv) $s = $State; if (-not $s) { $s = Join-Path $tmp ('state-' + [guid]::NewGuid().ToString('N') + '.json') }; $e = $envPath; if ($NoEnv) { $e = Join-Path $tmp 'missing.env' }; return @{ Apply = [bool]$Apply; EnvPath = $e; StatePath = $s; AssumeYes = $true; ClientId = $(if ($NoEnv) { $CLIENT } else { $null }) } }
function Mutations { return @($global:T.calls | Where-Object { $_ -notmatch '^GET ' }) }
function Check { param($r, $name) return @($r.Checks | Where-Object { $_.Name -like "$name*" })[0] }
function Out-Text { return ($script:lines -join "`n") }

# ------------------------------------------------------------------------------------------------ tests
Test-Case 'dry run on an empty tenant: plans site, library, grant, permissions; makes no mutation' {
    New-Tenant | Out-Null; $script:lines.Clear()
    $r = Invoke-TrigonM365Setup (Cfg)
    $keys = @($r.Plan | ForEach-Object { $_.Key })
    foreach ($k in 'CreateSite', 'CreateLibrary', 'CreateSiteGrant', 'AddRequired:Sites.Selected', 'AddRequired:Mail.Send', 'GrantAppRole:Sites.Selected', 'ExtendConsent:Mail.Send') { Assert ($keys -contains $k) "plan has $k" }
    Assert ((Mutations).Count -eq 0) 'dry run: no POST/PATCH/DELETE reached Graph'
    Assert (@(Get-TrigonWrites).Count -eq 0) 'dry run: no write recorded'
    Assert ($r.ExitCode -eq 0) "dry run exit 0 (got $($r.ExitCode))"
    Assert ((Out-Text) -match 'No change was made') 'dry run says no change was made'
    Assert ((Out-Text) -match '/sites/TrigonERP') 'dry run shows the clean URL'
    Assert (@($r.Checks | Where-Object { $_.Status -eq 'TODO' }).Count -ge 3) 'dry run marks pending items TODO'
}

Test-Case 'dry-run guard: a mutating call is refused even if code tried it' {
    New-Tenant | Out-Null
    $mod = Get-Module m365-provisioning
    $err = $null
    try { & $mod { $script:Apply = $false; Invoke-TG POST '/groups' @{ x = 1 } } } catch { $err = $_.Exception.Message }
    Assert ($err -match 'dry-run') 'Invoke-TG refuses POST in dry run'
    Assert ((Mutations).Count -eq 0) 'nothing reached the mock'
}

Test-Case 'apply on an empty tenant: private site, one library, write grant, only Sites.Selected + Mail.Send; PASS' {
    New-Tenant | Out-Null; $script:lines.Clear()
    $c = Cfg -Apply
    $global:T.siteDelay = 2
    $r = Invoke-TrigonM365Setup $c
    Assert ($r.Overall -eq 'PASS') "overall PASS (got $($r.Overall)): $((@($r.Checks | Where-Object { $_.Status -eq 'FAIL' }) | ForEach-Object { $_.Name + ': ' + $_.Detail }) -join ' | ')"
    Assert ($r.ExitCode -eq 0) 'exit 0'
    $g = @($global:T.groups)[0]
    Assert ($g.visibility -eq 'Private') 'group created Private'
    Assert ($g.mailNickname -eq 'TrigonERP') 'URL /sites/TrigonERP'
    Assert (@($g.owners)[0] -match 'admin-user-1$') 'owner = signed-in admin only'
    $site = Find-Site $g.siteId
    Assert (@($site.lists | Where-Object { $_.displayName -like 'ERP Documents*' }).Count -eq 1) 'exactly one ERP Documents library'
    Assert (@($site.permissions).Count -eq 1 -and @($site.permissions)[0].roles -contains 'write' -and @($site.permissions)[0].app -eq $CLIENT) 'one write grant for the app on that site'
    Assert (@($global:T.sites | Where-Object { $_.id -ne $site.id } | ForEach-Object { $_.permissions } | Where-Object { $_ }).Count -eq 0) 'no grant on any other site'
    $roles = @($global:T.app.requiredResourceAccess | Where-Object { $_.resourceAppId -eq $GRAPH } | ForEach-Object { $_.resourceAccess } | Where-Object { $_.type -eq 'Role' } | ForEach-Object { $_.id })
    Assert ($roles.Count -eq 1 -and $roles[0] -eq $R_SITES_SELECTED) 'the only application permission is Sites.Selected'
    $scopes = @($global:T.app.requiredResourceAccess | Where-Object { $_.resourceAppId -eq $GRAPH } | ForEach-Object { $_.resourceAccess } | Where-Object { $_.type -eq 'Scope' } | ForEach-Object { $_.id })
    foreach ($s in $S_OPENID, $S_PROFILE, $S_EMAIL, $S_OFFLINE, $S_USER_READ, $S_MAIL_SEND) { Assert ($scopes -contains $s) "delegated $s present" }
    Assert ($scopes.Count -eq 6) 'no other delegated permission added'
    Assert (@($global:T.app.requiredResourceAccess | Where-Object { $_.resourceAppId -eq '00000002-0000-0000-c000-000000000000' }).Count -eq 1) 'other API permissions kept'
    Assert (@($global:T.assignments | Where-Object { $_.appRoleId -eq $R_SITES_SELECTED }).Count -eq 1) 'Sites.Selected admin-consented once'
    Assert (@($global:T.assignments | Where-Object { $_.appRoleId -ne $R_SITES_SELECTED }).Count -eq 0) 'no other application consent'
    Assert ($global:T.grants[0].scope -match '\bMail\.Send\b') 'Mail.Send added to tenant-wide delegated consent'
    $st = Get-Content -Raw $c.StatePath | ConvertFrom-Json
    Assert ($st.created.site.groupId -and $st.created.library.driveId -and $st.created.siteGrant.permissionId -and $st.created.appRoleAssignment.id -and @($st.created.requiredAccess).Count -eq 2) 'state records everything created'
    $txt = Out-Text
    Assert ($txt -match "M365_SHAREPOINT_SITE_ID=$([regex]::Escape($site.id))") '.env block has the site id'
    Assert ($txt -match 'M365_SHAREPOINT_DRIVE_ID=b!NewDrive_') '.env block has the drive id'
    Assert (Test-TrigonSiteId $site.id) 'site id passes the m365graph rule'
    Assert ($txt -match 'Post to a channel when a webhook request is received') 'Teams manual step explained'
    Assert ((Check $r 'Re-running changes nothing').Status -eq 'PASS') 'post-apply idempotency check PASS'

    # rerun: nothing changes
    $before = (Mutations).Count; $script:lines.Clear()
    $r2 = Invoke-TrigonM365Setup $c
    Assert ((Mutations).Count -eq $before) "rerun made no mutation (made $((Mutations).Count - $before))"
    Assert ($r2.Overall -eq 'PASS') 'rerun PASS'
    Assert (@($global:T.groups).Count -eq 1) 'no duplicate site/group'
    Assert (@($site.lists | Where-Object { $_.displayName -like 'ERP Documents*' }).Count -eq 1) 'no ERP Documents1'
    Assert (@($site.permissions).Count -eq 1) 'no duplicate grant'
    $st2 = Get-Content -Raw $c.StatePath | ConvertFrom-Json
    Assert ($st2.created.site.groupId -eq $st.created.site.groupId) 'state keeps the created markers on rerun'
}

Test-Case 'existing site reused (shown first), library created once, rerun idempotent' {
    New-Tenant -WithSite -Configured | Out-Null; $script:lines.Clear()
    $c = Cfg -Apply
    $script:asked = 0
    Set-TrigonProvisioningHooks -Prompt { param($q) $script:asked++; 'APPLY' }
    $c.AssumeYes = $false
    $r = Invoke-TrigonM365Setup $c
    Assert ($script:asked -eq 1) 'asked for confirmation once before changes'
    $txt = Out-Text
    Assert ($txt.IndexOf('Reuse existing site') -ge 0 -and $txt.IndexOf('Reuse existing site') -lt $txt.IndexOf('Applying')) 'reuse shown before applying'
    Assert (@($global:T.calls | Where-Object { $_ -match '^POST /groups' }).Count -eq 0) 'no site created'
    $s = @($global:T.sites | Where-Object { $_.name -eq 'TrigonERP' })[0]
    Assert (@($s.lists | Where-Object { $_.displayName -like 'ERP Documents*' }).Count -eq 1) 'library created once'
    Assert ($r.Overall -eq 'PASS') "PASS (got $($r.Overall))"
    $n = (Mutations).Count
    [void](Invoke-TrigonM365Setup $c)
    Assert ((Mutations).Count -eq $n) 'library: rerun creates nothing'
    Set-TrigonProvisioningHooks -Prompt { param($q) 'APPLY' }
}

Test-Case 'confirmation refused: nothing changes' {
    New-Tenant | Out-Null
    Set-TrigonProvisioningHooks -Prompt { param($q) 'no' }
    $c = Cfg -Apply; $c.AssumeYes = $false
    $r = Invoke-TrigonM365Setup $c
    Assert ($r.ExitCode -eq 3) 'cancelled exit 3'
    Assert ((Mutations).Count -eq 0) 'no mutation after cancel'
    Set-TrigonProvisioningHooks -Prompt { param($q) 'APPLY' }
}

Test-Case 'existing write grant reused; existing read grant upgraded (PATCH, not a second grant)' {
    New-Tenant -WithSite -WithLibrary -GrantRoles 'write' -Configured | Out-Null; $script:lines.Clear()
    $r = Invoke-TrigonM365Setup (Cfg -Apply)
    Assert ((Mutations).Count -eq 0) 'fully configured tenant: no mutation'
    Assert ($r.Overall -eq 'PASS') 'PASS'
    Assert ((Check $r 'App has write').Status -eq 'PASS') 'write grant check PASS'
    New-Tenant -WithSite -WithLibrary -GrantRoles 'read' -Configured | Out-Null
    $c = Cfg -Apply
    $r = Invoke-TrigonM365Setup $c
    $s = @($global:T.sites | Where-Object { $_.name -eq 'TrigonERP' })[0]
    Assert (@($s.permissions).Count -eq 1 -and @($s.permissions)[0].roles -contains 'write') 'read grant upgraded in place'
    Assert (@($global:T.calls | Where-Object { $_ -match '^POST /sites/.*/permissions' }).Count -eq 0) 'no new grant POSTed'
    $st = Get-Content -Raw $c.StatePath | ConvertFrom-Json
    Assert ($st.created.siteGrant.action -eq 'upgraded' -and @($st.created.siteGrant.previousRoles) -contains 'read') 'state remembers the previous role'
}

Test-Case 'existing ERP Documents1 duplicate is reported and nothing else is created next to it' {
    New-Tenant -WithSite -WithLibrary -GrantRoles 'write' -Configured | Out-Null; $script:lines.Clear()
    $s = @($global:T.sites | Where-Object { $_.name -eq 'TrigonERP' })[0]
    [void]$s.lists.Add(@{ id = 'list-dupe'; displayName = 'ERP Documents1'; template = 'documentLibrary'; driveId = 'b!Dupe'; items = 0 })
    $r = Invoke-TrigonM365Setup (Cfg -Apply)
    Assert ((Mutations).Count -eq 0) 'no mutation'
    Assert ((Check $r "Library 'ERP Documents'").Status -eq 'WARN') 'duplicate library reported as WARN'
    Assert ((Out-Text) -match 'ERP Documents1') 'duplicate named in the report'
}

Test-Case 'accidental Sites.ReadWrite.All (and application Mail.Send) is a FAIL, never added by the tool' {
    New-Tenant -WithSite -WithLibrary -GrantRoles 'write' -Configured -BroadSites -AppMailSend | Out-Null; $script:lines.Clear()
    $r = Invoke-TrigonM365Setup (Cfg)
    Assert ((Check $r 'No tenant-wide SharePoint').Status -eq 'FAIL') 'Sites.ReadWrite.All -> FAIL'
    Assert ((Check $r 'No application-wide mail').Status -eq 'FAIL') 'application Mail.Send -> FAIL'
    Assert ($r.Overall -eq 'FAIL' -and $r.ExitCode -eq 1) 'overall FAIL, exit 1'
    Assert ((Out-Text) -match 'FOUND Sites\.ReadWrite\.All') 'named in the output'
    New-Tenant | Out-Null
    $r = Invoke-TrigonM365Setup (Cfg -Apply)
    $all = @($global:T.app.requiredResourceAccess | ForEach-Object { $_.resourceAccess } | ForEach-Object { $_.id })
    Assert ($all -notcontains $R_SITES_RW_ALL -and $all -notcontains $R_MAIL_SEND_APP) 'apply never adds broad permissions'
}

Test-Case 'public site is a FAIL (organization-wide access)' {
    New-Tenant -WithSite -WithLibrary -GrantRoles 'write' -Configured -Public | Out-Null
    $r = Invoke-TrigonM365Setup (Cfg)
    Assert ((Check $r 'Site is private').Status -eq 'FAIL') 'public group site -> FAIL'
}

Test-Case 'grant on another site is detected' {
    New-Tenant -WithSite -WithLibrary -GrantRoles 'write' -Configured | Out-Null
    [void]@($global:T.sites)[0].permissions.Add(@{ id = 'perm-other'; roles = @('write'); app = $CLIENT })
    $r = Invoke-TrigonM365Setup (Cfg)
    Assert ((Check $r 'App has no grant on any other site').Status -eq 'FAIL') 'grant on the intranet site -> FAIL'
}

Test-Case 'Mail.Send without tenant-wide consent: delegated added, users consent on reconnect, no AllPrincipals grant created' {
    New-Tenant -NoAdminConsent | Out-Null; $script:lines.Clear()
    $r = Invoke-TrigonM365Setup (Cfg -Apply)
    Assert (@($global:T.grants).Count -eq 0) 'no tenant-wide grant created'
    Assert ((Check $r 'Mail.Send (Delegated)').Status -eq 'PASS') 'Mail.Send delegated PASS'
    Assert ((Out-Text) -match 'Disconnect, then Connect') 'reconnect procedure explained'
}

Test-Case 'secrets are never printed (env secrets, webhook signature, bearer tokens in errors)' {
    New-Tenant | Out-Null; $script:lines.Clear()
    $global:T.failOn = '^GET /sites/root'
    $r = $null; try { $r = Invoke-TrigonM365Setup (Cfg) } catch { [void]$script:lines.Add((Protect-TrigonText $_.Exception.Message)) }
    $global:T.failOn = $null
    [void](Invoke-TrigonM365Setup (Cfg))
    [void](Invoke-TrigonM365Setup (Cfg -Apply))
    $txt = Out-Text
    foreach ($s in $FAKE_SECRET, $FAKE_KEY, $FAKE_SIG, $FAKE_BEARER, 'prod-00.uaenorth.logic.azure.com:443/workflows') { Assert (-not $txt.Contains($s)) "output does not contain $($s.Substring(0, 12))..." }
    Assert ($txt -match 'M365_CLIENT_SECRET=set') 'reports only that the secret is set'
    Assert ($txt -match 'Teams webhook in \.env.*set \(host prod-00\.uaenorth\.logic\.azure\.com\)') 'webhook reported by host only'
    Assert ((Protect-TrigonText "Authorization: Bearer $FAKE_BEARER") -notmatch 'eyJ') 'Protect-TrigonText strips bearer tokens'
    Assert ((Protect-TrigonText $FAKE_WEBHOOK) -notmatch $FAKE_SIG) 'Protect-TrigonText strips webhook URLs'
    $st = @(Get-ChildItem $tmp -Filter 'state-*.json' | ForEach-Object { Get-Content -Raw $_.FullName }) -join "`n"
    Assert (-not $st.Contains($FAKE_SECRET) -and -not $st.Contains($FAKE_SIG)) 'state files hold no secret'
    Assert (@($global:T.calls | Where-Object { $_ -match 'passwordCredentials' }).Count -eq 0) 'never asks Graph for passwordCredentials'
}

Test-Case 'partial failure: actionable recovery, state kept, rerun resumes, rollback removes only what was created' {
    New-Tenant | Out-Null; $script:lines.Clear()
    $c = Cfg -Apply
    $global:T.failOn = '^POST /sites/[^/]+/permissions$'
    $r = Invoke-TrigonM365Setup $c
    $global:T.failOn = $null
    $txt = Out-Text
    Assert ($r.ExitCode -eq 2) 'exit 2 on partial failure'
    Assert ($txt -match 'STOPPED - partial failure' -and $txt -match 'grant the app write on the site') 'names the failed step'
    Assert ($txt -match 'run the SAME -Apply command again' -and $txt -match 'rollback-m365-provisioning\.ps1') 'gives rerun and rollback instructions'
    Assert ($txt -notmatch 'eyJ') 'error output redacted'
    $st = Get-Content -Raw $c.StatePath | ConvertFrom-Json
    Assert ($st.created.site.groupId -and $st.created.library.driveId -and -not $st.created.siteGrant) 'state has the steps done before the failure'

    # rollback dry run: lists, changes nothing
    $script:lines.Clear(); $n = (Mutations).Count
    $rb = Invoke-TrigonM365Rollback @{ Apply = $false; StatePath = $c.StatePath }
    Assert ((Mutations).Count -eq $n) 'rollback dry run: no mutation'
    Assert ((Out-Text) -match 'Remove the admin consent for Sites\.Selected') 'rollback plan lists the consent'
    Assert ((Out-Text) -match "Site 'TrigonERP' is kept") 'site kept without -RemoveCreatedSharePoint'

    # rerun the setup: resumes (grant created), no duplicates
    $r2 = Invoke-TrigonM365Setup $c
    Assert ($r2.Overall -eq 'PASS') 'rerun after failure: PASS'
    Assert (@($global:T.groups).Count -eq 1) 'rerun after failure: still one site'

    # put a file in the library: rollback must not delete it even with -RemoveCreatedSharePoint
    $g = @($global:T.groups)[0]; $site = Find-Site $g.siteId
    @($site.lists | Where-Object { $_.displayName -eq 'ERP Documents' })[0].items = 3
    $script:lines.Clear()
    Set-TrigonProvisioningHooks -Prompt { param($q) if ($q -match 'ROLLBACK') { 'ROLLBACK' } else { 'DELETE ' + ($q -replace '^Type DELETE (.+?) to .*$', '$1') } }
    $rb2 = Invoke-TrigonM365Rollback @{ Apply = $true; StatePath = $c.StatePath; RemoveCreatedSharePoint = $true }
    Assert ($rb2.ExitCode -eq 0) 'rollback exit 0'
    Assert ((Out-Text) -match 'contains files') 'library with files is refused'
    Assert (@($global:T.calls | Where-Object { $_ -match '^DELETE /sites/.*/lists/' -or $_ -match '^DELETE /groups/' }).Count -eq 0) 'no SharePoint content deleted'
    Assert (@($site.permissions).Count -eq 0) 'site grant removed'
    Assert (@($global:T.assignments).Count -eq 0) 'Sites.Selected consent removed'
    Assert ($global:T.grants[0].scope -eq 'openid profile email offline_access User.Read') 'Mail.Send removed from consent, the rest kept'
    $ids = @($global:T.app.requiredResourceAccess | Where-Object { $_.resourceAppId -eq $GRAPH } | ForEach-Object { $_.resourceAccess } | ForEach-Object { $_.id })
    Assert ($ids.Count -eq 5 -and $ids -notcontains $R_SITES_SELECTED -and $ids -notcontains $S_MAIL_SEND) 'requiredResourceAccess back to the 5 sign-in permissions'
    Assert (@($global:T.app.requiredResourceAccess).Count -eq 2) 'other API kept'
    Assert ($global:T.app.appId -eq $CLIENT) 'app registration never deleted'
    Assert (@($global:T.calls | Where-Object { $_ -match '^DELETE /applications' }).Count -eq 0) 'no DELETE on applications'

    # empty library + site: removed only with typed confirmation
    @($site.lists | Where-Object { $_.displayName -eq 'ERP Documents' })[0].items = 0
    $script:lines.Clear()
    $rb3 = Invoke-TrigonM365Rollback @{ Apply = $true; StatePath = $c.StatePath; RemoveCreatedSharePoint = $true }
    Assert (@($global:T.groups).Count -eq 0) 'empty created site removed after typed confirmation'
    $rb4 = Invoke-TrigonM365Rollback @{ Apply = $true; StatePath = $c.StatePath; RemoveCreatedSharePoint = $true }
    Assert ($rb4.Actions.Count -eq 0) 'second rollback has nothing left to do'
    Set-TrigonProvisioningHooks -Prompt { param($q) 'APPLY' }
}

Test-Case 'rollback never touches pre-existing resources' {
    New-Tenant -WithSite -WithLibrary -GrantRoles 'write' -Configured | Out-Null
    $c = Cfg -Apply
    [void](Invoke-TrigonM365Setup $c)
    Set-TrigonProvisioningHooks -Prompt { param($q) 'ROLLBACK' }
    $rb = Invoke-TrigonM365Rollback @{ Apply = $true; StatePath = $c.StatePath; RemoveCreatedSharePoint = $true }
    Assert ((Mutations).Count -eq 0) 'nothing created -> rollback removes nothing'
    Set-TrigonProvisioningHooks -Prompt { param($q) 'APPLY' }
}

Test-Case 'validation rules match lib/m365graph.js samples' {
    Assert (Test-TrigonSiteId 'contoso.sharepoint.com,0f0f0f0f-1111-2222-3333-444444444444,5e5e5e5e-1111-2222-3333-444444444444') 'site id ok'
    Assert (-not (Test-TrigonSiteId 'contoso.sharepoint.com/sites/x')) 'site url is not an id'
    Assert (Test-TrigonDriveId 'b!FakeDriveId_ForTests-123') 'drive id ok'
    Assert (-not (Test-TrigonDriveId 'b!bad/drive')) 'drive id with / refused'
    Assert (Test-TrigonWebUrl 'https://contoso.sharepoint.com/sites/TrigonERP/ERP%20Documents') 'sharepoint url ok'
    Assert (-not (Test-TrigonWebUrl 'http://contoso.sharepoint.com/x')) 'http refused'
    Assert (-not (Test-TrigonWebUrl 'https://evil.example.com/x')) 'other host refused'
}

Test-Case 'setup and rollback scripts parse without errors' {
    foreach ($f in 'setup-m365-production.ps1', 'rollback-m365-provisioning.ps1', 'm365-provisioning.psm1') {
        $tok = $null; $errs = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "..\$f"), [ref]$tok, [ref]$errs)
        Assert (@($errs).Count -eq 0) "$f parses ($(@($errs | ForEach-Object { $_.Message }) -join '; '))"
    }
}

Remove-Item -Recurse -Force $tmp
Write-Host ''
Write-Host "m365-provisioning tests: $script:pass passed, $script:fail failed"
if ($script:fail) { $script:failed | ForEach-Object { Write-Host " - $_" }; exit 1 }
exit 0
