const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  collectActiveShellLines,
  countInvariantMatches,
  invariants,
} = require('../verifyInstaller');

const verifierPath = path.join(__dirname, '..', 'verifyInstaller.js');
const fixturePath = path.join(
  __dirname,
  '..',
  '__fixtures__',
  'verify-installer',
  'ignored-occurrences.sh',
);

test('installer invariant matching ignores comments, quoted text, and heredocs', () => {
  const source = fs.readFileSync(fixturePath, 'utf8');
  const activeLines = collectActiveShellLines(source);

  for (const { label, matcher, expected } of invariants) {
    assert.equal(
      countInvariantMatches(activeLines, matcher),
      expected,
      label,
    );
  }
});

test('shell syntax failures identify the specific file', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'daftcitadel-installer-test-'),
  );
  const scriptsDirectory = path.join(temporaryRoot, 'scripts');
  fs.mkdirSync(scriptsDirectory);
  fs.copyFileSync(fixturePath, path.join(scriptsDirectory, 'daftcitadel.sh'));
  fs.writeFileSync(
    path.join(scriptsDirectory, 'rvictl-capture.sh'),
    '#!/usr/bin/env bash\nif true; then\n',
  );

  try {
    const result = spawnSync(process.execPath, [verifierPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DAFT_CITADEL_REPO_ROOT: temporaryRoot,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /scripts\/rvictl-capture\.sh/);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});
