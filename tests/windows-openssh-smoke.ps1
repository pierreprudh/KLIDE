# Isolated localhost OpenSSH acceptance on an ephemeral Windows CI VM. No
# existing SSH configuration, keys, service or firewall rule is changed.
param([Parameter(Mandatory=$true)][string]$Binary)
$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
$server = "$env:WINDIR\System32\OpenSSH\sshd.exe"
if (!(Test-Path $server)) { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null }
if (!(Test-Path $server)) { throw 'Native Windows acceptance requires the OpenSSH Server Windows capability.' }
$root = Join-Path $env:RUNNER_TEMP ('klide-sshd-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $root | Out-Null
$root = $root.Replace('\','/')
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
& ssh-keygen -q -t ed25519 -N '' -f "$root/host"
if ($LASTEXITCODE -ne 0) { throw 'Host key generation failed' }
& ssh-keygen -q -t ed25519 -N '' -f "$root/client"
if ($LASTEXITCODE -ne 0) { throw 'Client key generation failed' }
@"
Port $port
ListenAddress 127.0.0.1
HostKey $root/host
PidFile $root/pid
AuthorizedKeysFile $root/client.pub
StrictModes no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
UseDNS no
LogLevel VERBOSE
"@ | Set-Content -Encoding ascii "$root/sshd_config"
$public = (Get-Content "$root/host.pub").Split(' ')
"[127.0.0.1]:$port $($public[0]) $($public[1])" | Set-Content -Encoding ascii "$root/known_hosts"
@"
Host native-smoke
  HostName 127.0.0.1
  Port $port
  User $env:USERNAME
  IdentityFile $root/client
  UserKnownHostsFile $root/known_hosts
  IdentitiesOnly yes
  BatchMode yes
  StrictHostKeyChecking yes
  ConnectTimeout 10
"@ | Set-Content -Encoding ascii "$root/client_config"
$process = Start-Process -FilePath $server -ArgumentList @('-D','-e','-f',"$root/sshd_config") -PassThru -RedirectStandardError "$root/server.log"
try {
    Start-Sleep -Seconds 2
    if ($process.HasExited) { throw (Get-Content "$root/server.log" -Raw) }
    $env:KLIDE_SMOKE_SSH_CONFIG = "$root/client_config"
    & python -u tests/remote-machine-smoke.py $Binary
    if ($LASTEXITCODE -ne 0) { throw 'Windows OpenSSH disconnect/replay acceptance failed' }
} finally {
    Remove-Item Env:KLIDE_SMOKE_SSH_CONFIG -ErrorAction SilentlyContinue
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    Get-Content "$root/server.log"
    Remove-Item -Recurse -Force $root
}
