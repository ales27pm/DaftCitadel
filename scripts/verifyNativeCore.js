#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const sanitize = process.argv.includes('--sanitize');
const compilerCandidates = process.env.CXX
  ? [process.env.CXX]
  : ['c++', 'g++', 'clang++'];
const compiler = compilerCandidates.find(
  (candidate) => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0,
);

if (!compiler) {
  console.error(
    'Native audio verification requires CMake or a C++20 compiler (c++, g++, or clang++).',
  );
  process.exit(1);
}

const sourceFiles = [
  'audio-engine/src/AudioBuffer.cpp',
  'audio-engine/src/DSPNode.cpp',
  'audio-engine/src/Scheduler.cpp',
  'audio-engine/src/SceneGraph.cpp',
  'audio-engine/src/Automation.cpp',
  'audio-engine/src/Clock.cpp',
  'audio-engine/src/PluginHost.cpp',
  'audio-engine/src/PluginNode.cpp',
  'audio-engine/src/instruments/InstrumentNode.cpp',
  'audio-engine/src/instruments/juno/Juno106Node.cpp',
  'audio-engine/src/instruments/juno/JunoDSPEngine.cpp',
  'audio-engine/src/instruments/juno/JunoVoice.cpp',
  'audio-engine/platform/common/NodeFactory.cpp',
  'audio-engine/tests/TestMain.cpp',
  'audio-engine/tests/SchedulerTests.cpp',
  'audio-engine/tests/ClipPlayerNodeTests.cpp',
  'audio-engine/tests/PluginNodeTests.cpp',
  'audio-engine/tests/SceneGraphTests.cpp',
  'audio-engine/tests/JunoCoreTests.cpp',
  'audio-engine/tests/InstrumentNodeTests.cpp',
].map((file) => path.join(rootDir, file));
const outputPath = path.join(
  os.tmpdir(),
  `daft-citadel-audio-engine-tests-${process.pid}`,
);
const compileArgs = [
  '-std=c++20',
  '-Wall',
  '-Wextra',
  '-Wpedantic',
  `-I${path.join(rootDir, 'audio-engine/include')}`,
];

if (sanitize) {
  compileArgs.push(
    '-fsanitize=address,undefined',
    '-fno-sanitize-recover=all',
    '-fno-omit-frame-pointer',
  );
}
compileArgs.push(...sourceFiles, '-o', outputPath);

try {
  const compilation = spawnSync(compiler, compileArgs, { stdio: 'inherit' });
  if (compilation.error) {
    throw compilation.error;
  }
  if (compilation.status !== 0) {
    throw new Error(
      `C++ compilation exited with status ${compilation.status ?? 'unknown'}`,
    );
  }

  const testRun = spawnSync(outputPath, [], {
    env: process.env,
    stdio: 'inherit',
  });
  if (testRun.error) {
    throw testRun.error;
  }
  if (testRun.status !== 0) {
    throw new Error(
      `native test binary exited with status ${testRun.status ?? 'unknown'}`,
    );
  }
} catch (error) {
  console.error(
    `Native audio verification failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
} finally {
  fs.rmSync(outputPath, { force: true });
}
