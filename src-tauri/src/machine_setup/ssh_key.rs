//! Authorize a public SSH identity. Private keys never enter the remote command.
use base64::Engine;
use std::path::Path;

fn public_key(text: &str) -> Result<String, String> {
    let mut words = text.split_whitespace();
    let algorithm = words.next().unwrap_or_default();
    let encoded = words.next().unwrap_or_default();
    if !matches!(
        algorithm,
        "ssh-ed25519"
            | "ssh-rsa"
            | "ecdsa-sha2-nistp256"
            | "ecdsa-sha2-nistp384"
            | "ecdsa-sha2-nistp521"
    ) || encoded.len() > 16384
    {
        return Err("The SSH public key is not a supported OpenSSH key".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid SSH public key")?;
    if bytes.len() < 4 + algorithm.len()
        || bytes[..4] != (algorithm.len() as u32).to_be_bytes()
        || &bytes[4..4 + algorithm.len()] != algorithm.as_bytes()
    {
        return Err("Invalid SSH public key algorithm".into());
    }
    Ok(format!("{algorithm} {encoded}"))
}

pub(super) fn local_public_key(directory: &Path) -> Result<String, String> {
    // Reuse default identities, including encrypted keys. SSH itself prompts
    // for a passphrase and adds the unlocked key to the user's agent.
    for name in ["id_ed25519", "id_ecdsa", "id_rsa"] {
        if directory.join(name).is_file() {
            if let Ok(text) = std::fs::read_to_string(directory.join(format!("{name}.pub"))) {
                if let Ok(key) = public_key(&text) {
                    return Ok(key);
                }
            }
        }
    }
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    match builder.create(directory) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error.to_string()),
    }
    let metadata = std::fs::symlink_metadata(directory).map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err("The SSH directory must be a real directory".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err(
                "Your SSH directory must belong to you and must not be writable by other accounts"
                    .into(),
            );
        }
    }
    let _lease = crate::process_lock::exclusive(&directory.join(".klide-key-setup.lock"))?;
    let private = directory.join("id_ed25519");
    let public = directory.join("id_ed25519.pub");
    if private.exists() || public.exists() {
        // Another setup may have finished while we waited for the lease.
        if private.is_file() {
            if let Ok(text) = std::fs::read_to_string(&public) {
                return public_key(&text);
            }
        }
        return Err(
            "Your existing SSH identity has no valid public key. Klide will not overwrite it."
                .into(),
        );
    }
    let temporary = directory.join(format!(
        ".klide-key-{}",
        crate::agent::transcripts::run_id()
    ));
    builder.create(&temporary).map_err(|e| e.to_string())?;
    let result = (|| {
        let generated = temporary.join("id_ed25519");
        let result = std::process::Command::new("ssh-keygen")
            .args([
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                "Klide remote access",
                "-f",
            ])
            .arg(&generated)
            .output()
            .map_err(|e| format!("Could not create an SSH key: {e}"))?;
        if !result.status.success() {
            return Err("Could not create an SSH key with ssh-keygen".into());
        }
        let generated_public = temporary.join("id_ed25519.pub");
        let key =
            public_key(&std::fs::read_to_string(&generated_public).map_err(|e| e.to_string())?)?;
        // Hard links publish without replacing an identity created elsewhere.
        std::fs::hard_link(&generated, &private).map_err(|e| {
            format!("Could not save SSH identity without overwriting an existing key: {e}")
        })?;
        std::fs::hard_link(&generated_public, &public)
            .map_err(|e| format!("Could not save SSH public key: {e}"))?;
        Ok(key)
    })();
    let _ = std::fs::remove_dir_all(&temporary);
    result
}

pub(super) fn authorization_script(key: &str) -> Result<String, String> {
    let key = crate::delegate::shell_quote(&public_key(key)?);
    Ok(format!(
        r#"set -eu
umask 077
test ! -L "$HOME/.ssh" || {{ echo 'SSH directory must not be a symlink'; exit 1; }}
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
file="$HOME/.ssh/authorized_keys"
test ! -L "$file" || {{ echo 'Authorized keys must not be a symlink'; exit 1; }}
if test ! -e "$file"; then : > "$file"; fi
test -f "$file"
chmod 600 "$file"
key={key}
if ! grep -Fqx -- "$key" "$file"; then printf '\n%s\n' "$key" >> "$file"; fi
echo 'Background SSH access enabled. Connect again to unlock your key if prompted.'
"#
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "klide-ssh-key-test-{}",
            crate::agent::transcripts::run_id()
        ));
        std::fs::create_dir(&dir).unwrap();
        dir
    }
    #[test]
    fn creates_once_reuses_identity_and_keeps_private_material_local() {
        let root = directory();
        let directory = root.join(".ssh");
        let key = local_public_key(&directory).unwrap();
        let private = std::fs::read(directory.join("id_ed25519")).unwrap();
        assert_eq!(local_public_key(&directory).unwrap(), key);
        assert_eq!(
            std::fs::read(directory.join("id_ed25519")).unwrap(),
            private
        );
        assert!(!authorization_script(&key).unwrap().contains("PRIVATE KEY"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(directory.join("id_ed25519"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn never_overwrites_an_incomplete_existing_identity() {
        let root = directory();
        std::fs::write(root.join("id_ed25519"), "existing private identity").unwrap();
        assert!(local_public_key(&root).is_err());
        assert_eq!(
            std::fs::read_to_string(root.join("id_ed25519")).unwrap(),
            "existing private identity"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn authorization_preserves_existing_access_is_idempotent_and_ignores_key_comments() {
        let root = directory();
        let key = local_public_key(&root.join("local")).unwrap();
        let remote = root.join("remote");
        std::fs::create_dir_all(remote.join(".ssh")).unwrap();
        let authorized = remote.join(".ssh/authorized_keys");
        std::fs::write(&authorized, "existing access without trailing newline").unwrap();
        let script = authorization_script(&format!("{key} comment'; touch injected")).unwrap();
        assert!(!script.contains("touch injected"));
        for _ in 0..2 {
            assert!(std::process::Command::new("sh")
                .args(["-c", &script])
                .env("HOME", &remote)
                .output()
                .unwrap()
                .status
                .success());
        }
        let content = std::fs::read_to_string(&authorized).unwrap();
        assert!(content.starts_with("existing access without trailing newline\n"));
        assert_eq!(content.lines().filter(|line| *line == key).count(), 1);
        assert!(authorization_script("-----BEGIN OPENSSH PRIVATE KEY-----").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
