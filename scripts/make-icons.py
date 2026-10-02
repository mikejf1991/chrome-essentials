"""Render the small geometric Essentials mark with only the Python standard library."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]

def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))

def pixel(x, y):
    # A rounded blue tile and three white tabs form an E at every toolbar size.
    edge = max(abs(x - .5) - .30, 0) ** 2 + max(abs(y - .5) - .30, 0) ** 2
    if edge > .18 ** 2:
        return (0, 0, 0, 0)
    if .25 <= x <= .36 and .24 <= y <= .76:
        return (255, 255, 255, 255)
    if .25 <= x <= .75 and (.24 <= y <= .36 or .64 <= y <= .76):
        return (255, 255, 255, 255)
    if .25 <= x <= .64 and .44 <= y <= .56:
        return (255, 255, 255, 255)
    return (36, 88, 211, 255)

for size in (16, 32, 48, 128):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel((x + (sx + .5) / 4) / size, (y + (sy + .5) / 4) / size)
                       for sy in range(4) for sx in range(4)]
            rows.extend(round(sum(p[c] for p in samples) / 16) for c in range(4))
    target = ROOT / 'extension' / 'icons' / f'{size}.png'
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(b'\x89PNG\r\n\x1a\n' +
                      chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)) +
                      chunk(b'IDAT', zlib.compress(bytes(rows))) + chunk(b'IEND', b''))
    print(target.relative_to(ROOT))
