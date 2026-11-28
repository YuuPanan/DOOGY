const { strict: assert } = require('node:assert');
const { spawnSync } = require('node:child_process');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, delimiter, dirname, join, resolve } = require('node:path');
const { test } = require('node:test');

const windows = process.platform === 'win32', prefix = 'doogy-mobile-start-';

function withSandbox(work) {
  const temporaryRoot = realpathSync(tmpdir()), ownedRoot = mkdtempSync(join(temporaryRoot, prefix));
  try {
    const sandbox = join(ownedRoot, 'app with spaces'); mkdirSync(sandbox);
    copyFileSync(resolve(__dirname, '../start.bat'), join(sandbox, 'start.bat'));
    writeFileSync(join(sandbox, 'npm.cmd'), [
      '@echo off',
      '>>"%DOOGY_START_TEST_LOG%" echo %*',
      'if /i "%~1"=="ci" exit /b %DOOGY_START_TEST_CI_CODE%',
      'if /i "%~1"=="run" if /i "%~2"=="check" exit /b %DOOGY_START_TEST_CHECK_CODE%',
      'if /i "%~1"=="start" exit /b %DOOGY_START_TEST_START_CODE%',
      'exit /b 89', '',
    ].join('\r\n'));
    work(sandbox);
  } finally {
    // Never pass a computed generic temp path to recursive deletion. Validate the
    // exact directory created above, including its real path and strict prefix.
    const target = resolve(ownedRoot);
    assert.equal(realpathSync(target), target);
    assert.equal(dirname(target), temporaryRoot);
    assert.match(basename(target), /^doogy-mobile-start-[A-Za-z0-9]{6}$/);
    assert.ok(basename(target).startsWith(prefix));
    rmSync(target, { recursive: true, force: false });
  }
}

function run(sandbox, { dependencies = true, ci = 0, check = 0, start = 0 } = {}) {
  if (dependencies) mkdirSync(join(sandbox, 'node_modules'));
  const log = join(sandbox, 'npm-calls.log'), env = {};
  for (const [name, value] of Object.entries(process.env)) if (name.toLowerCase() !== 'path') env[name] = value;
  const originalPath = Object.entries(process.env).find(([name]) => name.toLowerCase() === 'path')?.[1] ?? '';
  Object.assign(env, { PATH: [sandbox, dirname(process.execPath), originalPath].join(delimiter),
    DOOGY_START_TEST_LOG: log, DOOGY_START_TEST_CI_CODE: String(ci), DOOGY_START_TEST_CHECK_CODE: String(check), DOOGY_START_TEST_START_CODE: String(start) });
  const command = `""${join(sandbox, 'start.bat')}""`;
  const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
    cwd: sandbox, env, encoding: 'utf8', input: '', windowsHide: true, windowsVerbatimArguments: true, timeout: 5000,
  });
  assert.equal(result.error, undefined, 'Sandbox BAT must exit within five seconds'); assert.equal(result.signal, null);
  return { code: result.status, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [] };
}

test('Windows BAT stops after a failed check and never starts stale code', { skip: !windows, timeout: 10000 }, () => withSandbox(sandbox => {
  const result = run(sandbox, { check: 23 });
  assert.equal(result.code, 1); assert.deepEqual(result.calls, ['run check']);
}));

test('Windows BAT stops after dependency installation failure before check or start', { skip: !windows, timeout: 10000 }, () => withSandbox(sandbox => {
  const result = run(sandbox, { dependencies: false, ci: 19 });
  assert.equal(result.code, 1); assert.deepEqual(result.calls, ['ci']);
}));

test('Windows BAT installs missing dependencies, checks, and only then starts', { skip: !windows, timeout: 10000 }, () => withSandbox(sandbox => {
  const result = run(sandbox, { dependencies: false });
  assert.equal(result.code, 0); assert.deepEqual(result.calls, ['ci', 'run check', 'start']);
}));

test('Windows BAT skips install for an existing dependency directory and propagates the start exit code', { skip: !windows, timeout: 10000 }, () => withSandbox(sandbox => {
  const result = run(sandbox, { start: 37 });
  assert.equal(result.code, 37); assert.deepEqual(result.calls, ['run check', 'start']);
}));
