param([string]$NodeExecutable)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/enable-cli.ps1') -ClaudeExecutable $NodeExecutable 6>$null
$providerFakeClaude = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'fake-claude.mjs'))
'pipeline content' | claude $providerFakeClaude -p 'Explain "quoted text" & literal $()' '' --fixture-exit 7
exit $LASTEXITCODE
