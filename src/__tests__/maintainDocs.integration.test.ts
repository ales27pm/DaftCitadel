import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const repoRoot = path.resolve(__dirname, '..', '..');
const maintainDocsScript = path.join(repoRoot, 'scripts', 'maintainDocs.js');
const desiredRoadmap =
  '<!-- managed-by: maintainDocs stub -->\n# Roadmap\n\nSynchronized content for testing.\n';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface BootstrapOptions {
  initialRoadmap?: string;
}

const tempRoots: string[] = [];
const defaultTimeout = 60000;

jest.setTimeout(defaultTimeout);

async function createTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintain-docs-test-'));
  tempRoots.push(dir);
  return dir;
}

async function bootstrapSandbox(
  root: string,
  options: BootstrapOptions = {},
): Promise<void> {
  const docsDirectory = path.join(root, 'docs');
  const scriptsDirectory = path.join(root, 'scripts');

  await fs.mkdir(docsDirectory, { recursive: true });
  await fs.mkdir(scriptsDirectory, { recursive: true });

  const roadmapPath = path.join(docsDirectory, 'ROADMAP.md');
  const initialRoadmap =
    options.initialRoadmap ?? '# Roadmap\n\nInitial roadmap placeholder.\n';
  await fs.writeFile(roadmapPath, initialRoadmap, 'utf8');

  const stub = `#!/usr/bin/env python3\nimport json\nimport sys\nfrom pathlib import Path\n\nDESIRED = ${JSON.stringify(
    desiredRoadmap,
  )}\nROADMAP = Path('docs/ROADMAP.md')\n\ndef current_matches():\n    try:\n        return ROADMAP.read_text() == DESIRED\n    except FileNotFoundError:\n        return False\n\ndef plan_payload(decision, rationale):\n    return {\n        "ts": "000000",\n        "root": ${JSON.stringify(root)},\n        "artifacts": [\n            {\n                "path": "docs/ROADMAP.md",\n                "exists": ROADMAP.exists(),\n                "managed": True,\n                "decision": decision,\n                "rationale": rationale,\n                "suggested_content": DESIRED,\n            }\n        ],\n        "notes": []\n    }\n\nif __name__ == '__main__':\n    if len(sys.argv) < 2:\n        sys.exit(1)\n    mode = sys.argv[1]\n    if mode == 'plan':\n        if current_matches():\n            sys.stdout.write(json.dumps(plan_payload('keep', 'Up to date.')))\n            sys.exit(0)\n        payload = plan_payload('modify', 'Synchronize roadmap narrative.')\n        sys.stdout.write(json.dumps(payload))\n        if '--fail-on-change' in sys.argv[2:]:\n            sys.exit(2)\n        sys.exit(0)\n    if mode == 'apply':\n        ROADMAP.parent.mkdir(parents=True, exist_ok=True)\n        ROADMAP.write_text(DESIRED, encoding='utf8')\n        sys.exit(0)\n    sys.exit(1)\n`;

  const stubPath = path.join(scriptsDirectory, 'agents_sync.py');
  await fs.writeFile(stubPath, stub, { encoding: 'utf8', mode: 0o755 });
}

async function runMaintainDocs(
  sandboxRoot: string,
  args: string[] = [],
  envExtra: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [maintainDocsScript, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MAINTAIN_DOCS_ROOT: sandboxRoot,
        ...envExtra,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`maintainDocs exited via signal ${signal}`));
        return;
      }
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

afterAll(async () => {
  await Promise.all(
    tempRoots.map((dir) =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

describe('maintain:docs automation', () => {
  it('applies updates and verifies no drift remains', async () => {
    const sandboxRoot = await createTempRoot();
    await bootstrapSandbox(sandboxRoot, {
      initialRoadmap: '# Roadmap\n\nLegacy roadmap entry.\n',
    });

    const applyResult = await runMaintainDocs(sandboxRoot, ['--no-prettier']);
    expect(applyResult.code).toBe(0);
    expect(applyResult.stdout).toContain('Documentation maintenance complete.');

    const roadmapPath = path.join(sandboxRoot, 'docs', 'ROADMAP.md');
    const roadmap = await fs.readFile(roadmapPath, 'utf8');
    expect(roadmap).toBe(desiredRoadmap);

    const checkResult = await runMaintainDocs(sandboxRoot, ['--check', '--no-prettier']);
    expect(checkResult.code).toBe(0);
    expect(checkResult.stdout).toContain('Documentation is up to date.');
  });

  it('fails --check when documentation drift exists', async () => {
    const sandboxRoot = await createTempRoot();
    await bootstrapSandbox(sandboxRoot, {
      initialRoadmap: '# Roadmap\n\nNeeds synchronization.\n',
    });

    const checkResult = await runMaintainDocs(sandboxRoot, ['--check', '--no-prettier']);

    expect(checkResult.code).toBe(1);
    expect(checkResult.stderr).toContain('Managed documentation drift detected');
  });

  it('shows planned changes but does not modify files in --dry-run mode', async () => {
    const sandboxRoot = await createTempRoot();
    const initialRoadmap = '# Roadmap\n\nNeeds synchronization.\n';
    await bootstrapSandbox(sandboxRoot, {
      initialRoadmap,
    });

    const dryRunResult = await runMaintainDocs(sandboxRoot, [
      '--dry-run',
      '--no-prettier',
    ]);

    expect(dryRunResult.code).toBe(0);
    expect(dryRunResult.stdout).toContain(
      'Documentation maintenance would apply the following changes:',
    );

    const roadmapPath = path.join(sandboxRoot, 'docs', 'ROADMAP.md');
    const roadmapAfter = await fs.readFile(roadmapPath, 'utf8');
    expect(roadmapAfter).toBe(initialRoadmap);
  });

  it('fails fast when agents_sync.py is missing', async () => {
    const sandboxRoot = await createTempRoot();
    await bootstrapSandbox(sandboxRoot);

    const stubPath = path.join(sandboxRoot, 'scripts', 'agents_sync.py');
    await fs.rm(stubPath, { force: true });

    const applyResult = await runMaintainDocs(sandboxRoot, ['--no-prettier']);

    expect(applyResult.code).toBe(1);
    expect(applyResult.stderr).toContain('agents_sync.py not found');
  });

  it('surfaces interpreter resolution failures', async () => {
    const sandboxRoot = await createTempRoot();
    await bootstrapSandbox(sandboxRoot);
  
    const applyResult = await runMaintainDocs(sandboxRoot, ['--no-prettier'], {
      MAINTAIN_DOCS_PYTHON: '/nonexistent/python',
    });
  
    expect(applyResult.code).toBe(1);
    expect(applyResult.stderr).toContain('Unable to locate a Python interpreter');
  });

    const checkResult = await runMaintainDocs(sandboxRoot, ['--check', '--no-prettier']);

    expect(checkResult.code).toBe(1);
    expect(checkResult.stderr).toContain('Managed documentation drift detected');
  });

  // Remove this duplicate test case entirely, as the functionality is already covered by:
  // it('shows planned changes but does not modify files in --dry-run mode', ...)
});
