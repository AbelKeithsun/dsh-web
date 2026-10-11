import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = new URL('../', import.meta.url)
const fingerprints = JSON.parse(readFileSync(new URL('scripts/lib-artifact-fingerprints.json', root), 'utf8'))

const storeConsumers = ['packages/dsh-market', 'packages/dsh-web-all']

for (const dir of storeConsumers) {
  const file = `${dir}/lib/client.js`
  test(`${file} resolves the snapshot store through the supported platform`, () => {
    // Given a committed client artifact, when mounted, then use one supported store identity.
    assert.ok(Object.hasOwn(fingerprints, dir), 'the store-consuming artifact must remain in the committed registry')
    const source = readFileSync(fileURLToPath(new URL(file, root)), 'utf8')
    assert.equal(/\brequire\s*\(\s*["']@deepseek-ai\/dsh-client-store["']\s*\)/.test(source), true, 'store must resolve through the supported platform')
    assert.equal(/dsh-store-engine|@deepseek-ai\/dsh-client-runtime/.test(source), false, 'legacy store resolution must not ship')
  })
}
