import fs from 'node:fs/promises'
import path from 'node:path'

const BASE_URL = 'https://www.almacielo.com/shop/big_section.php?sort=4&cno1=1070'
const PAGE_COUNT = 7
const OUTPUT_FILE = path.resolve(process.cwd(), 'public/alma-prices-latest.json')

const normalizeText = (value) => value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const parsePrice = (value) => {
  const digits = value.replace(/[^\d]/g, '')
  const n = Number(digits)
  return Number.isFinite(n) ? n : 0
}

function extractProductsFromHtml(html) {
  const pattern =
    /<a href="(https:\/\/www\.almacielo\.com\/shop\/detail\.php[^"]+)"[^>]*>\s*([^<\n]+?)\s*<\/a>[\s\S]{0,1200}?([0-9,]+)원/gi
  const result = []
  for (const match of html.matchAll(pattern)) {
    const itemName = normalizeText(match[2] ?? '')
    const price = parsePrice(match[3] ?? '')
    if (!itemName || price <= 0) {
      continue
    }
    result.push({
      itemName,
      price,
      productUrl: match[1] ?? '',
    })
  }
  return result
}

async function fetchPage(page) {
  const url = page === 1 ? BASE_URL : `${BASE_URL}&page=${page}`
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  })
  if (!response.ok) {
    throw new Error(`page ${page} fetch failed: ${response.status}`)
  }
  return response.text()
}

async function main() {
  const byName = new Map()
  for (let page = 1; page <= PAGE_COUNT; page += 1) {
    const html = await fetchPage(page)
    const products = extractProductsFromHtml(html)
    for (const item of products) {
      // 같은 이름이 여러 번 나오면 최신(앞 페이지) 값을 우선
      if (!byName.has(item.itemName)) {
        byName.set(item.itemName, { ...item, page })
      }
    }
  }

  const items = [...byName.values()].sort((a, b) => a.itemName.localeCompare(b.itemName, 'ko'))
  const payload = {
    source: 'almacielo',
    sourceUrl: BASE_URL,
    fetchedAt: new Date().toISOString(),
    pageCount: PAGE_COUNT,
    itemCount: items.length,
    items,
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true })
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  console.log(`saved: ${OUTPUT_FILE}`)
  console.log(`items: ${items.length}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
