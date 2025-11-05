#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.resolve(
  process.env.MAINTAIN_DOCS_ROOT ?? path.join(__dirname, '..'),
);
const docsDir = path.join(rootDir, 'docs');
const agentsSyncScriptPath = path.resolve(
  process.env.MAINTAIN_DOCS_SYNC_SCRIPT ??
    path.join(rootDir, 'scripts', 'agents_sync.py'),
);
const prettierBinCandidates = [
  process.env.MAINTAIN_DOCS_PRETTIER ?? '',
  path.join(__dirname, '..', 'node_modules', '.bin', 'prettier'),
  'npx',
];

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');
const dryRun = args.has('--dry-run') || checkMode;
const verbose = args.has('--verbose');
const skipPrettier = args.has('--no-prettier');
const COMMAND_TIMEOUT_MS = 120000;
const OUTPUT_MAX_BYTES = 10 * 1024 * 1024;
const SAFE_COMMAND_PATTERN = /^[A-Za-z0-9_.:-]+$/;

async function main() {
  await ensureDocsDirectory();
  await assertAgentsSyncExists();
  const python = await resolvePythonExecutable();

  if (checkMode) {
    return runCheck(python);
  }

  if (dryRun) {
    return runDryRun(python);
  }

  return runApply(python);
}

async function ensureDocsDirectory() {
  try {
    await fs.mkdir(docsDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to prepare docs directory at ${docsDir}: ${error.message}`);
  }
}

async function assertAgentsSyncExists() {
  try {
    const stats = await fs.stat(agentsSyncScriptPath);
    if (!stats.isFile()) {
      throw new Error('agents_sync.py is not a file.');
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(
        `agents_sync.py not found at ${agentsSyncScriptPath}. Set MAINTAIN_DOCS_SYNC_SCRIPT to override the path.`,
      );
    }
    throw error;
  }
}

async function runCheck(python) {
  const planResult = await runAgentsSyncPlan(python, { failOnChange: true });
  if (planResult.code !== 0 && planResult.code !== 2) {
    surfacePlanFailure('plan', planResult);
    return planResult.code || 1;
  }

  const actionable = extractActionableArtifacts(planResult.plan);
  if (planResult.code === 2 || actionable.length > 0) {
    if (actionable.length > 0) {
      console.error('Managed documentation drift detected:');
      actionable.forEach((item) => console.error(` - ${item}`));
    } else {
      console.error('Managed documentation drift detected (no actionable details).');
    }
    return 1;
  }

  console.log('Documentation is up to date.');
  return 0;
}

async function runDryRun(python) {
  const planResult = await runAgentsSyncPlan(python, { failOnChange: false });
  if (planResult.code !== 0 && planResult.code !== 2) {
    surfacePlanFailure('plan', planResult);
    return planResult.code || 1;
  }

  const actionable = extractActionableArtifacts(planResult.plan);

  if (actionable.length === 0) {
    console.log('No documentation changes required.');
    return 0;
  }

  console.log('Documentation maintenance would apply the following changes:');
  actionable.forEach((item) => console.log(` - ${item}`));
  return 0;
}

async function runApply(python) {
  const initialPlan = await runAgentsSyncPlan(python, { failOnChange: false });
  if (initialPlan.code !== 0 && initialPlan.code !== 2) {
    surfacePlanFailure('plan', initialPlan);
    return initialPlan.code || 1;
  }
  const actionable = extractActionableArtifacts(initialPlan.plan);

  if (actionable.length === 0) {
    if (verbose) {
      console.log('Documentation already synchronized.');
    }
  } else {
    console.log('Applying managed documentation updates:');
    actionable.forEach((item) => console.log(` - ${item}`));
  }

  await runAgentsSyncApply(python);

  if (!skipPrettier) {
    await runPrettier();
  } else if (verbose) {
    console.log('Skipping Prettier formatting for docs (--no-prettier supplied).');
  }

  const verificationPlan = await runAgentsSyncPlan(python, { failOnChange: false });
  if ((verificationPlan.code ?? 0) !== 0) {
    surfacePlanFailure('verification', verificationPlan);
    return verificationPlan.code || 1;
  }
  const remaining = extractActionableArtifacts(verificationPlan.plan);
  if (remaining.length > 0) {
    const summary = remaining.map((item) => ` - ${item}`).join('\n');
    throw new Error(
      `agents_sync.py apply completed but documentation drift remains after maintenance:\n${summary}`,
    );
  }

  console.log('Documentation maintenance complete.');
  return 0;
}

async function runAgentsSyncPlan(python, options = {}) {
  const { failOnChange = true } = options;
  const args = [agentsSyncScriptPath, 'plan', '--no-diffs', '--json-stdout'];
  if (failOnChange) {
    args.push('--fail-on-change');
  }
  const result = await runCommand(python, args, {
    cwd: rootDir,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxBuffer: OUTPUT_MAX_BYTES,
  });

  let plan = { artifacts: [] };
  const trimmed = (result.stdout ?? '').trim();
  if (trimmed.length > 0) {
    try {
      plan = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Failed to parse agents_sync.py plan output: ${error.message}`);
    }
  }

  return {
    code: result.code ?? 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    plan,
  };
}

async function runAgentsSyncApply(python) {
  const result = await runCommand(
    python,
    [agentsSyncScriptPath, 'apply', '--allow-dirty', '--no-branch', '--no-commit'],
    {
      cwd: rootDir,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
    },
  );

  if ((result.code ?? 0) !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const message = stderr?.length
      ? stderr
      : stdout?.length
        ? stdout
        : 'agents_sync.py apply failed.';
    throw new Error(message);
  }
}

async function runPrettier() {
  const prettier = await resolvePrettierExecutable();
  if (prettier.command === 'npx') {
    const result = await runCommand(
      'npx',
      ['--yes', 'prettier', '--write', 'docs/**/*.md'],
      {
        cwd: rootDir,
        env: { ...process.env, NPX_NODE_OPTIONS: '--no-warnings' },
        timeoutMs: COMMAND_TIMEOUT_MS,
        maxBuffer: OUTPUT_MAX_BYTES,
      },
    );
    if ((result.code ?? 0) !== 0) {
      const message = result.stderr?.trim() || 'Prettier formatting failed.';
      throw new Error(message);
    }
    return;
  }

  const result = await runCommand(prettier.command, ['--write', 'docs/**/*.md'], {
    cwd: rootDir,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxBuffer: OUTPUT_MAX_BYTES,
  });
  if ((result.code ?? 0) !== 0) {
    const message = result.stderr?.trim() || 'Prettier formatting failed.';
    throw new Error(message);
  }
}

function extractActionableArtifacts(plan) {
  if (!plan || !Array.isArray(plan.artifacts)) {
    return [];
  }
  const actionable = [];
  for (const artifact of plan.artifacts) {
    if (!artifact || typeof artifact !== 'object') {
      continue;
    }
    const decision = typeof artifact.decision === 'string' ? artifact.decision : 'keep';
    if (decision === 'keep') {
      continue;
    }
    const pathValue = artifact.path || 'unknown path';
    const rationale = artifact.rationale ? ` :: ${artifact.rationale}` : '';
    actionable.push(`[${decision}] ${pathValue}${rationale}`);
  }
  return actionable;
}

async function resolvePythonExecutable() {
  const candidates = [];
  if (process.env.MAINTAIN_DOCS_PYTHON) {
    const override = process.env.MAINTAIN_DOCS_PYTHON.trim();
    if (path.isAbsolute(override)) {
      candidates.push(override);
    } else if (verbose) {
      console.warn(
        'Ignoring MAINTAIN_DOCS_PYTHON override because it is not an absolute path.',
      );
    }
  }
  candidates.push('python3', 'python');

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      const result = await runCommand(candidate, ['--version']);
      if ((result.code ?? 0) === 0) {
        return candidate;
      }
    } catch (error) {
      // continue to next candidate
      if (verbose) {
        console.warn(
          `Failed to execute python candidate '${candidate}': ${error.message}`,
        );
      }
    }
  }

  throw new Error('Unable to locate a Python interpreter for agents_sync.py.');
}

async function resolvePrettierExecutable() {
  for (const candidate of prettierBinCandidates) {
    if (!candidate) {
      continue;
    }
    if (candidate === 'npx') {
      return { command: 'npx' };
    }
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return { command: candidate };
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && verbose) {
        console.warn(
          `Unable to stat Prettier candidate '${candidate}': ${error.message}`,
        );
      }
    }
  }
  return { command: 'npx' };
}

function runCommand(command, args, options = {}) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    return Promise.reject(new Error('Invalid command supplied to runCommand.'));
  }
  const trimmedCommand = command.trim();
  if (!path.isAbsolute(trimmedCommand) && !SAFE_COMMAND_PATTERN.test(trimmedCommand)) {
    return Promise.reject(
      new Error(`Refusing to execute unsafe command string: ${trimmedCommand}`),
    );
  }

  return new Promise((resolve, reject) => {
    const { timeoutMs = COMMAND_TIMEOUT_MS, maxBuffer = OUTPUT_MAX_BYTES, ...rest } = options;
    const spawnOptions = { ...rest };
    if (!spawnOptions.stdio) {
      spawnOptions.stdio = ['ignore', 'pipe', 'pipe'];
    }

    const child = spawn(trimmedCommand, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;

    const clearTimer = (timer) => {
      if (timer) {
        clearTimeout(timer);
      }
    };

    const finalize = (resolver) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timeoutHandle);
      resolver();
    };

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer(timeoutHandle);
      try {
        child.kill('SIGKILL');
      } catch (killError) {
        if (verbose) {
          console.warn(
            `Failed to terminate child process for ${trimmedCommand}: ${killError.message}`,
          );
        }
      }
      reject(error);
    };

    const timeoutHandle =
      typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            const error = new Error(
              `Command '${trimmedCommand}' timed out after ${timeoutMs}ms.`,
            );
            error.code = 'COMMAND_TIMEOUT';
            fail(error);
          }, timeoutMs)
        : null;

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (settled) {
          return;
        }
        try {
          const bufferChunk = Buffer.from(chunk);
          if (stdoutSize + bufferChunk.length > maxBuffer) {
            const error = new Error(
              `Command '${trimmedCommand}' exceeded stdout limit of ${maxBuffer} bytes.`,
            );
            error.code = 'MAX_BUFFER_EXCEEDED';
            fail(error);
            return;
          }
          stdoutSize += bufferChunk.length;
          stdout += bufferChunk.toString();
        } catch (error) {
          fail(error);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (settled) {
          return;
        }
        try {
          const bufferChunk = Buffer.from(chunk);
          if (stderrSize + bufferChunk.length > maxBuffer) {
            const error = new Error(
              `Command '${trimmedCommand}' exceeded stderr limit of ${maxBuffer} bytes.`,
            );
            error.code = 'MAX_BUFFER_EXCEEDED';
            fail(error);
            return;
          }
          stderrSize += bufferChunk.length;
          stderr += bufferChunk.toString();
        } catch (error) {
          fail(error);
        }
      });
    }

    child.on('error', (error) => {
      fail(error);
    });

    child.on('close', (code) => {
      finalize(() => {
        resolve({ code, stdout, stderr });
      });
    });
  });
}

main()
  .then((code) => {
    const exitCode = typeof code === 'number' ? code : 0;
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exit(1);
  });

function surfacePlanFailure(stage, result) {
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const details = stderr?.length
    ? stderr
    : stdout?.length
      ? stdout
      : `agents_sync.py ${stage} failed with exit code ${result.code ?? 'unknown'}.`;
  console.error(details);
}
