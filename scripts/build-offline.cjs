// Precache only built assets. Captures and user data never enter Pages assets.
const { readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const root = path.resolve(__dirname, '../dist')
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? files(file) : [file]
  })
}
const assets = files(root).filter((file) => !['sw.js', '.nojekyll'].includes(path.basename(file)))
const hash = createHash('sha256')
hash.update(readFileSync(__filename))
for (const file of assets) hash.update(readFileSync(file))
const version = hash.digest('hex').slice(0, 16)
const names = assets.map((file) => path.relative(root, file).replaceAll('\\', '/'))
writeFileSync(path.join(root, '.nojekyll'), '')
writeFileSync(
  path.join(root, 'sw.js'),
  `// Generated application assets, version ${version}.
const CACHE = 'ens-wind-tunnel-' + self.registration.scope + '-${version}';
const URLS = ${JSON.stringify(names)}.map(name => new URL(name, self.registration.scope).href);
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(URLS))));
// No skipWaiting or forced reload: an update must never interrupt a control session.
self.addEventListener('activate', event => event.waitUntil((async () => {
  const prefix = 'ens-wind-tunnel-' + self.registration.scope + '-';
  for (const key of await caches.keys()) if (key.startsWith(prefix) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = event.request.mode === 'navigate' ? new URL('index.html', self.registration.scope).href : event.request;
    // The dev preview may add Vary: Origin; these precached public assets are identical.
    return await cache.match(key, { ignoreVary: true }) || fetch(event.request);
  })());
});
`,
)
console.log(`Offline application shell: ${names.length} assets, ${version}`)
