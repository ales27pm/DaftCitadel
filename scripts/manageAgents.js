#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.resolve(
  process.env.MANAGE_AGENTS_ROOT ?? path.join(__dirname, '..'),
);
const configPath = path.resolve(
  process.env.MANAGE_AGENTS_CONFIG ?? path.join(rootDir, 'agents.config.json'),
);
const agentsSyncScriptPath = path.resolve(
  process.env.MANAGE_AGENTS_SYNC_SCRIPT ??
    path.join(rootDir, 'scripts', 'agents_sync.py'),
);

const args = new Set(process.argv.slice(2));
const checkMode = args.has('--check');
const dryRun = checkMode || args.has('--dry-run');
const verbose = args.has('--verbose');

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'lib']);

async function main() {
  const config = await loadConfig();
  const manualPaths = new Set();
  const expected = new Map();

  if (!Array.isArray(config.agents)) {
    throw new Error('`agents` must be an array in agents.config.json');
  }

  for (const agent of config.agents) {
    validateAgent(agent);
    const relDir = normalizeRelative(agent.directory);
    manualPaths.add(relDir);
    const filePath = path.join(rootDir, relDir === '.' ? '' : relDir, 'AGENTS.md');
    const content = await buildMarkdown({
      title: agent.title,
      scope: agent.scope,
      instructions: agent.instructions,
      notes: agent.notes,
      sourceLabel: `manual entry (${relDir})`,
      body: agent.body,
      bodyPath: agent.body_path,
      protocols: agent.protocols,
    });
    expected.set(relDir, { filePath, content, source: 'manual' });
  }

  if (Array.isArray(config.autoRules)) {
    for (const rule of config.autoRules) {
      const autoEntries = await resolveAutoRule(rule, manualPaths);
      for (const entry of autoEntries) {
        if (expected.has(entry.relDir)) {
          continue;
        }
        expected.set(entry.relDir, {
          filePath: entry.filePath,
          content: entry.content,
          source: `auto rule (${entry.ruleLabel})`,
        });
      }
    }
  }

  const operations = await planOperations(expected);
  const python = await resolvePythonExecutable();

  if (checkMode) {
    let hasIssues = false;
    if (operations.length > 0) {
      hasIssues = true;
      console.error(
        `AGENTS.md files are out of sync with agents.config.json (${operations.length} change(s) needed).`,
      );
      if (verbose) {
        for (const op of operations) {
          console.error(` - [${op.type}] ${op.relativePath} :: ${op.reason}`);
        }
      }
    }

    const docPlan = await runAgentsSyncPlan(python);
    if (docPlan.code === 2) {
      hasIssues = true;
      console.error('agents_sync.py detected managed documentation drift:');
      for (const artifact of docPlan.plan.artifacts || []) {
        if (artifact.decision && artifact.decision !== 'keep') {
          console.error(
            ` - [${artifact.decision}] ${artifact.path} :: ${artifact.rationale}`,
          );
        }
      }
    } else if (docPlan.code !== 0) {
      const message = docPlan.stderr.trim() || 'agents_sync.py plan failed.';
      throw new Error(message);
    }

    if (hasIssues) {
      process.exit(1);
    }

    console.log('All AGENTS.md files and managed documentation are synchronized.');
    return;
  }

  if (dryRun) {
    if (operations.length === 0) {
      console.log('No AGENTS.md changes required.');
    } else {
      for (const op of operations) {
        console.log(`[DRY RUN][${op.type}] ${op.relativePath} :: ${op.reason}`);
      }
    }

    const docPlan = await runAgentsSyncPlan(python);
    if (docPlan.code === 2) {
      console.log('agents_sync.py would update managed documentation:');
      for (const artifact of docPlan.plan.artifacts || []) {
        if (artifact.decision && artifact.decision !== 'keep') {
          console.log(
            ` - [${artifact.decision}] ${artifact.path} :: ${artifact.rationale}`,
          );
        }
      }
    } else if (docPlan.code === 0) {
      console.log('Managed documentation already aligned with agents_sync.py.');
    } else {
      const message = docPlan.stderr.trim() || 'agents_sync.py plan failed.';
      throw new Error(message);
    }
    return;
  }

  if (operations.length > 0) {
    for (const op of operations) {
      if (op.type === 'write') {
        await fs.mkdir(path.dirname(op.filePath), { recursive: true });
        await fs.writeFile(op.filePath, op.content, 'utf8');
        console.log(`[WRITE] ${op.relativePath} :: ${op.reason}`);
      } else if (op.type === 'delete') {
        await fs.unlink(op.filePath);
        console.log(`[DELETE] ${op.relativePath} :: ${op.reason}`);
      }
    }
  } else if (verbose) {
    console.log('AGENTS.md files already up to date.');
  }

  const applyResult = await runAgentsSyncApply(python);
  if (applyResult.stdout.trim().length > 0) {
    process.stdout.write(applyResult.stdout);
  }
  if (applyResult.stderr.trim().length > 0) {
    process.stderr.write(applyResult.stderr);
  }

  const verificationPlan = await runAgentsSyncPlan(python, { failOnChange: false });
  if (verificationPlan.code !== 0) {
    const message =
      verificationPlan.stderr.trim() || 'agents_sync.py plan failed during verification.';
    throw new Error(message);
  }

  const outstandingArtifacts = (verificationPlan.plan.artifacts || []).filter(
    (artifact) => artifact.decision && artifact.decision !== 'keep',
  );

  if (outstandingArtifacts.length > 0) {
    const summary = outstandingArtifacts
      .map((artifact) => {
        const decision = artifact.decision || 'pending';
        const rationale = artifact.rationale ? ` :: ${artifact.rationale}` : '';
        return ` - [${decision}] ${artifact.path}${rationale}`;
      })
      .join('\n');
    throw new Error(
      `agents_sync.py apply completed but managed documentation drift remains:\n${summary}`,
    );
  }
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.version !== 'number') {
      throw new Error('`version` must be a number in agents.config.json');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('agents.config.json not found.');
    }
    throw error;
  }
}

function validateAgent(agent) {
  if (!agent || typeof agent !== 'object') {
    throw new Error('Invalid agent entry; expected an object.');
  }
  if (typeof agent.directory !== 'string' || agent.directory.length === 0) {
    throw new Error('Agent entry requires a non-empty `directory`.');
  }
  if (typeof agent.title !== 'string' || agent.title.length === 0) {
    throw new Error(`Agent ${agent.directory} is missing a title.`);
  }
  if (typeof agent.scope !== 'string' || agent.scope.length === 0) {
    throw new Error(`Agent ${agent.directory} is missing a scope description.`);
  }
  const hasBody = typeof agent.body === 'string' && agent.body.trim().length > 0;
  const hasBodyPath =
    typeof agent.body_path === 'string' && agent.body_path.trim().length > 0;
  if (hasBody && hasBodyPath) {
    throw new Error(`Agent ${agent.directory} cannot specify both body and body_path.`);
  }
  if (
    !hasBody &&
    !hasBodyPath &&
    (!Array.isArray(agent.instructions) || agent.instructions.length === 0)
  ) {
    throw new Error(`Agent ${agent.directory} must declare at least one instruction.`);
  }
  if (typeof agent.protocols !== 'undefined') {
    validateProtocols(agent.protocols, agent.directory);
  }
}

function validateProtocols(protocols, directory) {
  if (!Array.isArray(protocols)) {
    throw new Error(
      `Agent ${directory} expects 'protocols' to be an array when provided.`,
    );
  }
  protocols.forEach((protocol, index) => {
    if (!protocol || typeof protocol !== 'object') {
      throw new Error(`Agent ${directory} protocol at index ${index} must be an object.`);
    }
    if (typeof protocol.title !== 'string' || protocol.title.trim().length === 0) {
      throw new Error(
        `Agent ${directory} protocol at index ${index} requires a non-empty 'title'.`,
      );
    }
    const steps = protocol.steps;
    const body = protocol.body;
    const summary = protocol.summary;
    const hasSteps = Array.isArray(steps) && steps.length > 0;
    const hasBody = typeof body === 'string' && body.trim().length > 0;
    if (!hasSteps && !hasBody) {
      throw new Error(
        `Agent ${directory} protocol '${protocol.title}' must include either non-empty 'steps' or a non-empty 'body'.`,
      );
    }
    if (hasSteps) {
      steps.forEach((step, stepIndex) => {
        if (typeof step !== 'string' || step.trim().length === 0) {
          throw new Error(
            `Agent ${directory} protocol '${protocol.title}' step ${stepIndex} must be a non-empty string.`,
          );
        }
      });
    }
    if (
      typeof summary !== 'undefined' &&
      (typeof summary !== 'string' || summary.trim().length === 0)
    ) {
      throw new Error(
        `Agent ${directory} protocol '${protocol.title}' summary must be a non-empty string when provided.`,
      );
    }
  });
}

async function resolveAutoRule(rule, manualPaths) {
  if (!rule || typeof rule !== 'object') {
    throw new Error('Invalid auto rule entry.');
  }
  if (typeof rule.directory !== 'string' || rule.directory.length === 0) {
    throw new Error('Auto rule requires a `directory`.');
  }
  const depth =
    typeof rule.depth === 'number' && rule.depth > 0 ? Math.floor(rule.depth) : 1;
  const includeSelf = Boolean(rule.includeSelf);
  const exclude = Array.isArray(rule.exclude)
    ? rule.exclude.map((value) => normalizeExclude(value))
    : [];

  if (!rule.template || typeof rule.template !== 'object') {
    throw new Error(`Auto rule for ${rule.directory} is missing a template.`);
  }
  const template = rule.template;
  if (typeof template.title !== 'string' || template.title.length === 0) {
    throw new Error(`Auto rule for ${rule.directory} requires a template.title.`);
  }
  if (typeof template.scope !== 'string' || template.scope.length === 0) {
    throw new Error(`Auto rule for ${rule.directory} requires a template.scope.`);
  }
  if (!Array.isArray(template.instructions) || template.instructions.length === 0) {
    throw new Error(`Auto rule for ${rule.directory} requires template.instructions.`);
  }

  const baseDir = path.join(rootDir, rule.directory === '.' ? '' : rule.directory);
  let stat;
  try {
    stat = await fs.stat(baseDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn(`Auto rule directory '${rule.directory}' not found; skipping.`);
      return [];
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    console.warn(`Auto rule directory '${rule.directory}' is not a directory; skipping.`);
    return [];
  }

  const result = [];
  if (includeSelf) {
    const relDir = normalizeRelative(path.relative(rootDir, baseDir));
    if (
      !manualPaths.has(relDir) &&
      !isExcluded(relDir, path.basename(baseDir), exclude, rule.directory)
    ) {
      result.push(await buildAutoEntry(relDir, baseDir, template, rule));
    }
  }

  const directories = await collectDirectories(baseDir, depth);
  for (const dirPath of directories) {
    const relDir = normalizeRelative(path.relative(rootDir, dirPath));
    if (manualPaths.has(relDir)) {
      if (verbose) {
        console.log(
          `Skipping auto-generated AGENTS for ${relDir} (manual entry exists).`,
        );
      }
      continue;
    }
    const dirName = path.basename(dirPath);
    if (isExcluded(relDir, dirName, exclude, rule.directory)) {
      if (verbose) {
        console.log(`Excluding ${relDir} based on auto rule filters.`);
      }
      continue;
    }
    result.push(await buildAutoEntry(relDir, dirPath, template, rule));
  }
  return result;
}

async function collectDirectories(baseDir, depth) {
  const queue = [{ dir: baseDir, remainingDepth: depth }];
  const results = [];

  while (queue.length > 0) {
    const { dir, remainingDepth } = queue.shift();
    if (remainingDepth === 0) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (SKIP_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const childPath = path.join(dir, entry.name);
      results.push(childPath);
      if (remainingDepth > 1) {
        queue.push({ dir: childPath, remainingDepth: remainingDepth - 1 });
      }
    }
  }

  return results;
}

function isExcluded(relativeDir, dirName, exclude, ruleDirectory) {
  const normalizedRelative = relativeDir === '' ? '.' : relativeDir;
  for (const entry of exclude) {
    if (entry === dirName) {
      return true;
    }
    if (entry === normalizedRelative) {
      return true;
    }
    const fromRule = normalizeRelative(
      path.join(ruleDirectory === '.' ? '' : ruleDirectory, entry),
    );
    if (fromRule === normalizedRelative) {
      return true;
    }
  }
  return false;
}

async function buildAutoEntry(relDir, absDir, template, rule) {
  const context = {
    relativePath: relDir,
    directoryName:
      path.posix.basename(relDir === '.' ? '' : relDir) || path.basename(absDir),
    autoRoot: normalizeRelative(rule.directory),
    relativeToAutoRoot: normalizeRelative(
      path.relative(
        path.join(rootDir, rule.directory === '.' ? '' : rule.directory),
        absDir,
      ),
    ),
  };
  const content = await buildMarkdown({
    title: renderTemplate(template.title, context),
    scope: renderTemplate(template.scope, context),
    instructions: template.instructions.map((item) => renderTemplate(item, context)),
    notes: Array.isArray(template.notes)
      ? template.notes.map((note) => renderTemplate(note, context))
      : undefined,
    sourceLabel: `auto rule for ${rule.directory}`,
  });
  const filePath = path.join(rootDir, relDir === '.' ? '' : relDir, 'AGENTS.md');
  return { relDir, filePath, content, ruleLabel: rule.directory };
}

function renderTemplate(value, context) {
  return value.replace(/\{\{(.*?)\}\}/g, (_, key) => {
    const trimmed = String(key).trim();
    return Object.prototype.hasOwnProperty.call(context, trimmed) ? context[trimmed] : '';
  });
}

function normalizeRelative(input) {
  const normalized = path.normalize(input || '.');
  const relative = normalized === '' ? '.' : normalized;
  const withPosix = relative.split(path.sep).join('/');
  return withPosix === '' ? '.' : withPosix;
}

function normalizeExclude(value) {
  const normalized = path.normalize(value || '');
  return normalized.split(path.sep).join('/');
}

async function buildMarkdown({
  title,
  scope,
  instructions,
  notes,
  sourceLabel,
  body,
  bodyPath,
  protocols,
}) {
  if (typeof body === 'string' && body.trim().length > 0) {
    return ensureTrailingNewline(appendProtocols(body, protocols));
  }
  if (typeof bodyPath === 'string' && bodyPath.trim().length > 0) {
    const trimmedPath = bodyPath.trim();
    const resolvedPath = path.resolve(rootDir, trimmedPath);
    const relativeToRoot = path.relative(rootDir, resolvedPath);
    const normalizedRoot = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`;
    if (
      relativeToRoot.startsWith('..') ||
      (resolvedPath !== rootDir && !resolvedPath.startsWith(normalizedRoot))
    ) {
      throw new Error(`body_path must resolve within the repository: ${trimmedPath}`);
    }
    try {
      const content = await fs.readFile(resolvedPath, 'utf8');
      return ensureTrailingNewline(appendProtocols(content, protocols));
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`body_path '${trimmedPath}' does not exist.`);
      }
      throw error;
    }
  }
  const lines = [];
  lines.push('# AGENTS.md');
  lines.push('');
  lines.push(
    `> Generated by \`scripts/manageAgents.js\` (${sourceLabel}). Edit \`agents.config.json\` to update this file.`,
  );
  lines.push('');
  lines.push(`## ${title}`);
  lines.push('');
  lines.push(`**Scope:** ${scope}`);
  lines.push('');
  lines.push('### Instructions');
  lines.push('');
  instructions.forEach((instruction, index) => {
    lines.push(`${index + 1}. ${instruction}`);
  });
  if (notes && notes.length > 0) {
    lines.push('');
    lines.push('### Notes');
    lines.push('');
    notes.forEach((note) => {
      lines.push(`- ${note}`);
    });
  }
  lines.push('');
  if (!Array.isArray(protocols) || protocols.length === 0) {
    return lines.join('\n') + '\n';
  }
  const base = lines.join('\n');
  return ensureTrailingNewline(appendProtocols(base, protocols));
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function appendProtocols(content, protocols) {
  if (!Array.isArray(protocols) || protocols.length === 0) {
    return content;
  }

  const sections = [];
  const trimmedContent = content.replace(/\s+$/u, '');
  let beforeNotes = trimmedContent;
  let notesBlock = '';
  const notesIndex = trimmedContent.lastIndexOf('\n## Notes');
  if (notesIndex !== -1) {
    beforeNotes = trimmedContent.slice(0, notesIndex).replace(/\s+$/u, '');
    notesBlock = trimmedContent.slice(notesIndex).replace(/^\n+/u, '').trimEnd();
  }

  if (beforeNotes.length > 0) {
    sections.push(beforeNotes);
  }

  const protocolBlocks = [];
  for (const protocol of protocols) {
    if (!protocol || typeof protocol !== 'object') {
      continue;
    }
    const title = typeof protocol.title === 'string' ? protocol.title.trim() : '';
    if (title.length === 0) {
      continue;
    }
    const block = [`## ${title}`];
    const summary = typeof protocol.summary === 'string' ? protocol.summary.trim() : '';
    if (summary.length > 0) {
      block.push(summary);
    }
    if (Array.isArray(protocol.steps) && protocol.steps.length > 0) {
      for (const step of protocol.steps) {
        if (typeof step === 'string' && step.trim().length > 0) {
          block.push(`- ${step.trim()}`);
        }
      }
    } else if (typeof protocol.body === 'string' && protocol.body.trim().length > 0) {
      block.push(protocol.body.trim());
    }
    protocolBlocks.push(block.join('\n'));
  }

  if (protocolBlocks.length > 0) {
    sections.push(protocolBlocks.join('\n\n'));
  }

  if (notesBlock.length > 0) {
    sections.push(notesBlock);
  }

  return sections.join('\n\n');
}

async function planOperations(expected) {
  const operations = [];
  const expectedMap = new Map();
  for (const [relDir, entry] of expected.entries()) {
    const currentContent = await readFileIfExists(entry.filePath);
    expectedMap.set(relDir, true);
    if (currentContent === entry.content) {
      continue;
    }
    const relativePath = formatRelativePath(entry.filePath);
    const reason = currentContent
      ? 'update generated instructions'
      : 'create generated instructions';
    operations.push({
      type: 'write',
      filePath: entry.filePath,
      content: entry.content,
      relativePath,
      reason,
    });
  }

  const existingAgents = await gatherExistingAgents(rootDir);
  for (const agent of existingAgents) {
    if (expectedMap.has(agent.relDir)) {
      continue;
    }
    operations.push({
      type: 'delete',
      filePath: agent.filePath,
      relativePath: formatRelativePath(agent.filePath),
      reason: 'remove unmanaged AGENTS.md',
    });
  }

  operations.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return operations;
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function gatherExistingAgents(startDir) {
  const stack = [startDir];
  const results = [];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          continue;
        }
        stack.push(path.join(currentDir, entry.name));
      } else if (entry.isFile() && entry.name === 'AGENTS.md') {
        const dirRelative = normalizeRelative(path.relative(rootDir, currentDir));
        results.push({
          filePath: path.join(currentDir, entry.name),
          relDir: dirRelative,
        });
      }
    }
  }
  return results;
}

function formatRelativePath(filePath) {
  const relative = path.relative(rootDir, filePath);
  return relative.split(path.sep).join('/') || 'AGENTS.md';
}

async function resolvePythonExecutable() {
  const candidates = [];
  if (process.env.PYTHON) {
    candidates.push(process.env.PYTHON);
  }
  if (process.platform === 'win32') {
    candidates.push('python3.exe', 'python.exe');
  } else {
    candidates.push('python3', 'python');
  }

  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    try {
      const result = await runCommand(candidate, ['--version']);
      if (result.code === 0) {
        return candidate;
      }
    } catch (error) {
      // ignore and continue searching
    }
  }
  throw new Error('Unable to locate a Python interpreter to run agents_sync.py.');
}

async function runAgentsSyncPlan(python, options = {}) {
  const { failOnChange = true } = options;
  const args = [agentsSyncScriptPath, 'plan', '--no-diffs', '--json-stdout'];
  if (failOnChange) {
    args.push('--fail-on-change');
  }

  const result = await runCommand(python, args, { cwd: rootDir });

  let plan = { artifacts: [] };
  const trimmed = result.stdout.trim();
  if (trimmed.length > 0) {
    try {
      plan = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Failed to parse agents_sync.py plan output: ${error.message}`);
    }
  }

  return { code: result.code, plan, stdout: result.stdout, stderr: result.stderr };
}

async function runAgentsSyncApply(python) {
  const result = await runCommand(
    python,
    [agentsSyncScriptPath, 'apply', '--allow-dirty', '--no-branch', '--no-commit'],
    { cwd: rootDir },
  );

  if (result.code !== 0) {
    const message = result.stderr.trim() || 'agents_sync.py apply failed.';
    throw new Error(message);
  }

  return result;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnOptions = { ...options };
    if (!spawnOptions.stdio) {
      spawnOptions.stdio = ['ignore', 'pipe', 'pipe'];
    }

    const child = spawn(command, args, spawnOptions);
    let stdout = '';
    let stderr = '';

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
