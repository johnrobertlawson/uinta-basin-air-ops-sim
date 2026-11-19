#!/usr/bin/env python3
"""Build versioned one-click installers for macOS (.pkg) and Ubuntu (.deb)."""

from __future__ import annotations

import argparse
import io
import os
import platform
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"
PKG_NAME = "uinta-basin-air-ops-sim"
APP_DISPLAY_NAME = "Uinta Basin Air Ops Sim"
BUNDLE_ID = "io.github.johnrobertlawson.uinta-basin-air-ops-sim"
WEB_FILES = ["index.html", "styles.css", "app.js", "data.js", "VERSION"]


def read_version() -> str:
    return (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def make_tar_gz(entries: list[tuple[str, bytes, int]]) -> bytes:
    """Create a deterministic root-owned .tar.gz buffer from (arcname, data, mode) tuples."""
    buf = io.BytesIO()
    mtime = int(time.time())
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for arcname, data, mode in entries:
            ti = tarfile.TarInfo(name=arcname)
            ti.size = len(data)
            ti.mode = mode
            ti.uid = 0
            ti.gid = 0
            ti.uname = "root"
            ti.gname = "root"
            ti.mtime = mtime
            tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def make_ar_archive(members: list[tuple[str, bytes]]) -> bytes:
    """Create a standard Debian .deb `ar` archive (deb(5) format)."""
    out = bytearray(b"!<arch>\n")
    mtime = str(int(time.time())).encode("ascii")
    for name, payload in members:
        header = (
            f"{name:<16}"
            f"{mtime.decode('ascii'):<12}"
            f"{'0':<6}"
            f"{'0':<6}"
            f"{'100644':<8}"
            f"{len(payload):<10}"
            "`\n"
        ).encode("ascii")
        assert len(header) == 60, f"Invalid ar header length: {len(header)}"
        out.extend(header)
        out.extend(payload)
        if len(payload) % 2 == 1:
            out.extend(b"\n")
    return bytes(out)


def build_deb(version: str) -> Path:
    """Build Ubuntu/Debian one-click installer (.deb)."""
    DIST_DIR.mkdir(parents=True, exist_ok=True)
    deb_path = DIST_DIR / f"{PKG_NAME}_{version}_all.deb"

    bin_launcher = (
        "#!/bin/sh\n"
        "exec python3 /usr/share/uinta-basin-air-ops-sim/launcher.py /usr/share/uinta-basin-air-ops-sim/web \"$@\"\n"
    ).encode("utf-8")

    desktop_entry = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={APP_DISPLAY_NAME}\n"
        "GenericName=Aviation Operations Simulator\n"
        "Comment=DLR-style KVEL & Uinta Basin multi-role air operations simulator\n"
        "Exec=/usr/bin/uinta-basin-air-ops-sim\n"
        f"Icon={PKG_NAME}\n"
        "Terminal=false\n"
        "Categories=Game;Simulation;Education;\n"
        "StartupNotify=false\n"
    ).encode("utf-8")

    data_entries: list[tuple[str, bytes, int]] = [
        ("./usr/bin/uinta-basin-air-ops-sim", bin_launcher, 0o755),
        ("./usr/share/uinta-basin-air-ops-sim/launcher.py", (ROOT / "scripts" / "launcher.py").read_bytes(), 0o755),
        ("./usr/share/applications/uinta-basin-air-ops-sim.desktop", desktop_entry, 0o644),
        (f"./usr/share/icons/hicolor/scalable/apps/{PKG_NAME}.svg", (ROOT / "assets" / "icon.svg").read_bytes(), 0o644),
    ]
    for fname in WEB_FILES:
        data_entries.append((f"./usr/share/uinta-basin-air-ops-sim/web/{fname}", (ROOT / fname).read_bytes(), 0o644))

    installed_kb = max(1, sum(len(d) for _, d, _ in data_entries) // 1024)
    control_text = (
        f"Package: {PKG_NAME}\n"
        f"Version: {version}\n"
        "Section: games\n"
        "Priority: optional\n"
        "Architecture: all\n"
        "Depends: python3\n"
        f"Installed-Size: {installed_kb}\n"
        "Maintainer: John Lawson <john.lawson@usu.edu>\n"
        "Homepage: https://github.com/johnrobertlawson/uinta-basin-air-ops-sim\n"
        "Description: KVEL & Uinta Basin Air Operations Simulator\n"
        " Lightweight DLR train-signalling-inspired multi-role aviation operations\n"
        " simulator centered on Vernal Regional Airport (KVEL) and the Ashley Valley,\n"
        " extending across Uinta Basin airstrips, helipads, and regional portals.\n"
    ).encode("utf-8")

    control_tar = make_tar_gz([("./control", control_text, 0o644)])
    data_tar = make_tar_gz(data_entries)
    deb_bytes = make_ar_archive([
        ("debian-binary", b"2.0\n"),
        ("control.tar.gz", control_tar),
        ("data.tar.gz", data_tar),
    ])
    deb_path.write_bytes(deb_bytes)
    print(f"Built Ubuntu installer: {deb_path} ({len(deb_bytes):,} bytes)")
    return deb_path


def build_macos_pkg(version: str) -> Path:
    """Build macOS one-click installer (.pkg) installing into /Applications."""
    if platform.system() != "Darwin" or shutil.which("pkgbuild") is None:
        raise RuntimeError("macOS .pkg build requires macOS with pkgbuild installed")

    DIST_DIR.mkdir(parents=True, exist_ok=True)
    pkg_path = DIST_DIR / f"Uinta-Basin-Air-Ops-Sim-{version}-macOS.pkg"

    with tempfile.TemporaryDirectory(prefix="kvel-pkg-") as tmp:
        payload_root = Path(tmp) / "payload"
        app_dir = payload_root / "Applications" / f"{APP_DISPLAY_NAME}.app"
        macos_dir = app_dir / "Contents" / "MacOS"
        res_dir = app_dir / "Contents" / "Resources"
        web_dir = res_dir / "web"
        macos_dir.mkdir(parents=True)
        web_dir.mkdir(parents=True)

        info_plist = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>{APP_DISPLAY_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>{PKG_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>{BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>{APP_DISPLAY_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>{version}</string>
  <key>CFBundleVersion</key>
  <string>{version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
"""
        (app_dir / "Contents" / "Info.plist").write_text(info_plist, encoding="utf-8")

        exec_script = f"""#!/bin/bash
set -e
RES_DIR="$(cd "$(dirname "$0")/../Resources" && pwd)"
PYTHON_BIN=""
for candidate in \
  /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
  /opt/homebrew/bin/python3 \
  /usr/local/bin/python3 \
  /usr/bin/python3; do
  if [ -x "$candidate" ]; then
    PYTHON_BIN="$candidate"
    break
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  osascript -e 'display alert "{APP_DISPLAY_NAME}" message "Python 3 is required to run the local simulator server."'
  exit 1
fi
LOG_DIR="$HOME/Library/Logs/{PKG_NAME}"
mkdir -p "$LOG_DIR"
nohup "$PYTHON_BIN" "$RES_DIR/launcher.py" "$RES_DIR/web" > "$LOG_DIR/server.log" 2>&1 &
"""
        exec_path = macos_dir / PKG_NAME
        exec_path.write_text(exec_script, encoding="utf-8")
        exec_path.chmod(exec_path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

        shutil.copyfile(ROOT / "scripts" / "launcher.py", res_dir / "launcher.py")
        shutil.copyfile(ROOT / "assets" / "icon.svg", res_dir / "icon.svg")
        for fname in WEB_FILES:
            shutil.copyfile(ROOT / fname, web_dir / fname)

        subprocess.run(["xattr", "-cr", str(payload_root)], check=False)

        subprocess.run(
            [
                "pkgbuild",
                "--root",
                str(payload_root),
                "--identifier",
                BUNDLE_ID,
                "--version",
                version,
                "--install-location",
                "/",
                str(pkg_path),
            ],
            check=True,
            env={**os.environ, "COPYFILE_DISABLE": "1"},
        )

    print(f"Built macOS installer: {pkg_path} ({pkg_path.stat().st_size:,} bytes)")
    return pkg_path


def main() -> int:
    parser = argparse.ArgumentParser(description="Build macOS and Ubuntu installers.")
    parser.add_argument("--target", choices=["all", "deb", "macos"], default="all")
    args = parser.parse_args()
    version = read_version()

    if args.target in ("all", "deb"):
        build_deb(version)
    if args.target in ("all", "macos"):
        if platform.system() == "Darwin":
            build_macos_pkg(version)
        elif args.target == "macos":
            raise SystemExit("macOS .pkg can only be built on macOS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
