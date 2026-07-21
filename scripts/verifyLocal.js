#!/usr/bin/env node

const { spawnSync } = require('child_process');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const useSanitizers = process.argv.includes('--sanitize');
const hasCmake = spawnSync('cmake', ['--version'], { stdio: 'ignore' }).status === 0;
const nativeScript = hasCmake
  ? useSanitizers
    ? 'native:core:test:sanitize'
    : 'native:core:test'
  : useSanitizers
    ? 'native:core:test:direct:sanitize'
    : 'native:core:test:direct';
const checks = [
  ['Expo Doctor', npmCommand, ['run', 'expo:doctor']],
  ['Formatting', npmCommand, ['run', 'format:check']],
  ['Lint', npmCommand, ['run', 'lint']],
  ['TypeScript', npmCommand, ['run', 'typecheck']],
  ['Jest', npmCommand, ['run', 'test:ci']],
  ['Managed documentation', npmCommand, ['run', 'docs:check']],
  ['Production dependency audit', npmCommand, ['run', 'audit:prod']],
  [
    `${useSanitizers ? 'Native audio core (ASan/UBSan)' : 'Native audio core'}${
      hasCmake ? '' : ' (direct compiler fallback)'
    }`,
    npmCommand,
    ['run', nativeScript],
  ],
];

if (process.platform !== 'win32') {
  checks.splice(7, 0, [
    'Shell syntax',
    'bash',
    ['-n', 'scripts/daftcitadel.sh', 'scripts/rvictl-capture.sh'],
  ]);
}

for (const [label, command, args] of checks) {
  process.stdout.write(`\n==> ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, EXPO_NO_TELEMETRY: '1' },
    stdio: 'inherit',
  });

  if (result.error) {
    console.error(`${label} could not start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? 'unknown'}.`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write('\nAll local verification checks passed.\n');
