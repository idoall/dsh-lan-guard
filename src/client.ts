/**
 * dsh-lan-guard — the browser half: one section inside DSH's OFFICIAL settings
 * page (docs/SPEC.md F6).
 *
 * Hard constraints from the spec, all of them load-bearing:
 *
 * - It registers the official `settings.section` seat and replaces NOTHING.
 *   Layout seats (`sidebar`, `rightbar`, `shell.leading`) and layout root
 *   hooks are out of bounds (docs/GUARDRAILS.md §7).
 * - Pure `React.createElement` — no JSX, no extra front-end build step.
 * - Styles are inline CSS using the official `--dsw-alias-*` variables, so the
 *   light/dark theme follows automatically (dsh-mobile once shipped a
 *   reference to a non-existent alias and lost the dark theme entirely).
 * - Responsive at two breakpoints: coarse pointers get ≥44px targets, and
 *   ≤620px collapses to a single column.
 * - Passwords and tokens are NEVER echoed: the page only shows whether they
 *   are set, and every write goes through the host endpoint with
 *   `credentials: 'same-origin'`.
 *
 * The section reads and writes `/plugins/dsh-lan-guard/config` on DSH's own
 * origin — the management surface, guarded by DSH's native fence. That is a
 * different auth surface from the proxy port's visitor gate.
 */
import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react'

/** Plugin id: also the Loader entry id and the settings namespace. */
const PLUGIN_ID = 'dsh-lan-guard'
/** The official additive settings seat. */
const SEAT = 'settings.section'
/** The management endpoint on DSH's own origin. */
const CONFIG_PATH = '/plugins/dsh-lan-guard/config'

/** The four credential modes offered by the big-card selector. */
const MODE_CHOICES: readonly { id: string; title: string; detail: string }[] = [
  { id: 'token_and_password', title: '扫码免密 + 密码', detail: '既能扫码免密进入，也能手动输入访问密码' },
  { id: 'password', title: '仅密码', detail: '所有设备都必须输入访问密码' },
  { id: 'token', title: '仅安全 Token', detail: '只接受免密链接，不接受密码登录' },
]

/** Admin unlock policies. */
const POLICY_CHOICES: readonly { id: string; title: string; detail: string }[] = [
  { id: 'password_unlock', title: '密码解锁', detail: '任何设备打开设置页都需要管理员密码解锁' },
  { id: 'local_only', title: '仅本机', detail: '只有本机回环访问可以管理，其他设备只读' },
  { id: 'open', title: '不锁定', detail: '不额外解锁，任何能打开设置页的人都能修改' },
]

/** The three tabs of the section (user decision 2026-09-24). */
const TABS = [
  { id: 'access', label: '扫码访问' },
  { id: 'security', label: '安全认证' },
  { id: 'devices', label: '已授权设备' },
  { id: 'connection', label: '连接与证书' },
] as const

/** One tab id. */
type TabId = (typeof TABS)[number]['id']

/** The snapshot the host returns. */
/** What `/update` returns (SPEC F8). */
interface UpdateStatus {
  current: string
  latest: string | null
  hasUpdate: boolean
  checkedAtMs: number | null
  error: string | null
}

interface ConfigSnapshot {
  ok: boolean
  preferences: {
    enabled: boolean
    listenPort: number
    networkInterface: string
    mode: string
    adminPolicy: string
    adminProtection: boolean
    allowLoopback: boolean
    requirePairing: boolean
    requireApproval: boolean
  }
  listener: {
    listenHost: string
    listenPort: number
    configuredPort: number
    portFallback: boolean
    upstreamOrigin: string
  }
  authStatus: {
    pluginEnabled: boolean
    gateEnabled: boolean
    mode: string
    adminPolicy: string
    adminProtection: boolean
    allowLoopback: boolean
    localAccess: boolean
    adminRequired: boolean
    remoteReadOnly: boolean
    hasPassword: boolean
    hasAdminPassword: boolean
    hasSecretToken: boolean
    adminUnlocked: boolean
  }
  secretToken?: string
  devices: {
    id: string
    label: string
    status: 'pending' | 'approved' | 'blocked'
    decidedAtMs: number | null
    createdAtMs: number
    lastSeenAtMs: number | null
    lastIp: string | null
    revoked: boolean
  }[]
  pendingCount: number
  access: {
    port: number
    portFallbackFrom: number | null
    secure: boolean
    tlsMode: string
    caFingerprint: string | null
    loopbackOnly: boolean
    addresses: {
      interface: string
      address: string
      url: string
      virtual: boolean
      virtualReason?: string
      selected: boolean
    }[]
    selectedUrl: string | null
    qrSvg: string | null
    tokenUrl?: string
    tokenQrSvg?: string
    unavailableReason?: string
  }
}

const CSS = `
/*
 * Typography: NOTHING is invented here. DSH 0.1.7 ships a font scale as font
 * shorthands — --dsw-font-{base-16,s-14,xs-13,xxs-12,xxxs-11} plus -strong-
 * variants — each pairing a size with its line-height (16/24, 14/22, 13/20,
 * 12/18, 11/14) and weight (400 regular, 500 strong). Sizes, weights and
 * line-heights therefore come from the official tokens; only colours use the
 * official --dsw-alias-* variables, and only the URL box overrides the family
 * (with the official code font). See docs/RESEARCH.md §4.2.13.
 */
.lg-root{max-width:790px;display:flex;flex-direction:column;gap:18px}
/*
 * Tab bar = the OFFICIAL segmented-control pattern (the 外观 浅色/深色/跟随系统
 * selector in 通用设置): every item keeps the SAME font and the SAME
 * label-primary colour; selection is a filled background (bg-layer-3) with a
 * stronger border. Dimming the unselected labels and dropping their weight was
 * my own invention and made 2 of 3 tabs look like they had not been themed
 * (user feedback 2026-09-24).
 */
.lg-tabs{display:flex;gap:8px;flex-wrap:wrap}
.lg-tab{font:var(--dsw-font-s-14,14px/22px sans-serif);cursor:pointer;
  color:var(--dsw-alias-label-primary,#1f2329);background:transparent;
  border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:20px;padding:6px 14px}
.lg-tab[aria-selected=true]{background:var(--dsw-alias-bg-layer-3,#f1f2f4);
  border-color:var(--dsw-alias-label-tertiary,#adb2b8)}
.lg-tabbody{display:flex;flex-direction:column;gap:18px}
.lg-card{background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e6eb);
  border-radius:14px;padding:20px}
.lg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.lg-title{font:var(--dsw-font-base-strong-16,500 16px/24px sans-serif);margin:0;
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-sub{font:var(--dsw-font-xxs-12,12px/18px sans-serif);margin:4px 0 0;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;
  font:var(--dsw-font-xxs-12,12px/18px sans-serif);white-space:nowrap;
  background:var(--dsw-alias-state-success-tertiary,#e8f5e9);color:var(--dsw-alias-state-success-primary,#1b5e20)}
.lg-pill.off{background:var(--dsw-alias-bg-layer-3,#f1f2f4);color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-bar{display:flex;align-items:center;gap:8px;justify-content:space-between;margin-top:16px;padding:10px 12px;
  border-radius:10px;font:var(--dsw-font-xs-13,13px/20px sans-serif);
  background:var(--dsw-alias-state-success-tertiary,#e8f5e9);color:var(--dsw-alias-state-success-primary,#1b5e20)}
.lg-bar-compact{margin-top:0;padding:6px 10px}
.lg-bar.info{background:var(--dsw-alias-state-business-tertiary,#e8f0fe);color:var(--dsw-alias-state-business-primary,#1a3f8f)}
.lg-bar.warn{background:var(--dsw-alias-state-warn-tertiary,#fffbeb);color:var(--dsw-alias-state-warn-label,#92400e)}
.lg-bar.danger{background:var(--dsw-alias-interactive-bg-hover-danger,#fef2f2);color:var(--dsw-alias-state-error-primary,#b91c1c)}
.lg-mono-sm{font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-mono{margin-top:14px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-base,#f1f2f4);
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);
  font:var(--dsw-font-xs-13,13px/20px sans-serif);
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);
  word-break:break-all;color:var(--dsw-alias-label-primary,#1f2329)}
.lg-row{display:flex;gap:10px;margin-top:12px}
/* auto-fit: two options (TLS) fill the row evenly instead of leaving a third
   of the row empty, and three options (mode) still fit on one line. */
.lg-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px;margin-top:12px}
.lg-choice{text-align:left;cursor:pointer;border-radius:12px;padding:14px;background:var(--dsw-alias-bg-layer-1,#fff);
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);color:inherit}
.lg-choice[aria-pressed=true]{border:2px solid var(--dsw-static-deepseek-500,#4f46e5);
  background:var(--dsw-alias-interactive-bg-hover,#eef0ff)}
.lg-choice h4{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);margin:0 0 6px;
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-choice p{font:var(--dsw-font-xxs-12,12px/18px sans-serif);margin:0;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-field{display:flex;flex-direction:column;gap:6px;margin-top:14px}
.lg-label{font:var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-input{box-sizing:border-box;height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,#d0d3d9);
  font:var(--dsw-font-s-14,14px/22px sans-serif);
  background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329)}
.lg-btn{box-sizing:border-box;height:44px;padding:0 16px;border:0;border-radius:10px;cursor:pointer;
  font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);
  /* Brand blue + the official white token (both are official variables): the
     reference implementation's primary action colour, chosen by the user
     2026-09-24 over the theme-dependent near-white default. */
  background:var(--dsw-static-deepseek-500,#4176e6);
  color:var(--dsw-static-neutral-bluish-00,#fff)}
.lg-btn.secondary{background:var(--dsw-alias-bg-layer-3,#fff);color:var(--dsw-alias-label-primary,#1f2329);
  border:1px solid var(--dsw-alias-border-l2,#d0d3d9)}
.lg-btn:disabled{opacity:.55;cursor:not-allowed}
.lg-btn.full{width:100%}
.lg-btn-small{height:28px;padding:0 10px;font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-toggle{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;
  font:var(--dsw-font-s-14,14px/22px sans-serif);color:var(--dsw-alias-label-primary,#1f2329)}
.lg-switch{width:48px;height:28px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#d0d3d9);
  background:var(--dsw-alias-bg-layer-3,#f1f2f4);position:relative;cursor:pointer;flex:0 0 auto}
.lg-switch[aria-checked=true]{background:var(--dsw-static-deepseek-500,#4176e6);border-color:transparent}
.lg-switch[aria-checked=true] span{background:var(--dsw-static-neutral-bluish-00,#fff)}
.lg-switch span{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;
  background:var(--dsw-alias-label-primary-foreground,#fff);transition:left .15s}
.lg-switch[aria-checked=true] span{left:23px}
/* The white plate HUGS the code (fit-content + auto margins) instead of
   stretching across the card, and the code is a compact 190px — matching the
   reference implementation's proportions (user feedback 2026-09-24). */
.lg-qr{margin:14px auto 0;padding:10px;border-radius:10px;background:#fff;
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);width:fit-content}
.lg-qr svg{display:block;width:190px;height:190px}
.lg-hint{font:var(--dsw-font-xxs-12,12px/18px sans-serif);margin:14px 0 0;
  color:var(--dsw-alias-label-tertiary,#6b7280)}
.lg-lock{display:flex;flex-direction:column;align-items:center;text-align:center;padding:16px 20px 8px;gap:12px}
.lg-lock-emoji{font:var(--dsw-font-xl-24,600 24px/32px sans-serif)}
.lg-lock h3{font:var(--dsw-font-xl-24,600 24px/32px sans-serif);margin:0;
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-lockpill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:4px 12px;
  font:var(--dsw-font-xs-13,13px/20px sans-serif);
  background:var(--dsw-alias-state-success-tertiary,#e8f5e9);color:var(--dsw-alias-state-success-primary,#1b5e20)}
.lg-lock p{font:var(--dsw-font-s-14,14px/22px sans-serif);margin:0;max-width:560px;
  color:var(--dsw-alias-label-secondary,#6b7280)}
.lg-lock .lg-input{width:100%;text-align:left}
.lg-lock .lg-btn{margin-top:4px}
.lg-update{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.lg-chip{padding:3px 10px;border-radius:999px;background:var(--dsw-alias-state-success-tertiary,#ecfdf5);
  color:var(--dsw-alias-state-success-primary,#059669);font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-chip.warn{background:var(--dsw-alias-state-business-tertiary,#eff6ff);
  color:var(--dsw-static-deepseek-500,#4176e6)}
.lg-link{color:var(--dsw-alias-label-secondary,#6b7280);text-decoration:none;
  font:var(--dsw-font-xxs-12,12px/18px sans-serif)}
.lg-link:hover{color:var(--dsw-alias-label-primary,#1f2329)}
.lg-update-panel{margin:0;padding:12px;border-radius:10px;
  background:var(--dsw-alias-layer-2,#f1f2f4);border:1px solid var(--dsw-alias-border-l2,#e5e6eb)}
.lg-update-title{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);
  color:var(--dsw-alias-label-primary,#1f2329);margin-bottom:8px}
.lg-sec-title{margin:18px 0 2px;font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);
  color:var(--dsw-alias-label-secondary,#adb2b8)}
.lg-chip.ok,.lg-chip.wait,.lg-chip.ban{margin-left:6px}
.lg-chip.wait{background:var(--dsw-alias-state-warn-tertiary,#3a2f16);color:var(--dsw-alias-state-warn-label,#fbbf24)}
.lg-chip.ban{background:var(--dsw-static-red-600-a08,#ec13131f);color:var(--dsw-static-red-400,#f25a5a)}
.lg-danger{color:var(--dsw-static-red-400,#f25a5a);border-color:var(--dsw-static-red-400,#f25a5a)}
.lg-device{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;
  padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-base,#f1f2f4);
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb)}
.lg-device-name{font:var(--dsw-font-s-strong-14,500 14px/22px sans-serif);
  color:var(--dsw-alias-label-primary,#1f2329)}
.lg-recover{margin-top:8px;text-align:left;width:100%}
.lg-recover p{font:var(--dsw-font-xs-13,13px/20px sans-serif);margin:0 0 6px;
  color:var(--dsw-alias-label-tertiary,#6b7280)}
.lg-link{border:0;background:transparent;cursor:pointer;padding:2px 6px;
  font:var(--dsw-font-s-14,14px/22px sans-serif);color:var(--dsw-alias-state-error-primary,#b91c1c)}
@media (hover:none) and (pointer:coarse){.lg-btn,.lg-input,.lg-switch,.lg-tab{min-height:44px}}
@media (max-width:620px){.lg-grid{grid-template-columns:1fr}.lg-row{flex-direction:column}}
`.trim()

/** Fetch the settings snapshot. */
async function loadSnapshot(): Promise<ConfigSnapshot> {
  const response = await fetch(CONFIG_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`settings request failed: ${String(response.status)}`)
  return await response.json() as ConfigSnapshot
}

/** Send a management write. */
async function postConfig(body: Record<string, unknown>): Promise<ConfigSnapshot> {
  const response = await fetch(CONFIG_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const parsed = await response.json() as ConfigSnapshot & { error?: string }
  if (!response.ok) throw new Error(parsed.error ?? `settings write failed: ${String(response.status)}`)
  return parsed
}

/** One card. */
function Card(props: { title?: string; subtitle?: string; right?: ReactElement | null; children?: unknown }): ReactElement {
  // A card without a title renders no header at all: the lock card is a single
  // centred block, and a header plus a centred heading duplicated the same
  // sentence (user feedback 2026-09-24).
  return createElement('section', { className: 'lg-card' }, [
    props.title === undefined
      ? null
      : createElement('div', { className: 'lg-head', key: 'head' }, [
        createElement('div', { key: 'titles' }, [
          createElement('h3', { className: 'lg-title', key: 't' }, props.title),
          props.subtitle === undefined
            ? null
            : createElement('p', { className: 'lg-sub', key: 's' }, props.subtitle),
        ]),
        props.right ?? null,
      ]),
    props.children as ReactElement,
  ])
}

/** The three-way big-card selector. */
function ChoiceGrid(props: {
  choices: readonly { id: string; title: string; detail: string }[]
  value: string
  onPick: (id: string) => void
  disabled?: boolean
}): ReactElement {
  return createElement('div', { className: 'lg-grid' }, props.choices.map(choice => createElement(
    'button',
    {
      key: choice.id,
      type: 'button',
      className: 'lg-choice',
      'aria-pressed': props.value === choice.id,
      disabled: props.disabled === true,
      onClick: () => props.onPick(choice.id),
    },
    [
      createElement('h4', { key: 't' }, choice.title),
      createElement('p', { key: 'd' }, choice.detail),
    ],
  )))
}

/**
 * The settings section component.
 *
 * Three tabs (user decision, 2026-09-24) and EXACTLY ONE QR code at any time —
 * the earlier design drew the normal-link QR before a password existed (a code
 * that could only lead to "no password configured") and then added a second
 * one after unlocking, which read as "two QR codes, no idea which one to scan".
 * The single code shown is always one that works:
 *
 * - no access password yet → no QR at all, just the step that unblocks it;
 * - password set, management console locked → the normal link (scan, then type
 *   the password), with a note that unlocking reveals the passwordless code;
 * - unlocked → the passwordless link (scan and you are in).
 */
function SettingsSection(): ReactElement {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<TabId>('access')
  const [password, setPassword] = useState('')
  const [adminPassword, setAdminPassword] = useState('')
  const [unlockPassword, setUnlockPassword] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [showRecovery, setShowRecovery] = useState(false)
  const [portDraft, setPortDraft] = useState('')
  const [portCheck, setPortCheck] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateBusy, setUpdateBusy] = useState(false)

  // A transient confirmation: a permanent bar costs a whole row of the page
  // for information that is stale a second later (user feedback 2026-09-24).
  const flash = useCallback((message: string): void => {
    setNotice(message)
    setTimeout(() => setNotice(null), 2500)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await loadSnapshot())
      setError(null)
    } catch (failure) {
      setError((failure as Error).message)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const write = useCallback(async (body: Record<string, unknown>): Promise<void> => {
    setBusy(true)
    try {
      await postConfig(body)
      // Re-read instead of trusting the write's own snapshot: that snapshot is
      // computed BEFORE the response's Set-Cookie is stored, so an unlock would
      // otherwise report itself as still locked (and a lock as still unlocked).
      setSnapshot(await loadSnapshot())
      setError(null)
      flash('已保存')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [flash])

  /** Approve / block / unblock a device (F9). */
  const deviceAction = useCallback(async (id: string, action: string): Promise<void> => {
    setBusy(true)
    try {
      await fetch('/plugins/dsh-lan-guard/devices', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action, id }),
      })
      setSnapshot(await loadSnapshot())
      flash(action === 'approve' ? '已批准' : action === 'block' ? '已拉黑' : '已解除拉黑')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [flash])

  /** Revoke one device. */
  const revokeDevice = useCallback(async (id: string): Promise<void> => {
    setBusy(true)
    try {
      await fetch('/plugins/dsh-lan-guard/devices', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ action: 'revoke', id }),
      })
      setSnapshot(await loadSnapshot())
      flash('已吊销')
    } catch (failure) {
      setError((failure as Error).message)
    } finally {
      setBusy(false)
    }
  }, [flash])

  /** Ask the host what npm has (SPEC F8). Read-only; the host installs nothing. */
  const loadUpdate = useCallback(async (force: boolean): Promise<void> => {
    setUpdateBusy(true)
    try {
      const response = await fetch(`/plugins/dsh-lan-guard/update${force ? '?force=1' : ''}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      setUpdate(await response.json() as UpdateStatus)
    } catch {
      setUpdate({ current: '?', latest: null, hasUpdate: false, checkedAtMs: null, error: 'unreachable' })
    } finally {
      setUpdateBusy(false)
    }
  }, [])

  useEffect(() => {
    void loadUpdate(false)
  }, [loadUpdate])

  /** Ask the host whether a candidate port is free (loopback-only probe). */
  const checkPort = useCallback(async (candidate: string): Promise<void> => {
    const port = Number.parseInt(candidate, 10)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortCheck('请输入 1–65535 之间的端口号')
      return
    }
    setPortCheck('检查中…')
    try {
      const response = await fetch(`/plugins/dsh-lan-guard/port-check?port=${String(port)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const body = await response.json() as { available?: boolean }
      setPortCheck(body.available === true ? `端口 ${String(port)} 可用` : `端口 ${String(port)} 已被占用`)
    } catch {
      setPortCheck('检查失败')
    }
  }, [])

  /** Submit the admin unlock, keeping the button an ENABLED primary action. */
  const submitUnlock = async (): Promise<void> => {
    if (unlockPassword === '') {
      setNotice('请输入访问密码')
      return
    }
    await write({ adminUnlock: unlockPassword })
    setUnlockPassword('')
  }

  if (error !== null && snapshot === null) {
    return createElement('div', { className: 'lg-root' }, [
      createElement('style', { key: 'css' }, CSS),
      createElement(Card, { key: 'card', title: '局域网访问', subtitle: '无法读取设置', children:
        createElement('p', { className: 'lg-hint' }, error) }),
    ])
  }
  if (snapshot === null) {
    return createElement('div', { className: 'lg-root' }, [
      createElement('style', { key: 'css' }, CSS),
      createElement('p', { className: 'lg-hint', key: 'loading' }, '正在读取局域网访问设置…'),
    ])
  }

  const { preferences, authStatus, listener, access } = snapshot
  const running = authStatus.pluginEnabled && authStatus.gateEnabled
  const hasPassword = authStatus.hasPassword
  const unlocked = authStatus.adminUnlocked || preferences.adminPolicy === 'open'
  // First-run bootstrap: with NO password configured there is nothing to
  // protect yet (the gate refuses every device), and the lock card would hide
  // the very form that sets the first password — a deadlock the real DSH
  // environment hit. Locking therefore only starts once a password exists.
  // The server is authoritative: it knows whether this request reached DSH
  // directly on loopback (physical unlock privilege) or through the LAN
  // gateway. Guessing here is what locked the console on the operator's own
  // machine (user feedback 2026-09-24).
  const locked = hasPassword && authStatus.adminRequired === true && !authStatus.adminUnlocked
  const readOnly = authStatus.remoteReadOnly
  // Exactly ONE address is shown, and it is the one the QR encodes, so the
  // page never presents two different links to the same console (user
  // feedback 2026-09-24).
  const scanIsPasswordless = access.tokenUrl !== undefined
  const scanUrl = access.tokenUrl ?? access.selectedUrl

  const copy = (value: string, label: string): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(label)
        setTimeout(() => setCopied(null), 1500)
      } catch {
        setNotice('复制失败，请手动选择文本复制')
      }
    })()
  }

  const goSecurity = createElement('button', {
    key: 'go',
    type: 'button',
    className: 'lg-btn secondary',
    onClick: () => setTab('security'),
  }, '去设置访问密码')

  // ---- tab: access -------------------------------------------------------
  const qrBlock = !hasPassword
    ? createElement('div', { className: 'lg-bar warn', key: 'no-password' }, [
      createElement('span', { key: 't' }, '先设置访问密码，然后这里会出现可扫描的二维码。'),
      goSecurity,
    ])
    : access.unavailableReason !== undefined
      ? createElement('div', { className: 'lg-bar warn', key: 'no-url' }, access.unavailableReason)
      : unlocked && access.tokenQrSvg !== undefined
        ? createElement('div', { key: 'token-qr' }, [
          createElement('div', {
            key: 'svg',
            className: 'lg-qr',
            dangerouslySetInnerHTML: { __html: access.tokenQrSvg },
          }),
          createElement('p', { className: 'lg-hint', key: 'l' },
            '上面的地址就是二维码内容：扫码即登录（免密链接，等同于密码）。'),
        ])
        : createElement('div', { key: 'normal-qr' }, [
          access.qrSvg === null
            ? null
            : createElement('div', {
              key: 'svg',
              className: 'lg-qr',
              dangerouslySetInnerHTML: { __html: access.qrSvg },
            }),
          createElement('p', { className: 'lg-hint', key: 'l' },
            hasPassword && !unlocked
              ? '扫码后在手机上输入访问密码。解锁管理控制台后会改为显示免密二维码。'
              : '扫码后在手机上输入访问密码。'),
        ])

  const accessTab = createElement('div', { className: 'lg-tabbody' }, [
    createElement(Card, {
      key: 'status',
      title: '局域网访问',
      subtitle: '同一 Wi-Fi 下的设备可直接扫码访问',
      right: createElement('span', { className: running ? 'lg-pill' : 'lg-pill off' }, running ? '运行中' : '已停止'),
      children: [
        createElement('div', { className: hasPassword ? 'lg-bar' : 'lg-bar warn', key: 'bar' }, [
          createElement('span', { key: 'txt' }, hasPassword
            ? '🛡️ 访问安全认证已生效'
            : '⚠️ 尚未设置访问密码，门禁不会放行任何设备'),
          hasPassword ? null : goSecurity,
        ]),
        createElement('div', { className: 'lg-mono', key: 'url' }, scanUrl ?? '—'),
        createElement('div', { className: 'lg-row', key: 'copy' }, [
          createElement('button', {
            key: 'c',
            type: 'button',
            className: 'lg-btn secondary',
            disabled: scanUrl === null,
            onClick: () => copy(scanUrl ?? '', 'link'),
          }, copied === 'link' ? '已复制' : '复制链接'),
          scanIsPasswordless
            ? createElement('button', {
              key: 'r',
              type: 'button',
              className: 'lg-btn secondary',
              disabled: busy,
              onClick: () => void write({ rotateToken: true }),
            }, '重新生成')
            : null,
        ].filter(Boolean) as ReactElement[]),
        qrBlock,
        createElement('p', { className: 'lg-hint', key: 'private' }, '请在私密环境下使用'),
        createElement('p', { className: 'lg-hint', key: 'pwa' },
          '📱 提示：手机浏览器扫码打开后，在菜单点击「添加到主屏幕」即可作为独立全屏 App 运行。'),
      ],
    }),
  ])

  // ---- shared lock card --------------------------------------------------
  const lockCard = createElement(Card, {
    key: 'lock',
    children: createElement('div', { className: 'lg-lock' }, [
      createElement('div', { className: 'lg-lock-emoji', key: 'icon' }, '🔒'),
      createElement('h3', { key: 't' }, '管理控制台已锁定'),
      createElement('span', { className: 'lg-lockpill', key: 'pill' }, '🔑 使用访问密码解锁'),
      createElement('p', { key: 'p' },
        authStatus.hasAdminPassword
          ? '为保护你的网络与平台安全，修改验证方式与证书设置前需要先解锁管理控制台。'
          : '为保护你的网络与平台安全，当前未设置独立管理密码，输入访问密码即可解锁。'),
      createElement('input', {
        key: 'i',
        className: 'lg-input',
        type: 'password',
        autoComplete: 'current-password',
        placeholder: '输入访问密码',
        value: unlockPassword,
        onChange: (event: { target: { value: string } }) => setUnlockPassword(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Enter') void submitUnlock()
        },
      }),
      createElement('button', {
        key: 'b',
        type: 'button',
        className: 'lg-btn full',
        disabled: busy,
        onClick: () => void submitUnlock(),
      }, '解锁管理权限'),
      createElement('button', {
        key: 'forgot',
        type: 'button',
        className: 'lg-link',
        onClick: () => setShowRecovery(!showRecovery),
      }, '❓ 忘记访问密码？'),
      showRecovery
        ? createElement('div', { className: 'lg-recover', key: 'recover' }, [
          createElement('p', { key: 't' }, '🛟 找回与重置访问密码指引：'),
          createElement('p', { key: 'a' },
            '1. 电脑本机直连修改：在运行本程序的电脑上直接打开本控制台（127.0.0.1 享有免锁特权），可随时修改或清除密码。'),
          createElement('p', { key: 'b' },
            '2. 无头 / 服务器环境：删除插件私有目录（配置项 dataDir）下的 secrets.json 后重新设置；'
            + '删除后门禁会重新拒绝所有设备，直到你设置新密码。'),
        ])
        : null,
    ]),
  })

  // ---- tab: security -----------------------------------------------------
  const securityTab = createElement('div', { className: 'lg-tabbody' }, locked ? [lockCard] : [
    createElement(Card, {
      key: 'security',
      title: '安全认证',
      subtitle: '决定谁能通过代理端口进入 DSH',
      children: [
        createElement('p', { className: 'lg-hint', key: 'pw-explain' },
          '访问密码 = 手机等访客设备登录用；管理密码 = 解锁本设置页的管理台用（未设置时退回访问密码）。'),
        createElement(ChoiceGrid, {
          key: 'mode',
          choices: MODE_CHOICES,
          value: preferences.mode,
          disabled: busy,
          onPick: (id: string) => void write({ preferences: { mode: id } }),
        }),
        createElement('div', { className: 'lg-field', key: 'pw' }, [
          createElement('span', { className: 'lg-label', key: 'l' },
            authStatus.hasPassword ? '访问密码：已设置（不会回显）' : '访问密码：未设置'),
          createElement('input', {
            key: 'i',
            className: 'lg-input',
            type: 'password',
            autoComplete: 'new-password',
            placeholder: '输入新的访问密码（至少 8 位）',
            value: password,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setPassword(event.target.value),
          }),
          createElement('button', {
            key: 'b',
            type: 'button',
            className: 'lg-btn',
            disabled: busy || password === '',
            onClick: () => {
              void write({ setPassword: { next: password } }).then(() => setPassword(''))
            },
          }, '设置访问密码'),
        ]),
        createElement('div', { className: 'lg-field', key: 'admin' }, [
          createElement('span', { className: 'lg-label', key: 'l' },
            authStatus.hasAdminPassword ? '管理密码：已设置（不会回显）' : '管理密码：未设置（退回访问密码）'),
          createElement('input', {
            key: 'i',
            className: 'lg-input',
            type: 'password',
            autoComplete: 'new-password',
            placeholder: '输入新的管理密码（至少 8 位）',
            value: adminPassword,
            disabled: busy,
            onChange: (event: { target: { value: string } }) => setAdminPassword(event.target.value),
          }),
          createElement('button', {
            key: 'b',
            type: 'button',
            className: 'lg-btn secondary',
            disabled: busy || adminPassword === '',
            onClick: () => {
              void write({ setAdminPassword: { next: adminPassword } }).then(() => setAdminPassword(''))
            },
          }, '设置管理密码'),
        ]),
        createElement('div', { className: 'lg-toggle', key: 'loopback' }, [
          createElement('span', { key: 'l' }, '本机回环访问免密'),
          createElement('button', {
            key: 's',
            type: 'button',
            className: 'lg-switch',
            'aria-checked': preferences.allowLoopback,
            disabled: busy,
            onClick: () => void write({ preferences: { allowLoopback: !preferences.allowLoopback } }),
          }, createElement('span', null)),
        ]),
        createElement('p', { className: 'lg-hint', key: 'h' },
          '密码仅以 PBKDF2-SHA256 哈希存储于插件私有目录，绝不写入配置文件，也不会回显。'),
      ],
    }),
  ])

  // ---- tab: devices (P4-g) ----------------------------------------------
  const when = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toLocaleString('zh-CN'))
  const deviceGroups = [
    { key: 'pending', title: '待批准', list: snapshot.devices.filter(entry => entry.status === 'pending') },
    { key: 'approved', title: '已授权', list: snapshot.devices.filter(entry => entry.status === 'approved') },
    { key: 'blocked', title: '已拉黑', list: snapshot.devices.filter(entry => entry.status === 'blocked') },
  ]
  const statusChip = (status: string): ReactElement => createElement('span', {
    className: status === 'blocked' ? 'lg-chip ban' : status === 'pending' ? 'lg-chip wait' : 'lg-chip',
  }, status === 'blocked' ? '已拉黑' : status === 'pending' ? '待批准' : '已批准')
  const devButton = (label: string, action: string, id: string, danger: boolean): ReactElement =>
    createElement('button', {
      type: 'button',
      className: danger ? 'lg-btn secondary lg-btn-small lg-danger' : 'lg-btn lg-btn-small',
      disabled: busy,
      onClick: () => void deviceAction(id, action),
    }, label)
  const devicesTab = createElement('div', { className: 'lg-tabbody' }, locked ? [lockCard] : [
    createElement(Card, {
      key: 'devices',
      title: '已授权设备',
      subtitle: '每个设备一条独立身份，可逐个批准、吊销与拉黑',
      children: [
        createElement('p', { className: 'lg-hint', key: 'explain' },
          '手机第一次通过门禁时会显示配对页，让你给这台设备命名；命名后它就会出现在下面。'),
        createElement('div', { className: 'lg-toggle', key: 'pairing' }, [
          createElement('span', { key: 'l' }, '新设备需要命名确认'),
          createElement('button', {
            key: 's',
            type: 'button',
            className: 'lg-switch',
            'aria-checked': preferences.requirePairing,
            disabled: busy,
            onClick: () => void write({ preferences: { requirePairing: !preferences.requirePairing } }),
          }, createElement('span', null)),
        ]),
        createElement('div', { className: 'lg-toggle', key: 'approval' }, [
          createElement('span', { key: 'l' }, '新设备需要管理员批准'),
          createElement('button', {
            key: 's',
            type: 'button',
            className: 'lg-switch',
            'aria-checked': preferences.requireApproval,
            disabled: busy,
            onClick: () => void write({ preferences: { requireApproval: !preferences.requireApproval } }),
          }, createElement('span', null)),
        ]),
        createElement('p', { className: 'lg-hint', key: 'approval-hint' },
          '开启「管理员批准」后：手机完成命名 → 进入「待批准」，你在下面点「批准」它才能访问；'
          + '「拒绝并拉黑」会让它即使知道密码、换浏览器重新配对也被拒绝。'),
        snapshot.pendingCount > 0
          ? createElement('div', { className: 'lg-bar warn', key: 'pending-bar' },
            `🔔 有 ${String(snapshot.pendingCount)} 台新设备等待批准`)
          : null,
        snapshot.devices.length === 0
          ? createElement('p', { className: 'lg-hint', key: 'empty' }, '暂无已授权设备。')
          : createElement('div', { key: 'groups' }, deviceGroups
            .filter(group => group.list.length > 0)
            .map(group => createElement('div', { key: group.key }, [
              createElement('div', { key: 't', className: 'lg-sec-title' },
                `${group.title}（${String(group.list.length)}）`),
              ...group.list.map(device => createElement('div', { key: device.id, className: 'lg-device' }, [
                createElement('div', { key: 'meta' }, [
                  createElement('div', { key: 'l', className: 'lg-device-name' }, [
                    device.label,
                    statusChip(device.status),
                  ]),
                  createElement('div', { key: 'd', className: 'lg-hint' },
                    `创建 ${when(device.createdAtMs)} · 最近使用 ${when(device.lastSeenAtMs)}`
                    + ` · 来源 ${device.lastIp ?? '—'}`),
                ]),
                createElement('div', { key: 'a', className: 'lg-row' },
                  device.status === 'pending'
                    ? [devButton('批准', 'approve', device.id, false), devButton('拒绝并拉黑', 'block', device.id, true)]
                    : device.status === 'blocked'
                      ? [devButton('解除拉黑', 'unblock', device.id, false)]
                      : [devButton('吊销并拉黑', 'block', device.id, true)]),
              ])),
            ]))),
      ],
    }),
  ])

  // ---- tab: connection ---------------------------------------------------
  const connectionTab = createElement('div', { className: 'lg-tabbody' }, locked ? [lockCard] : [
    createElement(Card, {
      key: 'connection',
      title: '连接与证书',
      subtitle: '监听端口与传输安全',
      children: [
        createElement('div', { className: 'lg-mono', key: 'ports' },
          `代理端口 ${String(listener.listenPort)} → 上游 ${listener.upstreamOrigin}`),
        listener.portFallback
          ? createElement('div', { className: 'lg-bar warn', key: 'port-busy' },
            `配置的端口 ${String(listener.configuredPort ?? '?')} 已被占用，已自动改用 ${String(listener.listenPort)}。`
            + '可在下面改端口，或先关掉占用它的程序。')
          : null,
        createElement('div', { className: 'lg-field', key: 'port' }, [
          createElement('span', { className: 'lg-label', key: 'l' }, '代理端口（修改后需重启 dsh 生效）'),
          createElement('div', { className: 'lg-row', key: 'r' }, [
            createElement('input', {
              key: 'i',
              className: 'lg-input',
              type: 'number',
              min: 1,
              max: 65535,
              value: portDraft === '' ? String(listener.configuredPort ?? listener.listenPort) : portDraft,
              disabled: busy,
              onChange: (event: { target: { value: string } }) => {
                setPortDraft(event.target.value)
                setPortCheck(null)
              },
              onBlur: () => void checkPort(
                portDraft === '' ? String(listener.configuredPort ?? listener.listenPort) : portDraft,
              ),
            }),
            createElement('button', {
              key: 'b',
              type: 'button',
              className: 'lg-btn',
              disabled: busy || portDraft === ''
                || portDraft === String(listener.configuredPort ?? listener.listenPort),
              onClick: () => {
                void write({ preferences: { listenPort: Number.parseInt(portDraft, 10) } })
                  .then(() => { setPortDraft(''); setPortCheck(null) })
              },
            }, '保存端口'),
          ]),
          portCheck === null ? null : createElement('span', { className: 'lg-label', key: 'c' }, portCheck),
          createElement('span', { className: 'lg-label', key: 'h' },
            `默认 ${String(DEFAULT_PORT_HINT)}；被占用时会自动依次往后找可用端口（最多试 ${String(10)} 个）。`),
        ]),
        createElement('div', { className: 'lg-field', key: 'nic' }, [
          createElement('span', { className: 'lg-label', key: 'l' }, '对外公布的网卡'),
          createElement('select', {
            key: 's',
            className: 'lg-input',
            value: preferences.networkInterface,
            disabled: busy,
            onChange: (event: { target: { value: string } }) =>
              void write({ preferences: { networkInterface: event.target.value } }),
          }, [
            createElement('option', { key: 'auto', value: '' }, '自动选择（优先真实网卡）'),
            ...access.addresses.map(entry => createElement('option', {
              key: `${entry.interface}:${entry.address}`,
              value: entry.interface,
            }, `${entry.interface} · ${entry.address}${entry.virtual ? `（虚拟：${entry.virtualReason ?? '未知'}）` : ''}`)),
          ]),
        ]),
        createElement('p', { className: 'lg-hint', key: 'nic-hint' },
          '二维码与访问地址随此处选择即时刷新；虚拟网卡通常无法被手机访问。'),
        createElement(ChoiceGrid, {
          key: 'tls',
          choices: [
            { id: 'self-signed', title: '自签 HTTPS（默认）', detail: '手机需一次性信任自签 CA' },
            { id: 'off', title: '关闭 HTTPS', detail: '局域网内明文传输，仅建议在完全可信的网络中使用' },
          ],
          value: 'self-signed',
          disabled: busy,
          onPick: () => setNotice('TLS 切换在 P3 提供'),
        }),
        access.tlsMode === 'off'
          ? createElement('div', { className: 'lg-bar danger', key: 'tls-off' }, [
            createElement('span', { key: 't' },
              '⚠️ 已关闭 HTTPS：局域网内为明文传输，门禁密码与上游 cookie 可能被同网段嗅探；'
              + '浏览器部分能力（剪贴板、Service Worker）不可用。仅建议在完全可信的私有网络中使用。'),
          ])
          : null,
        access.caFingerprint === null
          ? null
          : createElement('div', { className: 'lg-mono lg-mono-sm', key: 'ca' },
            `自签 CA 指纹（SHA-256）：${access.caFingerprint}`),
        access.caFingerprint === null
          ? null
          : createElement('p', { className: 'lg-hint', key: 'ca-hint' },
            '手机首次访问需先安装并信任该 CA（README 中有指引）；CA 身份跨重启不变，换 IP 只重签叶证书。'),
        createElement('p', { className: 'lg-hint', key: 'nets' },
          `检测到 ${String(access.addresses.length)} 个可用地址${access.addresses.some(a => a.virtual) ? '（含虚拟网卡，已降权）' : ''}。`),
      ],
    }),
  ])

  // Only meaningful for a REMOTE session that had to unlock; the operator's own
  // machine is never locked, so the banner there is pure noise.
  const unlockBanner = authStatus.adminUnlocked && !locked && authStatus.localAccess === false
    ? createElement('div', { className: 'lg-bar info lg-bar-compact', key: 'unlocked' }, [
      createElement('span', { key: 't' }, '🔓 已解锁：本次会话内可直接修改下方设置'),
      createElement('button', {
        key: 'b',
        type: 'button',
        className: 'lg-btn secondary lg-btn-small',
        onClick: () => void write({ adminLock: true }),
      }, '重新锁定'),
    ])
    : null

  const readOnlyBanner = readOnly
    ? createElement('div', { className: 'lg-bar warn', key: 'readonly' },
      '当前为远程访问（只读）：请在运行本程序的电脑上打开本控制台修改——127.0.0.1 享有免锁特权。')
    : null

  // Update detection chip + panel (SPEC F8). Read-only: the host never installs
  // anything; it reports and offers a copyable command.
  const repoUrl = 'https://github.com/idoall/dsh-lan-guard'
  const updateChip = createElement('div', { className: 'lg-update', key: 'update' }, [
    createElement('span', {
      key: 'v',
      className: update !== null && update.hasUpdate ? 'lg-chip warn' : 'lg-chip',
    }, update === null
      ? '检查更新…'
      : update.error !== null
        ? `v${update.current} · 检查失败`
        : update.hasUpdate
          ? `v${update.current} ➔ v${String(update.latest)}`
          : `v${update.current} ✓ 最新`),
    createElement('button', {
      key: 'b',
      type: 'button',
      className: 'lg-btn secondary lg-btn-small',
      disabled: updateBusy,
      onClick: () => void loadUpdate(true),
    }, updateBusy ? '检查中…' : '检查更新'),
    createElement('a', { key: 'g', className: 'lg-link', href: repoUrl, target: '_blank', rel: 'noreferrer' }, 'GitHub'),
    createElement('a', {
      key: 'c',
      className: 'lg-link',
      href: `${repoUrl}/blob/main/CHANGELOG.md`,
      target: '_blank',
      rel: 'noreferrer',
    }, '更新日志'),
    createElement('a', {
      key: 'i',
      className: 'lg-link',
      href: `${repoUrl}/issues`,
      target: '_blank',
      rel: 'noreferrer',
    }, '反馈 Issue'),
  ])

  const updatePanel = update === null || !update.hasUpdate
    ? null
    : createElement('div', { className: 'lg-update-panel', key: 'updatepanel' }, [
      createElement('div', { key: 't', className: 'lg-update-title' },
        `发现新版本 v${String(update.latest)}（当前 v${update.current}）`),
      createElement('div', { key: 'c', className: 'lg-mono' },
        `dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`),
      createElement('div', { className: 'lg-row', key: 'r' }, [
        createElement('button', {
          key: 'cp',
          type: 'button',
          className: 'lg-btn secondary',
          onClick: () => copy(`dsh plugin --profile web add dsh-lan-guard@${String(update.latest)}`, 'update'),
        }, copied === 'update' ? '已复制' : '复制命令'),
      ]),
      createElement('p', { key: 'h', className: 'lg-hint' },
        '本插件不会自动安装，也不会重启 dsh：执行上面的命令后，需要你手动重启一次 dsh 才生效。'),
    ])

  const tabBar = createElement('div', { className: 'lg-tabs', role: 'tablist', key: 'tabs' },
    TABS.map(entry => createElement('button', {
      key: entry.id,
      type: 'button',
      role: 'tab',
      className: 'lg-tab',
      'aria-selected': tab === entry.id,
      onClick: () => setTab(entry.id),
    }, entry.label)))

  return createElement('div', { className: 'lg-root' }, [
    createElement('style', { key: 'css' }, CSS),
    error === null ? null : createElement('div', { className: 'lg-bar danger', key: 'err' }, error),
    notice === null ? null : createElement('div', { className: 'lg-bar info', key: 'ok' }, notice),
    unlockBanner,
    readOnlyBanner,
    updateChip,
    updatePanel,
    tabBar,
    tab === 'access'
      ? accessTab
      : tab === 'security' ? securityTab : tab === 'devices' ? devicesTab : connectionTab,
  ].filter(Boolean) as ReactElement[])
}

/** Default port shown as a hint in the port field. */
const DEFAULT_PORT_HINT = 3081

/**
 * Register the settings section.
 *
 * @param ctx - the client plugin context (injects `slots`).
 */
export function apply(ctx: {
  slots: {
    inject(seat: string, callback: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  effect?(callback: () => () => void): unknown
}): void {
  ctx.slots.inject(SEAT, () => ctx.slots.register(
    { name: SEAT, id: PLUGIN_ID, order: 100, label: '局域网访问' },
    SettingsSection,
  ))
}

module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply,
}
