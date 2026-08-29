# Build MusicYT.exe into dist\  (PowerShell)
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "Creating virtual environment..."
    py -3 -m venv .venv
}

$py = ".\.venv\Scripts\python.exe"

Write-Host "Installing dependencies..."
& $py -m pip install --upgrade pip | Out-Null
& $py -m pip install -r requirements.txt

Write-Host "Building..."
& $py -m PyInstaller --noconfirm MusicYT.spec

Write-Host ""
Write-Host "Done -> dist\MusicYT.exe"
