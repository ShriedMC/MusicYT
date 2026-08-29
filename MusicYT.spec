# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller build spec for MusicYT.

Produces a single windowed executable:  dist/MusicYT.exe

    pyinstaller --noconfirm MusicYT.spec
"""

block_cipher = None

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[('web', 'web')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'pytest', 'setuptools', 'pip',
        'PyQt5', 'PyQt6', 'PySide2', 'PySide6',
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='MusicYT',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['icon.ico'],
    version='version_info.txt',
)
