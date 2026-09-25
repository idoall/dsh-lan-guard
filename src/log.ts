/**
 * dsh-lan-guard — the logger surface this plugin uses.
 *
 * DSH hands a Cordis logger to `ctx.logger(...)`, which already satisfies this
 * shape. Declaring the narrow interface here keeps the rest of the plugin
 * testable with a stub, and keeps every call site honest about the one rule
 * that matters: NO credential is ever passed to a log call.
 */
export interface LanGuardLogger {
  /** Routine lifecycle and request information. */
  info(message: string, ...args: unknown[]): void
  /** Recoverable problems (upstream unavailable, session re-exchange). */
  warn(message: string, ...args: unknown[]): void
  /** Optional verbose diagnostics. */
  debug?(message: string, ...args: unknown[]): void
}

/** A logger that discards everything; used when no logger is supplied. */
export const noopLogger: LanGuardLogger = {
  info() {},
  warn() {},
  debug() {},
}
