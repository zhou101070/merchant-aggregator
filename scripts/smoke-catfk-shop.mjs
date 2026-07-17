/**
 * Smoke probe for https://catfk.com/shop/hththt using the same HTTP shape as ShopApiClient.
 * No browser tools — pure Node fetch.
 *
 * Usage: node scripts/smoke-catfk-shop.mjs [token]
 */
import { randomBytes } from 'node:crypto'

const TOKEN = process.argv[2] || 'hththt'
const BASE = 'https://catfk.com'
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const visitorId = randomBytes(8).toString('hex')
const jar = new Map()

function absorb(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  for (const c of list) {
    const part = c.split(';')[0]
    const i = part.indexOf('=')
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1))
  }
}
function cookie() {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      Origin: BASE,
      Referer: `${BASE}/shop/${TOKEN}`,
      'User-Agent': UA,
      Visitorid: visitorId,
      ...(jar.size ? { Cookie: cookie() } : {})
    },
    body: JSON.stringify(body)
  })
  absorb(res)
  const text = await res.text()
  return { status: res.status, text }
}

async function main() {
  console.log(`probe ${BASE}/shop/${TOKEN}`)
  try {
    const res = await fetch(`${BASE}/shop/${TOKEN}`, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html',
        Visitorid: visitorId
      }
    })
    absorb(res)
    const html = await res.text()
    console.log('warmup', {
      status: res.status,
      len: html.length,
      cookies: [...jar.keys()],
      spa: html.includes('/package/shop/assets/')
    })
  } catch (e) {
    console.error('warmup FAILED', e.cause?.code || e.message)
    process.exitCode = 2
    return
  }

  try {
    const info = await post('/shopApi/Shop/info', { token: TOKEN, category_key: null })
    let json
    try {
      json = JSON.parse(info.text)
    } catch {
      json = null
    }
    console.log('Shop/info', {
      status: info.status,
      code: json?.code,
      nickname: json?.data?.nickname,
      goods_count: json?.data?.goods_count,
      snippet: info.text.slice(0, 200)
    })
    if (json?.code !== 1) {
      process.exitCode = 3
      return
    }

    const list = await post('/shopApi/Shop/goodsList', {
      token: TOKEN,
      keywords: '',
      category_id: 0,
      goods_type: 'card',
      current: 1,
      pageSize: 5
    })
    let listJson
    try {
      listJson = JSON.parse(list.text)
    } catch {
      listJson = null
    }
    const data = listJson?.data
    const arr = Array.isArray(data) ? data : data?.list || []
    console.log('goodsList', {
      status: list.status,
      code: listJson?.code,
      count: arr.length,
      first: arr[0] ? { goods_key: arr[0].goods_key, name: arr[0].name, price: arr[0].price } : null
    })
    if (listJson?.code !== 1) process.exitCode = 4
    else {
      console.log('SMOKE OK — catfk shopApi matches ldxp-family')
      process.exitCode = 0
    }
  } catch (e) {
    console.error('API FAILED', e.cause?.code || e.message)
    process.exitCode = 5
  }
}

main()
