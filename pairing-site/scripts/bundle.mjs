import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { 'index.html':'text/html', 'app.js':'text/javascript', 'base.css':'text/css' };

export async function bundleWorker() {
  const assets = {};
  for (const [file,type] of Object.entries(types)) {
    const route = file === 'index.html' ? '/admin' : '/admin/' + file;
    assets[route] = [type, await readFile(new URL('../admin/' + file, import.meta.url),'utf8')];
  }
  const prefix = 'const assets = ' + JSON.stringify(assets) + ';\n';
  const wrapper = await readFile(new URL('./entry.template.js',import.meta.url),'utf8');
  const result = await build({stdin:{contents:prefix+wrapper,resolveDir:root,sourcefile:'entry.js'},bundle:true,platform:'browser',format:'esm',target:'es2022',write:false});
  return result.outputFiles[0].contents;
}
