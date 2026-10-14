import { readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
async function walk(dir) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, item.name);
    if (item.isDirectory()) await walk(path);
    else if (item.name.endsWith('.mjs')) files.push(path);
  }
}
await walk(resolve(root, 'src'));
await walk(resolve(root, 'scripts'));
await walk(resolve(root, 'tests'));
files.push(resolve(root, 'sw.js'));
for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${path}`);
  const source = await readFile(path, 'utf8');
  // Browser test callbacks intentionally resolve imports against the served page.
  const references = path.endsWith('browser.spec.mjs') ? [] : [...source.matchAll(/(?:from\s*|import\s*\(\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g)];
  for (const reference of references) await access(resolve(dirname(path), reference[1]));
}
const html = await readFile(resolve(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) await access(resolve(root, match[1]));
JSON.parse(await readFile(resolve(root, 'manifest.webmanifest'), 'utf8'));
JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
console.log(`Checked syntax and local module references in ${files.length} files.`);
