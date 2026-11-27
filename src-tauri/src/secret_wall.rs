//! The secret wall: what an agent runs on a Remote machine can't read the API
//! keys that machine holds for Klide.
//!
//! A Remote machine keeps the keys it was given in `~/.klide/remote-api`
//! (`machine_inference.rs`) so a task keeps running when the Mac is off. The
//! Run host reads them per request; nothing it starts may. Every program the
//! host starts — an agent's command, git, a Delegate CLI and everything those
//! start in turn — begins in its own mount namespace where an empty, read-only
//! tmpfs covers `~/.klide`. The files are not hidden by a rule the child could
//! argue with: in its view of the filesystem they do not exist.
//!
//! How: between fork and exec the child unshares a user + mount namespace
//! (no privilege needed), maps its own uid/gid onto themselves so files keep
//! their owner, makes mounts private, and mounts the tmpfs. Capabilities in
//! the new namespace end at exec (the uid is not 0 there), so the program
//! cannot unmount it, and a mount inherited into a namespace it creates later
//! is locked to it.
//!
//! The host also marks itself non-dumpable at start ([`seal_host`]), so a
//! child cannot reach the real `~/.klide` through `/proc/<host>/root` either.
//! What stays outside the wall: another process of the same user that is
//! *not* the host's child — an interactive SSH login running at the same
//! time. Use a dedicated account for the machine (setup creates `klide`).
//!
//! Fail closed. When this machine holds keys and the wall can't be raised —
//! Ubuntu's AppArmor refuses unprivileged user namespaces unless a profile
//! allows them — the program does not start, and setup offers the one-time
//! sudo step that installs that profile (`scripts/remote-host/`). A machine
//! without keys (Claude Code on its own login) is unaffected.
//!
//! Linux only. On macOS the Seatbelt sandbox (`agent/sandbox.rs`) lists the
//! same folder among its secret paths.

/// What the wall covers, relative to the home directory.
pub const COVERED: &str = ".klide";
/// The folder whose presence means this machine holds keys to protect.
pub const SECRETS: &str = ".klide/remote-api";

/// Raise the wall around `cmd` when this machine has secrets to protect.
/// A no-op elsewhere — on macOS, on a Linux machine with no keys.
pub fn guard(cmd: &mut std::process::Command) {
    #[cfg(target_os = "linux")]
    linux::guard(cmd);
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

/// [`guard`] for an async command.
pub fn guard_tokio(cmd: &mut tokio::process::Command) {
    guard(cmd.as_std_mut());
}

/// Make the Run host non-dumpable, so a same-user child cannot open
/// `/proc/<host>/root` past the wall. Called once when `klide ptyd` starts.
pub fn seal_host() {
    #[cfg(target_os = "linux")]
    unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
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
        let wall = linux::Wall::new(&home.join(COVERED)).ok_or("Cannot describe the wall")?;
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(r#"test -z "$(ls -A "$1" 2>/dev/null)" && echo walled"#).arg("sh").arg(home.join(COVERED));
        wall.apply(&mut cmd);
        let out = cmd.output().map_err(|e| linux::explain(&e))?;
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
        uid_map: Vec<u8>,
        gid_map: Vec<u8>,
    }

    impl Wall {
        pub fn new(target: &Path) -> Option<Self> {
            let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
            Some(Wall {
                target: CString::new(target.as_os_str().as_bytes()).ok()?,
                uid_map: format!("{uid} {uid} 1\n").into_bytes(),
                gid_map: format!("{gid} {gid} 1\n").into_bytes(),
            })
        }

        pub fn apply(self, cmd: &mut std::process::Command) {
            // SAFETY: the closure only makes raw syscalls on data prepared above.
            unsafe { cmd.pre_exec(move || raise(&self)); }
        }
    }

    pub fn guard(cmd: &mut std::process::Command) {
        if !super::has_secrets() { return; }
        let Some(home) = crate::cli::home_dir_path() else { return };
        match Wall::new(&home.join(super::COVERED)) {
            Some(wall) => wall.apply(cmd),
            // A home path with a NUL byte: refuse rather than run unwalled.
            None => unsafe { cmd.pre_exec(|| Err(std::io::Error::other(super::REFUSED))); },
        }
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

    fn raise(wall: &Wall) -> std::io::Result<()> {
        let fail = |_| std::io::Error::other(super::REFUSED);
        unsafe {
            check(libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWNS)).map_err(fail)?;
            write_file(b"/proc/self/setgroups\0", b"deny").map_err(fail)?;
            write_file(b"/proc/self/uid_map\0", &wall.uid_map).map_err(fail)?;
            write_file(b"/proc/self/gid_map\0", &wall.gid_map).map_err(fail)?;
            check(libc::mount(std::ptr::null(), b"/\0".as_ptr().cast(), std::ptr::null(), libc::MS_REC | libc::MS_PRIVATE, std::ptr::null())).map_err(fail)?;
            check(libc::mount(
                b"tmpfs\0".as_ptr().cast(),
                wall.target.as_ptr(),
                b"tmpfs\0".as_ptr().cast(),
                libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC,
                b"size=4k,mode=0500\0".as_ptr().cast(),
            )).map_err(fail)?;
        }
        Ok(())
    }

    /// The error a refused spawn reports, whatever the syscall said.
    pub fn explain(error: &std::io::Error) -> String {
        if error.to_string().contains(super::REFUSED) { super::REFUSED.into() } else { error.to_string() }
    }
}

/// What a program that could not be walled reports instead of starting.
pub const REFUSED: &str = "This machine holds API keys and can't hide them from commands yet. Finish \"Protect keys\" in Settings → Machines (one sudo step), then retry.";

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    /// Runs where unprivileged user namespaces are allowed (CI runners are);
    /// elsewhere it says so and passes — the probe in setup covers that case.
    #[test]
    fn a_walled_program_cannot_see_the_covered_folder() {
        let dir = std::env::temp_dir().join(format!("klide-wall-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("remote-api/openrouter")).unwrap();
        std::fs::write(dir.join("remote-api/openrouter/api-key"), "secret").unwrap();
        let wall = linux::Wall::new(&dir).unwrap();
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg("cat \"$1/remote-api/openrouter/api-key\" 2>/dev/null; ls -A \"$1\"; umount \"$1\" 2>/dev/null && echo unmounted; true").arg("sh").arg(&dir);
        wall.apply(&mut cmd);
        match cmd.output() {
            Ok(out) => {
                let seen = String::from_utf8_lossy(&out.stdout);
                assert!(!seen.contains("secret"), "{seen}");
                assert!(!seen.contains("remote-api"), "{seen}");
                assert!(!seen.contains("unmounted"), "{seen}");
            }
            Err(error) => assert!(error.to_string().contains(REFUSED), "{error}"),
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
