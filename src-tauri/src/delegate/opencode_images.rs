//! OpenCode's native `run --file` image lane. Files live only for this turn,
//! including server/stdout fallback and cold session retry.
use base64::Engine;
use serde_json::Value;
use std::path::PathBuf;
use tokio::process::Command;

pub(super) struct Images {
    root: Option<PathBuf>,
    paths: Vec<PathBuf>,
}

impl Images {
    pub(super) fn attach(&self, command: &mut Command) {
        for path in &self.paths {
            command.arg("--file").arg(path);
        }
    }

    pub(super) async fn stage(messages: &[Value], resumed: bool) -> Result<Self, String> {
        let mut images = Self {
            root: None,
            paths: Vec::new(),
        };
        let users: Vec<_> = messages.iter().filter(|m| m["role"] == "user").collect();
        let selected = if resumed {
            &users[users.len().saturating_sub(1)..]
        } else {
            &users[..]
        };
        let mut total = 0;
        for message in selected {
            for uri in message["images"].as_array().into_iter().flatten() {
                let (mime, encoded) = uri
                    .as_str()
                    .and_then(|s| s.strip_prefix("data:"))
                    .and_then(|s| s.split_once(";base64,"))
                    .ok_or("OpenCode image must be a base64 data URI")?;
                let ext = match mime {
                    "image/png" => "png",
                    "image/jpeg" | "image/jpg" => "jpg",
                    "image/gif" => "gif",
                    "image/webp" => "webp",
                    _ => return Err("OpenCode image format is unsupported".into()),
                };
                if encoded.len() > 14_000_000 {
                    return Err("OpenCode image is too large".into());
                }
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(encoded)
                    .map_err(|_| "Invalid OpenCode image data")?;
                total += bytes.len();
                if bytes.is_empty() || total > 64_000_000 {
                    return Err("OpenCode image budget exceeded".into());
                }
                if images.root.is_none() {
                    let mut nonce = [0_u8; 16];
                    getrandom::fill(&mut nonce)
                        .map_err(|e| format!("Unable to create image staging id: {e}"))?;
                    let id: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
                    let root = std::env::temp_dir().join(format!("klide-opencode-{id}"));
                    let create_root = root.clone();
                    crate::blocking::run(move || {
                        let mut builder = std::fs::DirBuilder::new();
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::DirBuilderExt;
                            builder.mode(0o700);
                        }
                        builder
                            .create(&create_root)
                            .map_err(|e| format!("Unable to stage OpenCode images: {e}"))
                    })
                    .await?;
                    images.root = Some(root);
                }
                let path = images.root.as_ref().unwrap().join(format!(
                    "image-{}.{}",
                    images.paths.len() + 1,
                    ext
                ));
                tokio::fs::write(&path, bytes)
                    .await
                    .map_err(|e| format!("Unable to stage OpenCode image: {e}"))?;
                images.paths.push(path);
            }
        }
        Ok(images)
    }
}

impl Drop for Images {
    fn drop(&mut self) {
        if let Some(root) = self.root.take() {
            tokio::task::spawn_blocking(move || {
                let _ = std::fs::remove_dir_all(root);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cold_turn_attaches_history_while_resume_only_attaches_latest_images() {
        let messages = serde_json::json!([
            {"role":"user", "content":"before", "images":["data:image/png;base64,AQID"]},
            {"role":"assistant", "content":"seen"},
            {"role":"user", "content":"", "images":["data:image/jpeg;base64,BAUG"]}
        ]);
        let messages = messages.as_array().unwrap();
        let cold = Images::stage(messages, false).await.unwrap();
        assert_eq!(cold.paths.len(), 2);
        let resumed = Images::stage(messages, true).await.unwrap();
        assert_eq!(resumed.paths.len(), 1);
        assert_eq!(tokio::fs::read(&resumed.paths[0]).await.unwrap(), [4, 5, 6]);
        let mut command = Command::new("opencode");
        resumed.attach(&mut command);
        let args: Vec<_> = command.as_std().get_args().collect();
        assert_eq!(args[0], "--file");
        assert_eq!(args[1], resumed.paths[0].as_os_str());
    }

    #[tokio::test]
    async fn resume_does_not_reattach_old_images_and_bad_data_is_refused() {
        let messages = serde_json::json!([
            {"role":"user", "images":["data:image/png;base64,AQID"]},
            {"role":"user", "content":"next"}
        ]);
        assert!(Images::stage(messages.as_array().unwrap(), true)
            .await
            .unwrap()
            .paths
            .is_empty());
        let bad = serde_json::json!([{"role":"user", "images":["https://example.com/image.png"]}]);
        assert!(Images::stage(bad.as_array().unwrap(), false).await.is_err());
    }
}
