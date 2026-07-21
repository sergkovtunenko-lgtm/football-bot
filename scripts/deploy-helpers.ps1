function ConvertTo-RuntimeAdminIds {
    param([Parameter(Mandatory)][string] $AdminIds)
    if ($AdminIds -notmatch '^-?\d+(,-?\d+)*$') {
        throw 'ADMIN_IDS must be a comma-separated list of numeric Telegram user IDs.'
    }
    return $AdminIds.Replace(',', ';')
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
