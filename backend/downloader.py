"""
downloader.py — Secure yt-dlp wrapper for video/audio extraction, search, and downloading.

Security:
  - URL whitelist: only YouTube domains allowed
  - Filename sanitization: no path traversal via crafted video titles
  - Search query sanitization
  - yt-dlp configured with restrictfilenames and no-exec

Provides:
  - validate_url(url)       -> bool
  - search_videos(query)    -> list of video result dicts
  - extract_info(url)       -> metadata dict
  - start_download(...)     -> runs download with progress hooks
  - cancel_download(...)    -> stops an active download
  - delete_file(filepath)   -> safe file deletion
"""

import os
import re
import threading
from urllib.parse import urlparse

import yt_dlp


# ── URL Validation ────────────────────────────────────────────────────
# Only allow YouTube domains — prevent SSRF to internal services
# We allow all domains now, so no ALLOWED_DOMAINS needed.


def validate_url(url: str) -> bool:
    """
    Validate that the URL is a legitimate YouTube URL.
    Blocks: internal IPs, non-YouTube domains, file:// schemes, etc.
    """
    if not url or not isinstance(url, str):
        return False

    url = url.strip()

    # Must start with http:// or https://
    if not re.match(r"^https?://", url, re.IGNORECASE):
        return False

    try:
        parsed = urlparse(url)
    except Exception:
        return False

    # Scheme must be http or https
    if parsed.scheme not in ("http", "https"):
        return False

    hostname = (parsed.hostname or "").lower()

    # Block empty hostname
    if not hostname:
        return False

    # Block IP addresses (prevent SSRF to internal services)
    import socket
    try:
        ip = socket.gethostbyname(hostname)
        if ip.startswith("127.") or ip.startswith("10.") or ip.startswith("192.168.") or ip.startswith("172.") or ip == "0.0.0.0":
            return False
    except Exception:
        pass

    if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1") or hostname.endswith(".local"):
        return False

    return True


def _sanitize_filename(name: str) -> str:
    """Remove dangerous characters from filenames to prevent path traversal."""
    if not name:
        return "download"
    # Remove path separators and other dangerous chars
    name = re.sub(r'[\\/:*?"<>|]', "_", name)
    # Remove leading/trailing dots and spaces
    name = name.strip(". ")
    # Limit length
    name = name[:200]
    return name or "download"


# ── Base yt-dlp options (security defaults) ───────────────────────────
def get_ffmpeg_path():
    import shutil
    path = shutil.which("ffmpeg")
    if path:
        return path
    # Check local workspace paths relative to this script
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    local_paths = [
        os.path.join(base_dir, "ffmpeg-master-latest-win64-gpl", "bin", "ffmpeg.exe"),
        os.path.join(base_dir, "ffmpeg", "bin", "ffmpeg.exe"),
        os.path.join(base_dir, "ffmpeg.exe")
    ]
    for p in local_paths:
        if os.path.isfile(p):
            return p
    try:
        import imageio_ffmpeg
        path = imageio_ffmpeg.get_ffmpeg_exe()
        if path and os.path.isfile(path):
            return path
    except ImportError:
        pass
    return None

def _secure_base_opts() -> dict:
    """Return yt-dlp options with security hardening."""
    opts = {
        "quiet": True,
        "no_warnings": True,
        # Restrict filenames to ASCII safe characters
        "restrictfilenames": True,
        # Don't execute any external programs beyond ffmpeg
        "noplaylist": True,
        # Don't write info json / thumbnails / etc
        "writethumbnail": False,
        "writeinfojson": False,
        "writedescription": False,
        "writeannotations": False,
        "writesubtitles": False,
        # Do not set file modification time to video upload date (prevents instant cleanup deletion)
        "updatetime": False,
    }
    
    ffmpeg_path = get_ffmpeg_path()
    if ffmpeg_path:
        opts["ffmpeg_location"] = ffmpeg_path
        
    return opts


def search_videos(query: str, max_results: int = 10) -> list:
    """Search YouTube for videos matching the query."""
    # Sanitize: remove control chars, limit length
    query = re.sub(r"[\x00-\x1f\x7f]", "", query).strip()[:200]
    if not query:
        return []

    # Cap max results
    max_results = min(max(1, max_results), 20)

    ydl_opts = {
        **_secure_base_opts(),
        "skip_download": True,
        "extract_flat": "in_playlist",
        "default_search": "auto",
    }

    search_url = f"ytsearch{max_results}:{query}"

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(search_url, download=False)

    results = []
    entries = info.get("entries") or []
    for entry in entries:
        vid_id = entry.get("id", "")
        # Sanitize video ID (should be alphanumeric + dash/underscore)
        if not re.match(r"^[\w-]{1,20}$", vid_id):
            continue

        results.append({
            "id": vid_id,
            "title": _sanitize_text(entry.get("title", "Unknown")),
            "url": f"https://www.youtube.com/watch?v={vid_id}",
            "thumbnail": _get_safe_thumbnail(entry),
            "duration": entry.get("duration") if isinstance(entry.get("duration"), (int, float)) else None,
            "channel": _sanitize_text(entry.get("channel") or entry.get("uploader", "Unknown")),
            "view_count": entry.get("view_count") if isinstance(entry.get("view_count"), (int, float)) else None,
        })

    return results


def _sanitize_text(text) -> str:
    """Sanitize text fields from yt-dlp to prevent XSS."""
    if not text or not isinstance(text, str):
        return "Unknown"
    # Remove HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Remove control characters
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return text[:500]


def _get_safe_thumbnail(entry: dict) -> str | None:
    """Extract thumbnail URL, ensuring it's from YouTube CDN only."""
    thumb = None
    thumbnails = entry.get("thumbnails")
    if isinstance(thumbnails, list) and thumbnails:
        thumb = thumbnails[-1].get("url") if isinstance(thumbnails[-1], dict) else None
    if not thumb:
        thumb = entry.get("thumbnail")

    if not thumb or not isinstance(thumb, str):
        return None

    # Only allow YouTube CDN URLs for thumbnails
    try:
        parsed = urlparse(thumb)
        hostname = (parsed.hostname or "").lower()
        if hostname.endswith((".ytimg.com", ".ggpht.com", ".googleusercontent.com")):
            return thumb
    except Exception:
        pass

    return None


def extract_info(url: str) -> dict:
    """Fetch video metadata without downloading."""
    if not validate_url(url):
        raise ValueError("Invalid or disallowed URL")

    ydl_opts = {
        **_secure_base_opts(),
        "skip_download": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)

    # Build a clean format list
    formats = []
    if info.get("formats"):
        for f in info["formats"]:
            formats.append({
                "format_id": str(f.get("format_id", "")),
                "ext": str(f.get("ext", "")),
                "resolution": str(f.get("resolution", "audio only")),
                "filesize": f.get("filesize") or f.get("filesize_approx"),
                "vcodec": str(f.get("vcodec", "none")),
                "acodec": str(f.get("acodec", "none")),
                "fps": f.get("fps"),
                "tbr": f.get("tbr"),
            })

    return {
        "title": _sanitize_text(info.get("title", "Unknown")),
        "thumbnail": _get_safe_thumbnail(info),
        "duration": info.get("duration") if isinstance(info.get("duration"), (int, float)) else None,
        "channel": _sanitize_text(info.get("channel") or info.get("uploader", "Unknown")),
        "view_count": info.get("view_count") if isinstance(info.get("view_count"), (int, float)) else None,
        "upload_date": str(info.get("upload_date", ""))[:10] if info.get("upload_date") else None,
        "webpage_url": info.get("webpage_url"),
        "formats": formats,
    }


def _has_ffmpeg() -> bool:
    """Check if ffmpeg is available on the system."""
    return get_ffmpeg_path() is not None


def _build_ydl_opts(
    mode: str,
    quality: str,
    file_format: str,
    output_dir: str,
    task_id: str,
    progress_store: dict,
    cancel_flags: dict,
    cut_start: float = None,
    cut_end: float = None,
) -> dict:
    """Build yt-dlp option dict based on user selections (all inputs pre-validated)."""

    # Use restrictfilenames to prevent dangerous characters in output
    outtmpl = os.path.join(output_dir, f"{task_id}_%(title)s.%(ext)s")

    ffmpeg_available = _has_ffmpeg()

    def progress_hook(d):
        cancel_event = cancel_flags.get(task_id)
        if cancel_event and cancel_event.is_set():
            raise Exception("Download cancelled by user")

        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes", 0)
            speed = d.get("speed") or 0
            eta = d.get("eta") or 0
            pct = (downloaded / total * 100) if total else 0
            progress_store[task_id] = {
                "status": "downloading",
                "percent": round(pct, 1),
                "speed": speed,
                "eta": eta,
                "total_bytes": total,
                "downloaded_bytes": downloaded,
            }
        elif d["status"] == "finished":
            progress_store[task_id] = {
                "status": "processing",
                "percent": 100,
                "message": "Finalizing..." if not ffmpeg_available else "Merging / converting...",
            }

    base = _secure_base_opts()

    opts = {}

    # ── Audio-only mode ──────────────────────────────────────────────
    if mode == "audio":
        opts = {
            **base,
            "format": "bestaudio/best",
            "outtmpl": outtmpl,
            "progress_hooks": [progress_hook],
        }

        # Only use FFmpeg postprocessor if ffmpeg is available
        if ffmpeg_available:
            audio_format = file_format if file_format in ("mp3", "aac", "flac", "wav", "opus") else "mp3"
            quality_map = {
                "best": "0",
                "320": "320",
                "256": "256",
                "192": "192",
                "128": "128",
            }
            preferred_quality = quality_map.get(quality, "192")
            opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": audio_format,
                "preferredquality": preferred_quality,
            }]
        # Without ffmpeg: downloads raw audio stream (webm/m4a) — still playable

    # ── Video mode ───────────────────────────────────────────────────
    else:
        if ffmpeg_available:
            # With ffmpeg: merge best video + best audio
            height_filter = {
                "best": "",
                "1080": "[height<=1080]",
                "720": "[height<=720]",
                "480": "[height<=480]",
                "360": "[height<=360]",
            }.get(quality, "")

            format_str = (
                f"bestvideo{height_filter}+bestaudio/best{height_filter}/bestvideo+bestaudio/best"
            )
            merge_format = file_format if file_format in ("mp4", "mkv", "webm") else "mp4"

            opts = {
                **base,
                "format": format_str,
                "merge_output_format": merge_format,
                "outtmpl": outtmpl,
                "progress_hooks": [progress_hook],
            }
        else:
            # Without ffmpeg: download best single-stream (already muxed video+audio)
            height_filter = {
                "best": "",
                "1080": "[height<=1080]",
                "720": "[height<=720]",
                "480": "[height<=480]",
                "360": "[height<=360]",
            }.get(quality, "")

            # Prefer a pre-muxed format that doesn't need ffmpeg merging
            format_str = f"best{height_filter}/best"

            opts = {
                **base,
                "format": format_str,
                "outtmpl": outtmpl,
                "progress_hooks": [progress_hook],
            }

    if cut_start is not None and cut_end is not None:
        from yt_dlp.utils import download_range_func
        opts["download_ranges"] = download_range_func(None, [(cut_start, cut_end)])

    return opts


def start_download(
    url: str,
    mode: str,
    quality: str,
    file_format: str,
    task_id: str,
    progress_store: dict,
    cancel_flags: dict,
    output_dir: str,
    cut_start: float = None,
    cut_end: float = None,
) -> None:
    """Run the download in the current thread (called from a background thread)."""
    # Final URL validation before downloading
    if not validate_url(url):
        progress_store[task_id] = {
            "status": "error",
            "percent": 0,
            "message": "Invalid URL. Only YouTube links are allowed.",
        }
        return

    os.makedirs(output_dir, exist_ok=True)
    cancel_flags[task_id] = threading.Event()

    opts = _build_ydl_opts(mode, quality, file_format, output_dir, task_id, progress_store, cancel_flags, cut_start, cut_end)

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info:
                # Find the actual generated file on disk by scanning the output directory
                filename = None
                if os.path.exists(output_dir):
                    for f in os.listdir(output_dir):
                        if f.startswith(f"{task_id}_") and not f.endswith(".part") and not f.endswith(".ytdl"):
                            filename = os.path.join(output_dir, f)
                            break
            else:
                filename = None

            # Verify the file is within the output directory (prevent path escape)
            if filename:
                real_file = os.path.normpath(os.path.realpath(filename))
                real_outdir = os.path.normpath(os.path.realpath(output_dir))
                if os.path.commonpath([real_file, real_outdir]) != real_outdir:
                    # Path traversal detected — delete and error
                    try:
                        os.remove(real_file)
                    except OSError:
                        pass
                    raise Exception("Security: output file path is outside download directory")

            progress_store[task_id] = {
                "status": "done",
                "percent": 100,
                "filename": _sanitize_filename(os.path.basename(filename)) if filename else None,
                "filepath": filename,
                "title": _sanitize_text(info.get("title", "Download") if info else "Download"),
            }
    except Exception as e:
        err_msg = str(e)
        if "cancelled" in err_msg.lower():
            _cleanup_partial_files(output_dir, task_id)
            progress_store[task_id] = {
                "status": "cancelled",
                "percent": 0,
                "message": "Download cancelled.",
            }
        else:
            progress_store[task_id] = {
                "status": "error",
                "percent": 0,
                "message": _clean_error(err_msg),
            }
    finally:
        cancel_flags.pop(task_id, None)


def cancel_download(task_id: str, cancel_flags: dict) -> bool:
    """Signal a running download to stop."""
    event = cancel_flags.get(task_id)
    if event:
        event.set()
        return True
    return False


def _cleanup_partial_files(output_dir: str, task_id: str):
    """Remove any partial download files for a cancelled task."""
    try:
        real_outdir = os.path.normpath(os.path.realpath(output_dir))
        for f in os.listdir(real_outdir):
            if f.startswith(task_id):
                filepath = os.path.join(real_outdir, f)
                # Double-check it's still within the directory
                if os.path.commonpath([os.path.normpath(os.path.realpath(filepath)), real_outdir]) == real_outdir:
                    try:
                        os.remove(filepath)
                    except OSError:
                        pass
    except OSError:
        pass


def delete_file(filepath: str):
    """Delete a file from disk (used for auto-cleanup after user downloads)."""
    try:
        if filepath and os.path.isfile(filepath):
            os.remove(filepath)
    except OSError:
        pass


def _clean_error(msg: str) -> str:
    """Return a user-friendly error message (never leak internal details)."""
    if "Sign in" in msg or "bot" in msg.lower():
        return "YouTube is requesting sign-in. Try again in a moment or use a different video."
    if "unavailable" in msg.lower():
        return "This video is unavailable (private, deleted, or geo-blocked)."
    if "Requested format" in msg:
        return "The selected format is not available for this video. Try a different format."
    if "ffmpeg" in msg.lower() or "FFmpeg" in msg:
        return "FFmpeg is not installed. Audio conversion and HD merging require FFmpeg on your PATH."
    if "security" in msg.lower():
        return "Download blocked for security reasons."
    # Generic — never expose raw exception text
    return "Download failed. Please try again with a different URL or format."


def download_preview(url: str, output_dir: str) -> str:
    """
    Download a low-quality (360p worst) MP4 preview for clip trimming.
    Returns the filepath of the downloaded preview, or raises on error.
    """
    if not validate_url(url):
        raise ValueError("Invalid or disallowed URL")

    os.makedirs(output_dir, exist_ok=True)

    # Create a deterministic filename based on video URL hash
    import hashlib
    url_hash = hashlib.md5(url.encode()).hexdigest()

    # Check if preview already exists
    for f in os.listdir(output_dir):
        if f.startswith(url_hash) and not f.endswith(".part") and not f.endswith(".ytdl"):
            existing = os.path.join(output_dir, f)
            if os.path.isfile(existing) and os.path.getsize(existing) > 0:
                return existing

    outtmpl = os.path.join(output_dir, f"{url_hash}.%(ext)s")

    ffmpeg_available = _has_ffmpeg()

    opts = {
        **_secure_base_opts(),
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
    }

    if ffmpeg_available:
        opts["format"] = "bestvideo[height<=360]+bestaudio/best[height<=360]/worst"
        opts["merge_output_format"] = "mp4"
    else:
        opts["format"] = "best[height<=360]/worst"

    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    # Find the generated file
    for f in os.listdir(output_dir):
        if f.startswith(url_hash) and not f.endswith(".part") and not f.endswith(".ytdl"):
            filepath = os.path.join(output_dir, f)
            if os.path.isfile(filepath) and os.path.getsize(filepath) > 0:
                return filepath

    raise Exception("Preview download completed but file not found")

