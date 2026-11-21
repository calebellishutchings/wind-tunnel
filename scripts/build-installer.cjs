// Explicit distribution build. Normal dev/build/package commands never call this script.
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
function run(label, cli, args = [], environment = {}) {
  console.log(`\n${label}`)
  const result = spawnSync(process.execPath, [path.join(root, cli), ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ...environment },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw Error(`${label} failed (exit ${result.status ?? result.signal})`)
}
async function main() {
  if (process.platform !== 'win32') throw Error('Build this Windows installer on Windows.')
  if (!existsSync(path.join(root, 'node_modules/electron-builder/cli.js')))
    throw Error(
      'Install development dependencies first: pnpm install --frozen-lockfile. See docs/DISTRIBUTION.md.',
    )
  run('Checking TypeScript', 'node_modules/typescript/bin/tsc', ['--noEmit'])
  run('Checking offline regressions', 'node_modules/vitest/vitest.mjs', ['run'])
  run('Compiling the application', 'node_modules/electron-vite/bin/electron-vite.js', ['build'])
  // A separate directory avoids touching the working app in release/win-unpacked.
  // Both runtimes go into one NSIS installer; setup chooses the native architecture.
  run(
    'Packaging per-user Windows installer (x64 + ARM64)',
    'node_modules/electron-builder/cli.js',
    [
      '--win',
      'nsis',
      '--x64',
      '--arm64',
      '--publish',
      'never',
      '--config.directories.output=distribution',
    ],
    { ELECTRON_BUILDER_COMPRESSION_LEVEL: process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ?? '3' },
  )
  run('Writing distribution checksums and instructions', 'scripts/release-manifest.cjs')
  run('Verifying bundled runtimes and non-admin manifests', 'scripts/verify-distribution.cjs')
}
main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
