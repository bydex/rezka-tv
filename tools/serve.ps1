# Dev server for testing the app in a desktop browser.
# Serves the app on http://localhost:8765 and proxies /rz/* to the mirror (the app switches to /rz on localhost),
# keeping the site's cookies server-side, so the browser needs no CORS or cookie workarounds.
# Usage: powershell -ExecutionPolicy Bypass -File tools\serve.ps1 [-Port 8765] [-Upstream https://standby-rezka.tv]
param([string]$Root = (Split-Path $PSScriptRoot), [int]$Port = 8765, [string]$Upstream = 'https://standby-rezka.tv')
Add-Type -AssemblyName System.Net.Http
$jar = New-Object Net.CookieContainer
$h = New-Object Net.Http.HttpClientHandler
$h.CookieContainer = $jar
$h.AllowAutoRedirect = $true
$h.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
$client = New-Object Net.Http.HttpClient($h)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('Mozilla/5.0 (SMART-TV; LINUX; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36')
$l = New-Object Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
"listening $Port"
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='application/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.png'='image/png'; '.xml'='text/xml' }
while ($l.IsListening) {
  $c = $l.GetContext()
  $q = $c.Request
  $r = $c.Response
  $r.Headers.Add('Cache-Control', 'no-store')
  try {
    $path = $q.Url.AbsolutePath
    if ($path.StartsWith('/rz/')) {
      # Proxy to the mirror, keeping the session cookies server-side
      $target = $Upstream + $q.RawUrl.Substring(3)
      $msg = New-Object Net.Http.HttpRequestMessage([Net.Http.HttpMethod]::new($q.HttpMethod), $target)
      if ($q.Headers['X-Requested-With']) { $msg.Headers.Add('X-Requested-With', $q.Headers['X-Requested-With']) }
      if ($q.HasEntityBody) {
        $body = (New-Object IO.StreamReader($q.InputStream)).ReadToEnd()
        $msg.Content = New-Object Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/x-www-form-urlencoded')
      }
      $resp = $client.SendAsync($msg).Result
      $bytes = $resp.Content.ReadAsByteArrayAsync().Result
      $r.StatusCode = [int]$resp.StatusCode
      $ct = $resp.Content.Headers.ContentType
      if ($ct) { $r.ContentType = $ct.ToString() }
      "$($q.HttpMethod) $target -> $($r.StatusCode) $($bytes.Length)"
      $r.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $p = [Uri]::UnescapeDataString($path.TrimStart('/'))
      if ($p -eq '') { $p = 'index.html' }
      $f = Join-Path $Root $p
      if (Test-Path $f -PathType Leaf) {
        $b = [IO.File]::ReadAllBytes($f)
        $ext = [IO.Path]::GetExtension($f)
        if ($types[$ext]) { $r.ContentType = $types[$ext] }
        $r.OutputStream.Write($b, 0, $b.Length)
      } else { $r.StatusCode = 404 }
    }
  } catch { "ERR $_"; try { $r.StatusCode = 502 } catch {} }
  try { $r.Close() } catch {}
}
