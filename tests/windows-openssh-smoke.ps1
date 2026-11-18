# Isolated localhost OpenSSH acceptance on an ephemeral Windows CI VM. No
# existing SSH configuration, keys, service or firewall rule is changed.
param([Parameter(Mandatory=$true)][string]$Binary)
$ErrorActionPreference = 'Stop'
$PSNativeCommandArgumentPassing = 'Standard'
$env:PATH = "$env:WINDIR\System32\OpenSSH;$env:PATH"
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
# Match production OpenSSH host-key ACLs: only SYSTEM and Administrators.
# The runner temp directory otherwise inherits permissions sshd rejects.
$administrators = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$system = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
function Set-KeyAcl([string]$path, $owner, $identities) {
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($identity in $identities) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'))
    }
    Set-Acl -LiteralPath $path -AclObject $acl
}
Set-KeyAcl "$root/host" $administrators @($administrators,$system)
Set-KeyAcl "$root/client" $user @($user,$administrators,$system)
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
# Service Control Manager launches sshd outside the CI step's non-breakaway
# job, as a real Windows OpenSSH installation does. Use a unique service and
# config; the VM's existing SSH service/configuration are never changed.
$name = 'KlideSmoke-' + [guid]::NewGuid().ToString('N')
$binaryPath = '"' + $server + '" -f "' + $root + '/sshd_config" -E "' + $root + '/server.log"'
New-Service -Name $name -BinaryPathName $binaryPath -StartupType Manual | Out-Null
try {
    Start-Service -Name $name
    (Get-Service -Name $name).WaitForStatus('Running',[TimeSpan]::FromSeconds(20))
    $env:KLIDE_SMOKE_SSH_CONFIG = "$root/client_config"
    & python -u tests/remote-machine-smoke.py $Binary
    if ($LASTEXITCODE -ne 0) { throw 'Windows OpenSSH disconnect/replay acceptance failed' }
    # Exercise the actual native installer from an SSH session as well. A
    # direct CI-shell launch is intentionally refused by its outer job policy.
    function Quote-Literal([string]$value) { return "'" + $value.Replace("'", "''") + "'" }
    $python = (Get-Command python).Source
    $installerTest = (Resolve-Path tests/remote-install-smoke.py).Path
    $nativeBinary = (Resolve-Path $Binary).Path
    $script = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(`$false); `$env:PYTHONUTF8='1'; `$env:PATH=" + (Quote-Literal $env:PATH) + "; & " + (Quote-Literal $python) + " -u " + (Quote-Literal $installerTest) + " " + (Quote-Literal $nativeBinary) + "; exit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    & ssh -F "$root/client_config" native-smoke "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded"
    if ($LASTEXITCODE -ne 0) { throw 'Windows OpenSSH installer acceptance failed' }
} finally {
    Remove-Item Env:KLIDE_SMOKE_SSH_CONFIG -ErrorAction SilentlyContinue
    Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
    & sc.exe delete $name | Out-Null
    if (Test-Path "$root/server.log") { Get-Content "$root/server.log" }
    Remove-Item -Recurse -Force $root
}
