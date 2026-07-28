#!/usr/bin/env node
'use strict';

/**
 * Durable one-origin Expo native development server.
 *
 * Public commands:
 *   node scripts/nativeDevSupervisor.js start
 *   node scripts/nativeDevSupervisor.js stop
 *   node scripts/nativeDevSupervisor.js restart
 *   node scripts/nativeDevSupervisor.js status
 *   node scripts/nativeDevSupervisor.js foreground
 *
 * The detached supervisor owns one local HTTP/WebSocket gateway, one
 * Cloudflare quick tunnel to that gateway, and one Expo Metro process whose
 * EXPO_PACKAGER_PROXY_URL is the exact quick-tunnel URL. All public routes
 * therefore share a single origin and a single lifecycle.
 */

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');

const {
  NATIVE_DEV_ROUTE_PREFIX,
  buildDevClientUrl,
  createGateway,
  parseTunnelUrl,
  readIpaMetadata,
  readJsonIfExists,
  validateExpoManifestOrigin,
  writeJsonAtomic,
} = require('./nativeDevGateway');

const SCHEMA_VERSION = 1;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_RUNTIME_DIRECTORY = path.join(PROJECT_ROOT, 'build', 'native-dev');
const DEFAULT_STATE_PATH = path.join(DEFAULT_RUNTIME_DIRECTORY, 'runtime-state.json');
const DEFAULT_LOCK_PATH = path.join(DEFAULT_RUNTIME_DIRECTORY, 'supervisor.lock');
const DEFAULT_LOG_PATH = path.join(DEFAULT_RUNTIME_DIRECTORY, 'supervisor.log');
const DEFAULT_IPA_PATH = path.join(
  DEFAULT_RUNTIME_DIRECTORY,
  'export',
  'DaftCitadel.ipa',
);
const DEFAULT_GATEWAY_PORT = 18_081;
const DEFAULT_METRO_PORT = 8_081;
const START_TIMEOUT_MS = 15 * 60 * 1_000;
const TUNNEL_DNS_PROPAGATION_TIMEOUT_MS = 3 * 60 * 1_000;
const CHILD_STOP_TIMEOUT_MS = 7_000;
const STATE_POLL_INTERVAL_MS = 250;
const HEALTH_CHECK_INTERVAL_MS = 20_000;
const HEALTH_CHECK_TIMEOUT_MS = 12_000;
const HEALTH_CHECK_FAILURE_THRESHOLD = 3;
const quickTunnelResolver = new dns.Resolver();
quickTunnelResolver.setServers(['1.1.1.1', '1.0.0.1']);
const EXPO_MANIFEST_HEADERS = {
  accept: 'application/expo+json,application/json',
  'expo-platform': 'ios',
  'expo-protocol-version': '1',
};

async function main() {
  const { command, options } = parseCli(process.argv.slice(2));
  switch (command) {
    case 'start':
      await startDetached(options);
      break;
    case 'stop':
      await stopDetached(options);
      break;
    case 'restart':
      await stopDetached({ ...options, quiet: true });
      await startDetached(options);
      break;
    case 'status':
      printStatus(options);
      break;
    case 'foreground':
      await startForeground(options);
      break;
    case 'run':
      await runSupervisor(options);
      break;
    case 'help':
      printUsage();
      break;
    default:
      throw new Error(`Unknown native-dev command: ${command}`);
  }
}

function parseCli(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv.shift() : 'start';
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--clear') {
      options.clear = true;
      continue;
    }
    if (argument === '--quiet') {
      options.quiet = true;
      continue;
    }
    if (argument === '--json') {
      options.json = true;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      return { command: 'help', options: {} };
    }
    const [rawKey, inlineValue] = argument.split('=', 2);
    const key = rawKey.replace(/^--/, '');
    const value =
      inlineValue ??
      (argv[index + 1] && !argv[index + 1].startsWith('-') ? argv[++index] : undefined);
    if (value === undefined) {
      throw new Error(`Missing value for ${rawKey}`);
    }
    options[toCamelCase(key)] = value;
  }
  return { command, options };
}

async function startDetached(options) {
  const paths = resolveRuntimePaths(options);
  fs.mkdirSync(paths.runtimeDirectory, { recursive: true });

  let current = readJsonIfExists(paths.statePath);
  if (current && isOwnedSupervisorLive(current)) {
    if (!isTerminalState(current.status)) {
      let replacedStaleSupervisor = false;
      const running =
        current.status === 'ready'
          ? current
          : await waitForSupervisorState(
              paths.statePath,
              current.instanceId,
              Number(options.waitMs ?? START_TIMEOUT_MS),
            );
      if (running.status === 'ready' && isOwnedSupervisorLive(running)) {
        try {
          await probePublicRuntime({
            tunnelUrl: running.tunnel?.url,
            gatewayNonce: running.gateway?.nonce,
            requestTimeoutMs: Number(options.healthTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS),
            probeLaunchAsset: true,
          });
          printReadyState(running, paths, options);
          return;
        } catch (error) {
          if (!options.quiet) {
            console.warn(
              `[native-dev] Existing supervisor is stale and will be replaced: ${error.message}`,
            );
          }
          try {
            process.kill(running.supervisorPid, 'SIGHUP');
          } catch (signalError) {
            if (signalError.code !== 'ESRCH') {
              throw signalError;
            }
          }
          await waitForPidExit(
            running.supervisorPid,
            Number(options.stopWaitMs ?? 20_000),
          );
          current = readJsonIfExists(paths.statePath);
          replacedStaleSupervisor = true;
        }
      }
      if (!replacedStaleSupervisor) {
        current = running;
      }
    }
    if (isOwnedSupervisorLive(current)) {
      await waitForPidExit(current.supervisorPid, Number(options.stopWaitMs ?? 20_000));
      current = readJsonIfExists(paths.statePath);
    }
  }

  cleanupStaleRuntime(current, paths);
  const instanceId = options.instanceId ?? crypto.randomUUID();
  acquireLaunchLock(paths.lockPath, instanceId);
  let launched = false;

  try {
    preflight(paths, options);
    const gatewayPort = await findAvailablePort(
      parsePort(options.gatewayPort, DEFAULT_GATEWAY_PORT),
      '127.0.0.1',
    );
    const metroPort = await findAvailablePort(
      parsePort(options.metroPort, DEFAULT_METRO_PORT),
      '127.0.0.1',
      gatewayPort,
    );
    rotateLog(paths.logPath);
    const logDescriptor = fs.openSync(paths.logPath, 'a', 0o600);
    let child;
    try {
      child = spawn(
        process.execPath,
        [
          __filename,
          'run',
          `--instance-id=${instanceId}`,
          `--gateway-port=${gatewayPort}`,
          `--metro-port=${metroPort}`,
          `--state-path=${paths.statePath}`,
          `--lock-path=${paths.lockPath}`,
          `--log-path=${paths.logPath}`,
          `--ipa-path=${paths.ipaPath}`,
          ...(options.cloudflaredPath
            ? [`--cloudflared-path=${options.cloudflaredPath}`]
            : []),
          ...(options.expoPath ? [`--expo-path=${options.expoPath}`] : []),
          ...(options.clear ? ['--clear'] : []),
        ],
        {
          cwd: PROJECT_ROOT,
          detached: true,
          env: {
            ...process.env,
            DAFT_CITADEL_NATIVE_DEV_SUPERVISOR: '1',
          },
          stdio: ['ignore', logDescriptor, logDescriptor],
        },
      );
    } finally {
      fs.closeSync(logDescriptor);
    }
    launched = true;
    child.unref();

    writeJsonAtomic(paths.statePath, {
      schemaVersion: SCHEMA_VERSION,
      instanceId,
      status: 'launching',
      supervisorPid: child.pid,
      projectRoot: PROJECT_ROOT,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      gateway: {
        host: '127.0.0.1',
        port: gatewayPort,
        status: 'pending',
      },
      metro: {
        host: '127.0.0.1',
        port: metroPort,
        status: 'pending',
        pid: null,
      },
      tunnel: {
        generation: 0,
        status: 'pending',
        pid: null,
        url: null,
      },
      launcherUrl: null,
      devClientUrl: null,
      logPath: paths.logPath,
      statePath: paths.statePath,
    });

    const ready = await waitForSupervisorState(
      paths.statePath,
      instanceId,
      Number(options.waitMs ?? START_TIMEOUT_MS),
    );
    if (ready.status !== 'ready') {
      throw new Error(
        ready.lastError?.message ??
          `Native development supervisor stopped in state "${ready.status}"`,
      );
    }
    printReadyState(ready, paths, options);
  } catch (error) {
    if (!launched) {
      removeLockIfOwned(paths.lockPath, instanceId);
    }
    throw error;
  }
}

async function startForeground(options) {
  const paths = resolveRuntimePaths(options);
  fs.mkdirSync(paths.runtimeDirectory, { recursive: true });
  let current = readJsonIfExists(paths.statePath);
  if (current && isOwnedSupervisorLive(current)) {
    if (!isTerminalState(current.status)) {
      throw new Error(
        `Native development supervisor is already running as PID ${current.supervisorPid}`,
      );
    }
    await waitForPidExit(current.supervisorPid, Number(options.stopWaitMs ?? 20_000));
    current = readJsonIfExists(paths.statePath);
  }
  cleanupStaleRuntime(current, paths);
  const instanceId = options.instanceId ?? crypto.randomUUID();
  acquireLaunchLock(paths.lockPath, instanceId);
  const gatewayPort = await findAvailablePort(
    parsePort(options.gatewayPort, DEFAULT_GATEWAY_PORT),
    '127.0.0.1',
  );
  const metroPort = await findAvailablePort(
    parsePort(options.metroPort, DEFAULT_METRO_PORT),
    '127.0.0.1',
    gatewayPort,
  );
  writeJsonAtomic(paths.statePath, {
    schemaVersion: SCHEMA_VERSION,
    instanceId,
    status: 'launching',
    supervisorPid: process.pid,
    projectRoot: PROJECT_ROOT,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await runSupervisor({
    ...options,
    instanceId,
    gatewayPort,
    metroPort,
    statePath: paths.statePath,
    lockPath: paths.lockPath,
    logPath: paths.logPath,
    ipaPath: paths.ipaPath,
  });
}

async function stopDetached(options) {
  const paths = resolveRuntimePaths(options);
  const state = readJsonIfExists(paths.statePath);
  if (!state || !isOwnedSupervisorLive(state)) {
    cleanupStaleRuntime(state, paths);
    if (!options.quiet) {
      console.log('DaftCitadel native development supervisor is not running.');
    }
    return;
  }

  try {
    process.kill(state.supervisorPid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
  const deadline = Date.now() + Number(options.waitMs ?? 20_000);
  while (Date.now() < deadline) {
    if (!isPidAlive(state.supervisorPid)) {
      if (!options.quiet) {
        console.log('DaftCitadel native development supervisor stopped.');
      }
      return;
    }
    await delay(STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Supervisor PID ${state.supervisorPid} did not stop within the timeout`,
  );
}

function printStatus(options) {
  const paths = resolveRuntimePaths(options);
  const state = readJsonIfExists(paths.statePath);
  const output = state
    ? {
        ...state,
        live: isOwnedSupervisorLive(state),
      }
    : {
        schemaVersion: SCHEMA_VERSION,
        status: 'not-started',
        live: false,
        statePath: paths.statePath,
      };
  console.log(JSON.stringify(output, null, 2));
}

async function runSupervisor(options) {
  if (!options.instanceId) {
    throw new Error('Internal supervisor run requires --instance-id');
  }

  const paths = resolveRuntimePaths(options);
  const instanceId = String(options.instanceId);
  await waitForLaunchRecord(paths.statePath, instanceId, 5_000);
  const gatewayPort = parsePort(options.gatewayPort, DEFAULT_GATEWAY_PORT);
  const metroPort = parsePort(options.metroPort, DEFAULT_METRO_PORT);
  let ipaMetadata = readIpaMetadata(paths.ipaPath, PROJECT_ROOT);
  const startedAt = new Date().toISOString();
  const gatewayNonce = crypto.randomBytes(24).toString('hex');
  let stopping = false;
  let stopReason = 'requested';
  let gateway;
  let activeTunnel = null;
  let activeMetro = null;
  let resolveShutdown;
  const shutdownPromise = new Promise((resolve) => {
    resolveShutdown = resolve;
  });

  let state = {
    schemaVersion: SCHEMA_VERSION,
    instanceId,
    status: 'starting',
    supervisorPid: process.pid,
    projectRoot: PROJECT_ROOT,
    startedAt,
    updatedAt: startedAt,
    gateway: {
      host: '127.0.0.1',
      port: gatewayPort,
      localUrl: `http://127.0.0.1:${gatewayPort}`,
      status: 'starting',
      nonce: gatewayNonce,
    },
    metro: {
      host: '127.0.0.1',
      port: metroPort,
      status: 'stopped',
      pid: null,
      restarts: 0,
      proxyUrl: null,
    },
    tunnel: {
      generation: 0,
      status: 'stopped',
      pid: null,
      url: null,
      restarts: 0,
    },
    health: {
      status: 'starting',
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastHealthyAt: null,
    },
    install: {
      ...ipaMetadata,
      path: ipaMetadata.ipaPath,
    },
    launcherUrl: null,
    devClientUrl: null,
    lastError: null,
    logPath: paths.logPath,
    statePath: paths.statePath,
  };
  writeJsonAtomic(paths.lockPath, {
    schemaVersion: SCHEMA_VERSION,
    instanceId,
    supervisorPid: process.pid,
    createdAt: startedAt,
  });

  const log = (level, message, fields = {}) => {
    const entry = {
      at: new Date().toISOString(),
      level,
      component: 'native-dev-supervisor',
      instanceId,
      message,
      ...fields,
    };
    const output = JSON.stringify(entry);
    if (level === 'error' || level === 'warn') {
      console.error(output);
    } else {
      console.log(output);
    }
  };

  const patchState = (patch) => {
    state = {
      ...state,
      ...patch,
      gateway: patch.gateway ? { ...state.gateway, ...patch.gateway } : state.gateway,
      metro: patch.metro ? { ...state.metro, ...patch.metro } : state.metro,
      tunnel: patch.tunnel ? { ...state.tunnel, ...patch.tunnel } : state.tunnel,
      health: patch.health ? { ...state.health, ...patch.health } : state.health,
      install: patch.install ? { ...state.install, ...patch.install } : state.install,
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomic(paths.statePath, state);
    return state;
  };

  const requestShutdown = (reason) => {
    if (stopping) {
      return;
    }
    stopping = true;
    stopReason = reason;
    patchState({ status: 'stopping' });
    log('info', 'Shutdown requested', { reason });
    resolveShutdown({ kind: 'shutdown', reason });
  };

  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));
  process.once('SIGHUP', () => requestShutdown('SIGHUP'));

  try {
    preflight(paths, options);
    patchState({ status: 'starting-gateway' });
    gateway = await createGateway({
      host: '127.0.0.1',
      port: gatewayPort,
      metroHost: '127.0.0.1',
      metroPort,
      getSnapshot: () => state,
      ipaPath: paths.ipaPath,
      logger: log,
    });
    patchState({
      gateway: {
        status: 'ready',
        port: gateway.port,
        localUrl: `http://127.0.0.1:${gateway.port}`,
      },
      status: 'starting-tunnel',
    });
    await waitForEndpoint(
      `http://127.0.0.1:${gateway.port}${NATIVE_DEV_ROUTE_PREFIX}/health`,
      {
        timeoutMs: 10_000,
        validate: (response) =>
          response.statusCode === 200 && JSON.parse(response.body).nonce === gatewayNonce,
      },
    );
    log('info', 'Local native development gateway started', {
      port: gateway.port,
      metroPort,
    });

    let tunnelBackoffMs = 1_000;
    while (!stopping) {
      try {
        const generationInstallMetadata = refreshInstallMetadataIfChanged(
          paths.ipaPath,
          state.install,
        );
        if (generationInstallMetadata) {
          ipaMetadata = generationInstallMetadata;
          patchState({
            install: {
              ...generationInstallMetadata,
              path: generationInstallMetadata.ipaPath,
            },
          });
        }
        const generation = state.tunnel.generation + 1;
        patchState({
          status: 'starting-tunnel',
          tunnel: {
            generation,
            status: 'starting',
            pid: null,
            url: null,
            connectedAt: null,
            readyAt: null,
          },
          metro: {
            status: 'stopped',
            pid: null,
            proxyUrl: null,
            readyAt: null,
            manifestOrigin: null,
          },
          health: {
            status: 'starting',
            consecutiveFailures: 0,
            lastCheckedAt: null,
            lastHealthyAt: null,
          },
          launcherUrl: null,
          devClientUrl: null,
        });

        activeTunnel = startCloudflareTunnel({
          gatewayPort: gateway.port,
          cloudflaredPath: options.cloudflaredPath,
          log,
        });
        patchState({
          tunnel: {
            status: 'starting',
            pid: activeTunnel.child.pid,
          },
        });
        const tunnelUrl = await raceWithShutdown(activeTunnel.url, shutdownPromise);
        if (tunnelUrl?.kind === 'shutdown') {
          break;
        }
        const normalizedTunnelUrl = tunnelUrl;
        const launcherUrl = `${normalizedTunnelUrl}${NATIVE_DEV_ROUTE_PREFIX}/`;
        const devClientUrl = buildDevClientUrl(
          normalizedTunnelUrl,
          ipaMetadata.devClientScheme,
        );
        patchState({
          status: 'probing-tunnel',
          tunnel: {
            status: 'probing',
            url: normalizedTunnelUrl,
            connectedAt: new Date().toISOString(),
          },
          launcherUrl,
          devClientUrl,
        });
        log('info', 'Cloudflare tunnel URL assigned', {
          generation,
          tunnelUrl: normalizedTunnelUrl,
        });

        await waitForReadiness(
          `${normalizedTunnelUrl}${NATIVE_DEV_ROUTE_PREFIX}/health`,
          {
            timeoutMs: TUNNEL_DNS_PROPAGATION_TIMEOUT_MS,
            validate: (response) => {
              if (response.statusCode !== 200) {
                return false;
              }
              return JSON.parse(response.body).nonce === gatewayNonce;
            },
          },
          shutdownPromise,
          [activeTunnel],
        );
        if (stopping) {
          break;
        }
        patchState({
          tunnel: {
            status: 'ready',
            readyAt: new Date().toISOString(),
          },
          status: 'starting-metro',
        });
        tunnelBackoffMs = 1_000;

        let metroBackoffMs = 1_000;
        while (!stopping && isChildRunning(activeTunnel.child)) {
          try {
            activeMetro = startExpoMetro({
              projectRoot: PROJECT_ROOT,
              metroPort,
              tunnelUrl: normalizedTunnelUrl,
              devClientScheme: ipaMetadata.devClientScheme,
              clear: Boolean(options.clear),
              expoPath: options.expoPath,
              log,
            });
            patchState({
              status: 'starting-metro',
              metro: {
                status: 'starting',
                pid: activeMetro.child.pid,
                proxyUrl: normalizedTunnelUrl,
              },
            });

            await waitForReadiness(
              `http://127.0.0.1:${metroPort}/status`,
              {
                timeoutMs: 90_000,
                validate: (response) =>
                  response.statusCode === 200 &&
                  response.body.includes('packager-status:running'),
              },
              shutdownPromise,
              [activeTunnel, activeMetro],
            );
            if (stopping) {
              break;
            }
            patchState({
              status: 'probing-manifest',
              metro: {
                status: 'probing',
                readyAt: new Date().toISOString(),
              },
            });

            await waitForReadiness(
              `${normalizedTunnelUrl}/status`,
              {
                timeoutMs: 60_000,
                validate: (response) =>
                  response.statusCode === 200 &&
                  response.body.includes('packager-status:running'),
              },
              shutdownPromise,
              [activeTunnel, activeMetro],
            );
            await waitForReadiness(
              normalizedTunnelUrl,
              {
                timeoutMs: 60_000,
                method: 'HEAD',
                headers: EXPO_MANIFEST_HEADERS,
                validate: (response) => response.statusCode === 200,
              },
              shutdownPromise,
              [activeTunnel, activeMetro],
            );
            let launchAssetUrl = null;
            await waitForReadiness(
              normalizedTunnelUrl,
              {
                timeoutMs: 90_000,
                headers: EXPO_MANIFEST_HEADERS,
                validate: (response) => {
                  if (response.statusCode !== 200) {
                    return false;
                  }
                  const manifest = validateExpoManifestOrigin(
                    response.body,
                    normalizedTunnelUrl,
                  );
                  launchAssetUrl = manifest.launchAsset?.url ?? manifest.bundleUrl;
                  return true;
                },
              },
              shutdownPromise,
              [activeTunnel, activeMetro],
            );
            if (!launchAssetUrl) {
              throw new Error('Expo manifest did not provide a launch asset URL');
            }
            await waitForBodyReadiness(
              launchAssetUrl,
              {
                timeoutMs: 12 * 60 * 1_000,
                requestTimeoutMs: 10 * 60 * 1_000,
                validate: (response) =>
                  response.statusCode >= 200 &&
                  response.statusCode < 300 &&
                  response.bodyBytes > 0 &&
                  String(response.headers['content-type'] ?? '').includes('javascript'),
              },
              shutdownPromise,
              [activeTunnel, activeMetro],
            );
            if (stopping) {
              break;
            }

            patchState({
              status: 'ready',
              metro: {
                status: 'ready',
                manifestOrigin: normalizedTunnelUrl,
              },
              tunnel: {
                status: 'ready',
              },
              health: {
                status: 'healthy',
                consecutiveFailures: 0,
                lastCheckedAt: new Date().toISOString(),
                lastHealthyAt: new Date().toISOString(),
              },
              lastError: null,
            });
            log('info', 'Native development server is ready', {
              launcherUrl,
              devClientUrl,
              generation,
            });
            metroBackoffMs = 1_000;

            const watchdogController = new AbortController();
            let outcome;
            try {
              outcome = await Promise.race([
                activeTunnel.exit.then((exit) => ({
                  kind: 'tunnel-exit',
                  exit,
                })),
                activeMetro.exit.then((exit) => ({
                  kind: 'metro-exit',
                  exit,
                })),
                monitorRuntimeHealth({
                  signal: watchdogController.signal,
                  intervalMs: Number(
                    options.healthIntervalMs ?? HEALTH_CHECK_INTERVAL_MS,
                  ),
                  failureThreshold: Number(
                    options.healthFailureThreshold ?? HEALTH_CHECK_FAILURE_THRESHOLD,
                  ),
                  probe: (signal) =>
                    probePublicRuntime({
                      tunnelUrl: normalizedTunnelUrl,
                      gatewayNonce,
                      signal,
                      requestTimeoutMs: Number(
                        options.healthTimeoutMs ?? HEALTH_CHECK_TIMEOUT_MS,
                      ),
                      probeLaunchAsset: true,
                    }),
                  onStatus: ({ healthy, checkedAt, consecutiveFailures, error }) => {
                    if (stopping || watchdogController.signal.aborted) {
                      return;
                    }
                    if (healthy) {
                      const refreshedInstall = refreshInstallMetadataIfChanged(
                        paths.ipaPath,
                        state.install,
                      );
                      if (refreshedInstall) {
                        ipaMetadata = refreshedInstall;
                      }
                      patchState({
                        status: 'ready',
                        tunnel: {
                          status: 'ready',
                        },
                        health: {
                          status: 'healthy',
                          consecutiveFailures: 0,
                          lastCheckedAt: checkedAt,
                          lastHealthyAt: checkedAt,
                        },
                        ...(refreshedInstall
                          ? {
                              install: {
                                ...refreshedInstall,
                                path: refreshedInstall.ipaPath,
                              },
                              devClientUrl: buildDevClientUrl(
                                normalizedTunnelUrl,
                                refreshedInstall.devClientScheme,
                              ),
                            }
                          : {}),
                        lastError: null,
                      });
                      return;
                    }
                    patchState({
                      status: 'degraded',
                      tunnel: {
                        status: 'degraded',
                      },
                      health: {
                        status: 'degraded',
                        consecutiveFailures,
                        lastCheckedAt: checkedAt,
                      },
                      lastError: runtimeError(
                        error.message,
                        'native_dev_public_health_failed',
                      ),
                    });
                    log('warn', 'Public native development health probe failed', {
                      error: error.message,
                      consecutiveFailures,
                    });
                  },
                }),
                shutdownPromise,
              ]);
            } finally {
              watchdogController.abort();
            }
            if (outcome.kind === 'shutdown') {
              break;
            }
            if (outcome.kind === 'health-failure') {
              log('warn', 'Public health remained unavailable; rotating the origin', {
                error: outcome.error.message,
                consecutiveFailures: outcome.consecutiveFailures,
              });
              patchState({
                status: 'restarting-tunnel',
                tunnel: {
                  status: 'restarting',
                  pid: activeTunnel.child.pid,
                  url: null,
                  restarts: state.tunnel.restarts + 1,
                },
                metro: {
                  status: 'stopping',
                },
                health: {
                  status: 'failed',
                  consecutiveFailures: outcome.consecutiveFailures,
                  lastCheckedAt: outcome.checkedAt,
                },
                launcherUrl: null,
                devClientUrl: null,
                lastError: runtimeError(
                  outcome.error.message,
                  'native_dev_public_health_failed',
                ),
              });
              await terminateChild(activeMetro, log);
              activeMetro = null;
              break;
            }
            if (outcome.kind === 'tunnel-exit') {
              log('warn', 'Cloudflare tunnel exited; rotating the origin', {
                ...outcome.exit,
              });
              patchState({
                status: 'restarting-tunnel',
                tunnel: {
                  status: 'restarting',
                  pid: null,
                  url: null,
                  restarts: state.tunnel.restarts + 1,
                },
                metro: {
                  status: 'stopping',
                },
                launcherUrl: null,
                devClientUrl: null,
                lastError: runtimeError(
                  `Cloudflare tunnel exited (${formatExit(outcome.exit)})`,
                ),
              });
              await terminateChild(activeMetro, log);
              activeMetro = null;
              break;
            }

            log('warn', 'Expo Metro exited; restarting behind the same origin', {
              ...outcome.exit,
            });
            patchState({
              status: 'restarting-metro',
              metro: {
                status: 'restarting',
                pid: null,
                restarts: state.metro.restarts + 1,
              },
              lastError: runtimeError(`Expo Metro exited (${formatExit(outcome.exit)})`),
            });
            activeMetro = null;
          } catch (error) {
            if (stopping) {
              break;
            }
            log('warn', 'Metro generation failed; retrying', {
              error: error.message,
              retryInMs: metroBackoffMs,
            });
            patchState({
              status: 'restarting-metro',
              metro: {
                status: 'restarting',
                pid: activeMetro?.child?.pid ?? state.metro.pid,
                restarts: state.metro.restarts + 1,
              },
              lastError: runtimeError(error.message),
            });
            await terminateChild(activeMetro, log);
            activeMetro = null;
            patchState({
              metro: {
                pid: null,
              },
            });
          }

          if (!stopping && isChildRunning(activeTunnel.child)) {
            await delayWithShutdown(metroBackoffMs, shutdownPromise);
            metroBackoffMs = Math.min(metroBackoffMs * 2, 15_000);
          }
        }
      } catch (error) {
        if (stopping) {
          break;
        }
        log('warn', 'Tunnel generation failed; rotating the origin', {
          error: error.message,
          retryInMs: tunnelBackoffMs,
        });
        patchState({
          status: 'restarting-tunnel',
          tunnel: {
            status: 'restarting',
            pid: activeTunnel?.child?.pid ?? state.tunnel.pid,
            url: null,
            restarts: state.tunnel.restarts + 1,
          },
          metro: {
            status: 'stopped',
            pid: activeMetro?.child?.pid ?? state.metro.pid,
            proxyUrl: null,
          },
          launcherUrl: null,
          devClientUrl: null,
          lastError: runtimeError(error.message),
        });
      } finally {
        await terminateChild(activeMetro, log);
        activeMetro = null;
        await terminateChild(activeTunnel, log);
        activeTunnel = null;
        if (!stopping) {
          patchState({
            metro: {
              pid: null,
            },
            tunnel: {
              pid: null,
            },
          });
        }
      }

      if (!stopping) {
        await delayWithShutdown(tunnelBackoffMs, shutdownPromise);
        tunnelBackoffMs = Math.min(tunnelBackoffMs * 2, 30_000);
      }
    }
  } catch (error) {
    stopReason = 'error';
    patchState({
      status: 'error',
      lastError: runtimeError(error.message),
    });
    log('error', 'Native development supervisor failed', {
      error: error.stack ?? error.message,
    });
    process.exitCode = 1;
  } finally {
    stopping = true;
    await terminateChild(activeMetro, log);
    await terminateChild(activeTunnel, log);
    if (gateway) {
      await gateway.close();
    }
    patchState({
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      stopReason,
      gateway: {
        status: 'stopped',
      },
      metro: {
        status: 'stopped',
        pid: null,
        proxyUrl: null,
      },
      tunnel: {
        status: 'stopped',
        pid: null,
        url: null,
      },
      health: {
        status: 'stopped',
        consecutiveFailures: 0,
      },
      launcherUrl: null,
      devClientUrl: null,
    });
    removeLockIfOwned(paths.lockPath, instanceId);
    log('info', 'Native development supervisor stopped', {
      reason: stopReason,
    });
  }
}

function startCloudflareTunnel({ gatewayPort, cloudflaredPath, log }) {
  const executable = cloudflaredPath ?? resolveExecutable('cloudflared');
  const child = spawn(
    executable,
    [
      'tunnel',
      '--no-autoupdate',
      '--metrics',
      '127.0.0.1:0',
      '--loglevel',
      'info',
      '--url',
      `http://127.0.0.1:${gatewayPort}`,
    ],
    {
      cwd: PROJECT_ROOT,
      detached: true,
      env: {
        ...process.env,
        TUNNEL_LOGLEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const exit = childExit(child);
  let captured = '';
  let resolveUrl;
  let rejectUrl;
  const url = new Promise((resolve, reject) => {
    resolveUrl = resolve;
    rejectUrl = reject;
  });
  const timeout = setTimeout(() => {
    rejectUrl(new Error('Cloudflare did not assign a quick-tunnel URL in time'));
  }, 45_000);
  timeout.unref();

  const consume = (streamName, chunk) => {
    const text = chunk.toString();
    captured = `${captured}${text}`.slice(-32_768);
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        log('info', 'cloudflared', { stream: streamName, line });
      }
    }
    const tunnelUrl = parseTunnelUrl(captured);
    if (tunnelUrl) {
      clearTimeout(timeout);
      resolveUrl(tunnelUrl);
    }
  };
  child.stdout.on('data', (chunk) => consume('stdout', chunk));
  child.stderr.on('data', (chunk) => consume('stderr', chunk));
  child.once('error', (error) => {
    clearTimeout(timeout);
    rejectUrl(error);
  });
  exit.then((result) => {
    clearTimeout(timeout);
    rejectUrl(
      new Error(`cloudflared exited before becoming ready (${formatExit(result)})`),
    );
  });

  return { child, exit, url, type: 'cloudflared' };
}

function startExpoMetro({
  projectRoot,
  metroPort,
  tunnelUrl,
  devClientScheme,
  clear,
  expoPath,
  log,
}) {
  const executable = expoPath ?? path.join(projectRoot, 'node_modules', '.bin', 'expo');
  const args = [
    'start',
    projectRoot,
    '--dev-client',
    '--host',
    'localhost',
    '--port',
    String(metroPort),
    '--scheme',
    devClientScheme,
    ...(clear ? ['--clear'] : []),
  ];
  const environment = buildExpoEnvironment(process.env, tunnelUrl, metroPort);
  const child = spawn(executable, args, {
    cwd: projectRoot,
    detached: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = childExit(child);
  attachChildLogs(child.stdout, 'stdout', 'expo', log);
  attachChildLogs(child.stderr, 'stderr', 'expo', log);
  child.once('error', (error) => {
    log('error', 'Expo process error', { error: error.message });
  });
  return { child, exit, type: 'expo' };
}

function buildExpoEnvironment(baseEnvironment, tunnelUrl, metroPort) {
  const environment = {
    ...baseEnvironment,
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_TYPESCRIPT_SETUP: '1',
    EXPO_PACKAGER_PROXY_URL: tunnelUrl,
    RCT_METRO_PORT: String(metroPort),
  };
  // Expo CLI disables watch/reload behavior when CI is truthy. A detached
  // process is non-interactive already; it must remain in development mode.
  delete environment.CI;
  return environment;
}

function attachChildLogs(stream, streamName, component, log) {
  let buffered = '';
  stream.on('data', (chunk) => {
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) {
        log('info', component, { stream: streamName, line });
      }
    }
  });
  stream.on('end', () => {
    if (buffered.trim()) {
      log('info', component, { stream: streamName, line: buffered });
    }
  });
}

function childExit(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    child.once('exit', (code, signal) => finish({ code, signal }));
    child.once('error', (error) =>
      finish({ code: null, signal: null, error: error.message }),
    );
  });
}

async function terminateChild(handle, log) {
  if (!handle?.child?.pid || !isChildRunning(handle.child)) {
    return;
  }
  const { child, exit, type } = handle;
  log('info', 'Stopping child process group', {
    type,
    pid: child.pid,
  });
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      log('warn', 'Could not send SIGTERM to child process group', {
        type,
        pid: child.pid,
        error: error.message,
      });
    }
  }
  const outcome = await waitForPromiseOrTimeout(exit, CHILD_STOP_TIMEOUT_MS, {
    timeout: true,
  });
  if (outcome.timeout && isChildRunning(child)) {
    log('warn', 'Child process exceeded graceful shutdown deadline', {
      type,
      pid: child.pid,
    });
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        log('warn', 'Could not send SIGKILL to child process group', {
          type,
          pid: child.pid,
          error: error.message,
        });
      }
    }
    await waitForPromiseOrTimeout(exit, 1_000, { timeout: true });
  }
}

async function waitForEndpoint(
  endpoint,
  {
    timeoutMs,
    headers = {},
    method = 'GET',
    maxBytes = 10 * 1024 * 1024,
    requestTimeoutMs = 15_000,
    signal,
    validate = (response) => response.statusCode >= 200 && response.statusCode < 300,
  },
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await requestText(endpoint, {
        headers,
        method,
        maxBytes,
        timeoutMs: Math.min(requestTimeoutMs, Math.max(deadline - Date.now(), 1)),
        signal,
      });
      if (validate(response)) {
        return response;
      }
      lastError = new Error(`${endpoint} returned HTTP ${response.statusCode}`);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      lastError = error;
    }
    await delayWithSignal(500, signal);
  }
  throw new Error(
    `Timed out waiting for ${endpoint}: ${lastError?.message ?? 'no response'}`,
  );
}

function requestText(
  endpoint,
  {
    headers = {},
    method = 'GET',
    maxBytes = 10 * 1024 * 1024,
    timeoutMs = 15_000,
    signal,
  } = {},
) {
  const url = new URL(endpoint);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method,
        headers,
        timeout: timeoutMs,
        signal,
        lookup: lookupForRequest(url),
      },
      (response) => {
        const chunks = [];
        let length = 0;
        let settled = false;
        const rejectResponse = (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };
        response.on('data', (chunk) => {
          length += chunk.length;
          if (length <= maxBytes) {
            chunks.push(chunk);
          } else {
            request.destroy(
              new Error(`Response from ${endpoint} exceeded ${maxBytes} bytes`),
            );
          }
        });
        response.once('aborted', () =>
          rejectResponse(new Error(`Response from ${endpoint} ended early`)),
        );
        response.once('error', rejectResponse);
        response.on('end', () => {
          if (!settled) {
            settled = true;
            resolve({
              statusCode: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          }
        });
      },
    );
    request.once('timeout', () =>
      request.destroy(new Error(`Request to ${endpoint} timed out`)),
    );
    request.once('error', reject);
    request.end();
  });
}

function requestFirstResponseBytes(
  endpoint,
  { headers = {}, minimumBytes = 1, timeoutMs = 15_000, signal } = {},
) {
  const url = new URL(endpoint);
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    let response;
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers,
        timeout: timeoutMs,
        signal,
        lookup: lookupForRequest(url),
      },
      (receivedResponse) => {
        response = receivedResponse;
        let bodyBytes = 0;
        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({
            statusCode: receivedResponse.statusCode ?? 0,
            headers: receivedResponse.headers,
            bodyBytes,
          });
          receivedResponse.destroy();
          request.destroy();
        };
        receivedResponse.on('data', (chunk) => {
          bodyBytes += chunk.length;
          if (bodyBytes >= minimumBytes) {
            finish();
          }
        });
        receivedResponse.once('end', finish);
        receivedResponse.once('aborted', () => {
          if (!settled) {
            settled = true;
            reject(new Error(`Response from ${endpoint} ended before its body arrived`));
          }
        });
        receivedResponse.once('error', (error) => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
      },
    );
    request.once('timeout', () =>
      request.destroy(new Error(`Request to ${endpoint} timed out`)),
    );
    request.once('error', (error) => {
      if (!settled) {
        settled = true;
        response?.destroy();
        reject(error);
      }
    });
    request.end();
  });
}

function lookupForRequest(url) {
  return url.protocol === 'https:' &&
    url.hostname.toLowerCase().endsWith('.trycloudflare.com')
    ? lookupQuickTunnelAddress
    : undefined;
}

function lookupQuickTunnelAddress(hostname, options, callback) {
  const normalizedOptions =
    typeof options === 'number' ? { family: options } : (options ?? {});
  const family = normalizedOptions.family === 6 ? 6 : 4;
  const resolve =
    family === 6
      ? quickTunnelResolver.resolve6.bind(quickTunnelResolver)
      : quickTunnelResolver.resolve4.bind(quickTunnelResolver);

  // macOS getaddrinfo can retain the NXDOMAIN observed before Cloudflare
  // publishes a newly-created quick-tunnel hostname. c-ares resolution avoids
  // that stale negative cache while HTTPS still retains the hostname for SNI.
  resolve(hostname, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    if (!addresses.length) {
      const notFound = new Error(`No DNS addresses found for ${hostname}`);
      notFound.code = 'ENOTFOUND';
      callback(notFound);
      return;
    }
    if (normalizedOptions.all) {
      callback(
        null,
        addresses.map((address) => ({ address, family })),
      );
      return;
    }
    callback(null, addresses[0], family);
  });
}

async function waitForResponseBody(endpoint, options) {
  const {
    timeoutMs,
    requestTimeoutMs = 15_000,
    signal,
    validate = (response) =>
      response.statusCode >= 200 && response.statusCode < 300 && response.bodyBytes > 0,
  } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      const response = await requestFirstResponseBytes(endpoint, {
        headers: options.headers,
        minimumBytes: options.minimumBytes,
        timeoutMs: Math.min(requestTimeoutMs, Math.max(deadline - Date.now(), 1)),
        signal,
      });
      if (validate(response)) {
        return response;
      }
      lastError = new Error(`${endpoint} returned HTTP ${response.statusCode}`);
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      lastError = error;
    }
    await delayWithSignal(500, signal);
  }
  throw new Error(
    `Timed out waiting for a response body from ${endpoint}: ${
      lastError?.message ?? 'no response'
    }`,
  );
}

async function probePublicRuntime({
  tunnelUrl,
  gatewayNonce,
  requestTimeoutMs = HEALTH_CHECK_TIMEOUT_MS,
  probeLaunchAsset = true,
  signal,
}) {
  if (typeof tunnelUrl !== 'string' || typeof gatewayNonce !== 'string') {
    throw new Error('Ready state is missing its public origin or gateway nonce');
  }
  const originUrl = new URL(tunnelUrl);
  if (originUrl.protocol !== 'https:') {
    throw new Error(`Public native development origin is not HTTPS: ${tunnelUrl}`);
  }
  const origin = originUrl.origin;
  const requestOptions = {
    timeoutMs: requestTimeoutMs,
    signal,
  };
  const healthResponse = await requestText(
    `${origin}${NATIVE_DEV_ROUTE_PREFIX}/health`,
    requestOptions,
  );
  let health;
  try {
    health = JSON.parse(healthResponse.body);
  } catch {
    throw new Error(
      `Public native development health route returned non-JSON HTTP ${healthResponse.statusCode}`,
    );
  }
  if (
    healthResponse.statusCode !== 200 ||
    health.gateway !== 'ready' ||
    health.nonce !== gatewayNonce
  ) {
    throw new Error('Public native development health nonce did not match this run');
  }

  const statusResponse = await requestText(`${origin}/status`, requestOptions);
  if (
    statusResponse.statusCode !== 200 ||
    !statusResponse.body.includes('packager-status:running')
  ) {
    throw new Error(
      `Public Metro status is unavailable (HTTP ${statusResponse.statusCode})`,
    );
  }

  const manifestResponse = await requestText(origin, {
    ...requestOptions,
    headers: EXPO_MANIFEST_HEADERS,
  });
  if (manifestResponse.statusCode !== 200) {
    throw new Error(
      `Public Expo manifest is unavailable (HTTP ${manifestResponse.statusCode})`,
    );
  }
  const manifest = validateExpoManifestOrigin(manifestResponse.body, origin);
  const launchAssetUrl = manifest.launchAsset?.url ?? manifest.bundleUrl;

  if (probeLaunchAsset) {
    const launchAssetResponse = await requestFirstResponseBytes(launchAssetUrl, {
      timeoutMs: requestTimeoutMs,
      signal,
    });
    if (
      launchAssetResponse.statusCode < 200 ||
      launchAssetResponse.statusCode >= 300 ||
      launchAssetResponse.bodyBytes === 0 ||
      !String(launchAssetResponse.headers['content-type'] ?? '').includes('javascript')
    ) {
      throw new Error(
        `Public Expo launch asset is unavailable (HTTP ${launchAssetResponse.statusCode})`,
      );
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    manifest,
    launchAssetUrl,
  };
}

async function monitorRuntimeHealth({
  probe,
  signal,
  intervalMs = HEALTH_CHECK_INTERVAL_MS,
  failureThreshold = HEALTH_CHECK_FAILURE_THRESHOLD,
  onStatus = () => {},
}) {
  if (typeof probe !== 'function') {
    throw new Error('monitorRuntimeHealth requires a probe function');
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 1) {
    throw new Error(`Invalid health-check interval: ${intervalMs}`);
  }
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new Error(`Invalid health-check failure threshold: ${failureThreshold}`);
  }

  let consecutiveFailures = 0;
  while (!signal?.aborted) {
    try {
      await delayWithSignal(intervalMs, signal);
      const result = await probe(signal);
      consecutiveFailures = 0;
      const checkedAt = result?.checkedAt ?? new Date().toISOString();
      await onStatus({
        healthy: true,
        checkedAt,
        consecutiveFailures,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        return { kind: 'health-aborted' };
      }
      consecutiveFailures += 1;
      const checkedAt = new Date().toISOString();
      await onStatus({
        healthy: false,
        checkedAt,
        consecutiveFailures,
        error,
      });
      if (consecutiveFailures >= failureThreshold) {
        return {
          kind: 'health-failure',
          checkedAt,
          consecutiveFailures,
          error,
        };
      }
    }
  }
  return { kind: 'health-aborted' };
}

function refreshInstallMetadataIfChanged(ipaPath, currentMetadata) {
  let stat;
  try {
    stat = fs.statSync(ipaPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
  if (!stat) {
    return currentMetadata?.sourceMissing ? null : readIpaMetadata(ipaPath, PROJECT_ROOT);
  }
  const unchanged =
    currentMetadata?.sourceMissing === false &&
    currentMetadata.device === stat.dev &&
    currentMetadata.inode === stat.ino &&
    currentMetadata.sizeBytes === stat.size &&
    currentMetadata.mtimeMs === stat.mtimeMs;
  return unchanged ? null : readIpaMetadata(ipaPath, PROJECT_ROOT);
}

function preflight(paths, options) {
  const cloudflared = options.cloudflaredPath ?? resolveExecutable('cloudflared');
  if (!cloudflared || !fs.existsSync(cloudflared)) {
    throw new Error(
      'cloudflared is required. Install it before starting native development.',
    );
  }
  const expo =
    options.expoPath ?? path.join(PROJECT_ROOT, 'node_modules', '.bin', 'expo');
  if (!fs.existsSync(expo)) {
    throw new Error(
      'Expo CLI is missing. Run npm install before starting native development.',
    );
  }
  if (!fs.existsSync(PROJECT_ROOT)) {
    throw new Error(`Project root does not exist: ${PROJECT_ROOT}`);
  }
  if (paths.ipaPath && !fs.existsSync(paths.ipaPath)) {
    // The dev server remains useful without an IPA, so this is represented as
    // install.available=false rather than failing the entire supervisor.
  }
}

function resolveExecutable(name) {
  const pathValue = process.env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function findAvailablePort(preferredPort, host, excludedPort) {
  for (let offset = 0; offset < 50; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate === excludedPort) {
      continue;
    }
    if (await canListen(candidate, host)) {
      return candidate;
    }
  }
  throw new Error(
    `No available port found from ${preferredPort} through ${preferredPort + 49}`,
  );
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForSupervisorState(statePath, instanceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readJsonIfExists(statePath);
    if (state?.instanceId === instanceId) {
      if (state.status === 'ready' || state.status === 'error') {
        return state;
      }
      if (
        state.status === 'stopped' ||
        (state.supervisorPid && !isPidAlive(state.supervisorPid))
      ) {
        return state;
      }
    }
    await delay(STATE_POLL_INTERVAL_MS);
  }
  throw new Error(
    `Native development supervisor did not become ready within ${timeoutMs}ms`,
  );
}

function resolveRuntimePaths(options) {
  const statePath = path.resolve(options.statePath ?? DEFAULT_STATE_PATH);
  const runtimeDirectory = path.dirname(statePath);
  return {
    runtimeDirectory,
    statePath,
    lockPath: path.resolve(
      options.lockPath ?? path.join(runtimeDirectory, path.basename(DEFAULT_LOCK_PATH)),
    ),
    logPath: path.resolve(
      options.logPath ?? path.join(runtimeDirectory, path.basename(DEFAULT_LOG_PATH)),
    ),
    ipaPath: path.resolve(options.ipaPath ?? DEFAULT_IPA_PATH),
  };
}

function acquireLaunchLock(lockPath, instanceId) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    let descriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    try {
      fs.writeFileSync(
        descriptor,
        `${JSON.stringify({
          schemaVersion: SCHEMA_VERSION,
          instanceId,
          launcherPid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`,
      );
    } finally {
      fs.closeSync(descriptor);
      descriptor = undefined;
    }
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(
        `Native development supervisor launch is already locked: ${lockPath}`,
      );
    }
    throw error;
  }
}

function removeLockIfOwned(lockPath, instanceId) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (lock.instanceId === instanceId) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // A malformed lock is left intact so another process cannot be started
      // concurrently without an explicit stale-runtime cleanup.
    }
  }
}

function cleanupStaleRuntime(state, paths) {
  if (state && !isOwnedSupervisorLive(state)) {
    cleanupStaleChild(state.metro?.pid, 'expo', state);
    cleanupStaleChild(state.tunnel?.pid, 'cloudflared', state);
  }
  if (fs.existsSync(paths.lockPath)) {
    let lock = null;
    try {
      lock = readJsonIfExists(paths.lockPath);
    } catch {
      // A malformed lock can only be reclaimed when no recorded owner is
      // alive. The state check below keeps a known supervisor protected.
    }
    const recordedOwnerAlive =
      isPidAlive(lock?.launcherPid) ||
      isPidAlive(lock?.supervisorPid) ||
      isOwnedSupervisorLive(state);
    if (!recordedOwnerAlive) {
      fs.rmSync(paths.lockPath, { force: true });
    }
  }
}

function cleanupStaleChild(pid, type, state) {
  if (!Number.isInteger(pid) || !isPidAlive(pid)) {
    return;
  }
  const command = processCommand(pid);
  const isOwned =
    type === 'expo'
      ? command.includes('expo') &&
        command.includes('start') &&
        command.includes(state.projectRoot)
      : command.includes('cloudflared') &&
        command.includes('--url') &&
        command.includes(`127.0.0.1:${state.gateway?.port}`);
  if (!isOwned) {
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error;
    }
  }
}

function isOwnedSupervisorLive(state) {
  if (!Number.isInteger(state?.supervisorPid)) {
    return false;
  }
  if (!isPidAlive(state.supervisorPid)) {
    return false;
  }
  const command = processCommand(state.supervisorPid);
  return (
    command.includes(path.basename(__filename)) &&
    command.includes('run') &&
    command.includes(state.instanceId)
  );
}

function processCommand(pid) {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
    }).trim();
  } catch {
    return '';
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isTerminalState(status) {
  return ['error', 'stopped', 'stopping'].includes(status);
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }
    await delay(STATE_POLL_INTERVAL_MS);
  }
  throw new Error(`Supervisor PID ${pid} did not exit within ${timeoutMs}ms`);
}

function isChildRunning(child) {
  return Boolean(child?.pid) && child.exitCode === null && !child.killed;
}

async function raceWithShutdown(operation, shutdownPromise, childHandles = []) {
  const childFailures = childHandles.filter(Boolean).map((handle) =>
    handle.exit.then((exit) => {
      throw new Error(`${handle.type} exited during readiness (${formatExit(exit)})`);
    }),
  );
  return Promise.race([operation, shutdownPromise, ...childFailures]);
}

async function waitForReadiness(endpoint, options, shutdownPromise, childHandles = []) {
  const controller = new AbortController();
  try {
    return await raceWithShutdown(
      waitForEndpoint(endpoint, {
        ...options,
        signal: controller.signal,
      }),
      shutdownPromise,
      childHandles,
    );
  } finally {
    controller.abort();
  }
}

async function waitForBodyReadiness(
  endpoint,
  options,
  shutdownPromise,
  childHandles = [],
) {
  const controller = new AbortController();
  try {
    return await raceWithShutdown(
      waitForResponseBody(endpoint, {
        ...options,
        signal: controller.signal,
      }),
      shutdownPromise,
      childHandles,
    );
  } finally {
    controller.abort();
  }
}

async function delayWithShutdown(milliseconds, shutdownPromise) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(undefined), milliseconds);
    shutdownPromise.then(finish);
  });
}

function delayWithSignal(milliseconds, signal) {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function waitForPromiseOrTimeout(promise, milliseconds, timeoutValue) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(timeoutValue), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function waitForLaunchRecord(statePath, instanceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readJsonIfExists(statePath);
    if (state?.instanceId === instanceId) {
      return state;
    }
    await delay(25);
  }
  throw new Error(`Supervisor launch record was not published for ${instanceId}`);
}

function runtimeError(message, code = 'native_dev_runtime_error') {
  return {
    code,
    message,
    at: new Date().toISOString(),
  };
}

function rotateLog(logPath, maximumBytes = 10 * 1024 * 1024) {
  try {
    if (fs.statSync(logPath).size < maximumBytes) {
      return;
    }
    const previousPath = `${logPath}.1`;
    fs.rmSync(previousPath, { force: true });
    fs.renameSync(logPath, previousPath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function formatExit(exit) {
  if (exit?.error) {
    return exit.error;
  }
  if (exit?.signal) {
    return `signal ${exit.signal}`;
  }
  return `exit ${exit?.code ?? 'unknown'}`;
}

function parsePort(value, fallback) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid TCP port: ${value}`);
  }
  return port;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function printReadyState(state, paths, options) {
  if (options.json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log('DaftCitadel native development server is ready.');
  console.log(`Launcher: ${state.launcherUrl}`);
  console.log(`Development server: ${state.devClientUrl}`);
  console.log(`State: ${paths.statePath}`);
  console.log(`Log: ${paths.logPath}`);
}

function printUsage() {
  console.log(`DaftCitadel durable native development server

Usage:
  npm run native-dev -- start [options]
  npm run native-dev -- stop
  npm run native-dev -- restart [options]
  npm run native-dev -- status
  npm run native-dev -- foreground [options]

Options:
  --gateway-port <port>  Preferred local gateway port (default 18081)
  --metro-port <port>    Preferred local Metro port (default 8081)
  --ipa-path <path>      Signed IPA served by the launcher
  --clear                Clear Metro's transform cache on every Metro start
  --wait-ms <ms>         Startup/stop wait timeout
  --json                 Print machine-readable startup state

Runtime files:
  ${DEFAULT_STATE_PATH}
  ${DEFAULT_LOG_PATH}

The public launcher is served at ${NATIVE_DEV_ROUTE_PREFIX}/ on the same
Cloudflare origin that proxies Expo's root manifest, bundles, and WebSockets.
`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[native-dev] ${error.stack ?? error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  buildExpoEnvironment,
  cleanupStaleRuntime,
  findAvailablePort,
  isTerminalState,
  monitorRuntimeHealth,
  parseCli,
  probePublicRuntime,
  refreshInstallMetadataIfChanged,
  requestFirstResponseBytes,
  requestText,
  resolveRuntimePaths,
  startCloudflareTunnel,
  startExpoMetro,
  waitForEndpoint,
};
