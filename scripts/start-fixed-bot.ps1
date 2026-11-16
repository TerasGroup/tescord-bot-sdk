$ErrorActionPreference = 'Stop'
$botRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $botRoot
$botRuntime = Join-Path $botRoot '.runtime/fixed-bot'
New-Item -ItemType Directory -Path $botRuntime -Force | Out-Null
$botLock = Join-Path $botRuntime 'process.lock'
if (Test-Path -LiteralPath $botLock) {
    $botPid = [int](Get-Content -LiteralPath $botLock -Raw)
    if (Get-Process -Id $botPid -ErrorAction SilentlyContinue) {
        Write-Output "Bot already running. PID: $botPid"
        exit 0
    }
}
$botNode = Join-Path $botRoot 'node_modules/.bin/node.exe'
if (-not (Test-Path -LiteralPath $botNode)) { throw 'Run pnpm install first.' }
$botProcess = Start-Process -FilePath $botNode -ArgumentList @(
    '--env-file-if-exists=.env.production.local',
    'node_modules/tsx/dist/cli.mjs', '--tsconfig', 'tsconfig.base.json', 'scripts/fixed-bot.ts'
) -WorkingDirectory $botRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $botRuntime 'stdout.log') -RedirectStandardError (Join-Path $botRuntime 'stderr.log') -PassThru
Write-Output "Bot launcher started. PID: $($botProcess.Id)"
