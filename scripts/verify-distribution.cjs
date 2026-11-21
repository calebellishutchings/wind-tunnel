// Read-only validation of the produced installer and its two application payloads.
// Never runs setup, launches the app, or opens serial devices.
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const assert = require('node:assert/strict')

const root = path.resolve(__dirname, '..')
const output = path.join(root, 'distribution')
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const fromBuilder = createRequire(
  createRequire(require.resolve('electron-builder')).resolve('app-builder-lib'),
)
const asar = fromBuilder('@electron/asar')

function peInfo(filename) {
  const b = fs.readFileSync(filename)
  assert.equal(b.toString('ascii', 0, 2), 'MZ', `Not a Windows executable: ${filename}`)
  const pe = b.readUInt32LE(60),
    optional = pe + 24
  assert.equal(b.readUInt32LE(pe), 0x4550)
  const sections = optional + b.readUInt16LE(pe + 20)
  const count = b.readUInt16LE(pe + 6)
  const offset = (rva) => {
    for (let i = 0; i < count; i++) {
      const s = sections + i * 40,
        start = b.readUInt32LE(s + 12)
      const length = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16))
      if (rva >= start && rva < start + length) return b.readUInt32LE(s + 20) + rva - start
    }
    throw Error('Invalid PE resource/import address')
  }
  const imports = []
  const importRva = b.readUInt32LE(optional + (b.readUInt16LE(optional) === 0x20b ? 112 : 96) + 8)
  if (importRva)
    for (let d = offset(importRva); b.readUInt32LE(d + 12); d += 20) {
      const name = offset(b.readUInt32LE(d + 12))
      imports.push(b.toString('ascii', name, b.indexOf(0, name)))
    }
  const manifestStart = b.indexOf(Buffer.from('<requestedExecutionLevel'))
  const manifest = manifestStart < 0 ? '' : b.toString('utf8', manifestStart, manifestStart + 300)
  const level =
    /<requestedExecutionLevel\b[^>]*\blevel=["']([^"']+)["']/.exec(manifest)?.[1] ?? null
  return {
    machine: b.readUInt16LE(pe + 4),
    level,
    imports,
    sha256: createHash('sha256').update(b).digest('hex'),
  }
}
function embeddedHash(tool, archive, member) {
  return new Promise((resolve, reject) => {
    // Decompress a named member to a hash stream, never executing it or extracting its path.
    const child = spawn(tool, ['e', '-so', '-bd', '-y', archive, member], { windowsHide: true })
    const hash = createHash('sha256')
    let errorText = ''
    child.stdin.end()
    child.stdout.on('data', (chunk) => hash.update(chunk))
    child.stderr.on('data', (chunk) => {
      errorText = (errorText + chunk.toString()).slice(-8192)
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(hash.digest('hex'))
        : reject(Error(`Archive verification failed (${code}): ${errorText}`)),
    )
  })
}
function walk(folder) {
  return fs.readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(folder, entry.name)
    return entry.isDirectory() ? walk(filename) : [filename]
  })
}
async function main() {
  const installer = path.join(output, `ENS-Wind-Tunnel-Setup-${metadata.version}.exe`)
  const setup = peInfo(installer)
  assert.equal(setup.level, 'asInvoker', 'Setup must not request administrator rights')
  const reports = []
  const expected = new Map()
  for (const [arch, folder, machine, binding] of [
    ['x64', 'win-unpacked', 0x8664, '@serialport+bindings-cpp.node'],
    ['arm64', 'win-arm64-unpacked', 0xaa64, '@serialport+bindings-cpp.armv8.node'],
  ]) {
    const appFolder = path.join(output, folder)
    const executable = peInfo(path.join(appFolder, 'ENS Wind Tunnel.exe'))
    assert.equal(executable.machine, machine)
    assert.equal(executable.level, 'asInvoker')
    assert(!fs.existsSync(path.join(appFolder, 'resources/elevate.exe')))
    const archive = path.join(appFolder, 'resources/app.asar')
    expected.set(executable.sha256, {
      arch,
      asarHash: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    })
    const pkg = JSON.parse(asar.extractFile(archive, 'package.json'))
    assert.equal(pkg.version, metadata.version)
    for (const filename of walk(path.join(root, 'out'))) {
      const relative = path.relative(root, filename)
      assert(
        asar.extractFile(archive, relative).equals(fs.readFileSync(filename)),
        `Stale packaged file: ${arch}/${relative}`,
      )
    }
    const native = peInfo(
      path.join(
        appFolder,
        'resources/app.asar.unpacked/node_modules/@serialport/bindings-cpp/prebuilds',
        `win32-${arch}`,
        binding,
      ),
    )
    assert.equal(native.machine, machine)
    // These are Windows system libraries. A separate VC++ redistributable must not be needed.
    const windowsLibraries = new Set(['kernel32.dll', 'advapi32.dll', 'ole32.dll', 'setupapi.dll'])
    for (const name of native.imports)
      assert(
        windowsLibraries.has(name.toLowerCase()),
        `Review unbundled native dependency: ${arch}/${name}`,
      )
    reports.push({
      arch,
      nativeImports: native.imports,
      appExecutionLevel: executable.level,
      matchesBuild: true,
    })
  }
  const { getPath7za } = fromBuilder('./toolsets/7zip')
  const path7za = await getPath7za()
  // 7za handles 7z but not NSIS containers. NSIS embeds the two standard 7z payloads
  // verbatim. Read their signature headers, then verify their real contents against
  // the checked build rather than assuming particular filenames inside the NSIS stub.
  const bytes = fs.readFileSync(installer)
  const signature = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])
  const tempRoot = path.join(root, '.test-data')
  fs.mkdirSync(tempRoot, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(tempRoot, 'installer-verify-'))
  const files = []
  const seen = new Set()
  try {
    let cursor = 0
    while ((cursor = bytes.indexOf(signature, cursor)) >= 0) {
      const start = cursor++
      if (start + 32 > bytes.length || bytes[start + 6] !== 0) continue
      const size = 32n + bytes.readBigUInt64LE(start + 12) + bytes.readBigUInt64LE(start + 20)
      if (size < 1024n || size > BigInt(bytes.length - start)) continue
      const file = path.join(temporary, `payload-${files.length}.7z`)
      files.push(file)
      fs.writeFileSync(file, bytes.subarray(start, start + Number(size)))
      const executableHash = await embeddedHash(path7za, file, 'ENS Wind Tunnel.exe')
      const payload = expected.get(executableHash)
      assert(payload, 'Embedded application executable does not match either checked architecture')
      assert(!seen.has(payload.arch), 'Duplicate embedded architecture')
      assert.equal(
        await embeddedHash(path7za, file, 'resources/app.asar'),
        payload.asarHash,
        'Embedded application resources differ from the checked build',
      )
      seen.add(payload.arch)
      cursor = start + Number(size)
    }
    assert.deepEqual([...seen].sort(), ['arm64', 'x64'])
  } finally {
    // Only the exact temporary files we created are removed. No recursive deletion.
    for (const file of files) if (fs.existsSync(file)) fs.unlinkSync(file)
    fs.rmdirSync(temporary)
  }
  const report = {
    version: metadata.version,
    setupExecutionLevel: setup.level,
    embeddedArchitectures: ['x64', 'arm64'],
    embeddedExecutablesAndResourcesMatchBuild: true,
    payloads: reports,
    installed: false,
    note: 'Static artifact verification; setup was not executed.',
  }
  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
