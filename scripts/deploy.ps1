[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$FunctionName = 'friday-football-bot'
$DatabaseName = 'friday-football-bot-db'
$ServiceAccountName = 'friday-football-bot-runtime'
$TriggerName = 'friday-football-bot-every-minute'
$CronExpression = '* * * * ? *'
$TriggerPayload = 'tick'
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Require-EnvironmentValue {
    param([Parameter(Mandatory)][string] $Name)
    $Value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Name must be set in the current PowerShell process."
    }
    return $Value.Trim()
}

function Invoke-YcQuiet {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $Description
    )
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & yc @Arguments *> $null
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($ExitCode -ne 0) {
        throw "$Description failed."
    }
}

function Invoke-YcText {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $Description
    )
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $Output = & yc @Arguments 2>$null
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($ExitCode -ne 0) {
        throw "$Description failed."
    }
    return ($Output -join "`n").Trim()
}

function Get-YcJsonOrNull {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $Description
    )
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $Output = & yc @Arguments 2>&1
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    $Text = ($Output | ForEach-Object { $_.ToString() }) -join "`n"
    if ($ExitCode -eq 0) {
        try {
            return $Text | ConvertFrom-Json
        }
        catch {
            throw "$Description returned invalid JSON."
        }
    }
    if ($Text -match '(?i)(not[ _-]?found|does not exist)') {
        return $null
    }
    throw "$Description failed."
}

function Wait-FunctionVersionActive {
    param([Parameter(Mandatory)][string] $VersionId)
    $Deadline = [DateTime]::UtcNow.AddMinutes(5)
    do {
        $Version = Get-YcJsonOrNull @('serverless', 'function', 'version', 'get', $VersionId, '--format', 'json') 'Function version status lookup'
        if ($null -eq $Version) {
            throw 'The newly created function version was not found.'
        }
        if ($Version.status -eq 'ACTIVE') {
            return $Version
        }
        if ($Version.status -eq 'FAILED') {
            throw 'The new function version entered FAILED status.'
        }
        Start-Sleep -Seconds 5
    } while ([DateTime]::UtcNow -lt $Deadline)
    throw 'Timed out waiting for the function version to become ACTIVE.'
}

function Invoke-WebhookProbe {
    param(
        [Parameter(Mandatory)][string] $Url,
        [Parameter(Mandatory)][string] $Secret,
        [Parameter(Mandatory)][int] $ExpectedStatus
    )
    $Client = [System.Net.Http.HttpClient]::new()
    $Request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $Url)
    try {
        [void]$Request.Headers.TryAddWithoutValidation('X-Telegram-Bot-Api-Secret-Token', $Secret)
        $Request.Content = [System.Net.Http.StringContent]::new('{"update_id":-1}', [Text.Encoding]::UTF8, 'application/json')
        $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
        try {
            if ([int]$Response.StatusCode -ne $ExpectedStatus) {
                throw "Candidate probe returned HTTP $([int]$Response.StatusCode); expected $ExpectedStatus."
            }
        }
        finally {
            $Response.Dispose()
        }
    }
    finally {
        $Request.Dispose()
        $Client.Dispose()
    }
}

$BotToken = Require-EnvironmentValue 'BOT_TOKEN'
$WebhookSecret = Require-EnvironmentValue 'WEBHOOK_SECRET'
$AdminIds = Require-EnvironmentValue 'ADMIN_IDS'
if ($WebhookSecret -notmatch '^[A-Za-z0-9_-]{16,256}$') {
    throw 'WEBHOOK_SECRET must contain 16-256 letters, digits, underscores, or hyphens.'
}
if ($AdminIds -notmatch '^-?\d+(,-?\d+)*$') {
    throw 'ADMIN_IDS must be a comma-separated list of numeric Telegram user IDs.'
}

$FolderId = Invoke-YcText @('config', 'get', 'folder-id') 'Folder configuration lookup'
if ([string]::IsNullOrWhiteSpace($FolderId)) {
    throw 'yc has no active folder-id.'
}

Push-Location -LiteralPath $RepositoryRoot
try {
    $ServiceAccount = Get-YcJsonOrNull @('iam', 'service-account', 'get', '--name', $ServiceAccountName, '--format', 'json') 'Service account lookup'
    if ($null -eq $ServiceAccount) {
        Invoke-YcQuiet @('iam', 'service-account', 'create', '--name', $ServiceAccountName) 'Service account creation'
        $ServiceAccount = Get-YcJsonOrNull @('iam', 'service-account', 'get', '--name', $ServiceAccountName, '--format', 'json') 'Created service account lookup'
    }
    $ServiceAccountId = [string]$ServiceAccount.id

    $Database = Get-YcJsonOrNull @('ydb', 'database', 'get', $DatabaseName, '--format', 'json') 'YDB database lookup'
    if ($null -eq $Database) {
        Invoke-YcQuiet @('ydb', 'database', 'create', $DatabaseName, '--serverless', '--sls-provisioned-rcu', '0', '--sls-storage-size', '1GB', '--deletion-protection') 'YDB database creation'
        $Database = Get-YcJsonOrNull @('ydb', 'database', 'get', $DatabaseName, '--format', 'json') 'Created YDB database lookup'
    }
    $YdbConnectionString = [string]$Database.endpoint
    if ([string]::IsNullOrWhiteSpace($YdbConnectionString)) {
        throw 'The YDB database did not return an endpoint.'
    }
    Invoke-YcQuiet @('ydb', 'database', 'add-access-binding', $DatabaseName, '--role', 'ydb.editor', '--service-account-id', $ServiceAccountId) 'YDB role binding'

    $Function = Get-YcJsonOrNull @('serverless', 'function', 'get', $FunctionName, '--format', 'json') 'Function lookup'
    if ($null -eq $Function) {
        Invoke-YcQuiet @('serverless', 'function', 'create', '--name', $FunctionName) 'Function creation'
        $Function = Get-YcJsonOrNull @('serverless', 'function', 'get', $FunctionName, '--format', 'json') 'Created function lookup'
    }
    $FunctionId = [string]$Function.id

    & (Join-Path $PSScriptRoot 'package-function.ps1')

    $PreviousYdbConnectionString = [Environment]::GetEnvironmentVariable('YDB_CONNECTION_STRING', 'Process')
    try {
        $env:YDB_CONNECTION_STRING = $YdbConnectionString
        $env:YDB_ACCESS_TOKEN_CREDENTIALS = Invoke-YcText @('iam', 'create-token') 'Short-lived IAM token creation'
        $PreviousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & npm.cmd run migrate *> $null
            $MigrationExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }
        if ($MigrationExitCode -ne 0) {
            throw 'YDB migration failed.'
        }
    }
    finally {
        Remove-Item Env:YDB_ACCESS_TOKEN_CREDENTIALS -ErrorAction SilentlyContinue
        if ($null -eq $PreviousYdbConnectionString) {
            Remove-Item Env:YDB_CONNECTION_STRING -ErrorAction SilentlyContinue
        }
        else {
            $env:YDB_CONNECTION_STRING = $PreviousYdbConnectionString
        }
    }

    $PreviousStable = Get-YcJsonOrNull @('serverless', 'function', 'version', 'get-by-tag', '--function-name', $FunctionName, '--tag', 'stable', '--format', 'json') 'Stable version lookup'
    $PreviousStableVersionId = if ($null -eq $PreviousStable) { $null } else { [string]$PreviousStable.id }

    $Environment = "BOT_TOKEN=$BotToken,WEBHOOK_SECRET=$WebhookSecret,ADMIN_IDS=$AdminIds,YDB_CONNECTION_STRING=$YdbConnectionString,YDB_METADATA_CREDENTIALS=1"
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $VersionOutput = & yc serverless function version create `
            --function-name $FunctionName `
            --runtime nodejs22 `
            --entrypoint dist/handler.handler `
            --memory 256MB `
            --execution-timeout 15s `
            --concurrency 1 `
            --service-account-id $ServiceAccountId `
            --source-path '.artifacts/function.zip' `
            --environment $Environment `
            --format json 2>$null
        $VersionExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($VersionExitCode -ne 0) {
        throw 'Function version creation failed.'
    }
    try {
        $NewVersion = ($VersionOutput -join "`n") | ConvertFrom-Json
    }
    catch {
        throw 'Function version creation returned invalid JSON.'
    }
    $NewVersionId = [string]$NewVersion.id
    $ActiveVersion = Wait-FunctionVersionActive $NewVersionId
    Write-Output "Function ID: $FunctionId"
    Write-Output "Version ID: $NewVersionId"
    Write-Output "Version status: $($ActiveVersion.status)"

    Invoke-YcQuiet @('serverless', 'function', 'version', 'set-tag', '--id', $NewVersionId, '--tag', 'candidate') 'Candidate tag update'
    Invoke-YcQuiet @('serverless', 'function', 'allow-unauthenticated-invoke', $FunctionName) 'Public webhook access update'

    $CandidateUrl = "https://functions.yandexcloud.net/$FunctionId`?tag=candidate"
    $WrongSecretBytes = [byte[]]::new(24)
    $Random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $Random.GetBytes($WrongSecretBytes)
    }
    finally {
        $Random.Dispose()
    }
    $WrongSecret = [Convert]::ToBase64String($WrongSecretBytes).TrimEnd('=').Replace('+', '_').Replace('/', '-')
    Invoke-WebhookProbe $CandidateUrl $WrongSecret 403
    Invoke-WebhookProbe $CandidateUrl $WebhookSecret 200

    Invoke-YcQuiet @('serverless', 'function', 'version', 'set-tag', '--id', $NewVersionId, '--tag', 'stable') 'Stable tag update'
    Invoke-YcQuiet @('serverless', 'function', 'add-access-binding', $FunctionName, '--role', 'functions.functionInvoker', '--service-account-id', $ServiceAccountId) 'Private timer invocation binding'

    $Trigger = Get-YcJsonOrNull @('serverless', 'trigger', 'get', $TriggerName, '--format', 'json') 'Timer trigger lookup'
    if ($null -eq $Trigger) {
        Invoke-YcQuiet @('serverless', 'trigger', 'create', 'timer', '--name', $TriggerName, '--cron-expression', $CronExpression, '--payload', $TriggerPayload, '--invoke-function-name', $FunctionName, '--invoke-function-tag', 'stable', '--invoke-function-service-account-id', $ServiceAccountId) 'Timer trigger creation'
    }
    else {
        Invoke-YcQuiet @('serverless', 'trigger', 'update', 'timer', $TriggerName, '--new-cron-expression', $CronExpression, '--new-payload', $TriggerPayload, '--new-invoke-function-name', $FunctionName, '--new-invoke-function-tag', 'stable', '--new-invoke-function-service-account-id', $ServiceAccountId) 'Timer trigger convergence'
    }

    $env:FUNCTION_URL = "https://functions.yandexcloud.net/$FunctionId`?tag=stable"
    & node scripts/set-webhook.mjs
    if ($LASTEXITCODE -ne 0) {
        throw 'Telegram webhook setup failed.'
    }

    Write-Output "Stable URL: $env:FUNCTION_URL"
    Write-Output "New version ID: $NewVersionId"
    if (-not [string]::IsNullOrWhiteSpace($PreviousStableVersionId)) {
        Write-Output "Previous stable version ID: $PreviousStableVersionId"
        Write-Output "Rollback: yc serverless function version set-tag --id $PreviousStableVersionId --tag stable"
    }
    Write-Output 'Next manual action: /setup'
}
finally {
    Pop-Location
}
