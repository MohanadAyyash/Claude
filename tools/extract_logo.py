#!/usr/bin/env python3
"""Extract vector artwork from the Trigon brand-guideline PDFs (rendered to SVG with pdftocairo) by bounding box.
usage: extract_logo.py in.svg out.svg x0 y0 x1 y1 [--recolor from=to,...]
Keeps only elements whose anchor point falls inside the box, drops background/hairline colours."""
import re, sys, xml.etree.ElementTree as ET
SVG = 'http://www.w3.org/2000/svg'; XL = 'http://www.w3.org/1999/xlink'
ET.register_namespace('', SVG); ET.register_namespace('xlink', XL)
src, out = sys.argv[1], sys.argv[2]; x0, y0, x1, y1 = map(float, sys.argv[3:7])
BG = {'#f2f1ee', '#d6d2c8', '#ffffff'}                       # paper, stone hairlines, white
def hexcol(v):
    m = re.match(r'rgb\(([\d.]+)%,\s*([\d.]+)%,\s*([\d.]+)%\)', v or '')
    return '#%02x%02x%02x' % tuple(round(float(g) * 2.55) for g in m.groups()) if m else (v or '#000000')
root = ET.parse(src).getroot()
defs = root.find(f'{{{SVG}}}defs'); glyphs = {g.get('id'): g for g in defs.iter(f'{{{SVG}}}g') if g.get('id')}
keep, used = [], set()
def walk(el, fill=None):
    for ch in el:
        tag = ch.tag.split('}')[1]
        if tag == 'defs': continue
        f = ch.get('fill') or fill
        if tag == 'g': walk(ch, f); continue
        if tag == 'use':
            x, y = float(ch.get('x', 0)), float(ch.get('y', 0)); ref = ch.get(f'{{{XL}}}href')[1:]
            col = hexcol(f)
            if x0 <= x <= x1 and y0 <= y <= y1 and col not in BG: keep.append(('use', ref, x, y, col)); used.add(ref)
        elif tag == 'path':
            m = re.match(r'\s*M\s+([-\d.]+)\s+([-\d.]+)', ch.get('d', ''))
            col = hexcol(ch.get('fill'))
            if m and ch.get('fill') and x0 <= float(m.group(1)) <= x1 and y0 <= float(m.group(2)) <= y1 and col not in BG: keep.append(('path', ch.get('d'), col))
walk(root)
recolor = {}
if '--recolor' in sys.argv:
    for pair in sys.argv[sys.argv.index('--recolor') + 1].split(','):
        a, b = pair.split('='); recolor[a.lower()] = b
w, h = x1 - x0, y1 - y0
o = [f'<svg xmlns="{SVG}" xmlns:xlink="{XL}" width="{w:.2f}" height="{h:.2f}" viewBox="{x0:.2f} {y0:.2f} {w:.2f} {h:.2f}"><defs>']
for gid in sorted(used):
    o.append(ET.tostring(glyphs[gid], encoding='unicode').replace(f' xmlns="{SVG}"', '').replace(f'ns0:', '').replace('xmlns:ns0="http://www.w3.org/2000/svg"', ''))
o.append('</defs><g id="art">')
for k in keep:
    if k[0] == 'use': o.append(f'<use xlink:href="#{k[1]}" x="{k[2]}" y="{k[3]}" fill="{recolor.get(k[4], k[4])}"/>')
    else: o.append(f'<path fill="{recolor.get(k[2], k[2])}" d="{k[1]}"/>')
o.append('</g></svg>')
open(out, 'w').write(''.join(o)); print(out, len(keep), 'elements,', len(used), 'glyphs')
