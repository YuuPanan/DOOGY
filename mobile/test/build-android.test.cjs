const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join, resolve } = require('node:path');
const { test } = require('node:test');
const { buildAndroid, parseArgs } = require('../scripts/build-android.cjs');

function fixture() {
  // Tiny owned sandboxes are retained, matching the build entry's no-delete policy.
  const owned = mkdtempSync(join(tmpdir(), 'doogy-apk-test-')), source = join(owned, 'source'), root = join(owned, 'builds');
  function write(path, value) { mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, value); }
  const lock = { lockfileVersion: 3, packages: { 'node_modules/typescript': { version: '6.0.3' } } };
  for (const name of ['App.tsx', 'index.ts', 'app.json', 'app.config.ts', 'package.json', 'tsconfig.json', 'src/screen.tsx', 'assets/image.png', 'plugins/local.cjs', 'scripts/expo.cjs', 'node_modules/typescript/bin/tsc']) write(join(source, name), name);
  write(join(source, 'package-lock.json'), JSON.stringify(lock)); write(join(source, 'node_modules/.package-lock.json'), JSON.stringify(lock));
  for (const name of ['.env', '.env.local', '.env.example', '.npmrc', 'owner.keystore', 'src/private.key', 'plugins/.env.secret', 'node_modules/pkg/.env', 'android/app/build/outputs/apk/release/app-release.apk', 'dist-android/old.js', '.expo/old', '.test-dist/old.js', 'node_modules/pkg/android/build/old', 'node_modules/pkg/android/.cxx/old', 'node_modules/@react-native/gradle-plugin/shared/build/old', 'node_modules/expo-modules-autolinking/android/expo-gradle-plugin/sub/build/old', 'node_modules/expo-dev-launcher/expo-dev-launcher-gradle-plugin/sub/build/old', 'node_modules/pkg/.gradle/old']) write(join(source, name), 'PRIVATE-OR-STALE');
  write(join(source, 'node_modules/expo/build/required.js'), 'DISTRIBUTED-JS');
  const java = join(owned, 'java'), sdk = join(owned, 'sdk'); mkdirSync(java); mkdirSync(sdk);
  const env = { JAVA_HOME: java, ANDROID_HOME: sdk, APP_VARIANT: 'production', EXPO_PUBLIC_ALLOW_LOCAL_HTTP: '0', EXPO_PUBLIC_CN_API_URL: 'http://192.168.1.2:3000', EXPO_PUBLIC_SECRET: 'DO-NOT-COPY', NODE_PATH: source };
  const calls = [];
  function runner(fail, artifact = 'nonempty synthetic APK for orchestration tests', qa = false) {
    return (stage, command, args, options) => {
      calls.push({ stage, command, args, ...options });
      assert.equal(options.env.APP_VARIANT, 'preview'); assert.equal(options.env.EXPO_NO_DOTENV, '1'); assert.equal(options.env.EXPO_PUBLIC_ALLOW_LOCAL_HTTP, '1');
      assert.equal(options.env.EXPO_PUBLIC_SECRET, undefined); assert.equal(options.env.NODE_PATH, undefined); assert.equal(options.env.EXPO_PUBLIC_CN_API_URL, env.EXPO_PUBLIC_CN_API_URL);
      if (stage === 'check') assert.equal(existsSync(join(options.cwd, 'android')), false);
      if (stage === 'prebuild' && fail !== stage) {
        assert.equal(args[0], join(options.cwd, 'scripts/expo.cjs')); assert.deepEqual(args.slice(1), ['prebuild', '--platform', 'android', '--no-install']);
        write(join(options.cwd, 'android/gradlew.bat'), '@echo off');
        write(join(options.cwd, 'android/app/build.gradle'), "android { defaultConfig { applicationId 'com.doogy.mobile.preview' } buildTypes { release { signingConfig signingConfigs.debug } } }");
      }
      if (stage === 'gradle') {
        assert.deepEqual(args, [':app:assembleRelease', qa ? '-PreactNativeArchitectures=arm64-v8a,x86_64' : '-PreactNativeArchitectures=arm64-v8a', '-Pexpo.android.cmakeObjectPathMax=240', '--no-daemon', '--max-workers=2', '--console=plain']);
        if (artifact !== null) write(join(options.cwd, 'app/build/outputs/apk/release/app-release.apk'), artifact);
      }
      return fail === stage ? 23 : 0;
    };
  }
  return { owned, source, root, env, calls, runner, write, options: { sourceRoot: source, buildRoot: root, env } };
}

test('isolated build filters secrets/generated outputs, keeps distributed JS and delivers only its fresh result', () => {
  const f = fixture(), original = readFileSync(join(f.source, '.env')), receipt = buildAndroid(f.options, f.runner());
  assert.deepEqual(f.calls.map(row => row.stage), ['check', 'prebuild', 'gradle']);
  const work = receipt.build_directory;
  for (const name of ['.env', '.env.local', '.env.example', '.npmrc', 'owner.keystore', 'src/private.key', 'plugins/.env.secret', 'node_modules/pkg/.env', 'dist-android', '.expo', '.test-dist', 'node_modules/pkg/android/build', 'node_modules/pkg/android/.cxx', 'node_modules/@react-native/gradle-plugin/shared/build', 'node_modules/expo-modules-autolinking/android/expo-gradle-plugin/sub/build', 'node_modules/expo-dev-launcher/expo-dev-launcher-gradle-plugin/sub/build', 'node_modules/pkg/.gradle']) assert.equal(existsSync(join(work, name)), false, name);
  assert.equal(readFileSync(join(work, 'node_modules/expo/build/required.js'), 'utf8'), 'DISTRIBUTED-JS');
  assert.deepEqual(readFileSync(join(f.source, '.env')), original); assert.equal(f.env.APP_VARIANT, 'production');
  assert.equal(receipt.sha256, createHash('sha256').update(readFileSync(receipt.apk)).digest('hex'));
  assert.equal(receipt.independent_signature_verification, 'not_performed');
  assert.equal(receipt.qa, false); assert.equal(receipt.requested_abi, 'arm64-v8a');
  assert.deepEqual(receipt.requested_abis, ['arm64-v8a']); assert.equal(basename(receipt.apk), 'doogy-preview-arm64.apk');
  assert.deepEqual(JSON.parse(readFileSync(join(resolve(receipt.apk, '..'), 'receipt.json'), 'utf8')), receipt);
});

test('QA mode requests only arm64 and x86_64 and delivers a distinct APK and receipt', () => {
  const f = fixture(), normal = buildAndroid(f.options, f.runner());
  const receipt = buildAndroid({ ...f.options, qa: true }, f.runner(undefined, 'nonempty synthetic QA APK', true));
  assert.equal(receipt.qa, true); assert.deepEqual(receipt.requested_abis, ['arm64-v8a', 'x86_64']);
  assert.equal(Object.hasOwn(receipt, 'requested_abi'), false);
  assert.equal(basename(receipt.apk), 'doogy-preview-qa-arm64-x86_64.apk');
  assert.equal(readFileSync(normal.apk, 'utf8'), 'nonempty synthetic APK for orchestration tests');
  assert.equal(readFileSync(receipt.apk, 'utf8'), 'nonempty synthetic QA APK');
  assert.equal(receipt.sha256, createHash('sha256').update(readFileSync(receipt.apk)).digest('hex'));
  assert.deepEqual(JSON.parse(readFileSync(join(resolve(receipt.apk, '..'), 'receipt.json'), 'utf8')), receipt);
});

test('CLI accepts only the explicit QA flag and one build root', () => {
  assert.deepEqual(parseArgs([]), { qa: false });
  assert.deepEqual(parseArgs(['E:\\AndroidDev\\b']), { qa: false, buildRoot: 'E:\\AndroidDev\\b' });
  assert.deepEqual(parseArgs(['--qa']), { qa: true });
  assert.deepEqual(parseArgs(['--qa', 'E:\\AndroidDev\\b']), { qa: true, buildRoot: 'E:\\AndroidDev\\b' });
  assert.deepEqual(parseArgs(['E:\\AndroidDev\\b', '--qa']), { qa: true, buildRoot: 'E:\\AndroidDev\\b' });
  for (const args of [['--unknown'], ['--qa=true'], ['--qa', '--qa'], ['--'], ['-PreactNativeArchitectures=x86'], ['--qa', '--abi', 'x86'], ['one', 'two'], ['']]) assert.throws(() => parseArgs(args), /Usage:/);
});

test('QA mode rejects non-boolean programmatic options before any build work', () => {
  const f = fixture();
  for (const qa of ['true', 1, null, ['arm64-v8a', 'x86_64']]) assert.throws(() => buildAndroid({ ...f.options, qa }, f.runner()), /must be a boolean/);
  assert.equal(f.calls.length, 0); assert.equal(existsSync(f.root), false);
});

for (const stage of ['check', 'prebuild', 'gradle']) test(`${stage} failure stops subsequent commands and never replaces a historical APK`, () => {
  const f = fixture(), old = join(f.root, 'artifacts/previous/old.apk'); f.write(old, 'previous-success');
  assert.throws(() => buildAndroid(f.options, f.runner(stage)), new RegExp(`${stage} failed`));
  assert.deepEqual(f.calls.map(row => row.stage), ['check', 'prebuild', 'gradle'].slice(0, ['check', 'prebuild', 'gradle'].indexOf(stage) + 1));
  assert.equal(readFileSync(old, 'utf8'), 'previous-success'); assert.deepEqual(readdirSync(join(f.root, 'artifacts')), ['previous']);
});

for (const artifact of [null, '']) test(`successful command without ${artifact === null ? 'an' : 'a nonempty'} APK cannot deliver`, () => {
  const f = fixture(); assert.throws(() => buildAndroid(f.options, f.runner(undefined, artifact)), /non-empty APK/);
  assert.equal(existsSync(join(f.root, 'artifacts')), false);
});

test('missing toolchain, mismatched installed lock and invalid public URLs fail before commands', () => {
  const f = fixture();
  assert.throws(() => buildAndroid({ ...f.options, env: { ...f.env, JAVA_HOME: '' } }, f.runner()), /JAVA_HOME/);
  assert.throws(() => buildAndroid({ ...f.options, env: { ...f.env, ANDROID_HOME: '' } }, f.runner()), /ANDROID_HOME/);
  assert.throws(() => buildAndroid({ ...f.options, env: { ...f.env, EXPO_PUBLIC_CN_API_URL: 'https://user:private-password@example.invalid' } }, f.runner()), error => !error.message.includes('private-password') && /EXPO_PUBLIC_CN_API_URL/.test(error.message));
  f.write(join(f.source, 'node_modules/.package-lock.json'), JSON.stringify({ packages: { 'node_modules/typescript': { version: 'other' } } }));
  assert.throws(() => buildAndroid(f.options, f.runner()), /do not match/); assert.equal(f.calls.length, 0);
});

test('non-ASCII or source-contained build roots are rejected without starting a command', () => {
  const f = fixture(); assert.throws(() => buildAndroid({ ...f.options, buildRoot: join(f.root, '中文') }, f.runner()), /ASCII/);
  assert.throws(() => buildAndroid({ ...f.options, buildRoot: join(f.source, 'builds') }, f.runner()), /separate/); assert.equal(f.calls.length, 0);
});

test('repeated successful runs use distinct build and delivery directories and preserve history', () => {
  const f = fixture(), first = buildAndroid(f.options, f.runner()), second = buildAndroid(f.options, f.runner());
  assert.notEqual(first.build_directory, second.build_directory); assert.notEqual(first.apk, second.apk);
  assert.equal(existsSync(first.apk), true); assert.equal(existsSync(second.apk), true);
  assert.equal(readdirSync(join(f.root, 'artifacts')).length, 2);
});

test('Windows process bridge runs fresh JS and batch stubs from a path with spaces and stops on exit 17', { skip: process.platform !== 'win32' }, () => {
  const f = fixture(), root = join(f.root, 'with spaces');
  f.write(join(f.source, 'node_modules/typescript/bin/tsc'), "require('node:fs').writeFileSync('check-invoked.txt', process.argv.slice(2).join(' '));");
  const bat = '@echo off\r\n> "..\\gradle-args.txt" echo %*\r\nexit /b 17\r\n';
  const gradle = "android { defaultConfig { applicationId 'com.doogy.mobile.preview' } buildTypes { release { signingConfig signingConfigs.debug } } }";
  f.write(join(f.source, 'scripts/expo.cjs'), `const fs = require('node:fs');
fs.writeFileSync('prebuild-invoked.txt', process.argv.slice(2).join(' '));
fs.mkdirSync('android/app', { recursive: true });
fs.writeFileSync('android/gradlew.bat', ${JSON.stringify(bat)});
fs.writeFileSync('android/app/build.gradle', ${JSON.stringify(gradle)});`);
  assert.throws(() => buildAndroid({ ...f.options, buildRoot: root }), /gradle failed \(exit 17\)/);
  const work = join(root, readdirSync(root).find(name => name.startsWith('dgy-')));
  assert.equal(readFileSync(join(work, 'check-invoked.txt'), 'utf8'), '--noEmit');
  assert.equal(readFileSync(join(work, 'prebuild-invoked.txt'), 'utf8'), 'prebuild --platform android --no-install');
  assert.equal(readFileSync(join(work, 'gradle-args.txt'), 'utf8').trim(), ':app:assembleRelease -PreactNativeArchitectures=arm64-v8a -Pexpo.android.cmakeObjectPathMax=240 --no-daemon --max-workers=2 --console=plain');
  assert.equal(existsSync(join(root, 'artifacts')), false);
  assert.equal(existsSync(join(work, 'android/app/build/outputs/apk/release/app-release.apk')), false);
});
