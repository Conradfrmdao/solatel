"""Draws the SOLATEL wordmark as an SVG, `assets/menu/logo.svg`.

    python scripts/build-logo.py <orbitron-black.woff2 or .ttf>

The letters are Orbitron Black (SIL Open Font License; the face is not
shipped - only these outlines, as artwork), set wide. The A is not a
letter: it is a peak, taller than the rest, with an orange triangle inside
it where a crossbar would be - the mark on Conrad's key art. A filter wears
the white like paint on metal, the way the key art's lettering is.

Outlines are written in font units with y flipped, cap height 720, so the
viewBox reads in the same units the font does.
"""
import sys
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets' / 'menu' / 'logo.svg'

TRACK = 70          # extra space between letters, font units
CAP = 720           # Orbitron's cap height
PEAK = 250          # how far the A's apex rises above the caps
A_WIDTH = 1000      # the A's base, outside edge to outside edge
LEG = 200           # each leg of the A across its foot
GAP = 95            # between the legs and the orange triangle, across
WHITE = '#f3f1ec'
ORANGE = '#f6a21b'


def glyph_path(glyphs, cmap, char, x):
    pen = SVGPathPen(glyphs)
    name = cmap[ord(char)]
    glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, x, CAP)))
    return pen.getCommands(), glyphs[name].width


def polygon(points):
    return 'M' + ' L'.join(f'{x:.1f} {y:.1f}' for x, y in points) + ' Z'


def main(font_path):
    font = TTFont(font_path)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()

    white = []
    orange = []
    x = 0.0
    for char in 'SOL':
        path, advance = glyph_path(glyphs, cmap, char, x)
        white.append(path)
        x += advance + TRACK

    # The peak: two legs meeting above the caps, their inner edges parallel
    # to their outer ones, and a triangle between them.
    half = A_WIDTH / 2
    rise = CAP + PEAK
    inner_apex = -PEAK + rise * LEG / half
    white.append(polygon([
        (x, CAP), (x + half, -PEAK), (x + A_WIDTH, CAP),
        (x + A_WIDTH - LEG, CAP), (x + half, inner_apex), (x + LEG, CAP),
    ]))
    slope = (CAP - inner_apex) / (half - LEG)
    orange.append(polygon([
        (x + LEG + GAP, CAP), (x + half, inner_apex + GAP * slope), (x + A_WIDTH - LEG - GAP, CAP),
    ]))
    x += A_WIDTH + TRACK

    for char in 'TEL':
        path, advance = glyph_path(glyphs, cmap, char, x)
        white.append(path)
        x += advance + TRACK
    width = x - TRACK

    pad = 30
    view = f'{-pad} {-PEAK - pad} {width + 2 * pad:.0f} {CAP + PEAK + 2 * pad}'
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" role="img" aria-label="Solatel">
  <defs>
    <filter id="worn" x="0" y="0" width="100%" height="100%" filterUnits="userSpaceOnUse">
      <feTurbulence type="fractalNoise" baseFrequency="0.02 0.035" numOctaves="3" seed="11" result="noise"/>
      <feColorMatrix in="noise" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -18 0 0 0 13.4" result="wear"/>
      <feComposite in="SourceGraphic" in2="wear" operator="in"/>
    </filter>
  </defs>
  <g fill="{WHITE}" filter="url(#worn)">
    <path d="{' '.join(white)}"/>
  </g>
  <path fill="{ORANGE}" d="{' '.join(orange)}"/>
</svg>
'''
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(svg, encoding='utf-8', newline='\n')
    print(f'{OUT.relative_to(ROOT)}: {len(svg)} bytes, {width:.0f} x {CAP + PEAK} units')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
