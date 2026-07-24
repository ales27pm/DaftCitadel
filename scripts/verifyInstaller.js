#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const installerPath = path.join(rootDir, 'scripts', 'daftcitadel.sh');
const shellFiles = [
  path.join('scripts', 'daftcitadel.sh'),
  path.join('scripts', 'rvictl-capture.sh'),
];

const syntaxCheck = spawnSync('bash', ['-n', ...shellFiles], {
  cwd: rootDir,
  stdio: 'inherit',
});

if (syntaxCheck.error) {
  console.error(`Installer syntax check could not start: ${syntaxCheck.error.message}`);
  process.exit(1);
}
if (syntaxCheck.status !== 0) {
  console.error(`Installer syntax check failed with exit code ${syntaxCheck.status ?? 'unknown'}.`);
  process.exit(syntaxCheck.status ?? 1);
}

const source = fs.readFileSync(installerPath, 'utf8');
const invariants = [
  {
    label: 'DISTRHO package installation step',
    needle: 'run_step "Install DISTRHO Ports packages" apt_install_available dpf-plugins',
    expected: 1,
  },
  {
    label: 'Tyrell helper invocation',
    needle: 'run_step "Install Tyrell N6" install_tyrell_n6',
    expected: 1,
  },
  {
    label: 'OB-Xd helper invocation',
    needle: 'run_step "Install OB-Xd" install_obxd',
    expected: 1,
  },
  {
    label: 'Tyrell source declaration',
    needle: 'TYRELL_PRIMARY_URL=',
    expected: 1,
  },
  {
    label: 'OB-Xd target version declaration',
    needle: 'obxd_target_version=',
    expected: 1,
  },
];

for (const { label, needle, expected } of invariants) {
  const actual = source.split(needle).length - 1;
  if (actual !== expected) {
    console.error(`${label} must appear ${expected} time(s); found ${actual}.`);
    process.exit(1);
  }
}

process.stdout.write('Installer integrity checks passed.\n');
