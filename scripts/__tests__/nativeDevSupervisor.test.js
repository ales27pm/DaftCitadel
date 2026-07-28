'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NATIVE_DEV_ROUTE_PREFIX,
  buildDevClientUrl,
  buildInstallManifest,
  buildPublicState,
  createGateway,
  parseByteRange,
  parseTunnelUrl,
  readIpaMetadata,
  readJsonIfExists,
  validateExpoManifestOrigin,
  writeJsonAtomic,
} = require('../nativeDevGateway');
const {
  buildExpoEnvironment,
  cleanupStaleRuntime,
  isTerminalState,
  monitorRuntimeHealth,
  parseCli,
  requestFirstResponseBytes,
} = require('../nativeDevSupervisor');

const TUNNEL_URL = 'https://one-origin-native-dev.trycloudflare.com';

test('Cloudflare URL parsing selects the latest complete quick-tunnel URL', () => {
  const output = [
    'INF Creating quick Tunnel on https://old-host.trycloudflare.com',
    'INF Registered tunnel connection',
    'INF Your quick Tunnel has been created! Visit it at',
    'https://one-origin-native-dev.trycloudflare.com',
  ].join('\n');

  assert.equal(parseTunnelUrl(output), TUNNEL_URL);
  assert.equal(parseTunnelUrl('no public URL yet'), null);
});

test('launcher, dev-client URL, and OTA manifest use one exact origin', () => {
  const devClientUrl = buildDevClientUrl(TUNNEL_URL, 'exp+daft-citadel');
  const manifest = buildInstallManifest({
    tunnelUrl: TUNNEL_URL,
    metadata: {
      bundleIdentifier: 'dev.daftcitadel.app',
      buildNumber: '6',
      displayName: 'Daft Citadel',
    },
  });

  assert.equal(
    devClientUrl,
    'exp+daft-citadel://expo-development-client/?url=https%3A%2F%2Fone-origin-native-dev.trycloudflare.com',
  );
  assert.match(
    manifest,
    /https:\/\/one-origin-native-dev\.trycloudflare\.com\/__native-dev\/DaftCitadel\.ipa/,
  );
  assert.doesNotMatch(manifest, /localhost|127\.0\.0\.1/);
});

test('Expo receives the exact proxy origin without CI watch-mode suppression', () => {
  const environment = buildExpoEnvironment(
    {
      PATH: '/usr/bin',
      CI: 'true',
      USER_DEFINED: 'preserved',
    },
    TUNNEL_URL,
    8081,
  );

  assert.equal(environment.EXPO_PACKAGER_PROXY_URL, TUNNEL_URL);
  assert.equal(environment.RCT_METRO_PORT, '8081');
  assert.equal(environment.EXPO_NO_TELEMETRY, '1');
  assert.equal(environment.EXPO_NO_TYPESCRIPT_SETUP, '1');
  assert.equal(environment.USER_DEFINED, 'preserved');
  assert.equal('CI' in environment, false);

  const parsed = parseCli([
    'start',
    '--gateway-port=18081',
    '--metro-port',
    '8081',
    '--clear',
  ]);
  assert.deepEqual(parsed, {
    command: 'start',
    options: {
      gatewayPort: '18081',
      metroPort: '8081',
      clear: true,
    },
  });
});

test('manifest validation rejects a stale Metro asset origin', () => {
  const valid = JSON.stringify({
    launchAsset: {
      url: `${TUNNEL_URL}/.expo/.virtual-metro-entry.bundle?platform=ios`,
    },
    assets: [
      {
        url: `${TUNNEL_URL}/assets/icon.png`,
      },
    ],
  });
  assert.doesNotThrow(() => validateExpoManifestOrigin(valid, TUNNEL_URL));

  const stale = JSON.stringify({
    launchAsset: {
      url: 'https://expired-tunnel.trycloudflare.com/index.bundle',
    },
  });
  assert.throws(
    () => validateExpoManifestOrigin(stale, TUNNEL_URL),
    /manifest origin mismatch/,
  );

  const staleSecondaryAsset = JSON.stringify({
    launchAsset: {
      url: `${TUNNEL_URL}/index.bundle`,
    },
    assets: [
      {
        url: 'https://expired-tunnel.trycloudflare.com/assets/icon.png',
      },
    ],
  });
  assert.throws(
    () => validateExpoManifestOrigin(staleSecondaryAsset, TUNNEL_URL),
    /origin mismatch for asset 0/,
  );
});

test('gateway proxies root HTTP and WebSocket traffic while serving tooling routes', async () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'daftcitadel-native-dev-test-'),
  );
  const ipaPath = path.join(temporaryRoot, 'DaftCitadel.ipa');
  fs.writeFileSync(ipaPath, Buffer.from('signed-ipa-fixture'));
  const ipaSha256 = crypto
    .createHash('sha256')
    .update('signed-ipa-fixture')
    .digest('hex');

  let webSocketRequestUrl = null;
  let webSocketClientMessage = null;
  const metroSockets = new Set();
  const metro = http.createServer((request, response) => {
    if (request.url === '/status') {
      response.end('packager-status:running');
      return;
    }
    response.setHeader('Content-Type', 'application/expo+json');
    response.setHeader('Connection', 'keep-alive, x-upstream-secret');
    response.setHeader('X-Upstream-Secret', 'must-not-leak');
    response.end(
      JSON.stringify({
        launchAsset: {
          url: `${TUNNEL_URL}/.expo/.virtual-metro-entry.bundle?platform=ios`,
        },
        observed: {
          path: request.url,
          host: request.headers.host,
          forwardedHost: request.headers['x-forwarded-host'],
          forwardedProto: request.headers['x-forwarded-proto'],
          strippedConnectionHeader: request.headers['x-remove-me'],
        },
      }),
    );
  });
  metro.on('upgrade', (request, socket, head) => {
    metroSockets.add(socket);
    socket.once('close', () => metroSockets.delete(socket));
    webSocketRequestUrl = request.url;
    const accept = crypto
      .createHash('sha1')
      .update(
        `${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`,
      )
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    let frameBuffer = Buffer.from(head);
    const onFrame = (frame) => {
      frameBuffer = Buffer.concat([frameBuffer, frame]);
      const message = decodeMaskedTextFrame(frameBuffer);
      if (message !== null) {
        webSocketClientMessage = message;
        socket.write(encodeUnmaskedTextFrame('metro-websocket-ready'));
      }
    };
    socket.on('data', onFrame);
  });
  const metroPort = await listen(metro);

  const snapshot = {
    schemaVersion: 1,
    status: 'ready',
    startedAt: '2026-07-28T15:00:00.000Z',
    updatedAt: '2026-07-28T15:00:01.000Z',
    projectRoot: '/private/repository/path',
    supervisorPid: 123,
    gateway: { status: 'ready', nonce: 'public-safe-nonce' },
    metro: { status: 'ready', pid: 456 },
    tunnel: {
      status: 'ready',
      generation: 1,
      url: TUNNEL_URL,
      pid: 789,
    },
    install: {
      available: true,
      bundleIdentifier: 'dev.daftcitadel.app',
      version: '1.0.0',
      buildNumber: '6',
      displayName: 'Daft Citadel',
      sha256: ipaSha256,
    },
    health: {
      status: 'healthy',
      lastCheckedAt: '2026-07-28T15:00:01.000Z',
      lastHealthyAt: '2026-07-28T15:00:01.000Z',
    },
    lastError: {
      code: 'native_dev_runtime_error',
      message: 'Sensitive failure at /private/repository/path',
      at: '2026-07-28T15:00:00.000Z',
    },
    launcherUrl: `${TUNNEL_URL}${NATIVE_DEV_ROUTE_PREFIX}/`,
    devClientUrl: buildDevClientUrl(TUNNEL_URL, 'exp+daft-citadel'),
  };
  const gateway = await createGateway({
    port: 0,
    metroPort,
    getSnapshot: () => snapshot,
    ipaPath,
  });

  try {
    const origin = `http://127.0.0.1:${gateway.port}`;
    const manifestResponse = await getText(`${origin}/?platform=ios`, {
      host: new URL(TUNNEL_URL).host,
      accept: 'application/expo+json',
      connection: 'keep-alive, x-remove-me',
      'x-remove-me': 'must-not-reach-metro',
    });
    assert.equal(manifestResponse.statusCode, 200);
    const manifest = JSON.parse(manifestResponse.body);
    assert.equal(manifest.observed.path, '/?platform=ios');
    assert.equal(manifest.observed.host, `127.0.0.1:${metroPort}`);
    assert.equal(manifest.observed.forwardedHost, new URL(TUNNEL_URL).host);
    assert.equal(manifest.observed.forwardedProto, 'https');
    assert.equal(manifest.observed.strippedConnectionHeader, undefined);
    assert.equal(manifestResponse.headers['x-upstream-secret'], undefined);
    assert.equal(manifestResponse.headers['content-security-policy'], undefined);
    validateExpoManifestOrigin(manifest, TUNNEL_URL);

    const launcher = await getText(`${origin}${NATIVE_DEV_ROUTE_PREFIX}/`);
    assert.equal(launcher.statusCode, 200);
    assert.match(launcher.body, /One tunnel generation/);
    assert.match(
      launcher.body,
      /exp\+daft-citadel:\/\/expo-development-client\/\?url=https%3A%2F%2Fone-origin-native-dev\.trycloudflare\.com/,
    );
    assert.doesNotMatch(launcher.body, /expired-tunnel|localhost/);

    const installManifest = await getText(
      `${origin}${NATIVE_DEV_ROUTE_PREFIX}/manifest.plist`,
    );
    assert.equal(installManifest.statusCode, 200);
    assert.match(
      installManifest.body,
      /one-origin-native-dev\.trycloudflare\.com\/__native-dev\/DaftCitadel\.ipa/,
    );

    const headIpa = await getText(
      `${origin}${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`,
      {},
      'HEAD',
    );
    assert.equal(headIpa.statusCode, 200);
    assert.equal(headIpa.body, '');
    assert.equal(headIpa.headers['content-length'], '18');
    assert.equal(headIpa.headers.etag, `"sha256-${ipaSha256}"`);

    const rangedIpa = await getText(
      `${origin}${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`,
      { range: 'bytes=7-9', 'if-range': headIpa.headers.etag },
    );
    assert.equal(rangedIpa.statusCode, 206);
    assert.equal(rangedIpa.body, 'ipa');
    assert.equal(rangedIpa.headers['content-range'], 'bytes 7-9/18');

    const staleResume = await getText(
      `${origin}${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`,
      { range: 'bytes=7-9', 'if-range': '"sha256-stale"' },
    );
    assert.equal(staleResume.statusCode, 200);
    assert.equal(staleResume.body, 'signed-ipa-fixture');
    assert.equal(staleResume.headers['content-range'], undefined);

    const unsatisfiableRange = await getText(
      `${origin}${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`,
      { range: 'bytes=99-100', 'if-range': headIpa.headers.etag },
    );
    assert.equal(unsatisfiableRange.statusCode, 416);
    assert.equal(unsatisfiableRange.headers['content-range'], 'bytes */18');

    const unchangedIpa = await getText(
      `${origin}${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`,
      { 'if-none-match': headIpa.headers.etag },
    );
    assert.equal(unchangedIpa.statusCode, 304);

    const publicState = await getText(`${origin}${NATIVE_DEV_ROUTE_PREFIX}/state`);
    const parsedState = JSON.parse(publicState.body);
    assert.deepEqual(parsedState, buildPublicState(snapshot));
    assert.doesNotMatch(publicState.body, /private\/repository|123|456|789/);
    assert.doesNotMatch(publicState.body, /Sensitive failure/);

    const websocketResponse = await rawWebSocketRequest(
      gateway.port,
      '/inspector/device?name=DaftCitadel',
    );
    assert.match(websocketResponse.headers, /101 Switching Protocols/);
    assert.match(websocketResponse.headers, /Sec-WebSocket-Accept:/);
    assert.equal(websocketResponse.message, 'metro-websocket-ready');
    assert.equal(webSocketClientMessage, 'gateway-roundtrip');
    assert.equal(webSocketRequestUrl, '/inspector/device?name=DaftCitadel');

    fs.writeFileSync(ipaPath, Buffer.from('replacement-artifact'));
    const changedIpa = await getText(
      `${origin}${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`,
    );
    assert.equal(changedIpa.statusCode, 409);
    assert.match(changedIpa.body, /native_dev_ipa_revision_changed/);
  } finally {
    await gateway.close();
    for (const socket of metroSockets) {
      socket.destroy();
    }
    await closeServer(metro);
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('gateway returns a retryable response instead of proxying before Metro is ready', async () => {
  const metro = http.createServer((_request, response) => {
    response.statusCode = 500;
    response.end('must not be reached');
  });
  const metroPort = await listen(metro);
  const gateway = await createGateway({
    port: 0,
    metroPort,
    getSnapshot: () => ({
      schemaVersion: 1,
      status: 'starting-metro',
      gateway: { status: 'ready' },
      metro: { status: 'stopped' },
      tunnel: { status: 'ready', generation: 1, url: TUNNEL_URL },
      install: { available: false },
    }),
  });

  try {
    const response = await getText(`http://127.0.0.1:${gateway.port}/`);
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['retry-after'], '2');
    assert.match(response.body, /native_dev_metro_starting/);
  } finally {
    await gateway.close();
    await closeServer(metro);
  }
});

test('gateway closes the Metro upstream when a downstream client cancels', async () => {
  let resolveUpstreamClosed;
  const upstreamClosed = new Promise((resolve) => {
    resolveUpstreamClosed = resolve;
  });
  const metro = http.createServer((request, response) => {
    request.socket.once('close', resolveUpstreamClosed);
    response.setHeader('Content-Type', 'application/javascript');
    response.write('partial-bundle');
  });
  const metroPort = await listen(metro);
  const gateway = await createGateway({
    port: 0,
    metroPort,
    getSnapshot: () => ({
      schemaVersion: 1,
      status: 'ready',
      gateway: { status: 'ready' },
      metro: { status: 'ready' },
      tunnel: { status: 'ready', generation: 1, url: TUNNEL_URL },
      install: { available: false },
    }),
  });

  try {
    await new Promise((resolve, reject) => {
      const request = http.get(
        `http://127.0.0.1:${gateway.port}/slow.bundle`,
        (response) => {
          response.once('data', () => {
            response.destroy();
            resolve();
          });
        },
      );
      request.once('error', reject);
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Gateway left its cancelled Metro upstream open')),
        1_000,
      );
      upstreamClosed.then(() => {
        clearTimeout(timer);
        resolve();
      }, reject);
    });
  } finally {
    await gateway.close();
    await closeServer(metro);
  }
});

test('health watchdog reports degradation, recovery, and terminal failure', async () => {
  const failureEvents = [];
  const failed = await monitorRuntimeHealth({
    intervalMs: 1,
    failureThreshold: 2,
    probe: async () => {
      throw new Error('Cloudflare 1033');
    },
    onStatus: (event) => failureEvents.push(event),
  });
  assert.equal(failed.kind, 'health-failure');
  assert.equal(failed.consecutiveFailures, 2);
  assert.deepEqual(
    failureEvents.map((event) => event.consecutiveFailures),
    [1, 2],
  );

  const controller = new AbortController();
  const recoveryEvents = [];
  let attempts = 0;
  const recovered = await monitorRuntimeHealth({
    signal: controller.signal,
    intervalMs: 1,
    failureThreshold: 3,
    probe: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('temporary edge propagation failure');
      }
      return { checkedAt: '2026-07-28T15:00:02.000Z' };
    },
    onStatus: (event) => {
      recoveryEvents.push(event);
      if (event.healthy) {
        controller.abort();
      }
    },
  });
  assert.equal(recovered.kind, 'health-aborted');
  assert.deepEqual(
    recoveryEvents.map((event) => event.healthy),
    [false, true],
  );
  assert.equal(recoveryEvents.at(-1).consecutiveFailures, 0);
});

test('launch readiness requires actual response bytes, not only HTTP headers', async () => {
  const sockets = new Set();
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
    response.write('globalThis.__nativeDevReady = true;');
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server);
  try {
    const response = await requestFirstResponseBytes(`http://127.0.0.1:${port}/bundle`, {
      timeoutMs: 1_000,
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.bodyBytes > 0);
    assert.match(response.headers['content-type'], /javascript/);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  }
});

test('corrupt IPA metadata fails closed instead of publishing an install', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'daftcitadel-corrupt-ipa-test-'),
  );
  const ipaPath = path.join(temporaryRoot, 'DaftCitadel.ipa');
  try {
    fs.writeFileSync(ipaPath, 'not a zip archive');
    const metadata = readIpaMetadata(ipaPath, temporaryRoot);
    assert.equal(metadata.available, false);
    assert.equal(metadata.sourceMissing, false);
    assert.match(metadata.metadataWarning, /zip|Info\.plist/i);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('runtime state writes atomically and byte ranges are bounded', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'daftcitadel-native-state-test-'),
  );
  const statePath = path.join(temporaryRoot, 'runtime-state.json');
  try {
    writeJsonAtomic(statePath, { schemaVersion: 1, status: 'ready' });
    assert.deepEqual(readJsonIfExists(statePath), {
      schemaVersion: 1,
      status: 'ready',
    });
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.deepEqual(parseByteRange('bytes=2-99', 10), {
      start: 2,
      end: 9,
    });
    assert.deepEqual(parseByteRange('bytes=-3', 10), {
      start: 7,
      end: 9,
    });
    assert.equal(parseByteRange('bytes=10-12', 10), null);
    assert.equal(parseByteRange('bytes=1-2,4-5', 10), null);
    assert.equal(
      fs.readdirSync(temporaryRoot).some((entry) => entry.endsWith('.tmp')),
      false,
    );
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

test('launch lock cleanup preserves a live owner and reclaims only a dead owner', () => {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'daftcitadel-native-lock-test-'),
  );
  const lockPath = path.join(temporaryRoot, 'supervisor.lock');
  try {
    writeJsonAtomic(lockPath, {
      instanceId: 'live-launch',
      launcherPid: process.pid,
    });
    cleanupStaleRuntime(null, { lockPath });
    assert.equal(fs.existsSync(lockPath), true);

    writeJsonAtomic(lockPath, {
      instanceId: 'stale-launch',
      launcherPid: 2_147_483_647,
    });
    cleanupStaleRuntime(null, { lockPath });
    assert.equal(fs.existsSync(lockPath), false);

    assert.equal(isTerminalState('ready'), false);
    assert.equal(isTerminalState('starting-metro'), false);
    assert.equal(isTerminalState('stopping'), true);
    assert.equal(isTerminalState('stopped'), true);
    assert.equal(isTerminalState('error'), true);
  } finally {
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

function getText(endpoint, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(endpoint, { headers, method }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    request.once('error', reject);
    request.end();
  });
}

function rawWebSocketRequest(port, requestPath) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${new URL(TUNNEL_URL).host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${key}`,
          '',
          '',
        ].join('\r\n'),
      );
    });
    let buffered = Buffer.alloc(0);
    let responseHeaders = null;
    let sentClientFrame = false;
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error('WebSocket proxy test timed out'));
    }, 5_000);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (responseHeaders === null) {
        const separator = buffered.indexOf('\r\n\r\n');
        if (separator < 0) {
          return;
        }
        responseHeaders = buffered.subarray(0, separator + 4).toString('utf8');
        buffered = buffered.subarray(separator + 4);
        const receivedAccept = /^sec-websocket-accept:\s*(.+)$/im
          .exec(responseHeaders)?.[1]
          .trim();
        if (receivedAccept !== expectedAccept) {
          clearTimeout(timeout);
          settled = true;
          socket.destroy();
          reject(new Error('WebSocket server returned an invalid accept key'));
          return;
        }
      }
      if (!sentClientFrame) {
        sentClientFrame = true;
        socket.write(encodeMaskedTextFrame('gateway-roundtrip'));
      }
      const message = decodeUnmaskedTextFrame(buffered);
      if (message !== null) {
        clearTimeout(timeout);
        settled = true;
        socket.destroy();
        resolve({ headers: responseHeaders, message });
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    socket.once('close', () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(new Error('WebSocket proxy closed before completing the round trip'));
      }
    });
  });
}

function encodeMaskedTextFrame(value) {
  const payload = Buffer.from(value);
  assert.ok(payload.length < 126, 'test WebSocket payload must use a short frame');
  const mask = crypto.randomBytes(4);
  const frame = Buffer.alloc(6 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
}

function encodeUnmaskedTextFrame(value) {
  const payload = Buffer.from(value);
  assert.ok(payload.length < 126, 'test WebSocket payload must use a short frame');
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function decodeMaskedTextFrame(frame) {
  if (frame.length < 6 || (frame[1] & 0x80) === 0) {
    return null;
  }
  const payloadLength = frame[1] & 0x7f;
  if (payloadLength >= 126 || frame.length < 6 + payloadLength) {
    return null;
  }
  const mask = frame.subarray(2, 6);
  const decoded = Buffer.alloc(payloadLength);
  for (let index = 0; index < payloadLength; index += 1) {
    decoded[index] = frame[6 + index] ^ mask[index % 4];
  }
  return decoded.toString('utf8');
}

function decodeUnmaskedTextFrame(frame) {
  if (frame.length < 2 || (frame[1] & 0x80) !== 0) {
    return null;
  }
  const payloadLength = frame[1] & 0x7f;
  if (payloadLength >= 126 || frame.length < 2 + payloadLength) {
    return null;
  }
  return frame.subarray(2, 2 + payloadLength).toString('utf8');
}
