# Runs JavaScript inside the app on the TV over the Chrome DevTools Protocol.
# Start the debug session first with tools\tv-debug.ps1.
# Usage: powershell -ExecutionPolicy Bypass -File tools\cdp.ps1 -Expr "Api.session" [-Out shot.png]
#   -Expr  JS expression; promises are awaited, the result is printed as JSON
#   -Out   also save a PNG screenshot of the app (only works while the TV screen is on)
param([string]$Expr = 'document.title', [string]$Out, [int]$Port = 9222)
$ErrorActionPreference = 'Stop'
$targets = (Invoke-WebRequest "http://127.0.0.1:$Port/json" -UseBasicParsing -TimeoutSec 10).Content | ConvertFrom-Json
$ws = New-Object Net.WebSockets.ClientWebSocket
$ws.ConnectAsync([Uri]$targets[0].webSocketDebuggerUrl, [Threading.CancellationToken]::None).Wait()
$script:nextId = 0

function Call($method, $params) {
    $script:nextId++
    $id = $script:nextId
    $msg = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 6 -Compress
    $b = [Text.Encoding]::UTF8.GetBytes($msg)
    $ws.SendAsync((New-Object ArraySegment[byte] (, $b)), 'Text', $true, [Threading.CancellationToken]::None).Wait()
    $buf = New-Object byte[] 1048576
    $ms = New-Object IO.MemoryStream
    while ($true) {
        $r = $ws.ReceiveAsync((New-Object ArraySegment[byte] (, $buf)), [Threading.CancellationToken]::None).Result
        if ($r.MessageType -eq 'Close') { throw 'Debugger connection closed' }
        $ms.Write($buf, 0, $r.Count)
        if ($r.EndOfMessage) {
            $j = [Text.Encoding]::UTF8.GetString($ms.ToArray()) | ConvertFrom-Json
            $ms.SetLength(0)
            if ($j.id -eq $id) { return $j }
        }
    }
}

$res = (Call 'Runtime.evaluate' @{ expression = $Expr; awaitPromise = $true; returnByValue = $true }).result
if ($res.exceptionDetails) { 'EXCEPTION: ' + $res.exceptionDetails.exception.description }
else { $res.result.value | ConvertTo-Json -Depth 8 }

if ($Out) {
    # Hangs while the app is hidden (TV in standby or another app in front)
    $shot = Call 'Page.captureScreenshot' @{ format = 'png' }
    if ($shot.error) { 'Screenshot error: ' + $shot.error.message }
    else { [IO.File]::WriteAllBytes((Join-Path (Get-Location) $Out), [Convert]::FromBase64String($shot.result.data)); "Saved $Out" }
}
