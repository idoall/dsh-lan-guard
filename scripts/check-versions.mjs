/**
 * Version-consistency gate.
 *
 * A release has one version number and one declared DSH release, and that pair
 * has to appear in every place a reader looks: both READMEs (badge, the
 * "verified" line, the compatibility table row, the declared verified list),
 * the hand-written release notes (whose anchors the release workflow gates on),
 * and the changelog. This check exists because the badge and the verified line
 * silently stayed at an older DSH release for several versions while the
 * compatibility table marched on.
 *
 * Run through `pnpm run verify`, so a release tag cannot be published when the
 * published README would state a stale version.
 */
import { readFileSync } from 'node:fs'

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const problems = []
const fail = message => problems.push(message)

/** Semver-ish ordering that understands prerelease suffixes like 0.2.1-alpha.5. */
function compareVersions(left, right) {
  const parse = value => value.split(/[.-]/).map(part => (/^\d+$/.test(part) ? Number(part) : part))
  const a = parse(left), b = parse(right)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return 1
    if (typeof y === 'number') return -1
    return x < y ? -1 : 1
  }
  return 0
}

const pkg = JSON.parse(read('package.json'))
const pluginVersion = pkg.version
const declared = Object.entries(pkg.dsh.compatibility.dshReleases)
  .filter(([, state]) => state === 'compatible')
  .map(([version]) => version)
  .sort(compareVersions)
const dshVersion = declared[declared.length - 1]
if (dshVersion === undefined) throw new Error('no compatible DSH release declared in package.json')

/** A release's README row/badge may render the version with `-` doubled for shields.io. */
const badgeForm = dshVersion.replace(/-/g, '--')

const surfaces = [
  {
    file: 'README.zh.md',
    checks: [
      [`徽章含 DSH-${badgeForm}`, content => content.includes(`badge/DSH-${badgeForm}-`)],
      [`已验证行 = ${dshVersion}`, content => content.includes(`已验证的 DeepSeek Harness：\`${dshVersion}\``)],
      [`当前版本行 = ${pluginVersion} / ${dshVersion}`, content =>
        content.includes(`当前版本：插件 **\`${pluginVersion}\`**，兼容 DeepSeek Harness **\`${dshVersion}\`**`)],
      ['兼容表有本版行', content => content.includes(`| **\`${pluginVersion}\`** |`)],
      ['已验证清单含本版 DSH', content => new RegExp(`已验证版本：[^\\n]*\`${dshVersion.replace(/\./g, '\\.')}\``).test(content)],
    ],
  },
  {
    file: 'README.md',
    checks: [
      [`badge contains DSH-${badgeForm}`, content => content.includes(`badge/DSH-${badgeForm}-`)],
      [`verified line = ${dshVersion}`, content => content.includes(`Verified DeepSeek Harness: \`${dshVersion}\``)],
      [`current version line = ${pluginVersion} / ${dshVersion}`, content =>
        content.includes(`Current version: plugin **\`${pluginVersion}\`**, compatible with DeepSeek Harness **\`${dshVersion}\`**`)],
      ['compatibility table has this release', content => content.includes(`| **\`${pluginVersion}\`** |`)],
      ['verified list includes this DSH release', content =>
        new RegExp(`verified releases:[^\\n]*\`${dshVersion.replace(/\./g, '\\.')}\``).test(content)],
    ],
  },
  {
    file: `release-notes/v${pluginVersion}.md`,
    checks: [
      ['Chinese anchor', content => content.includes(`<h3 id="cn-v${pluginVersion}">`)],
      ['English anchor', content => content.includes(`<h3 id="en-v${pluginVersion}">`)],
      [`compatibility line = ${dshVersion}`, content =>
        new RegExp(`兼容 DeepSeek Harness \`${dshVersion.replace(/\./g, '\\.')}\``).test(content) &&
        new RegExp(`Compatible with DeepSeek Harness \`${dshVersion.replace(/\./g, '\\.')}\``).test(content)],
    ],
  },
  {
    file: 'CHANGELOG.md',
    checks: [[`has a ${pluginVersion} section`, content => content.includes(`## [${pluginVersion}]`)]],
  },
]

for (const surface of surfaces) {
  let content
  try {
    content = read(surface.file)
  } catch {
    fail(`${surface.file}: missing`)
    continue
  }
  for (const [label, check] of surface.checks) {
    if (!check(content)) fail(`${surface.file}: ${label}`)
  }
}

// The DSH release the READMEs advertise must be the newest one declared, so a
// compatibility bump cannot quietly leave the docs a release behind.
const hostDevDependencies = ['@deepseek-ai/dsh-host-webserver', '@deepseek-ai/dsh-client-connection']
for (const name of hostDevDependencies) {
  const range = pkg.devDependencies[name]
  if (range !== dshVersion) fail(`package.json: devDependency ${name} is ${range}, expected ${dshVersion}`)
}

if (problems.length > 0) {
  console.error(`version consistency: ${problems.length} problem(s) for ${pluginVersion} on DSH ${dshVersion}`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`version consistency: ${pluginVersion} on DSH ${dshVersion} — README (zh/en), release notes and changelog agree`)
