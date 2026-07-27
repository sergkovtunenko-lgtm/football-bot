function ConvertTo-RuntimeAdminIds {
    param([Parameter(Mandatory)][string] $AdminIds)
    if ($AdminIds -notmatch '^-?\d+(,-?\d+)*$') {
        throw 'ADMIN_IDS must be a comma-separated list of numeric Telegram user IDs.'
    }
    return $AdminIds.Replace(',', ';')
}

function Invoke-YandexCloudRestJsonRequest {
    param(
        [Parameter(Mandatory)][ValidateSet('GET', 'PATCH')][string] $Method,
        [Parameter(Mandatory)][string] $Uri,
        [Parameter(Mandatory)][string] $IamToken,
        [AllowNull()][object] $BodyJson
    )

    $Client = [System.Net.Http.HttpClient]::new()
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

    $EscapedDatabaseId = [Uri]::EscapeDataString($DatabaseId)
    $DatabaseUri = "https://ydb.api.cloud.yandex.net/ydb/v1/databases/$EscapedDatabaseId"
    $BodyJson = [ordered]@{
        updateMask = 'deletionProtection'
        deletionProtection = $true
    } | ConvertTo-Json -Compress
    $Operation = & $RequestInvoker 'PATCH' $DatabaseUri $IamToken $BodyJson
    $MalformedOperationMessage = 'YDB deletion-protection update returned a malformed operation.'
    if ($null -eq $Operation -or $Operation.GetType() -ne [Management.Automation.PSCustomObject]) {
        throw $MalformedOperationMessage
    }
    $OperationIdProperty = $Operation.PSObject.Properties['id']
    if ($null -eq $OperationIdProperty -or [string]::IsNullOrWhiteSpace([string]$OperationIdProperty.Value)) {
        throw $MalformedOperationMessage
    }

    $OperationId = [Uri]::EscapeDataString([string]$OperationIdProperty.Value)
    $OperationUri = "https://operation.api.cloud.yandex.net/operations/$OperationId"
    $Deadline = [DateTime]::UtcNow.AddMinutes(5)
    while ($true) {
        $DoneProperty = $Operation.PSObject.Properties['done']
        if ($null -ne $DoneProperty -and $DoneProperty.Value -eq $true) {
            break
        }
        if ([DateTime]::UtcNow -ge $Deadline) {
            throw 'Timed out waiting for YDB deletion-protection update.'
        }
        & $DelayInvoker 2
        $Operation = & $RequestInvoker 'GET' $OperationUri $IamToken $null
    }

    $OperationError = $Operation.PSObject.Properties['error']
    if ($null -ne $OperationError -and $null -ne $OperationError.Value) {
        throw 'YDB deletion-protection update operation failed.'
    }

    $Database = & $RequestInvoker 'GET' $DatabaseUri $IamToken $null
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
