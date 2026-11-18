//! Remote shell, target and artifact vocabulary. Host commands are quoted for
//! the destination shell, never interpolated as local shell code.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostOs {
    #[default]
    Linux,
    Macos,
    Windows,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostArch {
    #[serde(rename = "x86_64")]
    X86_64,
    Aarch64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTarget {
    pub os: HostOs,
    pub arch: HostArch,
}

impl HostTarget {
    pub fn asset(self) -> Result<&'static str, String> {
        match (self.os, self.arch) {
            (HostOs::Linux, HostArch::X86_64) => Ok("klide-linux-x86_64"),
            (HostOs::Macos, HostArch::X86_64) => Ok("klide-macos-x86_64"),
            (HostOs::Macos, HostArch::Aarch64) => Ok("klide-macos-aarch64"),
            (HostOs::Windows, HostArch::X86_64) => Ok("klide-windows-x86_64.exe"),
            _ => Err("This remote architecture does not have a published helper yet".into()),
        }
    }
}
impl HostOs {
    pub fn binary(self) -> &'static str {
        if self == Self::Windows {
            "~/.klide/bin/klide.exe"
        } else {
            "~/.klide/bin/klide"
        }
    }
    pub fn command(self, script: &str) -> String {
        if self == Self::Windows {
            powershell(script)
        } else {
            format!("sh -lc {}", crate::delegate::shell_quote(script))
        }
    }
}

pub fn parse_system(value: &str) -> Result<HostTarget, String> {
    let mut words = value.trim().split_whitespace();
    let os = match words.next() {
        Some("Linux") => HostOs::Linux,
        Some("Darwin") => HostOs::Macos,
        Some("Windows") => HostOs::Windows,
        _ => return Err("Unsupported remote operating system".into()),
    };
    let arch = match words.next().map(str::to_ascii_lowercase).as_deref() {
        Some("x86_64" | "amd64" | "x64") => HostArch::X86_64,
        Some("arm64" | "aarch64") => HostArch::Aarch64,
        _ => return Err("Unsupported remote processor architecture".into()),
    };
    let target = HostTarget { os, arch };
    target.asset()?;
    Ok(target)
}

pub fn ps_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
/// `~` is an explicit remote home marker; all other text stays literal.
pub fn ps_path(value: &str) -> String {
    match value.strip_prefix("~/") {
        Some(rest) => format!("(Join-Path $HOME {})", ps_quote(rest)),
        None => ps_quote(value),
    }
}
pub fn powershell(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
pub const WINDOWS_SYSTEM_PROBE: &str = "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $a=[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString(); Write-Output ('Windows '+$a)";
pub const WINDOWS_PATH: &str = "$env:PATH=\"$HOME\\.local\\bin;$env:ProgramFiles\\Git\\cmd;$env:ProgramFiles\\GitHub CLI;$env:PATH\"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding;";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_only_supported_host_assets() {
        assert_eq!(
            parse_system("Darwin arm64").unwrap().asset().unwrap(),
            "klide-macos-aarch64"
        );
        assert_eq!(
            parse_system("Darwin x86_64").unwrap().asset().unwrap(),
            "klide-macos-x86_64"
        );
        assert_eq!(
            parse_system("Windows X64").unwrap().asset().unwrap(),
            "klide-windows-x86_64.exe"
        );
        assert!(parse_system("Windows Arm64").is_err());
        assert!(parse_system("Plan9 x86_64").is_err());
    }
    #[test]
    fn powershell_paths_do_not_interpret_user_text() {
        assert_eq!(
            ps_path("~/a'b/$env:KEY; x"),
            "(Join-Path $HOME 'a''b/$env:KEY; x')"
        );
        assert_eq!(ps_quote("C:\\a'b"), "'C:\\a''b'");
        let command = powershell("Write-Output 'hi'\n");
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(command.split_whitespace().last().unwrap())
            .unwrap();
        let text = String::from_utf16(
            &bytes
                .chunks_exact(2)
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
        .unwrap();
        assert_eq!(text, "Write-Output 'hi'\n");
    }
}
