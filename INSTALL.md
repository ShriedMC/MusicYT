# Installing MusicYT

## For users (just the app)

1. Download `MusicYT.exe` from the [Releases page](../../releases) (or build it
   yourself — see below).
2. Put it anywhere you like: Desktop, `C:\Program Files\MusicYT\`, a folder in
   your user directory. It's a single file with nothing alongside it.
3. Double-click it.

### First launch

The first time it runs on a machine, MusicYT may set two things up:

| Component | Why | Size |
|-----------|-----|------|
| **Microsoft Edge WebView2 Runtime** | Renders the window. Windows 11 already has it; some Windows 10 installs don't. If automatic installer has issues, download the one that says "WithWebview" | ~2 MB installer |
| **Deno** | `yt-dlp` uses it to resolve YouTube audio. | ~40 MB, one time |

If WebView2 is missing you'll get a Yes/No prompt to install it. Deno downloads
silently in the background — a small banner at the bottom of the window shows the
progress, and search/playback become available once it finishes.

Both are stored per-user and reused on every later launch. Nothing is written to
system folders and no admin rights are needed (unless Windows itself prompts for
the WebView2 install).

### If the window is blank

The WebView2 Runtime isn't installed. Get it from
<https://developer.microsoft.com/microsoft-edge/webview2/> (the "Evergreen
Bootstrapper"), install, and reopen MusicYT.

### If downloads fail

The Deno download was blocked (no connection on first run, or a firewall). Open
a terminal and run:

```
winget install DenoLand.Deno
```

then reopen MusicYT — it will detect Deno and continue. On networks that block
`github.com` entirely, build the app with Deno bundled (see below).

## Where MusicYT keeps your data

| What | Location |
|------|----------|
| Playlists & settings | `%USERPROFILE%\.music_app_config.json` |
| Downloaded audio | `%USERPROFILE%\.music_app_cache\` |
| Deno + WebView profile | `%LOCALAPPDATA%\MusicYT\` |

To uninstall: delete `MusicYT.exe` and, if you want, those three paths. There are
no registry entries or Start Menu shortcuts.

## For developers (build it yourself)

Requires **Python 3.10+** on Windows 10/11.

```bat
git clone <your-repo-url> MusicYT
cd MusicYT
build.bat
```

`build.bat` creates a virtual environment, installs the dependencies from
`requirements.txt`, and runs PyInstaller. The output is `dist\MusicYT.exe`.

PowerShell users can run `.\build.ps1` instead.

### Bundling Deno (fully offline first run)

Drop a `deno.exe` next to `app.py` before running the build. PyInstaller will
pack it into the exe and the app will use it directly, with no download. Get the
Windows build from <https://github.com/denoland/deno/releases>.

### Running without building

```bat
py -3 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python app.py
```
