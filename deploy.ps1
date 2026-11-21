# Builds, signs and installs Rezka TV on the Samsung TV.
# Usage: powershell -ExecutionPolicy Bypass -File deploy.ps1 -Tv <TV IP> [-Profile RezkaTV] [-NoInstall]
# The TV IP can also be set once via the REZKA_TV_IP environment variable.
param(
    [string]$Tv = $env:REZKA_TV_IP,
    [string]$Profile = 'RezkaTV',
    [string]$TizenStudio = $(if ($env:TIZEN_STUDIO) { $env:TIZEN_STUDIO } else { 'C:\tizen-studio' }),
    [switch]$NoInstall
)
$ErrorActionPreference = 'Stop'
if (-not $NoInstall -and -not $Tv) { throw 'Specify the TV IP: -Tv 192.168.x.x (or set REZKA_TV_IP)' }
$tizen = Join-Path $TizenStudio 'tools\ide\bin\tizen.bat'
$sdb = Join-Path $TizenStudio 'tools\sdb.exe'
$src = $PSScriptRoot
$work = Join-Path $src 'build'

# Only the app files go into the package
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory $work | Out-Null
foreach ($item in 'config.xml', 'index.html', 'icon.png', 'css', 'js') {
    Copy-Item (Join-Path $src $item) $work -Recurse
}

& $tizen package -t wgt -s $Profile -- $work
if ($LASTEXITCODE) { throw 'Packaging failed' }
$wgt = Get-ChildItem $work -Filter *.wgt | Select-Object -First 1
# The package is named after <name> in config.xml; the TV installer chokes on the space
$out = Join-Path $src 'RezkaTV.wgt'
Copy-Item $wgt.FullName $out -Force
"Package: $out"
if ($NoInstall) { return }

& $sdb connect $Tv
$serial = "${Tv}:26101"
$remote = '/home/owner/share/tmp/sdk_tools/tmp/RezkaTV.wgt'
& $sdb -s $serial push $out $remote
& $sdb -s $serial shell 0 vd_appinstall RezkaTVapp.RezkaTV $remote
& $sdb -s $serial shell 0 was_execute RezkaTVapp.RezkaTV
