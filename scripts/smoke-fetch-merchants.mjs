// Live smoke: pull first page from PriceAI and print counts.
const ua = 'MerchantAggregator/1.0 (+personal-research; contact: local-user)'
const url = 'https://priceai.cc/api/merchants?limit=5&offset=0'
const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': ua } })
if (!res.ok) {
  console.error('HTTP', res.status)
  process.exit(1)
}
const body = await res.json()
console.log(
  JSON.stringify(
    {
      ok: true,
      total: body.total,
      rows: body.rows?.length,
      degraded: body.degraded,
      sample: body.rows?.[0]?.name
    },
    null,
    2
  )
)
