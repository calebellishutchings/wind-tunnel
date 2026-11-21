const { createHash } = require('node:crypto')
const { createReadStream } = require('node:fs')
const { readFile, writeFile, stat, copyFile } = require('node:fs/promises')
const path = require('node:path')

async function main() {
  const root = path.resolve(__dirname, '..')
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const filename = `ENS-Wind-Tunnel-Setup-${version}.exe`
  const output = path.join(root, 'distribution')
  const file = path.join(output, filename)
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  const sha256 = hash.digest('hex')
  const manifest = {
    version,
    filename,
    bytes: (await stat(file)).size,
    sha256,
    architectures: ['x64', 'arm64'],
    installScope: 'currentUser',
    runtime: 'bundled Electron; no destination framework installation',
    target: 'Windows 11; Windows 10 permitted but unsupported',
    builtAt: new Date().toISOString(),
  }
  await writeFile(path.join(output, 'SHA256SUMS.txt'), `${sha256} *${filename}\n`)
  await writeFile(
    path.join(output, 'release-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  await copyFile(path.join(root, 'build/INSTALL.txt'), path.join(output, 'INSTALL.txt'))
  console.log(`\nReady to distribute: ${file}\nSHA256: ${sha256}`)
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
