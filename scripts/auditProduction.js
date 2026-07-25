#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const temporarilyAllowedAdvisories = new Set([
  'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
]);

const result = spawnSync(
  'npm',
  ['audit', '--omit=dev', '--audit-level=high', '--json'],
  {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }
);

let report;

try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('Unable to parse npm audit output.');
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(1);
}

const vulnerabilities = report.vulnerabilities ?? {};
const resolutionMemo = new Map();

function resolvePackage(packageName, visiting = new Set()) {
  if (resolutionMemo.has(packageName)) {
    return resolutionMemo.get(packageName);
  }

  if (visiting.has(packageName)) {
    return {
      allowed: false,
      advisoryUrls: new Set(),
      reason: `Dependency cycle while resolving ${packageName}`,
    };
  }

  const vulnerability = vulnerabilities[packageName];

  if (!vulnerability) {
    return {
      allowed: false,
      advisoryUrls: new Set(),
      reason: `Missing vulnerability record for ${packageName}`,
    };
  }

  const nextVisiting = new Set(visiting);
  nextVisiting.add(packageName);

  const advisoryUrls = new Set();
  const decisions = [];

  for (const entry of vulnerability.via ?? []) {
    if (typeof entry === 'string') {
      const dependencyResult = resolvePackage(entry, nextVisiting);

      for (const url of dependencyResult.advisoryUrls) {
        advisoryUrls.add(url);
      }

      decisions.push(dependencyResult.allowed);
      continue;
    }

    if (entry && typeof entry === 'object') {
      const url = entry.url;

      if (url) {
        advisoryUrls.add(url);
      }

      decisions.push(
        Boolean(url) && temporarilyAllowedAdvisories.has(url)
      );
    }
  }

  const resultForPackage = {
    allowed:
      decisions.length > 0 &&
      decisions.every(Boolean) &&
      advisoryUrls.size > 0,
    advisoryUrls,
    reason:
      decisions.length === 0
        ? `No resolvable advisory chain for ${packageName}`
        : undefined,
  };

  resolutionMemo.set(packageName, resultForPackage);
  return resultForPackage;
}

const allowed = [];
const blocked = [];

for (const [packageName, vulnerability] of Object.entries(vulnerabilities)) {
  const resolution = resolvePackage(packageName);

  const record = {
    packageName,
    severity: vulnerability.severity,
    range: vulnerability.range,
    advisoryUrls: [...resolution.advisoryUrls].sort(),
    effects: vulnerability.effects ?? [],
    reason: resolution.reason,
  };

  if (resolution.allowed) {
    allowed.push(record);
  } else {
    blocked.push(record);
  }
}

if (allowed.length > 0) {
  console.warn('Temporarily accepted upstream advisory chain:');

  for (const item of allowed) {
    console.warn(
      `- ${item.packageName} ${item.range}: ${item.advisoryUrls.join(', ')}`
    );
  }
}

if (blocked.length > 0) {
  console.error('Unapproved production vulnerabilities detected:');
  console.error(JSON.stringify(blocked, null, 2));
  process.exit(1);
}

console.log('No unapproved production vulnerabilities detected.');
