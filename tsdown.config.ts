import { readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'

// The manifest at the package root is the source of truth for entry ids,
// client externals, and the platform module list.
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Modules the web shell seeds into the frozen browser module table: client
// bundles leave these to the injected `require` instead of inlining. (This
// list mirrors the harness client build baseline for dsh 0.1.7.)
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

// Every module specifier this plugin's client bundle may require at runtime:
// the platform baseline plus any package-declared external rows. Anything else
// must never survive the build (a require() the module table cannot answer is
// a guaranteed runtime throw).
const requested = new Set([...PLATFORM_MODULES, ...(pkg.dsh?.client?.external ?? [])])
const isRequested = (specifier: string): boolean => requested.has(specifier)

// Host half: production dependencies stay imports (they resolve from the
// installed tree); everything else is inlined. Stated explicitly so moving a
// dependency between npm sections never silently re-bundles it.
const productionDeps = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
])
const escapeSpecifier = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const productionPatterns = [...productionDeps].map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
const isProductionDependency = (specifier: string): boolean =>
  productionPatterns.some(pattern => pattern.test(specifier))

const NODE_ENV = process.env.NODE_ENV ?? 'production'

export default defineConfig([
  // Host half: a plain Cordis plugin (ESM). Serves the reverse proxy and the
  // management endpoints; on DSH 0.1.7 its exported Config IS its settings
  // form namespace.
  {
    name: pkg.name,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: {
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  },
  // Client half: the official `settings.section` card. Wrapped in the
  // closure-factory handoff every `dsh.client` package's ./client export must
  // use: the factory receives the synchronous require bound to the browser
  // module table and returns the bundle exports.
  {
    name: `${pkg.name}/client`,
    entry: { client: 'src/client.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    define: {
      'process.env': '{}',
      'process.env.NODE_ENV': JSON.stringify(NODE_ENV),
      'import.meta.env.MODE': JSON.stringify(NODE_ENV),
      'import.meta.env': JSON.stringify({ MODE: NODE_ENV }),
    },
    plugins: [{
      name: 'dsh-lan-guard-client-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null
        // Type-only imports are erased before they ever reach this gate; a
        // surviving @deepseek-ai value import means we accidentally inline a
        // second copy of a harness module (React/Cordis/services) — fail loud.
        throw new Error(
          `client bundle purity: "${source}" is not in the platform baseline or this package's dsh.client.external list. `
          + 'Runtime @deepseek-ai imports are forbidden (cross-plugin value imports would duplicate React/Cordis). '
          + 'Type-only imports are erased and never reach this gate.',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
