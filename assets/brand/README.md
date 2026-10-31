# Zenith brand kit

The logo is a Z drawn as one thick stroke with a small sun above it, the zenith point. It sits on
a dark rounded tile with a soft blue glow.

## What's where

| Folder | Contents |
| --- | --- |
| `source/` | The files to edit. `zenith-logo-layers.svg` has named layers (tile, glow, Z mark, sun, hidden guides) for Inkscape, Figma or Illustrator. `zenith-logo.svg` and `zenith-icon-small.svg` are the two masters the build script reads. `palette.md` lists colors and fonts |
| `svg/` | Ready to use vectors: full logo, small icon, mono marks (white, black, blue), light version, wordmarks (dark and light), README banner, social preview |
| `png/` | Logo at 16, 24, 32, 48, 64, 128, 256, 512 and 1024 px, light logo and mono marks at 256 to 1024, wordmarks, `banner-readme.png` (1280x400), `social-preview.png` (1280x640), `zenith.ico` |

Sizes up to 48 px use the small icon: thicker Z, bigger sun, no glow, so it stays readable in the
taskbar and tray.

## Rebuilding

```bash
pip install cairosvg pillow
python scripts/brand/build-brand.py
```

This rewrites `svg/` and `png/` and also every app icon: `src-tauri/icons` (all PNGs at their
current sizes, `icon.ico`, `icon.icns`, Android and iOS), the NSIS installer bitmaps, `public/favicon.ico`
and the logo PNGs. Banners need the Outfit and Inter fonts installed (free on Google Fonts).

## Using the logo

- Keep some empty space around it, about a quarter of its width.
- Use the white mark on dark or busy backgrounds, the black one on light backgrounds.
- Don't recolor the gradient, stretch it, or put the full tile logo on a bright photo.

To set the GitHub social preview, upload `png/social-preview.png` under *Settings → General → Social preview*.
