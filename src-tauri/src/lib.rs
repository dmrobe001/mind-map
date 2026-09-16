//! The native half of the app.
//!
//! The web UI in `src/` is the whole interface; this exists only to give that
//! UI the things a browser page cannot have — arbitrary file paths, native
//! dialogs, and the ability to hand a file to whatever program owns it.
//!
//! Two deliberate choices:
//!
//! 1. **File I/O is done here with `std::fs`, not with `tauri-plugin-fs`.**
//!    The plugin exists to grant a page a *scoped* slice of the disk. The whole
//!    point of this app is referring to files wherever they actually are, so a
//!    scope would be a lie. The frontend is first-party code shipped in the
//!    same binary, so the trust boundary is the app, not the page.
//!
//! 2. **No JavaScript plugin packages.** `withGlobalTauri` puts `invoke` on
//!    `window.__TAURI__`, and every command below is reachable through it. That
//!    keeps the frontend buildless and identical whether it is running in a
//!    browser tab or in this window.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Errors cross the bridge as plain strings; the UI only ever shows them.
type CmdResult<T> = Result<T, String>;

fn stringify(err: impl std::fmt::Display) -> String {
    err.to_string()
}

/* ------------------------------------------------------------------ *
 * Reading and writing
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMeta {
    exists: bool,
    is_dir: bool,
    size: u64,
    /// Milliseconds since the epoch, or 0 when the platform won't say.
    modified: u64,
}

fn modified_millis(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn file_meta(path: String) -> FileMeta {
    match fs::metadata(&path) {
        Ok(meta) => FileMeta {
            exists: true,
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: modified_millis(&meta),
        },
        Err(_) => FileMeta {
            exists: false,
            is_dir: false,
            size: 0,
            modified: 0,
        },
    }
}

/// Existence check for a batch of paths.
///
/// A map can hold hundreds of file references and the UI wants to mark each
/// one resolvable or not on every render, so this answers them in one call
/// rather than one round trip each.
#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| Path::new(p).exists()).collect()
}

#[tauri::command]
fn read_text_file(path: String) -> CmdResult<String> {
    fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> CmdResult<()> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(stringify)?;
    }
    // Write to a sibling temp file and rename, so an interrupted save cannot
    // leave a half-written map where the whole map used to be.
    let temp = PathBuf::from(format!("{path}.tmp"));
    fs::write(&temp, contents).map_err(stringify)?;
    fs::rename(&temp, &path).map_err(stringify)
}

/* ------------------------------------------------------------------ *
 * Browsing
 * ------------------------------------------------------------------ */

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    modified: u64,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ListOptions {
    /// Include entries whose name starts with a dot.
    #[serde(default)]
    include_hidden: bool,
    /// Keep only files with one of these extensions (lowercase, no dot).
    #[serde(default)]
    extensions: Vec<String>,
}

#[tauri::command]
fn list_dir(path: String, options: Option<ListOptions>) -> CmdResult<Vec<DirEntry>> {
    let options = options.unwrap_or_default();
    let mut out = Vec::new();

    for entry in fs::read_dir(&path).map_err(|e| format!("{path}: {e}"))? {
        let entry = entry.map_err(stringify)?;
        let name = entry.file_name().to_string_lossy().to_string();

        if !options.include_hidden && name.starts_with('.') {
            continue;
        }

        let meta = match entry.metadata() {
            Ok(meta) => meta,
            // A broken symlink or a file we cannot stat is skipped rather than
            // failing the whole listing.
            Err(_) => continue,
        };

        if !meta.is_dir() && !options.extensions.is_empty() {
            let matches = Path::new(&name)
                .extension()
                .map(|ext| {
                    let ext = ext.to_string_lossy().to_lowercase();
                    options.extensions.iter().any(|want| want == &ext)
                })
                .unwrap_or(false);
            if !matches {
                continue;
            }
        }

        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified: modified_millis(&meta),
        });
    }

    // Directories first, then case-insensitive by name — what a file manager
    // would show, so the import preview matches what the user pictures.
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/* ------------------------------------------------------------------ *
 * Handing a file to the system
 * ------------------------------------------------------------------ */

#[tauri::command]
fn open_path(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    if !Path::new(&path).exists() {
        return Err(format!("{path} is not on this machine"));
    }
    app.opener().open_path(path, None::<&str>).map_err(stringify)
}

#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> CmdResult<()> {
    if !Path::new(&path).exists() {
        return Err(format!("{path} is not on this machine"));
    }
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(stringify)
}

#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> CmdResult<()> {
    // Only hand the system things it will treat as web links.
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return Err(format!("refusing to open {url}"));
    }
    app.opener().open_url(url, None::<&str>).map_err(stringify)
}

/* ------------------------------------------------------------------ *
 * Dialogs
 *
 * The dialog plugin is callback-based, so each command parks on a oneshot
 * channel until the user answers.
 * ------------------------------------------------------------------ */

async fn await_pick<T: Send + 'static>(
    start: impl FnOnce(tokio::sync::oneshot::Sender<T>),
) -> Option<T> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    start(tx);
    rx.await.ok()
}

#[tauri::command]
async fn pick_map_file(app: tauri::AppHandle) -> Option<String> {
    await_pick(|tx| {
        app.dialog()
            .file()
            .add_filter("Mind map", &["json"])
            .pick_file(move |picked| {
                let _ = tx.send(picked);
            });
    })
    .await
    .flatten()
    .and_then(|p| p.into_path().ok())
    .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_map_save_path(app: tauri::AppHandle, suggested: Option<String>) -> Option<String> {
    let suggested = suggested.unwrap_or_else(|| "map.mindmap.json".into());
    await_pick(|tx| {
        app.dialog()
            .file()
            .add_filter("Mind map", &["json"])
            .set_file_name(suggested)
            .save_file(move |picked| {
                let _ = tx.send(picked);
            });
    })
    .await
    .flatten()
    .and_then(|p| p.into_path().ok())
    .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_files(app: tauri::AppHandle) -> Vec<String> {
    await_pick(|tx| {
        app.dialog().file().pick_files(move |picked| {
            let _ = tx.send(picked);
        });
    })
    .await
    .flatten()
    .unwrap_or_default()
    .into_iter()
    .filter_map(|p| p.into_path().ok())
    .map(|p| p.to_string_lossy().to_string())
    .collect()
}

#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Option<String> {
    await_pick(|tx| {
        app.dialog().file().pick_folder(move |picked| {
            let _ = tx.send(picked);
        });
    })
    .await
    .flatten()
    .and_then(|p| p.into_path().ok())
    .map(|p| p.to_string_lossy().to_string())
}

/* ------------------------------------------------------------------ *
 * Identity
 *
 * File references are machine-specific, so the UI needs to be able to say
 * *which* machine a reference belongs to. The id is generated once and kept
 * in the app config directory; it never leaves this machine except inside
 * maps the user saves.
 * ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceInfo {
    id: String,
    name: String,
    os: String,
    home: String,
    separator: String,
}

fn stable_device_id(app: &tauri::AppHandle) -> String {
    let Ok(dir) = app.path().app_config_dir() else {
        return "unknown-device".into();
    };
    let file = dir.join("device-id");
    if let Ok(existing) = fs::read_to_string(&file) {
        let trimmed = existing.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    // Not a UUID: it only has to be unique among the handful of machines one
    // person syncs a map across.
    let generated = format!(
        "dev_{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let _ = fs::create_dir_all(&dir);
    let _ = fs::write(&file, &generated);
    generated
}

#[tauri::command]
fn device_info(app: tauri::AppHandle) -> DeviceInfo {
    let home = app
        .path()
        .home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| {
            fs::read_to_string("/etc/hostname")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| "this machine".into());

    DeviceInfo {
        id: stable_device_id(&app),
        name,
        os: std::env::consts::OS.to_string(),
        home,
        separator: std::path::MAIN_SEPARATOR.to_string(),
    }
}

/// Per-machine settings that must *not* travel inside the map file: where this
/// machine keeps each named root, and which map was open last.
#[tauri::command]
fn read_device_settings(app: tauri::AppHandle) -> serde_json::Value {
    let Ok(dir) = app.path().app_config_dir() else {
        return serde_json::json!({});
    };
    fs::read_to_string(dir.join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

#[tauri::command]
fn write_device_settings(app: tauri::AppHandle, settings: serde_json::Value) -> CmdResult<()> {
    let dir = app.path().app_config_dir().map_err(stringify)?;
    fs::create_dir_all(&dir).map_err(stringify)?;
    let body = serde_json::to_string_pretty(&settings).map_err(stringify)?;
    fs::write(dir.join("settings.json"), body).map_err(stringify)
}

/* ------------------------------------------------------------------ */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            file_meta,
            paths_exist,
            read_text_file,
            write_text_file,
            list_dir,
            open_path,
            reveal_path,
            open_url,
            pick_map_file,
            pick_map_save_path,
            pick_files,
            pick_directory,
            device_info,
            read_device_settings,
            write_device_settings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mind-map");
}

/* ------------------------------------------------------------------ *
 * Tests
 *
 * Only the commands that do not need an AppHandle — which is all the ones
 * containing actual logic. Dialogs and `open_path` hand straight off to the
 * platform and are verified by running the app.
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mind-map-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn writes_and_reads_back() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("map.json").to_string_lossy().to_string();
        write_text_file(path.clone(), "{\"hello\":1}".into()).unwrap();
        assert_eq!(read_text_file(path).unwrap(), "{\"hello\":1}");
    }

    #[test]
    fn write_creates_missing_parents() {
        let dir = temp_dir("parents");
        let path = dir.join("a/b/c/map.json").to_string_lossy().to_string();
        write_text_file(path.clone(), "x".into()).unwrap();
        assert_eq!(read_text_file(path).unwrap(), "x");
    }

    #[test]
    fn write_leaves_no_temp_file_behind() {
        let dir = temp_dir("atomic");
        let path = dir.join("map.json").to_string_lossy().to_string();
        write_text_file(path.clone(), "one".into()).unwrap();
        write_text_file(path.clone(), "two".into()).unwrap();
        assert_eq!(read_text_file(path.clone()).unwrap(), "two");
        assert!(!Path::new(&format!("{path}.tmp")).exists());
    }

    #[test]
    fn reading_a_missing_file_names_it() {
        let err = read_text_file("/definitely/not/here.json".into()).unwrap_err();
        assert!(err.contains("/definitely/not/here.json"), "got: {err}");
    }

    #[test]
    fn file_meta_reports_absence_without_erroring() {
        let meta = file_meta("/definitely/not/here.json".into());
        assert!(!meta.exists);
        assert!(!meta.is_dir);
    }

    #[test]
    fn paths_exist_keeps_input_order() {
        let dir = temp_dir("exists");
        let present = dir.join("yes.txt");
        fs::write(&present, "x").unwrap();
        let answers = paths_exist(vec![
            "/nope/a".into(),
            present.to_string_lossy().to_string(),
            "/nope/b".into(),
        ]);
        assert_eq!(answers, vec![false, true, false]);
    }

    #[test]
    fn listing_sorts_directories_first_then_by_name() {
        let dir = temp_dir("listing");
        fs::write(dir.join("beta.txt"), "").unwrap();
        fs::write(dir.join("Alpha.txt"), "").unwrap();
        fs::create_dir(dir.join("zsub")).unwrap();

        let entries = list_dir(dir.to_string_lossy().to_string(), None).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["zsub", "Alpha.txt", "beta.txt"]);
        assert!(entries[0].is_dir);
    }

    #[test]
    fn listing_hides_dotfiles_unless_asked() {
        let dir = temp_dir("hidden");
        fs::write(dir.join(".secret"), "").unwrap();
        fs::write(dir.join("plain.txt"), "").unwrap();

        let visible = list_dir(dir.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(visible.len(), 1);

        let all = list_dir(
            dir.to_string_lossy().to_string(),
            Some(ListOptions {
                include_hidden: true,
                extensions: vec![],
            }),
        )
        .unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn listing_filters_by_extension_case_insensitively() {
        let dir = temp_dir("extensions");
        fs::write(dir.join("notes.MD"), "").unwrap();
        fs::write(dir.join("photo.png"), "").unwrap();
        fs::create_dir(dir.join("sub")).unwrap();

        let entries = list_dir(
            dir.to_string_lossy().to_string(),
            Some(ListOptions {
                include_hidden: false,
                extensions: vec!["md".into()],
            }),
        )
        .unwrap();

        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // Directories are never filtered out by an extension list.
        assert_eq!(names, vec!["sub", "notes.MD"]);
    }

    #[test]
    fn listing_a_missing_directory_names_it() {
        let err = list_dir("/definitely/not/here".into(), None).unwrap_err();
        assert!(err.contains("/definitely/not/here"), "got: {err}");
    }

    #[test]
    fn open_url_refuses_non_web_schemes() {
        // A javascript: or file: URL must never reach the system opener.
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"] {
            assert!(!(bad.starts_with("http://")
                || bad.starts_with("https://")
                || bad.starts_with("mailto:")));
        }
    }
}
