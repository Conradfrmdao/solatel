//! The client's files: how long a browser may keep each one, and which build
//! of the client they are.
//!
//! Every file the page loads is named after its own contents
//! (`yard.3fa2c19b0d4e6a71.glb`), written so by `client/build.mjs`. A name
//! like that can never be served with different bytes, so a browser may keep
//! it for good, and a map is downloaded once rather than at the start of
//! every match. The page itself cannot be named that way - it is how the
//! browser learns the other names - so `index.html` is never stored, and
//! neither is anything else without a hash in its name. A new build is picked
//! up on the next page load and costs only the files that changed.
//!
//! The other half is a tab left open across a deploy. Its page names files
//! the new build no longer has, so it is refused at the handshake and
//! reloads itself, the same way a tab on an old protocol does.

use axum::{
    extract::Request,
    http::{HeaderValue, StatusCode, header},
    middleware::Next,
    response::Response,
};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// A year: as long as anybody keeps anything, and the convention for a name
/// that can never mean anything else.
const KEEP: HeaderValue = HeaderValue::from_static("public, max-age=31536000, immutable");
const NEVER: HeaderValue = HeaderValue::from_static("no-store");

/// How many hex digits of its content hash a file's name carries. Matches
/// `HASH_DIGITS` in `client/build.mjs`.
pub const HASH_DIGITS: usize = 16;

/// What a browser page calls its build: this, then a hash. The end-to-end
/// drivers name themselves instead (`duel.mjs`); they load no files and are
/// not asked to match.
pub const BUILD_PREFIX: &str = "solatel/";

/// Whether a request path names a file by its contents: a last segment of a
/// stem, a hash, and at least one extension (`solatel.<hash>.js.map`).
pub fn is_content_named(path: &str) -> bool {
    let file = path.rsplit('/').next().unwrap_or_default();
    let parts: Vec<&str> = file.split('.').collect();
    parts.len() >= 3 && parts[1..parts.len() - 1].iter().any(|part| is_hash(part))
}

fn is_hash(part: &str) -> bool {
    part.len() == HASH_DIGITS && part.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The `Cache-Control` for a response to `path`. Only a file that was found
/// is kept: a 404 for a hashed name is a page from another build asking, and
/// storing that would outlive the build that fixes it.
pub fn cache_control(path: &str, status: StatusCode) -> HeaderValue {
    let found = status.is_success() || status == StatusCode::NOT_MODIFIED;
    if found && is_content_named(path) {
        KEEP
    } else {
        NEVER
    }
}

/// Sets `Cache-Control` on every response the server sends.
pub async fn cache_policy(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let mut response = next.run(request).await;
    let value = cache_control(&path, response.status());
    response.headers_mut().insert(header::CACHE_CONTROL, value);
    response
}

/// Which build of the client this server hands out: the `build.json` the
/// client's build writes beside the page.
#[derive(Clone)]
pub struct ServedBuild {
    file: Arc<PathBuf>,
}

impl ServedBuild {
    pub fn new(web_dir: &Path) -> Self {
        Self {
            file: Arc::new(web_dir.join("build.json")),
        }
    }

    /// The build on disk now, or `None` when no client has been built here.
    ///
    /// Read on every handshake rather than once at start, because the client
    /// is rebuilt under a running server - that is how `./x client` is used -
    /// and an answer kept from start would refuse every page built since.
    pub async fn current(&self) -> Option<String> {
        let text = tokio::fs::read_to_string(&*self.file).await.ok()?;
        let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
        parsed.get("build")?.as_str().map(str::to_owned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "0123456789abcdef";

    #[test]
    fn a_file_named_by_its_contents_is_kept_for_good() {
        for path in [
            format!("/solatel.{HASH}.js"),
            format!("/solatel.{HASH}.js.map"),
            format!("/sim/solatel_sim_bg.{HASH}.wasm"),
            format!("/assets/maps/yard.{HASH}.glb"),
            format!("/assets/photo/concrete_albedo.{HASH}.webp"),
        ] {
            assert!(is_content_named(&path), "{path}");
            assert_eq!(cache_control(&path, StatusCode::OK), KEEP, "{path}");
            assert_eq!(
                cache_control(&path, StatusCode::NOT_MODIFIED),
                KEEP,
                "{path}"
            );
            assert_eq!(
                cache_control(&path, StatusCode::PARTIAL_CONTENT),
                KEEP,
                "{path}"
            );
        }
    }

    #[test]
    fn everything_else_is_never_stored() {
        for path in [
            "/",
            "/index.html",
            "/build.json",
            "/solatel.js",
            "/assets/maps/yard.glb",
            "/health",
            "/proof",
            "/admin",
            "/ws",
            // Not a hash: wrong length, capitals, or the extension itself.
            "/solatel.0123456789abcde.js",
            "/solatel.0123456789ABCDEF.js",
            "/solatel.0123456789abcdefa.js",
            &format!("/solatel.{HASH}"),
            &format!("/{HASH}.js"),
        ] {
            assert!(!is_content_named(path), "{path}");
            assert_eq!(cache_control(path, StatusCode::OK), NEVER, "{path}");
        }
    }

    #[test]
    fn a_missing_hashed_file_is_never_stored() {
        let path = format!("/assets/maps/yard.{HASH}.glb");
        assert_eq!(cache_control(&path, StatusCode::NOT_FOUND), NEVER);
        assert_eq!(
            cache_control(&path, StatusCode::INTERNAL_SERVER_ERROR),
            NEVER
        );
    }

    #[tokio::test]
    async fn the_served_build_is_read_from_disk_each_time() {
        let dir = std::env::temp_dir().join(format!("solatel-served-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let served = ServedBuild::new(&dir);
        assert_eq!(served.current().await, None, "no client built yet");

        std::fs::write(dir.join("build.json"), r#"{"build":"solatel/aaaa"}"#).unwrap();
        assert_eq!(served.current().await.as_deref(), Some("solatel/aaaa"));
        std::fs::write(dir.join("build.json"), r#"{"build":"solatel/bbbb"}"#).unwrap();
        assert_eq!(served.current().await.as_deref(), Some("solatel/bbbb"));

        std::fs::write(dir.join("build.json"), "not json").unwrap();
        assert_eq!(served.current().await, None);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
