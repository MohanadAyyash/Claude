# Trigon ERP - Microsoft 365 provisioning for the business integration (PR #16): shared logic for
#   scripts/setup-m365-production.ps1      (discover -> plan -> apply -> verify)
#   scripts/rollback-m365-provisioning.ps1 (undo only what the setup recorded as created by it)
# Tested by scripts/tests/m365-provisioning.tests.ps1 against a mocked Graph tenant (test-m365-provisioning.js).
#
# Safety rules built into this module:
#  - every Microsoft Graph call goes through Invoke-TG; any call other than GET is refused unless Apply mode is on;
#  - secrets are never read: for M365_CLIENT_SECRET / M365_ENCRYPTION_KEY only "set / not set" is checked, for the Teams
#    webhook only its host name; all console output passes through Protect-TrigonText (tokens, signatures, JWTs redacted);
#  - nothing broader than Sites.Selected (application) and Mail.Send (delegated) is ever added; existing permissions are kept;
#  - every change is recorded in a local state file (IDs only, no secrets) so the rollback removes only what this tool created.
# ASCII only: Windows PowerShell 5.1 reads scripts without a BOM as ANSI.

Set-StrictMode -Off

$script:GraphAppId = '00000003-0000-0000-c000-000000000000'
$script:GraphBase = 'https://graph.microsoft.com/v1.0'
# the same rules as lib/m365graph.js (validSiteId / validDriveId / safeWebUrl); test-m365-provisioning.js checks they stay identical
$script:SiteIdRe = '^[a-z0-9.-]{3,200},[0-9a-f-]{36},[0-9a-f-]{36}$'
$script:OpaqueIdRe = '^[A-Za-z0-9!_\-]{4,200}$'
$script:GuidRe = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# application permissions that would give the app access beyond the one Trigon site, or to mail / Teams in general
$script:BroadAppSharePoint = @('Sites.ReadWrite.All', 'Sites.FullControl.All', 'Sites.Manage.All', 'Sites.Read.All', 'Files.ReadWrite.All', 'Files.Read.All')
$script:BroadAppOther = @('Mail.ReadWrite', 'Mail.Send', 'Mail.Read', 'ChannelMessage.Send', 'ChannelMessage.Read.All', 'Group.ReadWrite.All', 'Directory.ReadWrite.All', 'Teamwork.Migrate.All')
$script:BroadDelegated = @('Sites.ReadWrite.All', 'Sites.FullControl.All', 'Sites.Manage.All', 'Files.ReadWrite.All', 'Files.ReadWrite.All', 'Mail.ReadWrite', 'ChannelMessage.Send', 'Group.ReadWrite.All')

# ---------------------------------------------------------------- hooks (replaced by the tests)
$script:Invoker = {
    param($Method, $Uri, $Body)
    if ($Uri -like 'https://*') {
        if ($Uri -notlike 'https://graph.microsoft.com/*') { throw 'Refusing a link outside graph.microsoft.com' }
        $full = $Uri
    } else { $full = $script:GraphBase + $Uri }
    $p = @{ Method = $Method; Uri = $full; OutputType = 'Json'; ErrorAction = 'Stop' }
    if ($null -ne $Body) { $p.Body = (ConvertTo-Json -InputObject $Body -Depth 20 -Compress); $p.ContentType = 'application/json' }
    $raw = Invoke-MgGraphRequest @p
    if ([string]::IsNullOrWhiteSpace([string]$raw)) { return $null }
    return ($raw | ConvertFrom-Json)
}
$script:Out = { param($Line) Write-Host $Line }
$script:Sleep = { param($Seconds) Start-Sleep -Seconds $Seconds }
$script:Prompt = { param($Question) Read-Host $Question }
$script:Apply = $false
$script:Writes = New-Object System.Collections.ArrayList

function Set-TrigonProvisioningHooks {
    param([scriptblock]$Invoker, [scriptblock]$Out, [scriptblock]$Sleep, [scriptblock]$Prompt)
    if ($Invoker) { $script:Invoker = $Invoker }
    if ($Out) { $script:Out = $Out }
    if ($Sleep) { $script:Sleep = $Sleep }
    if ($Prompt) { $script:Prompt = $Prompt }
}
function Get-TrigonWrites { return @($script:Writes) }

# ---------------------------------------------------------------- safe output
function Protect-TrigonText {
    param([string]$Text)
    if ($null -eq $Text) { return '' }
    $s = $Text
    $s = $s -replace '(?i)\b(sig|signature|client_secret|code|refresh_token|access_token|id_token|password|secret)=([^&\s"'']+)', '$1=[redacted]'
    $s = $s -replace '(?i)Bearer\s+[A-Za-z0-9\-\._~\+/]+=*', 'Bearer [redacted]'
    $s = $s -replace 'eyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*', '[redacted-token]'
    $s = $s -replace '(?i)https://[^\s"'']*(logic\.azure\.com|webhook\.office\.com|powerplatform\.com)[^\s"'']*', '[redacted-webhook-url]'
    return $s
}
function W { param([string]$Line = '') & $script:Out (Protect-TrigonText $Line) }
function Section { param([string]$Title) W ''; W ('==== ' + $Title + ' ' + ('=' * [Math]::Max(3, 60 - $Title.Length))) }

# ---------------------------------------------------------------- validation (mirror of lib/m365graph.js)
function Test-TrigonSiteId { param($Id) return ($Id -is [string]) -and ($Id -match $script:SiteIdRe) }
function Test-TrigonDriveId { param($Id) return ($Id -is [string]) -and ($Id -cmatch $script:OpaqueIdRe) }
function Test-TrigonWebUrl {
    param($Url)
    try { $u = [Uri][string]$Url } catch { return $false }
    if (-not $u.IsAbsoluteUri) { return $false }
    return ($u.Scheme -eq 'https') -and ($u.Host -match '(^|\.)sharepoint\.com$') -and [string]::IsNullOrEmpty($u.UserInfo)
}

# ---------------------------------------------------------------- Graph
# The logical step a Graph call belongs to (shown when it fails). Set with Set-TGStep before each group of calls.
$script:GStep = 'Microsoft Graph request'
function Set-TGStep { param([string]$Name) $script:GStep = $Name }

# The request path as it may be shown: relative to /v1.0, opaque paging tokens shortened, redacted, bounded.
# (URLs built here never carry tokens or secrets; the redaction is a second guard.)
function Get-SafeGraphPath {
    param([string]$Uri)
    $p = [string]$Uri
    if ($p.StartsWith($script:GraphBase, [StringComparison]::OrdinalIgnoreCase)) { $p = $p.Substring($script:GraphBase.Length) }
    $p = $p -replace '(?i)(\$?skiptoken=)[^&]+', '$1...'
    $p = Protect-TrigonText $p
    if ($p.Length -gt 300) { $p = $p.Substring(0, 300) + '...' }
    return $p
}

$script:StatusByName = @{ BadRequest = 400; Unauthorized = 401; Forbidden = 403; NotFound = 404; MethodNotAllowed = 405; Conflict = 409; PreconditionFailed = 412
    TooManyRequests = 429; InternalServerError = 500; BadGateway = 502; ServiceUnavailable = 503; GatewayTimeout = 504 }

# Status, Graph error code / message and request-id from an Invoke-MgGraphRequest failure. Invoke-MgGraphRequest throws an
# HttpResponseException (.Response = the HttpResponseMessage) whose ErrorRecord.ErrorDetails.Message holds the formatted HTTP
# response (status line, response headers, then the JSON body {"error":{"code","message","innerError":{"request-id","date"}}}).
# Only the JSON body's code / message / request-id / date are kept; response headers are never printed.
function Get-GraphErrorInfo {
    param($ErrorRecord, [string]$Method, [string]$Uri, [string]$Step)
    $e = $ErrorRecord.Exception
    if ($e -and $e.Data -and $e.Data.Contains('TrigonGraph')) { return $e.Data['TrigonGraph'] }
    $status = 0
    try { if ($e.Response -and $e.Response.StatusCode) { $status = [int]$e.Response.StatusCode } } catch { }
    $m = [string]$e.Message
    if (-not $status) {
        foreach ($k in $script:StatusByName.Keys) { if ($m -match ('\b' + $k + '\b')) { $status = $script:StatusByName[$k]; break } }
        if (-not $status -and $m -match 'status code[^0-9]{0,40}\b([1-5]\d\d)\b') { $status = [int]$Matches[1] }
    }
    $code = $null; $msg = $null; $rid = $null; $date = $null
    $raw = $null
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { $raw = [string]$ErrorRecord.ErrorDetails.Message }
    if ($raw) {
        # the JSON body follows the response headers (some headers, e.g. x-ms-ags-diagnostic, hold JSON themselves)
        $mm = [regex]::Match($raw, '\{\s*"error"\s*:'); $i = -1; if ($mm.Success) { $i = $mm.Index }
        $j = $raw.LastIndexOf('}')
        if ($i -ge 0 -and $j -gt $i) {
            try {
                $body = $raw.Substring($i, $j - $i + 1) | ConvertFrom-Json
                if ($body.error) {
                    $code = [string]$body.error.code; $msg = [string]$body.error.message
                    $ie = $body.error.innerError; if (-not $ie) { $ie = $body.error.innererror }
                    if ($ie) { $rid = [string]$ie.'request-id'; if ($ie.date -is [datetime]) { $date = $ie.date.ToString('yyyy-MM-ddTHH:mm:ss') } else { $date = [string]$ie.date } }
                }
            } catch { }
        }
    }
    if (-not $msg) { $msg = $m }
    $msg = Protect-TrigonText $msg; if ($msg.Length -gt 400) { $msg = $msg.Substring(0, 400) + '...' }
    $code = Protect-TrigonText $code
    if ($rid -notmatch '^[0-9a-fA-F-]{36}$') { $rid = $null }
    $info = [pscustomobject]@{ Step = $Step; Method = $Method; Path = (Get-SafeGraphPath $Uri); Status = $status; Code = $code; Message = $msg; RequestId = $rid; Date = (Protect-TrigonText $date) }
    $sum = "Microsoft Graph request failed during '$Step': $Method $($info.Path) -> HTTP $(if ($status) { $status } else { '(no response)' })"
    if ($code) { $sum += " $code" }
    $sum += ': ' + $msg
    $info | Add-Member -NotePropertyName Summary -NotePropertyValue $sum
    return $info
}

function Invoke-TG {
    param([string]$Method = 'GET', [string]$Uri, $Body = $null)
    if ($Method -ne 'GET') {
        if (-not $script:Apply) { throw "Internal safety stop: $Method $Uri attempted in dry-run mode (no change was made)" }
        [void]$script:Writes.Add("$Method $Uri")
    }
    try { return (& $script:Invoker $Method $Uri $Body) }
    catch {
        $info = Get-GraphErrorInfo $_ $Method $Uri $script:GStep
        $ex = New-Object System.Exception ($info.Summary)
        $ex.Data['TrigonGraph'] = $info
        throw $ex
    }
}
function Get-TGStatus {
    param($ErrorRecord)
    $e = $ErrorRecord.Exception
    if ($e -and $e.Data -and $e.Data.Contains('TrigonGraph')) { return [int]$e.Data['TrigonGraph'].Status }
    return [int](Get-GraphErrorInfo $ErrorRecord '' '' '').Status
}
function Get-TGShort { param($ErrorRecord) $i = Get-GraphErrorInfo $ErrorRecord '' '' ''; $t = "HTTP $($i.Status)"; if ($i.Code) { $t += " $($i.Code)" }; return ($t + ': ' + $i.Message) }

# The diagnostic block printed when a step fails (no headers, tokens or secrets; request-id is safe to give Microsoft support)
function Write-TrigonGraphFailure {
    param($ErrorRecord, [string]$Phase)
    $i = Get-GraphErrorInfo $ErrorRecord '' '' $script:GStep
    Section ("STOPPED during $Phase")
    if ($i.Method) {
        W "Step:          $($i.Step)"
        W "Request:       $($i.Method) $($i.Path)"
        W ("HTTP status:   " + $(if ($i.Status) { $i.Status } else { 'no response (network / sign-in problem)' }))
        W ("Graph error:   " + $(if ($i.Code) { $i.Code } else { '(none)' }))
        W "Graph message: $($i.Message)"
        if ($i.RequestId) { W "Request ID:    $($i.RequestId)$(if ($i.Date) { ' at ' + $i.Date }) (safe to give Microsoft support)" }
    } else {
        W "Step:          $script:GStep"
        W ('Error:         ' + (Protect-TrigonText ([string]$ErrorRecord.Exception.Message)))
    }
    $hint = switch ($i.Status) {
        400 { 'Microsoft Graph refused this request as malformed. This is a defect in the tool, not in your tenant: send this block (it contains no secret).' }
        401 { 'The sign-in is missing or expired: run the command again and complete the browser sign-in.' }
        403 { 'The signed-in account lacks a role or consent for this step: sign in as a Global Administrator and accept the requested permissions.' }
        404 { 'Microsoft 365 does not have this item (deleted, or a wrong ID in .env).' }
        429 { 'Microsoft 365 is throttling: wait a few minutes and run again.' }
        default { if ($i.Status -ge 500) { 'Microsoft 365 had a temporary problem: run again later.' } else { '' } }
    }
    if ($hint) { W "Likely cause:  $hint" }
}

function Get-TGOrNull {
    param([string]$Uri)
    try { return (Invoke-TG GET $Uri) } catch { if ((Get-TGStatus $_) -eq 404) { return $null }; throw }
}
function Get-TGAll {
    param([string]$Uri)
    $items = @(); $next = $Uri; $guard = 0
    while ($next -and $guard -lt 50) {
        $r = Invoke-TG GET $next
        if ($r -and $r.value) { $items += @($r.value) }
        $next = $null
        if ($r) { $next = $r.'@odata.nextLink' }
        $guard++
    }
    return $items
}
function Q { param([string]$Filter) return ('$filter=' + [uri]::EscapeDataString($Filter)) }
function Get-SafeError { param($ErrorRecord) $m = [string]$ErrorRecord.Exception.Message; if ($m.Length -gt 600) { $m = $m.Substring(0, 600) + '...' }; return (Protect-TrigonText $m) }

# ---------------------------------------------------------------- local files (non-secret values only)
function Read-TrigonEnvSafe {
    param([string]$Path)
    $r = [ordered]@{ Found = $false; Path = $Path; Values = @{}; SecretsSet = @{}; TeamsHost = $null }
    if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $r }
    $r.Found = $true
    $plain = @('M365_ENABLED', 'M365_TENANT_ID', 'M365_CLIENT_ID', 'M365_SHAREPOINT_ENABLED', 'M365_SHAREPOINT_SITE_ID', 'M365_SHAREPOINT_DRIVE_ID', 'M365_SHAREPOINT_ROOT', 'M365_OUTLOOK_ENABLED', 'M365_REDIRECT_URI')
    $secret = @('M365_CLIENT_SECRET', 'M365_ENCRYPTION_KEY', 'M365_TEAMS_WEBHOOK_URL')
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -notmatch '^\s*([A-Z0-9_]+)\s*=(.*)$') { continue }
        $k = $Matches[1]
        if ($plain -contains $k) { $r.Values[$k] = $Matches[2].Trim().Trim('"') }
        elseif ($secret -contains $k) {
            $isSet = -not [string]::IsNullOrWhiteSpace($Matches[2])
            $r.SecretsSet[$k] = $isSet
            if ($k -eq 'M365_TEAMS_WEBHOOK_URL' -and $isSet) { try { $r.TeamsHost = ([Uri]$Matches[2].Trim().Trim('"')).Host } catch { $r.TeamsHost = '(not a valid URL)' } }
        }
    }
    return $r
}
function Read-TrigonState {
    param([string]$Path)
    if ($Path -and (Test-Path -LiteralPath $Path)) { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
    return $null
}
function New-TrigonStateObject {
    param($Old, [string]$TenantId, [string]$ClientId)
    $s = [ordered]@{ tool = 'trigon-m365-provisioning'; version = 1; tenantId = $TenantId; clientId = $ClientId; created = [ordered]@{}; history = @() }
    if ($Old) {
        if ($Old.created) { foreach ($p in $Old.created.PSObject.Properties) { $s.created[$p.Name] = $p.Value } }
        if ($Old.history) { $s.history = @($Old.history) }
    }
    return $s
}
function Save-TrigonState {
    param($State, [string]$Path, [string]$Event)
    if ($Event) { $State.history = @($State.history) + @([ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); event = $Event }) }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $State -Depth 12))
}

# ---------------------------------------------------------------- discovery (read only)
function Get-TrigonM365Discovery {
    param([hashtable]$Cfg, $EnvInfo)
    $d = [ordered]@{ Warnings = New-Object System.Collections.ArrayList }
    Set-TGStep 'tenant discovery (GET /organization)'
    $org = @((Invoke-TG GET '/organization?$select=id,displayName').value)[0]
    Set-TGStep 'signed-in administrator lookup (GET /me)'
    $me = Invoke-TG GET '/me?$select=id,userPrincipalName,displayName'
    $d.Tenant = [ordered]@{ Id = $org.id; Name = $org.displayName }
    $d.Admin = [ordered]@{ Id = $me.id; Upn = $me.userPrincipalName }

    # --- Entra app registration (never selects passwordCredentials / keyCredentials)
    Set-TGStep 'Entra app registration lookup (GET /applications)'
    $sel = '&$select=id,appId,displayName,requiredResourceAccess'
    $clientId = $Cfg.ClientId
    if ($clientId) {
        if ($clientId -notmatch $script:GuidRe) { throw 'The Client ID is not a GUID' }
        $apps = @(Get-TGAll ('/applications?' + (Q "appId eq '$clientId'") + $sel))
    } else {
        $apps = @(Get-TGAll ('/applications?' + (Q "startswith(displayName,'Trigon')") + $sel))
        if ($apps.Count -gt 1) {
            $list = ($apps | ForEach-Object { "$($_.displayName) (Client ID $($_.appId))" }) -join '; '
            throw "More than one app registration starts with 'Trigon': $list. Run again with -ClientId <the ERP's M365_CLIENT_ID>."
        }
    }
    if ($apps.Count -ne 1) { throw 'The Trigon ERP app registration was not found. Pass -ClientId <M365_CLIENT_ID> or check the tenant.' }
    $app = $apps[0]
    $d.App = $app
    $d.ClientId = $app.appId

    Set-TGStep 'Microsoft Graph service principal lookup (permission names)'
    $gsp = @(Get-TGAll ('/servicePrincipals?' + (Q "appId eq '$script:GraphAppId'") + '&$select=id,appRoles,oauth2PermissionScopes'))[0]
    if (-not $gsp) { throw 'Microsoft Graph service principal not found in this tenant' }
    $d.GraphSpId = $gsp.id
    $d.RoleIdByName = @{}; $d.RoleNameById = @{}; $d.ScopeIdByName = @{}; $d.ScopeNameById = @{}
    foreach ($r in @($gsp.appRoles)) { $d.RoleIdByName[$r.value] = $r.id; $d.RoleNameById[$r.id] = $r.value }
    foreach ($r in @($gsp.oauth2PermissionScopes)) { $d.ScopeIdByName[$r.value] = $r.id; $d.ScopeNameById[$r.id] = $r.value }
    foreach ($need in @(@('Role', 'Sites.Selected'), @('Scope', 'Mail.Send'))) {
        $map = $d.RoleIdByName; if ($need[0] -eq 'Scope') { $map = $d.ScopeIdByName }
        if (-not $map.ContainsKey($need[1])) { throw "Microsoft Graph does not list the permission $($need[1]) in this tenant" }
    }

    # requested permissions (API permissions on the app registration)
    $d.RequestedApp = @(); $d.RequestedDelegated = @(); $d.OtherResources = 0
    foreach ($rra in @($app.requiredResourceAccess)) {
        if (-not $rra) { continue }
        if ($rra.resourceAppId -ne $script:GraphAppId) { $d.OtherResources++; continue }
        foreach ($ra in @($rra.resourceAccess)) {
            if ($ra.type -eq 'Role') { $n = $d.RoleNameById[$ra.id]; if (-not $n) { $n = $ra.id }; $d.RequestedApp += $n }
            else { $n = $d.ScopeNameById[$ra.id]; if (-not $n) { $n = $ra.id }; $d.RequestedDelegated += $n }
        }
    }

    # the app's enterprise application (service principal), its consented application permissions and delegated admin consent
    Set-TGStep 'app enterprise application lookup (GET /servicePrincipals)'
    $d.AppSp = @(Get-TGAll ('/servicePrincipals?' + (Q "appId eq '$($app.appId)'") + '&$select=id,appId,displayName'))[0]
    $d.GrantedApp = @(); $d.GrantedAppAssignments = @(); $d.AllPrincipalsGrant = $null; $d.ConsentedDelegated = @()
    if ($d.AppSp) {
        Set-TGStep 'app permissions lookup: consented application permissions (appRoleAssignments)'
        foreach ($a in @(Get-TGAll "/servicePrincipals/$($d.AppSp.id)/appRoleAssignments")) {
            if ($a.resourceId -ne $d.GraphSpId) { continue }
            $n = $d.RoleNameById[$a.appRoleId]; if (-not $n) { $n = $a.appRoleId }
            $d.GrantedApp += $n
            $d.GrantedAppAssignments += [pscustomobject]@{ Id = $a.id; Name = $n }
        }
        Set-TGStep 'app permissions lookup: delegated admin consent (oauth2PermissionGrants)'
        foreach ($g in @(Get-TGAll ('/oauth2PermissionGrants?' + (Q "clientId eq '$($d.AppSp.id)'")))) {
            if ($g.resourceId -ne $d.GraphSpId) { continue }
            if ($g.consentType -eq 'AllPrincipals') { $d.AllPrincipalsGrant = $g; $d.ConsentedDelegated = @(([string]$g.scope).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) }
        }
    }

    # --- SharePoint site
    Set-TGStep 'SharePoint root site lookup (GET /sites/root)'
    $root = Invoke-TG GET '/sites/root?$select=id,webUrl,siteCollection'
    $spHost = $root.siteCollection.hostname
    if (-not $spHost) { $spHost = ([Uri]$root.webUrl).Host }
    $d.SharePointHost = $spHost
    $d.RootSiteId = $root.id
    # Keyword site search. Written as $search on purpose: Invoke-MgGraphRequest rewrites a bare "search=" to "$search=" anyway
    # (ODataQueryOptionsHandler), so this is exactly what Graph receives. Never "*": that is a $search syntax error (HTTP 400).
    # Informational only: a failure here is reported and discovery continues with the /sites/<SiteName> address.
    Set-TGStep 'SharePoint site search for "Trigon" (GET /sites?$search=)'
    try { $d.SiteCandidates = @(Get-TGAll ('/sites?$search=' + [uri]::EscapeDataString('Trigon')) | Where-Object { $_ }) }
    catch { $d.SiteCandidates = @(); [void]$d.Warnings.Add('The SharePoint search for "Trigon" sites failed (' + (Get-TGShort $_) + '); continuing with the site address') }
    $site = $null; $source = $null
    $envSite = $null; if ($EnvInfo -and $EnvInfo.Values) { $envSite = $EnvInfo.Values['M365_SHAREPOINT_SITE_ID'] }
    if ($envSite -and (Test-TrigonSiteId $envSite)) {
        Set-TGStep 'SharePoint site lookup by the M365_SHAREPOINT_SITE_ID in .env'
        $site = Get-TGOrNull ('/sites/' + $envSite + '?$select=id,displayName,name,webUrl')
        if ($site) { $source = 'the M365_SHAREPOINT_SITE_ID already in .env' } else { [void]$d.Warnings.Add('M365_SHAREPOINT_SITE_ID in .env does not resolve to a site; it will be replaced by the discovered value') }
    }
    Set-TGStep "SharePoint site lookup by address /sites/$($Cfg.SiteName)"
    $byUrl = Get-TGOrNull ('/sites/' + $spHost + ':/sites/' + $Cfg.SiteName + '?$select=id,displayName,name,webUrl')
    if (-not $site -and $byUrl) { $site = $byUrl; $source = "its address /sites/$($Cfg.SiteName)" }
    elseif ($site -and $byUrl -and $byUrl.id -ne $site.id) { [void]$d.Warnings.Add("The site in .env ($($site.webUrl)) is not /sites/$($Cfg.SiteName) ($($byUrl.webUrl)); the one in .env is used") }
    if (-not $site) {
        $m = @($d.SiteCandidates | Where-Object { $_.displayName -eq $Cfg.SiteDisplayName })
        Set-TGStep "SharePoint site lookup by name '$($Cfg.SiteDisplayName)'"
        if ($m.Count -eq 1) { $site = Get-TGOrNull ('/sites/' + $m[0].id + '?$select=id,displayName,name,webUrl'); $source = "its name '$($Cfg.SiteDisplayName)'" }
        elseif ($m.Count -gt 1) { throw "More than one site is named '$($Cfg.SiteDisplayName)'. Put the right one in .env as M365_SHAREPOINT_SITE_ID and run again." }
    }
    $d.Site = $site; $d.SiteSource = $source
    $d.SiteGroup = $null
    $d.NicknameTaken = $null
    # the group alias is the last segment of the site address (/sites/<alias>); the site's "name" is not guaranteed to be it
    $nick = $Cfg.SiteName
    if ($site -and $site.webUrl) { $seg = ([Uri]$site.webUrl).AbsolutePath.TrimEnd('/').Split('/')[-1]; if ($seg -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { $nick = $seg } }
    Set-TGStep "Microsoft 365 group lookup (mailNickname '$nick')"
    $groups = @(Get-TGAll ('/groups?' + (Q "mailNickname eq '$nick'") + '&$select=id,displayName,visibility,mailNickname'))
    if ($groups.Count -ge 1) {
        Set-TGStep 'group site lookup (GET /groups/{id}/sites/root)'
        $gsite = Get-TGOrNull ('/groups/' + $groups[0].id + '/sites/root?$select=id,webUrl')
        if ($site -and $gsite -and $gsite.id -eq $site.id) { $d.SiteGroup = $groups[0] }
        elseif (-not $site) { $d.NicknameTaken = $groups[0] }
    }

    # --- document library, drive, grants
    $d.Library = $null; $d.LibraryDuplicates = @(); $d.LibraryExactCount = 0; $d.SiteGrants = @()
    if ($site) {
        Set-TGStep "document library lookup (GET /sites/{site}/lists)"
        $lists = @(Get-TGAll ('/sites/' + $site.id + '/lists?$select=id,displayName,list'))
        $exact = @($lists | Where-Object { $_.displayName -ceq $Cfg.LibraryName -and $_.list -and $_.list.template -eq 'documentLibrary' })
        $d.LibraryExactCount = $exact.Count
        $d.LibraryDuplicates = @($lists | Where-Object { $_.displayName -match ('^' + [regex]::Escape($Cfg.LibraryName) + '\s*\d+$') } | ForEach-Object { $_.displayName })
        if ($exact.Count -gt 1) { [void]$d.Warnings.Add("$($exact.Count) libraries are named '$($Cfg.LibraryName)'; the first one is used") }
        if ($exact.Count -ge 1) {
            Set-TGStep "library drive lookup (GET /sites/{site}/lists/{list}/drive)"
            $drive = Invoke-TG GET ('/sites/' + $site.id + '/lists/' + $exact[0].id + '/drive?$select=id,name,webUrl')
            $d.Library = [ordered]@{ ListId = $exact[0].id; DriveId = $drive.id; Name = $exact[0].displayName; WebUrl = $drive.webUrl }
        }
        Set-TGStep 'site grant lookup (GET /sites/{site}/permissions; needs Sites.FullControl.All for the signed-in admin)'
        foreach ($p in @(Get-TGAll ('/sites/' + $site.id + '/permissions'))) {
            $ids = @(); foreach ($x in @($p.grantedToIdentitiesV2) + @($p.grantedToIdentities)) { if ($x -and $x.application) { $ids += $x.application.id } }
            if ($ids -notcontains $d.ClientId) { continue }
            $full = Invoke-TG GET ('/sites/' + $site.id + '/permissions/' + $p.id)
            $d.SiteGrants += [pscustomobject]@{ Id = $p.id; Roles = @($full.roles) }
        }
    }

    # --- other sites where this app has a grant. Microsoft Graph cannot list EVERY site with an administrator (delegated) sign-in:
    # GET /sites/getAllSites and an unfiltered GET /sites are application-permission only, and "$search=*" is a syntax error (400).
    # So the sites checked are the tenant root site and every site the "Trigon" search found; the result says so.
    $d.OtherSiteGrants = @(); $d.SitesScanned = 0; $d.SitesNotChecked = 0
    if (-not $Cfg.SkipSiteScan) {
        $toCheck = @(@($d.RootSiteId) + @($d.SiteCandidates | ForEach-Object { $_.id }) | Where-Object { $_ -and (-not $site -or $_ -ne $site.id) } | Select-Object -Unique)
        foreach ($sid in $toCheck) {
            Set-TGStep 'other-site grant check (GET /sites/{site}/permissions)'
            try {
                $d.SitesScanned++
                foreach ($p in @(Get-TGAll ('/sites/' + $sid + '/permissions'))) {
                    foreach ($x in @($p.grantedToIdentitiesV2) + @($p.grantedToIdentities)) { if ($x -and $x.application -and $x.application.id -eq $d.ClientId) { $u = @($d.SiteCandidates | Where-Object { $_.id -eq $sid } | ForEach-Object { $_.webUrl })[0]; if (-not $u) { $u = $sid }; $d.OtherSiteGrants += $u } }
                }
            } catch { $d.SitesNotChecked++ }
        }
    }
    return $d
}

# ---------------------------------------------------------------- plan
function Get-GrantLevel { param($Roles) $r = @($Roles | ForEach-Object { ([string]$_).ToLower() }); if ($r -contains 'owner' -or $r -contains 'fullcontrol' -or $r -contains 'manage') { return 3 }; if ($r -contains 'write') { return 2 }; if ($r -contains 'read') { return 1 }; return 0 }

function New-TrigonPlan {
    param($D, [hashtable]$Cfg)
    $plan = New-Object System.Collections.ArrayList
    $add = { param($k, $t) [void]$plan.Add([pscustomobject]@{ Key = $k; Text = $t }) }
    if (-not $D.AppSp) { & $add 'CreateServicePrincipal' "Create the enterprise application (service principal) for $($D.App.displayName)" }
    if ($D.RequestedApp -notcontains 'Sites.Selected') { & $add 'AddRequired:Sites.Selected' "Entra app '$($D.App.displayName)': ADD API permission Microsoft Graph Sites.Selected (Application)" }
    if ($D.RequestedDelegated -notcontains 'Mail.Send') { & $add 'AddRequired:Mail.Send' "Entra app '$($D.App.displayName)': ADD API permission Microsoft Graph Mail.Send (Delegated)" }
    if ($D.GrantedApp -notcontains 'Sites.Selected') { & $add 'GrantAppRole:Sites.Selected' 'Grant admin consent for Sites.Selected (Application) - gives access to NO site by itself' }
    if ($D.AllPrincipalsGrant -and $D.ConsentedDelegated -notcontains 'Mail.Send') { & $add 'ExtendConsent:Mail.Send' 'Add Mail.Send to the existing tenant-wide (admin) consent of the delegated sign-in permissions' }
    if (-not $D.Site) { & $add 'CreateSite' "Create PRIVATE site '$($Cfg.SiteDisplayName)' at https://$($D.SharePointHost)/sites/$($Cfg.SiteName) (owner: $($D.Admin.Upn); no members, no organization-wide access)" }
    elseif ($D.SiteSource) { & $add 'ReuseSite' "Reuse existing site '$($D.Site.displayName)' $($D.Site.webUrl) (found by $($D.SiteSource))" }
    if (-not $D.Library) { & $add 'CreateLibrary' "Create document library '$($Cfg.LibraryName)' in the site" }
    $best = 0; foreach ($g in @($D.SiteGrants)) { $l = Get-GrantLevel $g.Roles; if ($l -gt $best) { $best = $l } }
    if (@($D.SiteGrants).Count -eq 0) { & $add 'CreateSiteGrant' "Grant the app WRITE on this one site only (Sites.Selected resource-specific permission)" }
    elseif ($best -lt 2) { & $add 'UpgradeSiteGrant' 'Change the existing read grant of the app on this site to write' }
    return , $plan
}
function Get-ChangeCount { param($Plan) return @($Plan | Where-Object { $_.Key -ne 'ReuseSite' }).Count }

# ---------------------------------------------------------------- checks / report
function Get-TrigonChecks {
    param($D, $Plan, [hashtable]$Cfg, $EnvInfo, [bool]$AfterApply)
    $c = New-Object System.Collections.ArrayList
    $pending = @($Plan | ForEach-Object { $_.Key })
    $add = { param($name, $status, $detail) [void]$c.Add([pscustomobject]@{ Name = $name; Status = $status; Detail = $detail }) }
    $todo = 'FAIL'; if (-not $AfterApply) { $todo = 'TODO' }

    & $add 'Tenant and administrator identified' 'PASS' "$($D.Tenant.Name) / $($D.Admin.Upn)"
    & $add 'Trigon Entra app registration found' 'PASS' "$($D.App.displayName), Client ID $($D.ClientId)"
    if ($D.Site) { & $add 'SharePoint site exists' 'PASS' $D.Site.webUrl } else { & $add 'SharePoint site exists' $todo 'not yet created' }
    if ($D.Site) {
        if ($D.SiteGroup) {
            if ($D.SiteGroup.visibility -eq 'Private') { & $add 'Site is private (no organization-wide access)' 'PASS' 'Microsoft 365 group visibility: Private' }
            else { & $add 'Site is private (no organization-wide access)' 'FAIL' "group visibility is '$($D.SiteGroup.visibility)': anyone in the organization can open it. Make the group Private, or use another site." }
        } else { & $add 'Site is private (no organization-wide access)' 'WARN' 'not a group site: check in SharePoint that it is not shared with "Everyone except external users"' }
    } else { & $add 'Site is private (no organization-wide access)' $todo 'created as Private by Apply' }
    if ($D.Library) {
        $st = 'PASS'; $det = $D.Library.WebUrl
        if ($D.LibraryExactCount -gt 1) { $st = 'WARN'; $det += " ($($D.LibraryExactCount) libraries with this name)" }
        if (@($D.LibraryDuplicates).Count) { $st = 'WARN'; $det += ' (also found: ' + (@($D.LibraryDuplicates) -join ', ') + ' - not used, check and remove by hand if empty)' }
        & $add "Library '$($Cfg.LibraryName)' exists" $st $det
    } else { & $add "Library '$($Cfg.LibraryName)' exists" $todo 'not yet created' }
    if ($D.Site -and $D.Library) {
        $ok = (Test-TrigonSiteId $D.Site.id) -and (Test-TrigonDriveId $D.Library.DriveId) -and (Test-TrigonWebUrl $D.Site.webUrl) -and (Test-TrigonWebUrl $D.Library.WebUrl)
        if ($ok) { & $add 'Site ID / Drive ID / URLs pass the lib/m365graph.js rules' 'PASS' 'site id host,guid,guid; drive id opaque; https://*.sharepoint.com' }
        else { & $add 'Site ID / Drive ID / URLs pass the lib/m365graph.js rules' 'FAIL' 'an ID or URL has an unexpected format' }
        Set-TGStep 'drive ID check (GET /sites/{site}/drives/{drive})'
        $drv = $null; try { $drv = Get-TGOrNull ('/sites/' + $D.Site.id + '/drives/' + $D.Library.DriveId + '?$select=id') } catch { [void]$D.Warnings.Add('Drive check failed: ' + (Get-TGShort $_)) }
        if ($drv -and $drv.id -eq $D.Library.DriveId) { & $add 'IDs resolve (GET site + drive)' 'PASS' 'the drive belongs to the site' } else { & $add 'IDs resolve (GET site + drive)' 'FAIL' 'the drive ID does not resolve inside the site' }
    } else { & $add 'Site ID / Drive ID resolve and are valid' $todo 'after the site and library exist' }

    if ($D.RequestedApp -contains 'Sites.Selected') { & $add 'Sites.Selected (Application) on the app registration' 'PASS' '' } else { & $add 'Sites.Selected (Application) on the app registration' $todo '' }
    if ($D.GrantedApp -contains 'Sites.Selected') { & $add 'Sites.Selected admin consent' 'PASS' '' } else { & $add 'Sites.Selected admin consent' $todo '' }
    $best = 0; foreach ($g in @($D.SiteGrants)) { $l = Get-GrantLevel $g.Roles; if ($l -gt $best) { $best = $l } }
    if ($best -eq 2) {
        $st = 'PASS'; $det = 'write on ' + $D.Site.webUrl
        if (@($D.SiteGrants).Count -gt 1) { $st = 'WARN'; $det += " ($(@($D.SiteGrants).Count) grants for the app on this site; one is enough)" }
        & $add 'App has write on the Trigon site' $st $det
    } elseif ($best -eq 3) { & $add 'App has write on the Trigon site' 'WARN' 'the app has owner / full control there: more than needed (write is enough)' }
    else { & $add 'App has write on the Trigon site' $todo 'no write grant yet' }
    if (@($D.OtherSiteGrants).Count) { & $add 'App has no grant on any other site' 'FAIL' ('also granted on: ' + (@($D.OtherSiteGrants) -join ', ')) }
    elseif ($Cfg.SkipSiteScan) { & $add 'App has no grant on any other site' 'WARN' 'not scanned (-SkipSiteScan)' }
    else {
        $det = "$($D.SitesScanned) other site(s) checked: the root site and the sites found by the 'Trigon' search (Graph cannot list every site with an administrator sign-in; the tenant-wide permission check below covers 'all sites' access)"; $st = 'PASS'
        if ($D.SitesNotChecked) { $det += ", $($D.SitesNotChecked) could not be read"; $st = 'WARN' }
        & $add 'App has no grant on any other site' $st $det
    }
    $broadSp = @(@($D.RequestedApp) + @($D.GrantedApp) | Where-Object { $script:BroadAppSharePoint -contains $_ } | Select-Object -Unique)
    if ($broadSp.Count) { & $add 'No tenant-wide SharePoint permission' 'FAIL' ('FOUND ' + ($broadSp -join ', ') + ' (Application): the app could reach every site. Remove it in Entra > App registrations > API permissions (this tool never adds it).') }
    else { & $add 'No tenant-wide SharePoint permission' 'PASS' 'no Sites.ReadWrite.All / FullControl.All / Files.ReadWrite.All' }
    $broadOther = @(@($D.RequestedApp) + @($D.GrantedApp) | Where-Object { $script:BroadAppOther -contains $_ } | Select-Object -Unique)
    if ($broadOther.Count) { & $add 'No application-wide mail / Teams permission' 'FAIL' ('FOUND ' + ($broadOther -join ', ') + ' (Application). Remove it in Entra.') }
    else { & $add 'No application-wide mail / Teams permission' 'PASS' 'no application Mail.Send / Mail.ReadWrite / ChannelMessage.Send / Group.ReadWrite.All' }
    $broadDel = @(@($D.RequestedDelegated) + @($D.ConsentedDelegated) | Where-Object { $script:BroadDelegated -contains $_ } | Select-Object -Unique)
    if ($broadDel.Count) { & $add 'No broad delegated permission' 'WARN' ('found ' + ($broadDel -join ', ') + ' (Delegated): not used by the ERP') }
    if ($D.RequestedDelegated -contains 'Mail.Send') { & $add 'Mail.Send (Delegated) on the app registration' 'PASS' 'users send only from their own mailbox' } else { & $add 'Mail.Send (Delegated) on the app registration' $todo '' }
    $authOk = @('openid', 'profile', 'email', 'offline_access', 'User.Read' | Where-Object { $D.RequestedDelegated -notcontains $_ })
    if ($authOk.Count) { & $add 'Sign-in permissions kept' 'WARN' ('not on the app registration: ' + ($authOk -join ', ') + ' (unchanged by this tool)') } else { & $add 'Sign-in permissions kept' 'PASS' 'openid profile email offline_access User.Read' }
    $changes = Get-ChangeCount $Plan
    if ($AfterApply) {
        if ($changes -eq 0) { & $add 'Re-running changes nothing (idempotent)' 'PASS' 'a fresh plan has no changes' } else { & $add 'Re-running changes nothing (idempotent)' 'FAIL' ("a fresh plan still has: " + ((@($Plan | Where-Object { $_.Key -ne 'ReuseSite' }) | ForEach-Object { $_.Key }) -join ', ')) }
    }
    if ($EnvInfo -and $EnvInfo.Found -and $D.Site -and $D.Library) {
        $es = $EnvInfo.Values['M365_SHAREPOINT_SITE_ID']; $ed = $EnvInfo.Values['M365_SHAREPOINT_DRIVE_ID']
        if (($es -and $es -ne $D.Site.id) -or ($ed -and $ed -ne $D.Library.DriveId)) { & $add '.env SharePoint IDs match' 'WARN' 'the IDs in .env differ from the discovered ones: use the block below' }
        elseif ($es -and $ed) { & $add '.env SharePoint IDs match' 'PASS' '' }
    }
    if ($EnvInfo -and $EnvInfo.SecretsSet['M365_TEAMS_WEBHOOK_URL']) { & $add 'Teams webhook in .env' 'PASS' "set (host $($EnvInfo.TeamsHost))" } else { & $add 'Teams webhook in .env' 'MANUAL' 'create the Workflow in Teams (one manual step, see below)' }
    return , $c
}
function Write-TrigonChecks {
    param($Checks)
    foreach ($x in $Checks) { $line = ('[{0,-6}] {1}' -f $x.Status, $x.Name); if ($x.Detail) { $line += ' - ' + $x.Detail }; W $line }
}
function Get-Overall { param($Checks) if (@($Checks | Where-Object { $_.Status -eq 'FAIL' }).Count) { return 'FAIL' }; return 'PASS' }

function Write-TrigonDiscovery {
    param($D, $EnvInfo, [hashtable]$Cfg)
    Section 'Preflight'
    W "Tenant:            $($D.Tenant.Name) ($($D.Tenant.Id))"
    W "Signed in as:      $($D.Admin.Upn)"
    W "App registration:  $($D.App.displayName)"
    W "Client ID:         $($D.ClientId)"
    if ($D.AppSp) { W 'Enterprise app:    present' } else { W 'Enterprise app:    MISSING (will be created)' }
    W ('Requested (Application): ' + ((@($D.RequestedApp) | Sort-Object) -join ', '))
    W ('Requested (Delegated):   ' + ((@($D.RequestedDelegated) | Sort-Object) -join ', '))
    W ('Admin-consented (Application): ' + ((@($D.GrantedApp) | Sort-Object) -join ', '))
    if ($D.AllPrincipalsGrant) { W ('Admin-consented (Delegated, all users): ' + ((@($D.ConsentedDelegated) | Sort-Object) -join ', ')) } else { W 'Admin-consented (Delegated, all users): none (users consent themselves when they connect)' }
    if ($D.OtherResources) { W "Other APIs on the app: $($D.OtherResources) (kept unchanged)" }
    W "SharePoint:        https://$($D.SharePointHost)"
    if (@($D.SiteCandidates).Count) { W 'Sites matching "Trigon":'; foreach ($s in $D.SiteCandidates) { W "   - $($s.displayName)  $($s.webUrl)" } } else { W 'Sites matching "Trigon": none' }
    if ($D.Site) { W "Dedicated site:    $($D.Site.displayName)  $($D.Site.webUrl)  (found by $($D.SiteSource))" } else { W "Dedicated site:    not found -> will be created as https://$($D.SharePointHost)/sites/$($Cfg.SiteName)" }
    if ($D.Library) { W "Library:           $($D.Library.Name)  $($D.Library.WebUrl)" } elseif ($D.Site) { W "Library:           '$($Cfg.LibraryName)' not found -> will be created" }
    W ('App grants on the site: ' + $(if (@($D.SiteGrants).Count) { (@($D.SiteGrants) | ForEach-Object { ($_.Roles -join '+') }) -join '; ' } else { 'none' }))
    if ($EnvInfo.Found) {
        $sec = @('M365_CLIENT_SECRET', 'M365_ENCRYPTION_KEY', 'M365_TEAMS_WEBHOOK_URL' | ForEach-Object { if ($EnvInfo.SecretsSet[$_]) { "$_=set" } else { "$_=not set" } })
        W ".env:              $($EnvInfo.Path) (secrets are not read or shown: $($sec -join ', '))"
    } else { W ".env:              not found at $($EnvInfo.Path) (fine: IDs are discovered)" }
    foreach ($w in $D.Warnings) { W "WARNING: $w" }
}

function Write-TrigonEnvBlock {
    param($D, [hashtable]$Cfg, $EnvInfo)
    Section 'Settings for C:\ERP\.env (no secrets; keep your existing M365_* lines)'
    if (-not ($D.Site -and $D.Library)) { W '(available after -Apply: the site and library must exist first)'; return }
    $root = $Cfg.SharePointRoot; if (-not $root) { $root = 'Trigon Civil Projects' }
    W '# --- Microsoft 365 business integration (from scripts/setup-m365-production.ps1) ---'
    W 'M365_SHAREPOINT_ENABLED=1'
    W ('M365_SHAREPOINT_SITE_ID=' + $D.Site.id)
    W ('M365_SHAREPOINT_DRIVE_ID=' + $D.Library.DriveId)
    W ('M365_SHAREPOINT_ROOT=' + $root)
    W 'M365_OUTLOOK_ENABLED=1'
    if ($EnvInfo -and $EnvInfo.SecretsSet['M365_TEAMS_WEBHOOK_URL']) { W '# M365_TEAMS_WEBHOOK_URL is already set in .env: keep that line as it is' }
    else { W '# M365_TEAMS_WEBHOOK_URL=   <- paste the Teams Workflow URL here yourself (it is a secret; see "Teams" below)' }
    W 'M365_TEAMS_INCLUDE_AMOUNTS=0'
    W ('# site:    ' + $D.Site.webUrl)
    W ('# library: ' + $D.Library.WebUrl)
}

function Write-TrigonManualSteps {
    param($D, [hashtable]$Cfg)
    Section 'Teams (the only manual Microsoft step)'
    W 'Microsoft does not offer a supported API to create a Teams Workflows webhook without broad Teams/Power Automate rights,'
    W 'so this tool does not create it (no Teams Graph permission is added).'
    W '  1. Teams > the team that should receive ERP notices (e.g. Trigon Civil) > channel "Procurement" (or your approvals channel).'
    W '  2. Channel "..." (More options) > Workflows.'
    W '  3. Template: "Post to a channel when a webhook request is received". Name it "Trigon ERP". Next > pick the same Team and channel > Add workflow.'
    W '  4. Copy the URL shown at the end (also later: Workflows app > the flow > the "When a Teams webhook request is received" step > HTTP URL).'
    W '  5. Paste it in C:\ERP\.env as M365_TEAMS_WEBHOOK_URL=<url> (keep it secret: it carries a signature). Restart the ERP.'
    W '  6. ERP > Settings > Microsoft 365 integration > Send a test notification.'
    Section 'Outlook (each user, once)'
    W 'Delegated Mail.Send lets a user send only from their own mailbox. After M365_OUTLOOK_ENABLED=1 and a restart:'
    W '  each user: ERP > Settings > Microsoft 365 account > Disconnect, then Connect (accepts "Send mail as you").'
    W '  Settings then shows "You can send from your mailbox"; Test reads the user''s own address and sends nothing.'
    if (-not $D.AllPrincipalsGrant) { W '  Your tenant has no tenant-wide consent for this app: if users are blocked from consenting, an administrator approves it once in Entra > Enterprise applications > the app > Permissions > Grant admin consent.' }
    Section 'Then'
    W '  Restart the ERP so .env is re-read (see M365.md "Restart that really applies .env"), then Settings > Microsoft 365 integration > Test connection.'
}

# ---------------------------------------------------------------- apply
function Invoke-TrigonApplyPlan {
    param($D, $Plan, [hashtable]$Cfg, $State)
    $keys = @($Plan | ForEach-Object { $_.Key })
    $script:Step = $script:GStep = 'apply: '
    $save = { param($ev) Save-TrigonState -State $State -Path $Cfg.StatePath -Event $ev }

    if ($keys -contains 'CreateServicePrincipal') {
        $script:Step = $script:GStep = 'apply: create the enterprise application'
        $sp = Invoke-TG POST '/servicePrincipals' @{ appId = $D.ClientId }
        $D.AppSp = $sp
        $State.created['servicePrincipal'] = [ordered]@{ id = $sp.id; note = 'kept on rollback (needed for sign-in)' }
        & $save 'created service principal'
        W "  done: enterprise application created"
    }
    $toAdd = @()
    if ($keys -contains 'AddRequired:Sites.Selected') { $toAdd += [pscustomobject]@{ name = 'Sites.Selected'; id = $D.RoleIdByName['Sites.Selected']; type = 'Role' } }
    if ($keys -contains 'AddRequired:Mail.Send') { $toAdd += [pscustomobject]@{ name = 'Mail.Send'; id = $D.ScopeIdByName['Mail.Send']; type = 'Scope' } }
    if ($toAdd.Count) {
        $script:Step = $script:GStep = 'apply: add the API permissions to the app registration'
        $rra = @(); $hasGraph = $false
        foreach ($r in @($D.App.requiredResourceAccess)) {
            if (-not $r) { continue }
            $acc = @(@($r.resourceAccess) | Where-Object { $_ } | ForEach-Object { @{ id = $_.id; type = $_.type } })
            if ($r.resourceAppId -eq $script:GraphAppId) { $hasGraph = $true; foreach ($t in $toAdd) { $acc += @{ id = $t.id; type = $t.type } } }
            $rra += @{ resourceAppId = $r.resourceAppId; resourceAccess = $acc }
        }
        if (-not $hasGraph) { $rra += @{ resourceAppId = $script:GraphAppId; resourceAccess = @($toAdd | ForEach-Object { @{ id = $_.id; type = $_.type } }) } }
        [void](Invoke-TG PATCH ('/applications/' + $D.App.id) @{ requiredResourceAccess = $rra })
        $prev = @(); if ($State.created['requiredAccess']) { $prev = @($State.created['requiredAccess']) }
        $State.created['requiredAccess'] = @($prev) + @($toAdd | ForEach-Object { [ordered]@{ name = $_.name; id = $_.id; type = $_.type } })
        & $save ('added API permissions: ' + (($toAdd | ForEach-Object { $_.name }) -join ', '))
        W ('  done: API permissions added: ' + (($toAdd | ForEach-Object { "$($_.name) ($(if ($_.type -eq 'Role') { 'Application' } else { 'Delegated' }))" }) -join ', '))
    }
    if ($keys -contains 'GrantAppRole:Sites.Selected') {
        $script:Step = $script:GStep = 'apply: grant admin consent for Sites.Selected'
        $a = Invoke-TG POST ('/servicePrincipals/' + $D.AppSp.id + '/appRoleAssignments') @{ principalId = $D.AppSp.id; resourceId = $D.GraphSpId; appRoleId = $D.RoleIdByName['Sites.Selected'] }
        $State.created['appRoleAssignment'] = [ordered]@{ id = $a.id; servicePrincipalId = $D.AppSp.id; permission = 'Sites.Selected' }
        & $save 'admin consent Sites.Selected'
        W '  done: admin consent for Sites.Selected'
    }
    if ($keys -contains 'ExtendConsent:Mail.Send') {
        $script:Step = $script:GStep = 'apply: add Mail.Send to the tenant-wide consent'
        $g = $D.AllPrincipalsGrant
        $newScope = ((@(([string]$g.scope).Split(' ', [StringSplitOptions]::RemoveEmptyEntries)) + 'Mail.Send') -join ' ')
        [void](Invoke-TG PATCH ('/oauth2PermissionGrants/' + $g.id) @{ scope = $newScope })
        $State.created['consentScope'] = [ordered]@{ grantId = $g.id; added = 'Mail.Send' }
        & $save 'tenant-wide consent + Mail.Send'
        W '  done: Mail.Send added to the tenant-wide delegated consent'
    }
    if ($keys -contains 'CreateSite') {
        $script:Step = $script:GStep = 'apply: create the private SharePoint site'
        if ($D.NicknameTaken) { throw "A Microsoft 365 group already uses the alias '$($Cfg.SiteName)' ($($D.NicknameTaken.displayName)) but its site was not found at /sites/$($Cfg.SiteName). Nothing was created for the site. Pick another -SiteName or put the existing site in .env." }
        $body = @{ displayName = $Cfg.SiteDisplayName; mailNickname = $Cfg.SiteName; description = 'Copies of Trigon ERP documents (written by the ERP; managed in the ERP)'
            groupTypes = @('Unified'); mailEnabled = $true; securityEnabled = $false; visibility = 'Private'
            'owners@odata.bind' = @('https://graph.microsoft.com/v1.0/users/' + $D.Admin.Id) }
        $g = Invoke-TG POST '/groups' $body
        $State.created['site'] = [ordered]@{ groupId = $g.id; siteId = $null; name = $Cfg.SiteName }
        & $save 'created private group site (provisioning)'
        W "  done: private Microsoft 365 group '$($Cfg.SiteDisplayName)' created; waiting for its SharePoint site..."
        $site = $null
        for ($i = 0; $i -lt 40 -and -not $site; $i++) {
            $site = Get-TGOrNull ('/groups/' + $g.id + '/sites/root?$select=id,displayName,name,webUrl')
            if (-not $site) { & $script:Sleep 15 }
        }
        if (-not $site) { throw 'The group was created but SharePoint has not finished creating its site after 10 minutes. Wait a few minutes and run the same -Apply command again (it continues from here).' }
        $State.created['site'].siteId = $site.id
        & $save 'site ready'
        $D.Site = $site; $D.SiteSource = $null
        W "  done: site ready: $($site.webUrl)"
    }
    if ((-not $D.Library) -and ($keys -contains 'CreateLibrary')) {
        $script:Step = $script:GStep = "apply: create the '$($Cfg.LibraryName)' library"
        $l = Invoke-TG POST ('/sites/' + $D.Site.id + '/lists') @{ displayName = $Cfg.LibraryName; list = @{ template = 'documentLibrary' } }
        $drive = Invoke-TG GET ('/sites/' + $D.Site.id + '/lists/' + $l.id + '/drive?$select=id,name,webUrl')
        $D.Library = [ordered]@{ ListId = $l.id; DriveId = $drive.id; Name = $Cfg.LibraryName; WebUrl = $drive.webUrl }
        $State.created['library'] = [ordered]@{ siteId = $D.Site.id; listId = $l.id; driveId = $drive.id; name = $Cfg.LibraryName }
        & $save 'created library'
        W "  done: library created: $($drive.webUrl)"
    }
    if (($keys -contains 'CreateSiteGrant') -or ($keys -contains 'UpgradeSiteGrant')) {
        $script:Step = $script:GStep = 'apply: grant the app write on the site'
        if (@($D.SiteGrants).Count -eq 0) {
            $p = Invoke-TG POST ('/sites/' + $D.Site.id + '/permissions') @{ roles = @('write'); grantedToIdentities = @(@{ application = @{ id = $D.ClientId; displayName = $D.App.displayName } }) }
            $State.created['siteGrant'] = [ordered]@{ siteId = $D.Site.id; permissionId = $p.id; action = 'created'; previousRoles = @() }
        } else {
            $g = @($D.SiteGrants)[0]
            $p = Invoke-TG PATCH ('/sites/' + $D.Site.id + '/permissions/' + $g.Id) @{ roles = @('write') }
            if (-not $p -or -not $p.id) { $p = [pscustomobject]@{ id = $g.Id } }
            $State.created['siteGrant'] = [ordered]@{ siteId = $D.Site.id; permissionId = $g.Id; action = 'upgraded'; previousRoles = @($g.Roles) }
        }
        & $save 'site grant write'
        $chk = Invoke-TG GET ('/sites/' + $D.Site.id + '/permissions/' + $p.id)
        if ((Get-GrantLevel $chk.roles) -ne 2) { throw 'The site grant was created but reading it back does not show write' }
        W '  done: app has write on this site only (validated by reading the grant back)'
    }
}

# ---------------------------------------------------------------- setup entry point
function Invoke-TrigonM365Setup {
    param([hashtable]$Cfg)
    $script:Apply = [bool]$Cfg.Apply
    $script:Writes = New-Object System.Collections.ArrayList
    foreach ($k in @{ SiteName = 'TrigonERP'; SiteDisplayName = 'Trigon ERP Documents'; LibraryName = 'ERP Documents' }.GetEnumerator()) { if (-not $Cfg[$k.Key]) { $Cfg[$k.Key] = $k.Value } }
    if ($Cfg.SiteName -notmatch '^[A-Za-z0-9][A-Za-z0-9-]{1,59}$') { throw 'SiteName may contain only letters, digits and "-"' }
    $result = [ordered]@{ Overall = 'FAIL'; ExitCode = 2; Checks = @(); Plan = @(); Mode = $(if ($script:Apply) { 'APPLY' } else { 'DRY RUN' }) }
    $envInfo = Read-TrigonEnvSafe $Cfg.EnvPath
    if (-not $Cfg.ClientId -and $envInfo.Values['M365_CLIENT_ID']) { $Cfg.ClientId = $envInfo.Values['M365_CLIENT_ID'] }
    W ("Trigon ERP - Microsoft 365 provisioning (" + $result.Mode + ')')
    if (-not $script:Apply) { W 'DRY RUN: discovery and validation only. No Microsoft 365 change will be made. Use -Apply to make the changes.' }

    try { $d = Get-TrigonM365Discovery -Cfg $Cfg -EnvInfo $envInfo }
    catch {
        Write-TrigonGraphFailure $_ 'discovery (read-only)'
        W 'No change was made: discovery only reads from Microsoft 365.'
        $result.ExitCode = 2; $result.Overall = 'FAIL'; $result.Error = (Get-GraphErrorInfo $_ '' '' $script:GStep); return $result
    }
    Write-TrigonDiscovery $d $envInfo $Cfg
    $plan = New-TrigonPlan $d $Cfg
    $result.Plan = $plan
    Section 'Planned changes'
    if ((Get-ChangeCount $plan) -eq 0) { W 'None. Everything is already in place.' }
    foreach ($p in $plan) { if ($p.Key -eq 'ReuseSite') { W "  = $($p.Text)" } else { W "  + $($p.Text)" } }
    W '  (kept unchanged: every existing permission on the app, the client secret, existing site content, other sites)'
    W '  (never added: Sites.ReadWrite.All, Files.ReadWrite.All, Mail.ReadWrite, application Mail.Send, Teams Graph permissions)'

    if (-not $script:Apply) {
        $checks = Get-TrigonChecks $d $plan $Cfg $envInfo $false
        Section 'Current state (TODO = done by -Apply)'
        Write-TrigonChecks $checks
        Write-TrigonEnvBlock $d $Cfg $envInfo
        Write-TrigonManualSteps $d $Cfg
        $result.Checks = $checks
        $result.Overall = Get-Overall $checks
        $result.ExitCode = $(if ($result.Overall -eq 'PASS') { 0 } else { 1 })
        Section ('DRY RUN result: ' + $result.Overall + $(if ((Get-ChangeCount $plan) -gt 0) { " ($((Get-ChangeCount $plan)) change(s) waiting for -Apply)" } else { '' }))
        W 'No change was made.'
        return $result
    }

    $existing = Read-TrigonState $Cfg.StatePath
    if ($existing -and $existing.clientId -and $existing.clientId -ne $d.ClientId) { throw "The state file $($Cfg.StatePath) belongs to another app ($($existing.clientId)). Use -StatePath with a new file." }
    $state = New-TrigonStateObject $existing $d.Tenant.Id $d.ClientId
    if ((Get-ChangeCount $plan) -gt 0 -or ($plan | Where-Object { $_.Key -eq 'ReuseSite' })) {
        if (-not $Cfg.AssumeYes) {
            $a = & $script:Prompt 'Review the list above. Type APPLY to make these changes (anything else cancels)'
            if ([string]$a -cne 'APPLY') { W 'Cancelled. No change was made.'; $result.ExitCode = 3; $result.Overall = 'CANCELLED'; return $result }
        }
    }
    if ((Get-ChangeCount $plan) -gt 0) {
        Section 'Applying'
        try {
            Invoke-TrigonApplyPlan $d $plan $Cfg $state
            Save-TrigonState -State $state -Path $Cfg.StatePath -Event 'apply finished'
        } catch {
            $msg = Get-SafeError $_
            Write-TrigonGraphFailure $_ 'apply - partial failure'
            Section 'STOPPED - partial failure'
            W "Failed while trying to: $script:Step"
            try { Save-TrigonState -State $state -Path $Cfg.StatePath -Event ('failed: ' + $script:Step) } catch { W 'WARNING: the state file could not be written' }
            W 'Completed before the failure (recorded in the state file):'
            if ($state.created.Count) { foreach ($k in $state.created.Keys) { W "   - $k" } } else { W '   - nothing' }
            W "State file: $($Cfg.StatePath)"
            W 'Recovery:'
            W '   1. Fix the cause shown above (role, consent, network), then run the SAME -Apply command again: finished steps are found and reused, nothing is duplicated.'
            W '   2. Or undo what was created: scripts\rollback-m365-provisioning.ps1 (dry run first), then with -Apply.'
            W 'The ERP itself was not changed. Leave the M365_SHAREPOINT_* / M365_OUTLOOK_* settings off until the setup finishes with PASS.'
            $result.ExitCode = 2; $result.Overall = 'FAIL'; $result.Error = $msg
            return $result
        }
    } else { Save-TrigonState -State $state -Path $Cfg.StatePath -Event 'verified (no changes needed)' }

    Section 'Verification (fresh read from Microsoft 365)'
    try { $d2 = Get-TrigonM365Discovery -Cfg $Cfg -EnvInfo $envInfo }
    catch {
        Write-TrigonGraphFailure $_ 'verification (read-only)'
        W 'The changes listed under "Applying" were made; the verification read failed. Run the same command again (it only verifies when nothing is missing).'
        $result.ExitCode = 2; $result.Overall = 'FAIL'; return $result
    }
    $plan2 = New-TrigonPlan $d2 $Cfg
    $checks = Get-TrigonChecks $d2 $plan2 $Cfg $envInfo $true
    Write-TrigonChecks $checks
    Write-TrigonEnvBlock $d2 $Cfg $envInfo
    Write-TrigonManualSteps $d2 $Cfg
    $result.Checks = $checks
    $result.Overall = Get-Overall $checks
    $result.ExitCode = $(if ($result.Overall -eq 'PASS') { 0 } else { 1 })
    Section ('RESULT: ' + $result.Overall)
    W "State file (IDs only, used by the rollback): $($Cfg.StatePath)"
    return $result
}

# ---------------------------------------------------------------- rollback entry point
function Invoke-TrigonM365Rollback {
    param([hashtable]$Cfg)
    $script:Apply = [bool]$Cfg.Apply
    $script:Writes = New-Object System.Collections.ArrayList
    $result = [ordered]@{ ExitCode = 2; Actions = @(); Refused = @() }
    W ('Trigon ERP - Microsoft 365 provisioning ROLLBACK (' + $(if ($script:Apply) { 'APPLY' } else { 'DRY RUN' }) + ')')
    $state = Read-TrigonState $Cfg.StatePath
    if (-not $state -or -not $state.created) { W "No provisioning state at $($Cfg.StatePath): nothing was recorded as created by the setup, so nothing is removed."; $result.ExitCode = 0; return $result }
    $c = $state.created
    Set-TGStep 'rollback: tenant discovery (GET /organization)'
    $org = @((Invoke-TG GET '/organization?$select=id,displayName').value)[0]
    if ($state.tenantId -and $org.id -ne $state.tenantId) { throw "Signed in to tenant $($org.id) but the state file is for $($state.tenantId). Sign in to the right tenant." }
    W "Tenant: $($org.displayName). The app registration itself is never deleted. Uploaded ERP documents are never deleted automatically."

    $actions = New-Object System.Collections.ArrayList
    $refused = New-Object System.Collections.ArrayList
    $add = { param($k, $t, $destructive) [void]$actions.Add([pscustomobject]@{ Key = $k; Text = $t; Destructive = [bool]$destructive }) }

    if ($c.siteGrant -and -not $c.siteGrant.removed) {
        Set-TGStep 'rollback: site grant lookup'
        $p = Get-TGOrNull ('/sites/' + $c.siteGrant.siteId + '/permissions/' + $c.siteGrant.permissionId)
        if ($p) {
            if ($c.siteGrant.action -eq 'created') { & $add 'siteGrant' 'Remove the app''s write grant on the Trigon site (created by the setup)' $false }
            elseif (@($c.siteGrant.previousRoles).Count) { & $add 'siteGrant' ('Change the app''s grant on the site back to: ' + (@($c.siteGrant.previousRoles) -join ', ')) $false }
        }
    }
    if ($c.appRoleAssignment -and -not $c.appRoleAssignment.removed) { & $add 'appRoleAssignment' 'Remove the admin consent for Sites.Selected (created by the setup)' $false }
    if ($c.consentScope -and -not $c.consentScope.removed) { & $add 'consentScope' 'Remove Mail.Send from the tenant-wide delegated consent (added by the setup)' $false }
    if ($c.requiredAccess -and -not $state.requiredAccessRemoved) { & $add 'requiredAccess' ('Remove from the app registration the API permissions the setup added: ' + ((@($c.requiredAccess) | ForEach-Object { $_.name }) -join ', ')) $false }
    $libEmpty = $null
    if ($c.library -and -not $c.library.removed) {
        Set-TGStep 'rollback: library content check'
        $items = Get-TGOrNull ('/drives/' + $c.library.driveId + '/root/children?$top=1&$select=id')
        $libEmpty = -not ($items -and @($items.value).Count)
        if (-not $Cfg.RemoveCreatedSharePoint) { [void]$refused.Add("Library '$($c.library.name)' is kept (pass -RemoveCreatedSharePoint to remove it when it is empty).") }
        elseif (-not $libEmpty) { [void]$refused.Add("Library '$($c.library.name)' is NOT removed: it contains files (uploaded ERP documents are never deleted automatically). Move or delete them by hand first if you really want it gone.") }
        else { & $add 'library' "DELETE the empty library '$($c.library.name)' (created by the setup)" $true }
    }
    if ($c.site -and $c.site.groupId -and -not $c.site.removed) {
        if (-not $Cfg.RemoveCreatedSharePoint) { [void]$refused.Add("Site '$($c.site.name)' is kept (pass -RemoveCreatedSharePoint to remove it when it is empty).") }
        else {
            $hasFiles = $false
            Set-TGStep 'rollback: site content check'
            if ($c.site.siteId) {
                foreach ($dv in @(Get-TGAll ('/sites/' + $c.site.siteId + '/drives?$select=id'))) {
                    if ($c.library -and $dv.id -eq $c.library.driveId -and $libEmpty) { continue }
                    $it = Get-TGOrNull ('/drives/' + $dv.id + '/root/children?$top=1&$select=id')
                    if ($it -and @($it.value).Count) { $hasFiles = $true }
                }
            }
            if ($hasFiles -or $libEmpty -eq $false) { [void]$refused.Add("Site '$($c.site.name)' is NOT removed: it contains files.") }
            else { & $add 'site' "DELETE the empty site '$($c.site.name)' (its Microsoft 365 group; restorable for 30 days from Entra > Groups > Deleted groups)" $true }
        }
    }
    if ($c.servicePrincipal) { [void]$refused.Add('The enterprise application created by the setup is kept (sign-in needs it).') }

    Section 'Rollback plan'
    if ($actions.Count -eq 0) { W 'Nothing to remove.' }
    foreach ($a in $actions) { W "  - $($a.Text)" }
    foreach ($r in $refused) { W "  (kept) $r" }
    W 'Before an Apply: set M365_SHAREPOINT_ENABLED=0 and M365_OUTLOOK_ENABLED=0 in C:\ERP\.env and restart the ERP.'
    W 'Users who already consented to Mail.Send keep that consent in their own Microsoft account until they Disconnect in the ERP.'
    $result.Actions = @($actions); $result.Refused = @($refused)
    if (-not $script:Apply) { W ''; W 'DRY RUN: no change was made. Run again with -Apply to remove the items above.'; $result.ExitCode = 0; return $result }
    if ($actions.Count -eq 0) { $result.ExitCode = 0; return $result }

    $nd = @($actions | Where-Object { -not $_.Destructive })
    if ($nd.Count -and -not $Cfg.AssumeYes) {
        $ans = & $script:Prompt 'Type ROLLBACK to remove the permissions listed above (anything else cancels)'
        if ([string]$ans -cne 'ROLLBACK') { W 'Cancelled. No change was made.'; $result.ExitCode = 3; return $result }
    }
    $step = ''
    try {
        foreach ($a in $actions) {
            $step = $a.Text; Set-TGStep ('rollback: ' + $a.Text)
            switch ($a.Key) {
                'siteGrant' {
                    if ($c.siteGrant.action -eq 'created') { [void](Invoke-TG DELETE ('/sites/' + $c.siteGrant.siteId + '/permissions/' + $c.siteGrant.permissionId)) }
                    else { [void](Invoke-TG PATCH ('/sites/' + $c.siteGrant.siteId + '/permissions/' + $c.siteGrant.permissionId) @{ roles = @($c.siteGrant.previousRoles) }) }
                    $c.siteGrant | Add-Member -NotePropertyName removed -NotePropertyValue $true -Force
                }
                'appRoleAssignment' {
                    try { [void](Invoke-TG DELETE ('/servicePrincipals/' + $c.appRoleAssignment.servicePrincipalId + '/appRoleAssignments/' + $c.appRoleAssignment.id)) } catch { if ((Get-TGStatus $_) -ne 404) { throw } }
                    $c.appRoleAssignment | Add-Member -NotePropertyName removed -NotePropertyValue $true -Force
                }
                'consentScope' {
                    $g = Get-TGOrNull ('/oauth2PermissionGrants/' + $c.consentScope.grantId)
                    if ($g) {
                        $sc = @(([string]$g.scope).Split(' ', [StringSplitOptions]::RemoveEmptyEntries) | Where-Object { $_ -ne 'Mail.Send' }) -join ' '
                        [void](Invoke-TG PATCH ('/oauth2PermissionGrants/' + $c.consentScope.grantId) @{ scope = $sc })
                    }
                    $c.consentScope | Add-Member -NotePropertyName removed -NotePropertyValue $true -Force
                }
                'requiredAccess' {
                    $ids = @(@($c.requiredAccess) | ForEach-Object { "$($_.type)|$($_.id)" })
                    $app = @(Get-TGAll ('/applications?' + (Q "appId eq '$($state.clientId)'") + '&$select=id,appId,requiredResourceAccess'))[0]
                    if (-not $app) { throw 'The app registration was not found' }
                    $rra = @()
                    foreach ($r in @($app.requiredResourceAccess)) {
                        if (-not $r) { continue }
                        $acc = @(@($r.resourceAccess) | Where-Object { $_ -and -not ($r.resourceAppId -eq $script:GraphAppId -and $ids -contains "$($_.type)|$($_.id)") } | ForEach-Object { @{ id = $_.id; type = $_.type } })
                        $rra += @{ resourceAppId = $r.resourceAppId; resourceAccess = $acc }
                    }
                    [void](Invoke-TG PATCH ('/applications/' + $app.id) @{ requiredResourceAccess = $rra })
                    $state | Add-Member -NotePropertyName requiredAccessRemoved -NotePropertyValue $true -Force
                }
                'library' {
                    $ans = & $script:Prompt "Type DELETE $($c.library.name) to delete the empty library"
                    if ([string]$ans -cne "DELETE $($c.library.name)") { W '  library kept (not confirmed)'; continue }
                    [void](Invoke-TG DELETE ('/sites/' + $c.library.siteId + '/lists/' + $c.library.listId))
                    $c.library | Add-Member -NotePropertyName removed -NotePropertyValue $true -Force
                }
                'site' {
                    $ans = & $script:Prompt "Type DELETE $($c.site.name) to delete the empty site and its group"
                    if ([string]$ans -cne "DELETE $($c.site.name)") { W '  site kept (not confirmed)'; continue }
                    [void](Invoke-TG DELETE ('/groups/' + $c.site.groupId))
                    $c.site | Add-Member -NotePropertyName removed -NotePropertyValue $true -Force
                }
            }
            $state.history = @($state.history) + @([ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); event = 'rollback: ' + $a.Key })
            [IO.File]::WriteAllText($Cfg.StatePath, (ConvertTo-Json -InputObject $state -Depth 12))
            W "  done: $($a.Text)"
        }
    } catch {
        Write-TrigonGraphFailure $_ 'rollback'
        W "STOPPED while trying to: $step"
        W 'The state file records what was already removed; fix the cause and run the same rollback command again.'
        $result.ExitCode = 2; return $result
    }
    W 'Rollback finished.'
    $result.ExitCode = 0
    return $result
}

Export-ModuleMember -Function Write-TrigonGraphFailure, Get-GraphErrorInfo, Invoke-TrigonM365Setup, Invoke-TrigonM365Rollback, Set-TrigonProvisioningHooks, Get-TrigonWrites, Protect-TrigonText, Test-TrigonSiteId, Test-TrigonDriveId, Test-TrigonWebUrl, Read-TrigonEnvSafe
