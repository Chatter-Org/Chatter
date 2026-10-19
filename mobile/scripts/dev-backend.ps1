<#
.SYNOPSIS
  Run a local Chatter server for mobile development, on its own database.

.DESCRIPTION
  Starts a private MongoDB on port 27018 (data in ~/.chatter-dev/mongo-27018,
  never your usual database) and the debug build of the server on port 8000
  against it. Build the server first with `cargo build` at the repo root.

  The emulator and a USB-connected phone reach it at http://localhost:8000
  after `adb reverse tcp:8000 tcp:8000`.

  -Reset   Stop both, delete the dev database and the seeded test accounts,
           and start fresh. Re-seed with: npx tsx scripts/seed-dev.mts
  -Stop    Stop both and exit.
#>
param([switch]$Reset, [switch]$Stop)

$ErrorActionPreference = "Stop"
$dev = Join-Path $env:USERPROFILE ".chatter-dev"
$db = Join-Path $dev "mongo-27018"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$server = Join-Path $repo "target\debug\chatter.exe"
$mongod = Get-ChildItem "C:\Program Files\MongoDB\Server\*\bin\mongod.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1

function Stop-DevServers {
  Get-Process chatter -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $server } |
    Stop-Process -Force -Confirm:$false
  Get-CimInstance Win32_Process -Filter "Name='mongod.exe'" |
    Where-Object { $_.CommandLine -like "*--port 27018*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
  Start-Sleep -Seconds 1
}

New-Item -ItemType Directory -Force $dev | Out-Null

if ($Stop -or $Reset) { Stop-DevServers }
if ($Stop) { Write-Host "Stopped."; exit 0 }
if ($Reset) {
  Remove-Item -Recurse -Force $db -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -Force (Join-Path $dev "test-accounts.json") -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Dev database and test accounts removed."
}

if (-not $mongod) { throw "MongoDB is not installed under C:\Program Files\MongoDB." }
if (-not (Test-Path $server)) { throw "No server build at $server. Run 'cargo build' at the repo root." }

# A signing key kept between runs, so sessions survive a restart.
$secretFile = Join-Path $dev "jwt_secret"
if (-not (Test-Path $secretFile)) {
  $bytes = New-Object byte[] 48
  [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  [Convert]::ToBase64String($bytes) | Set-Content -NoNewline $secretFile
}

if (-not (Get-NetTCPConnection -LocalPort 27018 -State Listen -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force $db | Out-Null
  Start-Process -WindowStyle Hidden -FilePath $mongod.FullName -ArgumentList @(
    "--port", "27018", "--bind_ip", "127.0.0.1",
    "--dbpath", "`"$db`"", "--logpath", "`"$(Join-Path $dev 'mongo-27018.log')`""
  )
  Start-Sleep -Seconds 2
}

if (-not (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue)) {
  $env:MONGODB_URI = "mongodb://127.0.0.1:27018"
  $env:JWT_SECRET = Get-Content -Raw $secretFile
  Start-Process -WindowStyle Hidden -WorkingDirectory $repo -FilePath $server `
    -RedirectStandardOutput (Join-Path $dev "backend.log") `
    -RedirectStandardError (Join-Path $dev "backend.err.log")
}

foreach ($i in 1..90) {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8000/_matrix/client/versions | Out-Null
    Write-Host "Chatter dev server up at http://localhost:8000 (logs in $dev)."
    exit 0
  } catch { Start-Sleep -Seconds 1 }
}
throw "The server did not answer on :8000. See $(Join-Path $dev 'backend.err.log')."
