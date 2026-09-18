$ErrorActionPreference = 'Stop'
$relayRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$relayResult = & node (Join-Path $PSScriptRoot 'package.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release staging failed.' }
$relayRelease = ($relayResult | ConvertFrom-Json)
$relayStage = [IO.Path]::GetFullPath($relayRelease.directory)
$relayAllowed = [IO.Path]::GetFullPath((Join-Path $relayRoot '.runtime/releases')) + [IO.Path]::DirectorySeparatorChar
if (-not $relayStage.StartsWith($relayAllowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected release directory.' }
$relayArchive = Join-Path ([IO.Path]::GetDirectoryName($relayStage)) ('codex-context-relay-' + $relayRelease.version + '.zip')
Add-Type -AssemblyName System.IO.Compression.FileSystem
# ZipFile preserves dotfiles, including the plugin manifest.
[IO.Compression.ZipFile]::CreateFromDirectory($relayStage, $relayArchive)
[pscustomobject]@{Directory=$relayStage; Archive=$relayArchive; Files=$relayRelease.files; Bytes=(Get-Item -LiteralPath $relayArchive).Length}
