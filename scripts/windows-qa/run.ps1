# Requires a disposable GitHub-hosted Windows VM. Checks only an owned test window.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CC_QA_RUNNER_CLASS -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Use the manual GitHub-hosted Windows QA workflow.'
}
function Write-Summary([string] $status) {
  Write-Host $status
  Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value $status
}
if ((Get-Process -Id $PID).SessionId -eq 0 -or -not [Environment]::UserInteractive) {
  Write-Summary 'SKIPPED — the runner does not have an interactive user desktop.'
  exit 0
}
$root = Resolve-Path (Join-Path $PSScriptRoot '../..')
$tempDir = Join-Path $env:RUNNER_TEMP ('cc-native-qa-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir | Out-Null
try {
  $version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
  if ($env:CC_QA_RELEASE -eq '0.3.2') { $version = '0.3.2' }
  elseif ($env:CC_QA_RELEASE -and $env:CC_QA_RELEASE -ne 'current') { throw 'Unsupported QA release choice.' }
  if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
  $name = "CC-Connect-$version-x64.exe"
  $base = "https://github.com/stevenchengxy/cc-connect/releases/download/v$version"
  Invoke-WebRequest "$base/latest.json" -OutFile (Join-Path $tempDir 'latest.json')
  Invoke-WebRequest "$base/$name" -OutFile (Join-Path $tempDir $name)
  Push-Location $root
  try {
    @'
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto');
const assert=require('node:assert/strict');
const dir=process.argv[2];
const version=process.argv[3];
const release=require('./src/updater.cjs').verifyManifest(JSON.parse(fs.readFileSync(path.join(dir,'latest.json'))),fs.readFileSync('src/update-public-key.pem'));
assert.equal(release.version,version);
const windows=release.files.windows;
assert.equal(windows.name,'CC-Connect-'+version+'-x64.exe');
const installer=fs.readFileSync(path.join(dir, windows.name));
assert.equal(installer.length,windows.size);
assert.equal(crypto.createHash('sha256').update(installer).digest('hex'),windows.sha256);
console.log('Verified signed Windows release '+version);
'@ | node - $tempDir $version
    if ($LASTEXITCODE -ne 0) { throw 'Release verification failed.' }
  } finally { Pop-Location }
  # Extract only the application archive and helper. The installer never runs.
  & 7z.exe e (Join-Path $tempDir $name) '$PLUGINSDIR/app-64.7z' "-o$tempDir" -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not extract signed application archive.' }
  & 7z.exe e (Join-Path $tempDir 'app-64.7z') 'resources/native/bin/jianping-input.exe' "-o$tempDir" -y | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $tempDir 'jianping-input.exe'))) { throw 'Release native helper missing.' }
  $fixture = Join-Path $tempDir 'NativeWindowCheck.exe'
  $compiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
  & $compiler '/nologo' '/target:exe' '/platform:x64' '/reference:System.Windows.Forms.dll' '/reference:System.Drawing.dll' "/out:$fixture" (Join-Path $PSScriptRoot 'NativeWindowCheck.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile the fixed test window.' }
  & $fixture
  $result = $LASTEXITCODE
  if ($result -eq 77) { Write-Summary 'SKIPPED — the test window could not securely own keyboard focus, the mouse target or visible pixels.' }
  elseif ($result -ne 0) { throw 'Windows native keyboard/mouse and pixel acceptance failed.' }
  else { Write-Summary 'PASS — the signed release helper delivered one center click and one KeyA to the test form. Windows pixel capture confirmed both visual transitions.' }
} finally {
  if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
exit 0
