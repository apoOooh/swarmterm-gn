use super::{
    path::{canonical, guarded},
    FileService,
};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::Path,
};
use tauri::http::{Request, Response};

pub(super) fn mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "mp4" | "m4v" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "webm" => Some("video/webm"),
        // Preview-only: served to the sandboxed HTML frame so relative
        // stylesheets, scripts, fonts and images resolve from the file's folder.
        "html" | "htm" => Some("text/html; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "css" => Some("text/css; charset=utf-8"),
        "js" | "mjs" => Some("text/javascript; charset=utf-8"),
        "json" => Some("application/json"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        "ttf" => Some("font/ttf"),
        "otf" => Some("font/otf"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        _ => None,
    }
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Images and videos shown by MediaView — the only kinds MediaStat/OpenMedia accept.
pub(super) fn is_media(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "mp4" | "m4v" | "mov" | "webm"
    )
}

/// Context id of the unrooted route: `/unrooted?path=<canonical abs path>`.
/// Served only to the app webview (`APP_WEBVIEW`), without CORS headers, from
/// a handle validated against the per-session allow-list of images/videos the
/// user opened (or copied). Preview/popout webviews can never read them.
/// Must stay in lockstep with `UNROOTED_MEDIA` in `src/tauri/files.ts`.
pub(super) const UNROOTED_ID: &str = "unrooted";

/// Resolve a path a pane printed or the user opened (absolute, or relative to
/// the terminal cwd) to a canonical regular media file. Deliberately NO root
/// check (screenshots land in scratch/temp dirs); the safety net is instead the
/// canonical regular-file + image/video extension rule, so only media can
/// ever be allow-listed — never HTML/SVG or arbitrary files.
pub(super) fn resolve_media(raw: &str, cwd: &Path) -> Result<std::path::PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("path must not be empty".into());
    }
    // UNC shares would make the app open an SMB connection because of
    // printed text; screenshots are local files, so refuse network paths.
    if (raw.starts_with(r"\\") || raw.starts_with("//")) && !raw.starts_with(r"\\?\") {
        return Err("network (UNC) paths are not supported".into());
    }
    let given = Path::new(raw);
    let joined = if given.is_absolute() {
        given.to_path_buf()
    } else {
        cwd.join(given)
    };
    let path = canonical(&joined)?;
    if !fs::metadata(&path).map_err(|e| e.to_string())?.is_file() {
        return Err(format!("{} is not a regular file", path.display()));
    }
    if !is_media(&path) {
        return Err(format!(
            "{} is not a supported image or video (png, jpg, jpeg, gif, webp, mp4, m4v, mov, webm)",
            path.display()
        ));
    }
    Ok(path)
}

/// Files whose unsaved buffer the preview frame renders (see `FileService::draft`).
pub(super) fn previewable(path: &Path) -> bool {
    matches!(extension(path).as_str(), "html" | "htm")
}

/// Kinds safe to hand to the OS default handler as a "browser" open.
pub(super) fn external_preview(path: &Path) -> bool {
    matches!(extension(path).as_str(), "html" | "htm" | "svg")
}

/// Two URL forms: `/<id>?path=<abs>` (media, query-addressed) and
/// `/<id>/f/<abs path>` — path-addressed so a page's relative URLs resolve
/// against its own folder without a `<base>` tag.
fn target(url: &url::Url) -> Result<(String, String), String> {
    let raw = url.path().trim_start_matches('/');
    if let Some((id, rest)) = raw.split_once("/f/") {
        let path = percent_encoding::percent_decode_str(rest)
            .decode_utf8()
            .map_err(|e| e.to_string())?
            .into_owned();
        // Windows paths arrive as `C:/…`; POSIX ones lose their leading slash to the split.
        let path = if cfg!(windows) {
            path
        } else {
            format!("/{path}")
        };
        return Ok((id.to_string(), path));
    }
    let path = url
        .query_pairs()
        .find(|(k, _)| k == "path")
        .ok_or("Missing media path")?
        .1
        .into_owned();
    Ok((raw.trim_end_matches('/').to_string(), path))
}

fn range(header: Option<&str>, len: u64) -> Result<Option<(u64, u64)>, String> {
    let Some(header) = header else {
        return Ok(None);
    };
    let spec = header.strip_prefix("bytes=").ok_or("Invalid byte range")?;
    if spec.contains(',') {
        return Err("Multiple byte ranges are not supported".into());
    }
    let (start, end) = spec.split_once('-').ok_or("Invalid byte range")?;
    if len == 0 {
        return Err("Empty file".into());
    }
    let (start, end) = if start.is_empty() {
        let count: u64 = end.parse().map_err(|_| "Invalid suffix range")?;
        if count == 0 {
            return Err("Invalid suffix range".into());
        }
        (len.saturating_sub(count), len - 1)
    } else {
        let start: u64 = start.parse().map_err(|_| "Invalid range start")?;
        let end = if end.is_empty() {
            len - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| "Invalid range end")?
                .min(len - 1)
        };
        (start, end)
    };
    if start >= len || end < start {
        return Err("Range is outside the file".into());
    }
    Ok(Some((
        start,
        end.min(start.saturating_add(8 * 1024 * 1024 - 1)),
    )))
}

/// Label of the app's own webview (`tauri.conf.json`). Every media consumer
/// (MediaView, overlay, gallery, the sandboxed HTML frame) lives inside it;
/// preview/popout webviews show agent-reachable pages and get nothing.
pub(crate) const APP_WEBVIEW: &str = "main";

/// Only the app webview may use the protocol. The label comes from Tauri's
/// own bookkeeping of which webview issued the request, not from anything the
/// page controls (unlike Origin/Referer).
fn webview_allowed(label: &str) -> bool {
    label == APP_WEBVIEW
}

/// Open `path` and validate the OPEN handle (not the name): its final path
/// must be a registered canonical media file and it must be a regular file.
/// Reading from this same handle closes the check-then-reopen race.
fn open_registered(
    service: &FileService,
    path: &str,
) -> Result<(fs::File, std::path::PathBuf), String> {
    const DENIED: &str = "Media file was not opened by the user";
    // Registered paths are dunce-canonical drive paths (`C:\...`); refuse
    // anything else (device, pipe, UNC, relative) before it is even opened.
    if !is_drive_path(path) {
        return Err(DENIED.into());
    }
    let file = fs::File::open(path).map_err(|_| DENIED.to_string())?;
    let real = final_path(&file, Path::new(path)).map_err(|_| DENIED.to_string())?;
    let regular = file.metadata().map(|m| m.is_file()).unwrap_or(false);
    if !regular || !is_media(&real) || !service.unrooted_registered(&real) {
        return Err(DENIED.into());
    }
    Ok((file, real))
}

/// Annotate mode needs the image's pixels on a canvas, but the unrooted route
/// sends no CORS header (see `response`), so drawing the served <img> would
/// taint the canvas. This hands the same bytes to the app window over IPC
/// instead, under the same rules as the route: registered (user-opened)
/// canonical file, validated on the open handle, raster images only (the
/// renderer decodes with createImageBitmap; animated GIF/WebP give their
/// first frame), size-capped.
pub const MAX_ANNOTATE_BYTES: u64 = 128 * 1024 * 1024;

pub fn read_registered_image(service: &FileService, path: &str) -> Result<Vec<u8>, String> {
    let (file, real) = open_registered(service, path)?;
    if !mime(&real).is_some_and(|m| m.starts_with("image/") && m != "image/svg+xml") {
        return Err("Only images can be annotated".into());
    }
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    if len > MAX_ANNOTATE_BYTES {
        return Err("Image is too large to annotate".into());
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(MAX_ANNOTATE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

fn is_drive_path(path: &str) -> bool {
    if !cfg!(windows) {
        return path.starts_with('/');
    }
    let b = path.as_bytes();
    b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

#[cfg(windows)]
fn final_path(file: &fs::File, _: &Path) -> Result<std::path::PathBuf, String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buf = vec![0u16; 1024];
    loop {
        // SAFETY: valid open handle and a writable buffer of the given length.
        let n = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle() as _,
                buf.as_mut_ptr(),
                buf.len() as u32,
                0,
            )
        } as usize;
        if n == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if n < buf.len() {
            let raw = std::path::PathBuf::from(std::ffi::OsString::from_wide(&buf[..n]));
            // Same verbatim-prefix stripping as `canonical` (dunce), so the forms compare.
            return Ok(dunce::simplified(&raw).to_path_buf());
        }
        buf.resize(n + 1, 0);
    }
}

#[cfg(not(windows))]
fn final_path(_: &fs::File, path: &Path) -> Result<std::path::PathBuf, String> {
    // Unsupported platform: best effort by name.
    canonical(path)
}

pub fn response(
    service: &FileService,
    webview_label: &str,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if !webview_allowed(webview_label) {
        return denied("Media is only served to the app window".into());
    }
    let result = (|| {
        let url = url::Url::parse(&request.uri().to_string()).map_err(|e| e.to_string())?;
        let (id, path) = target(&url)?;
        let unrooted = id == UNROOTED_ID;
        let (opened, path) = if unrooted {
            let (file, path) = open_registered(service, &path)?;
            (Some(file), path)
        } else {
            (None, guarded(&service.root(&id)?, &path, false)?)
        };
        let mime = mime(&path).ok_or("Unsupported media type")?;
        // is_media excludes documents, so the unrooted route never gets here.
        if !unrooted && (previewable(&path) || extension(&path) == "svg") {
            if let Some(draft) = service.draft(&path) {
                return page(mime, draft.into_bytes());
            }
            // Documents are small and never range-requested; serve them whole.
            if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
                return Err("Document is too large to preview".into());
            }
            return page(mime, fs::read(&path).map_err(|e| e.to_string())?);
        }
        let mut file = match opened {
            Some(file) => file,
            None => fs::File::open(path).map_err(|e| e.to_string())?,
        };
        let len = file.metadata().map_err(|e| e.to_string())?.len();
        let requested = range(
            request.headers().get("range").and_then(|v| v.to_str().ok()),
            len,
        )?;
        if requested.is_none() && len > 256 * 1024 * 1024 {
            return Err("Large media requires range requests".into());
        }
        let (start, end) = requested.unwrap_or((0, len.saturating_sub(1)));
        let count = if len == 0 { 0 } else { end - start + 1 };
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(count as usize);
        file.take(count)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        let mut response = Response::builder()
            .status(if requested.is_some() { 206 } else { 200 })
            .header("Content-Type", mime)
            .header("Accept-Ranges", "bytes")
            .header("Content-Length", bytes.len())
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff");
        // The sandboxed HTML frame (opaque origin) needs CORS for its own
        // project assets; registered unrooted files must never be readable
        // cross-origin, so that route sends no CORS header.
        if !unrooted {
            response = response.header("Access-Control-Allow-Origin", "*");
        }
        if requested.is_some() {
            response = response.header("Content-Range", format!("bytes {start}-{end}/{len}"));
        }
        response.body(bytes).map_err(|e| e.to_string())
    })();
    result.unwrap_or_else(denied)
}

fn denied(error: String) -> Response<Vec<u8>> {
    Response::builder()
        .status(403)
        .header("Content-Type", "text/plain")
        .body(error.into_bytes())
        .unwrap_or_default()
}

/// Documents (HTML, SVG) carry their own sandbox: even navigated to top level
/// they get an opaque origin and no popups/forms/top navigation.
fn page(mime: &str, bytes: Vec<u8>) -> Result<Response<Vec<u8>>, String> {
    Response::builder()
        .status(200)
        .header("Content-Type", mime)
        .header("Content-Length", bytes.len())
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox allow-scripts")
        .body(bytes)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranges_support_video_seek_and_suffix_and_reject_invalid_requests() {
        assert_eq!(
            range(Some("bytes=100-199"), 1000).unwrap(),
            Some((100, 199))
        );
        assert_eq!(range(Some("bytes=-20"), 1000).unwrap(), Some((980, 999)));
        assert_eq!(range(Some("bytes=900-"), 1000).unwrap(), Some((900, 999)));
        assert!(range(Some("bytes=1000-"), 1000).is_err());
        assert!(range(Some("bytes=1-2,3-4"), 1000).is_err());
    }
    #[test]
    fn protocol_refuses_outside_media_and_unregistered_roots() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        let c = service.open(t.path()).unwrap();
        let path = t.path().join("photo.png");
        fs::write(&path, [1, 2, 3, 4]).unwrap();
        let mut url = url::Url::parse(&format!("swarmterm-media://localhost/{}", c.id)).unwrap();
        url.query_pairs_mut()
            .append_pair("path", &path.to_string_lossy());
        let r = response(
            &service,
            APP_WEBVIEW,
            Request::builder()
                .uri(url.as_str())
                .header("range", "bytes=1-2")
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(r.status(), 206);
        assert_eq!(r.body(), &[2, 3]);
        let r = response(
            &service,
            APP_WEBVIEW,
            Request::builder()
                .uri("swarmterm-media://localhost/unknown?path=/etc/passwd")
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(r.status(), 403);
    }

    #[test]
    fn only_the_app_webview_is_served_and_unrooted_sends_no_cors() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        let shot = t.path().join("clip.png");
        fs::write(&shot, [9, 8]).unwrap();
        let path = service
            .register_user_media(&shot.to_string_lossy())
            .unwrap();
        let c = service.open(t.path()).unwrap();
        let mut rooted = url::Url::parse(&format!("swarmterm-media://localhost/{}", c.id)).unwrap();
        rooted
            .query_pairs_mut()
            .append_pair("path", &shot.to_string_lossy());
        for uri in [unrooted(&path), rooted.to_string()] {
            for label in ["preview-abc", "popout-1", "", "Main"] {
                let r = response(
                    &service,
                    label,
                    Request::builder().uri(&uri).body(vec![]).unwrap(),
                );
                assert_eq!(r.status(), 403, "{label} {uri}");
                assert!(r.body().starts_with(b"Media is only served"));
            }
        }
        let r = response(
            &service,
            APP_WEBVIEW,
            Request::builder()
                .uri(unrooted(&path))
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), &[9, 8]);
        assert!(r.headers().get("access-control-allow-origin").is_none());
        let r = response(
            &service,
            APP_WEBVIEW,
            Request::builder()
                .uri(rooted.as_str())
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(r.headers()["access-control-allow-origin"], "*");
    }

    #[test]
    fn annotate_read_serves_only_registered_images() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        let shot = t.path().join("a.png");
        let clip = t.path().join("v.mp4");
        fs::write(&shot, [1, 2, 3]).unwrap();
        fs::write(&clip, [4]).unwrap();
        let raw = shot.to_string_lossy().to_string();
        assert!(
            read_registered_image(&service, &raw).is_err(),
            "not opened yet"
        );
        let path = service.register_user_media(&raw).unwrap();
        assert_eq!(
            read_registered_image(&service, &path.to_string_lossy()).unwrap(),
            [1, 2, 3]
        );
        let video = service
            .register_user_media(&clip.to_string_lossy())
            .unwrap();
        assert!(read_registered_image(&service, &video.to_string_lossy()).is_err());
    }

    #[test]
    fn unrooted_validates_the_open_handle_not_the_name() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        let shot = t.path().join("a.png");
        fs::write(&shot, [1]).unwrap();
        let path = service
            .register_user_media(&shot.to_string_lossy())
            .unwrap();
        let get = |p: &Path| {
            response(
                &service,
                APP_WEBVIEW,
                Request::builder().uri(unrooted(p)).body(vec![]).unwrap(),
            )
        };
        assert_eq!(get(&path).status(), 200);
        // Swapped for a directory: the handle is no regular file.
        fs::remove_file(&shot).unwrap();
        fs::create_dir(&shot).unwrap();
        assert_eq!(get(&path).status(), 403);
        fs::remove_dir(&shot).unwrap();
        // Recreated with other content is still the registered path: allowed.
        fs::write(&shot, [2]).unwrap();
        assert_eq!(get(&path).body(), &[2]);
        // A different (unregistered) file under a name that resolves elsewhere.
        let secret = t.path().join("secret.png");
        fs::write(&secret, [7]).unwrap();
        assert_eq!(get(&secret).status(), 403);
        assert_eq!(get(&t.path().join("missing.png")).status(), 403);
        service.unregister_media(&[path.clone()]);
        assert_eq!(get(&path).status(), 403);
    }

    #[cfg(windows)]
    #[test]
    fn unrooted_denies_a_junction_retargeted_after_registration() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        let (a, b, link) = (
            t.path().join("a"),
            t.path().join("b"),
            t.path().join("link"),
        );
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        fs::write(a.join("x.png"), [1]).unwrap();
        fs::write(b.join("x.png"), [7]).unwrap();
        let junction = |target: &Path| {
            let ok = std::process::Command::new("cmd")
                .args(["/c", "mklink", "/J"])
                .arg(&link)
                .arg(target)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "mklink /J");
        };
        junction(&a);
        let registered = service
            .register_user_media(&link.join("x.png").to_string_lossy())
            .unwrap();
        let get = |p: &Path| {
            response(
                &service,
                APP_WEBVIEW,
                Request::builder().uri(unrooted(p)).body(vec![]).unwrap(),
            )
        };
        // Through the junction: the handle's final path is the registered one.
        assert_eq!(get(&link.join("x.png")).body(), &[1]);
        fs::remove_dir(&link).unwrap();
        junction(&b);
        // Same name, but the open handle now resolves to b\x.png: refused.
        assert_eq!(get(&link.join("x.png")).status(), 403);
        assert_eq!(get(&registered).status(), 200);
        // Device, verbatim, UNC and relative names are refused before opening.
        for raw in [
            r"\\.\NUL",
            r"\\?\C:\x.png",
            r"\\host\s\x.png",
            "NUL",
            "x.png",
        ] {
            assert!(!is_drive_path(raw), "{raw}");
        }
        assert!(is_drive_path(r"C:\x.png"));
    }

    fn unrooted(path: &Path) -> String {
        let mut url = url::Url::parse("swarmterm-media://localhost/unrooted").unwrap();
        url.query_pairs_mut()
            .append_pair("path", &path.to_string_lossy());
        url.to_string()
    }

    #[test]
    fn unrooted_route_serves_only_registered_media_with_ranges() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        let shown = t.path().join("shot.mp4");
        let other = t.path().join("other.png");
        fs::write(&shown, [1, 2, 3, 4]).unwrap();
        fs::write(&other, [1]).unwrap();
        let get = |uri: String, range: Option<&str>| {
            let mut b = Request::builder().uri(uri);
            if let Some(r) = range {
                b = b.header("range", r);
            }
            response(&service, APP_WEBVIEW, b.body(vec![]).unwrap())
        };
        assert_eq!(get(unrooted(&shown), None).status(), 403);
        let path = service
            .register_user_media(&shown.to_string_lossy())
            .unwrap();
        let r = get(unrooted(&path), Some("bytes=2-"));
        assert_eq!(r.status(), 206);
        assert_eq!(r.body(), &[3, 4]);
        assert_eq!(get(unrooted(&other), None).status(), 403);
        // A path spelled differently still resolves to the registered file.
        let dotted = t.path().join("sub").join("..").join("shot.mp4");
        fs::create_dir(t.path().join("sub")).unwrap();
        assert_eq!(get(unrooted(&dotted), None).status(), 200);
    }

    #[test]
    fn detected_media_is_checked_but_never_registered() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        fs::write(t.path().join("a.png"), [0]).unwrap();
        fs::write(t.path().join("b.txt"), "x").unwrap();
        let abs = t.path().join("a.png").to_string_lossy().into_owned();
        let raws: Vec<String> = vec!["a.png".into(), abs, "b.txt".into(), "gone.gif".into()];
        let got = service.check_detected_media(&raws, t.path());
        let a = canonical(&t.path().join("a.png")).unwrap();
        assert_eq!(got, vec![Some(a.clone()), Some(a.clone()), None, None]);
        // Pane output (agent-controlled) never widens what the webview may read.
        assert!(!service.unrooted_registered(&a));
        // Over the cap: entries past MAX_DETECTED_PER_CALL are not looked at.
        let many: Vec<String> = (0..super::super::MAX_DETECTED_PER_CALL)
            .map(|i| format!("missing{i}.png"))
            .chain(std::iter::once("a.png".to_string()))
            .collect();
        assert!(service
            .check_detected_media(&many, t.path())
            .iter()
            .all(Option::is_none));
    }

    #[test]
    fn user_media_registration_requires_absolute_existing_media() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        fs::write(t.path().join("a.webp"), [0]).unwrap();
        fs::write(t.path().join("a.html"), "<p>").unwrap();
        let abs = |n: &str| t.path().join(n).to_string_lossy().into_owned();
        let a = service.register_user_media(&abs("a.webp")).unwrap();
        assert!(service.unrooted_registered(&a));
        assert!(service.register_user_media("a.webp").is_err());
        assert!(service.register_user_media(&abs("a.html")).is_err());
        assert!(service.register_user_media(&abs("nope.png")).is_err());
    }

    #[test]
    fn resolve_media_validates_kind_existence_and_resolves_relative_paths() {
        let t = tempfile::tempdir().unwrap();
        let cwd = t.path().join("pane");
        fs::create_dir(&cwd).unwrap();
        fs::write(t.path().join("up.PNG"), [0]).unwrap();
        fs::write(t.path().join("notes.txt"), "x").unwrap();
        fs::write(t.path().join("page.svg"), "<svg/>").unwrap();
        fs::create_dir(t.path().join("dir.png")).unwrap();
        let expected = canonical(&t.path().join("up.PNG")).unwrap();
        // Relative to the terminal cwd, `..` traversal allowed but canonicalised.
        assert_eq!(resolve_media("../up.PNG", &cwd).unwrap(), expected);
        assert_eq!(
            resolve_media(&expected.to_string_lossy(), Path::new("/elsewhere")).unwrap(),
            expected
        );
        // Traversal onto a non-media file is still refused.
        assert!(resolve_media("../notes.txt", &cwd).is_err());
        assert!(resolve_media("../page.svg", &cwd).is_err());
        assert!(resolve_media("../dir.png", &cwd).is_err());
        assert!(resolve_media("../missing.png", &cwd).is_err());
        assert!(resolve_media("  ", &cwd).is_err());
        assert!(resolve_media(r"\\host\share\x.png", &cwd).is_err());
    }

    #[test]
    fn preview_frame_serves_path_addressed_assets_and_the_unsaved_draft() {
        let t = tempfile::tempdir().unwrap();
        let service = FileService::new(t.path().join("history"));
        let c = service.open(t.path()).unwrap();
        let page_path = t.path().join("index.html");
        fs::write(&page_path, "<p>disk</p>").unwrap();
        fs::write(t.path().join("app.css"), "p{}").unwrap();
        let root = std::path::PathBuf::from(&c.root);
        let addr = |name: &str| {
            let p = root.join(name).to_string_lossy().replace('\\', "/");
            format!(
                "swarmterm-media://localhost/{}/f/{}",
                c.id,
                p.trim_start_matches('/').replace(' ', "%20")
            )
        };
        let get = |uri: String| {
            response(
                &service,
                APP_WEBVIEW,
                Request::builder().uri(uri).body(vec![]).unwrap(),
            )
        };
        let r = get(addr("app.css"));
        assert_eq!(r.status(), 200);
        assert_eq!(r.body(), b"p{}");
        let r = get(addr("index.html"));
        assert_eq!(r.body(), b"<p>disk</p>");
        assert_eq!(
            r.headers()["content-security-policy"],
            "sandbox allow-scripts"
        );
        let file = root.join("index.html").to_string_lossy().into_owned();
        service
            .request(
                crate::files::FileRequest::PreviewDraft {
                    context_id: c.id.clone(),
                    path: file.clone(),
                    content: Some("<p>draft</p>".into()),
                },
                None,
            )
            .unwrap();
        assert_eq!(get(addr("index.html")).body(), b"<p>draft</p>");
        service
            .request(
                crate::files::FileRequest::PreviewDraft {
                    context_id: c.id.clone(),
                    path: file,
                    content: None,
                },
                None,
            )
            .unwrap();
        assert_eq!(get(addr("index.html")).body(), b"<p>disk</p>");
        assert!(!is_media(Path::new("a.js")));
        assert!(!external_preview(Path::new("a.js")));
        assert!(external_preview(Path::new("a.SVG")));
    }
}
