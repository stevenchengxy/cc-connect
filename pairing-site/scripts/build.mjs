import { mkdir, cp, readFile } from 'node:fs/promises';
const source = new URL('../',import.meta.url);
const entry = path => new URL(path,source);
const manifest = JSON.parse(await readFile(entry('.openai/hosting.json'),'utf8'));
if (manifest.d1 !== 'DB') throw Error('Set the DB binding in .openai/hosting.json');
for (const dir of ['dist/server','dist/.openai']) await mkdir(entry(dir),{recursive:true});
await cp(entry('worker/index.js'),entry('dist/server/index.js'));
await cp(entry('.openai/hosting.json'),entry('dist/.openai/hosting.json'));
await cp(entry('drizzle'),entry('dist/.openai/drizzle'),{recursive:true});
