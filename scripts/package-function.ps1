[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$ArtifactsRoot = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot '.artifacts'))
$RootPrefix = $RepositoryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $ArtifactsRoot.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to clean an artifacts path outside the repository.'
}

function Invoke-NpmStep {
    param([Parameter(Mandatory)][string[]] $Arguments)
    $PreviousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & npm.cmd @Arguments *> $null
        $ExitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PreviousErrorActionPreference
    }
    if ($ExitCode -ne 0) {
        throw "npm $($Arguments -join ' ') failed with exit code $ExitCode."
    }
}

Push-Location -LiteralPath $RepositoryRoot
try {
    Invoke-NpmStep @('ci')
    Invoke-NpmStep @('test')
    Invoke-NpmStep @('run', 'typecheck')
    Invoke-NpmStep @('run', 'build')

    if (Test-Path -LiteralPath $ArtifactsRoot) {
        Remove-Item -LiteralPath $ArtifactsRoot -Recurse -Force
    }
    $StageRoot = New-Item -ItemType Directory -Path (Join-Path $ArtifactsRoot 'function') -Force
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'dist') -Destination $StageRoot.FullName -Recurse
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'package.json') -Destination $StageRoot.FullName
    Copy-Item -LiteralPath (Join-Path $RepositoryRoot 'package-lock.json') -Destination $StageRoot.FullName

    $DeterministicTimestamp = [DateTime]::SpecifyKind([DateTime]'2000-01-01T00:00:00', [DateTimeKind]::Utc)
    Get-ChildItem -LiteralPath $StageRoot.FullName -Recurse -Force | ForEach-Object {
        $_.LastWriteTimeUtc = $DeterministicTimestamp
    }

    $ZipPath = Join-Path $ArtifactsRoot 'function.zip'
    Compress-Archive -Path (Join-Path $StageRoot.FullName '*') -DestinationPath $ZipPath -CompressionLevel Optimal
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Archive = [IO.Compression.ZipFile]::Open($ZipPath, [IO.Compression.ZipArchiveMode]::Update)
    try {
        foreach ($Entry in @($Archive.Entries | Where-Object { $_.FullName.Contains('\') })) {
            $NormalizedName = $Entry.FullName.Replace('\', '/')
            $NormalizedEntry = $Archive.CreateEntry($NormalizedName, [IO.Compression.CompressionLevel]::Optimal)
            $NormalizedEntry.LastWriteTime = [DateTimeOffset]$DeterministicTimestamp
            if ($Entry.Length -gt 0) {
                $Source = $Entry.Open()
                $Destination = $NormalizedEntry.Open()
                try {
                    $Source.CopyTo($Destination)
                }
                finally {
                    $Destination.Dispose()
                    $Source.Dispose()
                }
            }
            $Entry.Delete()
        }
    }
    finally {
        $Archive.Dispose()
    }
    $Zip = Get-Item -LiteralPath $ZipPath
    $Hash = Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256
    Write-Output "Path: $($Zip.FullName)"
    Write-Output "Bytes: $($Zip.Length)"
    Write-Output "SHA256: $($Hash.Hash)"
}
finally {
    Pop-Location
}
