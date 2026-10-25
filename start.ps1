[CmdletBinding()]
param(
    [ValidateSet('start', 'stop', 'status', 'trust', 'link', 'phone')]
    [string]$Action = 'start',
    [switch]$NoBrowser,
    [switch]$IgnoreSecurity,
    # phone only: JunOS.exe already asked about turning LAN mode on
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

try {
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $OutputEncoding = [Text.Encoding]::UTF8
} catch {}

$VTSupported = $false
if ($Host.UI.SupportsVirtualTerminal -or $env:WT_SESSION -or
    $env:TERM_PROGRAM -eq 'vscode' -or $PSVersionTable.PSVersion.Major -ge 7) {
    $VTSupported = $true
}

if ($VTSupported) {
    $e      = [char]27
    $R      = "$e[0m"
    $B      = "$e[1m"
    $D      = "$e[2m"
    $ACCENT = "$e[38;2;96;205;255m"    # #60CDFF  Fluent light blue
    $BLUE   = "$e[38;2;0;120;212m"     # #0078D4  Windows system blue
    $OK     = "$e[38;2;108;203;95m"    # #6CCB5F  Fluent green
    $DANGER = "$e[38;2;255;76;76m"     # #FF4C4C  Fluent red
    $WARN   = "$e[38;2;252;225;0m"     # #FCE100  Fluent amber
    $DIM    = "$e[38;2;158;158;158m"   # #9E9E9E  Neutral gray
    $MUTED  = "$e[38;2;204;204;204m"   # #CCCCCC  Light gray
} else {
    $R = ''; $B = ''; $D = ''; $ACCENT = ''; $BLUE = ''; $OK = ''
    $DANGER = ''; $WARN = ''; $DIM = ''; $MUTED = ''
}

function Step([string]$msg)    { Write-Host "  ${ACCENT}▸${R} ${B}${msg}${R}" }
function Ok([string]$msg)      { Write-Host "    ${OK}✓${R} ${MUTED}${msg}${R}" }
function Note([string]$msg)    { Write-Host "    ${DIM}ℹ ${msg}${R}" }
function Warn_([string]$msg)   { Write-Host "    ${WARN}⚠${R} ${WARN}${msg}${R}" }
function Fail_([string]$msg)   { Write-Host "    ${DANGER}✗${R} ${DANGER}${msg}${R}" }
# UUIDs, NOT indices. nvidia-smi enumerates by PCI bus order
# while CUDA sorts by speed, so the same index means different
# cards to the two of them. great.
function Get-GpuOrder {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return $null }
    $rows = & nvidia-smi --query-gpu=memory.total,uuid --format=csv,noheader,nounits 2>$null
    $uuids = @($rows | Where-Object { $_ -match ',' } | ForEach-Object {
        $f = $_ -split ','
        [pscustomobject]@{ Mb = [int]($f[0].Trim()); Uuid = $f[1].Trim() }
    } | Sort-Object Mb -Descending | ForEach-Object { $_.Uuid })
    if ($uuids.Count -eq 0) { return $null }
    return ($uuids -join ',')
}

# the card the MTP tune was measured on, as one string. MTP is
# multi-token prediction, a small drafter model guesses the next
# few tokens (how many = the draft depth) and the chat model
# checks them all in one pass. string is the vendor, then every
# GPU's name and how much VRAM it has. sorted biggest card first,
# so shuffling cards between slots isn't a change. only a real
# swap is.
#
# keep this in step with the copy in mtp-autotune.ps1. we compare
# what it prints against MTP_TUNED_GPU, so the day the two print a
# different string for the same card, every boot reads as a GPU
# change and re-runs the whole sweep. forever.
#
# there's no rocm-smi branch on windows bare metal, so an AMD box
# gets '' here. no stamp, and no automatic re-tune either.
function Get-GpuSignature {
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) { return '' }
    $rows = @(& nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null |
        ForEach-Object { $_.Trim() } | Where-Object { $_ -match ',' })
    if ($rows.Count -eq 0) { return '' }
    $cards = @($rows | ForEach-Object {
        $f = $_ -split ',', 2
        [pscustomobject]@{ Mb = [int]($f[1].Trim()); Text = ($f[0].Trim() + ':' + $f[1].Trim()) }
    } | Sort-Object Mb -Descending | ForEach-Object { $_.Text })
    return 'nvidia:' + ($cards -join ',')
}

$Runtime  = Join-Path $PSScriptRoot 'runtime'
$LogDir   = Join-Path $Runtime 'logs'
$PidFile  = Join-Path $Runtime 'pids.json'
$StateDir = Join-Path $Runtime 'state'
$CaddyDir = Join-Path $Runtime 'caddy'
$CertDir  = Join-Path $CaddyDir 'tls'
$Services = 'caddy', 'php', 'memory', 'prewarm', 'tts', 'ollama', 'llamacpp'

# read KEY=VALUE pairs in as env vars, but ONLY when they aren't
# set already, so you can still override one for a single run.
if (Test-Path .env) {
    foreach ($line in Get-Content .env) {
        # -cmatch ON PURPOSE. turkish 5.1's -match lowercases I to
        # dotless i (U+0131), [A-Za-z] misses it, AI_PROVIDER gone
        if ($line -cmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            $k = $Matches[1]; $v = $Matches[2].Trim()
            # the docker hostnames in .env.example mean nothing on bare
            # metal, so skip them and use our own localhost defaults.
            if ($v -match '://(ollama|tts|kokoro|karaoke|nginx|php|llamacpp)\b') { continue }
            if (-not (Get-Item "env:$k" -ErrorAction SilentlyContinue)) {
                Set-Item "env:$k" $v
            }
        }
    }
    # the header php shows the tts sidecar. install.ps1 writes
    # one, but a .env from before that has no line at all, and
    # the sidecar survives across runs so a per-run value would
    # lock php out of it on the second start. same rule as
    # start.sh, only when the line is MISSING.
    if (-not (Get-Content .env | Where-Object { $_ -match '^SIDECAR_SECRET=' })) {
        $bytes = [byte[]]::new(32)
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $env:SIDECAR_SECRET = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        Add-Content .env "SIDECAR_SECRET=$env:SIDECAR_SECRET"
    }
}
$SidecarSecret = if ($env:SIDECAR_SECRET) { $env:SIDECAR_SECRET } else { '' }

# her brain on another machine, mostly colab.ipynb in inference
# only mode. the quick tunnel URL and the gate key are new every
# notebook run, so a link that stopped answering is how we find
# out it changed. ask for Step 3's lines instead of making people
# hand edit .env. only these names get in, the rest of a paste is
# dropped. the manager window can't answer a prompt, it asks with
# its own box before it runs us and sets JUN_LINK_CHECKED.
$CloudKeys = @('AI_PROVIDER', 'OLLAMA_URL', 'OLLAMA_API_KEY', 'OLLAMA_MODELS_TO_PULL', 'TITLE_MODEL',
               'OMEGA_NUM_CTX', 'VLLM_URL', 'VLLM_API_KEY', 'VLLM_MODEL')

function Get-CloudLink {
    switch ("$env:AI_PROVIDER".ToLower()) {
        'vllm' { return @{ Url = "$env:VLLM_URL"; Key = "$env:VLLM_API_KEY"; Probe = '/v1/models' } }
        { $_ -in 'openrouter', 'llamacpp' } { return $null }
    }
    # unset is ours too, the loader above drops .env.example's ollama:11434
    if (-not $env:OLLAMA_URL -or $env:OLLAMA_URL -match '://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)') { return $null }
    return @{ Url = $env:OLLAMA_URL; Key = "$env:OLLAMA_API_KEY"; Probe = '/api/tags' }
}

# 8 s, a live tunnel answers in under one. a dead quick tunnel is
# a DNS failure or a cloudflare 530, a stale key the gate's 401.
# same thing to us, the lines are old.
function Test-CloudLink($link) {
    if (-not $link.Url) { return $false }
    # PS 5.1 still offers TLS 1.0 first and cloudflare won't talk to it
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $headers = @{}
    if ($link.Key) { $headers['Authorization'] = "Bearer $($link.Key)" }
    try {
        Invoke-WebRequest -UseBasicParsing -Uri ($link.Url.TrimEnd('/') + $link.Probe) -Headers $headers -TimeoutSec 8 | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Read-CloudLines {
    Write-Host "    paste the lines Step 3 of the notebook printed, then Enter on an empty line."
    Write-Host "    ${DIM}(just Enter keeps what .env has)${R}"
    $saved = 0
    while ($true) {
        $line = [Console]::ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if (-not $line) { break }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq)
        if ($key -cnotin $CloudKeys) { Note "skipped $key, the notebook never prints that one"; continue }
        $val = $line.Substring($eq + 1)
        $kept = @(Get-Content .env | Where-Object { $_ -notmatch "^$key=" })
        Set-Content -Path .env -Value ($kept + "$key=$val")
        Set-Item "env:$key" $val
        $saved++
    }
    if ($saved) { Ok "saved $saved line(s) to .env" }
}

if ($Action -eq 'link') {
    Read-CloudLines
    Note 'Stop then Start (or .\start.ps1) to bring her up with them'
    exit 0
}

if ($Action -eq 'start' -and $env:JUN_LINK_CHECKED -ne '1') {
    $link = Get-CloudLink
    if ($link -and -not (Test-CloudLink $link)) {
        if ($link.Url) {
            Warn_ "her model server at $($link.Url) isn't answering. a new notebook run means a new URL and key"
        } else {
            Warn_ 'no link to her model server in .env yet (VLLM_URL is empty)'
        }
        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
            Read-CloudLines
        } else {
            Note '.\start.ps1 link takes the new lines'
        }
    }
}

# same rules as Compare-JunVersion in install.ps1, -1/0/1. a
# -security tag sorts right above the same tag without it.
function Compare-JunVersion([string]$a, [string]$b) {
    $pa = Split-JunVersion $a
    $pb = Split-JunVersion $b
    for ($i = 0; $i -lt 4; $i++) {
        if ($pa.Core[$i] -ne $pb.Core[$i]) { return [Math]::Sign($pa.Core[$i] - $pb.Core[$i]) }
    }
    if ($pa.Pre -ne $pb.Pre) {
        if (-not $pa.Pre) { return 1 }
        if (-not $pb.Pre) { return -1 }
        return [Math]::Sign([string]::CompareOrdinal($pa.Pre, $pb.Pre))
    }
    return [Math]::Sign([int]$pa.Security - [int]$pb.Security)
}

function Split-JunVersion([string]$v) {
    $v = $v -replace '^v', ''
    $security = $v -match '-security$'
    $core, $pre = ($v -replace '-security$', '') -split '-', 2
    $nums = @($core -split '\.' | ForEach-Object { $n = 0; [void][int]::TryParse($_, [ref]$n); $n }) + @(0, 0, 0, 0)
    return @{ Core = $nums[0..3]; Pre = "$pre"; Security = $security }
}

# UPDATE_CHECK=on (the installer asks) and we're on a release
# tag: ask GitHub once what's newer on our channel. a newer
# -security release means a hole bad enough to stop her over
# (unauthenticated RCE class, see SECURITY.md), so no start
# without -IgnoreSecurity / JUN_IGNORE_SECURITY=1. exit 3 is what
# the manager window reads to offer the update. it never updates
# anything. main or a branch of your own is skipped.
function Get-UpdateNote {
    if ("$env:UPDATE_CHECK" -notmatch '^(on|1|true|yes)$') { return '' }
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { return '' }
    # native stderr under Stop throws on 5.1, and "no tag here" is a normal answer
    $ErrorActionPreference = 'Continue'
    $current = (& git -C $PSScriptRoot describe --tags --exact-match HEAD 2>$null) -join ''
    if ($LASTEXITCODE -ne 0 -or -not $current) { return '' }
    $origin = (& git -C $PSScriptRoot remote get-url origin 2>$null) -join ''
    if ($origin -notmatch '^(https://github\.com/|git@github\.com:)([^/]+/[^/]+?)(\.git)?/?$') { return '' }
    $slug = $Matches[2]
    $prereleases = "$env:JUN_CHANNEL" -in 'latest', 'experimental'

    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $tags = @()
    try {
        $headers = @{ 'User-Agent' = 'JunOS-update-check'; 'Accept' = 'application/vnd.github+json' }
        # assigned first, 5.1 hands a JSON array down the pipe as ONE object
        $list = Invoke-RestMethod -Uri "https://api.github.com/repos/$slug/releases?per_page=20" -Headers $headers -TimeoutSec 8 -UseBasicParsing -ErrorAction Stop
        $tags = @($list | Where-Object { -not $_.draft -and ($prereleases -or -not $_.prerelease) } | ForEach-Object { [string]$_.tag_name })
    } catch {
        # 60 anonymous API calls an hour per IP. the website's
        # /releases/latest redirect has no cap but only knows the
        # newest full release
        try {
            $req = [Net.HttpWebRequest]::Create("https://github.com/$slug/releases/latest")
            $req.AllowAutoRedirect = $false
            $req.UserAgent = 'JunOS-update-check'
            $req.Timeout = 8000
            $resp = $req.GetResponse()
            try { $loc = [string]$resp.Headers['Location'] } finally { $resp.Close() }
            if ($loc -match '/releases/tag/([^/?#]+)$') { $tags = @($Matches[1]) }
        } catch {}
        if (-not $tags) { Note "update check: couldn't reach GitHub, skipped"; return '' }
    }

    $newer = @($tags | Where-Object { (Compare-JunVersion $_ $current) -gt 0 })
    if (-not $newer) { return '' }
    $newest = $newer[0]
    foreach ($t in $newer) { if ((Compare-JunVersion $t $newest) -gt 0) { $newest = $t } }
    $security = $newer | Where-Object { $_ -match '-security$' } | Select-Object -First 1
    if (-not $security) {
        return "update: $newest is out, you're on $current. the Update button in the Jun OS app (or .\install.ps1 from this folder) updates her, chats and settings stay."
    }

    Write-Host ''
    Fail_ "SECURITY: $security is out and fixes a vulnerability in the version you run ($current)."
    Note "details: https://github.com/$slug/releases/tag/$security"
    Note 'update: the Update button in the Jun OS app, or .\install.ps1 from this folder. chats and settings stay.'
    if ($IgnoreSecurity -or "$env:JUN_IGNORE_SECURITY" -match '^(on|1|true|yes)$') {
        Warn_ 'starting anyway, -IgnoreSecurity / JUN_IGNORE_SECURITY is set. update soon.'
        return "reminder: you're on $current with a security fix out ($security). Update in the Jun OS app."
    }
    Fail_ 'NOT starting her on it. if she is still up from before, .\start.ps1 stop takes her down.'
    Note '.\start.ps1 -IgnoreSecurity (or JUN_IGNORE_SECURITY=1 in .env) starts her anyway, at your own risk.'
    exit 3
}

$UpdateNote = if ($Action -eq 'start') { Get-UpdateNote } else { '' }

$Port      = if ($env:JUN_PORT) { $env:JUN_PORT } else { '8080' }
# php -S speaks plain HTTP only, so it sits on loopback behind
# caddy, which does the TLS on JUN_PORT. nothing but caddy should
# ever talk to this one.
$PhpPort   = if ($env:JUN_PHP_PORT) { $env:JUN_PHP_PORT } else { '8079' }
$OllamaUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL } else { 'http://127.0.0.1:11434' }
$OllamaRemote = $OllamaUrl -notmatch '://(127\.0\.0\.1|localhost|\[::1\])(:|/|$)'
# SiteUrl stays loopback whatever we bind to. it is what the
# browser opens, and that's this machine talking to itself.
$SiteUrl   = "https://127.0.0.1:$Port"
$PhpUrl    = "http://127.0.0.1:$PhpPort"
$BindAddr  = if ($env:BIND_ADDR) { $env:BIND_ADDR.Trim() } else { '127.0.0.1' }
$LanHosts  = @()

# this box's own addresses on the home network. skips the virtual
# adapters Hyper-V, WSL and Docker Desktop leave lying around,
# those aren't reachable from a phone and naming them just widens
# the Host allowlist for nothing.
function Get-PrivateIPv4 {
    try {
        @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
            Where-Object {
                $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and
                $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback|Hyper-V|VirtualBox|VMware'
            } | Select-Object -ExpandProperty IPAddress -Unique)
    } catch { @() }
}

function Test-Elevated {
    try {
        $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
        return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { return $false }
}

# binding to 0.0.0.0 is only half of it on windows. the firewall
# drops the inbound connection before php ever sees it, so the
# phone just hangs with no error anywhere. Private profile ONLY,
# this must not follow you onto cafe wifi. delete it with:
#   Remove-NetFirewallRule -DisplayName "Jun OS (<port>)"
function Confirm-FirewallRule([string]$port) {
    $ruleName = "Jun OS ($port)"
    if (-not (Get-Command Get-NetFirewallRule -ErrorAction SilentlyContinue)) {
        Warn_ "no NetSecurity module here, so open TCP $port on private networks yourself"
        return
    }
    try {
        if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
            Note "firewall rule '$ruleName' is already there"
            return
        }
    } catch {
        Warn_ "could not read the firewall rules: $($_.Exception.Message)"
        return
    }
    if (Test-Elevated) {
        try {
            New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $port -Profile Private -ErrorAction Stop | Out-Null
            Ok "opened TCP $port on private networks (rule '$ruleName')"
        } catch {
            Warn_ "could not add the firewall rule: $($_.Exception.Message)"
        }
    } else {
        Warn_ 'windows firewall will block the phone. run this once in an admin PowerShell:'
        Note "New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -Profile Private"
    }
}

if ($Action -eq 'start' -and $BindAddr -notin @('127.0.0.1', 'localhost', '::1')) {
    $LanHosts = @(Get-PrivateIPv4)
    # php's built-in server is single-worker on windows
    # (PHP_CLI_SERVER_WORKERS is a unix-only knob), so the phone and
    # the desktop are not two users, they are one queue. whoever asks
    # second waits out the first reply's whole stream. docker doesn't
    # have this problem, php-fpm forks.
    Note 'one request at a time on windows - a second device waits for the first reply to finish'
    Note 'off loopback even the first account needs OMEGA_REGISTRATION_KEY from .env'
    Confirm-FirewallRule $Port
}

$Provider  = if ($env:AI_PROVIDER) { $env:AI_PROVIDER.ToLower() } else { 'ollama' }
if ($Provider -notin 'ollama', 'openrouter', 'llamacpp', 'vllm') { $Provider = 'ollama' }
$LlamaPort = if ($env:LLAMACPP_PORT) { $env:LLAMACPP_PORT } else { '8081' }
$LlamacppUrl = if ($env:LLAMACPP_URL) { $env:LLAMACPP_URL } else { "http://127.0.0.1:$LlamaPort" }

$GpuDevices = if ($env:GPU_DEVICES) { $env:GPU_DEVICES.Trim() } else { '' }
if (-not $GpuDevices -or $GpuDevices -eq 'auto') {
    $GpuDevices = Get-GpuOrder
} elseif ($GpuDevices -eq 'all') {
    $GpuDevices = ''
}
# an empty CUDA_VISIBLE_DEVICES means NO GPUs, not all of them,
# so only set it when we actually have a list. the model servers
# pick it up from here.
if ($GpuDevices) { $env:CUDA_VISIBLE_DEVICES = $GpuDevices }
$TensorParallel = $env:TENSOR_PARALLEL -match '^(on|1|true|yes)$'

if ($Action -eq 'start') {
    if ($GpuDevices -and ($GpuDevices -split ',').Count -gt 1) {
        Note "GPU order (largest VRAM first): $GpuDevices"
    }
    if ($TensorParallel) { Note 'tensor parallel: one model split across all GPUs' }
}

function Read-Pids {
    if (Test-Path $PidFile) {
        try { return Get-Content $PidFile -Raw | ConvertFrom-Json } catch {}
    }
    return $null
}

function Get-TrackedProcess([object]$pids, [string]$name) {
    if (-not $pids -or -not $pids.$name) { return $null }
    $p = Get-Process -Id $pids.$name -ErrorAction SilentlyContinue
    if ($p) { return $p }
    return $null
}

# what pids.json lost track of still holds JUN_PORT and the files
# under runtime\, so the uninstaller can't delete caddy.exe
function Stop-Strays([int[]]$keep = @()) {
    $here = $PSScriptRoot.TrimEnd('\') + '\'
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue `
        -Filter "Name='caddy.exe' OR Name='php.exe' OR Name='python.exe' OR Name='pythonw.exe' OR Name='llama-server.exe'" |
        Where-Object {
            $_.ProcessId -ne $PID -and $_.ProcessId -notin $keep -and $_.ParentProcessId -notin $keep -and (
                ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($here, [StringComparison]::OrdinalIgnoreCase)) -or
                ($_.CommandLine -and $_.CommandLine.IndexOf($here, [StringComparison]::OrdinalIgnoreCase) -ge 0))
        } | ForEach-Object {
            try {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop
                Ok "stopped untracked $($_.Name) (pid $($_.ProcessId))"
            } catch {
                Warn_ "could not stop $($_.Name) (pid $($_.ProcessId)): $($_.Exception.Message)"
            }
        }
}

# caddy gives the same WSAEACCES for a port another app holds and
# one windows reserved, so say which before it starts
function Get-PortBlocker([string]$port, [string]$addr) {
    if ($addr -eq 'localhost') { $addr = '127.0.0.1' }
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        for ($try = 0; $try -lt 6; $try++) {
            $owners = @(Get-NetTCPConnection -LocalPort ([int]$port) -State Listen -ErrorAction SilentlyContinue |
                Where-Object { $_.LocalAddress -in '0.0.0.0', '::', $addr -or $addr -in '0.0.0.0', '::' } |
                ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } |
                Sort-Object Id -Unique)
            if (-not $owners) { break }
            Start-Sleep -Milliseconds 500
        }
        if ($owners) {
            return ($owners | ForEach-Object {
                $path = if ($_.Path) { " ($($_.Path))" } else { ' (no path, a windows service or something run as admin)' }
                "$($_.ProcessName) pid $($_.Id)$path"
            }) -join ', '
        }
    }
    foreach ($line in (netsh interface ipv4 show excludedportrange protocol=tcp)) {
        if ($line -match '^\s*(\d+)\s+(\d+)' -and [int]$port -ge [int]$Matches[1] -and [int]$port -le [int]$Matches[2]) {
            return "windows itself, it reserved ports $($Matches[1])-$($Matches[2]) (Hyper-V, WSL or Docker Desktop do that)"
        }
    }
    return $null
}

function Test-Http([string]$url, [int]$timeoutSec = 2) {
    try {
        Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec | Out-Null
        return $true
    } catch { return $false }
}

# PS 5.1's Invoke-WebRequest has no -SkipCertificateCheck and our
# cert comes from a local CA it may not trust, so it just refuses
# caddy. a bare handshake that takes any cert answers the only
# question we have: is caddy up on the port and doing TLS.
function Test-Tls([string]$port) {
    $tcp = [Net.Sockets.TcpClient]::new()
    try {
        if (-not $tcp.ConnectAsync('127.0.0.1', [int]$port).Wait(2000)) { return $false }
        $ssl = [Net.Security.SslStream]::new($tcp.GetStream(), $false,
            [Net.Security.RemoteCertificateValidationCallback] { $true })
        $ssl.AuthenticateAsClient('localhost', $null, [Security.Authentication.SslProtocols]::Tls12, $false)
        return $true
    } catch { return $false } finally { $tcp.Dispose() }
}

# the draft depth in .env is a measurement, and it only describes
# the card it was measured on. swap the GPU and that number is
# about hardware that left the building. so hold the stamp the
# tuner wrote against what's in the box NOW and measure again when
# the two don't match.
function Invoke-MtpRecheck {
    # on the llamacpp side the tuner restarts the stack through
    # start.ps1, which is us. without this we start a tune inside
    # a tune. forever.
    if ($env:MTP_AUTOTUNE_RUNNING) { return }
    if ($env:MTP_AUTOTUNE -and $env:MTP_AUTOTUNE.ToLower() -match '^(off|0|false|no)$') { return }

    # no stamp means no tune ever finished on this box, so there's
    # nothing to compare and nothing to nag about.
    $tuned = $env:MTP_TUNED_GPU
    if (-not $tuned) { return }
    $sig = Get-GpuSignature
    if (-not $sig -or $sig -eq $tuned) { return }

    $drafter = ''
    switch ($Provider) {
        'llamacpp' { $drafter = $env:LLAMACPP_MTP }
        'ollama'   { $drafter = $env:OLLAMA_MTP }
        default    { return }
    }
    # MTP is off so there's no depth to measure. the tuner would
    # just die on it and we'd be back here every single boot.
    if (-not $drafter) { return }

    Step 'the GPU changed since MTP was tuned'
    Note "tuned on: $tuned"
    Note "here now: $sig"
    Note 'the draft depth in .env was measured on a card that is not in this box any more, so we are measuring it again'
    Note 'a few minutes on ollama, considerably longer on llamacpp where every depth needs a llama-server restart'
    Note 'set MTP_AUTOTUNE=off in .env to skip this'

    # /api/tags answers the moment ollama is up, which tells us
    # NOTHING about whether the drafter is pulled yet. the tuner
    # needs that blob on disk or it dies with "could not find the
    # drafter blob", so wait until ollama show admits it has one.
    $deadline = (Get-Date).AddMinutes(5)
    $ready = $false
    while ((Get-Date) -lt $deadline) {
        if ($Provider -eq 'llamacpp') {
            if (Test-Http "$LlamacppUrl/health") { $ready = $true; break }
        } elseif (Test-Http "$OllamaUrl/api/tags") {
            # PS 7.4 turns a non-zero exit from a native command into
            # a throw under ErrorActionPreference Stop, and "not pulled
            # yet" is the NORMAL answer in here, not an error.
            try {
                & ollama show --modelfile $drafter 2>$null | Out-Null
                if ($LASTEXITCODE -eq 0) { $ready = $true; break }
            } catch {}
        }
        Start-Sleep -Seconds 5
    }

    # leave the stamp stale ON PURPOSE. it's the only thing that
    # makes the next boot try again, and a pull that's still
    # running now is probably done by then.
    if (-not $ready) {
        Warn_ 'the drafter is not here yet, so the re-tune is skipped. run .\mtp-autotune.ps1 by hand once it has finished pulling.'
        return
    }

    try {
        $env:MTP_AUTOTUNE_RUNNING = '1'
        & "$PSScriptRoot\mtp-autotune.ps1"
    } catch {
        Warn_ "autotune did not finish, run .\mtp-autotune.ps1 by hand ($_)"
    } finally {
        Remove-Item env:MTP_AUTOTUNE_RUNNING -ErrorAction SilentlyContinue
        # the tuner just wrote .env and the copy we read at startup
        # is older than that. drop it, so a second start.ps1 in the
        # same session picks the new stamp up off disk instead of
        # re-running the whole sweep against a stale value.
        Remove-Item env:MTP_TUNED_GPU -ErrorAction SilentlyContinue
    }
}

if ($Action -eq 'stop') {
    Step 'stopping services'
    $pids = Read-Pids
    foreach ($name in $Services) {
        $p = Get-TrackedProcess $pids $name
        if (-not $p) { continue }
        try {
            Stop-Process -Id $p.Id -Force -ErrorAction Stop
            Ok "stopped $name (pid $($p.Id))"
        } catch {
            Warn_ "could not stop $name (pid $($p.Id)): $($_.Exception.Message)"
        }
    }
    Stop-Strays
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Host ''
    Ok 'all services stopped'
    exit 0
}

# the CA goes in the user's Root store, not the machine's. no
# admin needed, windows asks on its own with a "do you want to
# install this certificate" dialog, and that dialog is the consent.
# chrome and edge read that store. firefox only when it imports
# windows roots (security.enterprise_roots.enabled).
# tls\trusted is the thumbprint we added, so a new CA swaps the old
# one out and uninstall.ps1 knows which one to take back.
function Update-CaTrust([bool]$firstTime) {
    $caFile = Join-Path $CertDir 'ca.pem'
    $mark = Join-Path $CertDir 'trusted'
    if (-not (Test-Path $caFile)) { return $false }
    $ca = [Security.Cryptography.X509Certificates.X509Certificate2]::new($caFile)
    $old = if (Test-Path $mark) { (Get-Content $mark -Raw).Trim() } else { '' }
    if (-not $old -and -not $firstTime) { return $false }
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser')
    $store.Open('ReadWrite')
    try {
        if ($store.Certificates.Find('FindByThumbprint', $ca.Thumbprint, $false).Count -gt 0) {
            Set-Content $mark $ca.Thumbprint
            return $true
        }
        # same thumbprint and gone from the store = someone took it
        # out by hand. that's a no, don't ask on every start.
        if ($old -eq $ca.Thumbprint -and -not $firstTime) {
            Remove-Item $mark
            return $false
        }
        if ($old -and $old -ne $ca.Thumbprint) {
            Note 'the local CA changed, swapping the old one out of the windows trust store'
            foreach ($c in $store.Certificates.Find('FindByThumbprint', $old, $false)) { $store.Remove($c) }
        }
        Remove-Item $mark -ErrorAction SilentlyContinue
        Note "windows will ask whether to install a certificate from `"$($ca.GetNameInfo('SimpleName', $false))`". yes = no more browser warning"
        try {
            $store.Add($ca)
        } catch {
            Warn_ "not trusted ($($_.Exception.Message)). ./start.ps1 trust asks again"
            return $false
        }
        Set-Content $mark $ca.Thumbprint
        Ok 'trusted - restart the browser if it was open'
        return $true
    } finally {
        $store.Close()
    }
}

if ($Action -eq 'trust') {
    Step 'trust the local CA'
    if (-not (Test-Path (Join-Path $CertDir 'ca.pem'))) {
        Warn_ 'no CA yet. start her once first: ./start.ps1'
        exit 1
    }
    if (Update-CaTrust $true) { exit 0 } else { exit 1 }
}

function Get-PhpExe {
    $exe = Join-Path $Runtime 'php\php.exe'
    if (Test-Path $exe) { return $exe }
    $cmd = Get-Command php -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'PHP not found. Run install.ps1 first (it puts a portable PHP under runtime\php).' }
    return $cmd.Source
}

# .\start.ps1 phone: the QR the android app scans for LAN mode. asks
# before turning LAN_INFERENCE on, BIND_ADDR=0.0.0.0 opens her up
if ($Action -eq 'phone') {
    $phpExe = Get-PhpExe
    $token = "$env:JUN_LAN_TOKEN"
    $loopback = $BindAddr -in @('127.0.0.1', 'localhost', '::1')
    $need = @()
    if ("$env:LAN_INFERENCE" -notmatch '^(on|1|true|yes)$') { $need += 'LAN_INFERENCE=on' }
    if ($token.Length -lt 32) { $need += 'a new JUN_LAN_TOKEN' }
    if ($loopback) { $need += 'BIND_ADDR=0.0.0.0' }
    if ($need.Count) {
        Note "the phone needs: $($need -join ', ')"
        Note 'BIND_ADDR=0.0.0.0 lets every device on this network reach her login page, and her model with the token'
        if (-not $Yes) {
            if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
                Fail_ 'set those in .env and run .\start.ps1 phone again'
                exit 1
            }
            $ans = Read-Host '    write them to .env and restart her? [Y/n]'
            if ($ans -and $ans -notmatch '^(y|yes)$') { exit 1 }
        }
        if ($token.Length -lt 32) {
            $bytes = [byte[]]::new(32)
            [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
            $token = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
        }
        $set = [ordered]@{ LAN_INFERENCE = 'on'; JUN_LAN_TOKEN = $token }
        if ($loopback) { $set.BIND_ADDR = '0.0.0.0'; $BindAddr = '0.0.0.0' }
        if (-not (Test-Path .env)) { New-Item -ItemType File .env | Out-Null }
        foreach ($k in $set.Keys) {
            $kept = @(Get-Content .env | Where-Object { $_ -notmatch "^$k=" })
            Set-Content -Path .env -Value ($kept + "$k=$($set[$k])")
            Set-Item "env:$k" $set[$k]
        }
    }

    # php itself, not .env. an edit nobody restarted for would hand
    # the phone a token php has never heard of
    $live = $false
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$PhpUrl/api/model.php" -TimeoutSec 5 `
            -Headers @{ Authorization = "Bearer $token" } | Out-Null
        $live = $true
    } catch {}
    if (-not $live) {
        Step 'restarting her with LAN mode on'
        $self = (Get-Process -Id $PID).Path
        & $self -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath stop | Out-Host
        & $self -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath start -NoBrowser | Out-Host
        if ($LASTEXITCODE -ne 0) { Fail_ 'she did not come back up, see above'; exit 1 }
    }
    Confirm-FirewallRule $Port

    $caFile = Join-Path $CertDir 'ca.pem'
    $ca = if (Test-Path $caFile) {
        & $phpExe -r 'echo openssl_x509_fingerprint(file_get_contents($argv[1]), ''sha256'');' -- $caFile
    }
    if (-not $ca) { Fail_ "couldn't read her local CA at $caFile"; exit 1 }
    $hosts = @(Get-PrivateIPv4) + @($env:OMEGA_EXTRA_HOSTS -split '[,\s]+' | Where-Object { $_ })
    if (-not $hosts) { Fail_ 'no private address on this machine for the phone to reach'; exit 1 }
    $enc = { param($s) [Uri]::EscapeDataString($s) }
    $link = "junos://pair?mode=lan&name=$(& $enc $env:COMPUTERNAME)&token=$token&ca=$ca"
    foreach ($h in $hosts) { $link += "&url=$(& $enc "https://${h}:$Port/api/model.php")" }

    # drawn here from 0s and 1s, not as ANSI. the old console
    # without VT would print the escape codes as garbage
    $rows = @(& $phpExe (Join-Path $PSScriptRoot 'tools\qr.php') $link rows)
    $blank = '0' * $rows[0].Length
    $rows = @($blank) * 4 + $rows + @($blank) * 5
    Write-Host ''
    for ($y = 0; $y + 1 -lt $rows.Count; $y += 2) {
        $line = '    '
        for ($x = 0; $x -lt $rows[$y].Length; $x++) {
            $top = $rows[$y][$x] -eq '1'; $bottom = $rows[$y + 1][$x] -eq '1'
            $line += if ($top -and $bottom) { [char]0x2588 } elseif ($top) { [char]0x2580 } elseif ($bottom) { [char]0x2584 } else { ' ' }
        }
        Write-Host '  ' -NoNewline
        Write-Host ($line + '    ') -ForegroundColor Black -BackgroundColor White
    }
    Write-Host ''
    Note 'scan it in the Jun OS app (LAN, then Scan), or with the phone camera. same wifi as this PC.'
    Write-Host "    $link"
    Note 'the code holds the token: anyone who scans it gets her model. a new JUN_LAN_TOKEN in .env cuts everyone off.'
    exit 0
}

if ($Action -eq 'status') {
    Step 'service status'
    $pids = Read-Pids
    foreach ($name in $Services) {
        $p = Get-TrackedProcess $pids $name
        if ($p) {
            Ok ("{0,-10} running (pid {1})" -f $name, $p.Id)
        } else {
            Note ("{0,-10} not running" -f $name)
        }
    }
    if ((Test-Http $PhpUrl) -and (Test-Tls $Port)) {
        Ok "web UI     $SiteUrl"
    } else {
        Warn_ 'web UI     not responding'
    }
    exit 0
}

New-Item -ItemType Directory -Force -Path $Runtime, $LogDir, $StateDir, (Join-Path $StateDir 'rl') | Out-Null
$newPids = @{}
$oldPids = Read-Pids

function Start-Tracked([string]$name, [string]$exe, [string[]]$exeArgs) {
    $out = Join-Path $LogDir "$name.log"
    $err = Join-Path $LogDir "$name.err.log"
    # -ArgumentList just joins the array with spaces, no quoting. so
    # an install under C:\Users\Some Name\ hands php `-t C:\Users\Some`
    # and it dies with "Directory ... does not exist". quote it ourselves
    $quoted = $exeArgs | ForEach-Object { if ($_ -match '\s') { "`"$_`"" } else { $_ } }
    $p = Start-Process -FilePath $exe -ArgumentList $quoted -WindowStyle Hidden `
        -RedirectStandardOutput $out -RedirectStandardError $err -PassThru
    # touch Handle NOW. without an open handle ExitCode comes back
    # empty once the process is gone, "exited (code )" tells nobody anything
    $null = $p.Handle
    $script:newPids[$name] = $p.Id
    return $p
}

# if an Ollama server is already up (the desktop app autostarts
# one) just use it. otherwise launch `ollama serve` ourselves,
# with the model store inside the install folder so the weights
# go away with it on uninstall. an OLLAMA_URL off this machine (the
# colab notebook's tunnel) gets none of that, no install check and
# no 8 GB pull of weights that would never get used here.
if ($Provider -eq 'ollama' -and $OllamaRemote) {
    Ok "using Ollama at $OllamaUrl (not on this machine, nothing to start here)"
} elseif ($Provider -eq 'ollama') {
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    throw 'ollama is not installed. Run install.ps1 first (it installs Ollama for you).'
}

$ownOllama = $false
if (-not (Test-Http "$OllamaUrl/api/tags")) {
    Step 'start ollama serve'
    $env:OLLAMA_HOST   = '127.0.0.1:11434'
    $env:OLLAMA_MODELS = Join-Path $Runtime 'ollama-models'
    # one slot, two models. the KV cache, memory of the prompt
    # already read, uses 8 bits. needs flash attention, falls
    # back to f16 elsewhere.
    if (-not $env:OLLAMA_NUM_PARALLEL)      { $env:OLLAMA_NUM_PARALLEL = '1' }
    if (-not $env:OLLAMA_MAX_LOADED_MODELS) { $env:OLLAMA_MAX_LOADED_MODELS = '2' }
    if (-not $env:OLLAMA_KEEP_ALIVE)        { $env:OLLAMA_KEEP_ALIVE = '5m' }
    if (-not $env:OLLAMA_FLASH_ATTENTION)   { $env:OLLAMA_FLASH_ATTENTION = '1' }
    if (-not $env:OLLAMA_KV_CACHE_TYPE)     { $env:OLLAMA_KV_CACHE_TYPE = 'q8_0' }
    # Ollama has no real tensor parallelism. spreading the layers is
    # as close as it gets.
    if ($TensorParallel -and -not $env:OLLAMA_SCHED_SPREAD) { $env:OLLAMA_SCHED_SPREAD = '1' }
    Start-Tracked 'ollama' 'ollama' @('serve') | Out-Null
    $ownOllama = $true

    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Http "$OllamaUrl/api/tags")) {
        if ((Get-Date) -gt $deadline) { throw "ollama did not come up on $OllamaUrl (see runtime\logs\ollama.err.log)" }
        Start-Sleep -Seconds 1
    }
    Ok 'ollama serve ready'
} else {
    Ok "using already-running Ollama at $OllamaUrl"
    if ($GpuDevices -or $TensorParallel) {
        Note 'it was started outside Jun, so it has its own environment - the GPU settings above do not apply to it'
    }
    $p = Get-TrackedProcess $oldPids 'ollama'
    if ($p) { $newPids['ollama'] = $p.Id }
}

if ($env:OLLAMA_MODELS_TO_PULL) {
    foreach ($raw in $env:OLLAMA_MODELS_TO_PULL -split ',') {
        $m = $raw.Trim()
        if (-not $m) { continue }
        Step "pull $m"
        & ollama pull $m
        if ($LASTEXITCODE -ne 0 -and $m -match '^hf\.co/') {
            # older Ollama builds reject the hf.co alias ("realm host
            # huggingface.co does not match original host hf.co").
            $m = $m -replace '^hf\.co/', 'huggingface.co/'
            Note "retrying as $m"
            & ollama pull $m
        }
        if ($LASTEXITCODE -ne 0) { Warn_ "pull failed: $m (continuing)" }
    }
}

}

# the same preset docker/llamacpp-entrypoint.sh writes, see there
# for why the 16k ceiling is an override-kv and not a ctx-size.
# LLAMACPP_MODEL_FILE is a docker thing, it isn't read here.
function Write-LlamacppPresets([string]$path, [string[]]$chatModels) {
    $lines = @()
    $first = $true
    foreach ($m in $chatModels) {
        $lines += "[$m]", "hf-repo = $m"
        if ($env:OMEGA_NUM_CTX) { $lines += "ctx-size = $($env:OMEGA_NUM_CTX)" }
        else { $lines += 'override-kv = gemma4.context_length=int:16384', 'fit-ctx = 6144' }
        $lines += 'fit-target = 2048'
        if ($TensorParallel) { $lines += 'split-mode = row' }
        if ($first -and $env:LLAMACPP_MTP) {
            $nMax = if ($env:LLAMACPP_MTP_N_MAX) { $env:LLAMACPP_MTP_N_MAX } else { '4' }
            $lines += 'spec-type = draft-mtp', "spec-draft-hf = $($env:LLAMACPP_MTP)", "spec-draft-n-max = $nMax"
        }
        $lines += ''
        $first = $false
    }
    $title = if ($env:TITLE_MODEL) { $env:TITLE_MODEL } else { 'hf.co/efficiencyx/Titlewen-GGUF:F16' }
    $title = $title -replace '^hf\.co/', ''
    if ($title -match '/') {
        $lines += "[$title]", "hf-repo = $title", 'n-gpu-layers = 0', 'ctx-size = 2048', 'mmproj-auto = false', ''
    }
    [IO.File]::WriteAllLines($path, [string[]]$lines)
}

function Get-LlamacppStatus([string]$model) {
    try {
        $list = Invoke-RestMethod -Uri "$LlamacppUrl/v1/models" -TimeoutSec 5
        $entry = @($list.data) | Where-Object { $_.id -eq $model } | Select-Object -First 1
        if ($entry -and $entry.status) { return [string]$entry.status.value }
    } catch {}
    return ''
}

# only when AI_PROVIDER=llamacpp and LLAMACPP_URL points at this
# machine. a remote/custom URL means the user runs their own
# server. weights cache under runtime\llama-cache so they go away
# with the folder on uninstall.
if ($Provider -eq 'llamacpp' -and $LlamacppUrl -match '://(127\.0\.0\.1|localhost)\b') {
    if (Test-Http "$LlamacppUrl/health") {
        Ok "using already-running llama-server at $LlamacppUrl"
        $p = Get-TrackedProcess $oldPids 'llamacpp'
        if ($p) { $newPids['llamacpp'] = $p.Id }
    } else {
        if (-not (Get-Command llama-server -ErrorAction SilentlyContinue)) {
            throw 'llama-server is not installed. Run install.ps1 first (it installs llama.cpp via winget).'
        }
        $hfList = if ($env:LLAMACPP_MODEL_HF) { $env:LLAMACPP_MODEL_HF } else { 'efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M' }
        $chatModels = @($hfList -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
        $presets = Join-Path $Runtime 'llamacpp-models.ini'
        Write-LlamacppPresets $presets $chatModels
        Step "start llama-server ($($chatModels[0]))"
        Note 'first run downloads the model'
        # this build caches -hf downloads in the HF hub layout under
        # HF_HOME, LLAMA_CACHE alone doesn't keep them in the folder
        $env:LLAMA_CACHE = Join-Path $Runtime 'llama-cache'
        $env:HF_HOME = Join-Path $Runtime 'llama-cache\huggingface'
        $llamaArgs = @('--models-preset', $presets, '--models-max', '2', '--host', '127.0.0.1', '--port', $LlamaPort)
        $llamaProc = Start-Tracked 'llamacpp' 'llama-server' $llamaArgs

        $deadline = (Get-Date).AddMinutes(2)
        while (-not (Test-Http "$LlamacppUrl/health")) {
            if ($llamaProc.HasExited) { throw "llama-server exited (code $($llamaProc.ExitCode)) - see runtime\logs\llamacpp.err.log" }
            if ((Get-Date) -gt $deadline) { throw "llama-server did not come up on $LlamacppUrl (see runtime\logs\llamacpp.err.log)" }
            Start-Sleep -Seconds 2
        }

        # router mode loads a model on its first request, which would
        # make her first reply a 2-12 GB download. load her now, with
        # a generous deadline for exactly that download.
        try {
            Invoke-RestMethod -Method Post -Uri "$LlamacppUrl/models/load" -ContentType 'application/json' `
                -Body (@{ model = $chatModels[0] } | ConvertTo-Json) -TimeoutSec 10 | Out-Null
        } catch {}
        $deadline = (Get-Date).AddMinutes(30)
        while ((Get-LlamacppStatus $chatModels[0]) -ne 'loaded') {
            if ($llamaProc.HasExited) { throw "llama-server exited (code $($llamaProc.ExitCode)) - see runtime\logs\llamacpp.err.log" }
            if ((Get-Date) -gt $deadline) { Warn_ "$($chatModels[0]) still isn't loaded, she loads on the first message instead"; break }
            Start-Sleep -Seconds 3
        }
        Ok 'llama-server ready'
    }
}

$ttsPython = Join-Path $Runtime 'tts-venv\Scripts\python.exe'
$voiceOff = $env:VOICE -and $env:VOICE.ToLower() -match '^(off|0|false|no)$'
if (-not $voiceOff -and (Test-Path $ttsPython)) {
    $p = Get-TrackedProcess $oldPids 'tts'
    if ($p) {
        $newPids['tts'] = $p.Id
        Ok 'TTS already running'
    } else {
        Step 'start TTS sidecar'
        Note 'first run downloads voice models'
        $env:TTS_HOST    = '127.0.0.1'
        $env:TTS_PORT    = '8001'
        $env:SIDECAR_SECRET = $SidecarSecret
        $env:HF_HOME     = Join-Path $Runtime 'hf-cache'
        Start-Tracked 'tts' $ttsPython @((Join-Path $PSScriptRoot 'tts\server.py')) | Out-Null
    }
} elseif (-not $voiceOff) {
    Warn_ 'voice is on but the TTS venv is missing - re-run install.ps1 to set it up. Continuing text-only.'
}

$phpExe = Get-PhpExe
$caddyExe = Join-Path $Runtime 'caddy\caddy.exe'
if (-not (Test-Path $caddyExe)) {
    $cmd = Get-Command caddy -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'Caddy not found. Run install.ps1 again (it puts Caddy under runtime\caddy, it does the HTTPS).' }
    $caddyExe = $cmd.Source
}

foreach ($name in 'caddy', 'php') {
    $old = Get-TrackedProcess $oldPids $name
    if ($old) { Stop-Process -Id $old.Id -Force -ErrorAction SilentlyContinue }
}
Stop-Strays @($newPids.Values)
foreach ($taken in @(@{ Port = $Port; Addr = $BindAddr; Knob = 'JUN_PORT' }, @{ Port = $PhpPort; Addr = '127.0.0.1'; Knob = 'JUN_PHP_PORT' })) {
    $blocker = Get-PortBlocker $taken.Port $taken.Addr
    if ($blocker) {
        throw "port $($taken.Port) is taken by $blocker. close that, or set $($taken.Knob) to a free port in .env"
    }
}

# sanity-check php.exe before launching it hidden. a missing VC++
# runtime kills it with NO visible error (NTSTATUS 0xC0000135 =
# missing DLL). run through cmd so PHP warnings on stderr can't
# trip ErrorActionPreference.
cmd /c "`"$phpExe`" -v >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
    if ($LASTEXITCODE -eq -1073741515) {
        throw "php.exe can't start: the Microsoft Visual C++ runtime is missing. Install the 'Microsoft Visual C++ 2015-2022 Redistributable (x64)' (winget install Microsoft.VCRedist.2015+.x64) and re-run."
    }
    throw "php.exe failed its self-check (exit code $LASTEXITCODE). Try re-running install.ps1."
}

function Wait-Up([string]$name, [Diagnostics.Process]$proc, [scriptblock]$probe) {
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (& $probe)) {
        if ($proc.HasExited -or (Get-Date) -gt $deadline) {
            $err = Join-Path $LogDir "$name.err.log"
            if (Test-Path $err) {
                Write-Host "    ${DIM}--- last lines of runtime\logs\$name.err.log ---${R}"
                Get-Content $err -Tail 10 | ForEach-Object { Write-Host "    ${DIM}$_${R}" }
            }
            $why = if ($proc.HasExited) { "$name exited (code $($proc.ExitCode))" } else { 'timed out' }
            throw "web server did not come up on ${SiteUrl}: $why"
        }
        Start-Sleep -Seconds 1
    }
}

$listenLabel = if ($BindAddr -eq '127.0.0.1') { $SiteUrl } else { "https://${BindAddr}:${Port}" }
Step "start web server on $listenLabel"
$env:AI_PROVIDER            = $Provider
$env:OLLAMA_URL             = $OllamaUrl
$env:LLAMACPP_URL           = $LlamacppUrl
$env:TTS_URL                = 'http://127.0.0.1:8001'
$env:SIDECAR_SECRET         = $SidecarSecret
# one sidecar process serves both roles here, unlike docker where
# karaoke gets its own (GPU-capable) container.
$env:KARAOKE_URL            = 'http://127.0.0.1:8001'
$env:OMEGA_STATE_DIR        = $StateDir
$env:JUN_CA_FILE            = Join-Path $CertDir 'ca.pem'
# php-router.php refuses any Host that isn't in here with a 421,
# so a phone opening https://192.168.1.42:8080 needs that exact
# address listed. filled in from this machine's own private
# addresses, plus OMEGA_EXTRA_HOSTS for what we can't guess (an
# mDNS name, a tailscale address).
$SiteHosts = @('localhost', '127.0.0.1', '::1') + $LanHosts +
    @($env:OMEGA_EXTRA_HOSTS -split '[,\s]+' | Where-Object { $_ })
$env:OMEGA_ALLOWED_HOSTS    = $SiteHosts -join ','
$env:OMEGA_ALLOWED_ORIGINS  = $SiteUrl
# every request reaches php from caddy, so REMOTE_ADDR is always
# 127.0.0.1 and the rate limits would lump the phone and the
# desktop into one bucket. caddy throws away any X-Forwarded-For
# the client sent and writes the real address, and php only
# listens on loopback, so here the header is safe to believe.
$env:TRUST_PROXY            = '1'
$libPath = (Join-Path $PSScriptRoot 'webapp\api\lib\bootstrap.php').Replace('\', '/')
& $phpExe -r "require '$libPath'; db();"
if ($LASTEXITCODE -ne 0) { throw 'database migration failed' }
$oldMemory = Get-TrackedProcess $oldPids 'memory'
if ($oldMemory) { Stop-Process -Id $oldMemory.Id -Force -ErrorAction SilentlyContinue }
Start-Tracked 'memory' $phpExe @((Join-Path $PSScriptRoot 'webapp\api\consolidation-worker.php')) | Out-Null
# pre-warm. php does it because only php knows the num_ctx chat
# sends, a warm at any other one gets thrown out and reloaded on
# the first message. it waits out the pull too. logs\prewarm.log
if ($Provider -eq 'ollama') {
    Step 'pre-warm'
    Note 'loading her in the background'
    Start-Tracked 'prewarm' $phpExe @((Join-Path $PSScriptRoot 'webapp\api\prewarm.php')) | Out-Null
}
# PHP honors this on unix ONLY. on windows the built-in server
# stays single-worker, so requests made while a chat reply is
# streaming (TTS, say) just queue until it finishes. fine for a
# single local user.
$env:PHP_CLI_SERVER_WORKERS = '8'
$phpProc = Start-Tracked 'php' $phpExe @(
    '-S', "127.0.0.1:$PhpPort",
    '-t', (Join-Path $PSScriptRoot 'webapp'),
    (Join-Path $PSScriptRoot 'tools\php-router.php')
)
$newPids | ConvertTo-Json | Set-Content $PidFile
Wait-Up 'php' $phpProc { Test-Http $PhpUrl }

# the cert names every host in the allowlist, so the phone on
# https://192.168.1.42 gets the untrusted warning and not a
# name mismatch on top. a new host list is a new leaf from the
# same local CA, so a box that trusts the CA never notices.
& $phpExe (Join-Path $PSScriptRoot 'tools\local-cert.php') $CertDir @SiteHosts
if ($LASTEXITCODE -ne 0) { throw 'could not make the certificate (see above)' }
$null = Update-CaTrust ($env:JUN_TRUST_CA -match '^(1|on|yes|true)$')

# admin off: the admin API would want :2019 and we never
#   reconfigure a running caddy anyway.
# auto_https off: we bring our own cert, and its automatic
#   http->https redirect wants port 80.
# http_redirect: plain http:// typed at JUN_PORT gets a 308 to
#   https:// on the same port instead of a 400.
# flush_interval -1: every write php makes goes straight out.
#   the chat reply is SSE, one token at a time, and a buffered
#   proxy hands her whole reply over at the end.
$caddyfile = Join-Path $CaddyDir 'Caddyfile'
$certPem = (Join-Path $CertDir 'fullchain.pem').Replace('\', '/')
$keyPem  = (Join-Path $CertDir 'privkey.pem').Replace('\', '/')
[IO.File]::WriteAllText($caddyfile, @"
{
	admin off
	auto_https off
	servers {
		listener_wrappers {
			http_redirect
			tls
		}
	}
}

https://:$Port {
	bind $BindAddr
	tls "$certPem" "$keyPem"
	reverse_proxy 127.0.0.1:$PhpPort {
		flush_interval -1
	}
}
"@)
# caddy keeps its autosave and lock files under XDG_* when set,
# %AppData%\Caddy otherwise. inside runtime\ they go away with
# the install. only for caddy's own launch, nothing after it
# should inherit them.
$env:XDG_CONFIG_HOME = $CaddyDir
$env:XDG_DATA_HOME   = $CaddyDir
$caddyProc = Start-Tracked 'caddy' $caddyExe @('run', '--config', $caddyfile, '--adapter', 'caddyfile')
Remove-Item env:XDG_CONFIG_HOME, env:XDG_DATA_HOME -ErrorAction SilentlyContinue
$newPids | ConvertTo-Json | Set-Content $PidFile
Wait-Up 'caddy' $caddyProc { Test-Tls $Port }

# BEFORE the ready banner, not after. on llamacpp the sweep bounces
# llama-server six times, so she isn't usable till it finishes and
# opening the browser first would just show a broken chat.
Invoke-MtpRecheck

Write-Host ''
Write-Host "  ${OK}▸${R} ${B}${OK}ready${R} ${DIM}-${R} open ${B}${ACCENT}${SiteUrl}${R}"
foreach ($lan in $LanHosts) {
    Write-Host "    ${DIM}on your phone:${R} ${ACCENT}https://${lan}:${Port}${R} ${DIM}(same wifi)${R}"
}
if (-not (Test-Path (Join-Path $CertDir 'trusted'))) {
    Note 'the browser warns about the certificate until you trust it: ./start.ps1 trust. or click through, the traffic is encrypted either way'
}
Note 'stop with: ./start.ps1 stop   |   logs: runtime\logs\'
if ($UpdateNote) { Warn_ $UpdateNote }
if (-not $NoBrowser) { Start-Process $SiteUrl }
exit 0
