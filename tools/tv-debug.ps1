# Restarts Rezka TV on the TV in debug mode and forwards the inspector to localhost:9222.
# Then use tools\cdp.ps1, or open chrome://inspect in Chrome (Discover network targets: localhost:9222).
# Usage: powershell -ExecutionPolicy Bypass -File tools\tv-debug.ps1 -Tv <TV IP>
param(
    [string]$Tv = $env:REZKA_TV_IP,
    [string]$TizenStudio = $(if ($env:TIZEN_STUDIO) { $env:TIZEN_STUDIO } else { 'C:\tizen-studio' }),
    [int]$LocalPort = 9222
)
# Not 'Stop': PowerShell 5.1 turns harmless sdb stderr lines into terminating errors
$ErrorActionPreference = 'Continue'
if (-not $Tv) { throw 'Specify the TV IP: -Tv 192.168.x.x (or set REZKA_TV_IP)' }
$sdb = Join-Path $TizenStudio 'tools\sdb.exe'
$serial = "${Tv}:26101"

& $sdb connect $Tv | Out-Null
cmd /c "`"$sdb`" -s $serial forward --remove tcp:$LocalPort >nul 2>&1"
# "debug" hangs without output while the app is already running, so stop it first
cmd /c "`"$sdb`" -s $serial shell 0 kill RezkaTVapp >nul 2>&1"

$log = [IO.Path]::GetTempFileName()
$p = Start-Process -FilePath $sdb -ArgumentList "-s $serial shell 0 debug RezkaTVapp.RezkaTV" -RedirectStandardOutput $log -NoNewWindow -PassThru
if (-not $p.WaitForExit(40000)) { $p.Kill(); throw 'sdb debug did not answer in 40 s. Is developer mode on with this PC''s IP?' }
$out = Get-Content $log -Raw
Remove-Item $log
if ($out -notmatch 'port:\s*(\d+)') { throw "Unexpected sdb output: $out" }

& $sdb -s $serial forward "tcp:$LocalPort" "tcp:$($Matches[1])" | Out-Null
"Debugging Rezka TV on $Tv (inspector at http://127.0.0.1:$LocalPort/json)"
