# Native Windows; runs only in the user's explicit SSH setup terminal.
$ErrorActionPreference = 'Stop'
function Install-PackageIfMissing($Command, $Package) {
    if (!(Get-Command $Command -ErrorAction SilentlyContinue)) {
        if (!(Get-Command winget -ErrorAction SilentlyContinue)) {
            throw "Install $Package on this Windows machine, then retry (winget is unavailable in this SSH session)."
        }
        & winget install --exact --id $Package --accept-package-agreements --accept-source-agreements --disable-interactivity
        if ($LASTEXITCODE -ne 0) { throw "Could not install $Package. Install it locally on Windows, then retry." }
        $env:PATH = [Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')
    }
}
Install-PackageIfMissing git Git.Git
Install-PackageIfMissing gh GitHub.cli
if (!(Get-Command claude -ErrorAction SilentlyContinue)) {
    $installer = Invoke-WebRequest -UseBasicParsing https://claude.ai/install.ps1
    & ([scriptblock]::Create($installer.Content))
    if ($LASTEXITCODE -ne 0) { throw 'Claude Code installation failed. Review the installer output.' }
}
$env:PATH = "$HOME\.local\bin;$env:PATH"
& git --version
if ($LASTEXITCODE -ne 0) { throw 'Git is not available. Reconnect after installing Git for Windows.' }
& claude --version
if ($LASTEXITCODE -ne 0) { throw 'Claude Code is not available. Review the installer output.' }
Write-Output 'Prerequisites installed. Continue in Klide.'
