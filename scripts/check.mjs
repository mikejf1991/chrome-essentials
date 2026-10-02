import { readFile, readdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const extension = join(root, 'extension');
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.minimum_chrome_version !== '150') throw new Error('Unexpected manifest target');
for (const path of [manifest.background.service_worker, manifest.options_page, ...Object.values(manifest.icons)]) {
  await access(resolve(extension, path));
}
for (const file of await readdir(extension)) {
  if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', join(extension, file)], { stdio: 'inherit' });
}
const html = await readFile(join(extension, manifest.options_page), 'utf8');
for (const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  if (/^(https?:|data:|javascript:)/.test(match[1])) throw new Error('Unexpected remote/inline resource');
  await access(resolve(extension, match[1]));
}
if (manifest.host_permissions || manifest.content_scripts || manifest.externally_connectable) {
  throw new Error('Unexpected website access or external surface');
}
console.log('Manifest, extension JavaScript, local resources, and permission boundary checked.');
