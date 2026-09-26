/**
 * dsh-lan-guard — the browser half of the remote workspace picker.
 *
 * DSH's directory-picker seam is resolved once per PROCESS
 * (`@deepseek-ai/dsh-host-directory-picker-auto`), and because DSH's own web
 * server binds loopback that resolution is `native` on macOS/Windows: the OS
 * folder dialog opens on the HOST screen. A phone that reached this machine
 * through the LAN gateway therefore cannot add a workspace at all.
 *
 * A `single` slot renders its LOWEST-priority occupant, so this module registers
 * a shadowing occupant at {@link FLOW_PRIORITY} and decides per CLIENT:
 *
 * - a browser sitting at this machine delegates to DSH's own picker (the desktop
 *   preload when present, otherwise the official `uiWorkspace.pickDirectory()`),
 *   so the operator's OS dialog is untouched;
 * - a remote browser gets this module's own bottom-sheet directory browser,
 *   backed by one management route (`GET …/workspaces?path=…`).
 *
 * The occupant is RENDERLESS until a pick is requested, and it never registers a
 * workspace itself: it reports the chosen path through the owner's `onPicked`,
 * and DSH's own workspace flow performs the (validated, persisted) registration.
 */
import { createElement, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import {
  BROWSE_PATH,
  BrowseRequestError,
  CONFIG_PATH,
  browseErrorNotice,
  directoryFlowDecision,
  readBrowseResponse,
  readClientEnvironment,
  registerDirectoryFlow,
  type BrowseListingView,
  type FlowSlots,
  type PickerNotice,
} from './picker-logic.ts'

/** The client context surface this module needs. */
export interface DirectoryFlowContext {
  slots: FlowSlots
  /** Cordis optional service lookup; used to reach `uiWorkspace` without a hard dependency. */
  get?(name: string): unknown
}

/** Props the slot owner passes to a flow occupant. */
interface FlowProps {
  /** The owner's rising edge: one pick per `false → true` transition. */
  open: boolean
  /** True while the owner is adopting a path; the sheet stays up but is inert. */
  busy?: boolean
  onPicked(path: string): void
  onCancel(): void
  onError(message: string): void
  /** The official picker (OS dialog); throws when this host has none. */
  pick(): Promise<string | null>
  /** One directory level from the management route. */
  browse(path?: string): Promise<BrowseListingView>
}

/** The stable code of a failed request. */
function codeOf(reason: unknown): string {
  if (reason instanceof BrowseRequestError) return reason.code
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/** A human message for a thrown reason. */
function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Unlock the management console from inside the picker.
 *
 * The unlock is the ONE management write that never requires an unlocked
 * console (it IS the unlock), so this works under `password_unlock` even though
 * every other route refuses. Doing it here removes the dead end where the sheet
 * says "go unlock in Settings" and the operator has to find the lock card.
 *
 * @param password - the admin password (or the access password when no separate
 *   admin password is set, which is how the host falls back).
 */
async function postAdminUnlock(password: string): Promise<void> {
  const response = await fetch(CONFIG_PATH, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ adminUnlock: password }),
  })
  if (response.status === 401) throw new Error('管理密码不正确')
  if (!response.ok) throw new Error(`解锁失败（HTTP ${String(response.status)}）`)
}

/**
 * Read one directory level from the management route.
 *
 * @param path - the directory to list; omitted lists the host's home directory.
 * @returns the listing.
 */
async function fetchListing(path?: string): Promise<BrowseListingView> {
  const query = path === undefined ? '' : `?path=${encodeURIComponent(path)}`
  const response = await fetch(`${BROWSE_PATH}${query}`, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    // A non-JSON body (proxy error page, 401 HTML) is reported by its status.
    body = null
  }
  return readBrowseResponse(response.status, body)
}

/** Look a client service up without requiring it. */
function optionalService(ctx: DirectoryFlowContext, name: string): unknown {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

/**
 * The official picker for THIS browser, when it has one.
 *
 * Mirrors the official native surface: the desktop shell's preload picker wins,
 * then the client service. Either way the dialog appears on the machine the
 * browser is running on — which is exactly what makes this the LOCAL branch.
 *
 * @param ctx - the client context.
 * @returns the pick function, or `undefined` when this host has none.
 */
function officialPick(ctx: DirectoryFlowContext): (() => Promise<string | null>) | undefined {
  const scope = globalThis as unknown as { __DSH_DIRECTORY_PICKER__?: { pick?: () => Promise<string | null> } }
  const desktop = scope.__DSH_DIRECTORY_PICKER__
  if (desktop !== undefined && typeof desktop.pick === 'function') return () => desktop.pick?.() ?? Promise.resolve(null)
  const ui = optionalService(ctx, 'uiWorkspace') as { pickDirectory?: () => Promise<string | null> } | undefined
  if (ui !== undefined && typeof ui.pickDirectory === 'function') return () => ui.pickDirectory?.() ?? Promise.resolve(null)
  return undefined
}

/**
 * Typography and materials come from the official tokens only, exactly as the
 * settings card does; the sheet is a bottom sheet on phones and a centred card
 * from 620px up.
 */
const FLOW_CSS = `
.lgp-scrim{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:center;
  background:color-mix(in srgb, var(--dsw-alias-bg-mask,#000) 46%, transparent);backdrop-filter:blur(6px);
  -webkit-backdrop-filter:blur(6px)}
/*
 * FLEX SHRINK IS EXPLICIT ON EVERY FIXED ROW (user report 2026-09-26: the
 * breadcrumb and the quick-access rows were crushed into one overlapping strip).
 * A flex item's AUTOMATIC minimum size resolves to 0 as soon as its overflow is
 * not visible, and both rows scroll horizontally — so the moment the sheet hit
 * its max-height the browser shrank exactly those two rows to nothing while the
 * list kept its floor. Only the list may flex; everything else is fixed.
 */
.lgp-sheet{box-sizing:border-box;width:100%;max-width:560px;max-height:86vh;display:flex;flex-direction:column;
  overflow:hidden;
  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e5e6eb);
  border-radius:20px 20px 0 0;box-shadow:0 -12px 40px color-mix(in srgb, #000 26%, transparent);
  padding:16px 16px calc(16px + env(safe-area-inset-bottom,0px));gap:12px}
.lgp-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}
.lgp-title{font:var(--dsw-font-base-16-strong,500 16px/24px sans-serif);color:var(--dsw-alias-label-primary,#1f2329);margin:0}
.lgp-x{flex:0 0 auto;width:32px;height:32px;border-radius:50%;border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);
  background:transparent;color:var(--dsw-alias-label-primary,#1f2329);cursor:pointer;font-size:16px;line-height:1}
.lgp-crumbs,.lgp-quick{flex:0 0 auto;display:flex;align-items:center;gap:8px;overflow-x:auto;overflow-y:hidden;
  padding-bottom:2px;scrollbar-width:none}
.lgp-crumbs::-webkit-scrollbar,.lgp-quick::-webkit-scrollbar,.lgp-list::-webkit-scrollbar{display:none}
.lgp-crumb{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-secondary,#4e5969);
  font:var(--dsw-font-xs-13,13px/20px sans-serif);cursor:pointer;padding:4px 6px;border-radius:8px;white-space:nowrap}
.lgp-crumb[aria-current=true]{color:var(--dsw-alias-label-primary,#1f2329);font:var(--dsw-font-xs-13-strong,500 13px/20px sans-serif);
  background:var(--dsw-alias-bg-layer-3,#f1f2f4)}
.lgp-quickbtn{flex:0 0 auto;border:0.5px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:999px;
  background:transparent;color:var(--dsw-alias-label-primary,#1f2329);font:var(--dsw-font-xs-13,13px/20px sans-serif);
  padding:6px 12px;cursor:pointer;white-space:nowrap}
/* The list is the ONLY flexible row: it absorbs every bit of shrinkage, so the
   fixed rows above and the action buttons below stay whole on a short viewport. */
.lgp-list{flex:1 1 auto;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-radius:14px;padding:6px}
.lgp-row{display:flex;align-items:center;gap:8px;width:100%;text-align:left;border:0;background:transparent;
  color:var(--dsw-alias-label-primary,#1f2329);font:var(--dsw-font-s-14,14px/22px sans-serif);
  padding:10px 10px;border-radius:10px;cursor:pointer;min-height:44px}
.lgp-row:hover{background:var(--dsw-alias-bg-layer-3,#f1f2f4)}
.lgp-row .lgp-dir{flex:0 0 auto;opacity:.85}
.lgp-row .lgp-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lgp-row[data-hidden=true] .lgp-name{color:var(--dsw-alias-label-tertiary,#adb2b8)}
.lgp-hint{margin:0;padding:10px 4px;color:var(--dsw-alias-label-secondary,#4e5969);font:var(--dsw-font-xs-13,13px/20px sans-serif)}
.lgp-notice{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l2,#e5e6eb);border-left:3px solid var(--dsw-alias-state-warning-primary,#d25f00);
  border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:4px}
.lgp-notice h4{margin:0;font:var(--dsw-font-xs-13-strong,500 13px/20px sans-serif);color:var(--dsw-alias-label-primary,#1f2329)}
.lgp-notice p{margin:0;font:var(--dsw-font-xs-13,13px/20px sans-serif);color:var(--dsw-alias-label-secondary,#4e5969)}
.lgp-unlock{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:6px}
.lgp-input{flex:1 1 12ch;min-width:0;height:40px;box-sizing:border-box;border-radius:10px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l2,#e5e6eb);background:var(--dsw-alias-bg-layer-2,#fff);
  color:var(--dsw-alias-label-primary,#1f2329);font:var(--dsw-font-s-14,14px/22px sans-serif)}
.lgp-btn-inline{flex:0 0 auto;min-width:88px;min-height:40px;padding:0 16px}
.lgp-code{font:var(--dsw-font-xxs-12,12px/18px ui-monospace,SFMono-Regular,Menlo,monospace);
  color:var(--dsw-alias-label-tertiary,#adb2b8)}
.lgp-foot{flex:0 0 auto;display:flex;flex-direction:column;gap:10px}
.lgp-path{font:var(--dsw-font-xxs-12,12px/18px ui-monospace,SFMono-Regular,Menlo,monospace);
  color:var(--dsw-alias-label-secondary,#4e5969);overflow-x:auto;white-space:nowrap;scrollbar-width:none}
.lgp-actions{display:flex;gap:10px}
.lgp-btn{flex:1 1 auto;min-height:44px;border-radius:12px;cursor:pointer;
  font:var(--dsw-font-s-14-strong,500 14px/22px sans-serif);border:1px solid transparent}
.lgp-btn.primary{background:var(--dsw-alias-state-business-primary,#1a3f8f);color:#fff}
.lgp-btn.ghost{background:transparent;border-color:var(--dsw-alias-border-l2,#e5e6eb);color:var(--dsw-alias-label-primary,#1f2329)}
.lgp-btn[disabled]{opacity:.5;cursor:default}
.lgp-busy{align-self:center;margin:auto;padding:16px 20px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);
  color:var(--dsw-alias-label-primary,#1f2329);font:var(--dsw-font-s-14,14px/22px sans-serif)}
@media (min-width:620px){
  .lgp-scrim{align-items:center}
  .lgp-sheet{border-radius:20px;max-height:80vh;padding:18px 20px}
}
`

/**
 * The shadowing flow occupant.
 *
 * Renderless until the owner opens a pick. One pick per rising `open` edge, one
 * outcome per pick — the same contract the official occupant implements, so the
 * owner cannot tell the difference.
 *
 * @param props - the owner conversation plus the injected pick/browse calls.
 * @returns the sheet while a remote pick is in flight, otherwise nothing.
 */
export function DirectoryFlow(props: FlowProps): ReactElement | null {
  const { open, pick, browse } = props
  const latest = useRef(props)
  latest.current = props
  const armed = useRef(false)
  const alive = useRef(true)
  const [listing, setListing] = useState<BrowseListingView | null>(null)
  const [notice, setNotice] = useState<PickerNotice | null>(null)
  /** The server's stable code behind {@link notice}; drives the inline unlock. */
  const [failureCode, setFailureCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [unlockPassword, setUnlockPassword] = useState('')
  const [unlockBusy, setUnlockBusy] = useState(false)
  const [unlockError, setUnlockError] = useState<string | null>(null)
  /** The path a retry should re-list (the last one shown, or the home directory). */
  const lastPath = useRef<string | undefined>(undefined)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const load = useCallback((path?: string): void => {
    lastPath.current = path ?? lastPath.current
    setLoading(true)
    setNotice(null)
    setFailureCode(null)
    void browse(path).then(
      (next) => {
        // A listing that lands after the owner closed the flow is dropped, so a
        // cancelled pick can never repaint the sheet.
        if (!alive.current || !latest.current.open) return
        setListing(next)
        setLoading(false)
      },
      (reason: unknown) => {
        if (!alive.current || !latest.current.open) return
        setNotice(browseErrorNotice(codeOf(reason)))
        setFailureCode(codeOf(reason))
        setLoading(false)
      },
    )
  }, [browse])

  useEffect(() => {
    if (!open) {
      armed.current = false
      setListing(null)
      setNotice(null)
      setFailureCode(null)
      setLoading(false)
      setUnlockPassword('')
      setUnlockError(null)
      lastPath.current = undefined
      return
    }
    if (armed.current) return
    armed.current = true
    if (directoryFlowDecision(readClientEnvironment()) === 'native') {
      // The operator is sitting at this machine: hand the pick to DSH's own
      // picker so the OS dialog appears where the person can see it.
      let pending: Promise<string | null>
      try {
        pending = pick()
      } catch (reason) {
        latest.current.onError(messageOf(reason))
        return
      }
      pending.then(
        (path) => {
          if (!alive.current) return
          if (path === null) latest.current.onCancel()
          else latest.current.onPicked(path)
        },
        (reason: unknown) => {
          if (alive.current) latest.current.onError(messageOf(reason))
        },
      )
      return
    }
    load(undefined)
  }, [open, pick, load])

  // Escape cancels, matching the owner's own dialogs.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') latest.current.onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (!open) return null
  if (directoryFlowDecision(readClientEnvironment()) !== 'browse') return null
  if (props.busy === true) {
    return createElement('div', { className: 'lgp-scrim' }, [
      createElement('style', { key: 'css' }, FLOW_CSS),
      createElement('div', { className: 'lgp-busy', role: 'status', key: 'busy' }, '正在添加工作区…'),
    ])
  }

  const stop = (event: { stopPropagation(): void }): void => {
    event.stopPropagation()
  }
  const cancel = (): void => {
    latest.current.onCancel()
  }
  /** Unlock in place, then list the same directory again. */
  const submitUnlock = (): void => {
    if (unlockPassword === '' || unlockBusy) return
    setUnlockBusy(true)
    setUnlockError(null)
    void postAdminUnlock(unlockPassword).then(
      () => {
        if (!alive.current) return
        setUnlockPassword('')
        setUnlockBusy(false)
        load(lastPath.current)
      },
      (reason: unknown) => {
        if (!alive.current) return
        setUnlockError(messageOf(reason))
        setUnlockBusy(false)
      },
    )
  }
  const crumbs = listing?.crumbs ?? []
  const rows = listing?.entries ?? []
  /** The console is locked: offer the unlock right here instead of a dead end. */
  const needsUnlock = failureCode === 'admin_required'

  return createElement('div', { className: 'lgp-scrim', key: 'scrim', onClick: cancel }, [
    createElement('style', { key: 'css' }, FLOW_CSS),
    createElement('div', {
      key: 'sheet',
      className: 'lgp-sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '选择工作区目录',
      onClick: stop,
    }, [
      createElement('div', { className: 'lgp-head', key: 'head' }, [
        createElement('h3', { className: 'lgp-title', key: 't' }, '选择工作区目录'),
        createElement('button', {
          key: 'x',
          type: 'button',
          className: 'lgp-x',
          'aria-label': '取消',
          onClick: cancel,
        }, '✕'),
      ]),
      notice === null ? null : createElement('div', { className: 'lgp-notice', key: 'notice', role: 'alert' }, [
        createElement('h4', { key: 't' }, notice.title),
        createElement('p', { key: 'd' }, notice.detail),
        needsUnlock
          ? createElement('div', { className: 'lgp-unlock', key: 'unlock' }, [
            createElement('input', {
              key: 'i',
              className: 'lgp-input',
              type: 'password',
              autoComplete: 'current-password',
              placeholder: '管理密码（未设置时用访问密码）',
              value: unlockPassword,
              disabled: unlockBusy,
              onChange: (event: { target: { value: string } }) => {
                setUnlockPassword(event.target.value)
              },
              onKeyDown: (event: { key: string }) => {
                if (event.key === 'Enter') submitUnlock()
              },
            }),
            createElement('button', {
              key: 'b',
              type: 'button',
              className: 'lgp-btn primary lgp-btn-inline',
              disabled: unlockBusy || unlockPassword === '',
              onClick: submitUnlock,
            }, unlockBusy ? '解锁中…' : '解锁'),
            unlockError === null
              ? null
              : createElement('p', { className: 'lgp-hint', key: 'e' }, unlockError),
          ])
          : createElement('div', { className: 'lgp-unlock', key: 'retry' }, [
            createElement('button', {
              key: 'r',
              type: 'button',
              className: 'lgp-btn ghost lgp-btn-inline',
              onClick: () => {
                load(lastPath.current)
              },
            }, '重试'),
            createElement('span', { className: 'lgp-code', key: 'c' }, failureCode ?? ''),
          ]),
      ]),
      crumbs.length === 0 ? null : createElement('div', { className: 'lgp-crumbs', key: 'crumbs' },
        crumbs.map((crumb, index) => createElement('button', {
          key: crumb.path,
          type: 'button',
          className: 'lgp-crumb',
          'aria-current': index === crumbs.length - 1,
          onClick: () => {
            load(crumb.path)
          },
        }, crumb.name))),
      (listing?.quick?.length ?? 0) === 0 ? null : createElement('div', { className: 'lgp-quick', key: 'quick' },
        (listing?.quick ?? []).map(entry => createElement('button', {
          key: entry.path,
          type: 'button',
          className: 'lgp-quickbtn',
          onClick: () => {
            load(entry.path)
          },
        }, entry.name))),
      createElement('div', { className: 'lgp-list', key: 'list' }, loading
        ? [createElement('p', { className: 'lgp-hint', key: 'loading' }, '正在读取…')]
        : listing === null
          // A refusal is never dressed up as "this folder is empty": the notice
          // above carries the reason, and this says so.
          ? [createElement('p', { className: 'lgp-hint', key: 'blocked' }, '目录暂时无法读取，见上方提示。')]
          : rows.length === 0
            ? [createElement('p', { className: 'lgp-hint', key: 'empty' }, '这个文件夹里没有子文件夹')]
            : rows.map(entry => createElement('button', {
              key: entry.path,
              type: 'button',
              className: 'lgp-row',
              'data-hidden': entry.hidden,
              onClick: () => {
                load(entry.path)
              },
            }, [
              createElement('span', { className: 'lgp-dir', key: 'i' }, '📁'),
              createElement('span', { className: 'lgp-name', key: 'n' }, entry.name),
            ]))),
      listing?.truncated === true
        ? createElement('p', { className: 'lgp-hint', key: 'trunc' }, '子文件夹太多，只显示了前一部分。')
        : null,
      createElement('div', { className: 'lgp-foot', key: 'foot' }, [
        createElement('div', { className: 'lgp-path', key: 'p', title: listing?.path ?? '' }, listing?.path ?? ''),
        createElement('div', { className: 'lgp-actions', key: 'a' }, [
          createElement('button', {
            key: 'cancel',
            type: 'button',
            className: 'lgp-btn ghost',
            onClick: cancel,
          }, '取消'),
          createElement('button', {
            key: 'use',
            type: 'button',
            className: 'lgp-btn primary',
            disabled: listing === null,
            onClick: () => {
              if (listing !== null) latest.current.onPicked(listing.path)
            },
          }, '使用此目录'),
        ]),
      ]),
    ].filter(Boolean) as ReactElement[]),
  ])
}

/**
 * Register the shadowing occupant into both directory-flow holes.
 *
 * @param ctx - the client plugin context.
 */
export function applyDirectoryFlow(ctx: DirectoryFlowContext): void {
  const pick = (): Promise<string | null> => {
    const official = officialPick(ctx)
    if (official === undefined) {
      throw new Error('这台主机没有可用的系统目录选择器')
    }
    return official()
  }
  registerDirectoryFlow(ctx.slots, DirectoryFlow, { pick, browse: fetchListing })
}
