@echo off
REM Build MusicYT.exe into dist\  (Windows, needs Python 3.10+ on PATH)
setlocal

cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    py -3 -m venv .venv || python -m venv .venv || goto :fail
)

call .venv\Scripts\activate.bat || goto :fail

echo Installing dependencies...
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt || goto :fail

echo Building...
pyinstaller --noconfirm MusicYT.spec || goto :fail

echo.
echo Done -> dist\MusicYT.exe
exit /b 0

:fail
echo.
echo BUILD FAILED
exit /b 1
