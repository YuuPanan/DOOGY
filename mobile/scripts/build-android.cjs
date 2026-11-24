const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } = require('node:fs');
const { basename, isAbsolute, join, relative, resolve, sep } = require('node:path');

const sourceFiles = ['App.tsx', 'index.ts', 'app.json', 'app.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json',
  'babel.config.js', 'babel.config.cjs', 'metro.config.js', 'metro.config.cjs', 'react-native.config.js',
  'src', 'assets', 'plugins', 'scripts/expo.cjs', 'node_modules'];
const publicUrls = ['EXPO_PUBLIC_API_URL', 'EXPO_PUBLIC_CN_API_URL', 'EXPO_PUBLIC_GLOBAL_API_URL'];
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const inside = (root, target) => { const path = relative(root, target); return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };

function parseArgs(args) {
  const options = { qa: false };
  for (const arg of args) {
    if (arg === '--qa' && !options.qa) options.qa = true;
    else if (!arg || arg.startsWith('-') || options.buildRoot) throw new Error('Usage: node scripts/build-android.cjs [--qa] [short-ascii-build-root]');
    else options.buildRoot = arg;
  }
  return options;
}

function buildEnvironment(input) {
  for (const name of ['JAVA_HOME', 'ANDROID_HOME']) {
    if (!input[name] || !existsSync(input[name]) || !statSync(input[name]).isDirectory()) throw new Error(`${name} is missing or invalid. Configure JAVA_HOME for JDK 17 and ANDROID_HOME for SDK 37; see docs/android-toolchain.md.`);
  }
  const env = Object.fromEntries(Object.entries(input).filter(([name]) => !/^EXPO_PUBLIC_/i.test(name) && name.toUpperCase() !== 'NODE_PATH'));
  for (const name of publicUrls) {
    const entry = Object.entries(input).find(([key]) => key.toUpperCase() === name), value = entry?.[1]?.trim();
    if (!value) continue;
    let url;
    try { url = new URL(value); } catch { throw new Error(`${name} must be a public HTTP(S) server root without credentials.`); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error(`${name} must be a public HTTP(S) server root without credentials, paths or queries.`);
    env[name] = value;
  }
  return { ...env, APP_VARIANT: 'preview', EXPO_PUBLIC_ALLOW_LOCAL_HTTP: '1', EXPO_NO_DOTENV: '1', EXPO_NO_TELEMETRY: '1', CI: '1', NODE_ENV: 'production' };
}

function copySource(source, target) {
  const accept = file => {
    const path = relative(source, file).split(sep).join('/'), name = basename(file);
    if (/^\.env/i.test(name) || /^\.?npmrc$/i.test(name) || /\.(?:keystore|jks|p8|p12|key|pem|mobileprovision|apk|aab|tsbuildinfo)$/i.test(name)) return false;
    if (/(?:^|\/)(?:\.gradle|\.cxx|\.kotlin|\.cache)(?:\/|$)/.test(path) || /\/android\/build(?:\/|$)/.test(path)) return false;
    if (/^node_modules\/(?:@react-native\/gradle-plugin|expo-modules-autolinking\/android\/expo-gradle-plugin|expo-modules-core\/expo-module-gradle-plugin|expo-dev-launcher\/expo-dev-launcher-gradle-plugin)\/(?:.*\/)?build(?:\/|$)/.test(path)) return false;
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Linked input is not supported in the isolated build: ${path}`);
    return true;
  };
  for (const name of sourceFiles) if (existsSync(join(source, name))) cpSync(join(source, name), join(target, name), { recursive: true, force: false, errorOnExist: true, filter: accept });
}

function runCommand(stage, file, args, options) {
  console.log(`[ANDROID] ${stage}`);
  const result = basename(file) === 'gradlew.bat'
    ? spawnSync(options.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `gradlew.bat ${args.join(' ')}`], { ...options, stdio: 'inherit', windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync(file, args, { ...options, stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(`${stage} could not start: ${result.error.message}`);
  return result.status;
}

function buildAndroid({ sourceRoot = resolve(__dirname, '..'), buildRoot = 'E:\\AndroidDev\\b', env: input = process.env, qa = false } = {}, run = runCommand) {
  if (typeof qa !== 'boolean') throw new Error('QA mode must be a boolean.');
  const requestedAbis = qa ? ['arm64-v8a', 'x86_64'] : ['arm64-v8a'];
  const source = realpathSync(sourceRoot), root = resolve(buildRoot), env = buildEnvironment(input);
  if (!/^[\x20-\x7e]+$/.test(root) || /[%!^&|<>"()]/.test(root) || inside(source, root)) throw new Error('Build root must be a separate, short ASCII path without shell metacharacters.');
  const lockPath = join(source, 'package-lock.json'), installedPath = join(source, 'node_modules', '.package-lock.json');
  if (!existsSync(lockPath) || !existsSync(installedPath)) throw new Error('Locked node_modules is required. Install dependencies separately before building; this command never installs them.');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')), installed = JSON.parse(readFileSync(installedPath, 'utf8'));
  for (const [name, item] of Object.entries(installed.packages ?? {})) if (!lock.packages?.[name] || lock.packages[name].version !== item.version) throw new Error('Installed dependency versions do not match package-lock.json.');
  const lockHash = sha256(lockPath), started = new Date().toISOString();
  mkdirSync(root, { recursive: true });
  const actualRoot = realpathSync(root);
  if (!/^[\x20-\x7e]+$/.test(actualRoot) || inside(source, actualRoot)) throw new Error('Resolved build root must remain ASCII and outside the source project.');
  const work = mkdtempSync(join(actualRoot, 'dgy-'));
  console.log(`[ANDROID] Isolated build: ${work}`);
  try {
    copySource(source, work);
    if (sha256(lockPath) !== lockHash || sha256(join(work, 'package-lock.json')) !== lockHash) throw new Error('Dependency lock changed during the copy; start a new build.');
    const tsc = join(work, 'node_modules', 'typescript', 'bin', 'tsc'), expo = join(work, 'scripts', 'expo.cjs');
    if (!existsSync(tsc) || !existsSync(expo)) throw new Error('Copied TypeScript/Expo entry is missing; dependencies were not installed by this command.');
    const steps = [];
    function step(stage, file, args, cwd = work) {
      const code = run(stage, file, args, { cwd, env });
      steps.push({ stage, exit_code: code });
      if (code !== 0) throw new Error(`${stage} failed (exit ${code ?? 'signal'}). No APK will be delivered.`);
    }
    step('check', process.execPath, [tsc, '--noEmit']);
    step('prebuild', process.execPath, [expo, 'prebuild', '--platform', 'android', '--no-install']);
    const android = join(work, 'android'), gradlew = join(android, 'gradlew.bat'), gradleFile = join(android, 'app', 'build.gradle');
    if (!existsSync(gradlew) || !existsSync(gradleFile)) throw new Error('Fresh prebuild did not produce the Android project.');
    const gradle = readFileSync(gradleFile, 'utf8');
    if (!/applicationId\s+["']com\.doogy\.mobile\.preview["']/.test(gradle) || !/\brelease\s*\{[^}]*\bsigningConfig\s+signingConfigs\.debug\b/.test(gradle)) throw new Error('Expected preview package and release debug-test signing configuration were not generated.');
    step('gradle', gradlew, [':app:assembleRelease', `-PreactNativeArchitectures=${requestedAbis.join(',')}`, '-Pexpo.android.cmakeObjectPathMax=240', '--no-daemon', '--max-workers=2', '--console=plain'], android);
    const apk = join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
    if (!existsSync(apk) || lstatSync(apk).isSymbolicLink() || !statSync(apk).isFile() || !statSync(apk).size || !inside(work, realpathSync(apk))) throw new Error('This build did not produce a non-empty APK at its expected isolated path.');
    const digest = sha256(apk), size = statSync(apk).size;
    const artifacts = join(actualRoot, 'artifacts'); mkdirSync(artifacts, { recursive: true });
    const destination = join(artifacts, basename(work)); mkdirSync(destination);
    const output = join(destination, qa ? 'doogy-preview-qa-arm64-x86_64.apk' : 'doogy-preview-arm64.apk'); copyFileSync(apk, output, constants.COPYFILE_EXCL);
    if (sha256(output) !== digest) throw new Error('Delivered APK does not match this build output.');
    const receipt = { format: 'doogy-android-build-v1', started_at: started, completed_at: new Date().toISOString(), variant: 'preview', qa, requested_abis: requestedAbis,
      ...(!qa ? { requested_abi: 'arm64-v8a' } : {}),
      package_id: 'com.doogy.mobile.preview', signing_configuration: 'debug_test_key_not_production', independent_signature_verification: 'not_performed',
      package_lock_sha256: lockHash, build_directory: work, apk: output, size_bytes: size, sha256: digest, steps };
    writeFileSync(join(destination, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(`[ANDROID] Test-signed preview APK: ${output}\n[ANDROID] SHA256: ${digest}`);
    return receipt;
  } catch (error) { throw new Error(`${error.message}\nIsolated files retained for inspection: ${work}`); }
}

module.exports = { buildAndroid, parseArgs };
if (require.main === module) {
  try {
    buildAndroid(parseArgs(process.argv.slice(2)));
  } catch (error) { console.error(`[ANDROID] ${error.message}`); process.exitCode = 1; }
}
