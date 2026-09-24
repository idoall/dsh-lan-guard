# dsh-lan-guard

Safely expose the desktop DeepSeek Harness Web GUI to your local network.

> **Status: in progress (P1 complete).** The engineering skeleton and the loopback reverse proxy are implemented and tested; the password gate and settings UI (P2) and the LAN listener, TLS and QR code (P3) are not. The listener is loopback-only until the gate exists. See [`docs/PLAN.md`](docs/PLAN.md).

---

## What it is

dsh-lan-guard is a DeepSeek Harness (DSH) plugin. It lets a phone, tablet, or another computer on the same LAN open the DSH running on your desktop in a browser:

- **DSH's loopback binding stays untouched** — no DSH configuration changes, no DSH source modifications;
- **The official Web UI is reused as-is** — no layout replacement, no UI hijacking;
- **Password-gated** — opening the port is not the point; who gets in is;
- **Self-signed HTTPS on by default** — it can be turned off; the settings page then explains the impact.

---

## Why another one

There are already 16+ similarly named `dsh-lan-*` plugins on npm. Most of them solve the same problem: **how to open DSH's port to the LAN**.

dsh-lan-guard addresses the next question: **once it is open, who gets in.**

| Dimension | Common approach | dsh-lan-guard |
| --- | --- | --- |
| Gate | None, or relying on DSH's own cookie fence | Built-in password gate + per-IP lockout |
| UI | Some replace the official UI with a mobile-specific layout | **Official UI untouched** (so it does not drift with DSH releases) |
| DSH config | Some flip `host` to `0.0.0.0` | Leaves DSH's binding alone; proxies on a separate port |
| Transport | Usually plain HTTP | Self-signed HTTPS on by default, can be turned off |

---

## Planned capabilities

- Reverse proxy for HTTP and WebSocket (including DSH 0.1.7's Remote stream at `/api/remote.mux`)
- Request-header rewriting and upstream session-cookie injection (so proxied traffic looks like a local loopback request to DSH)
- Password gate: separate access and admin passwords, token links, persistent sessions, per-IP failure lockout
- Settings UI: mounted inside the **official DSH settings page** (registers an official seat; does not replace the official UI) for the gate, the access URL, and the QR code
- Self-signed HTTPS by default: long-lived CA plus a leaf certificate for the NIC's current IP; turning it off shows an impact notice
- LAN QR code: the settings page shows the current URL, with a password link and an admin-unlocked token link
- Multi-NIC detection and selection (virtual adapters down-ranked)
- Official Web UI left completely unchanged

---

## Explicitly out of scope

- ❌ Public tunnels (Cloudflare / cpolar / FRP / Tailscale)
- ❌ IM bots (WeChat / QQ / Feishu / Telegram)
- ❌ A mobile-specific UI (the official UI already ships responsive behaviour)
- ❌ Modifying DSH source or its `host` binding
- ❌ Multi-user accounts

---

## Documentation

### For users

| Document | Contents |
| --- | --- |
| `README.md` / [`README.zh.md`](README.zh.md) | Project overview (this file) |
| [`CHANGELOG.md`](CHANGELOG.md) | Release history |
| [`docs/SPEC.md`](docs/SPEC.md) | Technical specification: what it does and does not do |
| [`docs/PLAN.md`](docs/PLAN.md) | Staged implementation plan and acceptance criteria |

### For AI assistants (required reading before implementing)

| Document | Contents |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | **AI collaboration charter**: responsibilities, red lines, stop points, workflow, drift self-check |
| [`docs/GUARDRAILS.md`](docs/GUARDRAILS.md) | Permission boundaries: allowed / forbidden / ask-first, responsibility matrix |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | Verified DSH facts baseline (with file paths and line numbers) |
| [`docs/RELEASE.md`](docs/RELEASE.md) | Release process and authorization levels |

> If you are handing this project to an AI to implement: **have it read `AGENTS.md` first.** That file exists specifically to keep it from drifting.

---

## Security notes

- The plugin does **not** listen externally by default; explicit configuration is required;
- A LAN is not a trusted network. Any device on the same subnet can attempt to connect, so the gate is mandatory, not optional;
- Self-signed HTTPS requires trusting the CA on the phone once;
- Passwords are stored as PBKDF2-SHA256 hashes; no plaintext credentials or private keys will ever appear in this repository.

- **mDNS discovery is optional and off by default** (`mdns.enabled`). Even when on, iOS Safari and Android Chrome do not resolve `.local` names for arbitrary web pages in practice — the QR code stays the reliable path on a phone.

---

## Development

Requires Node ≥ 20 and pnpm.

```sh
pnpm install
pnpm test        # type check (src + tests) + vitest
pnpm run build   # tsdown → lib/
```

---

## License

[MIT](LICENSE)
