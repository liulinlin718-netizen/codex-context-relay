param([ValidateSet('serve','mcp','doctor','demo','login')][string]$Mode='serve',[int]$Port=6400)
$ErrorActionPreference='Stop'
$relayRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $relayRoot
if ($Mode -eq 'mcp') { & node (Join-Path $relayRoot 'src/mcp.mjs'); exit $LASTEXITCODE }
if ($Mode -eq 'demo') { & node (Join-Path $relayRoot 'scripts/demo.mjs'); exit $LASTEXITCODE }
if ($Mode -eq 'login') { & node (Join-Path $relayRoot 'src/cli.mjs') login; exit $LASTEXITCODE }
& node (Join-Path $relayRoot 'src/cli.mjs') $Mode --port $Port
exit $LASTEXITCODE
