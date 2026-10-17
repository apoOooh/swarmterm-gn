//! Pure release logic for the buzzkey companion (SWA-42): which GitHub
//! release to offer, which hosts a download may touch, and whether the
//! bytes are what the buzzkey release workflow signed.
//!
//! Trust chain: `SHA256SUMS.txt.minisig` is checked against the public key
//! compiled in below, THEN each file against `SHA256SUMS.txt`. The sums file
//! alone proves integrity only — anyone who can publish a release can also
//! publish matching sums — so nothing is trusted before the signature is.

use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};

/// The one release source. Fixed in code on purpose: a setting or env
/// override in release builds would turn the installer into "run whatever
/// this URL serves".
pub const RELEASES_URL: &str = "https://api.github.com/repos/apoOooh/buzzkey/releases?per_page=20";

/// The buzzkey release key (minisign, key id EFAC892903260581). The release
/// workflow signs `SHA256SUMS.txt` with its secret half (GitHub secret
/// `MINISIGN_SECRET_KEY` in the buzzkey repo).
pub const SIGNING_KEY: &str = "RWSBBSYDKYms79DKyRXf9Qb9z0KmDIM5ZCcdrwmXBF2MCuNC61n+nGkM";
/// swarmterm-testlab key (id E7591202FF617829). Its secret half lies
/// unencrypted in the testlab, so only debug builds trust it — scenario 34
/// installs from a local fake release signed with it.
pub const TEST_SIGNING_KEY: &str = "RWQpeGH/AhJZ57Bh0TYOSNHLEvKEhXH7kpqUYU+lu6FCIfkpkIaN6h91";

/// Keys a release may be signed with in this build.
pub fn trusted_keys() -> &'static [&'static str] {
    if cfg!(debug_assertions) {
        &[SIGNING_KEY, TEST_SIGNING_KEY]
    } else {
        &[SIGNING_KEY]
    }
}

/// Any trusted key verifies.
pub fn verify_trusted(sums: &[u8], sig: &str) -> Result<(), String> {
    let mut last = Err("signature-invalid".to_string());
    for key in trusted_keys() {
        last = verify_signature(sums, sig, key);
        if last.is_ok() {
            break;
        }
    }
    last
}

pub const TAG_PREFIX: &str = "buzzkey-";
pub const EXE: &str = "buzzkey.exe";
pub const CONSOLE_EXE: &str = "buzzkey-console.exe";
pub const SUMS: &str = "SHA256SUMS.txt";
pub const SUMS_SIG: &str = "SHA256SUMS.txt.minisig";
/// Files that end up installed, in install order.
pub const INSTALLED: &[&str] = &[EXE, CONSOLE_EXE];

/// pyapp launchers are a few MB (the runtime is fetched on first start);
/// anything near this is not a buzzkey build.
pub const MAX_EXE_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_SUMS_BYTES: u64 = 64 * 1024;
pub const MAX_SIG_BYTES: u64 = 4 * 1024;
pub const MAX_LIST_BYTES: u64 = 4 * 1024 * 1024;

/// Hosts a request (or any redirect of it) may reach. GitHub serves release
/// assets from github.com and redirects to its asset CDNs.
const ALLOWED_HOSTS: &[&str] = &[
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

#[derive(Debug, Clone, Deserialize)]
pub struct GhAsset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub assets: Vec<GhAsset>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub url: String,
}

/// A release that has everything an install needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Release {
    pub tag: String,
    pub version: Version,
    pub exe: Asset,
    pub console: Asset,
    pub sums: Asset,
    pub sig: Asset,
}

impl Release {
    pub fn asset(&self, name: &str) -> Option<&Asset> {
        [&self.exe, &self.console, &self.sums, &self.sig]
            .into_iter()
            .find(|a| a.name == name)
    }
}

/// `buzzkey-1.9.1-bk.4` → `1.9.1+bk.4`. The fork suffix is build metadata
/// in buzzkey's own version string (`BUILD_SUFFIX = "+bk"`), but semver
/// ignores build metadata when ordering, so it is parsed as a pre-release
/// would be and compared by hand in `newer`.
pub fn version_of_tag(tag: &str) -> Option<Version> {
    let rest = tag.strip_prefix(TAG_PREFIX)?;
    let (core, bk) = match rest.split_once("-bk.") {
        Some((core, n)) => (core, Some(n)),
        None => (rest, None),
    };
    let mut v = Version::parse(core).ok()?;
    if !v.pre.is_empty() || !v.build.is_empty() {
        return None;
    }
    if let Some(n) = bk {
        n.parse::<u64>().ok()?;
        v.build = semver::BuildMetadata::new(&format!("bk.{n}")).ok()?;
    }
    Some(v)
}

/// What buzzkey reports in `hello` (`1.9.1+bk.4`, maybe `1.9.1b1+bk.2` for
/// an old whisper-key-based build): lenient, unknown shapes are `None`
/// and simply never show "update available".
pub fn parse_reported(version: &str) -> Option<Version> {
    Version::parse(version.trim()).ok()
}

fn bk_number(v: &Version) -> u64 {
    v.build
        .as_str()
        .strip_prefix("bk.")
        .and_then(|n| n.parse().ok())
        .unwrap_or(0)
}

/// Strictly newer, counting the fork build number after the core version.
pub fn newer(candidate: &Version, current: &Version) -> bool {
    let core = |v: &Version| (v.major, v.minor, v.patch);
    match core(candidate).cmp(&core(current)) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => {
            // 1.9.1b1 (pre) < 1.9.1 regardless of the fork number.
            if !current.pre.is_empty() && candidate.pre.is_empty() {
                return true;
            }
            bk_number(candidate) > bk_number(current)
        }
    }
}

fn pick(release: &GhRelease, name: &str) -> Option<Asset> {
    release
        .assets
        .iter()
        .find(|a| a.name == name)
        .map(|a| Asset {
            name: a.name.clone(),
            size: a.size,
            url: a.browser_download_url.clone(),
        })
}

/// The newest published buzzkey release that carries the two launchers,
/// the sums and their signature. Unsigned releases (everything before the
/// signing workflow) are skipped, not offered with a warning.
pub fn select(releases: &[GhRelease]) -> Option<Release> {
    releases
        .iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            Some(Release {
                tag: r.tag_name.clone(),
                version: version_of_tag(&r.tag_name)?,
                exe: pick(r, EXE)?,
                console: pick(r, CONSOLE_EXE)?,
                sums: pick(r, SUMS)?,
                sig: pick(r, SUMS_SIG)?,
            })
        })
        .filter(|r| {
            r.exe.size <= MAX_EXE_BYTES
                && r.console.size <= MAX_EXE_BYTES
                && r.sums.size <= MAX_SUMS_BYTES
                && r.sig.size <= MAX_SIG_BYTES
        })
        .reduce(|best, r| {
            if newer(&r.version, &best.version) {
                r
            } else {
                best
            }
        })
}

/// HTTPS to an allowlisted host. `allow_loopback` is the testlab's fake
/// release server and only ever true in debug builds.
pub fn url_allowed(url: &url::Url, allow_loopback: bool) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    if allow_loopback && url.scheme() == "http" && (host == "127.0.0.1" || host == "localhost") {
        return true;
    }
    url.scheme() == "https" && url.username().is_empty() && ALLOWED_HOSTS.contains(&host)
}

/// Check `sums` against the signature with `key` (base64 minisign public
/// key). Legacy (non-prehashed) signatures are refused: the release
/// workflow signs prehashed, and accepting both only widens what verifies.
pub fn verify_signature(sums: &[u8], sig: &str, key: &str) -> Result<(), String> {
    let key = PublicKey::from_base64(key).map_err(|_| "signing-key-invalid".to_string())?;
    let sig = Signature::decode(sig).map_err(|_| "signature-invalid".to_string())?;
    key.verify(sums, &sig, false)
        .map_err(|_| "signature-invalid".to_string())
}

/// `SHA256SUMS.txt` in `sha256sum` format (`<hex>  <name>` or `<hex> *<name>`).
/// Only the files we install are looked up, so unrelated lines are fine;
/// a name listed twice with different hashes is not.
pub fn expected_hash(sums: &str, name: &str) -> Result<[u8; 32], String> {
    let mut found: Option<[u8; 32]> = None;
    for line in sums.lines() {
        let line = line.trim_end_matches('\r');
        let Some((hex, file)) = line.split_once(' ') else {
            continue;
        };
        let file = file.trim_start_matches(' ').trim_start_matches('*');
        if file != name {
            continue;
        }
        let hash = decode_hex(hex).ok_or_else(|| "sums-invalid".to_string())?;
        if found.is_some_and(|f| f != hash) {
            return Err("sums-invalid".into());
        }
        found = Some(hash);
    }
    found.ok_or_else(|| format!("sums-missing:{name}"))
}

fn decode_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Signed with the testlab key (`tools/minisign-test.mjs sign`). The two
    // hashes are sha256("") and sha256("a").
    const SUMS_FIXTURE: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  buzzkey.exe\nca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb *buzzkey-console.exe\n";
    const SIG_FIXTURE: &str = "untrusted comment: signature from swarmterm-testlab test key\nRUQpeGH/AhJZ53umzp4yU0JMAI8UMyrp01Y2KOOX92Ug82IQCJKUwUcNBhmJipktvXIPuZH+eYY/2SaSMJJA0ZtR6F4j1tqQSwA=\ntrusted comment: timestamp:0\tfile:SHA256SUMS.txt\nfSNJZiCZoVIOBT4ONr14f2bHxFfOUau5yv07VtW2MvQZD2sPjxiCvQt7B7w1ZkqbTx0pvuJQnkLRnfGw/raSAg==\n";

    fn gh(tag: &str, names: &[&str]) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            draft: false,
            prerelease: false,
            assets: names
                .iter()
                .map(|n| GhAsset {
                    name: (*n).into(),
                    size: 10,
                    browser_download_url: format!("https://github.com/x/{tag}/{n}"),
                })
                .collect(),
        }
    }

    const ALL: &[&str] = &[EXE, CONSOLE_EXE, SUMS, SUMS_SIG];

    #[test]
    fn tag_versions_keep_the_fork_number() {
        let v = version_of_tag("buzzkey-1.9.1-bk.4").unwrap();
        assert_eq!(v.to_string(), "1.9.1+bk.4");
        assert_eq!(
            version_of_tag("buzzkey-2.0.0").unwrap().to_string(),
            "2.0.0"
        );
        assert!(version_of_tag("v1.9.1").is_none());
        assert!(version_of_tag("buzzkey-1.9.1-rc.1").is_none());
        assert!(version_of_tag("buzzkey-1.9.1-bk.x").is_none());
    }

    #[test]
    fn newer_counts_core_then_fork_number() {
        let v = |s: &str| Version::parse(s).unwrap();
        assert!(newer(&v("1.9.1+bk.4"), &v("1.9.1+bk.3")));
        assert!(!newer(&v("1.9.1+bk.3"), &v("1.9.1+bk.3")));
        assert!(!newer(&v("1.9.1+bk.9"), &v("1.10.0+bk.1")));
        assert!(newer(&v("1.10.0"), &v("1.9.1+bk.9")));
        assert!(newer(&v("1.9.1+bk.1"), &v("1.9.1-b1+bk.2")));
        assert_eq!(parse_reported(" 1.9.1+bk.4 ").unwrap(), v("1.9.1+bk.4"));
        assert!(parse_reported("1.9.1b1").is_none());
    }

    #[test]
    fn select_takes_the_newest_complete_signed_release() {
        let mut draft = gh("buzzkey-9.0.0", ALL);
        draft.draft = true;
        let mut pre = gh("buzzkey-8.0.0", ALL);
        pre.prerelease = true;
        let unsigned = gh("buzzkey-7.0.0", &[EXE, CONSOLE_EXE, SUMS]);
        let mut huge = gh("buzzkey-6.0.0", ALL);
        huge.assets[0].size = MAX_EXE_BYTES + 1;
        let releases = vec![
            draft,
            pre,
            unsigned,
            huge,
            gh("buzzkey-1.9.1-bk.3", ALL),
            gh("buzzkey-1.9.1-bk.4", ALL),
            gh("other-5.0.0", ALL),
        ];
        let r = select(&releases).unwrap();
        assert_eq!(r.tag, "buzzkey-1.9.1-bk.4");
        assert_eq!(r.asset(SUMS_SIG).unwrap().name, SUMS_SIG);
        assert!(select(&[gh("buzzkey-1.0.0", &[EXE, CONSOLE_EXE, SUMS])]).is_none());
    }

    #[test]
    fn only_https_to_allowlisted_hosts() {
        let u = |s: &str| url::Url::parse(s).unwrap();
        assert!(url_allowed(&u("https://github.com/a/b"), false));
        assert!(url_allowed(
            &u("https://release-assets.githubusercontent.com/x"),
            false
        ));
        assert!(!url_allowed(&u("http://github.com/a/b"), false));
        assert!(!url_allowed(&u("https://github.com.evil.example/a"), false));
        let mut with_user = u("https://github.com/a");
        with_user.set_username("x").unwrap();
        assert!(!url_allowed(&with_user, false));
        assert!(!url_allowed(&u("http://127.0.0.1:9/x"), false));
        assert!(url_allowed(&u("http://127.0.0.1:9/x"), true));
        assert!(!url_allowed(&u("http://intranet.example/x"), true));
    }

    #[test]
    fn signature_must_match_the_compiled_key_and_the_bytes() {
        assert_eq!(
            verify_signature(SUMS_FIXTURE.as_bytes(), SIG_FIXTURE, TEST_SIGNING_KEY),
            Ok(())
        );
        let tampered = SUMS_FIXTURE.replace("e3b0", "e3b1");
        assert!(verify_signature(tampered.as_bytes(), SIG_FIXTURE, TEST_SIGNING_KEY).is_err());
        // The release key did not sign the testlab fixture.
        assert!(verify_signature(SUMS_FIXTURE.as_bytes(), SIG_FIXTURE, SIGNING_KEY).is_err());
        // Test builds (debug) also trust the testlab key; release builds do not.
        assert_eq!(
            verify_trusted(SUMS_FIXTURE.as_bytes(), SIG_FIXTURE).is_ok(),
            cfg!(debug_assertions)
        );
        // Another key (same format) must not verify.
        let other = "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
        assert!(verify_signature(SUMS_FIXTURE.as_bytes(), SIG_FIXTURE, other).is_err());
        assert!(verify_signature(SUMS_FIXTURE.as_bytes(), "garbage", TEST_SIGNING_KEY).is_err());
    }

    #[test]
    fn sums_lookup_is_strict_about_the_files_we_install() {
        assert_eq!(expected_hash(SUMS_FIXTURE, EXE).unwrap(), sha256(b""));
        assert_eq!(
            expected_hash(SUMS_FIXTURE, CONSOLE_EXE).unwrap(),
            sha256(b"a")
        );
        assert!(expected_hash(SUMS_FIXTURE, "other.exe").is_err());
        let twice = format!("{SUMS_FIXTURE}{}  buzzkey.exe\n", "00".repeat(32));
        assert!(expected_hash(&twice, EXE).is_err());
        assert!(expected_hash("zz  buzzkey.exe", EXE).is_err());
        let crlf = SUMS_FIXTURE.replace('\n', "\r\n");
        assert_eq!(expected_hash(&crlf, EXE).unwrap(), sha256(b""));
    }
}
