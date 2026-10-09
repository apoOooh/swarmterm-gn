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
        _ => None,
    }
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
        let id = url.path().trim_matches('/');
        let path = url
            .query_pairs()
            .find(|(k, _)| k == "path")
            .ok_or("Missing media path")?
            .1
            .into_owned();
        let path = guarded(&service.root(id)?, &path, false)?;
        let mime = mime(&path).ok_or("Unsupported media type")?;
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
}
