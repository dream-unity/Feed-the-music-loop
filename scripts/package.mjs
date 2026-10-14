import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '_site');
const entries = ['index.html', 'style.css', 'icon.svg', 'icons', 'manifest.webmanifest', '.nojekyll', 'src'];
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of entries) await cp(resolve(root, entry), resolve(output, entry), { recursive: true, filter: path => !path.endsWith('.md') });
async function files(dir) {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else result.push(relative(output, path).replaceAll('\\', '/'));
  }
  return result.sort();
}
const assets = await files(output);
const hash = createHash('sha256');
const integrity = {};
for (const path of assets) {
  const bytes = await readFile(resolve(output, path));
  hash.update(path); hash.update(bytes);
  integrity['./' + path] = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
}
const template = await readFile(resolve(root, 'sw.js'), 'utf8');
hash.update(template);
const revision = hash.digest('hex').slice(0, 16);
const worker = template.replace('"__BUILD_REVISION__"', JSON.stringify(revision))
  .replace('/* __BUILD_ASSETS__ */', assets.map(path => JSON.stringify('./' + path)).join(',\n  '))
  .replace('/* __BUILD_INTEGRITY__ */', Object.entries(integrity).map(([path, value]) => `${JSON.stringify(path)}: ${JSON.stringify(value)}`).join(',\n  '));
await writeFile(resolve(output, 'sw.js'), worker);
console.log(`Packaged ${assets.length + 1} static files; revision ${revision}.`);
