const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sources = path.join(__dirname, '..', 'native');
const output = path.join(sources, 'bin');
fs.mkdirSync(output, { recursive: true });

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(cmd + ' failed: ' + (result.status ?? result.signal));
}

if (process.platform === 'darwin') {
  const [identity = '-', ...extra] = process.argv.slice(2);
  if (extra.length || (identity !== '-' && !/^[A-F0-9]{40}$/.test(identity))) {
    throw new Error('Expected a signing certificate SHA-1 fingerprint.');
  }
  const signArgs = ['--sign', identity, '--force'];
  if (identity !== '-') signArgs.push('--options', 'runtime', '--timestamp');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jianping-native-'));
  function universal(source, destination, minimum) {
    const slices = ['arm64', 'x86_64'].map(arch => {
      const slice = path.join(tmp, path.basename(source, '.swift') + '-' + arch);
      run('xcrun', ['swiftc', '-O', '-target', arch + '-apple-macos' + minimum,
        path.join(sources, source), '-o', slice]);
      return slice;
    });
    run('xcrun', ['lipo', '-create', ...slices, '-output', destination]);
  }
  try {
    const binary = path.join(output, 'jianping-input');
    universal('MacInput.swift', binary, '12.0');
    run('/usr/bin/codesign', [...signArgs, '--identifier', 'app.jianping.input', binary]);
    const app = path.join(output, 'CC Connect Screen.app');
    const contents = path.join(app, 'Contents');
    fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
    fs.copyFileSync(path.join(sources, 'MacScreen-Info.plist'), path.join(contents, 'Info.plist'));
    fs.copyFileSync(path.join(__dirname, '../build/icon.icns'), path.join(contents, 'Resources', 'icon.icns'));
    universal('MacScreen.swift', path.join(contents, 'MacOS', 'cc-connect-screen'), '12.3');
    run('/usr/bin/codesign', [...signArgs, app]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
} else if (process.platform === 'win32') {
  const framework = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  run(framework, ['/nologo', '/optimize+', '/platform:anycpu', '/codepage:65001',
    '/out:' + path.join(output, 'jianping-input.exe'), path.join(sources, 'WindowsInput.cs')]);
} else {
  console.log('当前系统仅支持观看远程桌面。');
}
