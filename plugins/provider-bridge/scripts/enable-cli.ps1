# Dot-source this file to enable provider commands for the current terminal.
# It does not edit a PowerShell profile, PATH, credentials, or Claude binaries.
param([string]$ClaudeExecutable)

foreach ($providerCommandName in @('claude', 'claude-provider')) {
    $providerExisting = Get-Command $providerCommandName -ErrorAction SilentlyContinue
    if ($providerExisting -and $providerExisting.CommandType -in @('Alias', 'Function')) {
        throw "A function or alias named $providerCommandName already exists. Use the separate provider CLI, or open a fresh terminal before enabling this wrapper."
    }
}
$providerCliPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../cli.mjs'))
$providerNativePath = $ClaudeExecutable
if (-not $providerNativePath) {
    $providerNativeCommand = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notmatch '\.(cmd|bat)$' } | Select-Object -First 1
    $providerNativePath = if ($providerNativeCommand) { $providerNativeCommand.Source } else { 'claude' }
}
$providerNodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
$providerNodePath = $providerNodeCommand.Source

$providerClaudeFunction = {
    $providerArguments = @('--wrap', '--native', $providerNativePath) + @($args | ForEach-Object { [string]$_ })
    $providerPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $providerArguments)))
    if ($MyInvocation.ExpectingInput) {
        $input | & $providerNodePath $providerCliPath --shell-args $providerPayload
    } else {
        & $providerNodePath $providerCliPath --shell-args $providerPayload
    }
    $global:LASTEXITCODE = $LASTEXITCODE
}.GetNewClosure()
$providerStandaloneFunction = {
    $providerArguments = @($args | ForEach-Object { [string]$_ })
    $providerPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $providerArguments)))
    if ($MyInvocation.ExpectingInput) {
        $input | & $providerNodePath $providerCliPath --shell-args $providerPayload
    } else {
        & $providerNodePath $providerCliPath --shell-args $providerPayload
    }
    $global:LASTEXITCODE = $LASTEXITCODE
}.GetNewClosure()
Set-Item -Path Function:global:claude -Value $providerClaudeFunction
Set-Item -Path Function:global:claude-provider -Value $providerStandaloneFunction
Write-Host 'Provider CLI enabled for this terminal. Try: claude provider --help'
