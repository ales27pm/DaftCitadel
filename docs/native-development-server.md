# Native development server

Daft Citadel uses a detached, single-origin supervisor for physical-device
development. It keeps the Expo manifest, JavaScript bundles, inspector and HMR
WebSockets, launcher, signed IPA, and OTA installation manifest on one
Cloudflare quick-tunnel origin.

This avoids the stale-host failure mode where an install page survives while a
separate Metro tunnel has already expired with Cloudflare error 1033.

## Commands

Start the service and wait until the public manifest and launch asset have been
verified:

```bash
npm run native-dev -- start
```

Inspect its machine-readable state:

```bash
npm run native-dev -- status
```

Restart or stop the complete gateway/tunnel/Metro process tree:

```bash
npm run native-dev -- restart
npm run native-dev -- stop
```

Run in the foreground when diagnosing startup:

```bash
npm run native-dev -- foreground
```

The default local ports are `18081` for the gateway and `8081` for Metro. If
either is occupied, the supervisor chooses the next available port without
terminating an unrelated process. Preferred ports can be supplied explicitly:

```bash
npm run native-dev -- start --gateway-port 18100 --metro-port 8090
```

## Runtime contract

Runtime state is written atomically to:

```text
build/native-dev/runtime-state.json
```

Structured supervisor and child-process logs are written to:

```text
build/native-dev/supervisor.log
```

The public launcher is exposed at `/__native-dev/`. All paths outside
`/__native-dev` are streamed directly to Metro, including generic HTTP Upgrade
requests. The supervisor starts Expo only after Cloudflare returns a live
origin, with:

```text
EXPO_PACKAGER_PROXY_URL=<the exact live HTTPS origin>
```

Readiness requires all of the following:

1. The local gateway responds with the current run nonce.
2. The public gateway responds with that same nonce, tolerating initial
   Cloudflare DNS propagation.
3. Local and public Metro status report `packager-status:running`.
4. Public Expo manifest `HEAD` and `GET` requests succeed.
5. The manifest launch asset uses the exact current tunnel origin.
6. Every fetchable manifest asset uses that same origin.
7. A `GET` for the launch asset returns actual JavaScript bytes through the
   public gateway. Header-only success is not treated as bundle readiness.

If Metro exits, it is restarted behind the existing origin. If cloudflared
exits, both processes are reconciled under a new tunnel generation so Metro can
never advertise the previous host. Signals stop the owned child process groups
and close the gateway before state becomes `stopped`.

After startup, the supervisor continuously probes the public gateway nonce,
Metro status, Expo manifest, and launch asset. The first failed probe moves the
machine-readable state to `degraded`. Three consecutive failures rotate the
quick tunnel and restart Metro with the replacement origin. Running `start`
against an existing detached process also revalidates its public origin instead
of trusting a cached `ready` state.

## Signed iOS client

The default signed artifact is:

```text
build/native-dev/export/DaftCitadel.ipa
```

When present, the launcher dynamically generates its OTA installation plist
from the current origin and metadata read from the IPA. `GET`, `HEAD`, byte
ranges, `If-None-Match`, `If-Range`, and unsatisfiable-range responses are
supported. Downloads use a SHA-256 ETag and one open file descriptor so an
atomic artifact replacement cannot splice two IPA revisions into one resumed
download. Invalid or unreadable IPAs fail closed and are not advertised.

Replace the IPA atomically (write a new file and rename it over the existing
path). The supervisor detects the new file identity, refreshes its metadata, and
publishes the new revision without serving it under the previous ETag.

## Security boundary

A Cloudflare quick-tunnel hostname is an unguessable, temporary bearer
capability. Expo development clients cannot attach an application-specific
authorization header to every manifest, bundle, asset, and WebSocket request,
so possession of the hostname grants access to the development Metro,
inspector, launcher, and signed IPA. Do not publish or reuse the URL outside the
intended development devices. Stop the supervisor when the session is no
longer needed.

Cloudflare quick tunnels remain temporary hostnames. The detached supervisor
keeps one alive across terminal and Codex session closure, but it cannot retain
the same hostname after a process restart or machine reboot. A named
Cloudflare tunnel and DNS record are required if a permanent hostname is
needed.
