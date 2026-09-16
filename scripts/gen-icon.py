"""Generate square Zenith Z icon - large readable Z."""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
OUT = r"c:\Users\tromb\Downloads\dbd\zenith-player - Copy\app-icon-z.png"

img = Image.new("RGB", (SIZE, SIZE), (8, 10, 16))
draw = ImageDraw.Draw(img)

for r in range(400, 0, -3):
    t = 1 - r / 400
    c = int(22 + 60 * t), int(40 + 95 * t), int(85 + 130 * t)
    draw.ellipse(
        (SIZE // 2 - r, SIZE // 2 - r - 20, SIZE // 2 + r, SIZE // 2 + r - 20),
        fill=c,
    )

font = None
for path in (
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\calibrib.ttf",
):
    if os.path.isfile(path):
        font = ImageFont.truetype(path, 820)
        break
if font is None:
    font = ImageFont.load_default()

draw.text(
    (SIZE // 2, SIZE // 2 + 24),
    "Z",
    font=font,
    anchor="mm",
    fill=(88, 155, 255),
    stroke_width=14,
    stroke_fill=(205, 225, 255),
)

img.save(OUT, optimize=True)
print(f"Wrote {OUT}")
