#!/usr/bin/env node

const fs = require('fs/promises');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const configPath = path.join(rootDir, 'agents.config.json');

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
    const content = buildMarkdown({
      title: agent.title,
      scope: agent.scope,
      instructions: agent.instructions,
      notes: agent.notes,
      sourceLabel: `manual entry (${relDir})`,
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

  if (checkMode) {
    if (operations.length > 0) {
      console.error(`AGENTS.md files are out of sync with agents.config.json (${operations.length} change(s) needed).`);
      if (verbose) {
        for (const op of operations) {
          console.error(` - [${op.type}] ${op.relativePath} :: ${op.reason}`);
        }
      }
      process.exit(1);
    }
    console.log('All AGENTS.md files are synchronized with agents.config.json.');
    return;
  }

  if (dryRun) {
    if (operations.length === 0) {
      console.log('No changes required.');
      return;
    }
    for (const op of operations) {
      console.log(`[DRY RUN][${op.type}] ${op.relativePath} :: ${op.reason}`);
    }
    return;
  }

  if (operations.length === 0) {
    if (verbose) {
      console.log('AGENTS.md files already up to date.');
    }
    return;
  }

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
  if (!Array.isArray(agent.instructions) || agent.instructions.length === 0) {
    throw new Error(`Agent ${agent.directory} must declare at least one instruction.`);
  }
}

async function resolveAutoRule(rule, manualPaths) {
  if (!rule || typeof rule !== 'object') {
    throw new Error('Invalid auto rule entry.');
  }
  if (typeof rule.directory !== 'string' || rule.directory.length === 0) {
    throw new Error('Auto rule requires a `directory`.');
  }
  const depth = typeof rule.depth === 'number' && rule.depth > 0 ? Math.floor(rule.depth) : 1;
  const includeSelf = Boolean(rule.includeSelf);
  const exclude = Array.isArray(rule.exclude) ? rule.exclude.map((value) => normalizeExclude(value)) : [];

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
    if (!manualPaths.has(relDir) && !isExcluded(relDir, path.basename(baseDir), exclude, rule.directory)) {
      result.push(buildAutoEntry(relDir, baseDir, template, rule));
    }
  }

  const directories = await collectDirectories(baseDir, depth);
  for (const dirPath of directories) {
    const relDir = normalizeRelative(path.relative(rootDir, dirPath));
    if (manualPaths.has(relDir)) {
      if (verbose) {
        console.log(`Skipping auto-generated AGENTS for ${relDir} (manual entry exists).`);
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
    result.push(buildAutoEntry(relDir, dirPath, template, rule));
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
    const fromRule = normalizeRelative(path.join(ruleDirectory === '.' ? '' : ruleDirectory, entry));
    if (fromRule === normalizedRelative) {
      return true;
    }
  }
  return false;
}

function buildAutoEntry(relDir, absDir, template, rule) {
  const context = {
    relativePath: relDir,
    directoryName: path.posix.basename(relDir === '.' ? '' : relDir) || path.basename(absDir),
    autoRoot: normalizeRelative(rule.directory),
    relativeToAutoRoot: normalizeRelative(path.relative(path.join(rootDir, rule.directory === '.' ? '' : rule.directory), absDir)),
  };
  const content = buildMarkdown({
    title: renderTemplate(template.title, context),
    scope: renderTemplate(template.scope, context),
    instructions: template.instructions.map((item) => renderTemplate(item, context)),
    notes: Array.isArray(template.notes) ? template.notes.map((note) => renderTemplate(note, context)) : undefined,
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

function buildMarkdown({ title, scope, instructions, notes, sourceLabel }) {
  const lines = [];
  lines.push('# AGENTS.md');
  lines.push(`> Generated by \`scripts/manageAgents.js\` (${sourceLabel}). Edit \`agents.config.json\` to update this file.`);
  lines.push('');
  lines.push(`## ${title}`);
  lines.push('');
  lines.push(`**Scope:** ${scope}`);
  lines.push('');
  lines.push('### Instructions');
  instructions.forEach((instruction, index) => {
    lines.push(`${index + 1}. ${instruction}`);
  });
  if (notes && notes.length > 0) {
    lines.push('');
    lines.push('### Notes');
    notes.forEach((note) => {
      lines.push(`- ${note}`);
    });
  }
  lines.push('');
  return lines.join('\n') + '\n';
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
    const reason = currentContent ? 'update generated instructions' : 'create generated instructions';
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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
