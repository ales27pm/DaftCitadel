#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(
  process.env.DAFT_CITADEL_REPO_ROOT || path.join(__dirname, '..'),
);
const installerPath = path.join(rootDir, 'scripts', 'daftcitadel.sh');
const shellFiles = [
  path.join('scripts', 'daftcitadel.sh'),
  path.join('scripts', 'rvictl-capture.sh'),
];

const invariants = [
  {
    label: 'DISTRHO package installation step',
    matcher:
      /^run_step\s+"Install DISTRHO Ports packages"\s+apt_install_available\s+dpf-plugins$/,
    expected: 1,
  },
  {
    label: 'Tyrell helper invocation',
    matcher: /^run_step\s+"Install Tyrell N6"\s+install_tyrell_n6$/,
    expected: 1,
  },
  {
    label: 'OB-Xd helper invocation',
    matcher: /^run_step\s+"Install OB-Xd"\s+install_obxd$/,
    expected: 1,
  },
  {
    label: 'Tyrell source declaration',
    matcher: /^(?:local\s+)?TYRELL_PRIMARY_URL\s*=/,
    expected: 1,
  },
  {
    label: 'OB-Xd target version declaration',
    matcher: /^(?:local\s+)?obxd_target_version\s*=/,
    expected: 1,
  },
];

function stripShellComment(line) {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (
      character === '#' &&
      !inSingleQuote &&
      !inDoubleQuote &&
      (index === 0 || /[\s;&|()]/.test(line[index - 1]))
    ) {
      return line.slice(0, index);
    }
  }

  return line;
}

function findHereDocuments(line) {
  const hereDocuments = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = 0; index < line.length - 1; index += 1) {
    const character = line[index];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (
      character !== '<' ||
      line[index + 1] !== '<' ||
      inSingleQuote ||
      inDoubleQuote ||
      line[index + 2] === '<'
    ) {
      continue;
    }

    let cursor = index + 2;
    let stripTabs = false;
    if (line[cursor] === '-') {
      stripTabs = true;
      cursor += 1;
    }
    while (/\s/.test(line[cursor] ?? '')) {
      cursor += 1;
    }

    let delimiter = '';
    const quote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : null;
    if (quote) {
      cursor += 1;
      while (cursor < line.length && line[cursor] !== quote) {
        delimiter += line[cursor];
        cursor += 1;
      }
    } else {
      while (cursor < line.length && !/[\s;&|()<>]/.test(line[cursor])) {
        delimiter += line[cursor];
        cursor += 1;
      }
    }

    if (delimiter) {
      hereDocuments.push({ delimiter, stripTabs });
    }
    index = cursor;
  }

  return hereDocuments;
}

function collectActiveShellLines(source) {
  const activeLines = [];
  const pendingHereDocuments = [];

  for (const rawLine of source.split(/\r?\n/)) {
    if (pendingHereDocuments.length > 0) {
      const current = pendingHereDocuments[0];
      const candidate = current.stripTabs ? rawLine.replace(/^\t+/, '') : rawLine;
      if (candidate === current.delimiter) {
        pendingHereDocuments.shift();
      }
      continue;
    }

    const withoutComment = stripShellComment(rawLine);
    const normalized = withoutComment.trim();
    if (!normalized) {
      continue;
    }

    activeLines.push(normalized);
    pendingHereDocuments.push(...findHereDocuments(withoutComment));
  }

  return activeLines;
}

function countInvariantMatches(activeLines, matcher) {
  return activeLines.reduce(
    (count, line) => count + (matcher.test(line) ? 1 : 0),
    0,
  );
}

function checkShellSyntax(shellFile) {
  const syntaxCheck = spawnSync('bash', ['-n', shellFile], {
    cwd: rootDir,
    stdio: 'inherit',
  });

  if (syntaxCheck.error) {
    console.error(
      `Installer syntax check could not start for ${shellFile}: ${syntaxCheck.error.message}`,
    );
    process.exit(1);
  }
  if (syntaxCheck.status !== 0) {
    console.error(
      `Installer syntax check failed for ${shellFile} with exit code ${syntaxCheck.status ?? 'unknown'}.`,
    );
    process.exit(syntaxCheck.status ?? 1);
  }
}

function main() {
  for (const shellFile of shellFiles) {
    checkShellSyntax(shellFile);
  }

  const source = fs.readFileSync(installerPath, 'utf8');
  const activeLines = collectActiveShellLines(source);

  for (const { label, matcher, expected } of invariants) {
    const actual = countInvariantMatches(activeLines, matcher);
    if (actual !== expected) {
      console.error(`${label} must appear ${expected} time(s); found ${actual}.`);
      process.exit(1);
    }
  }

  process.stdout.write('Installer integrity checks passed.\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  collectActiveShellLines,
  countInvariantMatches,
  invariants,
  stripShellComment,
};
