import fs from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const LOGIN_URL = 'https://www.almacielo.com/member/login.php'
/** 회원 전용 단가표 (로그인 세션 필요) */
const MY_PRICE_URL = 'https://www.almacielo.com/content/content.php?cont=my_price'
const OUTPUT_FILE = path.resolve(process.cwd(), 'public/alma-prices-member.json')

const parsePrice = (value) => {
  const digits = String(value ?? '').replace(/[^\d]/g, '')
  const n = Number(digits)
  return Number.isFinite(n) ? n : 0
}

async function tryLoadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env')
  try {
    const text = await fs.readFile(envPath, 'utf8')
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = val
    }
  } catch {
    // optional
  }
}

/**
 * 나의 단가표: 실제 HTML은 (1) 구버전 tr#alma_* + #prd_name a + td[3],
 * (2) 현재 #printarea 안 table.tbl_col.mypage.price — 품명은 첫 td 링크, 나의단가는 td.point_color(6번째 열).
 */
function extractRowsFromDocument() {
  const out = []

  const legacy = Array.from(document.querySelectorAll('tr[id^="alma_"]'))
  for (const tr of legacy) {
    const nameEl =
      tr.querySelector('#prd_name a') ||
      tr.querySelector('[id="prd_name"] a') ||
      tr.querySelector('a[href*="detail.php"]') ||
      tr.querySelector('td a')
    const itemName = (nameEl?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const cells = tr.querySelectorAll('td')
    const priceText = (cells[2]?.textContent ?? '').trim()
    const productUrl =
      nameEl && 'href' in nameEl && typeof nameEl.href === 'string' ? nameEl.href : ''
    let supplyNote = ''
    if (cells.length > 6) {
      supplyNote = (cells[6]?.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    if (!supplyNote && cells.length > 3) {
      supplyNote = (cells[3]?.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    out.push({ itemName, priceText, productUrl, supplyNote })
  }

  const modern = Array.from(
    document.querySelectorAll('#printarea table.tbl_col.mypage.price tbody tr'),
  )
  for (const tr of modern) {
    const cells = tr.querySelectorAll('td')
    if (cells.length < 6) continue
    const nameEl = cells[0].querySelector('a[href*="detail.php"]') || cells[0].querySelector('a')
    const itemName = (nameEl?.textContent ?? cells[0].textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const priceTd = tr.querySelector('td.point_color') || cells[5]
    const priceText = (priceTd?.textContent ?? '').trim()
    const productUrl =
      nameEl && 'href' in nameEl && typeof nameEl.href === 'string' ? nameEl.href : ''
    // 수급정보(결품·계절한정 등): 보통 4번째 열(td[4]). 비어 있으면 7번째 열(td[7]) 텍스트
    let supplyNote = (cells[3]?.textContent ?? '').replace(/\s+/g, ' ').trim()
    if (!supplyNote && cells.length > 6) {
      supplyNote = (cells[6]?.textContent ?? '').replace(/\s+/g, ' ').trim()
    }
    out.push({ itemName, priceText, productUrl, supplyNote })
  }

  return out
}

/** 메인 문서 + 모든 iframe에서 동일 추출 시도 */
async function extractRowsFromAllFrames(page) {
  const tryEval = async (handle) => {
    try {
      return await handle.evaluate(extractRowsFromDocument)
    } catch {
      return []
    }
  }
  let raw = await tryEval(page)
  if (raw.length > 0) {
    return raw
  }
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) {
      continue
    }
    const r = await tryEval(frame)
    if (r.length > 0) {
      return r
    }
  }
  return []
}

/** 단가표 tbody 행이 보일 때까지 (메인/iframe) */
async function waitForPriceTableInAnyFrame(page, timeoutMs = 90000) {
  const hasRows = () => {
    const a = document.querySelectorAll('#printarea table.tbl_col.mypage.price tbody tr').length
    const b = document.querySelectorAll('tr[id^="alma_"]').length
    return a > 0 || b > 0
  }
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    for (const frame of page.frames()) {
      try {
        const ok = await frame.evaluate(hasRows)
        if (ok) return
      } catch {
        // cross-origin or not ready
      }
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(
    '나의 단가표 행을 찾지 못했습니다. 로그인·my_price 접근을 확인하세요.',
  )
}

async function main() {
  await tryLoadDotEnv()
  const id = process.env.ALMA_LOGIN_ID?.trim()
  const pw = process.env.ALMA_LOGIN_PASSWORD?.trim()
  if (!id || !pw) {
    console.error(
      'Set ALMA_LOGIN_ID and ALMA_LOGIN_PASSWORD (or add them to app/.env). Do not commit credentials.',
    )
    process.exit(1)
  }

  const headless = process.env.ALMA_HEADLESS !== '0' && process.env.ALMA_HEADLESS !== 'false'

  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    locale: 'ko-KR',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  })
  const page = await context.newPage()

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.locator('#login_id').fill(id)
    await page.locator('#login_pwd').fill(pw)
    await page.locator('#login > form:has(#login_id) input[type="submit"][value="로그인"]').click()

    await page.waitForFunction(
      () =>
        document.querySelector('a[href*="logout"]') !== null ||
        window.location.search.includes('err=1'),
      { timeout: 45000 },
    )
    if (page.url().includes('err=1')) {
      throw new Error('로그인 실패: 아이디·비밀번호(ALMA_LOGIN_ID / ALMA_LOGIN_PASSWORD)를 확인하세요.')
    }

    await page.goto(MY_PRICE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await page.waitForLoadState('networkidle', { timeout: 45000 }).catch(() => {})

    await waitForPriceTableInAnyFrame(page, 90000)

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {})
    await new Promise((r) => setTimeout(r, 600))

    const raw = await extractRowsFromAllFrames(page)
    const byName = new Map()
    for (const row of raw) {
      const price = parsePrice(row.priceText)
      if (!row.itemName || price <= 0) continue
      const sn = typeof row.supplyNote === 'string' ? row.supplyNote.trim() : ''
      if (!byName.has(row.itemName)) {
        byName.set(row.itemName, {
          itemName: row.itemName,
          price,
          productUrl: row.productUrl || '',
          supplyNote: sn,
        })
      }
    }

    const items = [...byName.values()].sort((a, b) => a.itemName.localeCompare(b.itemName, 'ko'))
    const payload = {
      source: 'almacielo-member',
      sourceUrl: MY_PRICE_URL,
      fetchedAt: new Date().toISOString(),
      itemCount: items.length,
      items,
    }

    await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true })
    await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    console.log(`saved: ${OUTPUT_FILE}`)
    console.log(`items: ${items.length}`)
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
