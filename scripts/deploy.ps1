[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http

$FunctionName = 'friday-football-bot'
$DatabaseName = 'friday-football-bot-db'
$ServiceAccountName = 'friday-football-bot-runtime'
$TriggerName = 'friday-football-bot-every-minute'
$CloudflareWebhookUrl = 'https://friday-football-bot-ingress.football-sergei.workers.dev/telegram'
$CloudflareTelegramApiUrl = 'https://friday-football-bot-ingress.football-sergei.workers.dev/telegram-api'
$CronExpression = '* * * * ? *'
$TriggerPayload = 'tick'
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
. (Join-Path $PSScriptRoot 'deploy-helpers.ps1')

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
    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = $false
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.Timeout = [TimeSpan]::FromSeconds(90)
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
        $Handler.Dispose()
    }
}

function Invoke-TelegramBotApiJson {
    param(
        [Parameter(Mandatory)][string] $BotToken,
        [Parameter(Mandatory)][string] $MethodName,
        [AllowNull()][object] $Body
    )
    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = $false
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.Timeout = [TimeSpan]::FromSeconds(20)
    $Request = $null
    $Response = $null
    try {
        $Method = if ($null -eq $Body) {
            [System.Net.Http.HttpMethod]::Get
        }
        else {
            [System.Net.Http.HttpMethod]::Post
        }
        $Request = [System.Net.Http.HttpRequestMessage]::new(
            $Method,
            "https://api.telegram.org/bot$BotToken/$MethodName"
        )
        if ($null -ne $Body) {
            $BodyJson = $Body | ConvertTo-Json -Compress
            $Request.Content = [System.Net.Http.StringContent]::new(
                $BodyJson,
                [Text.Encoding]::UTF8,
                'application/json'
            )
        }
        $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
        if ([int]$Response.StatusCode -ne 200) {
            throw 'Unexpected Telegram status.'
        }
        $ResponseJson = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $Payload = $ResponseJson | ConvertFrom-Json
        if ($Payload.ok -ne $true) {
            throw 'Telegram rejected the request.'
        }
        return $Payload
    }
    catch {
        throw 'Telegram Bot API deployment request failed.'
    }
    finally {
        if ($null -ne $Response) {
            $Response.Dispose()
        }
        if ($null -ne $Request) {
            $Request.Dispose()
        }
        $Client.Dispose()
        $Handler.Dispose()
    }
}

function Get-TelegramWebhookUrl {
    param([Parameter(Mandatory)][string] $BotToken)
    $Payload = Invoke-TelegramBotApiJson $BotToken 'getWebhookInfo' $null
    if ($null -eq $Payload.result) {
        throw 'Telegram webhook lookup returned an invalid result.'
    }
    return [string]$Payload.result.url
}

function Set-TelegramWebhookConfiguration {
    param(
        [Parameter(Mandatory)][string] $BotToken,
        [Parameter(Mandatory)][string] $WebhookSecret,
        [Parameter(Mandatory)][string] $WebhookUrl
    )
    $ParsedUrl = $null
    if (
        -not [Uri]::TryCreate($WebhookUrl, [UriKind]::Absolute, [ref]$ParsedUrl) -or
        $ParsedUrl.Scheme -ne 'https'
    ) {
        throw 'Previous Telegram webhook URL is invalid.'
    }
    [void](Invoke-TelegramBotApiJson $BotToken 'setWebhook' @{
        url = $ParsedUrl.ToString()
        secret_token = $WebhookSecret
        allowed_updates = @('message', 'callback_query')
        drop_pending_updates = $false
        max_connections = 1
    })
}

$BotToken = Require-EnvironmentValue 'BOT_TOKEN'
$WebhookSecret = Require-EnvironmentValue 'WEBHOOK_SECRET'
$AdminIds = Require-EnvironmentValue 'ADMIN_IDS'
if ($BotToken -notmatch '^\d{8,12}:[A-Za-z0-9_-]{30,}$') {
    throw 'BOT_TOKEN must be a valid token newly issued by BotFather.'
}
if ($WebhookSecret -notmatch '^[A-Za-z0-9_-]{16,256}$') {
    throw 'WEBHOOK_SECRET must contain 16-256 letters, digits, underscores, or hyphens.'
}
if ($AdminIds -notmatch '^-?\d+(,-?\d+)*$') {
    throw 'ADMIN_IDS must be a comma-separated list of numeric Telegram user IDs.'
}
$RuntimeAdminIds = ConvertTo-RuntimeAdminIds $AdminIds
$PreviousTelegramWebhookUrl = Get-TelegramWebhookUrl $BotToken

$FolderId = Invoke-YcText @('config', 'get', 'folder-id') 'Folder configuration lookup'
if ([string]::IsNullOrWhiteSpace($FolderId)) {
    throw 'yc has no active folder-id.'
}

$PreviousStableVersionId = $null
$PreviousWebhookSecret = $null
$CloudflarePreviousVersionId = $null
$CloudflareDeployed = $false
$WebhookSetupAttempted = $false
$StableMoved = $false
$FunctionId = ''
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
    }
    Invoke-YcQuiet @('ydb', 'database', 'update', $DatabaseName, '--serverless', '--sls-provisioned-rcu', '0', '--sls-storage-size', '1GB', '--deletion-protection') 'YDB database convergence'
    $Database = Get-YcJsonOrNull @('ydb', 'database', 'get', $DatabaseName, '--format', 'json') 'Converged YDB database lookup'
    if ($null -eq $Database) {
        throw 'The YDB database disappeared after configuration update.'
    }
    $DeletionProtectionProperty = $Database.PSObject.Properties['deletion_protection']
    if ($null -eq $DeletionProtectionProperty -or $DeletionProtectionProperty.Value -ne $true) {
        $YdbRestIamToken = Invoke-YcText @('iam', 'create-token') 'Short-lived IAM token creation for YDB configuration'
        try {
            [void](Set-YdbDeletionProtectionViaRest -DatabaseId ([string]$Database.id) -IamToken $YdbRestIamToken)
        }
        finally {
            $YdbRestIamToken = $null
        }
        $Database = Get-YcJsonOrNull @('ydb', 'database', 'get', $DatabaseName, '--format', 'json') 'REST-converged YDB database lookup'
        if ($null -eq $Database) {
            throw 'The YDB database disappeared after REST configuration update.'
        }
    }
    Assert-YdbDatabaseConfiguration $Database
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
    if ($null -ne $PreviousStable -and $null -ne $PreviousStable.environment) {
        $PreviousWebhookSecretProperty = $PreviousStable.environment.PSObject.Properties['WEBHOOK_SECRET']
        if ($null -ne $PreviousWebhookSecretProperty) {
            $PreviousWebhookSecret = [string]$PreviousWebhookSecretProperty.Value
        }
    }

    $Environment = "BOT_TOKEN=$BotToken,WEBHOOK_SECRET=$WebhookSecret,ADMIN_IDS=$RuntimeAdminIds,YDB_CONNECTION_STRING=$YdbConnectionString,YDB_METADATA_CREDENTIALS=1,TELEGRAM_API_BASE_URL=$CloudflareTelegramApiUrl"
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $VersionOutput = & yc serverless function version create `
            --function-name $FunctionName `
            --runtime nodejs22 `
            --entrypoint dist/handler.handler `
            --memory 256MB `
            --execution-timeout 35s `
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

    $PreviousYandexFunctionUrl = [Environment]::GetEnvironmentVariable('YANDEX_FUNCTION_URL', 'Process')
    try {
        $env:YANDEX_FUNCTION_URL = "https://functions.yandexcloud.net/$FunctionId`?tag=stable"
        $CloudflareDeployment = & (Join-Path $PSScriptRoot 'deploy-cloudflare.ps1')
        if ($null -eq $CloudflareDeployment) {
            throw 'Cloudflare ingress deployment failed.'
        }
        $CloudflarePreviousVersionId = [string]$CloudflareDeployment.PreviousVersionId
        $CloudflareDeployed = $true
        if ([string]$CloudflareDeployment.WorkerUrl -ne $CloudflareWebhookUrl) {
            throw 'Cloudflare ingress deployment returned an unexpected URL.'
        }
        $env:FUNCTION_URL = $CloudflareWebhookUrl
        $WebhookSetupAttempted = $true
        & node scripts/set-webhook.mjs
        if ($LASTEXITCODE -ne 0) {
            throw 'Telegram webhook setup failed.'
        }
    }
    finally {
        if ($null -eq $PreviousYandexFunctionUrl) {
            Remove-Item Env:YANDEX_FUNCTION_URL -ErrorAction SilentlyContinue
        }
        else {
            $env:YANDEX_FUNCTION_URL = $PreviousYandexFunctionUrl
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($PreviousStableVersionId)) {
        Write-Output "Previous stable version ID: $PreviousStableVersionId"
        Write-Output "Rollback: yc serverless function version set-tag --id $PreviousStableVersionId --tag stable"
    }
    else {
        Write-Output 'Previous stable version: none (first deployment); rollback tag is unavailable.'
    }
    Invoke-YcQuiet @('serverless', 'function', 'version', 'set-tag', '--id', $NewVersionId, '--tag', 'stable') 'Stable tag update'
    $StableMoved = $true
    Invoke-YcQuiet @('serverless', 'function', 'add-access-binding', $FunctionName, '--role', 'functions.functionInvoker', '--service-account-id', $ServiceAccountId) 'Private timer invocation binding'

    $Trigger = Get-YcJsonOrNull @('serverless', 'trigger', 'get', $TriggerName, '--format', 'json') 'Timer trigger lookup'
    if ($null -eq $Trigger) {
        Invoke-YcQuiet @('serverless', 'trigger', 'create', 'timer', '--name', $TriggerName, '--cron-expression', $CronExpression, '--payload', $TriggerPayload, '--invoke-function-name', $FunctionName, '--invoke-function-tag', 'stable', '--invoke-function-service-account-id', $ServiceAccountId) 'Timer trigger creation'
    }
    else {
        Invoke-YcQuiet @('serverless', 'trigger', 'update', 'timer', '--id', ([string]$Trigger.id), '--new-cron-expression', $CronExpression, '--new-payload', $TriggerPayload, '--new-invoke-function-name', $FunctionName, '--new-invoke-function-tag', 'stable', '--new-invoke-function-service-account-id', $ServiceAccountId) 'Timer trigger convergence'
    }

    Write-Output "Stable URL: $env:FUNCTION_URL"
    Write-Output "New version ID: $NewVersionId"
    if (-not [string]::IsNullOrWhiteSpace($PreviousStableVersionId)) {
        Write-Output "Previous stable version ID: $PreviousStableVersionId"
        Write-Output "Rollback: yc serverless function version set-tag --id $PreviousStableVersionId --tag stable"
    }
    Write-Output 'Next manual action: /setup'
}
catch {
    $OriginalError = $_
    if ($StableMoved) {
        if (-not [string]::IsNullOrWhiteSpace($PreviousStableVersionId)) {
            Write-Output "Previous stable version ID: $PreviousStableVersionId"
            Write-Output "Rollback: yc serverless function version set-tag --id $PreviousStableVersionId --tag stable"
        }
        else {
            Write-Output 'Previous stable version: none (first deployment); rollback tag is unavailable.'
        }
    }
    [void](Invoke-ProductionRollback `
        -StableMoved $StableMoved `
        -PreviousStableVersionId $PreviousStableVersionId `
        -CloudflareDeployed $CloudflareDeployed `
        -PreviousCloudflareVersionId $CloudflarePreviousVersionId `
        -WebhookSetupAttempted $WebhookSetupAttempted `
        -PreviousWebhookSecret $PreviousWebhookSecret `
        -PreviousWebhookUrl $PreviousTelegramWebhookUrl `
        -RestoredYandexFunctionUrl (Get-YandexFunctionStableUrl $FunctionId) `
        -YandexRollback {
            param($VersionId)
            Invoke-YcQuiet @(
                'serverless',
                'function',
                'version',
                'set-tag',
                '--id',
                $VersionId,
                '--tag',
                'stable'
            ) 'Automatic stable version rollback'
        } `
        -CloudflareRollback {
            param($VersionId)
            & (Join-Path $PSScriptRoot 'deploy-cloudflare.ps1') `
                -RollbackVersionId $VersionId
        } `
        -FirstCloudflareRollback {
            param($Secret, $YandexFunctionUrl)
            $ProcessWebhookSecret = [Environment]::GetEnvironmentVariable(
                'WEBHOOK_SECRET',
                'Process'
            )
            $ProcessYandexFunctionUrl = [Environment]::GetEnvironmentVariable(
                'YANDEX_FUNCTION_URL',
                'Process'
            )
            try {
                $env:WEBHOOK_SECRET = $Secret
                $env:YANDEX_FUNCTION_URL = $YandexFunctionUrl
                & (Join-Path $PSScriptRoot 'deploy-cloudflare.ps1') `
                    -RestoreSecretsOnly
            }
            finally {
                if ($null -eq $ProcessWebhookSecret) {
                    Remove-Item Env:WEBHOOK_SECRET -ErrorAction SilentlyContinue
                }
                else {
                    $env:WEBHOOK_SECRET = $ProcessWebhookSecret
                }
                if ($null -eq $ProcessYandexFunctionUrl) {
                    Remove-Item Env:YANDEX_FUNCTION_URL -ErrorAction SilentlyContinue
                }
                else {
                    $env:YANDEX_FUNCTION_URL = $ProcessYandexFunctionUrl
                }
            }
        } `
        -TelegramRollback {
            param($Secret, $Url)
            Set-TelegramWebhookConfiguration $BotToken $Secret $Url
        }
    )
    throw $OriginalError
}
finally {
    Pop-Location
}
