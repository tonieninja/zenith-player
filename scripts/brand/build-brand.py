#!/usr/bin/env python3
"""Build every Zenith brand asset from the two source SVGs.

    pip install cairosvg pillow
    python scripts/brand/build-brand.py

Reads assets/brand/source/zenith-logo.svg (full logo) and zenith-icon-small.svg (the
chunkier version that stays readable at 16-48 px) and writes:

    assets/brand/svg/   logo variants, wordmarks, banners
    assets/brand/png/   the same as PNG in all the usual sizes
    src-tauri/icons/    every app icon (png, ico, icns, android, ios), same sizes as before
    src-tauri/nsis/     installer header and sidebar bitmaps
    public/             favicon.ico and logo.png

Banners use the Outfit and Inter fonts, install them first or the text falls back to
whatever sans the system has.
"""
from __future__ import annotations

import io
import re
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "assets" / "brand"
SRC = BRAND / "source"
SVG = BRAND / "svg"
PNG = BRAND / "png"
ICONS = ROOT / "src-tauri" / "icons"

LOGO = (SRC / "zenith-logo.svg").read_text()
SMALL = (SRC / "zenith-icon-small.svg").read_text()

Z_PATH = "M292 392 H684 L318 752 H732"
SMALL_LIMIT = 48  # at or below this size the small icon is used


def inner(svg: str) -> str:
    """content of an <svg> element without the root tag"""
    body = re.sub(r"^.*?<svg[^>]*>", "", svg, count=1, flags=re.S)
    return body.rsplit("</svg>", 1)[0]


def render(svg: str, w: int, h: int | None = None) -> Image.Image:
    data = cairosvg.svg2png(bytestring=svg.encode(), output_width=w, output_height=h or w)
    return Image.open(io.BytesIO(data)).convert("RGBA")


def icon_at(size: int) -> Image.Image:
    return render(SMALL if size <= SMALL_LIMIT else LOGO, size)


def mono(color: str) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        f'<path d="{Z_PATH}" fill="none" stroke="{color}" stroke-width="120" '
        'stroke-linecap="round" stroke-linejoin="round"/>'
        f'<circle cx="724" cy="254" r="62" fill="{color}"/></svg>\n'
    )


def light_tile() -> str:
    """logo on a light tile, for light backgrounds and print"""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">'
        '<defs><linearGradient id="z" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#5b9dff"/><stop offset="1" stop-color="#1f4fa8"/></linearGradient>'
        '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e8eefb"/></linearGradient></defs>'
        '<rect x="48" y="48" width="928" height="928" rx="232" fill="url(#bg)"/>'
        '<rect x="49.5" y="49.5" width="925" height="925" rx="230.5" fill="none" stroke="#0a0c12" stroke-opacity="0.08" stroke-width="3"/>'
        f'<path d="{Z_PATH}" fill="none" stroke="url(#z)" stroke-width="120" stroke-linecap="round" stroke-linejoin="round"/>'
        '<circle cx="724" cy="254" r="62" fill="#ffb84d"/></svg>\n'
    )


def wordmark(dark: bool) -> str:
    fg = "#ffffff" if dark else "#0d1019"
    sub = "#9aa3b8" if dark else "#4a5368"
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="320" viewBox="0 0 1200 320">'
        f'<svg x="20" y="20" width="280" height="280" viewBox="0 0 1024 1024">{inner(LOGO)}</svg>'
        f'<text x="330" y="190" font-family="Outfit, Inter, sans-serif" font-weight="700" font-size="150" letter-spacing="6" fill="{fg}">Zenith</text>'
        f'<text x="336" y="252" font-family="Inter, sans-serif" font-size="36" fill="{sub}">desktop player for YouTube Music</text>'
        "</svg>\n"
    )


def banner(w: int, h: int, tagline: str, small: str) -> str:
    s = min(h * 0.62, w * 0.25)
    title = min(h * 0.25, w * 0.1)
    tag = min(h * 0.075, w * 0.026)
    note = min(h * 0.05, w * 0.018)
    x = w * 0.08
    y = (h - s) / 2
    tx = x + s + w * 0.035
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
        '<defs><linearGradient id="bb" x1="0" y1="0" x2="1" y2="1">'
        '<stop offset="0" stop-color="#0b0e16"/><stop offset="1" stop-color="#18203a"/></linearGradient>'
        '<radialGradient id="halo" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#5b9dff" stop-opacity=".35"/>'
        '<stop offset="1" stop-color="#5b9dff" stop-opacity="0"/></radialGradient>'
        '<radialGradient id="halo2" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#9cc6ff" stop-opacity=".12"/>'
        '<stop offset="1" stop-color="#9cc6ff" stop-opacity="0"/></radialGradient></defs>'
        f'<g id="background"><rect width="{w}" height="{h}" fill="url(#bb)"/>'
        f'<circle cx="{x + s / 2}" cy="{h / 2}" r="{s}" fill="url(#halo)"/>'
        f'<circle cx="{w * 0.88}" cy="{h * 0.1}" r="{h * 0.7}" fill="url(#halo2)"/></g>'
        f'<g id="logo"><svg x="{x}" y="{y}" width="{s}" height="{s}" viewBox="0 0 1024 1024">{inner(LOGO)}</svg></g>'
        f'<g id="text"><text x="{tx}" y="{h / 2 + title * 0.1}" font-family="Outfit, Inter, sans-serif" font-weight="700" '
        f'font-size="{title}" letter-spacing="{title * 0.04}" fill="#ffffff">Zenith</text>'
        f'<text x="{tx + 4}" y="{h / 2 + title * 0.1 + tag * 1.9}" font-family="Inter, sans-serif" font-size="{tag}" fill="#c4cde0">{tagline}</text>'
        f'<text x="{tx + 4}" y="{h / 2 + title * 0.1 + tag * 1.9 + note * 2}" font-family="Inter, sans-serif" font-size="{note}" fill="#7f8aa3">{small}</text></g>'
        "</svg>\n"
    )


def save_ico(path: Path, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    imgs = [icon_at(s) for s in sizes]
    imgs[-1].save(path, format="ICO", sizes=[(s, s) for s in sizes], append_images=imgs[:-1])


def to_bmp(img: Image.Image, path: Path) -> None:
    bg = Image.new("RGB", img.size, (255, 255, 255))
    bg.paste(img, mask=img.split()[3])
    bg.save(path, format="BMP")


def main() -> None:
    SVG.mkdir(parents=True, exist_ok=True)
    PNG.mkdir(parents=True, exist_ok=True)

    svgs = {
        "zenith-logo.svg": LOGO,
        "zenith-icon.svg": SMALL,
        "zenith-mark-white.svg": mono("#ffffff"),
        "zenith-mark-black.svg": mono("#0a0c12"),
        "zenith-mark-blue.svg": mono("#5b9dff"),
        "zenith-logo-light.svg": light_tile(),
        "zenith-wordmark-dark.svg": wordmark(True),
        "zenith-wordmark-light.svg": wordmark(False),
        "banner-readme.svg": banner(1280, 400, "A fast, good looking desktop player for YouTube Music",
                                    "Windows · Linux · macOS  ·  free and open source"),
        "social-preview.svg": banner(1280, 640, "A fast desktop player for YouTube Music",
                                     "Windows · Linux · macOS  ·  free and open source"),
    }
    for name, body in svgs.items():
        (SVG / name).write_text(body)

    for s in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
        icon_at(s).save(PNG / f"zenith-logo-{s}.png")
    for s in (256, 512, 1024):
        render(svgs["zenith-logo-light.svg"], s).save(PNG / f"zenith-logo-light-{s}.png")
        for c in ("white", "black", "blue"):
            render(svgs[f"zenith-mark-{c}.svg"], s).save(PNG / f"zenith-mark-{c}-{s}.png")
    render(svgs["zenith-wordmark-dark.svg"], 1200, 320).save(PNG / "zenith-wordmark-dark.png")
    render(svgs["zenith-wordmark-light.svg"], 1200, 320).save(PNG / "zenith-wordmark-light.png")
    render(svgs["banner-readme.svg"], 1280, 400).save(PNG / "banner-readme.png")
    render(svgs["social-preview.svg"], 1280, 640).convert("RGB").save(PNG / "social-preview.png")
    save_ico(PNG / "zenith.ico")

    # app icons: keep every existing file, re-render it at its own size
    for p in ICONS.rglob("*.png"):
        w, h = Image.open(p).size
        img = icon_at(w)
        img.resize((w, h)).save(p)
    save_ico(ICONS / "icon.ico")
    icon_at(1024).save(ICONS / "icon.icns", format="ICNS")

    nsis = ROOT / "src-tauri" / "nsis"
    head = Image.new("RGBA", (150, 57), (255, 255, 255, 255))
    head.alpha_composite(render(LOGO, 49), (96, 4))
    to_bmp(head, nsis / "header.bmp")
    side = render(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">'
        '<defs><linearGradient id="bb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#18203a"/>'
        '<stop offset="1" stop-color="#0b0e16"/></linearGradient></defs>'
        '<rect width="164" height="314" fill="url(#bb)"/>'
        f'<svg x="22" y="40" width="120" height="120" viewBox="0 0 1024 1024">{inner(LOGO)}</svg>'
        '<text x="82" y="200" text-anchor="middle" font-family="Outfit, Inter, sans-serif" font-weight="700" font-size="30" fill="#fff">Zenith</text>'
        "</svg>",
        164, 314,
    )
    to_bmp(side, nsis / "sidebar.bmp")

    pub = ROOT / "public"
    save_ico(pub / "favicon.ico", sizes=(16, 32, 48, 64))
    icon_at(512).save(pub / "logo.png")
    icon_at(512).save(ROOT / "src" / "assets" / "logo.png")
    print("brand assets written")


if __name__ == "__main__":
    main()
