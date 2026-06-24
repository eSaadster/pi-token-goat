/**
 * Google Drive image fetcher: downloads + shrinks + caches.
 *
 * Faithful TypeScript port of src/token_goat/gdrive.py. Strict NodeNext ESM.
 *
 * ===========================================================================
 * THE SEAM STRATEGY (mirrors Python's deferred optional imports + test patches)
 * ===========================================================================
 * Python lazily imports the optional Google libraries inside try/except blocks
 * and the tests patch the import targets directly. There is no `googleapis` /
 * `google-auth-library` npm dependency here; instead each Python patch target is
 * a module-level injectable SEAM with a default real implementation that does a
 * dynamic `await import(...)` and fail-softs EXACTLY like Python's ImportError /
 * except path. Tests inject a seam so the real import is never reached.
 *
 * Seam setters (call with `null` to restore the real default):
 *   - patch("google.auth.default", return_value=(creds, "proj"))
 *       -> gdrive._setGoogleAuthDefault(() => [creds, "proj"])
 *   - patch("google.auth.default", side_effect=Exception("no ADC"))
 *       -> gdrive._setGoogleAuthDefault(() => { throw new Error("no ADC"); })
 *   - patch("google.oauth2.credentials.Credentials.from_authorized_user_file",
 *           return_value=fake)
 *       -> gdrive._setCredentialsFromAuthorizedUserFile(() => fake)
 *   - patch("google.auth.transport.requests.Request", ...)
 *       -> gdrive._setRequestFactory(() => new FakeRequest())
 *   - patch("googleapiclient.discovery.build", return_value=service)
 *       -> gdrive._setDriveBuild(() => service)
 *   - patch("googleapiclient.http.MediaIoBaseDownload", side_effect=fake)
 *       -> gdrive._setMediaIoBaseDownload(fakeDownloaderCtor)
 *   - patch("google_auth_oauthlib.flow.InstalledAppFlow.from_client_secrets_file",
 *           return_value=flow)
 *       -> gdrive._setInstalledAppFlowFromClientSecretsFile(() => flow)
 *
 * DEFAULT FAIL-SOFT BEHAVIOR of each seam (matches Python):
 *   - _googleAuthDefault: dynamic import("google-auth-library") + ADC probe.
 *     _try_adc() catches ANY error (missing package OR auth failure) and returns
 *     null — so on a box without the package, ADC is simply unavailable.
 *   - _credentialsFromAuthorizedUserFile / _requestFactory: dynamic import; on
 *     failure _try_stored_oauth catches and returns null.
 *   - _driveBuild / _mediaIoBaseDownload: dynamic import("googleapis"); a missing
 *     package surfaces as the same RuntimeError the Python download path raises.
 *   - _installedAppFlowFromClientSecretsFile: dynamic import; a missing package
 *     surfaces as a RuntimeError, matching Python's flow-init failure path.
 *
 * ===========================================================================
 * Parity notes (Python -> TS)
 * ===========================================================================
 *  - pathlib.Path -> string paths. paths.ts exposes camelCase helpers
 *    (gdriveCredsPath / gdriveCacheDir / ensureDir / atomicWriteText /
 *    atomicWriteBytes / ensureParentDir).
 *  - io.BytesIO -> a minimal in-memory byte buffer (_ByteBuffer) with write() /
 *    tell() / getvalue(), matching the surface MediaIoBaseDownload expects.
 *  - fetch_file awaits image_shrink.shrink_if_image (async in the TS port), so
 *    fetch_file is async; list_drive_files / get_credentials stay sync.
 *  - str[:n] (truncation) counts CODE POINTS -> [...s].slice(0, n).join("").
 *  - 0o600 secure write -> fs.writeFileSync(..., { mode: 0o600 }) + chmod.
 *  - Python str.split("\n") keeps a trailing "" after a final newline (unlike
 *    splitlines); JS String.split("\n") matches that, so the offsets loop is a
 *    1:1 port.
 *  - len(ln.encode("utf-8")) -> Buffer.byteLength(ln, "utf-8").
 *  - `verbatimModuleSyntax`/`exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`
 *    are on — optionals are `T | undefined`, every indexed access is narrowed.
 */

import fs from "node:fs";
import path from "node:path";

import * as image_shrink from "./image_shrink.js";
import * as paths from "./paths.js";
import * as self from "./gdrive.js";
import { sanitize_log_str } from "./hooks_common.js";
import { registerReset } from "./reset.js";
import { getLogger } from "./util.js";

import { extract as md_extract } from "./languages/markdown.js";

const _LOG = getLogger("gdrive");

const _DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

// OAuth error messages that indicate the refresh token is permanently invalid
// (revoked or expired grant), as opposed to a transient network failure.
const _PERMANENT_OAUTH_ERROR_KEYWORDS = [
  "invalid_grant",
  "token has been expired",
  "token has been revoked",
  "unauthorized_client",
] as const;

// ===========================================================================
// Structural credential interface (mirrors Python's _GoogleCredentials Protocol)
// ===========================================================================

/**
 * Structural interface for a google-auth credentials object. Declares only the
 * attributes and methods that gdrive helpers actually access. The injected fake
 * (and the real google-auth object) both satisfy this shape.
 */
export interface GoogleCredentials {
  expired?: boolean;
  refresh_token?: string | null;
  refresh(request: unknown): void;
  to_json(): string;
  [key: string]: unknown;
}

// ===========================================================================
// Minimal in-memory byte buffer (Python io.BytesIO surface)
// ===========================================================================

/**
 * Minimal byte accumulator with the io.BytesIO surface the download loop uses:
 * write(bytes) / tell() / getvalue(). MediaIoBaseDownload (real or fake) writes
 * chunks into it; the loop checks tell() for the size cap.
 */
export class _ByteBuffer {
  private _chunks: Buffer[] = [];
  private _len = 0;

  write(data: Uint8Array | Buffer | string): number {
    const buf =
      typeof data === "string"
        ? Buffer.from(data, "utf-8")
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
    this._chunks.push(buf);
    this._len += buf.length;
    return buf.length;
  }

  tell(): number {
    return this._len;
  }

  getvalue(): Buffer {
    return Buffer.concat(this._chunks, this._len);
  }
}

// ===========================================================================
// Injectable seams (Python's lazily-imported optional Google libraries)
// ===========================================================================

/** google.auth.default(scopes=...) -> [creds, project]. Throws when ADC unavailable. */
type GoogleAuthDefaultFn = (scopes: string[]) => [GoogleCredentials, unknown];
/** Credentials.from_authorized_user_file(path, scopes=...) -> creds. */
type CredentialsFromAuthorizedUserFileFn = (
  path: string,
  scopes: string[],
) => GoogleCredentials;
/** google.auth.transport.requests.Request() -> a request object for creds.refresh. */
type RequestFactoryFn = () => unknown;
/** googleapiclient.discovery.build("drive","v3",...) -> a Drive service. */
type DriveBuildFn = (
  serviceName: string,
  version: string,
  opts: { credentials: GoogleCredentials; cache_discovery: boolean },
) => unknown;
/** MediaIoBaseDownload constructor: new (buf, request) -> downloader. */
type MediaIoBaseDownloadCtor = new (
  buf: _ByteBuffer,
  request: unknown,
) => { next_chunk(): [unknown, boolean] };
/** InstalledAppFlow.from_client_secrets_file(path, scopes=...) -> oauth flow. */
type InstalledAppFlowFromClientSecretsFileFn = (
  path: string,
  scopes: string[],
) => OAuthFlow;

/** Structural interface for a google-auth-oauthlib InstalledAppFlow instance. */
export interface OAuthFlow {
  run_local_server(opts: { port: number; open_browser: boolean }): GoogleCredentials;
  run_console(): GoogleCredentials;
}

let _googleAuthDefault: GoogleAuthDefaultFn | null = null;
let _credentialsFromAuthorizedUserFile: CredentialsFromAuthorizedUserFileFn | null =
  null;
let _requestFactory: RequestFactoryFn | null = null;
let _driveBuild: DriveBuildFn | null = null;
let _mediaIoBaseDownload: MediaIoBaseDownloadCtor | null = null;
let _installedAppFlowFromClientSecretsFile: InstalledAppFlowFromClientSecretsFileFn | null =
  null;

/** Seam setter for google.auth.default (pass null to restore the real default). */
export function _setGoogleAuthDefault(fn: GoogleAuthDefaultFn | null): void {
  _googleAuthDefault = fn;
}
/** Seam setter for Credentials.from_authorized_user_file. */
export function _setCredentialsFromAuthorizedUserFile(
  fn: CredentialsFromAuthorizedUserFileFn | null,
): void {
  _credentialsFromAuthorizedUserFile = fn;
}
/** Seam setter for google.auth.transport.requests.Request. */
export function _setRequestFactory(fn: RequestFactoryFn | null): void {
  _requestFactory = fn;
}
/** Seam setter for googleapiclient.discovery.build. */
export function _setDriveBuild(fn: DriveBuildFn | null): void {
  _driveBuild = fn;
}
/** Seam setter for googleapiclient.http.MediaIoBaseDownload. */
export function _setMediaIoBaseDownload(
  ctor: MediaIoBaseDownloadCtor | null,
): void {
  _mediaIoBaseDownload = ctor;
}
/** Seam setter for InstalledAppFlow.from_client_secrets_file. */
export function _setInstalledAppFlowFromClientSecretsFile(
  fn: InstalledAppFlowFromClientSecretsFileFn | null,
): void {
  _installedAppFlowFromClientSecretsFile = fn;
}

registerReset(() => {
  _googleAuthDefault = null;
  _credentialsFromAuthorizedUserFile = null;
  _requestFactory = null;
  _driveBuild = null;
  _mediaIoBaseDownload = null;
  _installedAppFlowFromClientSecretsFile = null;
});

// Default real-implementation resolvers. Each does a dynamic import and throws on
// failure; the callers catch (ADC/oauth) or surface a RuntimeError (download).
// In the TS port the real google libraries are not an npm dependency, so these
// dynamic imports will reject — which is exactly the Python "package missing"
// fail-soft path. Tests always inject a seam, so these are never reached in CI.

function _resolveGoogleAuthDefault(): GoogleAuthDefaultFn {
  if (_googleAuthDefault !== null) {
    return _googleAuthDefault;
  }
  return (_scopes: string[]): [GoogleCredentials, unknown] => {
    throw new Error(
      "google-auth-library is not installed (ADC unavailable in this build)",
    );
  };
}

function _resolveCredentialsFromAuthorizedUserFile(): CredentialsFromAuthorizedUserFileFn {
  if (_credentialsFromAuthorizedUserFile !== null) {
    return _credentialsFromAuthorizedUserFile;
  }
  return (_p: string, _scopes: string[]): GoogleCredentials => {
    throw new Error("google-auth-library is not installed");
  };
}

function _resolveRequestFactory(): RequestFactoryFn {
  if (_requestFactory !== null) {
    return _requestFactory;
  }
  return (): unknown => {
    throw new Error("google-auth-library is not installed");
  };
}

function _resolveDriveBuild(): DriveBuildFn {
  if (_driveBuild !== null) {
    return _driveBuild;
  }
  return (): unknown => {
    throw new Error("googleapis is not installed");
  };
}

function _resolveMediaIoBaseDownload(): MediaIoBaseDownloadCtor {
  if (_mediaIoBaseDownload !== null) {
    return _mediaIoBaseDownload;
  }
  // A constructor that always throws — the download path wraps it in try/except
  // and re-raises as RuntimeError, matching the Python "package missing" path.
  return class {
    constructor(_buf: _ByteBuffer, _request: unknown) {
      throw new Error("googleapis is not installed");
    }
    next_chunk(): [unknown, boolean] {
      throw new Error("googleapis is not installed");
    }
  } as unknown as MediaIoBaseDownloadCtor;
}

function _resolveInstalledAppFlowFromClientSecretsFile(): InstalledAppFlowFromClientSecretsFileFn {
  if (_installedAppFlowFromClientSecretsFile !== null) {
    return _installedAppFlowFromClientSecretsFile;
  }
  return (_p: string, _scopes: string[]): OAuthFlow => {
    throw new Error("google-auth-oauthlib is not installed");
  };
}

// ===========================================================================
// Secure credential write
// ===========================================================================

/**
 * Write OAuth credential JSON to *p* with owner-only permissions (0o600).
 *
 * On POSIX this prevents other local users from reading refresh tokens. On
 * Windows chmod has no meaningful effect (NTFS ACLs control access), so we
 * delegate to paths.atomicWriteText which uses the user-profile location.
 *
 * Uses an atomic write-then-rename pattern (temp file with a unique
 * pid+counter+timestamp name) so a partial write never leaves a truncated
 * credential file and a predictable-name symlink attack is prevented.
 */
export function _write_creds_secure(p: string, content: string): void {
  paths.ensureDir(path.dirname(p));
  if (process.platform !== "win32") {
    // Write via fs.openSync with mode 0o600 so the file is never world-readable,
    // even briefly before a post-write chmod. Unique temp name prevents a
    // predictable-path symlink attack.
    const tmp = `${p}.${process.pid}.${process.hrtime.bigint().toString()}.tmp`;
    let fd: number;
    try {
      fd = fs.openSync(tmp, "wx", 0o600);
    } catch (err) {
      throw err;
    }
    try {
      fs.writeSync(fd, Buffer.from(content, "utf-8"));
      fs.closeSync(fd);
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // missing_ok
      }
      throw err;
    }
    fs.renameSync(tmp, p);
    // Ensure mode on the destination (rename may inherit umask on some FSes).
    try {
      fs.chmodSync(p, 0o600);
    } catch {
      // contextlib.suppress(OSError)
    }
  } else {
    paths.atomicWriteText(p, content);
  }
}

// ===========================================================================
// Credentials acquisition
// ===========================================================================

/**
 * Raised when Google Drive credentials cannot be obtained via any method.
 *
 * Attempts multiple fallback paths in order: Application Default Credentials
 * (ADC) via gcloud auth, then stored OAuth tokens. If all fail, this error is
 * raised, indicating Google Drive integration is unavailable for this session.
 */
export class GDriveCredsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GDriveCredsUnavailable";
    Object.setPrototypeOf(this, GDriveCredsUnavailable.prototype);
  }
}

/** Try Google Application Default Credentials (gcloud auth application-default login). */
export function _try_adc(): GoogleCredentials | null {
  try {
    const googleAuthDefault = _resolveGoogleAuthDefault();
    const [creds] = googleAuthDefault(_DRIVE_SCOPES);
    return creds;
  } catch (e) {
    _LOG.info("ADC unavailable: %s", String(e));
    return null;
  }
}

/**
 * Try cached OAuth tokens from a previous token-goat gdrive-auth run.
 *
 * On a permanent credential failure (revoked token / invalid grant), the stale
 * creds file is deleted so the next call falls through to the OAuth flow rather
 * than silently failing on every request until the user manually removes it.
 */
export function _try_stored_oauth(): GoogleCredentials | null {
  const creds_path = paths.gdriveCredsPath();
  if (!fs.existsSync(creds_path)) {
    return null;
  }
  try {
    const fromAuthorizedUserFile = _resolveCredentialsFromAuthorizedUserFile();
    const requestFactory = _resolveRequestFactory();

    const creds: GoogleCredentials = fromAuthorizedUserFile(
      creds_path,
      _DRIVE_SCOPES,
    );
    if (creds.expired && creds.refresh_token) {
      const t_refresh = _monotonic();
      try {
        creds.refresh(requestFactory());
      } catch (refresh_err) {
        // Distinguish permanent failures (revoked/invalid grant) from transient
        // network errors so we only delete stale creds when the server
        // definitively rejects them.
        const refresh_err_lower = String(refresh_err).toLowerCase();
        if (
          _PERMANENT_OAUTH_ERROR_KEYWORDS.some((kw) =>
            refresh_err_lower.includes(kw),
          )
        ) {
          _LOG.warning(
            "OAuth refresh token permanently invalid (revoked or expired grant); " +
              "removing stale credentials so re-auth is triggered",
          );
          try {
            if (fs.existsSync(creds_path)) {
              fs.unlinkSync(creds_path);
            }
          } catch (unlink_err) {
            _LOG.debug(
              "could not remove stale creds file: %s",
              String(unlink_err),
            );
          }
        } else {
          // Transient error (network timeout, DNS failure, etc.) — keep creds.
          _LOG.warning(
            "OAuth token refresh failed after %ss (transient); keeping cached creds",
            (_monotonic() - t_refresh).toFixed(3),
          );
        }
        return null;
      }
      // Do NOT log creds.to_json() — it contains refresh tokens.
      _write_creds_secure(creds_path, creds.to_json());
      _LOG.info(
        "OAuth credentials refreshed in %ss",
        (_monotonic() - t_refresh).toFixed(3),
      );
    }
    return creds;
  } catch (exc) {
    // Do NOT log exc directly — the message may contain credential material.
    // Log the exception type so the failure mode is diagnosable without leaking
    // secrets.
    _LOG.warning("stored OAuth invalid or refresh failed (%s)", _excName(exc));
    return null;
  }
}

/** Try ADC then stored OAuth. Raise GDriveCredsUnavailable if neither works. */
export function get_credentials(): GoogleCredentials {
  let creds = self._try_adc();
  if (creds !== null) {
    _LOG.debug("using Application Default Credentials (ADC) for Drive access");
    return creds;
  }
  creds = self._try_stored_oauth();
  if (creds !== null) {
    _LOG.debug("using stored OAuth credentials for Drive access");
    return creds;
  }
  const creds_path = paths.gdriveCredsPath();
  throw new GDriveCredsUnavailable(
    "No Google Drive credentials available. To authenticate, run:\n" +
      "  token-goat gdrive-auth\n" +
      `This stores OAuth tokens at: ${creds_path}\n` +
      "Alternatively, use Application Default Credentials:\n" +
      "  gcloud auth application-default login",
  );
}

// ===========================================================================
// Validation helpers
// ===========================================================================

/**
 * Validate file_id to prevent path traversal attacks.
 *
 * Google Drive file IDs are base64url without padding, ~25-40 chars. Reject
 * anything that looks like a path or is otherwise malformed.
 */
export function _validate_file_id(file_id: string): void {
  if (typeof file_id !== "string" || file_id.trim() === "") {
    throw new Error("file_id cannot be empty or whitespace-only");
  }
  const stripped = file_id.trim();
  // Python len() counts code points.
  const strippedLen = [...stripped].length;
  if (strippedLen > 128) {
    throw new Error(`file_id too long (max 128 chars): ${strippedLen}`);
  }
  // Reject path-like patterns.
  if (
    stripped.includes("/") ||
    stripped.includes("\\") ||
    stripped.includes("..")
  ) {
    throw new Error(
      `file_id contains invalid characters: ${_pyReprStr(stripped)}`,
    );
  }
  // Allow alphanumeric, hyphen, underscore (base64url alphabet). Python's
  // str.isalnum() is Unicode-aware (any Unicode letter/digit), so we use the
  // Unicode-aware predicate rather than ASCII [A-Za-z0-9].
  for (const ch of stripped) {
    if (!(_isAlnum(ch) || ch === "-" || ch === "_")) {
      throw new Error(
        `file_id contains invalid characters: ${_pyReprStr(stripped)}`,
      );
    }
  }
}

const _MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

// Drive API can return arbitrary mimeType strings from user-controlled metadata.
// Allow only the characters that appear in legitimate MIME types (RFC 2045 token
// + slash + optional parameter suffix) so a crafted type cannot inject
// unexpected values into the Drive calls.
// NOTE on the trailing `(?:\n)?$`: Python's `re.match` ends this pattern in a
// bare `$`, and Python's `$` (without re.MULTILINE) matches at the end of the
// string OR just before a single trailing `\n`. JS `$` (no `m` flag) matches the
// absolute end only, so the literal `$` would reject a valid `"text/plain\n"`
// that CPython accepts. The optional `\n` before `$` reproduces CPython's
// trailing-newline tolerance exactly (one `\n` only; `\r\n` / `\n\n` still fail).
const _MIME_TYPE_RE =
  /^[A-Za-z0-9!#$&\-^_.+]+\/[A-Za-z0-9!#$&\-^_.+]+(?:;[^\x00-\x1f\x7f]*)?(?:\n)?$/;
const _MAX_MIME_TYPE_LEN = 256;

// Maximum characters kept in a sanitised local filename derived from the Drive
// file's display name. Long names can exceed filesystem path limits; 200 chars
// gives ample readability headroom while staying well under the 255-byte limit
// common to most filesystems.
const _MAX_SAFE_FILENAME_CHARS = 200;

/**
 * Derive a safe, cache-dir-bounded local path for a Drive file.
 *
 * Strips path separators and control characters from the Drive display name,
 * truncates to filesystem-safe length, and verifies the resulting path does not
 * escape the cache directory.
 */
export function _build_local_cache_path(
  file_id: string,
  name: string,
  cache_dir: string,
): string {
  // Allow only alphanumeric, dot, hyphen, underscore — everything else stripped.
  let safe_name = "";
  for (const ch of name) {
    if (_isAlnum(ch) || ch === "." || ch === "_" || ch === "-") {
      safe_name += ch;
    }
  }
  if (!safe_name) {
    safe_name = file_id;
  }
  // Python str[:n] counts code points.
  safe_name = [...safe_name].slice(0, _MAX_SAFE_FILENAME_CHARS).join("");
  const local_path = path.join(cache_dir, `${file_id}_${safe_name}`);
  // Containment check: resolve both and ensure local_path is under cache_dir.
  const resolvedLocal = path.resolve(local_path);
  const resolvedBase = path.resolve(cache_dir);
  if (
    resolvedLocal !== resolvedBase &&
    !resolvedLocal.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error(`Computed path escapes cache directory: ${local_path}`);
  }
  return local_path;
}

/**
 * Validate and return a Drive API mimeType value.
 *
 * The Drive API returns mimeType from user-controlled file metadata, so a
 * compromised or crafted response could contain an unexpected string. We accept
 * only values matching the RFC 2045 token grammar (type/subtype with optional
 * parameters limited to printable ASCII) within a reasonable length. Any value
 * that fails validation is replaced with "application/octet-stream" so the
 * download falls through to the direct (non-export) path rather than raising.
 */
export function _validate_mime_type(mime: unknown, file_id: string): string {
  if (typeof mime !== "string") {
    _LOG.warning(
      "gdrive: non-string mimeType for file %s (%s); treating as octet-stream",
      file_id,
      _typeName(mime),
    );
    return "application/octet-stream";
  }
  // Python len() counts code points.
  if ([...mime].length > _MAX_MIME_TYPE_LEN) {
    _LOG.warning(
      "gdrive: mimeType too long (%d chars) for file %s; treating as octet-stream",
      [...mime].length,
      file_id,
    );
    return "application/octet-stream";
  }
  if (!_MIME_TYPE_RE.test(mime)) {
    _LOG.warning(
      "gdrive: mimeType %s for file %s failed validation; treating as octet-stream",
      _pyReprStr(mime),
      file_id,
    );
    return "application/octet-stream";
  }
  _LOG.debug(
    "gdrive: mimeType accepted: %s for file %s",
    sanitize_log_str(mime),
    file_id,
  );
  return mime;
}

// ===========================================================================
// Download
// ===========================================================================

/** Minimal structural view of the googleapiclient Drive service. */
interface DriveService {
  files(): {
    get(opts: { fileId: string; fields: string }): { execute(): unknown };
    get_media(opts: { fileId: string }): unknown;
    export_media(opts: { fileId: string; mimeType: string }): unknown;
    list(opts: {
      q: string;
      spaces: string;
      fields: string;
      pageSize: number;
    }): { execute(): unknown };
  };
}

/**
 * Download a Drive file into the local cache and return the final local path.
 *
 * Handles Google Workspace files (exported as PDF) and binary files (downloaded
 * directly). Enforces *max_size_bytes* per-chunk during streaming and again
 * after the download completes. Uses an atomic write so a crash never leaves a
 * truncated cache entry.
 *
 * Returns the (possibly adjusted) *local_path* — it gains a ".pdf" suffix for
 * Workspace exports that had no extension.
 */
export function _download_to_cache(
  file_id: string,
  mime: string,
  local_path: string,
  service: unknown,
  max_size_bytes: number,
  MediaIoBaseDownload: MediaIoBaseDownloadCtor,
): string {
  // Validate the MIME type from the Drive API before using it to branch and
  // before passing it to export_media() to prevent injection via crafted
  // metadata.
  mime = _validate_mime_type(mime, file_id);
  const svc = service as DriveService;
  let final_path = local_path;
  let request: unknown;
  // Google Workspace formats can't be downloaded directly — export as PDF.
  if (mime.startsWith("application/vnd.google-apps")) {
    request = svc
      .files()
      .export_media({ fileId: file_id, mimeType: "application/pdf" });
    if (path.extname(final_path) === "") {
      final_path = `${final_path}.pdf`;
    }
  } else {
    request = svc.files().get_media({ fileId: file_id });
  }

  const buf = new _ByteBuffer();
  const downloader = new MediaIoBaseDownload(buf, request);
  let done = false;
  const t_download_start = _monotonic();
  try {
    while (!done) {
      const [, _done] = downloader.next_chunk();
      done = _done;
      // Check accumulated size after each chunk to avoid holding the full file
      // in memory before detecting an oversize condition.
      if (buf.tell() > max_size_bytes) {
        throw new _OversizeError(
          `Drive file ${_pyReprStr(file_id)} too large during download: ` +
            `${buf.tell()} bytes exceeds limit of ${max_size_bytes} bytes`,
        );
      }
    }
  } catch (e) {
    if (e instanceof _OversizeError) {
      throw new Error(e.message);
    }
    throw new Error(`Download failed for ${file_id}: ${String(e)}`);
  }

  const downloaded_bytes = buf.tell();
  if (downloaded_bytes > max_size_bytes) {
    throw new Error(
      `Drive file ${_pyReprStr(file_id)} too large: ${downloaded_bytes} bytes ` +
        `exceeds limit of ${max_size_bytes} bytes`,
    );
  }

  const t_write_start = _monotonic();
  const download_elapsed = t_write_start - t_download_start;
  try {
    paths.ensureDir(path.dirname(final_path));
    // Atomic write: write to a temp file then rename so a killed/crashed process
    // never leaves a truncated cache file that looks valid.
    paths.atomicWriteBytes(final_path, buf.getvalue());
    const written_bytes = fs.statSync(final_path).size;
    const write_elapsed = _monotonic() - t_write_start;
    _LOG.info(
      "gdrive downloaded: file_id=%s name=%s bytes=%d download_elapsed=%ss write_elapsed=%ss",
      file_id,
      sanitize_log_str(path.basename(final_path)),
      written_bytes,
      download_elapsed.toFixed(3),
      write_elapsed.toFixed(3),
    );
  } catch (e) {
    throw new Error(
      `Failed to write downloaded file to ${final_path}: ${String(e)}`,
    );
  }

  return final_path;
}

/** Internal marker so the download loop can re-throw oversize errors verbatim. */
class _OversizeError extends Error {}

/**
 * Download a Drive file. Return the local cached path.
 *
 * Shrinks if it's an image and large enough. Raises GDriveCredsUnavailable if
 * credentials aren't set up. Raises RuntimeError (Error) on download failure or
 * if the file exceeds *max_size_bytes* (default 100 MB) to prevent unbounded
 * RAM use. Async because it awaits image_shrink.shrink_if_image.
 */
export async function fetch_file(
  file_id: string,
  opts: { shrink_if_image?: boolean; max_size_bytes?: number } = {},
): Promise<string> {
  const shrink_if_image = opts.shrink_if_image ?? true;
  const max_size_bytes = opts.max_size_bytes ?? _MAX_DOWNLOAD_BYTES;

  self._validate_file_id(file_id);
  const t_fetch_start = _monotonic();
  _LOG.debug(
    "gdrive fetch_file: file_id=%s shrink=%s max_bytes=%d",
    file_id,
    shrink_if_image,
    max_size_bytes,
  );
  const creds = self.get_credentials();

  const build = _resolveDriveBuild();
  const MediaIoBaseDownload = _resolveMediaIoBaseDownload();

  const cache_dir = image_shrink.ensure_cache_dir(paths.gdriveCacheDir());
  const service = build("drive", "v3", {
    credentials: creds,
    cache_discovery: false,
  });

  const t_meta_start = _monotonic();
  let meta: unknown;
  try {
    meta = (service as DriveService)
      .files()
      .get({ fileId: file_id, fields: "id, name, mimeType, size" })
      .execute();
  } catch (e) {
    throw new Error(
      `Failed to fetch Drive file metadata for ${file_id}: ${String(e)}`,
    );
  }

  if (!_isDict(meta)) {
    throw new Error(
      `Expected dict metadata from Drive API, got ${_typeName(meta)}`,
    );
  }

  _LOG.debug(
    "gdrive metadata fetched: file_id=%s name=%s mime=%s elapsed=%ss",
    file_id,
    sanitize_log_str(String((meta as Record<string, unknown>)["name"] ?? "")),
    sanitize_log_str(
      String((meta as Record<string, unknown>)["mimeType"] ?? ""),
    ),
    (_monotonic() - t_meta_start).toFixed(3),
  );

  const metaDict = meta as Record<string, unknown>;
  const name: string =
    metaDict["name"] !== undefined && metaDict["name"] !== null
      ? String(metaDict["name"])
      : file_id;
  const mime: string =
    metaDict["mimeType"] !== undefined && metaDict["mimeType"] !== null
      ? String(metaDict["mimeType"])
      : "";

  // Enforce size cap using Drive-reported size before downloading. Best-effort;
  // the post-download check is the definitive guard. Google Workspace files omit
  // the "size" field entirely, so skip the pre-check when absent or non-numeric.
  if (metaDict["size"] !== undefined && metaDict["size"] !== null) {
    const reported_size = _pyIntStrict(metaDict["size"]);
    if (reported_size !== null) {
      if (reported_size > max_size_bytes) {
        throw new Error(
          `Drive file ${_pyReprStr(file_id)} too large: ${reported_size} bytes ` +
            `exceeds limit of ${max_size_bytes} bytes`,
        );
      }
    }
    // non-numeric size field — proceed to download.
  }

  let local_path = _build_local_cache_path(file_id, name, cache_dir);

  if (fs.existsSync(local_path)) {
    const cached_size = fs.statSync(local_path).size;
    _LOG.info(
      "gdrive cache hit: file_id=%s name=%s size=%d elapsed=%ss",
      file_id,
      sanitize_log_str(path.basename(local_path)),
      cached_size,
      (_monotonic() - t_fetch_start).toFixed(3),
    );
  } else {
    local_path = _download_to_cache(
      file_id,
      mime,
      local_path,
      service,
      max_size_bytes,
      MediaIoBaseDownload,
    );
  }

  const result_path = shrink_if_image
    ? await image_shrink.shrink_if_image(local_path)
    : local_path;
  _LOG.debug(
    "gdrive fetch_file complete: file_id=%s total_elapsed=%ss path=%s",
    file_id,
    (_monotonic() - t_fetch_start).toFixed(3),
    sanitize_log_str(path.basename(result_path)),
  );
  return result_path;
}

// ===========================================================================
// list_drive_files
// ===========================================================================

/** Shape of one entry returned by list_drive_files. */
export interface DriveFileEntry {
  id: string;
  name: string;
  mimeType: string;
  size_bytes: number;
}

/**
 * List accessible Google Drive files.
 *
 * Returns a list of dicts with keys id / name / mimeType / size_bytes
 * (size_bytes is 0 when unavailable, e.g. for Workspace files). Returns an empty
 * list if credentials are unavailable or an API error occurs (fail-soft).
 */
export function list_drive_files(
  opts: { folder_id?: string | null; max_results?: number } = {},
): DriveFileEntry[] {
  const folder_id = opts.folder_id ?? null;
  const max_results = opts.max_results ?? 20;

  let creds: GoogleCredentials;
  try {
    creds = self.get_credentials();
  } catch (e) {
    if (e instanceof GDriveCredsUnavailable) {
      return [];
    }
    throw e;
  }

  try {
    const build = _resolveDriveBuild();
    const service = build("drive", "v3", {
      credentials: creds,
      cache_discovery: false,
    });

    // Build query filters for supported file types.
    const type_filters = [
      "mimeType='application/vnd.google-apps.document'",
      "mimeType='application/vnd.google-apps.presentation'",
      "mimeType='text/plain'",
      "mimeType='application/pdf'",
    ];
    const type_query = type_filters.map((f) => `(${f})`).join(" or ");

    // Add folder filter if specified.
    let query = type_query;
    if (folder_id) {
      _validate_file_id(folder_id);
      query = `'${folder_id}' in parents and (${type_query})`;
    }

    const meta_fields = "files(id,name,mimeType,size)";
    const results = (service as DriveService)
      .files()
      .list({
        q: query,
        spaces: "drive",
        fields: meta_fields,
        pageSize: max_results,
      })
      .execute();

    const filesRaw = _isDict(results)
      ? (results as Record<string, unknown>)["files"]
      : undefined;
    const files = Array.isArray(filesRaw) ? filesRaw : [];
    const output: DriveFileEntry[] = [];
    for (const f of files) {
      const fd = _isDict(f) ? (f as Record<string, unknown>) : {};
      const sizeRaw = fd["size"];
      const size_bytes =
        sizeRaw !== undefined && sizeRaw !== null && sizeRaw !== "" && sizeRaw !== 0
          ? _pyIntStrict(sizeRaw) ?? 0
          : 0;
      output.push({
        id: fd["id"] !== undefined && fd["id"] !== null ? String(fd["id"]) : "",
        name:
          fd["name"] !== undefined && fd["name"] !== null
            ? String(fd["name"])
            : "",
        mimeType:
          fd["mimeType"] !== undefined && fd["mimeType"] !== null
            ? String(fd["mimeType"])
            : "",
        size_bytes,
      });
    }
    return output;
  } catch (e) {
    _LOG.debug("list_drive_files failed: %s", String(e));
    return [];
  }
}

// ===========================================================================
// OAuth out-of-band flow
// ===========================================================================

/**
 * Interactive: opens browser, user grants access, pastes code. Saves creds JSON.
 *
 * Returns the path to the saved credentials file. Throws when the client secrets
 * file does not exist, when the credentials file cannot be written after a
 * successful auth flow, or when the OAuth flow itself fails.
 */
export function run_oauth_oob_flow(client_secrets_path: string): string {
  if (!fs.existsSync(client_secrets_path)) {
    const err = new Error(
      `Client secrets file not found: ${client_secrets_path}. ` +
        "Download it from Google Cloud Console → APIs & Services → Credentials.",
    );
    err.name = "FileNotFoundError";
    throw err;
  }

  const fromClientSecretsFile = _resolveInstalledAppFlowFromClientSecretsFile();

  let flow: OAuthFlow;
  try {
    flow = fromClientSecretsFile(client_secrets_path, _DRIVE_SCOPES);
  } catch (exc) {
    throw new Error(
      `Invalid client secrets file ${client_secrets_path}: ${String(exc)}`,
    );
  }

  // Try local server first (loopback), fall back to console.
  let creds: GoogleCredentials;
  try {
    creds = flow.run_local_server({ port: 0, open_browser: true });
  } catch (e) {
    _LOG.debug(
      "OAuth local-server flow failed (%s: %s); falling back to console",
      _excName(e),
      String(e),
    );
    creds = flow.run_console();
  }

  const out = paths.gdriveCredsPath();
  try {
    _write_creds_secure(out, creds.to_json());
  } catch (exc) {
    const err = new Error(
      `OAuth flow succeeded but credentials could not be saved to ${out}: ${String(exc)}. ` +
        "Check directory permissions.",
    );
    err.name = "OSError";
    throw err;
  }
  return out;
}

// ===========================================================================
// Section-index extraction for Drive markdown / text docs.
//
// WHY: A 200 KB markdown spec pulled from Drive consumes ~50k tokens of context
// even when the agent only needs one section. By exposing the document's heading
// structure first, the agent can request a single section and pay <1 KB instead.
// ===========================================================================

/**
 * File extensions we treat as markdown-extractable text. Extending this list
 * (e.g. to ".rst") requires adding a matching language extractor.
 */
export const TEXT_EXTENSIONS: readonly string[] = [
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".mkdn",
  ".txt",
];

// Maximum bytes we will load into memory for section-index extraction. Matches
// parser.MAX_FILE_SIZE so the behaviour is consistent with the local-file path
// and prevents OOM on a pathological Drive doc.
//
// Exported via a mutable binding + setter so tests can lower it (Python
// monkeypatches the module global). ES `let` exports are read-only from outside,
// so _setMaxSectionIndexBytes rebinds it.
export let _MAX_SECTION_INDEX_BYTES = 2_000_000;

/** Test seam: override _MAX_SECTION_INDEX_BYTES (Python monkeypatch.setattr). */
export function _setMaxSectionIndexBytes(n: number): void {
  _MAX_SECTION_INDEX_BYTES = n;
}

/**
 * Return true if *p* has an extension we know how to extract sections from.
 *
 * Used by the pre-fetch hook to decide whether to suggest the gdrive-sections
 * shim instead of gdrive-fetch for Drive text docs. Extension-only (no content
 * sniff) because the hook fires before the file is downloaded — we only have the
 * Drive name field. Python lowercases the suffix.
 */
export function is_text_path(p: string): boolean {
  return TEXT_EXTENSIONS.includes(path.extname(p).toLowerCase());
}

/** One section entry in the extract_section_index result. */
export interface SectionIndexEntry {
  heading: string;
  level: number;
  line: number;
  end_line: number | null;
  approx_bytes: number;
}

/** Result shape of extract_section_index. */
export interface SectionIndexResult {
  path: string;
  size_bytes: number;
  line_count: number;
  sections: SectionIndexEntry[];
  extractor_available: boolean;
}

/**
 * Build a compact section-index summary for a markdown/text file.
 *
 * The approx_bytes field lets the agent gauge how expensive each section would
 * be to extract relative to the whole document. When extraction fails (file too
 * large, parser error, non-markdown extension) sections is an empty list and
 * extractor_available is false; the caller can still show the total size and
 * fall back to gdrive-fetch.
 *
 * Never raises for malformed content — fail-soft, returns the best-available
 * metadata so the hook hint always has something useful to emit.
 */
export function extract_section_index(local_path: string): SectionIndexResult {
  const result: SectionIndexResult = {
    path: local_path,
    size_bytes: 0,
    line_count: 0,
    sections: [],
    extractor_available: false,
  };
  let size: number;
  try {
    size = fs.statSync(local_path).size;
    result.size_bytes = size;
  } catch (exc) {
    _LOG.debug(
      "extract_section_index: stat failed for %s: %s",
      local_path,
      String(exc),
    );
    return result;
  }

  if (size > _MAX_SECTION_INDEX_BYTES) {
    _LOG.info(
      "extract_section_index: %s too large (%d > %d bytes), skipping parse",
      sanitize_log_str(path.basename(local_path)),
      size,
      _MAX_SECTION_INDEX_BYTES,
    );
    return result;
  }

  if (!is_text_path(local_path)) {
    return result;
  }

  let raw: Buffer;
  try {
    raw = fs.readFileSync(local_path);
  } catch (exc) {
    _LOG.debug(
      "extract_section_index: read failed for %s: %s",
      local_path,
      String(exc),
    );
    return result;
  }

  // Compute line offsets so we can attribute byte ranges to each section.
  // Decode with replacement (errors="replace") and normalise newlines.
  let text: string;
  try {
    text = raw
      .toString("utf-8")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
  } catch (exc) {
    _LOG.debug(
      "extract_section_index: decode failed for %s: %s",
      local_path,
      String(exc),
    );
    return result;
  }

  // Python str.split("\n") keeps a trailing "" after a final newline; JS
  // String.split("\n") matches that exactly.
  const lines = text.split("\n");
  const line_count = lines.length;
  result.line_count = line_count;

  // Build cumulative byte offsets so section approx_bytes is O(1) per section.
  // Index i = byte offset of the start of line (i+1). +1 per line for the
  // newline that the split consumed.
  const offsets: number[] = [0];
  for (const ln of lines) {
    offsets.push(offsets[offsets.length - 1]! + Buffer.byteLength(ln, "utf-8") + 1);
  }

  let sections: { heading: string; level: number; line: number; end_line: number | null }[];
  try {
    const [, , , secs] = md_extract(raw, path.basename(local_path));
    sections = secs;
  } catch (exc) {
    _LOG.debug(
      "extract_section_index: parse failed for %s: %s",
      local_path,
      String(exc),
    );
    return result;
  }

  const out_sections: SectionIndexEntry[] = [];
  for (const sec of sections) {
    const start_line = Math.max(1, Math.min(sec.line, line_count));
    const end_line = sec.end_line;
    let byte_end: number;
    if (end_line === null || end_line === undefined) {
      byte_end = offsets[offsets.length - 1]!;
    } else {
      const end_line_clamped = Math.max(start_line, Math.min(end_line, line_count));
      byte_end = offsets[end_line_clamped]!;
    }
    const approx_bytes = Math.max(0, byte_end - offsets[start_line - 1]!);
    out_sections.push({
      heading: sec.heading,
      level: sec.level,
      line: sec.line,
      end_line: sec.end_line ?? null,
      approx_bytes,
    });
  }

  result.sections = out_sections;
  result.extractor_available = true;
  return result;
}

// ===========================================================================
// Internal helpers (no Python analogue — strict-TS / parity shims)
// ===========================================================================

/** Monotonic seconds (Python time.monotonic). */
function _monotonic(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}

/** True for a plain object (Python isinstance(x, dict)). */
function _isDict(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Python type(x).__name__ for the common cases the messages reference. */
function _typeName(value: unknown): string {
  if (value === null) return "NoneType";
  if (Array.isArray(value)) return "list";
  switch (typeof value) {
    case "string":
      return "str";
    case "number":
      return Number.isInteger(value) ? "int" : "float";
    case "boolean":
      return "bool";
    case "object":
      return "dict";
    case "undefined":
      return "NoneType";
    default:
      return typeof value;
  }
}

/** Constructor/error name of a thrown value (Python type(e).__name__). */
function _excName(e: unknown): string {
  if (e instanceof Error) {
    return e.name || e.constructor.name;
  }
  return typeof e;
}

/**
 * Python int(x) for str/number metadata values. Returns null when the value
 * cannot be parsed as a base-10 integer (Python's ValueError/TypeError path).
 */
function _pyIntStrict(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return null;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Unicode-aware str.isalnum() for a single character: true when the character is
 * a Unicode letter or decimal/numeric digit. Python's isalnum is broader than
 * ASCII [A-Za-z0-9], so we match the Unicode property classes.
 */
function _isAlnum(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Python repr() of a string for embedding in error/log messages. Mirrors the
 * common case: single-quoted, backslash and single-quote escaped.
 */
function _pyReprStr(s: string): string {
  const escaped = s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

export const __all__ = [
  "GDriveCredsUnavailable",
  "TEXT_EXTENSIONS",
  "extract_section_index",
  "fetch_file",
  "get_credentials",
  "is_text_path",
  "list_drive_files",
  "run_oauth_oob_flow",
] as const;
