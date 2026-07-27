function Get-YcJsonOrNull {
    param(
        [Parameter(Mandatory)][string[]] $Arguments,
        [Parameter(Mandatory)][string] $Description,
        [string] $ExecutablePath = 'yc'
    )

    $StdoutPath = [IO.Path]::GetTempFileName()
    $StderrPath = [IO.Path]::GetTempFileName()
    try {
        $PreviousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $ExecutablePath @Arguments 1> $StdoutPath 2> $StderrPath
            $ExitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }

        $StdoutText = [IO.File]::ReadAllText($StdoutPath)
        if ($ExitCode -eq 0) {
            try {
                return $StdoutText | ConvertFrom-Json
            }
            catch {
                throw "$Description returned invalid JSON."
            }
        }

        $StderrText = [IO.File]::ReadAllText($StderrPath)
        $DiagnosticText = "$StdoutText`n$StderrText"
        if ($DiagnosticText -match '(?i)(not[ _-]?found|does not exist)') {
            return $null
        }
        throw "$Description failed."
    }
    finally {
        Remove-Item -LiteralPath $StdoutPath, $StderrPath -Force -ErrorAction SilentlyContinue
    }
}

function ConvertTo-RuntimeAdminIds {
    param([Parameter(Mandatory)][string] $AdminIds)
    if ($AdminIds -notmatch '^-?\d+(,-?\d+)*$') {
        throw 'ADMIN_IDS must be a comma-separated list of numeric Telegram user IDs.'
    }
    return $AdminIds.Replace(',', ';')
}

function Invoke-ProductionRollback {
    param(
        [Parameter(Mandatory)][bool] $StableMoved,
        [AllowEmptyString()][string] $PreviousStableVersionId,
        [Parameter(Mandatory)][bool] $CloudflareDeployed,
        [AllowEmptyString()][string] $PreviousCloudflareVersionId,
        [Parameter(Mandatory)][bool] $WebhookSetupAttempted,
        [AllowEmptyString()][string] $PreviousWebhookSecret,
        [AllowEmptyString()][string] $PreviousWebhookUrl,
        [AllowEmptyString()][string] $RestoredYandexFunctionUrl,
        [Parameter(Mandatory)][scriptblock] $YandexRollback,
        [Parameter(Mandatory)][scriptblock] $CloudflareRollback,
        [Parameter(Mandatory)][scriptblock] $FirstCloudflareRollback,
        [Parameter(Mandatory)][scriptblock] $TelegramRollback
    )

    $Result = [ordered]@{
        YandexRestored = $false
        CloudflareRestored = $false
        TelegramRestored = $false
    }
    if ($StableMoved -and -not [string]::IsNullOrWhiteSpace($PreviousStableVersionId)) {
        try {
            & $YandexRollback $PreviousStableVersionId
            $Result.YandexRestored = $true
        }
        catch {
            Write-Warning 'Automatic Yandex stable version rollback failed.'
        }
    }
    if (
        $CloudflareDeployed -and
        -not [string]::IsNullOrWhiteSpace($PreviousCloudflareVersionId)
    ) {
        try {
            & $CloudflareRollback $PreviousCloudflareVersionId
            $Result.CloudflareRestored = $true
        }
        catch {
            Write-Warning 'Automatic Cloudflare Worker rollback failed.'
        }
    }
    elseif (
        $CloudflareDeployed -and
        -not [string]::IsNullOrWhiteSpace($PreviousWebhookSecret) -and
        -not [string]::IsNullOrWhiteSpace($RestoredYandexFunctionUrl)
    ) {
        try {
            & $FirstCloudflareRollback `
                $PreviousWebhookSecret `
                $RestoredYandexFunctionUrl
            $Result.CloudflareRestored = $true
        }
        catch {
            Write-Warning 'Automatic first Cloudflare Worker rollback failed.'
        }
    }
    if (
        $WebhookSetupAttempted -and
        -not [string]::IsNullOrWhiteSpace($PreviousWebhookSecret) -and
        -not [string]::IsNullOrWhiteSpace($PreviousWebhookUrl)
    ) {
        try {
            & $TelegramRollback $PreviousWebhookSecret $PreviousWebhookUrl
            $Result.TelegramRestored = $true
        }
        catch {
            Write-Warning 'Automatic Telegram webhook rollback failed.'
        }
    }
    return [pscustomobject]$Result
}

function Invoke-YandexCloudRestJsonRequest {
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'PATCH')][string] $Method,
        [Parameter(Mandatory)][string] $Uri,
        [Parameter(Mandatory)][string] $IamToken,
        [AllowNull()][object] $BodyJson
    )

    $Client = [System.Net.Http.HttpClient]::new()
    $Client.Timeout = [TimeSpan]::FromSeconds(30)
    $Request = $null
    $Response = $null
    try {
        $Request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::new($Method),
            $Uri
        )
        [void]$Request.Headers.TryAddWithoutValidation('Authorization', "Bearer $IamToken")
        if ($null -ne $BodyJson) {
            $Request.Content = [System.Net.Http.StringContent]::new(
                $BodyJson,
                [Text.Encoding]::UTF8,
                'application/json'
            )
        }

        try {
            $Response = $Client.SendAsync($Request).GetAwaiter().GetResult()
        }
        catch {
            throw 'Yandex Cloud REST request failed before receiving a response.'
        }
        if (-not $Response.IsSuccessStatusCode) {
            throw "Yandex Cloud REST request failed with HTTP $([int]$Response.StatusCode)."
        }

        $ResponseJson = $Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        try {
            return $ResponseJson | ConvertFrom-Json
        }
        catch {
            throw 'Yandex Cloud REST request returned invalid JSON.'
        }
    }
    finally {
        if ($null -ne $Response) {
            $Response.Dispose()
        }
        if ($null -ne $Request) {
            $Request.Dispose()
        }
        $Client.Dispose()
        $IamToken = $null
    }
}

function Set-YdbDeletionProtectionViaRest {
    param(
        [Parameter(Mandatory)][string] $DatabaseId,
        [Parameter(Mandatory)][string] $IamToken,
        [scriptblock] $RequestInvoker,
        [scriptblock] $DelayInvoker
    )

    if ($null -eq $RequestInvoker) {
        $RequestInvoker = {
            param($Method, $Uri, $Token, $BodyJson)
            Invoke-YandexCloudRestJsonRequest $Method $Uri $Token $BodyJson
        }
    }
    if ($null -eq $DelayInvoker) {
        $DelayInvoker = {
            param($Seconds)
            Start-Sleep -Seconds $Seconds
        }
    }
    $InvokeRequestWithRetry = {
        param($Method, $Uri, $Token, $BodyJson)
        for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
            try {
                return & $RequestInvoker $Method $Uri $Token $BodyJson
            }
            catch {
                if ($Attempt -eq 3) {
                    throw
                }
                & $DelayInvoker 2
            }
        }
    }

    $EscapedDatabaseId = [Uri]::EscapeDataString($DatabaseId)
    $DatabaseUri = "https://ydb.api.cloud.yandex.net/ydb/v1/databases/$EscapedDatabaseId"
    $BodyJson = [ordered]@{
        updateMask = 'deletionProtection'
        deletionProtection = $true
    } | ConvertTo-Json -Compress
    $MalformedOperationMessage = 'YDB deletion-protection update returned a malformed operation.'
    $AssertOperationShape = {
        param([AllowNull()][object] $Candidate)
        if ($null -eq $Candidate -or $Candidate.GetType() -ne [Management.Automation.PSCustomObject]) {
            throw $MalformedOperationMessage
        }
        $CandidateId = $Candidate.PSObject.Properties['id']
        if ($null -eq $CandidateId -or [string]::IsNullOrWhiteSpace([string]$CandidateId.Value)) {
            throw $MalformedOperationMessage
        }
    }
    $Operation = & $InvokeRequestWithRetry 'PATCH' $DatabaseUri $IamToken $BodyJson
    & $AssertOperationShape $Operation
    $OperationIdProperty = $Operation.PSObject.Properties['id']

    $OperationId = [Uri]::EscapeDataString([string]$OperationIdProperty.Value)
    $OperationUri = "https://operation.api.cloud.yandex.net/operations/$OperationId"
    $Deadline = [DateTime]::UtcNow.AddMinutes(5)
    while ($true) {
        & $AssertOperationShape $Operation
        $DoneProperty = $Operation.PSObject.Properties['done']
        if ($null -ne $DoneProperty -and $DoneProperty.Value -eq $true) {
            break
        }
        if ([DateTime]::UtcNow -ge $Deadline) {
            throw 'Timed out waiting for YDB deletion-protection update.'
        }
        & $DelayInvoker 2
        $Operation = & $InvokeRequestWithRetry 'GET' $OperationUri $IamToken $null
    }

    $OperationError = $Operation.PSObject.Properties['error']
    if ($null -ne $OperationError -and $null -ne $OperationError.Value) {
        throw 'YDB deletion-protection update operation failed.'
    }

    $Database = & $InvokeRequestWithRetry 'GET' $DatabaseUri $IamToken $null
    $DeletionProtection = $Database.PSObject.Properties['deletionProtection']
    if ($null -eq $DeletionProtection -or $DeletionProtection.Value -ne $true) {
        throw 'YDB deletion protection is not enabled after REST update.'
    }
    return $Database
}

function Assert-YdbDatabaseConfiguration {
    param([Parameter(Mandatory)][object] $Database)

    $Problems = [Collections.Generic.List[string]]::new()
    $DeletionProtection = $Database.PSObject.Properties['deletion_protection']
    if ($null -eq $DeletionProtection -or $DeletionProtection.Value -ne $true) {
        [void]$Problems.Add('deletion protection is not enabled')
    }

    $ServerlessProperty = $Database.PSObject.Properties['serverless_database']
    if ($null -eq $ServerlessProperty -or $null -eq $ServerlessProperty.Value) {
        [void]$Problems.Add('database is not serverless')
    }
    else {
        $Serverless = $ServerlessProperty.Value
        $ProvisionedProperty = $Serverless.PSObject.Properties['provisioned_rcu_limit']
        if ($null -ne $ProvisionedProperty -and [string]$ProvisionedProperty.Value -ne '0') {
            [void]$Problems.Add('provisioned RCU limit is not 0')
        }
        $StorageProperty = $Serverless.PSObject.Properties['storage_size_limit']
        if ($null -eq $StorageProperty -or [string]$StorageProperty.Value -ne '1073741824') {
            [void]$Problems.Add('storage size limit is not 1GB')
        }
    }

    if ($Problems.Count -gt 0) {
        throw "YDB configuration mismatch after update: $($Problems -join '; '). Verify permissions and run deploy.ps1 again before creating a function version."
    }
}
