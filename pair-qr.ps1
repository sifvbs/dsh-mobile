<#
.SYNOPSIS
  DSH mobile — issue pairing links and QR codes for LAN and/or tunnel access.

.DESCRIPTION
  Two independent paths, neither overwrites the other:

    -Mode lan      same WiFi  : tcp-proxy on <lan-ip>:<LanPort> -> 127.0.0.1:<DshPort>
    -Mode tunnel   any network: cloudflared quick tunnel -> tunnel-shim -> DSH
    -Mode both     issue both

  Outputs, per mode:
    pair-url-lan.txt    / pair-url-tunnel.txt
    pair-qr-lan.png     / pair-qr-tunnel.png

  Only ONE pairing token is valid at a time, so when both modes run in the same
  invocation the token is minted once and reused. Minting twice would invalidate
  the first QR code.

.PARAMETER DshPort
  Port the DSH webserver listens on. Find it in the DSH Web GUI URL.

.PARAMETER LanPort
  Local port the TCP forwarder binds for the LAN path.

.PARAMETER ShimPort
  Local port the tunnel shim binds.

.PARAMETER Ip
  Local interface address to advertise for the LAN path. Defaults to the first
  adapter that has both an IPv4 address and a default gateway.

.PARAMETER Node
  Path to node.exe. Defaults to `node` on PATH.

.PARAMETER QrcodeModule
  Path to the qrcode package. Defaults to the first DSH profile that has one.

.PARAMETER Profile
  Optional. Rewrite that DSH profile's cordis.patch.yml so the pairing endpoint
  is reachable: adds the web-ui-remote-web-ui block if missing (with the detected
  LAN IP in trustedHosts) and points publicBaseUrl at the base being issued.
  A .bak-dshmobile backup is written first.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File pair-qr.ps1 -Mode lan -DshPort 3080

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File pair-qr.ps1 -Mode both -DshPort 3080 -Profile desktop
#>
param(
  [ValidateSet('lan', 'tunnel', 'both')]
  [string]$Mode = 'lan',
  [int]$DshPort = 3080,
  [int]$LanPort = 56875,
  [int]$ShimPort = 56998,
  [string]$Ip = '',
  [string]$Node = 'node',
  [string]$QrcodeModule = '',
  [string]$Profile = ''
)

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
if (-not $dir) { $dir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$scripts = Join-Path $dir 'scripts'

if (-not $QrcodeModule) {
  $cand = @()
  if ($env:DSH_QRCODE_MODULE) { $cand += $env:DSH_QRCODE_MODULE }
  if ($env:DSH_HOME) {
    Get-ChildItem (Join-Path $env:DSH_HOME 'profiles') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $cand += Join-Path $_.FullName 'node_modules/qrcode'
    }
  }
  $cand += Join-Path $dir 'node_modules/qrcode'
  foreach ($c in $cand) { if (Test-Path $c) { $QrcodeModule = $c; break } }
}
if (-not $QrcodeModule) { throw "找不到 qrcode 包，请用 -QrcodeModule 指定（npm i qrcode 也行）" }
$QrcodeModule = $QrcodeModule -replace '\\', '/'

# `node` is often not on PATH for a plain double-click session, but DSH ships a
# runtime of its own. Fall back to it before failing.
function Resolve-Node([string]$given) {
  if ($given -and $given -ne 'node' -and (Test-Path $given)) { return $given }
  $cmd = Get-Command $given -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $h = $env:DSH_HOME
  if (-not $h) { $h = Join-Path $env:USERPROFILE '.dsh' }
  $cand = @()
  $cand += Join-Path $h 'dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe'
  Get-ChildItem (Join-Path $h 'dsh-runtimes') -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $cand += Join-Path $_.FullName 'dependencies/node/bin/node.exe'
  }
  $cand += 'C:\Program Files\nodejs\node.exe'
  foreach ($c in $cand) { if (Test-Path $c) { return $c } }
  throw "找不到 node，请用 -Node 指定 node.exe 的完整路径"
}
$Node = Resolve-Node $Node

function Get-LanIp {
  if ($Ip) { return $Ip }
  $c = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
  Where-Object {
    $_.NetAdapter.Status -eq 'Up' -and $_.IPv4Address -and $_.IPv4DefaultGateway -and
    $_.InterfaceAlias -notmatch 'Loopback'
  } | Select-Object -First 1
  if ($c) { return $c.IPv4Address.IPAddress }
  return (Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' } |
    Select-Object -First 1).IPAddress
}

function Ensure-LanProxy([string]$lanIp) {
  $listen = Get-NetTCPConnection -LocalPort $LanPort -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalAddress -ne '127.0.0.1' }
  if ($listen) {
    Write-Host "  tcp-proxy 已在 $($listen.LocalAddress):$LanPort" -ForegroundColor DarkGray
    return
  }
  Start-Process -FilePath $Node -ArgumentList @(
    (Join-Path $scripts 'tcp-proxy.js'),
    '--listen', $lanIp, '--port', "$LanPort", '--target', "127.0.0.1:$DshPort"
  ) -RedirectStandardOutput (Join-Path $dir 'proxy.log') `
    -RedirectStandardError (Join-Path $dir 'proxy.log.err') -WindowStyle Hidden
  Start-Sleep -Seconds 2
  Write-Host "  tcp-proxy 已启动 $lanIp`:$LanPort -> 127.0.0.1:$DshPort" -ForegroundColor DarkGray
}

function Ensure-Tunnel {
  $shimUp = (Get-NetTCPConnection -State Listen -LocalPort $ShimPort -ErrorAction SilentlyContinue) -ne $null
  if (-not $shimUp) {
    Start-Process -FilePath $Node -ArgumentList @(
      (Join-Path $scripts 'tunnel-shim.js'),
      '--listen-port', "$ShimPort", '--target-port', "$DshPort",
      '--host-file', (Join-Path $dir 'public-host.txt')
    ) -RedirectStandardOutput (Join-Path $dir 'shim.log') `
      -RedirectStandardError (Join-Path $dir 'shim.err') -WindowStyle Hidden
    Start-Sleep -Milliseconds 900
    Write-Host "  shim 已启动 127.0.0.1:$ShimPort -> 127.0.0.1:$DshPort" -ForegroundColor DarkGray
  }
  $hostFile = Join-Path $dir 'public-host.txt'
  $cf = Get-Process cloudflared -ErrorAction SilentlyContinue
  if ($cf) {
    $h = if (Test-Path $hostFile) { (Get-Content $hostFile -Raw).Trim() } else { '' }
    if ($h) {
      $code = curl.exe -s -o NUL -w '%{http_code}' --max-time 10 "https://$h/api/pair/status" 2>$null
      if ($code -eq '200') {
        Write-Host "  复用现有隧道 https://$h" -ForegroundColor DarkGray
        return $h
      }
    }
  }

  $cfExe = Join-Path $dir 'bin\cloudflared.exe'
  if (-not (Test-Path $cfExe)) { throw "缺少 $cfExe，请从 cloudflare/cloudflared releases 下载后放到 bin\ 下" }

  Write-Host "  启动新隧道..." -ForegroundColor DarkGray
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 800
  Remove-Item (Join-Path $dir 'cf.log'), (Join-Path $dir 'cf.err') -ErrorAction SilentlyContinue

  # Some networks refuse SRV lookups for argotunnel.com, so edge discovery
  # fails outright. Pinning TUNNEL_EDGE skips discovery. The port is REQUIRED —
  # a bare IP fails with "missing port in address".
  if (-not $env:TUNNEL_EDGE) {
    $env:TUNNEL_EDGE = '198.41.192.227:7844,198.41.200.113:7844,198.41.192.37:7844,198.41.200.53:7844'
  }
  # --protocol http2 + --ha-connections 4: QUIC gets cut mid-stream on some
  # networks ("no recent network activity"), and a single http2 connection can
  # still 530 later; four is what held up in testing.
  Start-Process -FilePath $cfExe -ArgumentList @(
    'tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4',
    '--ha-connections', '4', '--retries', '10', '--url', "http://127.0.0.1:$ShimPort"
  ) -RedirectStandardOutput (Join-Path $dir 'cf.log') `
    -RedirectStandardError (Join-Path $dir 'cf.err') -WindowStyle Hidden

  $h = $null
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 700
    $m = Select-String -Path (Join-Path $dir 'cf.err') `
      -Pattern 'https://([a-z0-9-]+\.trycloudflare\.com)' -ErrorAction SilentlyContinue |
    Select-Object -First 1
    if ($m) { $h = $m.Matches[0].Groups[1].Value; break }
  }
  if (-not $h) { throw "拿不到隧道域名，看 $(Join-Path $dir 'cf.err')" }
  Set-Content $hostFile $h -NoNewline -Encoding ascii

  for ($i = 0; $i -lt 40; $i++) {
    $code = curl.exe -s -o NUL -w '%{http_code}' --max-time 10 "https://$h/api/pair/status" 2>$null
    if ($code -eq '200') { break }
    Start-Sleep -Milliseconds 1500
  }
  Write-Host "  隧道 https://$h 就绪" -ForegroundColor DarkGray
  return $h
}

# The pairing endpoint refuses to mint a token until some base URL is known
# (409 lan-required), and the LAN path needs its Host in trustedHosts. Doing that
# by hand is the most error-prone step, so -Profile does it.
function Set-ProfileConfig([string]$prof, [string]$base, [string]$lanIp) {
  if (-not $prof) { return }
  $home2 = $env:DSH_HOME
  if (-not $home2) { $home2 = Join-Path $env:USERPROFILE '.dsh' }
  $file = Join-Path $home2 "profiles/$prof/cordis.patch.yml"
  if (-not (Test-Path $file)) { throw "找不到 $file" }

  Copy-Item $file "$file.bak-dshmobile" -Force
  $c = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)

  if ($c -match '(?m)^- id:\s*web-ui-remote-web-ui\s*$') {
    $c = [regex]::Replace($c, 'publicBaseUrl:\s*\S+', "publicBaseUrl: $base")
    if ($c -notmatch "trustedHosts:") {
      $c = [regex]::Replace($c, '(?m)^(- id:\s*web-ui-remote-web-ui\s*\r?\n)',
        "`$1  config:`n    trustedHosts:`n      - $lanIp`n      - 127.0.0.1`n")
    }
    elseif ($c -notmatch [regex]::Escape("- $lanIp")) {
      $c = [regex]::Replace($c, '(?m)^(\s+trustedHosts:\s*\r?\n)',
        "`$1      - $lanIp`n")
    }
  }
  else {
    $block = @(
      '',
      '- id: web-ui-remote-web-ui',
      '  config:',
      "    plugin: '@linxin666/dsh-remote-web-ui'",
      '    trustedHosts:',
      "      - $lanIp",
      '      - 127.0.0.1',
      "    publicBaseUrl: $base",
      '    requirePairingForLan: true',
      '    enabled: true'
    ) -join "`n"
    $c = $c.TrimEnd() + "`n" + $block + "`n"
  }

  [System.IO.File]::WriteAllText($file, $c, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "  profile '$prof' 已更新（备份 $file.bak-dshmobile）" -ForegroundColor DarkGray
  Start-Sleep -Milliseconds 1200   # hot reload
}

$script:PairToken = $null
$script:PairExpires = $null
function Get-PairToken {
  if ($script:PairToken) { return $script:PairToken }
  $raw = curl.exe -s --max-time 15 -X POST -H 'Content-Type: application/json' -d '{}' `
    "http://127.0.0.1:$DshPort/api/pair/issue"
  $issue = $raw | ConvertFrom-Json
  if (-not $issue.ok) { throw "签发失败（$raw）——publicBaseUrl 没配？见 -Profile 或 README 第三节" }
  $script:PairToken = $issue.token
  $script:PairExpires = $issue.expiresAt
  return $issue.token
}

function New-Pair([string]$label, [string]$base) {
  $tk = Get-PairToken
  $url = "$base/pair-accept?pair=$tk"
  $txt = Join-Path $dir "pair-url-$label.txt"
  $png = Join-Path $dir "pair-qr-$label.png"
  Set-Content $txt $url -NoNewline -Encoding ascii
  $env:PAIR_URL = $url
  $env:PAIR_PNG = $png
  $env:QRMOD = $QrcodeModule
  & $Node -e "const QR=require(process.env.QRMOD);QR.toFile(process.env.PAIR_PNG,process.env.PAIR_URL,{errorCorrectionLevel:'M',width:720,margin:2,color:{dark:'#111111',light:'#ffffff'}}).then(()=>console.log('OK')).catch(e=>{console.error(e.message);process.exit(1)})"
  if ($LASTEXITCODE -ne 0) { throw "二维码生成失败 ($label)" }
  $exp = [DateTimeOffset]::FromUnixTimeMilliseconds($script:PairExpires).ToLocalTime().ToString('HH:mm:ss')
  Write-Host ""
  Write-Host "  [$label] $url" -ForegroundColor Yellow
  Write-Host "  [$label] 过期 $exp   图片 $png" -ForegroundColor DarkGray
  return [pscustomobject]@{ Mode = $label; Url = $url; Qr = $png; Expires = $script:PairExpires }
}

$out = @()
$lanIp = Get-LanIp
if ($Mode -eq 'both') {
  Write-Host "[both] 先起隧道（publicBaseUrl 用它）" -ForegroundColor Cyan
  $h = Ensure-Tunnel
  if ($h -is [array]) { $h = $h[-1] }
  Set-ProfileConfig $Profile "https://$h" $lanIp
}
if ($Mode -eq 'lan' -or $Mode -eq 'both') {
  Write-Host "[lan] 同 WiFi 直连" -ForegroundColor Cyan
  Ensure-LanProxy $lanIp
  if ($Mode -eq 'lan') { Set-ProfileConfig $Profile "http://${lanIp}:$LanPort" $lanIp }
  $code = curl.exe -s -o NUL -w '%{http_code}' --max-time 6 "http://${lanIp}:$LanPort/api/pair/status"
  if ($code -ne '200') { throw "LAN 通路不通（http://${lanIp}:$LanPort/api/pair/status -> $code）——trustedHosts 里有没有 $lanIp？" }
  $out += New-Pair 'lan' "http://${lanIp}:$LanPort"
}
if ($Mode -eq 'tunnel') {
  Write-Host "[tunnel] 异网（cloudflared）" -ForegroundColor Cyan
  $h = Ensure-Tunnel
  if ($h -is [array]) { $h = $h[-1] }
  Set-ProfileConfig $Profile "https://$h" $lanIp
  $out += New-Pair 'tunnel' "https://$h"
}
elseif ($Mode -eq 'both') {
  $out += New-Pair 'tunnel' "https://$(if ($h -is [array]) { $h[-1] } else { $h })"
}
$out | Format-Table -AutoSize
