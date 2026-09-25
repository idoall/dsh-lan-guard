<h1 align="center">DSH LAN Guard</h1>

<p align="center">Use the official DeepSeek Harness Web UI from your phone — a gated reverse proxy on your LAN that never touches DSH's own loopback binding.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-lan-guard"><img src="https://img.shields.io/npm/v/dsh-lan-guard?label=npm&color=CB3837" alt="npm version"></a>
  <a href="https://github.com/idoall/dsh-lan-guard/actions/workflows/ci.yml"><img src="https://github.com/idoall/dsh-lan-guard/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0F172A" alt="MIT"></a>
</p>

<p align="center">English | <a href="README.zh.md">中文</a></p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#compatibility">Compatibility</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#security-boundary">Security</a> ·
  <a href="#uninstall">Uninstall</a> ·
  <a href="#development">Development</a>
</p>

> DSH LAN Guard is a community plugin for DeepSeek Harness. It does not modify DSH core, does not change DSH's own listening address, and reuses the official Web UI unmodified.

DSH serves its Web UI on `127.0.0.1` only, so phones and tablets cannot reach it, and DSH deliberately refuses to bind `0.0.0.0`. This plugin leaves that binding alone and runs a **second, gated port** that proxies the official UI to your LAN: password gate, self-signed HTTPS by default, a QR code to open it on a phone, and per-device pairing you can revoke one by one.

## Features

- **Gated reverse proxy** — full HTTP and WebSocket forwarding (the official UI's `/api/remote.mux` mux included), `Host`/`Origin` rewriting, hop-by-hop header stripping, `502` when the upstream is unreachable.
- **Password gate** — PBKDF2-SHA256 (600,000 iterations), a separate **access password** (phones) and **admin password** (this console), a `dsh_` passwordless link, persistent visitor sessions, per-IP lockout and CSRF checks.
- **Self-signed HTTPS by default** — generates its own `DSH LAN Guard CA`, issues a leaf certificate for the selected NIC address, and keeps the CA identity stable across restarts so devices only trust it once.
- **Your own machine is never locked** — direct `127.0.0.1` access is physically unlocked. Remote access follows `auth.adminPolicy`: read-only (default), password-unlocked, or open.
- **Per-device pairing** — a phone that passes the gate names itself once, receives an HttpOnly device cookie, appears in the settings page (name / created / last used / source IP) and can be revoked individually. A revoked device is refused with `403` immediately.
- **Settings inside the official page** — a "局域网访问" section with four tabs: QR access, authentication, authorised devices, connection & certificates. All typography and colours use the official design tokens; the official layout is never replaced.
- **Configurable port** — defaults to `3081` (DSH's port + 1), walks up to ten ports when that one is taken, editable in the settings page with an availability check.
- **Optional mDNS** — off by default; advertises `_dsh-lan-guard._tcp` when enabled.

## Install

```sh
dsh plugin --profile web add dsh-lan-guard
```

Then restart DSH once (the plugin's server half is loaded at startup) and open **Settings → 局域网访问**.

## Usage

1. In **Settings → 局域网访问 → 安全认证**, set an **access password** (at least 8 characters). Until you do, the gate refuses every device.
2. In **连接与证书**, pick the NIC to publish on. `0.0.0.0` is the default for a configured plugin; set `listenHost: 127.0.0.1` in the config to keep it local-only while you try it out.
3. Open the **扫码访问** tab and scan the QR code with your phone.
4. On the phone: trust the `DSH LAN Guard CA` certificate (the SHA-256 fingerprint is shown in the settings page), enter the access password once, then **name the device** on the pairing page.
5. The phone now runs the official DSH UI. It appears under **已授权设备**, where you can revoke it at any time.

> Remote devices are **read-only** by default (`adminPolicy: local_only`): they can use DSH but cannot change plugin settings. Switch the policy on the desktop if you want a phone to manage them.

## Compatibility

Current release: plugin **`0.1.0`** is verified against DeepSeek Harness **`0.1.7-rc.1`** (the latest release candidate).

### Which plugin version goes with which DeepSeek Harness version

| Plugin | Verified DeepSeek Harness | On npm | What that version is |
| --- | --- | --- | --- |
| **`0.1.0`** | `0.1.7-rc.1` | `latest` | First release: gated reverse proxy, self-signed HTTPS, device pairing, settings UI, QR access |

- The declared range is `>=0.1.7-rc.1 <0.2.0` (`dsh.engines.dsh`), and `dsh.compatibility.dshReleases` records `0.1.7-rc.1: compatible`.
- A DSH release that is not listed is **unverified** — test it before trusting it.
- Install a specific version when it matters:

  ```sh
  dsh plugin --profile web add dsh-lan-guard@0.1.0
  ```

## Configuration

The plugin reads its config from its Cordis entry (profile patch or `dsh plugin` config). Defaults are conservative: **nothing is published until you say so.**

```yaml
enabled: true                    # master switch
listenHost: 0.0.0.0              # default 127.0.0.1 (loopback only); set to face the LAN
listenPort: 3081                 # DSH port + 1; auto-walks up to 10 ports when taken
upstreamOrigin: http://127.0.0.1:3080
dataDir: ~/.dsh/profiles/web/data/dsh-lan-guard
networkInterface: en0            # optional: publish on one NIC (empty = automatic)
tls:
  mode: self-signed              # 'self-signed' (default) | 'provided' | 'off'
  allowInsecureLan: false        # required acknowledgement for LAN plain HTTP
mdns:
  enabled: false                 # advertise _dsh-lan-guard._tcp
auth:
  mode: token_and_password       # 'token_and_password' | 'password' | 'token'
  adminPolicy: local_only        # 'local_only' (default) | 'password_unlock' | 'open'
  adminProtection: true          # admin console needs the admin password
  allowLoopback: true            # 127.0.0.1 visitors skip the gate (physically unlocked)
  requirePairing: true           # new remote devices must name themselves once
```

Every key above can also be changed from the settings page (the non-sensitive ones are declared as volatile config fields).

## Device approval and permanent ban

Paired devices are listed under **Settings → 局域网访问 → 已授权设备** with three groups: **pending**, **approved** and **blocked**.

- Turn on **新设备需要管理员批准** to require an explicit approval before a newly paired device is let in (off by default). A pending phone sees a "waiting for approval" page until you press **批准**.
- **吊销并拉黑** cuts a device off permanently: its identity is blocked, and re-pairing with the access password from another browser is refused too. **解除拉黑** is the only way back.
- This deliberately does not use device fingerprinting (which breaks whenever the browser or OS changes) — the operator decides, and the decision sticks.

## Updates

The settings page shows the running version next to the newest one on npm, with a **copyable** upgrade command:

```sh
dsh plugin --profile web add dsh-lan-guard@latest
```

The plugin never installs anything by itself and never restarts DSH — run the command yourself and restart DSH once. The check only asks the public npm registry, is cached for six hours, and a failure is reported in the UI instead of breaking the gate.

## Troubleshooting

**The phone shows a certificate warning.** The CA is self-signed: install/trust `DSH LAN Guard CA` once per device. Compare the fingerprint shown in **连接与证书** before trusting it.

**The phone cannot reach the address at all.** Check that the phone is on the same network, that the address matches the QR code, and that no VPN or "private relay" feature is intercepting traffic. The settings page shows the address the listener is actually bound to.

**"配置的端口 X 已被占用，已自动改用 Y".** Something else holds the port; the plugin moved on by itself. Set a different port in **连接与证书** (it has an availability check) or free the port.

**"此设备已被移除访问权限" (403).** The device was revoked under **已授权设备**. Delete that record to let it pair again.

**I forgot the access password.** On the machine that runs DSH, open `http://127.0.0.1:3080` (direct loopback access is physically unlocked) and set a new one. On a headless server, delete `secrets.json` in `dataDir` and set a new password — until then the gate refuses every device.

**Every device asks for the password again after I changed it.** That is intentional: changing the access password or the auth mode revokes every existing visitor session.

**Plain HTTP on the LAN is refused.** `listenHost` + `tls.mode: 'off'` is rejected unless you set `tls.allowInsecureLan: true` — the gate password would otherwise travel in clear text.

## Security boundary

- DSH's own listener is untouched; this plugin never edits DSH config or the official UI.
- Secrets (`secrets.json`, `devices.json`, sessions) live in `dataDir` with mode `600`; the plaintext device token is returned once and only its SHA-256 hash is stored.
- The gate applies before the listener is useful, and the proxy stamps every forwarded request with an unforgeable origin marker so the host can tell the machine's own operator from a proxied visitor.
- Loopback direct access is **physically unlocked by design** — anyone who can already use that machine can change these settings.
- The access password is **shared**: revoking a device invalidates that device's identity cookie immediately, but re-pairing with the password from another browser is still possible. A permanent per-machine ban would need device fingerprinting or per-device tokens.
- LAN-only by design: no public tunnels, no IM bots, no port forwarding.

## Uninstall

```sh
dsh plugin --profile web remove dsh-lan-guard
rm -rf ~/.dsh/profiles/web/data/dsh-lan-guard   # optional: removes secrets, devices and the CA
```

## Development

```sh
pnpm install
pnpm test          # unit + integration tests (typecheck included)
pnpm run build     # bundles lib/index.js and lib/client.js
pnpm run verify    # typecheck + tests + build + pack dry-run
```

The design and verification record lives in [`docs/`](docs/) — `SPEC.md` (what it must do), `PLAN.md` (phase gates and what was verified when), `RESEARCH.md` (verified DSH facts), `GUARDRAILS.md` (red lines), `RELEASE.md` (release flow).

## License

[MIT](LICENSE)
