"""Build a distributable unpacked-extension ZIP; no dependencies are needed at runtime."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'extension' / 'manifest.json').read_text(encoding='utf-8'))['version']
destination = root / 'dist' / f'essentials-{version}.zip'
destination.parent.mkdir(exist_ok=True)
with ZipFile(destination, 'w', ZIP_DEFLATED) as archive:
    for file in sorted((root / 'extension').rglob('*')):
        if file.is_file():
            archive.write(file, file.relative_to(root / 'extension'))
print(destination)
