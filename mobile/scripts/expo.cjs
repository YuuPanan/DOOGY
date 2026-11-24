const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const args = process.argv.slice(2);
const variant = process.env.APP_VARIANT || (args[0] === 'export' ? 'preview' : 'development');
const child = spawn(process.execPath, [require.resolve('expo/bin/cli'), ...args], {
  cwd: resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true,
  env: { ...process.env, APP_VARIANT: variant, EXPO_PUBLIC_ALLOW_LOCAL_HTTP: ['development', 'preview'].includes(variant) ? '1' : '0' },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
process.once('SIGINT', () => child.kill('SIGINT'));
process.once('SIGTERM', () => child.kill('SIGTERM'));
