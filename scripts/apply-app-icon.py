"""Resize the generated Zenith logo into app, tray, and splash assets."""
from __future__ import annotations

import io
import struct
from pathlib import Path

from PIL import Image

SRC = Path(r"C:\Users\tromb\.cursor\projects\c-Users-tromb-Downloads-zenith-player\assets\zenith-app-logo.png")
ROOT = Path(r"c:\Users\tromb\Downloads\zenith-player")
ASSETS = ROOT / "src" / "assets"
ICONS = ROOT / "src-tauri" / "icons"
PUBLIC = ROOT / "public"


def rounded(img: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    img = img.convert("RGBA")
    w, h = img.size
    r = int(min(w, h) * radius_ratio)
    mask = Image.new("L", (w, h), 0)
    from PIL import ImageDraw

    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=255)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    out.paste(img, mask=mask)
    return out


def fit(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.Resampling.LANCZOS)


def write_icns(path: Path, master: Image.Image) -> None:
    """PNG-in-ICNS for 128/256/512/1024."""
    chunks = [
        (1024, b"ic10"),
        (512, b"ic09"),
        (256, b"ic08"),
        (128, b"ic07"),
    ]
    entries: list[tuple[bytes, bytes]] = []
    for size, tag in chunks:
        buf = io.BytesIO()
        fit(master, size).save(buf, format="PNG")
        entries.append((tag, buf.getvalue()))
    body = b""
    for tag, data in entries:
        body += tag + struct.pack(">I", 8 + len(data)) + data
    path.write_bytes(b"icns" + struct.pack(">I", 8 + len(body)) + body)


def main() -> None:
    if not SRC.is_file():
        raise SystemExit(f"missing source logo: {SRC}")

    master = Image.open(SRC).convert("RGBA")
    # Trim a hair of empty margin so the Z reads at 32px.
    bbox = master.getbbox()
    if bbox:
        pad = int(min(master.size) * 0.06)
        l, t, r, b = bbox
        l = max(0, l - pad)
        t = max(0, t - pad)
        r = min(master.width, r + pad)
        b = min(master.height, b + pad)
        side = max(r - l, b - t)
        cx, cy = (l + r) // 2, (t + b) // 2
        half = side // 2
        master = master.crop(
            (
                max(0, cx - half),
                max(0, cy - half),
                min(master.width, cx + half),
                min(master.height, cy + half),
            )
        )
        master = fit(master, 1024)

    ASSETS.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)

    ui = rounded(master, 0.22)
    ui.save(ASSETS / "logo.png", "PNG", optimize=True)
    ui.save(PUBLIC / "logo.png", "PNG", optimize=True)

    fit(master, 32).save(ICONS / "32x32.png", "PNG", optimize=True)
    fit(master, 128).save(ICONS / "128x128.png", "PNG", optimize=True)
    fit(master, 256).save(ICONS / "128x128@2x.png", "PNG", optimize=True)

    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    ico_images = [fit(master, s[0]) for s in ico_sizes]
    ico_images[0].save(
        ICONS / "icon.ico",
        format="ICO",
        sizes=ico_sizes,
        append_images=ico_images[1:],
    )
    ico_images[0].save(PUBLIC / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    write_icns(ICONS / "icon.icns", master)
    print("wrote", ASSETS / "logo.png")
    print("wrote", ICONS)


if __name__ == "__main__":
    main()
