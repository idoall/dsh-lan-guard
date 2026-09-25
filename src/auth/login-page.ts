/**
 * dsh-lan-guard — the visitor login page.
 *
 * Three states must be visually distinct, because two of them look like a
 * working gate but are not:
 *
 * - `invalid` — a wrong password;
 * - `locked` — this IP is locked out, with the honest remaining time;
 * - `no-password` — NO password is configured, so the gate cannot let anyone
 *   in. Showing a plain "wrong password" here would be the "any password
 *   works" illusion the spec forbids.
 *
 * The page carries no credential, no token and no state beyond what the URL
 * already exposes. Colours go through the official `--dsw-alias-*` variables
 * with fallbacks, because this page is served on the PROXY origin where the
 * official stylesheet is not loaded.
 */
import type { AuthMode } from '../config.ts'

/** Which state the login page should render. */
export type LoginState =
  | 'prompt' | 'invalid' | 'locked' | 'no-password' | 'csrf' | 'token-only'
  | 'device-removed' | 'pending-approval' | 'link-inactive'

/** Options for {@link renderLoginPage}. */
export interface LoginPageOptions {
  state: LoginState
  mode: AuthMode
  /** Absolute lockout end, for the honest remaining-time message. */
  lockedUntilMs?: number
  /** Clock injection for tests. */
  now?: number
  /** Where to go after a successful login (already validated as a local path). */
  next?: string
}

/**
 * Render the device-pairing page (P4-g).
 *
 * Shown to a device that has just passed the password/link gate but carries no
 * device identity: naming it is what makes the "已授权设备" list meaningful and
 * what makes a later revoke effective (user request 2026-09-24, modelled on
 * dsh-mobile's pairing screen).
 */
export function renderPairingPage(options: {
  defaultLabel: string
  ip: string
  error?: 'invalid' | 'csrf'
}): string {
  const notice = options.error === 'csrf'
    ? '<p class="notice error">请求来源校验未通过，请重新提交。</p>'
    : options.error === 'invalid'
      ? '<p class="notice error">设备名称不能为空。</p>'
      : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>确认设备 · DSH 局域网访问</title>
<style>${LOGIN_CSS}</style>
</head>
<body>
<main class="card">
  <h1>确认这台设备</h1>
  <p class="sub">给它起个名字，方便你在「已授权设备」里识别、也方便日后单独吊销。</p>
  ${notice}
  <div class="lg-mono-static">来源地址：${escapeHtml(options.ip)}</div>
  <form method="post" action="/__dsh_lan_guard__/pair" autocomplete="off">
    <label for="label">设备名称</label>
    <input id="label" name="label" type="text" value="${escapeHtml(options.defaultLabel)}" autofocus required>
    <button type="submit">确认并进入 DSH</button>
  </form>
  <p class="hint">管理员随时可以在设置页吊销这台设备；吊销后本设备需要重新确认。</p>
</main>
</body>
</html>
`
}

/** Escape text for HTML text nodes and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Human-readable remaining lockout time. */
function remainingSeconds(lockedUntilMs: number | undefined, now: number): number {
  if (lockedUntilMs === undefined) return 0
  return Math.max(0, Math.ceil((lockedUntilMs - now) / 1_000))
}

const LOGIN_CSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-base,#f6f7f9);color:var(--dsw-alias-text-primary,#1f2329);
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif}
.card{width:min(400px,calc(100vw - 32px));background:var(--dsw-alias-bg-elevated,#fff);
  border:1px solid var(--dsw-alias-border-subtle,#e5e6eb);border-radius:14px;padding:24px;
  box-shadow:0 8px 28px rgba(0,0,0,.06)}
h1{margin:0 0 6px;font-size:18px}
.sub{margin:0 0 18px;font-size:13px;color:var(--dsw-alias-text-secondary,#6b7280)}
label{display:block;font-size:13px;margin:0 0 6px;color:var(--dsw-alias-text-secondary,#6b7280)}
input[type=password],input[type=text]{width:100%;height:44px;padding:0 12px;font-size:16px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-subtle,#d0d3d9);background:var(--dsw-alias-bg-base,#fff);
  color:var(--dsw-alias-text-primary,#1f2329)}
input[type=password]:focus{outline:2px solid var(--dsw-alias-brand-primary,#4f46e5);outline-offset:1px}
button{width:100%;height:44px;margin-top:14px;border:0;border-radius:10px;font-size:15px;font-weight:600;
  color:#fff;background:var(--dsw-alias-brand-primary,#4f46e5);cursor:pointer}
button:disabled{opacity:.6;cursor:not-allowed}
.notice{margin:0 0 16px;padding:10px 12px;border-radius:10px;font-size:13px;line-height:1.5}
.notice.error{background:var(--dsw-alias-bg-danger,#fef2f2);color:var(--dsw-alias-text-danger,#b91c1c);
  border:1px solid var(--dsw-alias-border-danger,#fecaca)}
.notice.warn{background:var(--dsw-alias-bg-warning,#fffbeb);color:var(--dsw-alias-text-warning,#92400e);
  border:1px solid var(--dsw-alias-border-warning,#fde68a)}
.hint{margin:14px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-text-secondary,#6b7280)}
.lg-mono-static{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-secondary,#f1f2f4);
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;color:var(--dsw-alias-text-primary,#1f2329)}
@media (hover:none) and (pointer:coarse){button,input[type=password]{height:48px}}
`.trim()

/** Build the state-specific notice block. */
function notice(state: LoginState, lockedUntilMs: number | undefined, now: number): string {
  if (state === 'invalid') {
    return '<p class="notice error">密码错误，请重试。</p>'
  }
  if (state === 'locked') {
    const seconds = remainingSeconds(lockedUntilMs, now)
    return `<p class="notice error">尝试次数过多，该地址已被临时锁定${
      seconds > 0 ? `，请在约 ${String(seconds)} 秒后重试` : '，请稍后重试'
    }。</p>`
  }
  if (state === 'csrf') {
    return '<p class="notice error">请求来源校验未通过，请从本页重新登录。</p>'
  }
  if (state === 'link-inactive') {
    return '<p class="notice error">这条免密链接无效，或当前「仅密码」模式不使用免密链接。<br>'
      + '请输入访问密码；若希望链接可用，请在运行本程序的电脑上把验证模式改为「令牌 + 密码」。</p>'
  }
  if (state === 'pending-approval') {
    return '<p class="notice">⏳ <strong>这台设备正在等待管理员批准。</strong><br>'
      + '请在运行本程序的电脑上打开设置 → 局域网访问 → 已授权设备，点「批准」后刷新本页即可进入。</p>'
  }
  if (state === 'device-removed') {
    return '<p class="notice error"><strong>此设备已被移除访问权限。</strong><br>'
      + '请联系管理员在「已授权设备」中重新放行，或让管理员删除该记录后重新确认。</p>'
  }
  if (state === 'token-only') {
    return '<p class="notice warn">当前验证模式为<strong>仅安全 Token</strong>，不接受密码登录。'
      + '请使用管理员提供的免密链接或二维码。</p>'
  }
  if (state === 'no-password') {
    return '<p class="notice warn"><strong>尚未设置访问密码。</strong><br>'
      + '出于安全考虑，未设置密码时门禁不会放行任何设备。'
      + '请在桌面 DSH 的「设置 → 局域网访问」中设置访问密码。</p>'
  }
  return ''
}

/**
 * Render the login page.
 *
 * @param options - the state, the auth mode and optional lockout/redirect data.
 * @returns a complete HTML document.
 */
export function renderLoginPage(options: LoginPageOptions): string {
  const now = options.now ?? Date.now()
  const blocked = options.state === 'locked' || options.state === 'no-password'
    || options.state === 'device-removed' || options.state === 'pending-approval'
    || options.state === 'link-inactive'
  const next = options.next !== undefined && options.next.startsWith('/') ? options.next : '/'
  const modeHint = options.mode === 'password'
    ? '本设备需要输入访问密码。'
    : options.mode === 'token'
      ? '本设备使用免密链接访问；如已失效，请向管理员索取新的二维码。'
      : '输入访问密码，或使用管理员提供的免密链接。'

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>需要访问密码 · DSH 局域网访问</title>
<style>${LOGIN_CSS}</style>
</head>
<body>
<main class="card">
  <h1>局域网访问</h1>
  <p class="sub">${escapeHtml(modeHint)}</p>
  ${notice(options.state, options.lockedUntilMs, now)}
  <form method="post" action="/__dsh_lan_guard__/login" autocomplete="off">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="password">访问密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
      autofocus ${blocked ? 'disabled' : ''} required>
    <button type="submit" ${blocked ? 'disabled' : ''}>进入 DSH</button>
  </form>
  <p class="hint">此页面由 dsh-lan-guard 提供。密码通过 HTTPS 或局域网传输，请仅在可信网络中访问。</p>
</main>
</body>
</html>
`
}
