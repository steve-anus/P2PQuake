// Boot the DHT through a qn-peer-style instance and prove bootstrap works.
const DHT = require('hyperdht')
const node = new DHT()

const guard = setTimeout(() => {
  console.log('SMOKE FAIL: no bootstrap within 25s (UDP egress blocked?)')
  process.exit(2)
}, 25000)

node.ready().then(() => {
  clearTimeout(guard)
  console.log('SMOKE OK: DHT bootstrapped; routing nodes:', node.nodes ? node.nodes.length : 'n/a')
  return node.destroy()
}).then(() => process.exit(0)).catch((e) => {
  clearTimeout(guard)
  console.log('SMOKE FAIL:', e.message)
  process.exit(1)
})
