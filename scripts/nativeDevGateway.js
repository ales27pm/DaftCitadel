'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const NATIVE_DEV_ROUTE_PREFIX = '/__native-dev';
const DEFAULT_DEV_CLIENT_SCHEME = 'exp+daft-citadel';

function parseTunnelUrl(value) {
  const matches = String(value).match(
    /https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.trycloudflare\.com\b/gi,
  );
  return matches ? normalizePublicUrl(matches.at(-1)) : null;
}

function normalizePublicUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error(`Native development tunnel must use HTTPS: ${value}`);
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function buildDevClientUrl(tunnelUrl, scheme = DEFAULT_DEV_CLIENT_SCHEME) {
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) {
    throw new Error(`Invalid development-client URL scheme: ${scheme}`);
  }
  const manifestUrl = normalizePublicUrl(tunnelUrl);
  return `${scheme}://expo-development-client/?url=${encodeURIComponent(manifestUrl)}`;
}

function buildInstallManifest({ tunnelUrl, metadata }) {
  const ipaUrl = `${normalizePublicUrl(
    tunnelUrl,
  )}${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${escapeXml(ipaUrl)}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${escapeXml(metadata.bundleIdentifier)}</string>
        <key>bundle-version</key>
        <string>${escapeXml(metadata.buildNumber)}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${escapeXml(metadata.displayName)}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>
`;
}

function buildPublicState(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
    startedAt: snapshot.startedAt,
    gateway: {
      status: snapshot.gateway?.status ?? 'unknown',
      launcherPath: `${NATIVE_DEV_ROUTE_PREFIX}/`,
    },
    metro: {
      status: snapshot.metro?.status ?? 'unknown',
    },
    tunnel: {
      status: snapshot.tunnel?.status ?? 'unknown',
      generation: snapshot.tunnel?.generation ?? 0,
      url: snapshot.tunnel?.url ?? null,
    },
    health: {
      status: snapshot.health?.status ?? 'unknown',
      lastCheckedAt: snapshot.health?.lastCheckedAt ?? null,
      lastHealthyAt: snapshot.health?.lastHealthyAt ?? null,
    },
    launcherUrl: snapshot.launcherUrl ?? null,
    devClientUrl: snapshot.devClientUrl ?? null,
    install: {
      available: Boolean(snapshot.install?.available),
      version: snapshot.install?.version ?? null,
      buildNumber: snapshot.install?.buildNumber ?? null,
    },
    lastError: snapshot.lastError
      ? {
          code: snapshot.lastError.code ?? 'native_dev_runtime_error',
          summary:
            'Native development connectivity was interrupted; automatic recovery is in progress.',
          at: snapshot.lastError.at,
        }
      : null,
  };
}

function renderLauncher(snapshot) {
  const publicState = buildPublicState(snapshot);
  const tunnelUrl = publicState.tunnel.url;
  const launcherUrl = tunnelUrl ? `${tunnelUrl}${NATIVE_DEV_ROUTE_PREFIX}/` : null;
  const manifestUrl = tunnelUrl
    ? `${tunnelUrl}${NATIVE_DEV_ROUTE_PREFIX}/manifest.plist`
    : null;
  const installUrl =
    manifestUrl && publicState.install.available
      ? `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`
      : null;
  const devClientUrl = publicState.devClientUrl;
  const statusLabel =
    publicState.status === 'ready'
      ? 'Ready'
      : publicState.status === 'stopped'
        ? 'Stopped'
        : 'Starting';
  const versionLabel = publicState.install.version
    ? `Version ${publicState.install.version} (${publicState.install.buildNumber})`
    : 'Native development client';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <meta http-equiv="refresh" content="${publicState.status === 'ready' ? '300' : '4'}" />
    <title>Daft Citadel Native Dev</title>
    <style>
      :root {
        color: #f7f7fb;
        background: #070a12;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display",
          "Helvetica Neue", sans-serif;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      main {
        width: min(100%, 440px);
        padding: 28px;
        border: 1px solid #293143;
        border-radius: 22px;
        background: #101520;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35);
      }
      .eyebrow {
        display: flex;
        align-items: center;
        gap: 9px;
        margin-bottom: 14px;
        color: #9aa6bb;
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: ${publicState.status === 'ready' ? '#61e0b5' : '#f2c96d'};
        box-shadow: 0 0 18px currentColor;
      }
      h1 { margin: 0 0 8px; font-size: 30px; }
      p { color: #b7c0d2; line-height: 1.5; }
      .button {
        display: block;
        margin-top: 14px;
        padding: 16px 18px;
        border-radius: 12px;
        text-align: center;
        text-decoration: none;
        font-weight: 750;
      }
      .primary { color: #06130f; background: #61e0b5; }
      .secondary {
        color: #f7f7fb;
        border: 1px solid #3a465e;
        background: #151b28;
      }
      .disabled {
        color: #7f899d;
        border: 1px solid #2a3140;
        background: #111722;
      }
      .details {
        margin-top: 22px;
        padding-top: 18px;
        border-top: 1px solid #293143;
        color: #7f899d;
        font-size: 13px;
        overflow-wrap: anywhere;
      }
      code { color: #78d8ff; }
    </style>
  </head>
  <body>
    <main>
      <div class="eyebrow"><span class="dot"></span>${escapeHtml(statusLabel)}</div>
      <h1>Daft Citadel Dev</h1>
      <p>${escapeHtml(versionLabel)}. Install once, then open the current development server.</p>
      ${
        installUrl
          ? `<a class="button primary" href="${escapeHtml(installUrl)}">Install on this iPhone</a>`
          : '<span class="button disabled">Install artifact unavailable</span>'
      }
      ${
        devClientUrl && publicState.status === 'ready'
          ? `<a class="button secondary" href="${escapeHtml(devClientUrl)}">Open development server</a>`
          : '<span class="button disabled">Development server is starting…</span>'
      }
      <div class="details">
        <div>One tunnel generation: <strong>${escapeHtml(
          String(publicState.tunnel.generation),
        )}</strong></div>
        ${
          launcherUrl
            ? `<div>Public origin: <code>${escapeHtml(tunnelUrl)}</code></div>`
            : ''
        }
        <p>This page, Expo manifest, JavaScript bundles, inspector WebSockets, and IPA install all use this same public origin.</p>
      </div>
    </main>
  </body>
</html>
`;
}

async function createGateway({
  host = '127.0.0.1',
  port = 0,
  metroHost = '127.0.0.1',
  metroPort,
  getSnapshot,
  ipaPath,
  logger = () => {},
}) {
  if (!Number.isInteger(metroPort) || metroPort <= 0) {
    throw new Error('createGateway requires a valid Metro port');
  }
  if (typeof getSnapshot !== 'function') {
    throw new Error('createGateway requires getSnapshot');
  }

  const sockets = new Set();
  const activeResources = new Set();
  const server = http.createServer((request, response) => {
    handleGatewayRequest({
      request,
      response,
      metroHost,
      metroPort,
      getSnapshot,
      ipaPath,
      logger,
      activeResources,
    }).catch((error) => {
      logger('error', 'Gateway request failed', {
        error: error.message,
        path: request.url,
      });
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: 'native_dev_gateway_error',
          message: 'The native development gateway could not serve this request.',
        });
      } else {
        response.destroy(error);
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    proxyWebSocket({
      request,
      socket,
      head,
      metroHost,
      metroPort,
      getSnapshot,
      logger,
      activeResources,
    });
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const address = server.address();
  const resolvedPort = typeof address === 'object' ? address.port : port;

  return {
    host,
    port: resolvedPort,
    server,
    async close() {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          for (const resource of activeResources) {
            resource.destroy?.();
          }
          for (const socket of sockets) {
            socket.destroy();
          }
        }, 1_000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections?.();
      });
    },
  };
}

async function handleGatewayRequest({
  request,
  response,
  metroHost,
  metroPort,
  getSnapshot,
  ipaPath,
  logger,
  activeResources,
}) {
  const requestUrl = new URL(request.url || '/', 'http://native-dev.local');
  const pathname = requestUrl.pathname.replace(/\/+$/, '') || '/';
  const snapshot = getSnapshot();

  const isToolingRoute =
    pathname === NATIVE_DEV_ROUTE_PREFIX ||
    pathname.startsWith(`${NATIVE_DEV_ROUTE_PREFIX}/`);
  if (isToolingRoute) {
    setSecurityHeaders(response);
  }

  if (
    pathname === NATIVE_DEV_ROUTE_PREFIX ||
    pathname === `${NATIVE_DEV_ROUTE_PREFIX}/launcher`
  ) {
    sendText(response, 200, 'text/html; charset=utf-8', renderLauncher(snapshot));
    return;
  }

  if (pathname === `${NATIVE_DEV_ROUTE_PREFIX}/health`) {
    sendJson(response, 200, {
      gateway: 'ready',
      nonce: snapshot.gateway?.nonce ?? null,
      status: snapshot.status,
      metro: snapshot.metro?.status ?? 'unknown',
      generation: snapshot.tunnel?.generation ?? 0,
    });
    return;
  }

  if (pathname === `${NATIVE_DEV_ROUTE_PREFIX}/state`) {
    sendJson(response, 200, buildPublicState(snapshot));
    return;
  }

  if (pathname === `${NATIVE_DEV_ROUTE_PREFIX}/manifest.plist`) {
    if (!snapshot.tunnel?.url || !snapshot.install?.available) {
      sendJson(response, 503, {
        error: 'native_dev_install_unavailable',
        message: 'The signed native development artifact is not available yet.',
      });
      return;
    }
    const manifest = buildInstallManifest({
      tunnelUrl: snapshot.tunnel.url,
      metadata: {
        bundleIdentifier: snapshot.install.bundleIdentifier,
        buildNumber: snapshot.install.buildNumber,
        displayName: snapshot.install.displayName,
      },
    });
    sendText(response, 200, 'application/xml; charset=utf-8', manifest);
    return;
  }

  if (pathname === `${NATIVE_DEV_ROUTE_PREFIX}/DaftCitadel.ipa`) {
    if (!snapshot.install?.available || !ipaPath) {
      sendJson(response, 404, {
        error: 'native_dev_ipa_not_found',
        message: 'The signed native development IPA is not available.',
      });
      return;
    }
    await serveFile(request, response, ipaPath, {
      activeResources,
      expectedSha256: snapshot.install.sha256,
    });
    return;
  }

  if (isToolingRoute) {
    sendJson(response, 404, {
      error: 'native_dev_route_not_found',
      message: 'The requested native development route does not exist.',
    });
    return;
  }

  if (!isMetroReachable(snapshot)) {
    response.setHeader('Retry-After', '2');
    sendJson(response, 503, {
      error: 'native_dev_metro_starting',
      message: 'Metro is starting. Retry this same URL shortly.',
      stateUrl: `${NATIVE_DEV_ROUTE_PREFIX}/state`,
    });
    return;
  }

  proxyHttp({
    request,
    response,
    metroHost,
    metroPort,
    logger,
    activeResources,
  });
}

function proxyHttp({ request, response, metroHost, metroPort, logger, activeResources }) {
  const headers = buildProxyHeaders(request.headers, metroHost, metroPort, {
    upgrade: false,
  });
  let upstreamResponse = null;
  const upstreamRequest = http.request(
    {
      hostname: metroHost,
      port: metroPort,
      method: request.method,
      path: request.url,
      headers,
    },
    (receivedResponse) => {
      upstreamResponse = receivedResponse;
      trackResource(activeResources, receivedResponse);
      if (response.destroyed) {
        receivedResponse.destroy();
        return;
      }
      const responseHeaders = stripHopByHopHeaders(receivedResponse.headers);
      if (receivedResponse.statusMessage) {
        response.writeHead(
          receivedResponse.statusCode ?? 502,
          receivedResponse.statusMessage,
          responseHeaders,
        );
      } else {
        response.writeHead(receivedResponse.statusCode ?? 502, responseHeaders);
      }
      receivedResponse.once('aborted', () => {
        if (!response.destroyed) {
          response.destroy(new Error('Metro closed the proxied response early'));
        }
      });
      receivedResponse.once('error', (error) => {
        if (!response.destroyed) {
          response.destroy(error);
        }
      });
      receivedResponse.pipe(response);
    },
  );
  trackResource(activeResources, upstreamRequest);

  upstreamRequest.on('error', (error) => {
    if (response.destroyed) {
      return;
    }
    logger('warn', 'Metro HTTP proxy request failed', {
      error: error.message,
      path: request.url,
    });
    if (!response.headersSent && !response.destroyed) {
      sendJson(response, 502, {
        error: 'native_dev_metro_unreachable',
        message: 'Metro is temporarily unavailable behind the native gateway.',
      });
    } else if (!response.destroyed) {
      response.destroy(error);
    }
  });
  const destroyUpstream = () => {
    upstreamRequest.destroy();
    upstreamResponse?.destroy();
  };
  request.once('aborted', destroyUpstream);
  response.once('close', destroyUpstream);
  request.pipe(upstreamRequest);
}

function proxyWebSocket({
  request,
  socket,
  head,
  metroHost,
  metroPort,
  getSnapshot,
  logger,
  activeResources,
}) {
  if (!isMetroReachable(getSnapshot())) {
    socket.end(
      'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\n\r\n',
    );
    return;
  }

  let connected = false;
  const upstream = net.createConnection({ host: metroHost, port: metroPort }, () => {
    connected = true;
    if (socket.destroyed) {
      upstream.destroy();
      return;
    }
    const headers = buildProxyHeaders(request.headers, metroHost, metroPort, {
      upgrade: true,
    });
    let requestHead = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          requestHead += `${name}: ${item}\r\n`;
        }
      } else if (value !== undefined) {
        requestHead += `${name}: ${value}\r\n`;
      }
    }
    requestHead += '\r\n';
    upstream.write(requestHead);
    if (head?.length) {
      upstream.write(head);
    }
    socket.pipe(upstream).pipe(socket);
  });
  trackResource(activeResources, upstream);

  upstream.on('error', (error) => {
    if (socket.destroyed) {
      return;
    }
    logger('warn', 'Metro WebSocket proxy failed', {
      error: error.message,
      path: request.url,
    });
    if (!connected && socket.writable) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy(error);
    }
  });
  socket.once('error', () => upstream.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.once('close', () => {
    if (!socket.destroyed) {
      socket.destroy();
    }
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function buildProxyHeaders(
  incomingHeaders,
  metroHost,
  metroPort,
  { upgrade = false } = {},
) {
  const headers = stripHopByHopHeaders(incomingHeaders);
  const publicHost = firstHeaderValue(incomingHeaders.host);
  const forwardedFor = firstHeaderValue(incomingHeaders['cf-connecting-ip']);

  headers.host = `${metroHost}:${metroPort}`;
  headers['x-forwarded-host'] = publicHost || '';
  headers['x-forwarded-proto'] = 'https';
  if (forwardedFor) {
    headers['x-forwarded-for'] = forwardedFor;
  }
  if (upgrade) {
    const upgradeValue = firstHeaderValue(incomingHeaders.upgrade);
    if (upgradeValue) {
      headers.connection = 'Upgrade';
      headers.upgrade = upgradeValue;
    }
  }
  return headers;
}

function stripHopByHopHeaders(incomingHeaders) {
  const headers = {};
  const connectionTokens = new Set(
    String(firstHeaderValue(incomingHeaders.connection) ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(incomingHeaders)) {
    const normalizedName = name.toLowerCase();
    if (
      value !== undefined &&
      !HOP_BY_HOP_HEADERS.has(normalizedName) &&
      !connectionTokens.has(normalizedName)
    ) {
      headers[normalizedName] = value;
    }
  }
  return headers;
}

function trackResource(resources, resource) {
  if (!resources || !resource) {
    return resource;
  }
  resources.add(resource);
  const release = () => resources.delete(resource);
  resource.once?.('close', release);
  return resource;
}

async function serveFile(
  request,
  response,
  filePath,
  { activeResources, expectedSha256 } = {},
) {
  if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) {
    response.setHeader('Allow', 'GET, HEAD');
    sendJson(response, 405, {
      error: 'native_dev_method_not_allowed',
      message: 'The IPA route supports only GET and HEAD.',
    });
    return;
  }

  const fileHandle = await fs.promises.open(filePath, 'r');
  let stream;
  try {
    const beforeHash = await fileHandle.stat();
    if (!beforeHash.isFile()) {
      throw new Error(`IPA path is not a regular file: ${filePath}`);
    }
    const sha256 = await sha256FileHandle(fileHandle, beforeHash.size);
    const stat = await fileHandle.stat();
    if (!sameFileRevision(beforeHash, stat)) {
      throw new Error('IPA changed while its download representation was prepared');
    }
    if (expectedSha256 && expectedSha256 !== sha256) {
      response.setHeader('Retry-After', '2');
      sendJson(response, 409, {
        error: 'native_dev_ipa_revision_changed',
        message: 'The signed IPA changed. Retry after runtime state is refreshed.',
      });
      return;
    }

    const etag = `"sha256-${sha256}"`;
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Disposition', 'attachment; filename="DaftCitadel.ipa"');
    response.setHeader('ETag', etag);

    if (etagMatches(firstHeaderValue(request.headers['if-none-match']), etag)) {
      response.writeHead(304);
      response.end();
      return;
    }

    let start = 0;
    let end = stat.size - 1;
    let statusCode = 200;
    const requestedRange = firstHeaderValue(request.headers.range);
    const ifRange = firstHeaderValue(request.headers['if-range']);
    const range =
      requestedRange && (!ifRange || ifRange === etag) ? requestedRange : null;
    if (range) {
      const parsedRange = parseByteRange(range, stat.size);
      if (!parsedRange) {
        response.setHeader('Content-Range', `bytes */${stat.size}`);
        response.writeHead(416);
        response.end();
        return;
      }
      ({ start, end } = parsedRange);
      statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    }

    response.setHeader('Content-Length', end - start + 1);
    response.writeHead(statusCode);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      stream = fileHandle.createReadStream({
        start,
        end,
        autoClose: false,
      });
      trackResource(activeResources, stream);
      const finish = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        response.off('close', onResponseClose);
        response.off('finish', onResponseFinish);
        activeResources?.delete(stream);
        if (!stream.destroyed) {
          stream.destroy();
        }
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onResponseClose = () => finish();
      const onResponseFinish = () => finish();
      stream.once('error', finish);
      response.once('close', onResponseClose);
      response.once('finish', onResponseFinish);
      stream.pipe(response);
    });
  } finally {
    if (stream && !stream.destroyed) {
      stream.destroy();
    }
    activeResources?.delete(stream);
    await fileHandle.close().catch(() => {});
  }
}

async function sha256FileHandle(fileHandle, size) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(Math.max(size, 1), 1024 * 1024));
  let position = 0;
  while (position < size) {
    const length = Math.min(buffer.length, size - position);
    const { bytesRead } = await fileHandle.read(buffer, 0, length, position);
    if (bytesRead === 0) {
      throw new Error('IPA ended before its advertised file size');
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function sameFileRevision(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function etagMatches(header, etag) {
  if (!header) {
    return false;
  }
  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag || value === `W/${etag}`);
}

function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) {
    return null;
  }
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

function readIpaMetadata(ipaPath, projectRoot) {
  const fallback = readProjectMetadata(projectRoot);
  if (!ipaPath || !fs.existsSync(ipaPath)) {
    return {
      ...fallback,
      available: false,
      ipaPath: ipaPath ? path.resolve(ipaPath) : null,
      sourceMissing: true,
    };
  }

  let stat;
  try {
    stat = fs.statSync(ipaPath);
    if (!stat.isFile()) {
      throw new Error('IPA path is not a regular file');
    }
    const entries = spawnSync('unzip', ['-Z1', ipaPath], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (entries.status !== 0) {
      throw new Error(entries.stderr || 'unzip could not list the IPA');
    }
    const infoPlistPath = entries.stdout
      .split(/\r?\n/)
      .find((entry) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(entry));
    if (!infoPlistPath) {
      throw new Error('IPA does not contain an application Info.plist');
    }
    const plist = spawnSync('unzip', ['-p', ipaPath, infoPlistPath], {
      encoding: null,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (plist.status !== 0) {
      throw new Error('unzip could not read the application Info.plist');
    }
    const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
      input: plist.stdout,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (converted.status !== 0) {
      throw new Error(converted.stderr || 'plutil could not decode Info.plist');
    }
    const info = JSON.parse(converted.stdout);
    const schemes = (info.CFBundleURLTypes ?? []).flatMap(
      (entry) => entry.CFBundleURLSchemes ?? [],
    );
    const devClientScheme = schemes.find(
      (scheme) => typeof scheme === 'string' && scheme.startsWith('exp+'),
    );
    if (
      typeof info.CFBundleIdentifier !== 'string' ||
      typeof info.CFBundleVersion !== 'string' ||
      !devClientScheme
    ) {
      throw new Error(
        'IPA metadata is missing its bundle identifier, build number, or Expo development-client scheme',
      );
    }
    const sha256 = sha256File(ipaPath);
    const finalStat = fs.statSync(ipaPath);
    if (!sameFileRevision(stat, finalStat)) {
      throw new Error('IPA changed while its metadata was being read');
    }

    return {
      available: true,
      ipaPath: path.resolve(ipaPath),
      sourceMissing: false,
      bundleIdentifier: info.CFBundleIdentifier,
      version: info.CFBundleShortVersionString ?? fallback.version,
      buildNumber: info.CFBundleVersion,
      displayName: info.CFBundleDisplayName ?? info.CFBundleName ?? fallback.displayName,
      devClientScheme,
      device: stat.dev,
      inode: stat.ino,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      sha256,
    };
  } catch (error) {
    return {
      ...fallback,
      available: false,
      ipaPath: path.resolve(ipaPath),
      sourceMissing: false,
      ...(stat
        ? {
            device: stat.dev,
            inode: stat.ino,
            mtimeMs: stat.mtimeMs,
            sizeBytes: stat.size,
          }
        : {}),
      metadataWarning: error.message,
    };
  }
}

function readProjectMetadata(projectRoot) {
  const defaults = {
    bundleIdentifier: 'dev.daftcitadel.app',
    version: '1.0.0',
    buildNumber: '1',
    displayName: 'Daft Citadel Dev',
    devClientScheme: DEFAULT_DEV_CLIENT_SCHEME,
  };
  const infoPath = path.join(projectRoot, 'ios', 'DaftCitadel', 'Info.plist');
  if (!fs.existsSync(infoPath)) {
    return defaults;
  }
  const converted = spawnSync('plutil', ['-convert', 'json', '-o', '-', '--', infoPath], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (converted.status !== 0) {
    return defaults;
  }
  try {
    const info = JSON.parse(converted.stdout);
    const schemes = (info.CFBundleURLTypes ?? []).flatMap(
      (entry) => entry.CFBundleURLSchemes ?? [],
    );
    return {
      bundleIdentifier: info.CFBundleIdentifier ?? defaults.bundleIdentifier,
      version: info.CFBundleShortVersionString ?? defaults.version,
      buildNumber: info.CFBundleVersion ?? defaults.buildNumber,
      displayName: info.CFBundleDisplayName ?? info.CFBundleName ?? defaults.displayName,
      devClientScheme:
        schemes.find((scheme) => scheme.startsWith('exp+')) ?? defaults.devClientScheme,
    };
  } catch {
    return defaults;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function validateExpoManifestOrigin(payload, tunnelUrl) {
  const expectedOrigin = normalizePublicUrl(tunnelUrl);
  let manifest;
  try {
    manifest = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    throw new Error('Expo root did not return a JSON manifest');
  }
  const launchAssetUrl = manifest?.launchAsset?.url ?? manifest?.bundleUrl;
  if (typeof launchAssetUrl !== 'string') {
    throw new Error('Expo manifest did not expose a launch asset URL');
  }
  const fetchableUrls = [
    ['launch asset', launchAssetUrl],
    ...(Array.isArray(manifest.assets)
      ? manifest.assets
          .filter((asset) => typeof asset?.url === 'string')
          .map((asset, index) => [`asset ${index}`, asset.url])
      : []),
  ];
  for (const [label, fetchableUrl] of fetchableUrls) {
    let actualOrigin;
    try {
      actualOrigin = new URL(fetchableUrl).origin;
    } catch {
      throw new Error(`Expo manifest ${label} URL is invalid`);
    }
    if (actualOrigin !== expectedOrigin) {
      throw new Error(
        `Expo manifest origin mismatch for ${label}: expected ${expectedOrigin}, received ${actualOrigin}`,
      );
    }
  }
  return manifest;
}

function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(
      temporaryPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporaryPath, { force: true });
  }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function isMetroReachable(snapshot) {
  return ['starting', 'probing', 'ready'].includes(snapshot.metro?.status);
}

function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
}

function sendJson(response, statusCode, value) {
  sendText(
    response,
    statusCode,
    'application/json; charset=utf-8',
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

function sendText(response, statusCode, contentType, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeXml(value) {
  return escapeHtml(value);
}

module.exports = {
  DEFAULT_DEV_CLIENT_SCHEME,
  NATIVE_DEV_ROUTE_PREFIX,
  buildDevClientUrl,
  buildInstallManifest,
  buildPublicState,
  createGateway,
  parseByteRange,
  parseTunnelUrl,
  readIpaMetadata,
  readJsonIfExists,
  renderLauncher,
  validateExpoManifestOrigin,
  writeJsonAtomic,
};
