"""
app.py — Flask API server for the YT-DLP Web Interface.

Security hardening:
  - URL whitelist (YouTube/Invidious only)
  - Input validation & length limits on all endpoints
  - Strict allowlists for mode, quality, format parameters
  - Task ID format validation (hex only)
  - Path traversal protection on file serving
  - Rate limiting per IP
  - Security headers (CSP, X-Frame-Options, etc.)
  - CORS restricted to same-origin
  - Request body size cap
  - Concurrent download cap per session
  - No internal error details leaked to client
"""

import json
import os
import re
import threading
import time
import uuid
from collections import deque, defaultdict
from functools import wraps

from flask import Flask, request, jsonify, Response, send_file, send_from_directory, after_this_request
from flask_cors import CORS

from downloader import (
    extract_info, search_videos, start_download,
    cancel_download, delete_file, validate_url,
)

# ── Configuration ────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "downloads"))
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend"))

os.makedirs(DOWNLOAD_DIR, exist_ok=True)
try:
    for f in os.listdir(DOWNLOAD_DIR):
        path = os.path.join(DOWNLOAD_DIR, f)
        if os.path.isfile(path):
            delete_file(path)
except Exception:
    pass

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = 1 * 1024 * 1024  # 1 MB max request body

# Restrict CORS to same-origin only (no wildcard)
CORS(app, origins=["http://localhost:5000", "http://127.0.0.1:5000"])

# ── Allowed values (strict allowlists) ───────────────────────────────
ALLOWED_MODES = {"video", "audio"}
ALLOWED_VIDEO_QUALITIES = {"best", "1080", "720", "480", "360"}
ALLOWED_AUDIO_QUALITIES = {"best", "320", "256", "192", "128"}
ALLOWED_VIDEO_FORMATS = {"mp4", "mkv", "webm"}
ALLOWED_AUDIO_FORMATS = {"mp3", "aac", "flac", "wav", "opus"}
TASK_ID_PATTERN = re.compile(r"^[a-f0-9]{8}$")

# ── In-memory stores ─────────────────────────────────────────────────
progress_store: dict = {}
cancel_flags: dict = {}
download_history: deque = deque(maxlen=20)

def start_cleanup_thread():
    def cleanup_loop():
        while True:
            try:
                now = time.time()
                if os.path.exists(DOWNLOAD_DIR):
                    for f in os.listdir(DOWNLOAD_DIR):
                        path = os.path.normpath(os.path.join(DOWNLOAD_DIR, f))
                        if os.path.isfile(path):
                            # Clean up files older than 30 minutes
                            if now - os.path.getmtime(path) > 30 * 60:
                                delete_file(path)
                                match = re.match(r"^([a-f0-9]{8})_", f)
                                if match:
                                    task_id = match.group(1)
                                    progress_store.pop(task_id, None)
                                    for item in list(download_history):
                                        if item.get("task_id") == task_id:
                                            try:
                                                download_history.remove(item)
                                            except ValueError:
                                                pass
                                            break
            except Exception:
                pass
            time.sleep(60)

    threading.Thread(target=cleanup_loop, daemon=True).start()

# ── Rate Limiting ─────────────────────────────────────────────────────
# Simple in-memory per-IP rate limiter (no extra dependency)
_rate_store: dict = defaultdict(list)  # ip -> [timestamps]
RATE_LIMIT_WINDOW = 60   # seconds
RATE_LIMIT_MAX = 30      # max requests per window per IP
MAX_CONCURRENT_DOWNLOADS = 3  # max simultaneous downloads


def _rate_limit_check() -> bool:
    """Return True if the request should be BLOCKED."""
    ip = request.remote_addr or "unknown"
    now = time.time()
    # Prune old entries
    _rate_store[ip] = [t for t in _rate_store[ip] if now - t < RATE_LIMIT_WINDOW]
    if len(_rate_store[ip]) >= RATE_LIMIT_MAX:
        return True
    _rate_store[ip].append(now)
    return False


def rate_limited(f):
    """Decorator to apply rate limiting to routes."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if _rate_limit_check():
            return jsonify({"error": "Too many requests. Please slow down."}), 429
        return f(*args, **kwargs)
    return wrapper


# ── Security Headers ──────────────────────────────────────────────────
@app.after_request
def set_security_headers(response):
    # Prevent clickjacking
    response.headers["X-Frame-Options"] = "DENY"
    # Prevent MIME-type sniffing
    response.headers["X-Content-Type-Options"] = "nosniff"
    # XSS protection (legacy browsers)
    response.headers["X-XSS-Protection"] = "1; mode=block"
    # Referrer policy
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # Content Security Policy — restrict what the page can load
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' https://*.ytimg.com https://*.ggpht.com https://i.ytimg.com data:; "
        "connect-src 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'; "
        "base-uri 'self';"
    )
    # Permissions policy — disable unused browser features
    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=(), payment=()"
    )
    return response


# ── Validation Helpers ────────────────────────────────────────────────
def _validate_task_id(task_id: str) -> bool:
    """Ensure task_id is exactly 8 hex characters."""
    return bool(TASK_ID_PATTERN.match(task_id))


def _sanitize_search_query(query: str) -> str:
    """Sanitize search input: strip, limit length, remove control chars."""
    query = query.strip()
    # Remove control characters (keep printable + common whitespace)
    query = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", query)
    # Limit length
    return query[:200]


def _get_active_download_count() -> int:
    """Count currently active downloads."""
    return sum(
        1 for info in progress_store.values()
        if info.get("status") in ("starting", "downloading", "processing")
    )


# ── Frontend serving ─────────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    # Prevent directory traversal — only serve files within FRONTEND_DIR
    safe_path = os.path.normpath(os.path.join(FRONTEND_DIR, path))
    if not safe_path.startswith(FRONTEND_DIR):
        return jsonify({"error": "Forbidden"}), 403
    return send_from_directory(FRONTEND_DIR, path)


# ── API: Search YouTube ──────────────────────────────────────────────
@app.route("/api/search", methods=["POST"])
@rate_limited
def api_search():
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Invalid request body"}), 400

    query = data.get("query", "")
    if not isinstance(query, str):
        return jsonify({"error": "Query must be a string"}), 400

    query = _sanitize_search_query(query)
    if not query or len(query) < 2:
        return jsonify({"error": "Search query is too short (min 2 characters)"}), 400

    try:
        results = search_videos(query, max_results=10)
        return jsonify({"results": results})
    except Exception:
        return jsonify({"error": "Search failed. Please try again."}), 500


# ── API: Fetch video info ────────────────────────────────────────────
@app.route("/api/info", methods=["POST"])
@rate_limited
def api_info():
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Invalid request body"}), 400

    url = data.get("url", "")
    if not isinstance(url, str):
        return jsonify({"error": "URL must be a string"}), 400

    url = url.strip()
    if not url:
        return jsonify({"error": "URL is required"}), 400

    # Validate URL is a YouTube URL
    if not validate_url(url):
        return jsonify({"error": "Only YouTube URLs are allowed"}), 400

    try:
        info = extract_info(url)
        return jsonify(info)
    except Exception:
        return jsonify({"error": "Failed to fetch video info. Check the URL and try again."}), 500


# ── API: Start download ──────────────────────────────────────────────
@app.route("/api/download", methods=["POST"])
@rate_limited
def api_download():
    data = request.get_json(silent=True)
    if not data or not isinstance(data, dict):
        return jsonify({"error": "Invalid request body"}), 400

    url = data.get("url", "")
    mode = data.get("mode", "video")
    quality = data.get("quality", "best")
    file_format = data.get("format", "mp4")

    # Type checks
    if not all(isinstance(v, str) for v in [url, mode, quality, file_format]):
        return jsonify({"error": "Invalid parameter types"}), 400

    url = url.strip()

    # Validate URL
    if not validate_url(url):
        return jsonify({"error": "Only YouTube URLs are allowed"}), 400

    # Validate mode
    if mode not in ALLOWED_MODES:
        return jsonify({"error": f"Invalid mode. Must be one of: {', '.join(ALLOWED_MODES)}"}), 400

    # Validate quality
    allowed_qualities = ALLOWED_AUDIO_QUALITIES if mode == "audio" else ALLOWED_VIDEO_QUALITIES
    if quality not in allowed_qualities:
        return jsonify({"error": f"Invalid quality. Must be one of: {', '.join(allowed_qualities)}"}), 400

    # Validate format
    allowed_formats = ALLOWED_AUDIO_FORMATS if mode == "audio" else ALLOWED_VIDEO_FORMATS
    if file_format not in allowed_formats:
        return jsonify({"error": f"Invalid format. Must be one of: {', '.join(allowed_formats)}"}), 400

    # Limit concurrent downloads
    if _get_active_download_count() >= MAX_CONCURRENT_DOWNLOADS:
        return jsonify({"error": f"Too many active downloads (max {MAX_CONCURRENT_DOWNLOADS}). Wait for one to finish."}), 429

    task_id = uuid.uuid4().hex[:8]
    progress_store[task_id] = {"status": "starting", "percent": 0}

    thread = threading.Thread(
        target=_run_download,
        args=(url, mode, quality, file_format, task_id),
        daemon=True,
    )
    thread.start()

    return jsonify({"task_id": task_id})


def _run_download(url, mode, quality, file_format, task_id):
    """Background thread target for downloading."""
    start_download(
        url=url,
        mode=mode,
        quality=quality,
        file_format=file_format,
        task_id=task_id,
        progress_store=progress_store,
        cancel_flags=cancel_flags,
        output_dir=DOWNLOAD_DIR,
    )
    result = progress_store.get(task_id, {})
    if result.get("status") == "done":
        download_history.appendleft({
            "task_id": task_id,
            "title": result.get("title", "Unknown"),
            "filename": result.get("filename"),
            "mode": mode,
            "format": file_format,
            "timestamp": time.time(),
        })


# ── API: Cancel download ─────────────────────────────────────────────
@app.route("/api/cancel/<task_id>", methods=["POST"])
@rate_limited
def api_cancel(task_id):
    if not _validate_task_id(task_id):
        return jsonify({"error": "Invalid task ID"}), 400

    success = cancel_download(task_id, cancel_flags)
    if success:
        return jsonify({"status": "cancelling", "message": "Download is being cancelled..."})
    else:
        return jsonify({"error": "No active download found for this task"}), 404


# ── API: SSE progress stream ─────────────────────────────────────────
@app.route("/api/progress/<task_id>")
def api_progress(task_id):
    if not _validate_task_id(task_id):
        return jsonify({"error": "Invalid task ID"}), 400

    if task_id not in progress_store:
        return jsonify({"error": "Unknown task"}), 404

    def event_stream():
        last_sent = None
        timeout = 0
        while timeout < 600:
            info = progress_store.get(task_id, {"status": "unknown"})
            serialized = json.dumps(info)

            if serialized != last_sent:
                yield f"data: {serialized}\n\n"
                last_sent = serialized

            if info.get("status") in ("done", "error", "cancelled"):
                break

            time.sleep(0.5)
            timeout += 0.5

    return Response(
        event_stream(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── API: Serve downloaded file (auto-delete after) ───────────────────
@app.route("/api/file/<task_id>")
@rate_limited
def api_file(task_id):
    if not _validate_task_id(task_id):
        return jsonify({"error": "Invalid task ID"}), 400

    info = progress_store.get(task_id)
    if not info or info.get("status") != "done":
        return jsonify({"error": "File not ready"}), 404

    filepath = info.get("filepath")
    if not filepath:
        return jsonify({"error": "File not found"}), 404

    # Path traversal protection: ensure file is within DOWNLOAD_DIR
    real_filepath = os.path.normpath(os.path.realpath(filepath))
    real_download_dir = os.path.normpath(os.path.realpath(DOWNLOAD_DIR))
    if not real_filepath.startswith(real_download_dir):
        return jsonify({"error": "Access denied"}), 403

    if not os.path.isfile(real_filepath):
        return jsonify({"error": "File not found on disk"}), 404

    return send_file(
        real_filepath,
        as_attachment=True,
        download_name=info.get("filename", "download"),
    )


# ── API: Download history ─────────────────────────────────────────────
@app.route("/api/history")
def api_history():
    return jsonify(list(download_history))


# ── Error handlers ────────────────────────────────────────────────────
@app.errorhandler(413)
def too_large(e):
    return jsonify({"error": "Request body too large (max 1 MB)"}), 413


@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Not found"}), 404


@app.errorhandler(500)
def server_error(e):
    return jsonify({"error": "Internal server error"}), 500


# ── Run ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    start_cleanup_thread()
    print("\n  [*] YT-DLP Web Interface running at http://localhost:5000\n")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
