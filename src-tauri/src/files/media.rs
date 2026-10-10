use super::{path::guarded, FileService};
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

pub fn response(service: &FileService, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let result = (|| {
        let url = url::Url::parse(&request.uri().to_string()).map_err(|e| e.to_string())?;
        let (id, path) = target(&url)?;
        let path = guarded(&service.root(&id)?, &path, false)?;
        let mime = mime(&path).ok_or("Unsupported media type")?;
        if previewable(&path) || extension(&path) == "svg" {
            if let Some(draft) = service.draft(&path) {
                return page(mime, draft.into_bytes());
            }
            // Documents are small and never range-requested; serve them whole.
            if fs::metadata(&path).map_err(|e| e.to_string())?.len() > 32 * 1024 * 1024 {
                return Err("Document is too large to preview".into());
            }
            return page(mime, fs::read(&path).map_err(|e| e.to_string())?);
        }
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
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
            .header("Access-Control-Allow-Origin", "*")
            .header("Cache-Control", "no-store")
            .header("X-Content-Type-Options", "nosniff");
        if requested.is_some() {
            response = response.header("Content-Range", format!("bytes {start}-{end}/{len}"));
        }
        response.body(bytes).map_err(|e| e.to_string())
    })();
    result.unwrap_or_else(|error: String| {
        Response::builder()
            .status(403)
            .header("Content-Type", "text/plain")
            .body(error.into_bytes())
            .unwrap_or_default()
    })
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
            Request::builder()
                .uri("swarmterm-media://localhost/unknown?path=/etc/passwd")
                .body(vec![])
                .unwrap(),
        );
        assert_eq!(r.status(), 403);
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
        let get =
            |uri: String| response(&service, Request::builder().uri(uri).body(vec![]).unwrap());
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
