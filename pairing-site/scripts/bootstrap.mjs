#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';

const usage = 'Usage:\n  node pairing-site/scripts/bootstrap.mjs <new-private-file>\n  node pairing-site/scripts/bootstrap.mjs setup <https-origin> <private-file> <admin-username> [--password-stdin]';

async function passwordFromTerminal() {
  if (!stdin.isTTY || !stdout.isTTY) throw Error('Use a local terminal or pipe your password manager output with --password-stdin.');
  const silent = new Writable({write(chunk,encoding,done){done();}});
  const prompt = createInterface({input:stdin,output:silent,terminal:true});
  const interrupted = new AbortController();
  prompt.once('SIGINT',()=>interrupted.abort());
  try {
    stdout.write('New admin password: ');
    const first = await prompt.question('',{signal:interrupted.signal});
    stdout.write('\nConfirm admin password: ');
    const second = await prompt.question('',{signal:interrupted.signal});
    if (first !== second) throw Error('The passwords did not match.');
    return first;
  } finally { prompt.close(); stdout.write('\n'); }
}

async function passwordFromPipe() {
  if (stdin.isTTY) throw Error('Use --password-stdin with a private pipe from a password manager.');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of stdin) {
    bytes += chunk.length;
    if (bytes > 1024) throw Error('Invalid password length');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)).replace(/\r?\n$/,'');
}

async function setup(origin,file,username,fromPipe) {
  let url;
  try { url = new URL(origin); } catch { throw Error('Enter the HTTPS origin of your own Worker.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw Error('Enter the HTTPS origin of your own Worker.');
  }
  if (!/^[a-z0-9][a-z0-9_.-]{2,39}$/i.test(username)) throw Error('Invalid admin username.');
  const info = await stat(file);
  if (!info.isFile() || info.size > 64 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    throw Error('Use the private setup file created by this tool.');
  }
  const bootstrap = (await readFile(file,'utf8')).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(bootstrap)) throw Error('Invalid setup file.');
  const password = await (fromPipe ? passwordFromPipe() : passwordFromTerminal());
  if (password.length<12 || password.length>128) throw Error('Use a password of 12 to 128 characters.');
  const response = await fetch(new URL('/v1/auth/bootstrap',url),{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(20_000),
    headers:{'content-type':'application/json'},body:JSON.stringify({username,password,bootstrap})
  });
  if (response.status !== 201) throw Error('Setup was not accepted (HTTP '+response.status+'). Check the Worker binding, code, and whether setup was already completed.');
  console.log('Administrator created. Sign in at '+new URL('/admin',url));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'setup') {
    if (args.length !== 4 && !(args.length===5 && args[4]==='--password-stdin')) throw Error(usage);
    return setup(args[1],args[2],args[3],args[4]==='--password-stdin');
  }
  if (args.length!==1 || args[0].startsWith('--')) throw Error(usage);
  const code = randomBytes(32).toString('base64url');
  try { await writeFile(args[0],code+'\n',{flag:'wx',mode:0o600}); }
  catch { throw Error('Could not create a new private setup file. Choose an unused private path.'); }
  console.log('CC_ADMIN_BOOTSTRAP_SHA256='+createHash('sha256').update(code).digest('hex'));
}
try { await main(); }
catch (error) {console.error(error.message);process.exitCode=1;}
