"""MusicYT Player - a small desktop YouTube audio player / downloader.

Design notes:
  * The UI is plain HTML/CSS/JS rendered by pywebview (Edge WebView2 on Windows).
  * Audio is downloaded with yt-dlp into a local cache and played back from a
    tiny threaded HTTP server, so anything already downloaded plays offline.
  * yt-dlp needs a JavaScript runtime (Deno) to solve YouTube's signature
    challenges. If one is not present it is downloaded once, on first run.
  * No ffmpeg dependency: YouTube's native audio (m4a / webm-opus) is served
    straight to the WebView, which plays both.
"""

import glob
import json
import os
import platform
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import webview
import yt_dlp

APP_NAME = "MusicYT"
DEBUG = os.environ.get("MUSICYT_DEBUG") == "1"

# MusicYT is free software. This notice is deliberately asserted from several
# independent places - here, web/index.html, web/style.css and web/script.js -
# so that a repackager trying to sell it has to strip all of them.
FREE_NOTICE = (
    "MusicYT is free and will always be free. "
    "If you paid for this, you got scammed."
)

# Per-user data. Config + audio cache keep their historical locations so an
# existing install keeps its playlists and downloads.
CONFIG_FILE = os.path.expanduser("~/.music_app_config.json")
CACHE_DIR = os.path.expanduser("~/.music_app_cache")
APP_DATA_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), APP_NAME)
RUNTIME_DIR = os.path.join(APP_DATA_DIR, "runtime")

os.makedirs(CACHE_DIR, exist_ok=True)
os.makedirs(RUNTIME_DIR, exist_ok=True)

AUDIO_EXTS = (".m4a", ".webm", ".opus", ".mp3", ".ogg", ".mp4", ".aac")
_MIME = {
    ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac",
    ".webm": "audio/webm", ".opus": "audio/ogg", ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
}


def resource_path(relative_path):
    """Path to a bundled resource (works both from source and from a PyInstaller build)."""
    base = getattr(sys, "_MEIPASS", os.path.abspath("."))
    return os.path.join(base, relative_path)


def cached_audio(video_id):
    """Return the path of an already-downloaded audio file for video_id, or None.
    Matches any container so pre-existing .mp3 downloads keep working."""
    for path in sorted(glob.glob(os.path.join(CACHE_DIR, glob.escape(video_id) + ".*"))):
        ext = os.path.splitext(path)[1].lower()
        if ext in AUDIO_EXTS and os.path.getsize(path) > 0:
            return path
    return None


# --------------------------------------------------------------------------- #
#  Local audio server (threaded, supports HTTP Range so seeking works)
# --------------------------------------------------------------------------- #
SERVER_PORT = 0
_httpd = None


class _AudioHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # silence console spam
        pass

    def _resolve(self):
        name = os.path.basename(self.path.lstrip("/").split("?", 1)[0])
        path = os.path.join(CACHE_DIR, name)
        if not os.path.isfile(path) or os.path.dirname(os.path.abspath(path)) != os.path.abspath(CACHE_DIR):
            return None
        return path

    def do_HEAD(self):
        self._serve(head_only=True)

    def do_GET(self):
        self._serve(head_only=False)

    def _serve(self, head_only):
        path = self._resolve()
        if not path:
            self.send_error(404)
            return
        size = os.path.getsize(path)
        ctype = _MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        partial = False
        if rng and rng.startswith("bytes="):
            try:
                s, _, e = rng[6:].partition("-")
                if s:
                    start = int(s)
                    end = int(e) if e else size - 1
                else:  # suffix range: bytes=-N
                    start = max(0, size - int(e))
                end = min(end, size - 1)
                if start > end:
                    raise ValueError
                partial = True
            except ValueError:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return

        length = end - start + 1
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if partial:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        if head_only:
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(65536, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)


def start_server():
    global _httpd, SERVER_PORT
    _httpd = ThreadingHTTPServer(("127.0.0.1", 0), _AudioHandler)
    _httpd.daemon_threads = True
    SERVER_PORT = _httpd.server_address[1]
    threading.Thread(target=_httpd.serve_forever, daemon=True).start()


def audio_url(path):
    return f"http://127.0.0.1:{SERVER_PORT}/{os.path.basename(path)}"


# --------------------------------------------------------------------------- #
#  JavaScript runtime (Deno) - found locally or downloaded once on first run
# --------------------------------------------------------------------------- #
JS_RUNTIMES = None
RUNTIME_STATUS = {"state": "checking", "detail": "", "progress": 0}
_runtime_done = threading.Event()
_runtime_lock = threading.Lock()


def _prepend_path(directory):
    if directory and directory not in os.environ.get("PATH", "").split(os.pathsep):
        os.environ["PATH"] = directory + os.pathsep + os.environ.get("PATH", "")


def _find_deno():
    candidates = []
    which = shutil.which("deno")
    if which:
        candidates.append(which)
    candidates += [
        resource_path("deno.exe"), resource_path("deno"),
        os.path.join(RUNTIME_DIR, "deno.exe"), os.path.join(RUNTIME_DIR, "deno"),
        os.path.join(os.path.expanduser("~"), ".deno", "bin", "deno.exe"),
    ]
    local_appdata = os.environ.get("LOCALAPPDATA", "")
    if local_appdata:
        candidates += glob.glob(os.path.join(
            local_appdata, "Microsoft", "WinGet", "Packages",
            "DenoLand.Deno*", "deno.exe"))
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    return None


def _deno_zip_name():
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        return "deno-aarch64-pc-windows-msvc.zip"
    return "deno-x86_64-pc-windows-msvc.zip"


def _activate(path):
    global JS_RUNTIMES
    JS_RUNTIMES = {"deno": {"path": path}}
    _prepend_path(os.path.dirname(path))
    RUNTIME_STATUS.update(state="ok", detail=path, progress=100)


def _ssl_context():
    """A CA-verified SSL context that also works in a frozen build on a PC with
    no Python install (uses certifi's bundle, falls back to the OS store)."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def _download(url, dest, progress=None, attempts=3):
    """Download url -> dest with a real User-Agent, verified TLS, and retries."""
    ctx = _ssl_context()
    req = urllib.request.Request(url, headers={"User-Agent": "MusicYT/1.0"})
    last_err = None
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
                total = int(resp.headers.get("Content-Length", 0))
                done = 0
                with open(dest, "wb") as out:
                    while True:
                        chunk = resp.read(65536)
                        if not chunk:
                            break
                        out.write(chunk)
                        done += len(chunk)
                        if progress and total:
                            progress(min(99, int(done * 100 / total)))
            return
        except Exception as exc:
            last_err = exc
            time.sleep(2 * attempt)
    raise last_err


def ensure_runtime():
    """Locate Deno; download it once if missing. Runs on a background thread."""
    if not _runtime_lock.acquire(blocking=False):
        return  # another attempt is already in progress
    try:
        found = _find_deno()
        if found:
            _activate(found)
            return

        RUNTIME_STATUS.update(state="downloading", detail="Downloading Deno runtime…", progress=0)
        url = f"https://github.com/denoland/deno/releases/latest/download/{_deno_zip_name()}"
        tmp_zip = os.path.join(RUNTIME_DIR, "deno_download.zip")

        _download(url, tmp_zip, progress=lambda p: RUNTIME_STATUS.__setitem__("progress", p))
        with zipfile.ZipFile(tmp_zip) as zf:
            member = next((n for n in zf.namelist() if n.lower().endswith("deno.exe")), "deno.exe")
            with zf.open(member) as src, open(os.path.join(RUNTIME_DIR, "deno.exe"), "wb") as dst:
                shutil.copyfileobj(src, dst)
        try:
            os.remove(tmp_zip)
        except OSError:
            pass

        dest = os.path.join(RUNTIME_DIR, "deno.exe")
        if os.path.isfile(dest):
            _activate(dest)
        else:
            RUNTIME_STATUS.update(state="error", detail="Deno archive did not contain deno.exe")
    except Exception as exc:
        RUNTIME_STATUS.update(
            state="error",
            detail=(
                "Couldn't download the Deno runtime "
                f"({type(exc).__name__}: {exc}). "
                "Check your connection and reopen MusicYT, or install it with:  "
                "winget install DenoLand.Deno"
            ),
        )
    finally:
        _runtime_done.set()
        _runtime_lock.release()


def wait_for_runtime(timeout=180):
    """Block until the runtime is ready. If a previous attempt failed (e.g. a
    transient network error at startup), retry now, synchronously - the user is
    waiting on a track, so it's worth another try."""
    _runtime_done.wait(timeout)
    if RUNTIME_STATUS.get("state") != "ok":
        _runtime_done.clear()
        ensure_runtime()                # no-op if another retry is mid-flight
        _runtime_done.wait(timeout)


def yt_common_opts():
    """Options merged into every yt-dlp call.

    remote_components lets yt-dlp fetch its EJS challenge-solver script (cached
    after first use); js_runtimes points it at our Deno binary. Both are needed
    to reliably obtain a downloadable audio format from YouTube.
    """
    opts = {"remote_components": ["ejs:github"]}
    if JS_RUNTIMES:
        opts["js_runtimes"] = JS_RUNTIMES
    return opts


# --------------------------------------------------------------------------- #
#  Config (atomic writes, thread-safe, .bak fallback)
# --------------------------------------------------------------------------- #
_cfg_lock = threading.RLock()


def load_config():
    for path in (CONFIG_FILE, CONFIG_FILE + ".bak"):
        try:
            if os.path.exists(path):
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    return data
        except Exception:
            continue
    return {}


# --------------------------------------------------------------------------- #
#  API exposed to the web UI
# --------------------------------------------------------------------------- #
class Api:
    def __init__(self):
        self.config = load_config()
        self._window = None          # underscore: kept off the JS bridge
        self._mini = False
        self.config.setdefault("playlists", {})
        self.config.setdefault("settings", {})
        self.save_config()

    # -- window -----------------------------------------------------------
    def set_window(self, window):
        self._window = window

    def toggle_mini_player(self):
        if not self._window:
            return self._mini
        try:
            if self._mini:
                self._window.resize(1200, 800)
                self._window.on_top = False
            else:
                self._window.resize(400, 200)
                self._window.on_top = True
            self._mini = not self._mini
        except Exception as exc:
            print(f"mini player toggle failed: {exc}")
        return self._mini

    # -- config ---------------------------------------------------------------
    def save_config(self):
        with _cfg_lock:
            try:
                payload = json.dumps(self.config, indent=1)
                directory = os.path.dirname(CONFIG_FILE) or "."
                fd, tmp = tempfile.mkstemp(dir=directory, prefix=".mcfg", suffix=".tmp")
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(payload)
                    f.flush()
                    os.fsync(f.fileno())
                if os.path.exists(CONFIG_FILE):
                    try:
                        shutil.copy2(CONFIG_FILE, CONFIG_FILE + ".bak")
                    except OSError:
                        pass
                os.replace(tmp, CONFIG_FILE)
            except Exception as exc:
                print(f"Error saving config: {exc}")

    # -- first-run warning --------------------------------------------------
    def check_first_launch(self):
        return not self.config.get("warning_accepted", False)

    def accept_warning(self):
        self.config["warning_accepted"] = True
        self.save_config()
        return True

    def free_notice(self):
        return FREE_NOTICE

    # -- persisted UI settings (volume / shuffle / repeat / last playlist) --
    def get_settings(self):
        return self.config.get("settings", {})

    def save_settings(self, patch):
        with _cfg_lock:
            settings = self.config.setdefault("settings", {})
            if isinstance(patch, dict):
                settings.update(patch)
            self.save_config()
        return True

    # -- runtime status ---------------------------------------------------
    def get_runtime_status(self):
        return dict(RUNTIME_STATUS)

    # -- playlists ------------------------------------------------------------
    def get_playlists(self):
        return self.config.get("playlists", {})

    def create_playlist(self, name):
        with _cfg_lock:
            if name and name not in self.config["playlists"]:
                self.config["playlists"][name] = []
                self.save_config()
                return True
        return False

    def add_to_playlist(self, playlist_name, song):
        with _cfg_lock:
            playlist = self.config["playlists"].get(playlist_name)
            if playlist is None:
                return False
            if any(s["id"] == song["id"] for s in playlist):
                return False
            playlist.append(song)
            self.save_config()
        return True

    def remove_from_playlist(self, playlist_name, song_id):
        with _cfg_lock:
            if playlist_name in self.config["playlists"]:
                self.config["playlists"][playlist_name] = [
                    s for s in self.config["playlists"][playlist_name] if s["id"] != song_id
                ]
                self.save_config()
                return True
        return False

    def bulk_import(self, playlist_name, song_names):
        added = 0
        with _cfg_lock:
            self.config["playlists"].setdefault(playlist_name, [])
        for name in song_names:
            name = (name or "").strip()
            if not name:
                continue
            results = self.search_youtube(name)
            if not results:
                continue
            song = results[0]
            with _cfg_lock:
                playlist = self.config["playlists"].setdefault(playlist_name, [])
                if not any(s["id"] == song["id"] for s in playlist):
                    playlist.append(song)
                    added += 1
                    self.save_config()
        return added

    def background_sync_playlist(self, playlist_name):
        def _sync():
            wait_for_runtime()
            for song in list(self.config.get("playlists", {}).get(playlist_name, [])):
                video_id = song["id"]
                if cached_audio(video_id):
                    continue
                opts = {
                    "format": "bestaudio[ext=m4a]/bestaudio/best",
                    "outtmpl": os.path.join(CACHE_DIR, f"{video_id}.%(ext)s"),
                    "quiet": True,
                    "noprogress": True,
                    "noplaylist": True,
                }
                opts.update(yt_common_opts())
                try:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
                except Exception as exc:
                    print(f"Background download error for {video_id}: {exc}")

        threading.Thread(target=_sync, daemon=True).start()
        return True

    # -- search / download --------------------------------------------------
    def search_youtube(self, query):
        opts = {
            "format": "bestaudio/best",
            "noplaylist": True,
            "extract_flat": True,
            "default_search": "ytsearch10",
            "quiet": True,
        }
        opts.update(yt_common_opts())
        results = []
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f"ytsearch10:{query}", download=False)
            for entry in (info or {}).get("entries", []):
                if not entry.get("id"):
                    continue
                thumb = f"https://i.ytimg.com/vi/{entry['id']}/hqdefault.jpg"
                if entry.get("thumbnails"):
                    thumb = entry["thumbnails"][-1].get("url", thumb)
                results.append({
                    "id": entry.get("id"),
                    "title": entry.get("title"),
                    "duration": entry.get("duration"),
                    "thumbnail": thumb,
                    "channel": entry.get("uploader") or entry.get("channel"),
                })
        except Exception as exc:
            print(f"Search error: {exc}")
        return results

    def download_audio(self, video_id):
        existing = cached_audio(video_id)
        if existing:
            return audio_url(existing)

        wait_for_runtime()
        opts = {
            "format": "bestaudio[ext=m4a]/bestaudio/best",
            "outtmpl": os.path.join(CACHE_DIR, f"{video_id}.%(ext)s"),
            "quiet": True,
            "noprogress": True,
            "noplaylist": True,
        }
        opts.update(yt_common_opts())
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        except Exception as exc:
            print(f"Download error: {exc}")
            return None

        downloaded = cached_audio(video_id)
        return audio_url(downloaded) if downloaded else None


# --------------------------------------------------------------------------- #
#  Edge WebView2 Runtime - the UI needs it. pywebview silently falls back to the
#  ancient MSHTML engine when it is missing, which cannot run this app's
#  JS/CSS - the symptom is a blank window. Windows 11 ships it; older / LTSC /
#  fresh Windows 10 often does not.
# --------------------------------------------------------------------------- #
_WEBVIEW2_CLIENT = r"{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
_WEBVIEW2_BOOTSTRAPPER_URL = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"


def _message_box(text, title="MusicYT", style=0):
    try:
        import ctypes
        return ctypes.windll.user32.MessageBoxW(0, text, title, style)
    except Exception:
        print(f"{title}: {text}")
        return None


def _webview2_installed():
    try:
        import winreg
    except ImportError:
        return True  # not Windows - nothing to check
    sub_paths = (
        rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_CLIENT}",
        rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_CLIENT}",
    )
    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for sub in sub_paths:
            try:
                with winreg.OpenKey(root, sub) as key:
                    version, _ = winreg.QueryValueEx(key, "pv")
                    if version and version not in ("", "0.0.0.0"):
                        return True
            except OSError:
                continue
    return False


def ensure_webview2():
    """Make sure the Edge WebView2 Runtime is present; offer to install it if not."""
    if os.name != "nt" or _webview2_installed():
        return

    MB_YESNO, MB_ICONINFO, MB_ICONERROR, IDYES = 0x4, 0x40, 0x10, 6
    choice = _message_box(
        "MusicYT needs the Microsoft Edge WebView2 Runtime to display its window.\n\n"
        "Download and install it now? (about 2 MB, from Microsoft)",
        "MusicYT - one-time setup",
        MB_YESNO | MB_ICONINFO,
    )
    if choice != IDYES:
        _message_box(
            "MusicYT can't start without the WebView2 Runtime.\n\n"
            "Install it from:\nhttps://developer.microsoft.com/microsoft-edge/webview2/\n"
            "then run MusicYT again.",
            "MusicYT",
            MB_ICONERROR,
        )
        sys.exit(1)

    try:
        setup = os.path.join(tempfile.gettempdir(), "MicrosoftEdgeWebview2Setup.exe")
        _download(_WEBVIEW2_BOOTSTRAPPER_URL, setup)
        subprocess.run([setup, "/silent", "/install"], check=False)
        for _ in range(30):
            if _webview2_installed():
                break
            time.sleep(2)
    except Exception as exc:
        _message_box(f"WebView2 install failed: {exc}\n\n"
                     "Install it manually from:\n"
                     "https://developer.microsoft.com/microsoft-edge/webview2/",
                     "MusicYT", MB_ICONERROR)

    if not _webview2_installed():
        _message_box(
            "WebView2 still isn't detected. MusicYT may not display correctly.\n"
            "If the window is blank, install WebView2 manually and restart.",
            "MusicYT", MB_ICONERROR)


def main():
    ensure_webview2()
    start_server()
    threading.Thread(target=ensure_runtime, daemon=True).start()

    # "MusicYT is free" - asserted here, plus in the web UI (sidebar banner +
    # first-run modal) and app.py's FREE_NOTICE constant. Removing one does
    # nothing; a reseller has to strip every copy.
    print(FREE_NOTICE)

    api = Api()
    window = webview.create_window(
        "MusicYT Player",
        url=resource_path("web/index.html"),
        js_api=api,
        width=1200,
        height=800,
        min_size=(400, 200),
        background_color="#000000",
    )
    api.set_window(window)

    def _on_shown():
        try:
            window.evaluate_js(
                "window.assertFreeNotice && window.assertFreeNotice();"
                f"console.log({json.dumps(FREE_NOTICE)});"
            )
        except Exception:
            pass
        if not api.config.get("free_notice_ack"):
            # separate thread so the modal box doesn't freeze the UI thread
            threading.Thread(
                target=lambda: _message_box(FREE_NOTICE, "MusicYT", 0x40),
                daemon=True,
            ).start()
            api.config["free_notice_ack"] = True
            api.save_config()
    window.events.shown += _on_shown

    # Explicit, guaranteed-writable profile dir so the WebView2 process starts
    # even when the .exe lives somewhere read-only (Program Files, a USB stick…).
    storage = os.path.join(APP_DATA_DIR, "webview")
    os.makedirs(storage, exist_ok=True)
    webview.start(debug=DEBUG, storage_path=storage)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException:  # windowed build has no console - show the error
        import traceback
        _message_box(
            "MusicYT hit an unexpected error and has to close:\n\n"
            + traceback.format_exc(),
            "MusicYT - error",
            0x10,
        )
        raise
