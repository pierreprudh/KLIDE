//! Repository-only GitHub access. Personal OAuth credentials never leave this Mac.
use crate::remote_platform::{ps_quote, HostOs};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepositoryContext {
    repository: String,
    author_name: String,
    author_email: String,
}

pub(crate) fn slug(root: &str) -> Result<String, String> {
    let origin = crate::machines::origin_repo(root).ok_or("This project has no origin remote.")?;
    parse_slug(&origin)
}

pub(crate) fn github_origin(root: &str) -> bool {
    crate::machines::origin_repo(root).is_some_and(|origin| {
        origin.starts_with("git@github.com:")
            || reqwest::Url::parse(&origin)
                .ok()
                .is_some_and(|url| url.host_str() == Some("github.com"))
    })
}

fn parse_slug(origin: &str) -> Result<String, String> {
    let path = if let Some(path) = origin.strip_prefix("git@github.com:") {
        path.to_string()
    } else {
        let url = reqwest::Url::parse(origin)
            .map_err(|_| "Repository-only access requires a GitHub.com origin.")?;
        if url.host_str() != Some("github.com")
            || !matches!(url.scheme(), "https" | "ssh")
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || (url.scheme() == "https" && !url.username().is_empty())
        {
            return Err("Use a GitHub.com origin without embedded credentials.".into());
        }
        url.path().trim_start_matches('/').to_string()
    };
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let pieces: Vec<_> = path.split('/').collect();
    if pieces.len() != 2
        || pieces.iter().any(|part| {
            part.is_empty()
                || matches!(*part, "." | "..")
                || !part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        })
    {
        return Err("Choose an origin in the form github.com/owner/repository.".into());
    }
    Ok(path.to_string())
}

fn remote_command(os: HostOs, script: &str) -> String {
    if os == HostOs::Windows {
        os.command(&format!(
            "{} {script}",
            crate::remote_platform::WINDOWS_PATH
        ))
    } else {
        os.command(&format!(
            "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"\n{script}"
        ))
    }
}

fn key_id(repository: &str) -> String {
    format!("{:x}", Sha256::digest(repository.to_lowercase().as_bytes()))
}

pub(crate) fn ssh_command(repository: &str, os: HostOs) -> String {
    ssh_command_for_key(&key_id(repository), os)
}

fn ssh_command_for_key(id: &str, os: HostOs) -> String {
    let directory = format!("$HOME/.klide/repository-keys/{id}");
    format!("ssh -F {} -o BatchMode=yes -o ConnectTimeout=10 -o IdentityAgent=none -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=\"{directory}/known_hosts\" -i \"{directory}/key\"", if os == HostOs::Windows { "NUL" } else { "/dev/null" })
}

/// Only the exact command Klide generates is safe in a restricted checkout.
/// The key directory is a hex digest, never shell text supplied by a repo.
pub(crate) fn is_managed_ssh_command(command: &str) -> bool {
    let Some((_, tail)) = command.split_once("$HOME/.klide/repository-keys/") else { return false; };
    let Some((id, _)) = tail.split_once('/') else { return false; };
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { return false; }
    let os = if cfg!(windows) { HostOs::Windows } else { HostOs::Linux };
    command == ssh_command_for_key(id, os)
}

pub(crate) fn access_probe(root: &str, os: HostOs) -> String {
    let Ok(repository) = slug(root) else {
        return String::new();
    };
    let directory = format!(".klide/repository-keys/{}", key_id(&repository));
    if os == HostOs::Windows {
        format!("if (Test-Path -LiteralPath (Join-Path $HOME '{directory}/verified')) {{ Write-Output 'repositoryAccess=ready' }}; ")
    } else {
        format!("if test -f \"$HOME/{directory}/verified\" && test -f \"$HOME/{directory}/key\"; then echo repositoryAccess=ready; fi; ")
    }
}

fn context(root: &str) -> Result<RepositoryContext, String> {
    let repository = slug(root)?;
    let author_name = crate::git::git_output(root, &["config", "--get", "user.name"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let author_email = crate::git::git_output(root, &["config", "--get", "user.email"])
        .unwrap_or_default()
        .trim()
        .to_string();
    if [&author_name, &author_email]
        .iter()
        .any(|value| value.len() > 254 || value.chars().any(char::is_control))
    {
        return Err("The local Git author identity is not valid.".into());
    }
    Ok(RepositoryContext {
        repository,
        author_name,
        author_email,
    })
}

#[tauri::command]
pub(crate) async fn machine_repository_context(
    workspace_root: String,
) -> Result<RepositoryContext, String> {
    crate::blocking::run(move || context(&workspace_root)).await
}

fn prepare_script(repository: &str, known_hosts: &str, os: HostOs) -> String {
    let directory = format!(".klide/repository-keys/{}", key_id(repository));
    if os == HostOs::Windows {
        return format!("$ErrorActionPreference='Stop'; $d=Join-Path $HOME '{directory}'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $key=Join-Path $d 'key'; if (!(Test-Path -LiteralPath $key)) {{ & ssh-keygen -t ed25519 -N '\"\"' -C 'Klide repository access' -f $key; if ($LASTEXITCODE -ne 0) {{ throw 'Could not create repository key' }} }}; [IO.File]::WriteAllText((Join-Path $d 'known_hosts'),{},[Text.UTF8Encoding]::new($false)); & ssh-keygen -y -P '\"\"' -f $key; exit $LASTEXITCODE", ps_quote(known_hosts));
    }
    format!("set -e\numask 077\nd=\"$HOME/{directory}\"\nmkdir -p -- \"$d\"\nif test -L \"$d\" || test -L \"$d/key\" || test -L \"$d/known_hosts\"; then echo 'Repository key path cannot be a symlink' >&2; exit 1; fi\nchmod 700 \"$d\"\nif ! test -f \"$d/key\"; then ssh-keygen -q -t ed25519 -N '' -C 'Klide repository access' -f \"$d/key\"; fi\nprintf '%s' {} > \"$d/known_hosts\"\nchmod 600 \"$d/key\" \"$d/known_hosts\"\nssh-keygen -y -P '' -f \"$d/key\"", crate::delegate::shell_quote(known_hosts))
}

fn github_known_hosts() -> Result<String, String> {
    #[derive(Deserialize)]
    struct Metadata {
        ssh_keys: Vec<String>,
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Klide-repository-access")
        .build()
        .map_err(|e| e.to_string())?;
    let metadata: Metadata = client
        .get("https://api.github.com/meta")
        .send()
        .and_then(|response| response.error_for_status())
        .map_err(|_| "Could not verify GitHub's SSH host keys over HTTPS.")?
        .json()
        .map_err(|_| "Invalid GitHub SSH host-key response.")?;
    let keys: Vec<_> = metadata
        .ssh_keys
        .into_iter()
        .filter(|key| key.starts_with("ssh-ed25519 ") && !key.contains(['\n', '\r', '\0']))
        .collect();
    if keys.is_empty() {
        return Err("GitHub did not publish an Ed25519 SSH host key.".into());
    }
    Ok(keys
        .iter()
        .map(|key| format!("github.com {key}\n"))
        .collect())
}

#[derive(Deserialize)]
struct DeployKey {
    id: u64,
    key: String,
    read_only: bool,
}

fn public_key_material(key: &str) -> Result<String, String> {
    let mut fields = key.split_whitespace();
    let algorithm = fields.next().unwrap_or_default();
    let material = fields.next().unwrap_or_default();
    if algorithm != "ssh-ed25519" || material.is_empty() {
        return Err("The machine did not return a valid Ed25519 public key.".into());
    }
    // GitHub stores only the algorithm and key material. ssh-keygen -y can
    // include the key's comment; comments and whitespace are not key identity.
    Ok(format!("{algorithm} {material}"))
}

fn existing_deploy_key(
    keys: impl Iterator<Item = DeployKey>,
    public_key: &str,
) -> Option<DeployKey> {
    let expected = public_key_material(public_key).ok()?;
    keys.into_iter()
        .find(|key| public_key_material(&key.key).ok().as_ref() == Some(&expected))
}

#[tauri::command]
pub(crate) async fn machine_repository_connect(
    id: String,
    workspace_root: String,
    allow_push: Option<bool>,
) -> Result<String, String> {
    crate::blocking::run(move || {
        let ctx = context(&workspace_root)?;
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        let os = crate::machine_install::detect_target(&machine.ssh_host)?.os;
        let hosts = github_known_hosts()?;
        let prepared = crate::machine_install::ssh(&machine.ssh_host, &remote_command(os, &prepare_script(&ctx.repository, &hosts, os)))?;
        let public_key = public_key_material(String::from_utf8_lossy(&prepared.stdout).lines().find(|line| line.starts_with("ssh-ed25519 ")).ok_or("The machine did not return a repository public key.")?)?;
        let endpoint = format!("repos/{}/keys", ctx.repository);
        let existing = crate::git::github::gh_output(&workspace_root, &["api", &endpoint, "--paginate", "--slurp"])
            .map_err(|_| "Sign in to GitHub on this Mac with repository admin access, then retry. No personal GitHub login is needed on the remote machine.")?;
        let pages: Vec<Vec<DeployKey>> = serde_json::from_str(&existing).map_err(|_| "GitHub returned an invalid repository-key list.")?;
        let found = existing_deploy_key(pages.into_iter().flatten(), &public_key);
        let directory = format!(".klide/repository-keys/{}", key_id(&ctx.repository));
        if allow_push.is_none() && found.is_none() {
            let clear = if os == HostOs::Windows { format!("Remove-Item -LiteralPath (Join-Path $HOME '{directory}/verified') -ErrorAction SilentlyContinue") } else { format!("rm -f -- \"$HOME/{directory}/verified\"") };
            let _ = crate::machine_install::ssh(&machine.ssh_host, &remote_command(os, &clear));
            return Err("This repository key was removed from GitHub. Reconnect repository access.".into());
        }
        if let Some(key) = &found {
            if allow_push.is_some_and(|push| key.read_only != !push) { return Err("This repository key already has different permissions. Remove it in GitHub repository Settings → Deploy keys before changing access.".into()); }
        }
        let allow_push = allow_push.unwrap_or_else(|| found.as_ref().is_some_and(|key| !key.read_only));
        let created = found.is_none();
        let deploy_key_id = match found {
            Some(key) => key.id,
            None => {
                let key_arg = format!("key={public_key}");
                let title = format!("title=Klide · {}", machine.label());
                let permissions = format!("read_only={}", !allow_push);
                let response = crate::git::github::gh_output(&workspace_root, &["api", "--method", "POST", &endpoint, "--raw-field", &title, "--raw-field", &key_arg, "--field", &permissions])?;
                serde_json::from_str::<DeployKey>(&response).map_err(|_| "GitHub returned an invalid repository key.")?.id
            }
        };
        let command = ssh_command(&ctx.repository, os);
        let verify = if os == HostOs::Windows {
            format!("$ErrorActionPreference='Stop'; $env:GIT_SSH_COMMAND={}; & git ls-remote --heads {}; if ($LASTEXITCODE -ne 0) {{ throw 'Repository access could not be verified' }}; [IO.File]::WriteAllText((Join-Path $HOME '{directory}/verified'),'verified');", ps_quote(&command), ps_quote(&format!("git@github.com:{}.git", ctx.repository)))
        } else {
            format!("set -e\nGIT_SSH_COMMAND={} git ls-remote --heads {} >/dev/null\numask 077\nprintf verified > \"$HOME/{directory}/verified\"", crate::delegate::shell_quote(&command), crate::delegate::shell_quote(&format!("git@github.com:{}.git", ctx.repository)))
        };
        if let Err(error) = crate::machine_install::ssh(&machine.ssh_host, &remote_command(os, &verify)) {
            if created && crate::git::github::gh_output(&workspace_root, &["api", "--method", "DELETE", &format!("{endpoint}/{deploy_key_id}")]).is_err() {
                return Err(format!("Access verification failed and the new deploy key could not be removed. Remove key {deploy_key_id} in {}/settings/keys before retrying. {error}", format!("https://github.com/{}",ctx.repository)));
            }
            return Err(format!("Repository access was not verified. {error}"));
        }
        Ok(format!("Access to {} verified ({}). No personal GitHub login was copied.", ctx.repository, if allow_push { "read and push" } else { "read only" }))
    }).await
}

pub(crate) fn git_configuration(root: &str, checkout: &str, os: HostOs) -> Result<String, String> {
    let ctx = context(root)?;
    let command = ssh_command(&ctx.repository, os);
    let directory = format!(".klide/repository-keys/{}", key_id(&ctx.repository));
    let ssh_url = format!("git@github.com:{}.git", ctx.repository);
    let https_url = format!("https://github.com/{}.git", ctx.repository);
    if os == HostOs::Windows {
        let path = crate::remote_platform::ps_path(checkout);
        let mut script = format!("if (Test-Path -LiteralPath (Join-Path $HOME '{directory}/verified')) {{ & git -C {path} config --local core.sshCommand {}; if ($LASTEXITCODE -ne 0) {{ throw 'Could not scope repository access' }}; & git -C {path} remote set-url origin {} }} else {{ & git -C {path} remote set-url origin {} }}; if ($LASTEXITCODE -ne 0) {{ throw 'Could not scope repository origin' }}; & git -C {path} config --local credential.helper '\"\"'; if ($LASTEXITCODE -ne 0) {{ throw 'Could not scope Git credentials' }}; ", ps_quote(&command), ps_quote(&ssh_url), ps_quote(&https_url));
        for (key, value) in [
            ("user.name", ctx.author_name),
            ("user.email", ctx.author_email),
        ] {
            if !value.is_empty() {
                script.push_str(&format!("& git -C {path} config --local {key} {}; if ($LASTEXITCODE -ne 0) {{ throw 'Could not save repository identity' }}; ",ps_quote(&value)));
            }
        }
        return Ok(script);
    }
    let path = crate::machines::remote_path_word(checkout);
    let mut script = format!("if test -f \"$HOME/{directory}/verified\"; then\ngit -C {path} config --local core.sshCommand {}\ngit -C {path} remote set-url origin {}\nelse\ngit -C {path} remote set-url origin {}\nfi\ngit -C {path} config --local credential.helper ''\n",crate::delegate::shell_quote(&command),crate::delegate::shell_quote(&ssh_url),crate::delegate::shell_quote(&https_url));
    for (key, value) in [
        ("user.name", ctx.author_name),
        ("user.email", ctx.author_email),
    ] {
        if !value.is_empty() {
            script.push_str(&format!(
                "git -C {path} config --local {key} {}\n",
                crate::delegate::shell_quote(&value)
            ));
        }
    }
    Ok(script)
}

pub(crate) fn clone_script(root: &str, checkout: &str, os: HostOs) -> Result<String, String> {
    let ctx = context(root)?;
    let directory = format!(".klide/repository-keys/{}", key_id(&ctx.repository));
    let command = ssh_command(&ctx.repository, os);
    let scoped = git_configuration(root, checkout, os)?;
    let mut identity = String::new();
    for (key, value) in [
        ("user.name", ctx.author_name),
        ("user.email", ctx.author_email),
    ] {
        if value.is_empty() {
            continue;
        }
        if os == HostOs::Windows {
            identity.push_str(&format!("& git -C {} config --local {key} {}; if ($LASTEXITCODE -ne 0) {{ throw 'Could not save repository identity' }}; ",crate::remote_platform::ps_path(checkout),ps_quote(&value)));
        } else {
            identity.push_str(&format!(
                "git -C {} config --local {key} {}\n",
                crate::machines::remote_path_word(checkout),
                crate::delegate::shell_quote(&value)
            ));
        }
    }
    let ssh_url = format!("git@github.com:{}.git", ctx.repository);
    let https_url = format!("https://github.com/{}.git", ctx.repository);
    if os == HostOs::Windows {
        let path = crate::remote_platform::ps_path(checkout);
        return Ok(format!("$env:GIT_TERMINAL_PROMPT='0'; $env:GIT_ASKPASS='false'; $env:SSH_ASKPASS='false'; $destination={path}; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null; if (Test-Path -LiteralPath (Join-Path $HOME '{directory}/verified')) {{ $env:GIT_SSH_COMMAND={}; & git clone -- {} $destination; if ($LASTEXITCODE -ne 0) {{ throw 'Clone failed; existing files were kept' }}; {scoped} }} else {{ & git -c credential.helper= -c core.askPass= -c http.extraHeader= clone -- {} $destination; if ($LASTEXITCODE -ne 0) {{ throw 'Connect repository access before cloning a private repository' }}; & git -C $destination config --local credential.helper ''; {identity} }}",ps_quote(&command),ps_quote(&ssh_url),ps_quote(&https_url)));
    }
    Ok(format!("export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"\nset -e\nexport GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false\ndestination={}\nmkdir -p -- \"$(dirname -- \"$destination\")\"\nif test -f \"$HOME/{directory}/verified\"; then\nGIT_SSH_COMMAND={} git clone -- {} \"$destination\"\n{scoped}\nelse\ngit -c credential.helper= -c core.askPass= -c http.extraHeader= clone -- {} \"$destination\"\ngit -C \"$destination\" config --local credential.helper ''\n{identity}\nfi",crate::machines::remote_path_word(checkout),crate::delegate::shell_quote(&command),crate::delegate::shell_quote(&ssh_url),crate::delegate::shell_quote(&https_url)))
}

#[tauri::command]
pub(crate) async fn machine_repository_configure(
    id: String,
    workspace_root: String,
    path: String,
) -> Result<(), String> {
    crate::blocking::run(move || {
        let ctx=context(&workspace_root)?;
        let machine=crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        crate::machines::validate_machine(&machine)?;
        let os=crate::machine_install::detect_target(&machine.ssh_host)?.os;
        crate::machine_files::validate_path(&path)?;
        let checkout=path;
        let accepted=[format!("git@github.com:{}.git",ctx.repository),format!("git@github.com:{}",ctx.repository),format!("https://github.com/{}.git",ctx.repository),format!("https://github.com/{}",ctx.repository),format!("ssh://git@github.com/{}.git",ctx.repository)];
        let config=git_configuration(&workspace_root,&checkout,os)?;
        let verify=if os==HostOs::Windows {
            format!("$origin=& git -C {} remote get-url origin; if ($LASTEXITCODE -ne 0 -or @({}) -notcontains $origin) {{ throw 'This folder belongs to another repository' }}; {config}",crate::remote_platform::ps_path(&checkout),accepted.iter().map(|url| ps_quote(url)).collect::<Vec<_>>().join(","))
        } else {
            format!("set -e\norigin=$(git -C {} remote get-url origin)\ncase \"$origin\" in {}) ;; *) echo 'This folder belongs to another repository' >&2; exit 1;; esac\n{config}",crate::machines::remote_path_word(&checkout),accepted.iter().map(|url|crate::delegate::shell_quote(url)).collect::<Vec<_>>().join("|"))
        };
        crate::machine_install::ssh(&machine.ssh_host,&remote_command(os, &verify))?;
        Ok(())
    }).await
}

#[tauri::command]
pub(crate) async fn machine_github_accounts(id: String) -> Result<Vec<String>, String> {
    crate::blocking::run(move || {
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        let os = crate::machine_install::detect_target(&machine.ssh_host)?.os;
        let script = if os == HostOs::Windows { "& gh auth status --hostname github.com --json hosts --jq '.hosts[\"github.com\"][] | .login'; exit 0" }
            else { "export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; gh auth status --hostname github.com --json hosts --jq '.hosts[\"github.com\"][] | .login' 2>/dev/null || true" };
        let out = crate::machine_install::ssh(&machine.ssh_host, &remote_command(os, script))?;
        Ok(String::from_utf8_lossy(&out.stdout).lines().filter(|login| !login.is_empty() && login.len() <= 39 && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).map(str::to_string).collect())
    }).await
}

#[tauri::command]
pub(crate) async fn machine_github_logout(id: String, login: String) -> Result<(), String> {
    crate::blocking::run(move || {
        if login.is_empty() || login.len() > 39 || !login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("Choose a GitHub account to disconnect.".into()); }
        let machine = crate::machines::get(&id).ok_or("Machine is no longer configured")?;
        let os = crate::machine_install::detect_target(&machine.ssh_host)?.os;
        let script = if os == HostOs::Windows { format!("'y' | & gh auth logout --hostname github.com --user {}; exit $LASTEXITCODE",ps_quote(&login)) }
            else { format!("export PATH=\"$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; printf 'y\\n' | gh auth logout --hostname github.com --user {}",crate::delegate::shell_quote(&login)) };
        crate::machine_install::ssh(&machine.ssh_host,&remote_command(os, &script))?;
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_keys_without_comments_reuse_the_existing_read_only_grant() {
        let material = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDummyPublicFixture";
        let keys = vec![DeployKey {
            id: 42,
            key: material.into(),
            read_only: true,
        }];
        let found = existing_deploy_key(
            keys.into_iter(),
            &format!("{material} Klide repository access\r\n"),
        )
        .expect(
            "GitHub omits the comment; this must reuse the existing key rather than POST it again",
        );
        assert_eq!(found.id, 42);
        assert!(found.read_only);
        assert!(existing_deploy_key(vec![found].into_iter(), "ssh-ed25519 another-key").is_none());
    }
    fn git(path: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }
    #[cfg(unix)]
    #[test]
    fn commit_identity_and_access_are_local_to_the_selected_repository() {
        let root = std::env::temp_dir().join(format!(
            "klide-repo-scope-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for folder in ["local", "remote", "other", "home"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
        }
        for folder in ["local", "remote", "other"] {
            let path = root.join(folder);
            git(&path, &["init", "-q"]);
            git(
                &path,
                &[
                    "remote",
                    "add",
                    "origin",
                    "https://github.com/example/project.git",
                ],
            );
            git(&path, &["config", "--local", "user.name", folder]);
            git(
                &path,
                &[
                    "config",
                    "--local",
                    "user.email",
                    &format!("{folder}@example.test"),
                ],
            );
        }
        let global = root.join("home/global.gitconfig");
        let original=b"[user]\n name = Shared User\n email = shared@example.test\n[credential]\n helper = shared-helper\n";
        std::fs::write(&global, original).unwrap();
        let script = git_configuration(
            root.join("local").to_str().unwrap(),
            root.join("remote").to_str().unwrap(),
            HostOs::Macos,
        )
        .unwrap();
        assert!(!script.contains("--global"));
        let out = std::process::Command::new("sh")
            .args(["-ec", &script])
            .env("HOME", root.join("home"))
            .env("GIT_CONFIG_GLOBAL", &global)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            git(&root.join("remote"), &["config", "--local", "user.name"]),
            "local"
        );
        assert_eq!(
            git(&root.join("remote"), &["config", "--local", "user.email"]),
            "local@example.test"
        );
        assert_eq!(
            git(&root.join("other"), &["config", "--local", "user.name"]),
            "other"
        );
        assert_eq!(std::fs::read(&global).unwrap(), original);
        assert_eq!(
            git(
                &root.join("remote"),
                &["config", "--local", "credential.helper"]
            ),
            ""
        );
        let keydir = root
            .join("home/.klide/repository-keys")
            .join(key_id("example/project"));
        std::fs::create_dir_all(&keydir).unwrap();
        std::fs::write(keydir.join("verified"), "verified").unwrap();
        let out = std::process::Command::new("sh")
            .args(["-ec", &script])
            .env("HOME", root.join("home"))
            .env("GIT_CONFIG_GLOBAL", &global)
            .output()
            .unwrap();
        assert!(out.status.success());
        assert_eq!(
            git(&root.join("remote"), &["remote", "get-url", "origin"]),
            "git@github.com:example/project.git"
        );
        assert!(git(
            &root.join("remote"),
            &["config", "--local", "core.sshCommand"]
        )
        .contains("IdentityAgent=none"));
        assert_eq!(std::fs::read(&global).unwrap(), original);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn repository_key_generation_is_private_idempotent_and_only_returns_the_public_key() {
        use std::os::unix::fs::PermissionsExt;
        let home = std::env::temp_dir().join(format!(
            "klide-key-scope-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&home).unwrap();
        let script = prepare_script(
            "example/project",
            "github.com ssh-ed25519 TEST\n",
            HostOs::Macos,
        );
        let run = || {
            std::process::Command::new("sh")
                .args(["-ec", &script])
                .env("HOME", &home)
                .output()
                .unwrap()
        };
        let first = run();
        let second = run();
        assert!(first.status.success());
        assert!(second.status.success());
        assert_eq!(first.stdout, second.stdout);
        assert!(first.stdout.starts_with(b"ssh-ed25519 "));
        assert!(!String::from_utf8_lossy(&first.stdout).contains("PRIVATE KEY"));
        let key = home
            .join(".klide/repository-keys")
            .join(key_id("example/project"))
            .join("key");
        assert_eq!(
            std::fs::metadata(key).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn repository_scope_cannot_be_a_url_or_shell_injection() {
        for origin in [
            "git@github.com:org/repo.git",
            "https://github.com/org/repo.git",
            "ssh://git@github.com/org/repo.git",
        ] {
            assert_eq!(parse_slug(origin).unwrap(), "org/repo");
        }
        for origin in [
            "https://evil.test/org/repo",
            "https://user:secret@github.com/org/repo",
            "git@github.com:org/repo;evil",
            "git@github.com:org/../other",
            "file:///repo",
        ] {
            assert!(parse_slug(origin).is_err());
        }
        let command = ssh_command("org/repo", HostOs::Macos);
        assert!(command.contains("IdentityAgent=none"));
        assert!(command.contains("StrictHostKeyChecking=yes"));
        assert!(!command.contains("auth token"));
        let prepare = prepare_script("org/repo", "github.com ssh-ed25519 TEST\n", HostOs::Macos);
        assert!(prepare.contains("umask 077"));
        assert!(!prepare.contains("gh auth login"));
        assert!(!prepare.contains("--global"));
    }
}
