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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jianping-native-'));
  try {
    const slices = ['arm64', 'x86_64'].map((arch) => {
      const binary = path.join(tmp, arch);
      run('xcrun', ['swiftc', '-O', '-target', arch + '-apple-macos12.0',
        path.join(sources, 'MacInput.swift'), '-o', binary]);
      return binary;
    });
    const binary = path.join(output, 'jianping-input');
    run('xcrun', ['lipo', '-create', ...slices, '-output', binary]);
    run('/usr/bin/codesign', ['-s', '-', '--force', '--identifier', 'app.jianping.input', binary]);
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
