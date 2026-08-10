[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')]
    [string] $RollbackVersionId,
    [switch] $RestoreSecretsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
. (Join-Path $PSScriptRoot 'deploy-helpers.ps1')

$QueueName = 'friday-football-bot-updates'
$DeadLetterQueueName = 'friday-football-bot-updates-dlq'
$WorkerBaseUrl = 'https://friday-football-bot-ingress.football-sergei.workers.dev'
$WorkerUrl = "$WorkerBaseUrl/telegram"
$TelegramGatewayProbeUrl = "$WorkerBaseUrl/telegram-api/getMe"
$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$LocalWrangler = Join-Path $RepositoryRoot 'node_modules\.bin\wrangler.cmd'
if (-not (Test-Path -LiteralPath $LocalWrangler -PathType Leaf)) {
    throw 'The pinned Wrangler is missing. Run npm ci and wrangler login.'
}
$Wrangler = (Get-Item -LiteralPath $LocalWrangler).FullName

function Require-EnvironmentValue {
    param([Parameter(Mandatory)][string] $Name)
    $Value = [Environment]::GetEnvironmentVariable($Name, 'Process')
    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Name must be set in the current PowerShell process."
    }
    return $Value.Trim()
}

function Invoke-WranglerQuiet {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $FailureMessage
    )
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Wrangler @Arguments *> $null
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($ExitCode -ne 0) {
        throw $FailureMessage
    }
}

function Get-CurrentWorkerVersionId {
    $StdoutPath = [IO.Path]::GetTempFileName()
    $StderrPath = [IO.Path]::GetTempFileName()
    try {
        $PreviousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $Wrangler deployments list --json 1> $StdoutPath 2> $StderrPath
            $ExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }
        if ($ExitCode -ne 0) {
            $DiagnosticText = [IO.File]::ReadAllText($StderrPath)
            if ($DiagnosticText -match 'code:\s*10007') {
                return $null
            }
            throw 'Cloudflare Worker deployment lookup failed.'
        }
        try {
            $ParsedDeployments = [IO.File]::ReadAllText($StdoutPath) |
                ConvertFrom-Json
            $Deployments = @($ParsedDeployments | ForEach-Object { $_ })
        }
        catch {
            throw 'Cloudflare Worker deployment lookup returned invalid JSON.'
        }
        if ($Deployments.Count -eq 0) {
            return $null
        }
        $CurrentDeployment = $Deployments |
            Sort-Object { [DateTime]$_.created_on } |
            Select-Object -Last 1
        $CurrentVersion = @($CurrentDeployment.versions) |
            Sort-Object { [double]$_.percentage } |
            Select-Object -Last 1
        $VersionId = [string]$CurrentVersion.version_id
        if ($VersionId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') {
            throw 'Cloudflare Worker deployment lookup returned an invalid version.'
        }
        return $VersionId
    }
    finally {
        Remove-Item -LiteralPath $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Ensure-Queue {
    param([Parameter(Mandatory)][string] $Name)
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $Wrangler queues info $Name *> $null
        $LookupExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($LookupExitCode -ne 0) {
        Invoke-WranglerQuiet @('queues', 'create', $Name) "Cloudflare queue $Name creation failed."
    }
}

function Set-WorkerSecrets {
    param(
        [Parameter(Mandatory)][string] $WebhookSecret,
        [Parameter(Mandatory)][string] $YandexFunctionUrl,
        [Parameter(Mandatory)][string] $BotToken
    )
    $SecretsJson = @{
        WEBHOOK_SECRET = $WebhookSecret
        YANDEX_FUNCTION_URL = $YandexFunctionUrl
        BOT_TOKEN = $BotToken
    } | ConvertTo-Json -Compress
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        Invoke-CloudflareSecretUpdateWithRetry -UpdateInvoker {
            $SecretsJson | & $Wrangler secret bulk *> $null
            return $LASTEXITCODE
        }
    }
    finally {
        $SecretsJson = $null
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
}

function Invoke-TelegramGatewayProbe {
    param([Parameter(Mandatory)][string] $Secret)
    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = $false
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.Timeout = [TimeSpan]::FromSeconds(20)
    $Request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::Post,
        $TelegramGatewayProbeUrl
    )
    $Response = $null
    try {
        [void]$Request.Headers.TryAddWithoutValidation(
            'X-Telegram-Bot-Api-Secret-Token',
            $Secret
        )
        $Request.Content = [System.Net.Http.StringContent]::new(
            '{}',
            [Text.Encoding]::UTF8,
            'application/json'
        )
        $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
        if ([int]$Response.StatusCode -ne 200) {
            throw 'Cloudflare Telegram gateway probe failed.'
        }
        $Payload = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult() |
            ConvertFrom-Json
        if ($Payload.ok -ne $true) {
            throw 'Cloudflare Telegram gateway probe failed.'
        }
    }
    catch {
        throw 'Cloudflare Telegram gateway probe failed.'
    }
    finally {
        if ($null -ne $Response) {
            $Response.Dispose()
        }
        $Request.Dispose()
        $Client.Dispose()
        $Handler.Dispose()
    }
}

function Invoke-WorkerProbe {
    param(
        [Parameter(Mandatory)][string] $Secret,
        [Parameter(Mandatory)][int] $ExpectedStatus
    )
    $Handler = [System.Net.Http.HttpClientHandler]::new()
    $Handler.AllowAutoRedirect = $false
    $Client = [System.Net.Http.HttpClient]::new($Handler)
    $Client.Timeout = [TimeSpan]::FromSeconds(20)
    $Request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::Post,
        $WorkerUrl
    )
    try {
        [void]$Request.Headers.TryAddWithoutValidation(
            'X-Telegram-Bot-Api-Secret-Token',
            $Secret
        )
        $Request.Content = [System.Net.Http.StringContent]::new(
            '{"update_id":-1}',
            [Text.Encoding]::UTF8,
            'application/json'
        )
        $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
        try {
            if ([int]$Response.StatusCode -ne $ExpectedStatus) {
                throw "Cloudflare Worker probe expected HTTP $ExpectedStatus."
            }
        }
        finally {
            $Response.Dispose()
        }
    }
    catch {
        throw "Cloudflare Worker probe expected HTTP $ExpectedStatus."
    }
    finally {
        $Request.Dispose()
        $Client.Dispose()
        $Handler.Dispose()
    }
}

Push-Location -LiteralPath $RepositoryRoot
try {
    if (-not [string]::IsNullOrWhiteSpace($RollbackVersionId)) {
        if ($RestoreSecretsOnly) {
            throw 'Choose either Worker rollback or secret restoration.'
        }
        Invoke-WranglerQuiet @(
            'rollback',
            $RollbackVersionId,
            '--yes',
            '--message',
            'Automatic rollback after failed football bot deployment'
        ) 'Cloudflare Worker rollback failed.'
        return
    }

    $WebhookSecret = Require-EnvironmentValue 'WEBHOOK_SECRET'
    $YandexFunctionUrl = Require-EnvironmentValue 'YANDEX_FUNCTION_URL'
    $BotToken = Require-EnvironmentValue 'BOT_TOKEN'
    if ($WebhookSecret -notmatch '^[A-Za-z0-9_-]{16,256}$') {
        throw 'WEBHOOK_SECRET is invalid.'
    }
    if ($YandexFunctionUrl -notmatch '^https://functions\.yandexcloud\.net/[a-z0-9]+\?tag=stable$') {
        throw 'YANDEX_FUNCTION_URL is invalid.'
    }
    if ($BotToken -notmatch '^\d{8,12}:[A-Za-z0-9_-]{30,}$') {
        throw 'BOT_TOKEN is invalid.'
    }
    if ($RestoreSecretsOnly) {
        try {
            Set-WorkerSecrets $WebhookSecret $YandexFunctionUrl $BotToken
        }
        finally {
            $WebhookSecret = $null
            $YandexFunctionUrl = $null
            $BotToken = $null
        }
        return
    }

    $HadExistingWorker = $true
    $PreviousWorkerVersionId = Get-CurrentWorkerVersionId
    if ([string]::IsNullOrWhiteSpace($PreviousWorkerVersionId)) {
        $HadExistingWorker = $false
    }

    try {
        Ensure-Queue $QueueName
        Ensure-Queue $DeadLetterQueueName
        if (-not $HadExistingWorker) {
            Invoke-WranglerQuiet @('deploy') 'Initial Cloudflare Worker deployment failed.'
            $PreviousWorkerVersionId = Get-CurrentWorkerVersionId
        }

        Set-WorkerSecrets $WebhookSecret $YandexFunctionUrl $BotToken
        Invoke-WranglerQuiet @('deploy') 'Cloudflare Worker deployment failed.'

        $WrongSecretBytes = [byte[]]::new(24)
        $Random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try {
            $Random.GetBytes($WrongSecretBytes)
        }
        finally {
            $Random.Dispose()
        }
        $WrongSecret = [Convert]::ToBase64String($WrongSecretBytes).
            TrimEnd('=').
            Replace('+', '_').
            Replace('/', '-')
        Invoke-WorkerProbe $WrongSecret 403
        Invoke-WorkerProbe $WebhookSecret 200
        Wait-CloudflareTelegramGateway `
            -Secret $WebhookSecret `
            -ProbeInvoker { param($Secret) Invoke-TelegramGatewayProbe $Secret }

        [pscustomobject]@{
            WorkerUrl = $WorkerUrl
            PreviousVersionId = if ($HadExistingWorker) {
                $PreviousWorkerVersionId
            }
            else {
                $null
            }
        }
    }
    catch {
        if (-not [string]::IsNullOrWhiteSpace($PreviousWorkerVersionId)) {
            try {
                Invoke-WranglerQuiet @(
                    'rollback',
                    $PreviousWorkerVersionId,
                    '--yes',
                    '--message',
                    'Automatic rollback after failed football bot deployment'
                ) 'Cloudflare Worker rollback failed.'
            }
            catch {
                Write-Warning 'Cloudflare Worker automatic rollback failed.'
            }
        }
        throw
    }
    finally {
        $WebhookSecret = $null
        $YandexFunctionUrl = $null
        $BotToken = $null
    }
}
finally {
    Pop-Location
}
