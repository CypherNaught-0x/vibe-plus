use chrono::Local;
use eyre::{bail, ContextCompat, Result};
use rand::distr::Alphanumeric;
use rand::Rng;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use which::which;

pub fn get_local_time() -> String {
    let now = Local::now();
    now.format("%Y-%m-%d %H-%M-%S").to_string()
}

pub fn random_string(length: usize) -> String {
    rand::rng().sample_iter(&Alphanumeric).take(length).map(char::from).collect()
}

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(not(windows))]
const EXECUTABLE_NAME: &str = "ffmpeg";

#[cfg(windows)]
const EXECUTABLE_NAME: &str = "ffmpeg.exe";

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// The app's own scratch folder: recordings, converted audio, downloads and the sidecar's temp
/// copies land here. Resolved once per process by [`init_staging_dir`] (or the fallback) and
/// re-checked on every call, since the folder can be removed while the app runs.
static STAGING_DIR: OnceLock<PathBuf> = OnceLock::new();
/// Used only when the staging folder cannot be made private; unique per process.
static EMERGENCY_DIR: OnceLock<PathBuf> = OnceLock::new();

const STAGING_FOLDER_NAME: &str = "staging";
/// Matches `identifier` in tauri.conf.json, so the fallback lands where `app_cache_dir` does.
const APP_IDENTIFIER: &str = "github.com.thewh1teagle.vibe";
/// Set once the folder passed the full check; later calls only confirm it is still a directory.
static STAGING_VERIFIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Resolve the staging folder under the app cache dir. Call once, early in setup, before
/// anything reads [`get_vibe_temp_folder`].
pub fn init_staging_dir(app: &tauri::AppHandle) {
    use tauri::Manager;
    let dir = match app.path().app_cache_dir() {
        Ok(cache) => cache.join(STAGING_FOLDER_NAME),
        Err(error) => {
            tracing::error!("no app cache dir, using the fallback staging folder: {error}");
            fallback_staging_dir()
        }
    };
    if STAGING_DIR.set(dir.clone()).is_err() && STAGING_DIR.get() != Some(&dir) {
        tracing::warn!(
            "staging folder was used before it was initialised; keeping {:?}",
            STAGING_DIR.get()
        );
    }
}

/// Where temp files go. Keeps its historical name and signature; callers have no AppHandle.
pub fn get_vibe_temp_folder() -> PathBuf {
    use std::sync::atomic::Ordering;
    let dir = STAGING_DIR.get_or_init(fallback_staging_dir);
    let still_there = || std::fs::symlink_metadata(dir).is_ok_and(|metadata| metadata.file_type().is_dir());
    if STAGING_VERIFIED.load(Ordering::Acquire) && still_there() {
        return dir.clone();
    }
    match ensure_private_dir(dir).inspect(|()| STAGING_VERIFIED.store(true, Ordering::Release)) {
        Ok(()) => dir.clone(),
        Err(error) => {
            tracing::error!("staging folder {} is unusable: {error}", dir.display());
            emergency_dir()
        }
    }
}

/// Without an AppHandle (unit tests, early CLI paths) mirror what Tauri's `app_cache_dir`
/// resolves to, from the environment: still per user, never a guessable name in shared /tmp.
fn fallback_staging_dir() -> PathBuf {
    user_cache_dir()
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(APP_IDENTIFIER).join(STAGING_FOLDER_NAME))
        .unwrap_or_else(emergency_dir)
}

fn user_cache_dir() -> Option<PathBuf> {
    let env = |key: &str| std::env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from);
    #[cfg(windows)]
    return env("LOCALAPPDATA");
    #[cfg(target_os = "macos")]
    return env("HOME").map(|home| home.join("Library").join("Caches"));
    #[cfg(all(unix, not(target_os = "macos")))]
    return env("XDG_CACHE_HOME").or_else(|| env("HOME").map(|home| home.join(".cache")));
}

/// A fresh, randomly named private folder under temp, created once per process. Creating it
/// with `create_dir` (not `_all`) fails if anything already sits at that name.
fn emergency_dir() -> PathBuf {
    EMERGENCY_DIR
        .get_or_init(|| {
            for _ in 0..8 {
                let dir = std::env::temp_dir().join(format!("vibe-staging-{}", random_string(16)));
                if create_private_dir(&dir).is_ok() {
                    return dir;
                }
            }
            tracing::error!("could not create a private staging folder; using the temp dir");
            std::env::temp_dir()
        })
        .clone()
}

#[cfg(unix)]
fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(dir)
}

#[cfg(not(unix))]
fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir(dir)
}

/// Create the folder if needed and make sure it is a real directory (not a symlink) that only
/// the current user can enter.
fn ensure_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    use std::io::{Error, ErrorKind};
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)?;
    }
    match create_private_dir(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(dir)?;
    if !metadata.file_type().is_dir() {
        return Err(Error::other("not a directory (or a symlink)"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        // chmod succeeds only for the owner (or root), so it doubles as the ownership check
        // without a getuid binding, and it tightens a folder an older build left open.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        let metadata = std::fs::symlink_metadata(dir)?;
        if !metadata.file_type().is_dir() || metadata.mode() & 0o077 != 0 {
            return Err(Error::other("folder is not private to this user"));
        }
    }
    Ok(())
}

pub fn find_ffmpeg_path() -> Option<PathBuf> {
    if let Ok(path) = which(EXECUTABLE_NAME) {
        return Some(path);
    }

    let cwd = std::env::current_dir().ok()?;
    let ffmpeg_in_cwd = cwd.join(EXECUTABLE_NAME);
    if ffmpeg_in_cwd.is_file() && ffmpeg_in_cwd.exists() {
        return Some(ffmpeg_in_cwd);
    }

    if let Ok(exe_path) = std::env::current_exe() {
        let exe_folder = exe_path.parent()?;
        let ffmpeg_in_exe_folder = exe_folder.join(EXECUTABLE_NAME);
        if ffmpeg_in_exe_folder.exists() {
            return Some(ffmpeg_in_exe_folder);
        }
        #[cfg(target_os = "macos")]
        {
            let resources_folder = exe_folder.join("../Resources");
            let ffmpeg_in_resources = resources_folder.join(EXECUTABLE_NAME);
            if ffmpeg_in_resources.exists() {
                return Some(ffmpeg_in_resources);
            }
        }
    }

    None
}

fn command() -> Result<Command> {
    let ffmpeg_path = find_ffmpeg_path().context("ffmpeg not found")?;
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-hide_banner", "-loglevel", "error", "-y"]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// Mono float PCM at `rate` arrives on stdin and is encoded into `output` as it comes.
/// `mixed`: several sources were summed upstream, so cap the peaks like the old merge did.
pub fn spawn_live_encoder(rate: u32, mixed: bool, output_args: &[&str], output: &Path) -> Result<Child> {
    let mut cmd = command()?;
    let rate = rate.to_string();
    cmd.args(["-f", "f32le", "-ar", rate.as_str(), "-ac", "1", "-i", "pipe:0"]);
    if mixed {
        cmd.args(["-af", MIX_LIMITER]);
    }
    cmd.args(output_args).arg(output);
    cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped());
    tracing::debug!("live encoder: {:?}", cmd);
    Ok(cmd.spawn()?)
}

/// Peak cap after summing sources; `amix` with `normalize=0` adds them, which can clip.
const MIX_LIMITER: &str = "alimiter=limit=0.97";

/// One pass from the raw captures to the stored file: mix (when there are two), downmix,
/// resample and encode. Replaces the old merge-to-WAV + normalize pair, which wrote and
/// re-read a full intermediate WAV.
pub fn transcode_recording(inputs: &[PathBuf], output_args: &[&str], output: &Path) -> Result<()> {
    if inputs.is_empty() {
        bail!("no recording inputs");
    }
    let mut cmd = command()?;
    for input in inputs {
        cmd.arg("-i").arg(input);
    }
    let graph;
    if inputs.len() > 1 {
        // amix averages by default, which costs 6 dB on a two-input mix. Sum instead and cap
        // the peaks, since the mic and the meeting can both be loud at once.
        graph = format!(
            "amix=inputs={}:duration=longest:dropout_transition=0:normalize=0,{MIX_LIMITER}",
            inputs.len()
        );
        cmd.args(["-filter_complex", graph.as_str()]);
    }
    cmd.args(output_args).arg(output);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    tracing::debug!("transcode recording: {:?}", cmd);

    let result = cmd.output()?;
    if !result.status.success() {
        let stderr = String::from_utf8_lossy(&result.stderr);
        bail!("ffmpeg failed: {}", stderr.chars().take(1000).collect::<String>().trim());
    }
    if std::fs::metadata(output).map(|m| m.len()).unwrap_or(0) == 0 {
        bail!("ffmpeg produced no output");
    }
    Ok(())
}

#[cfg(test)]
mod staging_tests {
    use super::*;

    #[test]
    fn the_staging_folder_is_stable_and_private() {
        let first = get_vibe_temp_folder();
        assert_eq!(first, get_vibe_temp_folder());
        assert!(first.is_dir());
        assert!(!first.file_name().unwrap().to_string_lossy().starts_with("vibe_temp"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::symlink_metadata(&first).unwrap().mode() & 0o777, 0o700);
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_or_open_staging_folder_is_refused_or_tightened() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let root = std::env::temp_dir().join(format!("vibe-staging-test-{}", random_string(12)));
        std::fs::create_dir(&root).unwrap();
        let target = root.join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(ensure_private_dir(&link).is_err());

        let open = root.join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o777)).unwrap();
        ensure_private_dir(&open).unwrap();
        assert_eq!(std::fs::metadata(&open).unwrap().mode() & 0o777, 0o700);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
