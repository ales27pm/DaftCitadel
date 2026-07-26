import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const repoRoot = path.resolve(__dirname, '..', '..');
const manageAgentsScript = path.join(repoRoot, 'scripts', 'manageAgents.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface BootstrapOptions {
  useStubSync?: boolean;
}

const tempRoots: string[] = [];

jest.setTimeout(60000);

async function createTempRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manage-agents-test-'));
  tempRoots.push(dir);
  return dir;
}

async function writeJson(target: string, value: unknown): Promise<void> {
  const content = JSON.stringify(value, null, 2);
  await fs.writeFile(target, `${content}\n`, 'utf8');
}

async function bootstrapWorkingCopy(
  root: string,
  options: BootstrapOptions = {},
): Promise<void> {
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });

  const roadmapPath = path.join(root, 'docs', 'ROADMAP.md');
  await fs.writeFile(roadmapPath, '# Roadmap\n\nInitial content.\n', 'utf8');

  const agentsConfig = {
    version: 1,
    agents: [
      {
        directory: '.',
        title: 'Test Root Rules',
        scope: 'All files in the sandbox repository.',
        instructions: [
          'Keep generated documentation synchronized with automation outputs.',
        ],
      },
      {
        directory: 'docs',
        title: 'Docs Guidance',
        scope: 'Markdown documentation located under docs/.',
        instructions: [
          'Ensure roadmap content stays aligned with managed automation expectations.',
        ],
      },
    ],
    autoRules: [],
  };

  await writeJson(path.join(root, 'agents.config.json'), agentsConfig);

  if (options.useStubSync) {
    const rootLiteral = JSON.stringify(root);
    const stub = `#!/usr/bin/env python3\nimport json\nimport sys\n\nPLAN = {\n  "ts": "000000",\n  "root": ${rootLiteral},\n  "artifacts": [\n    {\n      "path": "docs/ROADMAP.md",\n      "exists": False,\n      "managed": False,\n      "current_hash": None,\n      "current_size": None,\n      "decision": "create",\n      "rationale": "Stub sync script intentionally leaves drift for testing.",\n      "suggested_content": "# Roadmap\\n\\nPlaceholder\\n"\n    }\n  ],\n  "notes": []\n}\n\nif __name__ == "__main__":\n  if len(sys.argv) < 2:\n    sys.exit(1)\n  mode = sys.argv[1]\n  if mode == "plan":\n    sys.stdout.write(json.dumps(PLAN))\n    if "--fail-on-change" in sys.argv[2:]:\n      sys.exit(2)\n    sys.exit(0)\n  if mode == "apply":\n    sys.exit(0)\n  sys.exit(1)\n`;
    await fs.writeFile(path.join(root, 'scripts', 'agents_sync.py'), stub, {
      encoding: 'utf8',
    });
    return;
  }

  const source = path.join(repoRoot, 'scripts', 'agents_sync.py');
  const destination = path.join(root, 'scripts', 'agents_sync.py');
  await fs.copyFile(source, destination);
}

async function runManageAgents(
  sandboxRoot: string,
  args: string[] = [],
  envExtra: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [manageAgentsScript, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        MANAGE_AGENTS_ROOT: sandboxRoot,
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
        reject(new Error(`manageAgents exited via signal ${signal}`));
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

describe('manage:agents automation', () => {
  it('refreshes managed documentation and passes verification', async () => {
    const sandboxRoot = await createTempRoot();
    await bootstrapWorkingCopy(sandboxRoot);

    const result = await runManageAgents(sandboxRoot);
    expect(result.code).toBe(0);

    const roadmapPath = path.join(sandboxRoot, 'docs', 'ROADMAP.md');
    const roadmap = await fs.readFile(roadmapPath, 'utf8');
    expect(roadmap).toContain('<!-- managed-by: agents_sync.py v1 -->');

    const checkResult = await runManageAgents(sandboxRoot, ['--check']);
    expect(checkResult.code).toBe(0);
  });

  it('fails the run when documentation drift persists after apply', async () => {
    const sandboxRoot = await createTempRoot();
    await bootstrapWorkingCopy(sandboxRoot, { useStubSync: true });

    const result = await runManageAgents(sandboxRoot);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'agents_sync.py apply completed but managed documentation drift remains',
    );
  });
});
