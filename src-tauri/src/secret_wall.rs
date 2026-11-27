//! The secret wall: what an agent runs on a Remote machine can't read the API
//! keys that machine holds for Klide.
//!
//! A Remote machine keeps the keys it was given in `~/.klide/remote-api`
//! (`machine_inference.rs`) so a task keeps running when the Mac is off. The
//! Run host reads them per request; nothing it starts may.
//!
//! **One door, at the host.** `klide ptyd` walls *itself* first thing, while
//! it is still one thread ([`host_start`]): it opens a private handle on the
//! key folder, then enters its own user + mount namespace where an empty,
//! read-only tmpfs covers `~/.klide/remote-api` and `~/.klide/bin` (the
//! helper) is re-bound read-only. Everything the host ever starts — an agent's
//! command, git and its hooks, a Delegate CLI, a worktree setup script and the
//! `npm install` it runs — inherits that view with no code at the spawn site,
//! so a new spawn site can't forget it. The host alone reads keys, through the
//! handle it opened before walling ([`read_key`]); a key sync writes the real
//! folder, and the handle sees the change.
//!
//! Only those folders: the rest of `~/.klide` is what the agents work in —
//! each conversation's worktree (`run-host/worktrees`), the coordination files
//! a Delegate's MCP server reads, the helper binary it runs.
//!
//! Capabilities in the namespace end at exec for every child (its uid is not
//! 0 there), so nothing it starts can unmount the cover, and a mount inherited
//! into a namespace it creates is locked. The host is non-dumpable and its key
//! handle close-on-exec, so neither `/proc/<host>/root` nor `/proc/<host>/fd`
//! leads around the wall.
//!
//! What stays outside: another process of the same account that the host did
//! not start — an interactive SSH login running alongside, or a line an agent
//! leaves in `~/.profile` for the next one — and root. Use a dedicated account
//! nobody logs into by hand, and keys with a spending limit.
//!
//! **Fail closed.** If the wall can't be raised (Ubuntu's AppArmor refuses
//! unprivileged user namespaces until "Protect keys" installs a profile) and
//! keys are present, the host refuses to start. With no keys it starts and
//! records that it is unwalled (`<data>/wall`); a key sync then stops it while
//! idle, so the next start is walled, and refuses while it is busy.
//!
//! Linux only. On macOS the Seatbelt sandbox (`agent/sandbox.rs`) lists the
//! same folder among its secret paths.

/// What the wall covers, relative to the home directory — the keys, and so
/// also the folder whose contents mean there is something to protect.
pub const SECRETS: &str = ".klide/remote-api";
/// The helper's own folder, pinned read-only behind the wall.
pub const PINNED: &str = ".klide/bin";

/// Wall this process — `klide ptyd` / `klide scheduled`, before anything
/// else and while single-threaded — and record the outcome in `data_dir`.
/// Exits when keys are present and the wall can't be raised.
pub fn host_start(data_dir: &std::path::Path) {
    #[cfg(target_os = "linux")]
    {
        let _ = std::fs::create_dir_all(data_dir);
        let state = data_dir.join(STATE);
        match linux::enter() {
            Ok(()) => { let _ = std::fs::write(state, "up"); }
            Err(error) if has_secrets() => {
                eprintln!("{REFUSED} ({error})");
                std::process::exit(1);
            }
            Err(_) => { let _ = std::fs::write(state, "down"); }
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = data_dir;
}

/// Where the host records whether its wall is up.
pub const STATE: &str = "wall";

/// Before keys land: a host running *unwalled* on `data_dir` would expose
/// them, so stop it while idle (the next run starts it, walled) or refuse.
pub fn ensure_no_unwalled_host(data_dir: &std::path::Path) -> Result<(), String> {
    if std::fs::read_to_string(data_dir.join(STATE)).map(|s| s.trim() == "down").unwrap_or(false) {
        crate::pty_daemon::stop_idle_host(data_dir)
            .map_err(|e| format!("The Run host started before keys were protected and is busy ({e}). Let its tasks finish, then sync again."))?;
        let _ = std::fs::remove_file(data_dir.join(STATE));
    }
    Ok(())
}

/// The key the walled host holds for `provider`, read through the handle it
/// opened before walling. `None` when this process isn't a walled host — the
/// caller reads the path instead (a sync subcommand, the Mac).
pub fn read_key(provider: &str) -> Option<Result<Option<String>, String>> {
    #[cfg(target_os = "linux")]
    { linux::read_key(provider) }
    #[cfg(not(target_os = "linux"))]
    { let _ = provider; None }
}

/// Whether this machine holds keys the wall must cover.
pub fn has_secrets() -> bool {
    crate::cli::home_dir_path().is_some_and(|home| {
        std::fs::read_dir(home.join(SECRETS)).is_ok_and(|mut entries| entries.next().is_some())
    })
}

/// Can a walled program on this machine see the covered folder? `Ok(())` when
/// the wall holds; the reason otherwise. Runs a real walled `sh` — the probe
/// is the mechanism, not a guess about kernel settings.
pub fn check() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let home = crate::cli::home_dir_path().ok_or("No home directory")?;
        let covered = home.join(SECRETS);
        // The mount point must exist; an empty one is what a keyless machine has.
        std::fs::create_dir_all(&covered).map_err(|e| e.to_string())?;
        let wall = linux::Wall::new(&covered, &home.join(PINNED)).ok_or("Cannot describe the wall")?;
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(r#"test -z "$(ls -A "$1" 2>/dev/null)" && ! touch "$2/.klide-wall-probe" 2>/dev/null && echo walled"#).arg("sh").arg(&covered).arg(home.join(PINNED));
        wall.apply(&mut cmd);
        let out = cmd.output().map_err(|e| format!("The kernel refused the wall: {e}"))?;
        if out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "walled" { Ok(()) }
        else { Err("The covered folder is still visible to commands".into()) }
    }
    #[cfg(not(target_os = "linux"))]
    { Err("The secret wall is Linux-only; macOS uses the Seatbelt sandbox".into()) }
}

#[cfg(target_os = "linux")]
mod linux {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::process::CommandExt;
    use std::path::Path;

    /// Everything the child needs, built before fork: between fork and exec
    /// only async-signal-safe calls are allowed, so no allocation there.
    pub struct Wall {
        target: CString,
        /// The folder to re-bind read-only, and the flags its mount already
        /// carries — a remount inside a user namespace must keep them.
        pinned: Option<(CString, libc::c_ulong)>,
        uid_map: Vec<u8>,
        gid_map: Vec<u8>,
    }

    impl Wall {
        pub fn new(target: &Path, pinned: &Path) -> Option<Self> {
            let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
            let pinned = if pinned.is_dir() {
                let path = CString::new(pinned.as_os_str().as_bytes()).ok()?;
                let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
                if unsafe { libc::statvfs(path.as_ptr(), &mut stat) } != 0 { return None; }
                let mut kept: libc::c_ulong = 0;
                for (st, ms) in [(libc::ST_NOSUID, libc::MS_NOSUID), (libc::ST_NODEV, libc::MS_NODEV), (libc::ST_NOEXEC, libc::MS_NOEXEC), (libc::ST_NOATIME, libc::MS_NOATIME), (libc::ST_NODIRATIME, libc::MS_NODIRATIME), (libc::ST_RELATIME, libc::MS_RELATIME)] {
                    if stat.f_flag & st != 0 { kept |= ms; }
                }
                Some((path, kept))
            } else { None };
            Some(Wall {
                target: CString::new(target.as_os_str().as_bytes()).ok()?,
                pinned,
                uid_map: format!("{uid} {uid} 1\n").into_bytes(),
                gid_map: format!("{gid} {gid} 1\n").into_bytes(),
            })
        }

        pub fn apply(self, cmd: &mut std::process::Command) {
            // SAFETY: the closure only makes raw syscalls on data prepared above.
            unsafe { cmd.pre_exec(move || raise(&self)); }
        }
    }

    /// The key folder, opened before walling; -1 outside a walled host.
    static KEYS: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(-1);

    pub fn enter() -> Result<(), String> {
        let home = crate::cli::home_dir_path().ok_or("No home directory")?;
        let covered = home.join(super::SECRETS);
        std::fs::create_dir_all(&covered).map_err(|e| e.to_string())?;
        let wall = Wall::new(&covered, &home.join(super::PINNED)).ok_or("Cannot describe the wall")?;
        let path = CString::new(covered.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        if fd < 0 { return Err(std::io::Error::last_os_error().to_string()); }
        unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
        if let Err(error) = raise(&wall) {
            unsafe { libc::close(fd) };
            return Err(format!("The kernel refused the wall: {error}"));
        }
        KEYS.store(fd, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    pub fn read_key(provider: &str) -> Option<Result<Option<String>, String>> {
        let dir = KEYS.load(std::sync::atomic::Ordering::SeqCst);
        if dir < 0 { return None; }
        Some(read_key_at(dir, provider))
    }

    /// The same rules as a path read (`machine_inference::destination_key`):
    /// a regular file of mode 600, no symlink, bounded, one printable line.
    pub fn read_key_at(dir: libc::c_int, provider: &str) -> Result<Option<String>, String> {
        let name = CString::new(format!("{provider}/api-key")).map_err(|e| e.to_string())?;
        let fd = unsafe { libc::openat(dir, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
        if fd < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENOENT) { return Err("Cannot read the destination API key file.".into()); }
            // A provider folder without its key: authorized once, now missing.
            let folder = CString::new(provider).map_err(|e| e.to_string())?;
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            let exists = unsafe { libc::fstatat(dir, folder.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } == 0;
            return if exists { Err("The authorized API key is missing. Sync keys again in Settings → Machines.".into()) } else { Ok(None) };
        }
        use std::io::Read;
        use std::os::fd::FromRawFd;
        let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
        let meta = file.metadata().map_err(|_| "Cannot read the destination API key file.")?;
        use std::os::unix::fs::PermissionsExt;
        if !meta.is_file() || meta.len() > 16384 || meta.permissions().mode() & 0o077 != 0 {
            return Err("The destination API key must be a regular private file.".into());
        }
        let mut key = String::new();
        file.read_to_string(&mut key).map_err(|_| "Cannot read the destination API key file.")?;
        let key = key.trim();
        if key.is_empty() || key.chars().any(char::is_control) { return Err("The destination API key file is invalid.".into()); }
        Ok(Some(key.into()))
    }

    fn write_file(path: &[u8], data: &[u8]) -> std::io::Result<()> {
        let fd = unsafe { libc::open(path.as_ptr().cast(), libc::O_WRONLY | libc::O_CLOEXEC) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        let written = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
        let error = std::io::Error::last_os_error();
        unsafe { libc::close(fd) };
        if written != data.len() as isize { return Err(error); }
        Ok(())
    }

    fn check(result: libc::c_int) -> std::io::Result<()> {
        if result == 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }

    // std carries only an errno from the child back to `spawn`, so each step
    // fails with the kernel's own error; `explain` turns it into the message.
    fn raise(wall: &Wall) -> std::io::Result<()> {
        unsafe {
            check(libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWNS))?;
            write_file(b"/proc/self/setgroups\0", b"deny")?;
            write_file(b"/proc/self/uid_map\0", &wall.uid_map)?;
            write_file(b"/proc/self/gid_map\0", &wall.gid_map)?;
            check(libc::mount(std::ptr::null(), b"/\0".as_ptr().cast(), std::ptr::null(), libc::MS_REC | libc::MS_PRIVATE, std::ptr::null()))?;
            check(libc::mount(
                b"tmpfs\0".as_ptr().cast(),
                wall.target.as_ptr(),
                b"tmpfs\0".as_ptr().cast(),
                libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
                b"size=4k,mode=0500\0".as_ptr().cast(),
            ))?;
            if let Some((pinned, kept)) = &wall.pinned {
                check(libc::mount(pinned.as_ptr(), pinned.as_ptr(), std::ptr::null(), libc::MS_BIND | libc::MS_REC, std::ptr::null()))?;
                check(libc::mount(std::ptr::null(), pinned.as_ptr(), std::ptr::null(), libc::MS_REMOUNT | libc::MS_BIND | libc::MS_RDONLY | *kept, std::ptr::null()))?;
            }
        }
        Ok(())
    }
}

/// What a program that could not be walled reports instead of starting.
pub const REFUSED: &str = "This machine holds API keys and can't hide them from commands yet. Finish \"Protect keys\" in Settings → Machines (one sudo step), then retry.";

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn the_host_reads_keys_through_its_handle_with_the_path_rules() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("klide-keys-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("openrouter")).unwrap();
        std::fs::create_dir_all(dir.join("deepseek")).unwrap();
        std::fs::write(dir.join("openrouter/api-key"), "sk-or\n").unwrap();
        std::fs::set_permissions(dir.join("openrouter/api-key"), std::fs::Permissions::from_mode(0o600)).unwrap();
        let path = std::ffi::CString::new(dir.to_str().unwrap()).unwrap();
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
        assert_eq!(linux::read_key_at(fd, "openrouter").unwrap().as_deref(), Some("sk-or"));
        assert_eq!(linux::read_key_at(fd, "mistral").unwrap(), None);
        assert!(linux::read_key_at(fd, "deepseek").is_err(), "a folder without its key is an error");
        std::fs::set_permissions(dir.join("openrouter/api-key"), std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(linux::read_key_at(fd, "openrouter").is_err(), "a readable-by-others key is refused");
        unsafe { libc::close(fd) };
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Runs where unprivileged user namespaces are allowed (CI runners are);
    /// elsewhere it says so and passes — the probe in setup covers that case.
    #[test]
    fn a_walled_program_cannot_see_the_covered_folder() {
        let dir = std::env::temp_dir().join(format!("klide-wall-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("remote-api/openrouter")).unwrap();
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::create_dir_all(dir.join("run-host/worktrees/convo")).unwrap();
        std::fs::write(dir.join("remote-api/openrouter/api-key"), "secret").unwrap();
        std::fs::write(dir.join("bin/klide"), "helper").unwrap();
        let wall = linux::Wall::new(&dir.join("remote-api"), &dir.join("bin")).unwrap();
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(concat!(
            "cat \"$1/remote-api/openrouter/api-key\" 2>/dev/null; ls -A \"$1/remote-api\";",
            "umount \"$1/remote-api\" 2>/dev/null && echo unmounted;",
            "echo x > \"$1/bin/klide\" 2>/dev/null && echo replaced; cat \"$1/bin/klide\";",
            "echo work > \"$1/run-host/worktrees/convo/file\" && echo worktree-ok; true",
        )).arg("sh").arg(&dir);
        wall.apply(&mut cmd);
        match cmd.output() {
            Ok(out) => {
                let seen = String::from_utf8_lossy(&out.stdout);
                assert!(!seen.contains("secret"), "the key is unreadable: {seen}");
                assert!(!seen.contains("openrouter"), "the key folder looks empty: {seen}");
                assert!(!seen.contains("unmounted"), "the wall can't be taken down: {seen}");
                assert!(!seen.contains("replaced") && seen.contains("helper"), "the helper is read-only but runnable: {seen}");
                assert!(seen.contains("worktree-ok"), "the rest of ~/.klide is the agents' to use: {seen}");
            }
            // Ubuntu's AppArmor refuses unprivileged user namespaces by
            // default; CI lifts that and sets KLIDE_REQUIRE_WALL so this
            // proves the wall there instead of skipping.
            Err(error) => {
                assert!(std::env::var_os("KLIDE_REQUIRE_WALL").is_none(), "the wall could not be raised: {error}");
                assert!(matches!(error.raw_os_error(), Some(libc::EPERM | libc::EACCES)), "{error}");
                eprintln!("secret wall unavailable on this kernel ({error}); skipped");
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
