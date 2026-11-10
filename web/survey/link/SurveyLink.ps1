<#
  Survey Link: the clipboard and chat-log bridge for the N-Space and J-Space Surveys.

  Run it with Start-SurveyLink.bat (double-click). It does two things while open:

  1. Clipboard. When you copy in EVE (probe scanner, directional scan, or a
     wormhole's Show Info), it hands that copy to the N-Space Survey page, so you
     never have to click over to the second screen and paste. Anything else on
     your clipboard (passwords, chat, documents) is ignored and never leaves this
     window: only copies shaped like those three EVE windows are passed on.

  2. Chat logs. EVE writes a line to your Local chat log every time you change
     system. Survey Link reads those lines, so the survey knows about a jump about
     a second after it happens.

  3. Planet scan pictures. Only while the J-Space Survey page is waiting for
     scan captures (you pressed Input scan results there), a picture you put on
     the clipboard (Win+Shift+S or Print Screen) is handed to that page. At any
     other time pictures are ignored. The last few are kept in memory only.

  It talks only to this computer (http://localhost:47321) and only answers the
  N-Space Survey page. Nothing is sent anywhere else, nothing is written to disk,
  and copies are forgotten after ten minutes. It never touches the game client.
  Close the window to stop it.
#>
param([int]$Port = 47321)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$Version = '1.5'
$Allowed = @('https://idan-armstrong.github.io', 'http://localhost:8799')
$KeepMs = 10 * 60 * 1000

$script:items = New-Object System.Collections.ArrayList
$script:seq = 0
$script:lastClip = $null
$script:logs = @{}          # path -> @{ pos; char }
$script:where = @{}         # character -> system name
$script:images = @{}        # seq -> PNG bytes, only while the page asks for pictures
$script:wantImageUntil = 0
$script:clipPending = $false
$script:clipAt = 0

function NowMs { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

function Add-Item([string]$kind, [hashtable]$data) {
  $script:seq++
  $data.seq = $script:seq
  $data.kind = $kind
  $data.at = NowMs
  [void]$script:items.Add($data)
  while ($script:items.Count -gt 50) { $script:items.RemoveAt(0) }
}

# ---- what counts as an EVE copy (same rules as the survey page) -------------
$SigRow = [regex]'(?m)(^|\t)[A-Z]{3}-\d{3}\t'
$Dist = [regex]'^(-|[\d.,\s\u00A0]+\s?(m|km|AU))$'
function Get-EveKind([string]$text) {
  if ([string]::IsNullOrWhiteSpace($text) -or $text.Length -gt 200000) { return $null }
  if ($SigRow.IsMatch($text)) { return 'probe scan' }
  $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() -ne '' })
  $scan = 0
  foreach ($l in $lines) {
    $c = $l -split "`t"
    if ($c.Count -ge 3 -and $Dist.IsMatch($c[$c.Count - 1].Trim())) { $scan++ }
  }
  if ($scan -gt 0 -and $scan -ge [math]::Ceiling($lines.Count * 0.6)) { return 'directional scan' }
  if ($text -match '(?i)wormhole' -and
      $text -match '(?i)(natural lifetime|cycle of decay|stability|ships can pass|smallest ships)') {
    return 'wormhole Show Info'
  }
  return $null
}

# Windows numbers every copy, so copying the same text twice still counts as new
Add-Type -Namespace SurveyLink -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetClipboardSequenceNumber();
'@
$script:lastSeqNo = [SurveyLink.Native]::GetClipboardSequenceNumber()

function Check-Clipboard {
  # a copy is looked at again for a few seconds: the snipping tool finishes
  # writing its picture a moment after the clipboard changes
  $n = [SurveyLink.Native]::GetClipboardSequenceNumber()
  if ($n -ne $script:lastSeqNo) { $script:lastSeqNo = $n; $script:clipAt = NowMs; $script:clipPending = $true }
  if (-not $script:clipPending) { return }
  $text = $null
  try { $text = Get-Clipboard -Raw } catch { }
  if (-not [string]::IsNullOrEmpty($text)) {
    $script:clipPending = $false
    $script:lastClip = $text
    $kind = Get-EveKind $text
    if ($kind) {
      Add-Item 'paste' @{ text = $text }
      Write-Host ("{0:HH:mm:ss}  passed on a {1}" -f (Get-Date), $kind) -ForegroundColor Cyan
    }
    return
  }
  if (Check-Image) { $script:clipPending = $false; return }
  if ((NowMs) - $script:clipAt -gt 3000) { $script:clipPending = $false }
}

# a picture on the clipboard is passed on only while the survey page waits for scan captures
function Check-Image {
  try { $img = Get-Clipboard -Format Image } catch { return $false }
  if ($null -eq $img) { return $false }
  if ((NowMs) -gt $script:wantImageUntil) {
    $img.Dispose()
    Write-Host ("{0:HH:mm:ss}  picture ignored: the J-Space Survey page is not waiting for scans" -f (Get-Date)) -ForegroundColor DarkGray
    return $true
  }
  $ms = New-Object System.IO.MemoryStream
  try { $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }
  Add-Item 'image' @{ size = $ms.Length }
  $script:images[$script:seq] = $ms.ToArray()
  $ms.Dispose()
  foreach ($k in @($script:images.Keys | Sort-Object | Select-Object -SkipLast 5)) { $script:images.Remove($k) }
  Write-Host ("{0:HH:mm:ss}  passed on a scan picture" -f (Get-Date)) -ForegroundColor Cyan
  return $true
}

# ---- Local chat logs ---------------------------------------------------------
$Docs = [Environment]::GetFolderPath('MyDocuments')
$LogDir = Join-Path $Docs 'EVE\logs\Chatlogs'
$Changed = [regex]'Channel changed to Local\s*:\s*(.+?)\s*\*?\s*$'
$Listener = [regex]'Listener:\s+(.+?)\s*$'

function Read-From([string]$path, [long]$pos) {
  $fs = [System.IO.File]::Open($path, 'Open', 'Read', 'ReadWrite')
  try {
    if ($pos -gt $fs.Length) { $pos = 0 }
    if ($fs.Length -le $pos) { return @{ text = ''; pos = $pos } }
    if ($pos % 2 -eq 1) { $pos-- }
    [void]$fs.Seek($pos, 'Begin')
    $buf = New-Object byte[] ($fs.Length - $pos)
    $n = $fs.Read($buf, 0, $buf.Length)
    $n = $n - ($n % 2)
    return @{ text = [System.Text.Encoding]::Unicode.GetString($buf, 0, $n).TrimStart([char]0xFEFF); pos = $pos + $n }
  } finally { $fs.Close() }
}

function Note-System([string]$char, [string]$system, [bool]$initial) {
  if (-not $char -or -not $system) { return }
  if ($script:where[$char] -eq $system) { return }
  $script:where[$char] = $system
  Add-Item 'system' @{ char = $char; system = $system; initial = $initial }
  Write-Host ("{0:HH:mm:ss}  {1}: {2}" -f (Get-Date), $char, $system) -ForegroundColor Green
}

function Check-Logs {
  if (-not (Test-Path $LogDir)) { return }
  # Windows does not refresh the size or time of a file EVE still has open, so the
  # listing is only used to find today's logs; each one is opened to read its real size
  $since = (Get-Date).AddHours(-24)
  foreach ($f in (Get-ChildItem -Path $LogDir -Filter 'Local_*.txt' -File -ErrorAction SilentlyContinue |
                  Where-Object { $_.LastWriteTime -gt $since -or $_.CreationTime -gt $since })) {
    $t = $script:logs[$f.FullName]
    $initial = $false
    if (-not $t) {
      $t = @{ pos = 0; char = $null }
      $script:logs[$f.FullName] = $t
      $initial = $true
    }
    try { $r = Read-From $f.FullName $t.pos } catch { continue }
    if (-not $r.text) { continue }
    $t.pos = $r.pos
    $last = $null
    foreach ($line in ($r.text -split "`r?`n")) {
      if (-not $t.char) { $m = $Listener.Match($line); if ($m.Success) { $t.char = $m.Groups[1].Value } }
      $m = $Changed.Match($line)
      if ($m.Success) {
        $last = $m.Groups[1].Value
        if (-not $initial) { Note-System $t.char $last $false }
      }
    }
    if ($initial -and $last) { Note-System $t.char $last $true }
  }
}

# ---- tiny local web service ------------------------------------------------------
function Send($ctx, [int]$status, [string]$body) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.Headers['Cache-Control'] = 'no-store'
  if ($body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    $res.ContentType = 'application/json; charset=utf-8'
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  }
  $res.Close()
}

function Handle($ctx) {
  $req = $ctx.Request
  $origin = $req.Headers['Origin']
  if (-not $origin -or $Allowed -notcontains $origin) { Send $ctx 403 '{"error":"not allowed"}'; return }
  $res = $ctx.Response
  $res.Headers['Access-Control-Allow-Origin'] = $origin
  $res.Headers['Vary'] = 'Origin'
  if ($req.HttpMethod -eq 'OPTIONS') {
    $res.Headers['Access-Control-Allow-Methods'] = 'GET'
    $res.Headers['Access-Control-Allow-Headers'] = '*'
    $res.Headers['Access-Control-Allow-Private-Network'] = 'true'
    Send $ctx 204 ''
    return
  }
  if ($req.Url.AbsolutePath -eq '/image') {
    $n = 0
    [void][long]::TryParse($req.QueryString['seq'], [ref]$n)
    $bytes = $script:images[[int]$n]
    if (-not $bytes) { Send $ctx 404 '{"error":"no such picture"}'; return }
    $res.StatusCode = 200
    $res.Headers['Cache-Control'] = 'no-store'
    $res.ContentType = 'image/png'
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
    $res.Close()
    return
  }
  if ($req.Url.AbsolutePath -ne '/events') { Send $ctx 404 '{"error":"not found"}'; return }
  if ($req.QueryString['img'] -eq '1') { $script:wantImageUntil = (NowMs) + 60000 }
  $since = 0
  [void][long]::TryParse($req.QueryString['since'], [ref]$since)
  $cut = (NowMs) - $KeepMs
  while ($script:items.Count -gt 0 -and $script:items[0].at -lt $cut) { $script:items.RemoveAt(0) }
  $out = @($script:items | Where-Object { $_.seq -gt $since })
  $body = @{ app = 'survey-link'; version = $Version; seq = $script:seq; logs = (Test-Path $LogDir); items = $out } |
          ConvertTo-Json -Depth 4 -Compress
  Send $ctx 200 $body
}

$http = New-Object System.Net.HttpListener
$http.Prefixes.Add("http://localhost:$Port/")
try { $http.Start() } catch {
  Write-Host "Could not open http://localhost:$Port. Is Survey Link already running?" -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "  Survey Link $Version is running." -ForegroundColor Cyan
Write-Host "  Keep this window open while you survey; close it to stop."
Write-Host "  Talks only to the N-Space Survey page on this computer."
if (Test-Path $LogDir) { Write-Host "  Reading jumps from $LogDir" }
else { Write-Host "  EVE chat logs not found at $LogDir (jumps will come from the survey page instead)." -ForegroundColor Yellow }
Write-Host ""

try { $script:lastClip = Get-Clipboard -Raw } catch { }   # do not pass on whatever was copied before
$task = $http.GetContextAsync()
$nextLog = 0
try {
  while ($http.IsListening) {
    if ($task.Wait(250)) {
      try { Handle $task.Result } catch { }
      $task = $http.GetContextAsync()
    }
    Check-Clipboard
    if ((NowMs) -ge $nextLog) { Check-Logs; $nextLog = (NowMs) + 1000 }
  }
} finally {
  $http.Stop()
}
