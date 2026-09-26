/**
 * Remote workspace picker — layout invariants.
 *
 * Why a stylesheet test exists at all: the breadcrumb and quick-access rows were
 * crushed into one overlapping strip (reported 2026-09-26 with a screenshot), and
 * NOTHING in the type system or the other suites could see it. The cause is a
 * flexbox rule that is easy to reintroduce: a flex item's automatic minimum size
 * resolves to 0 once its overflow is not `visible`, and both rows scroll
 * horizontally — so as soon as the sheet reached its max-height the browser
 * shrank exactly those two rows to nothing while the list kept its floor.
 *
 * The sheet is rendered in a real browser in this repository's manual
 * verification; this test pins the invariants that made it correct so a future
 * edit cannot silently undo them.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/workspace-flow.ts', import.meta.url), 'utf8')
const css = /const FLOW_CSS = `\n([\s\S]*?)\n`/.exec(source)?.[1] ?? ''

/** The declaration block of one rule, by exact selector. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector}{`)
  expect(start, `rule ${selector} is missing`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', start)
  return css.slice(start + selector.length + 1, end)
}

describe('picker sheet layout', () => {
  it('extracts the stylesheet it is guarding', () => {
    expect(css.length).toBeGreaterThan(1000)
  })

  it('lets ONLY the list flex, so the fixed rows cannot be crushed', () => {
    // The rows that scroll horizontally are the ones at risk: without an
    // explicit flex-basis their automatic minimum size is 0.
    for (const selector of ['.lgp-crumbs,.lgp-quick', '.lgp-head', '.lgp-foot', '.lgp-notice']) {
      expect(rule(selector), `${selector} must not shrink`).toContain('flex:0 0 auto')
    }
    expect(rule('.lgp-list')).toContain('flex:1 1 auto')
    expect(rule('.lgp-list')).toContain('min-height:0')
  })

  it('clips the sheet instead of letting a child escape its rounded box', () => {
    expect(rule('.lgp-sheet')).toContain('overflow:hidden')
  })

  it('keeps every chip on one line, so a long name cannot be cut in half', () => {
    expect(rule('.lgp-crumb')).toContain('white-space:nowrap')
    expect(rule('.lgp-quickbtn')).toContain('white-space:nowrap')
  })
})
