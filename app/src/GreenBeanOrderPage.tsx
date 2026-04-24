import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import * as XLSX from 'xlsx'
import PageSaveStatus from './components/PageSaveStatus'
import { exportStyledGreenBeanOrderExcel } from './greenBeanOrderExcelExport'
import { dayIndexForReferenceDate, normalizeInventoryStatusState } from './inventoryStatusUtils'
import { INVENTORY_STATUS_STORAGE_KEY } from './InventoryStatusPage'
import {
  BEAN_NAME_ALIASES_STORAGE_KEY,
  BEAN_NAME_ALIASES_UPDATED_EVENT,
  getEffectiveGreenBeanOrderAliases,
  normalizeBeanNameAliases,
  readCustomBeanNameAliases,
  writeCustomBeanNameAliases,
  type BeanNameAliasEntry,
} from './beanNameAliasStore'
import { GREEN_BEAN_ORDER_INVENTORY_ALIASES } from './greenBeanOrderInventoryAliases'
import { useCloudDocumentRefreshPull } from './lib/cloudDocumentRefresh'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { useDocumentSaveUi } from './lib/documentSaveUi'
import { useAppRuntime } from './providers/AppRuntimeProvider'

export const GREEN_BEAN_ORDER_STORAGE_KEY = 'green-bean-order-v2'
/** 알마 단가 갱신 직후 UI(강조·단가 목록) 복원 및 재갱신 쿨다운 */
const GREEN_BEAN_ALMA_REFRESH_CACHE_KEY = 'green-bean-alma-refresh-cache-v1'
/**
 * 알마 단가 JSON/갱신 API를 다시 호출하기 전 최소 대기 시간.
 * (성공 갱신 후 UI 캐시 유지 구간과 동일)
 */
export const ALMA_PRICE_REFRESH_COOLDOWN_MS = 8 * 60 * 60 * 1000

const almaCooldownHumanLabel = (): string => {
  const ms = ALMA_PRICE_REFRESH_COOLDOWN_MS
  if (ms >= 60 * 60 * 1000 && ms % (60 * 60 * 1000) === 0) {
    return `${ms / (60 * 60 * 1000)}시간`
  }
  if (ms >= 60 * 60 * 1000) {
    const h = ms / (60 * 60 * 1000)
    return Number.isInteger(h) ? `${h}시간` : `약 ${h.toFixed(1)}시간`
  }
  if (ms >= 60 * 1000 && ms % (60 * 1000) === 0) {
    return `${ms / (60 * 1000)}분`
  }
  return `${Math.round(ms / 1000)}초`
}

/** 남은 쿨다운을 사람이 읽기 쉬운 문자열로 */
const formatAlmaCooldownRemaining = (remainingMs: number): string => {
  const msec = Math.max(0, remainingMs)
  if (msec >= 60 * 60 * 1000) {
    const totalMin = Math.ceil(msec / (60 * 1000))
    const h = Math.floor(totalMin / 60)
    const m = totalMin % 60
    if (m === 0) {
      return `약 ${h}시간`
    }
    return `약 ${h}시간 ${m}분`
  }
  if (msec >= 60 * 1000) {
    return `약 ${Math.max(1, Math.ceil(msec / (60 * 1000)))}분`
  }
  const s = Math.max(1, Math.ceil(msec / 1000))
  return `${s}초`
}

const currencyFormatter = new Intl.NumberFormat('ko-KR')

type PriceCell = number | string
type GreenBeanPriceSource = 'auto' | number

export type GreenBeanOrderRow = {
  id: string
  itemName: string
  /** 입출고 품목과의 고정 연동 키(이름이 바뀌어도 연결 유지) */
  inventoryLinkKey?: string
  supplierPrices: PriceCell[]
  quantityKg: number
  priceSource?: GreenBeanPriceSource
  lineTotal: number
  /** 알마 단가표에서 온 수급 안내(결품·계절한정 등), 불러오기 매칭 시에만 채움 */
  almaSupplyNote?: string
}

type GreenBeanOrderBaseline = {
  savedAt: string
  title: string
  supplierLabels: string[]
  rows: GreenBeanOrderRow[]
}

export type GreenBeanMonthlyItemSnapshot = {
  itemName: string
  quantityKg: number
  lineTotal: number
}

export type GreenBeanMonthlyPoint = {
  id: string
  /** YYYY-MM */
  monthKey: string
  savedAt: string
  sumQty: number
  sumMoney: number
  itemCount: number
  /** 월 기록 시점의 품목별 수량·총액 (원두별 그래프용) */
  items?: GreenBeanMonthlyItemSnapshot[]
}

/** 품목 소계에서 빼는 쿠폰·감면(원). 기록·차트의 총액은 차감 후 금액입니다. */
export type GreenBeanOrderDeductions = {
  almaWon: number
  gscWon: number
  /** 그 외 임의 감면 */
  otherWon: number
}

/** 일자별로 저장하는 주문 스냅샷. 월별 추이는 같은 달의 스냅샷을 합산해 만듭니다. */
export type GreenBeanOrderDatedSnapshot = {
  id: string
  /** 주문 일자 YYYY-MM-DD */
  orderDate: string
  savedAt: string
  sumQty: number
  /** 차감 반영 후 총액(기록·월별 합계에 사용) */
  sumMoney: number
  /** 기록 시점 품목 행 합계(차감 전) */
  sumMoneyGross?: number
  /** 기록 시점 감면 내역 */
  deductions?: GreenBeanOrderDeductions
  /** 일자 기록 시 메모(선택) */
  memo?: string
  itemCount: number
  items?: GreenBeanMonthlyItemSnapshot[]
}

type AlmaPriceItem = {
  itemName: string
  price: number
  supplyNote?: string
}

/** 알마 단가 갱신 직후, 이전 표시와 달라진 행만 기록 (강조·툴팁용) */
type AlmaRefreshRowChange = {
  prevPrice: number | null
  nextPrice: number | null
  prevNote: string
  nextNote: string
}

type AlmaRefreshCacheV1 = {
  version: 1
  completedAt: number
  cooldownMs: number
  almaFetchedAt: string
  almaItems: AlmaPriceItem[]
  almaRefreshChanges: Record<string, AlmaRefreshRowChange>
  almaRefreshUnchangedIds: Record<string, true>
  almaRefreshGlobalSameHint: boolean
}

const isAlmaRefreshRowChange = (v: unknown): v is AlmaRefreshRowChange => {
  if (!v || typeof v !== 'object') {
    return false
  }
  const o = v as Record<string, unknown>
  return (
    (o.prevPrice === null || typeof o.prevPrice === 'number') &&
    (o.nextPrice === null || typeof o.nextPrice === 'number') &&
    typeof o.prevNote === 'string' &&
    typeof o.nextNote === 'string'
  )
}

const readAlmaRefreshCache = (): AlmaRefreshCacheV1 | null => {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const raw = window.localStorage.getItem(GREEN_BEAN_ALMA_REFRESH_CACHE_KEY)
    if (!raw) {
      return null
    }
    const o = JSON.parse(raw) as Partial<AlmaRefreshCacheV1>
    if (o.version !== 1 || typeof o.completedAt !== 'number' || !Array.isArray(o.almaItems)) {
      return null
    }
    const items: AlmaPriceItem[] = []
    for (const row of o.almaItems) {
      if (!row || typeof row !== 'object') {
        continue
      }
      const r = row as Record<string, unknown>
      const itemName = String(r.itemName ?? '').trim()
      const price = Math.max(0, Number(r.price ?? 0))
      if (!itemName || !Number.isFinite(price)) {
        continue
      }
      const sn = r.supplyNote
      const supplyNoteRaw = typeof sn === 'string' ? sn.replace(/\s+/g, ' ').trim() : ''
      const item: AlmaPriceItem = { itemName, price }
      if (supplyNoteRaw) {
        item.supplyNote = supplyNoteRaw
      }
      items.push(item)
    }

    const changes: Record<string, AlmaRefreshRowChange> = {}
    if (o.almaRefreshChanges && typeof o.almaRefreshChanges === 'object') {
      for (const [id, ch] of Object.entries(o.almaRefreshChanges)) {
        if (id && isAlmaRefreshRowChange(ch)) {
          changes[id] = ch
        }
      }
    }
    const unchanged: Record<string, true> = {}
    if (o.almaRefreshUnchangedIds && typeof o.almaRefreshUnchangedIds === 'object') {
      for (const id of Object.keys(o.almaRefreshUnchangedIds)) {
        if (id) {
          unchanged[id] = true
        }
      }
    }

    return {
      version: 1,
      completedAt: o.completedAt,
      cooldownMs:
        typeof o.cooldownMs === 'number' && o.cooldownMs > 0 ? o.cooldownMs : ALMA_PRICE_REFRESH_COOLDOWN_MS,
      almaFetchedAt: typeof o.almaFetchedAt === 'string' ? o.almaFetchedAt : '',
      almaItems: items,
      almaRefreshChanges: changes,
      almaRefreshUnchangedIds: unchanged,
      almaRefreshGlobalSameHint: Boolean(o.almaRefreshGlobalSameHint),
    }
  } catch {
    return null
  }
}

const writeAlmaRefreshCache = (payload: {
  completedAt: number
  cooldownMs?: number
  almaFetchedAt: string
  almaItems: AlmaPriceItem[]
  almaRefreshChanges: Record<string, AlmaRefreshRowChange>
  almaRefreshUnchangedIds: Record<string, true>
  almaRefreshGlobalSameHint: boolean
}) => {
  if (typeof window === 'undefined') {
    return
  }
  try {
    const body: AlmaRefreshCacheV1 = {
      version: 1,
      completedAt: payload.completedAt,
      cooldownMs: payload.cooldownMs ?? ALMA_PRICE_REFRESH_COOLDOWN_MS,
      almaFetchedAt: payload.almaFetchedAt,
      almaItems: payload.almaItems,
      almaRefreshChanges: payload.almaRefreshChanges,
      almaRefreshUnchangedIds: payload.almaRefreshUnchangedIds,
      almaRefreshGlobalSameHint: payload.almaRefreshGlobalSameHint,
    }
    window.localStorage.setItem(GREEN_BEAN_ALMA_REFRESH_CACHE_KEY, JSON.stringify(body))
  } catch {
    /* quota 등 */
  }
}

export type GreenBeanOrderPersisted = {
  title: string
  supplierLabels: string[]
  rows: GreenBeanOrderRow[]
  baseline: GreenBeanOrderBaseline | null
  orderSnapshots: GreenBeanOrderDatedSnapshot[]
  /** 현재 표 기준 쿠폰·감면(원). 일자 기록 시 스냅샷에도 함께 저장됩니다. */
  orderDeductions: GreenBeanOrderDeductions
}

/** 월 마감 회의 등 다른 화면이 생두 주문 저장 후 갱신할 때 구독 */
export const GREEN_BEAN_ORDER_SAVED_EVENT = 'green-bean-order-saved'

const defaultPersisted = (): GreenBeanOrderPersisted => ({
  title: '■ 생두 주문',
  supplierLabels: ['GSC', '알마씨엘로'],
  rows: [
    {
      id: crypto.randomUUID(),
      itemName: '',
      supplierPrices: ['', ''],
      quantityKg: 0,
      priceSource: 'auto',
      lineTotal: 0,
    },
  ],
  baseline: null,
  orderSnapshots: [],
  orderDeductions: { almaWon: 0, gscWon: 0, otherWon: 0 },
})

const normalizeItemKey = (value: string) =>
  value.trim().toLowerCase().replace(/\s+/g, ' ')

type GreenBeanInventoryStockMatch = {
  endingStock: number
  inventoryItemName: string
  inventoryLinkKey: string
}

type ReadInventoryStockLinkResult = {
  byItemKey: Map<string, GreenBeanInventoryStockMatch>
  byInventoryLinkKey: Map<string, GreenBeanInventoryStockMatch>
  referenceDateLabel: string | null
  loadError: boolean
  hasStoredPayload: boolean
  /** 입출고 beanRows 개수(별칭으로 늘어난 맵 키 수와 구분) */
  inventoryBeanRowCount: number
}

function attachAliasStockKeys(
  map: Map<string, GreenBeanInventoryStockMatch>,
  normalizeKey: (value: string) => string,
  aliases: ReadonlyArray<readonly [string, string]>,
) {
  for (const [orderLabel, inventoryName] of aliases) {
    const orderK = normalizeKey(orderLabel)
    const invK = normalizeKey(inventoryName)
    if (!orderK || !invK) {
      continue
    }
    if (map.has(orderK)) {
      continue
    }
    const hit = map.get(invK)
    if (hit) {
      map.set(orderK, hit)
    }
  }
}

function readInventoryStockFromStorage(
  normalizeKey: (value: string) => string,
  aliases: ReadonlyArray<readonly [string, string]>,
): ReadInventoryStockLinkResult {
  const empty = (): ReadInventoryStockLinkResult => ({
    byItemKey: new Map(),
    byInventoryLinkKey: new Map(),
    referenceDateLabel: null,
    loadError: false,
    hasStoredPayload: false,
    inventoryBeanRowCount: 0,
  })
  try {
    const raw = window.localStorage.getItem(INVENTORY_STATUS_STORAGE_KEY)
    if (!raw) {
      return empty()
    }
    const parsed = normalizeInventoryStatusState(JSON.parse(raw))
    if (!parsed) {
      return { ...empty(), hasStoredPayload: true, loadError: true }
    }
    const inventoryBeanRowCount = parsed.beanRows.length
    const dayIdx = dayIndexForReferenceDate(parsed.days, parsed.referenceDate)
    const map = new Map<string, GreenBeanInventoryStockMatch>()
    const byInventoryLinkKey = new Map<string, GreenBeanInventoryStockMatch>()
    for (const bean of parsed.beanRows) {
      const k = normalizeKey(bean.name)
      if (!k) {
        continue
      }
      const stockLen = bean.stock.length
      const cappedIdx = stockLen <= 0 ? 0 : Math.min(Math.max(dayIdx, 0), stockLen - 1)
      const rawStock = bean.stock[cappedIdx]
      const endingStock =
        typeof rawStock === 'number' && Number.isFinite(rawStock) ? Math.round(rawStock * 1000) / 1000 : 0
      const inventoryLinkKey = `inventory-bean-no:${String(bean.no)}`
      const match = { endingStock, inventoryItemName: bean.name, inventoryLinkKey }
      map.set(k, match)
      byInventoryLinkKey.set(inventoryLinkKey, match)
    }
    attachAliasStockKeys(map, normalizeKey, aliases)
    const ref =
      typeof parsed.referenceDate === 'string' && parsed.referenceDate.trim().length >= 10
        ? parsed.referenceDate.trim().slice(0, 10)
        : null
    return {
      byItemKey: map,
      byInventoryLinkKey,
      referenceDateLabel: ref,
      loadError: false,
      hasStoredPayload: true,
      inventoryBeanRowCount,
    }
  } catch {
    return { ...empty(), hasStoredPayload: true, loadError: true }
  }
}

function formatHintKg(n: number) {
  const rounded = Math.round(n * 100) / 100
  return rounded.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const normalizeCompareName = (value: string) =>
  value
    .replace(/\[[^\]]*]/g, ' ')
    .replace(/※.*$/g, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

const MATCH_STOPWORDS = new Set([
  '원두',
  '생두',
  'special',
  '스페셜',
  '스페셜티',
  'g1',
  'g2',
  'shb',
  'aa',
  'fc',
  'ny2',
  '수프리모',
  '내추럴',
  '워시드',
  '허니',
])

const tokenizeCompareName = (value: string) =>
  normalizeCompareName(value)
    .split(/[\s,/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !MATCH_STOPWORDS.has(t))

/** 주문 품목 토큰이 알마 품명 토큰과 맞는 개수 (부분 일치 포함) */
const countMatchingTokens = (left: string, right: string) => {
  const a = tokenizeCompareName(left)
  const b = tokenizeCompareName(right)
  if (a.length === 0 || b.length === 0) {
    return 0
  }
  let hit = 0
  for (const t of a) {
    if (b.some((u) => u.includes(t) || t.includes(u))) {
      hit += 1
    }
  }
  return hit
}

const pickBestInventoryMatch = (
  rawName: string,
  inventoryByName: Map<string, GreenBeanInventoryStockMatch>,
): GreenBeanInventoryStockMatch | null => {
  const key = normalizeItemKey(rawName)
  if (!key) {
    return null
  }
  const exact = inventoryByName.get(key)
  if (exact) {
    return exact
  }

  const tokens = tokenizeCompareName(rawName)
  if (tokens.length === 0) {
    return null
  }
  const minRequired = Math.min(2, tokens.length)
  let best: GreenBeanInventoryStockMatch | null = null
  let bestHits = -1
  for (const hit of inventoryByName.values()) {
    const hits = countMatchingTokens(rawName, hit.inventoryItemName)
    if (hits < minRequired) {
      continue
    }
    if (hits > bestHits) {
      best = hit
      bestHits = hits
    }
  }
  return best
}

/** 느슨 매칭 시 주문 품목 쪽에서 요구하는 최소 ‘맞는 토큰’ 개수 상한 (실제 요구치는 min(3, 주문 토큰 수)) */
const MIN_ALMA_TOKEN_OVERLAP = 3

function buildAlmaPriceByNameMap(items: AlmaPriceItem[]): Map<string, AlmaPriceItem> {
  const map = new Map<string, AlmaPriceItem>()
  for (const item of items) {
    const key = normalizeCompareName(item.itemName)
    if (!key || map.has(key)) {
      continue
    }
    map.set(key, item)
  }
  return map
}

/**
 * 알마 JSON 품목과 주문표 품목명 매칭
 *
 * 1. `normalizeCompareName` 한 뒤 문자열이 JSON 어떤 항목과든 같으면 그 항목으로 확정
 * 2. 아니면 주문표 품목명 ↔ 각 JSON `itemName`에 대해 토큰 겹침 수(`countMatchingTokens`) 계산
 * 3. 겹침이 `min(3, 주문 토큰 개수)` 미만이면 후보 아님 (주문 토큰이 1~2개뿐이면 그만큼 전부 맞아야 함)
 * 4. 후보 중 겹침 수가 최대인 JSON 품목 하나 선택. 동점이면 먼저 나온 항목 유지
 */
function findMatchedAlmaForRow(
  row: GreenBeanOrderRow,
  items: AlmaPriceItem[],
  almaPriceByName: Map<string, AlmaPriceItem>,
): AlmaPriceItem | null {
  const itemKey = normalizeCompareName(row.itemName)
  if (!itemKey) {
    return null
  }
  const exact = almaPriceByName.get(itemKey)
  if (exact) {
    return exact
  }

  const rowTokens = tokenizeCompareName(row.itemName)
  if (rowTokens.length === 0) {
    return null
  }
  const minRequired = Math.min(MIN_ALMA_TOKEN_OVERLAP, rowTokens.length)

  let best: AlmaPriceItem | null = null
  let bestHits = -1
  for (const item of items) {
    const hits = countMatchingTokens(row.itemName, item.itemName)
    if (hits < minRequired) {
      continue
    }
    if (hits > bestHits) {
      best = item
      bestHits = hits
    }
  }
  return best
}

const normalizePriceSource = (value: unknown, supplierCount: number): GreenBeanPriceSource => {
  if (value === 'auto') {
    return 'auto'
  }
  const n = Number(value)
  if (Number.isInteger(n) && n >= 0 && n < supplierCount) {
    return n
  }
  return 'auto'
}

const parseNumber = (value: unknown) => {
  const normalized = String(value ?? '')
    .replaceAll(',', '')
    .replace(/원/g, '')
    .trim()
  if (!normalized) {
    return 0
  }
  const n = Number(normalized)
  return Number.isFinite(n) ? n : 0
}

/** 자동 모드에서 비교할 유효 단가(원/kg, 0 초과). 없으면 null */
const unitPriceForAutoPick = (v: PriceCell): number | null => {
  if (v === '' || v === undefined) {
    return null
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 0 ? v : null
  }
  const s = String(v).trim()
  if (!s || /품절/i.test(s) || /^x$/i.test(s)) {
    return null
  }
  const n = parseNumber(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 자동: 가장 낮은 단가 열. 동일하면 더 왼쪽(인덱스 작은) 열 */
const pickLowestUnitPriceIndex = (prices: PriceCell[]): number => {
  let bestIdx = -1
  let bestVal = Infinity
  for (let i = 0; i < prices.length; i++) {
    const u = unitPriceForAutoPick(prices[i])
    if (u !== null && u < bestVal) {
      bestVal = u
      bestIdx = i
    }
  }
  return bestIdx
}

const resolveUnitPriceIndex = (prices: PriceCell[], priceSource: GreenBeanPriceSource): number => {
  if (priceSource === 'auto') {
    return pickLowestUnitPriceIndex(prices)
  }
  return priceSource >= 0 && priceSource < prices.length ? priceSource : -1
}

const computeLineTotal = (prices: PriceCell[], quantityKg: number, priceSource: GreenBeanPriceSource): number => {
  const idx = resolveUnitPriceIndex(prices, priceSource)
  if (idx < 0) {
    return 0
  }
  const picked = prices[idx]
  const unit = typeof picked === 'number' ? picked : parseNumber(picked)
  if (!Number.isFinite(unit) || unit <= 0 || !Number.isFinite(quantityKg) || quantityKg <= 0) {
    return 0
  }
  return Math.round(unit * quantityKg)
}

const applyLineTotal = (row: GreenBeanOrderRow): GreenBeanOrderRow => {
  const source = row.priceSource ?? 'auto'
  return {
    ...row,
    priceSource: source,
    lineTotal: computeLineTotal(row.supplierPrices, row.quantityKg, source),
  }
}

const defaultOrderDeductions = (): GreenBeanOrderDeductions => ({
  almaWon: 0,
  gscWon: 0,
  otherWon: 0,
})

const parseOrderDeductions = (raw: unknown): GreenBeanOrderDeductions => {
  if (!raw || typeof raw !== 'object') {
    return defaultOrderDeductions()
  }
  const o = raw as Record<string, unknown>
  return {
    almaWon: Math.max(0, parseNumber(o.almaWon)),
    gscWon: Math.max(0, parseNumber(o.gscWon)),
    otherWon: Math.max(0, parseNumber(o.otherWon)),
  }
}

const netMoneyFromGrossAndDeductions = (gross: number, d: GreenBeanOrderDeductions): number => {
  const cut =
    Math.max(0, d.almaWon) + Math.max(0, d.gscWon) + Math.max(0, d.otherWon)
  const g = Number.isFinite(gross) ? gross : 0
  return Math.max(0, Math.round(g - cut))
}

const normalizeText = (value: unknown) => String(value ?? '').trim()

const parsePriceCell = (value: unknown): PriceCell => {
  if (value === null || value === undefined || value === '') {
    return ''
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  const s = String(value).trim()
  if (!s) {
    return ''
  }
  if (/품절/.test(s)) {
    return '품절'
  }
  if (/^x$/i.test(s)) {
    return 'X'
  }
  const n = Number(s.replaceAll(',', ''))
  if (Number.isFinite(n)) {
    return n
  }
  return s
}

const formatMoney = (value: number) => `${currencyFormatter.format(Math.round(value))}원`
const formatKg = (value: number) => `${currencyFormatter.format(value)} kg`

/** 단가 기준 버튼용 짧은 라벨 (GSC→G, 알마씨엘로 등→알) */
function formatSupplierSourceButtonLabel(label: string, columnIndex: number): string {
  const t = label.trim()
  if (!t) {
    return `${columnIndex + 1}`
  }
  if (/^gsc$/i.test(t)) {
    return 'G'
  }
  if (/알마/.test(t)) {
    return '알'
  }
  if (t.length <= 2) {
    return t
  }
  return t.slice(0, 2)
}

const formatDelta = (delta: number, suffix: string) => {
  if (delta === 0) {
    return '변동 없음'
  }
  const sign = delta > 0 ? '+' : ''
  return `${sign}${currencyFormatter.format(Math.abs(delta))}${suffix}`
}

const summarizeAlmaRefreshChange = (c: AlmaRefreshRowChange): { line: string; title: string; tone: 'up' | 'down' | 'neutral' } => {
  const priceChanged = c.prevPrice !== c.nextPrice
  const noteChanged = c.prevNote !== c.nextNote
  const titleLines: string[] = []
  if (priceChanged) {
    titleLines.push(
      `단가: ${c.prevPrice == null ? '—' : formatMoney(c.prevPrice)} → ${c.nextPrice == null ? '—' : formatMoney(c.nextPrice)}`,
    )
  }
  if (noteChanged) {
    titleLines.push(`수급 안내: ${c.prevNote || '(없음)'} → ${c.nextNote || '(없음)'}`)
  }
  let line = ''
  let tone: 'up' | 'down' | 'neutral' = 'neutral'
  if (priceChanged && c.prevPrice != null && c.nextPrice != null) {
    const d = c.nextPrice - c.prevPrice
    line = formatDelta(d, '원')
    tone = d > 0 ? 'up' : d < 0 ? 'down' : 'neutral'
  } else if (priceChanged && c.prevPrice == null && c.nextPrice != null) {
    line = '단가 새로 넣음'
    tone = 'neutral'
  } else if (priceChanged && c.prevPrice != null && c.nextPrice == null) {
    line = '단가 비움'
    tone = 'neutral'
  } else if (noteChanged) {
    line = '수급 안내 변경'
    tone = 'neutral'
  }
  return { line, title: titleLines.join('\n'), tone }
}

const formatSignedNumber = (delta: number, suffix: string) => {
  if (delta === 0) {
    return `0${suffix}`
  }
  const sign = delta > 0 ? '+' : '-'
  return `${sign}${currencyFormatter.format(Math.abs(delta))}${suffix}`
}

const formatMonthLabel = (monthKey: string) => {
  const [y, m] = monthKey.split('-')
  if (!y || !m) {
    return monthKey
  }
  return `${y}년 ${Number(m)}월`
}

const formatOrderDateLabel = (orderDate: string) => {
  const [y, mo, d] = orderDate.split('-')
  if (!y || !mo || !d) {
    return orderDate
  }
  return `${y}.${String(mo).padStart(2, '0')}.${String(d).padStart(2, '0')}`
}

const monthKeyFromOrderDate = (orderDate: string) => orderDate.slice(0, 7)

/** 같은 달에 여러 번 저장하면 수량·총액·품목별 값을 합산해 월별 점으로 만듭니다. */
export function aggregateOrderSnapshotsToMonthlyPoints(
  snapshots: GreenBeanOrderDatedSnapshot[],
): GreenBeanMonthlyPoint[] {
  const byMonth = new Map<string, GreenBeanOrderDatedSnapshot[]>()
  for (const s of snapshots) {
    const mk = monthKeyFromOrderDate(s.orderDate)
    if (!/^\d{4}-\d{2}$/.test(mk)) {
      continue
    }
    const arr = byMonth.get(mk) ?? []
    arr.push(s)
    byMonth.set(mk, arr)
  }
  const result: GreenBeanMonthlyPoint[] = []
  for (const [monthKey, list] of byMonth) {
    list.sort((a, b) => a.orderDate.localeCompare(b.orderDate) || a.savedAt.localeCompare(b.savedAt))
    const sumQty = list.reduce((acc, x) => acc + x.sumQty, 0)
    const sumMoney = list.reduce((acc, x) => acc + x.sumMoney, 0)
    const itemMap = new Map<string, GreenBeanMonthlyItemSnapshot>()
    for (const snap of list) {
      for (const it of snap.items ?? []) {
        const key = normalizeItemKey(it.itemName)
        if (!key) {
          continue
        }
        const prev = itemMap.get(key)
        if (prev) {
          itemMap.set(key, {
            itemName: prev.itemName,
            quantityKg: prev.quantityKg + it.quantityKg,
            lineTotal: prev.lineTotal + it.lineTotal,
          })
        } else {
          itemMap.set(key, {
            itemName: it.itemName.trim(),
            quantityKg: it.quantityKg,
            lineTotal: it.lineTotal,
          })
        }
      }
    }
    const items = [...itemMap.values()].filter((x) => x.itemName.trim())
    const savedAt = [...list.map((x) => x.savedAt)].sort().at(-1) ?? ''
    result.push({
      id: `agg-month-${monthKey}`,
      monthKey,
      savedAt,
      sumQty,
      sumMoney,
      itemCount: items.length,
      items: items.length > 0 ? items : undefined,
    })
  }
  return result.sort((a, b) => a.monthKey.localeCompare(b.monthKey))
}

function snapshotGrossMoney(row: GreenBeanOrderDatedSnapshot): number {
  if (row.sumMoneyGross != null && Number.isFinite(row.sumMoneyGross) && row.sumMoneyGross >= 0) {
    return row.sumMoneyGross
  }
  return row.sumMoney
}

function snapshotDeductionSummary(row: GreenBeanOrderDatedSnapshot): string {
  const d = row.deductions
  if (!d || (d.almaWon <= 0 && d.gscWon <= 0 && d.otherWon <= 0)) {
    return '—'
  }
  const bits: string[] = []
  if (d.almaWon > 0) {
    bits.push(`알마 ${currencyFormatter.format(d.almaWon)}`)
  }
  if (d.gscWon > 0) {
    bits.push(`GSC ${currencyFormatter.format(d.gscWon)}`)
  }
  if (d.otherWon > 0) {
    bits.push(`기타 ${currencyFormatter.format(d.otherWon)}`)
  }
  return bits.join(' · ')
}

/** 표 제목에서 연·월을 추정 (예: 26.04월, 4월, 2026년 4월) */
function guessMonthKeyFromTitle(title: string): string | null {
  const yearNow = new Date().getFullYear()
  const a = title.match(/(\d{4})\s*년\s*(\d{1,2})\s*월/)
  if (a) {
    const y = parseInt(a[1], 10)
    const m = parseInt(a[2], 10)
    if (m >= 1 && m <= 12) {
      return `${y}-${String(m).padStart(2, '0')}`
    }
  }
  const b = title.match(/(\d{1,2})\s*년\s*(\d{1,2})\s*월/)
  if (b) {
    let y = parseInt(b[1], 10)
    if (y < 100) {
      y += 2000
    }
    const m = parseInt(b[2], 10)
    if (m >= 1 && m <= 12) {
      return `${y}-${String(m).padStart(2, '0')}`
    }
  }
  const c = title.match(/(\d{2})\.(\d{2})\s*월/)
  if (c) {
    let y = parseInt(c[1], 10)
    if (y < 100) {
      y += 2000
    }
    const m = parseInt(c[2], 10)
    if (m >= 1 && m <= 12) {
      return `${y}-${String(m).padStart(2, '0')}`
    }
  }
  const d = title.match(/(\d{1,2})\s*월/)
  if (d) {
    const m = parseInt(d[1], 10)
    if (m >= 1 && m <= 12) {
      return `${yearNow}-${String(m).padStart(2, '0')}`
    }
  }
  return null
}

const formatAxisMoney = (value: number) => {
  const v = Math.round(value)
  if (v >= 100000000) {
    return `${(v / 100000000).toFixed(1)}억`
  }
  if (v >= 10000) {
    return `${Math.round(v / 10000)}만`
  }
  return currencyFormatter.format(v)
}

/** 원두별 다중 선 그래프 — 품목마다 다른 색 */
const GREEN_BEAN_SERIES_COLORS = [
  '#7c3aed',
  '#2563eb',
  '#0d9488',
  '#c026d3',
  '#ea580c',
  '#ca8a04',
  '#db2777',
  '#4f46e5',
  '#059669',
  '#b45309',
  '#0e7490',
  '#be123c',
]

function parseMatrixFromFile(buffer: ArrayBuffer): unknown[][] {
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: true,
  }) as unknown[][]
  return matrix
}

function parseGreenBeanOrderFromMatrix(matrix: unknown[][]): GreenBeanOrderPersisted | null {
  let headerRowIndex = -1
  let qtyIndex = -1
  let totalIndex = -1
  let supplierLabels: string[] = []

  for (let r = 0; r < matrix.length; r++) {
    const row = matrix[r] ?? []
    const c0 = normalizeText(row[0])
    if (c0 !== '구분') {
      continue
    }

    const labels = row.map((cell) => normalizeText(cell))
    qtyIndex = labels.findIndex(
      (h, i) =>
        i > 0 &&
        (h.includes('수량') || h === '수량(KG)' || h.toLowerCase() === 'kg' || h === 'KG'),
    )
    totalIndex = labels.findIndex((h, i) => i > 0 && (h.includes('총계') || h.includes('합계')))

    if (qtyIndex >= 2 && totalIndex > qtyIndex) {
      supplierLabels = labels.slice(1, qtyIndex)
      headerRowIndex = r
      break
    }
  }

  if (headerRowIndex < 0 || supplierLabels.length === 0) {
    return null
  }

  let title = '■ 생두 주문'
  for (let r = 0; r < headerRowIndex; r++) {
    const cell = normalizeText(matrix[r]?.[0] as unknown)
    if (cell && (cell.includes('생두') || cell.includes('주문'))) {
      title = cell
      break
    }
  }

  const rows: GreenBeanOrderRow[] = []
  for (let r = headerRowIndex + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? []
    const name = normalizeText(row[0] as unknown)
    if (!name) {
      continue
    }
    if (name === '총합' || name === '합계' || name === '총계') {
      break
    }

    const supplierPrices = supplierLabels.map((_, i) => parsePriceCell(row[1 + i] as unknown))
    const quantityKg = parseNumber(row[qtyIndex] as unknown)
    const lineTotal = parseNumber(row[totalIndex] as unknown)

    rows.push(applyLineTotal({
      id: crypto.randomUUID(),
      itemName: name,
      supplierPrices,
      quantityKg,
      priceSource: 'auto',
      lineTotal,
    }))
  }

  if (rows.length === 0) {
    return null
  }

  let orderDeductions = defaultOrderDeductions()
  for (let r = headerRowIndex + 1; r < matrix.length; r++) {
    const row = matrix[r] ?? []
    const label = normalizeText(row[0] as unknown)
    if (!label) {
      continue
    }
    const amount = Math.max(0, parseNumber(row[totalIndex] as unknown))
    if (label.includes('알마씨엘로') && label.includes('차감')) {
      orderDeductions = { ...orderDeductions, almaWon: amount }
    } else if (label.includes('GSC') && label.includes('차감')) {
      orderDeductions = { ...orderDeductions, gscWon: amount }
    } else if (label.includes('기타 감면')) {
      orderDeductions = { ...orderDeductions, otherWon: amount }
    }
  }

  return {
    title,
    supplierLabels,
    rows,
    baseline: null,
    orderSnapshots: [],
    orderDeductions,
  }
}

function normalizePersisted(raw: unknown): GreenBeanOrderPersisted {
  const base = defaultPersisted()
  if (!raw || typeof raw !== 'object') {
    return base
  }
  const o = raw as Record<string, unknown>
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : base.title
  const supplierLabels = Array.isArray(o.supplierLabels)
    ? o.supplierLabels.map((x) => String(x ?? '').trim()).filter(Boolean)
    : base.supplierLabels
  const labels = supplierLabels.length > 0 ? supplierLabels : base.supplierLabels

  const rowsIn = Array.isArray(o.rows) ? o.rows : []
  const rows: GreenBeanOrderRow[] = rowsIn.map((item) => {
    const row = item as Record<string, unknown>
    const supplierPricesRaw = Array.isArray(row.supplierPrices) ? row.supplierPrices : []
    const supplierPrices = labels.map((_, i) =>
      i < supplierPricesRaw.length ? parsePriceCell(supplierPricesRaw[i]) : '',
    )
    const priceSource = normalizePriceSource(row.priceSource, labels.length)
    return applyLineTotal({
      id: typeof row.id === 'string' && row.id ? row.id : crypto.randomUUID(),
      itemName: String(row.itemName ?? ''),
      inventoryLinkKey:
        typeof row.inventoryLinkKey === 'string' && row.inventoryLinkKey.trim()
          ? row.inventoryLinkKey.trim()
          : undefined,
      supplierPrices,
      quantityKg: parseNumber(row.quantityKg),
      priceSource,
      lineTotal: parseNumber(row.lineTotal),
      almaSupplyNote:
        typeof row.almaSupplyNote === 'string' && row.almaSupplyNote.trim()
          ? row.almaSupplyNote.trim()
          : undefined,
    })
  })

  let baseline: GreenBeanOrderBaseline | null = null
  if (o.baseline && typeof o.baseline === 'object') {
    const b = o.baseline as Record<string, unknown>
    const bRowsIn = Array.isArray(b.rows) ? b.rows : []
    const bLabels = Array.isArray(b.supplierLabels)
      ? b.supplierLabels.map((x) => String(x ?? '').trim()).filter(Boolean)
      : labels
    const bRows: GreenBeanOrderRow[] = bRowsIn.map((item) => {
      const row = item as Record<string, unknown>
      const supplierPricesRaw = Array.isArray(row.supplierPrices) ? row.supplierPrices : []
      const supplierPrices = bLabels.map((_, i) =>
        i < supplierPricesRaw.length ? parsePriceCell(supplierPricesRaw[i]) : '',
      )
      const priceSource = normalizePriceSource(row.priceSource, bLabels.length)
      return applyLineTotal({
        id: typeof row.id === 'string' && row.id ? row.id : crypto.randomUUID(),
        itemName: String(row.itemName ?? ''),
        inventoryLinkKey:
          typeof row.inventoryLinkKey === 'string' && row.inventoryLinkKey.trim()
            ? row.inventoryLinkKey.trim()
            : undefined,
        supplierPrices,
        quantityKg: parseNumber(row.quantityKg),
        priceSource,
        lineTotal: parseNumber(row.lineTotal),
        almaSupplyNote:
          typeof row.almaSupplyNote === 'string' && row.almaSupplyNote.trim()
            ? row.almaSupplyNote.trim()
            : undefined,
      })
    })
    baseline = {
      savedAt: typeof b.savedAt === 'string' ? b.savedAt : new Date().toISOString(),
      title: typeof b.title === 'string' ? b.title : title,
      supplierLabels: bLabels.length > 0 ? bLabels : labels,
      rows: bRows,
    }
  }

  const parseSnapshotItems = (itemsRaw: unknown): GreenBeanMonthlyItemSnapshot[] | undefined => {
    if (!Array.isArray(itemsRaw)) {
      return undefined
    }
    const parsed = itemsRaw
      .map((raw) => {
        if (!raw || typeof raw !== 'object') {
          return null
        }
        const it = raw as Record<string, unknown>
        const itemName = typeof it.itemName === 'string' ? it.itemName.trim() : ''
        if (!itemName) {
          return null
        }
        return {
          itemName,
          quantityKg: parseNumber(it.quantityKg),
          lineTotal: parseNumber(it.lineTotal),
        }
      })
      .filter((x): x is GreenBeanMonthlyItemSnapshot => x !== null)
    return parsed.length > 0 ? parsed : undefined
  }

  const orderSnapshotsRaw = Array.isArray(o.orderSnapshots) ? o.orderSnapshots : []
  let orderSnapshots: GreenBeanOrderDatedSnapshot[] = orderSnapshotsRaw
    .map((item): GreenBeanOrderDatedSnapshot | null => {
      if (!item || typeof item !== 'object') {
        return null
      }
      const row = item as Record<string, unknown>
      const orderDate = typeof row.orderDate === 'string' ? row.orderDate.trim() : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
        return null
      }
      const items = parseSnapshotItems(row.items)
      const snap: GreenBeanOrderDatedSnapshot = {
        id: typeof row.id === 'string' && row.id ? row.id : crypto.randomUUID(),
        orderDate,
        savedAt: typeof row.savedAt === 'string' ? row.savedAt : new Date().toISOString(),
        sumQty: parseNumber(row.sumQty),
        sumMoney: parseNumber(row.sumMoney),
        itemCount: Math.max(0, Math.round(parseNumber(row.itemCount))),
      }
      const grossRaw = row.sumMoneyGross
      if (grossRaw !== undefined && grossRaw !== null && String(grossRaw).trim() !== '') {
        const g = parseNumber(grossRaw)
        if (Number.isFinite(g) && g >= 0) {
          snap.sumMoneyGross = g
        }
      }
      if (row.deductions && typeof row.deductions === 'object') {
        const d = parseOrderDeductions(row.deductions)
        if (d.almaWon > 0 || d.gscWon > 0 || d.otherWon > 0) {
          snap.deductions = d
        }
      }
      if (items && items.length > 0) {
        snap.items = items
      }
      const memoRaw = row.memo
      if (typeof memoRaw === 'string' && memoRaw.trim()) {
        snap.memo = memoRaw.trim().slice(0, 500)
      }
      return snap
    })
    .filter((x): x is GreenBeanOrderDatedSnapshot => x !== null)

  const monthlyHistoryRaw = Array.isArray(o.monthlyHistory) ? o.monthlyHistory : []
  if (orderSnapshots.length === 0 && monthlyHistoryRaw.length > 0) {
    orderSnapshots = monthlyHistoryRaw
      .map((item): GreenBeanOrderDatedSnapshot | null => {
        if (!item || typeof item !== 'object') {
          return null
        }
        const row = item as Record<string, unknown>
        const monthKey = typeof row.monthKey === 'string' ? row.monthKey.trim() : ''
        if (!/^\d{4}-\d{2}$/.test(monthKey)) {
          return null
        }
        const items = parseSnapshotItems(row.items)
        const snap: GreenBeanOrderDatedSnapshot = {
          id: typeof row.id === 'string' && row.id ? row.id : crypto.randomUUID(),
          orderDate: `${monthKey}-01`,
          savedAt: typeof row.savedAt === 'string' ? row.savedAt : new Date().toISOString(),
          sumQty: parseNumber(row.sumQty),
          sumMoney: parseNumber(row.sumMoney),
          itemCount: Math.max(0, Math.round(parseNumber(row.itemCount))),
        }
        if (items && items.length > 0) {
          snap.items = items
        }
        return snap
      })
      .filter((x): x is GreenBeanOrderDatedSnapshot => x !== null)
  }

  return {
    title,
    supplierLabels: labels,
    rows: rows.length > 0 ? rows : base.rows,
    baseline,
    orderSnapshots,
    orderDeductions: parseOrderDeductions(o.orderDeductions),
  }
}

/** 월 마감 회의 등 — 저장된 생두 주문 JSON을 읽어 정규화 */
export function readGreenBeanOrderPersistedFromStorage(): GreenBeanOrderPersisted {
  if (typeof window === 'undefined') {
    return defaultPersisted()
  }
  try {
    const raw = window.localStorage.getItem(GREEN_BEAN_ORDER_STORAGE_KEY)
    if (!raw) {
      return defaultPersisted()
    }
    return normalizePersisted(JSON.parse(raw))
  } catch {
    return defaultPersisted()
  }
}

function writeGreenBeanOrderPersistedToStorage(persisted: GreenBeanOrderPersisted) {
  try {
    window.localStorage.setItem(GREEN_BEAN_ORDER_STORAGE_KEY, JSON.stringify(persisted))
    window.dispatchEvent(new Event(GREEN_BEAN_ORDER_SAVED_EVENT))
  } catch {
    // ignore
  }
}

/** `YYYY-MM`에 일자 기록이 있으면 차감 반영 후 월 합계(원). 없으면 `hasMonth: false`. */
export function getGreenBeanOrderMonthAggregate(ym: string): {
  hasMonth: boolean
  sumMoney: number
  snapshotCount: number
} | null {
  const key = ym.trim()
  if (!/^\d{4}-\d{2}$/.test(key)) {
    return null
  }
  const persisted = readGreenBeanOrderPersistedFromStorage()
  const points = aggregateOrderSnapshotsToMonthlyPoints(persisted.orderSnapshots)
  const hit = points.find((p) => p.monthKey === key)
  if (!hit) {
    return { hasMonth: false, sumMoney: 0, snapshotCount: 0 }
  }
  const snapshotCount = persisted.orderSnapshots.filter((s) => s.orderDate.slice(0, 7) === key).length
  return { hasMonth: true, sumMoney: hit.sumMoney, snapshotCount }
}

/** 총계 산출에 쓰인 공급처 단가 셀(엑셀에서 강조) */
export type GreenBeanExportLineBasisKind = 'gsc' | 'alma'

export type GreenBeanExportLineBasisHighlight = { col: number; kind: GreenBeanExportLineBasisKind }

function buildGreenBeanOrderExportMatrix(state: GreenBeanOrderPersisted): {
  matrix: (string | number)[][]
  lineBasisHighlightByRow: (GreenBeanExportLineBasisHighlight | null)[]
} {
  const { title, supplierLabels, rows, orderDeductions } = state
  const qtyHeader = 'kg'
  const totalHeader = '총계'
  const headerRow = ['구분', ...supplierLabels, qtyHeader, totalHeader]

  const priceLabelRow = ['생두(1kg)', '가격', ...Array(Math.max(0, supplierLabels.length - 1)).fill(''), '주문', '']

  const aoa: (string | number)[][] = [
    [title, ...Array(headerRow.length - 1).fill('')],
    priceLabelRow.slice(0, headerRow.length),
    headerRow,
    ...rows.map((row) => {
      const prices = supplierLabels.map((_, i) => {
        const v = row.supplierPrices[i]
        if (v === '' || v === undefined) {
          return ''
        }
        return typeof v === 'number' ? v : v
      })
      return [row.itemName, ...prices, row.quantityKg, row.lineTotal]
    }),
  ]

  const sumQty = rows.reduce((s, r) => s + r.quantityKg, 0)
  const sumGross = rows.reduce((s, r) => s + r.lineTotal, 0)
  aoa.push([
    '총합',
    ...Array(supplierLabels.length).fill(''),
    sumQty,
    sumGross,
  ])

  const d = parseOrderDeductions(orderDeductions)
  const net = netMoneyFromGrossAndDeductions(sumGross, d)
  const emptyMid = Array(supplierLabels.length).fill('')
  if (d.almaWon > 0) {
    aoa.push(['알마씨엘로 차감(쿠폰·감면)', ...emptyMid, '', d.almaWon])
  }
  if (d.gscWon > 0) {
    aoa.push(['GSC 차감(쿠폰·감면)', ...emptyMid, '', d.gscWon])
  }
  if (d.otherWon > 0) {
    aoa.push(['기타 감면', ...emptyMid, '', d.otherWon])
  }
  if (d.almaWon > 0 || d.gscWon > 0 || d.otherWon > 0) {
    aoa.push(['반영 총액', ...emptyMid, '', net])
  }

  const lineBasisHighlightByRow: (GreenBeanExportLineBasisHighlight | null)[] = aoa.map(() => null)
  const dataFirstRow = 3
  for (let i = 0; i < rows.length; i += 1) {
    const priceIdx = resolveUnitPriceIndex(rows[i].supplierPrices, rows[i].priceSource ?? 'auto')
    if (priceIdx < 0) {
      continue
    }
    const label = supplierLabels[priceIdx] ?? ''
    const col = 1 + priceIdx
    if (/알마/i.test(label)) {
      lineBasisHighlightByRow[dataFirstRow + i] = { col, kind: 'alma' }
    } else if (/gsc/i.test(label)) {
      lineBasisHighlightByRow[dataFirstRow + i] = { col, kind: 'gsc' }
    }
  }

  return { matrix: aoa, lineBasisHighlightByRow }
}

export default function GreenBeanOrderPage() {
  const { mode, activeCompanyId, user, cloudDocRefreshTick } = useAppRuntime()
  const [persisted, setPersisted] = useState<GreenBeanOrderPersisted>(() => readGreenBeanOrderPersistedFromStorage())
  const [statusMessage, setStatusMessage] = useState('편집 내용은 이 브라우저에 자동 저장됩니다.')
  const [isCloudReady, setIsCloudReady] = useState(mode === 'local')
  const {
    lastSavedAt,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    resetDocumentSaveUi,
    saveState,
    skipInitialDocumentSave,
  } = useDocumentSaveUi(mode)
  const pullGreenBeanFromCloudRef = useRef<((isCancelled: () => boolean) => Promise<void>) | null>(null)
  const [compareMode, setCompareMode] = useState(true)
  const [recordDate, setRecordDate] = useState(() => new Date().toISOString().slice(0, 10))
  /** 선택한 주문 일자로 저장할 때 붙이는 메모(로컬 입력) */
  const [snapshotMemoDraft, setSnapshotMemoDraft] = useState('')
  const [almaItems, setAlmaItems] = useState<AlmaPriceItem[]>([])
  const [almaFetchedAt, setAlmaFetchedAt] = useState('')
  const [isLoadingAlma, setIsLoadingAlma] = useState(false)
  const [isRefreshingAlmaJson, setIsRefreshingAlmaJson] = useState(false)
  const [almaRefreshChanges, setAlmaRefreshChanges] = useState<Record<string, AlmaRefreshRowChange>>({})
  const [almaRefreshUnchangedIds, setAlmaRefreshUnchangedIds] = useState<Record<string, true>>({})
  const [almaRefreshGlobalSameHint, setAlmaRefreshGlobalSameHint] = useState(false)
  const [editingSupplierHeaderNames, setEditingSupplierHeaderNames] = useState(false)
  const [perItemMetric, setPerItemMetric] = useState<'qty' | 'money'>('qty')
  const [visibleItemKeys, setVisibleItemKeys] = useState<string[]>([])
  /** 구분(품목명): null이면 모두 잠금, 해당 행 id만 편집 가능(트리플클릭으로 잠금 해제) */
  const [itemNameUnlockedRowId, setItemNameUnlockedRowId] = useState<string | null>(null)
  const itemNameUnlockedRowIdRef = useRef<string | null>(null)
  const itemNameTripleClickRef = useRef<
    Record<string, { count: number; timeoutId: ReturnType<typeof setTimeout> | null }>
  >({})
  /** 입출고 저장소와 동기화할 때마다 증가(다른 탭·다시 보기 시 재조회) */
  const [inventoryHintsTick, setInventoryHintsTick] = useState(0)
  const [aliasDraftOpen, setAliasDraftOpen] = useState(false)
  const [aliasDraftRows, setAliasDraftRows] = useState<BeanNameAliasEntry[]>(() => readCustomBeanNameAliases())
  const [aliasRevision, setAliasRevision] = useState(0)
  const isAlmaRefreshAvailable = import.meta.env.DEV

  useEffect(() => {
    let cancelled = false

    setIsCloudReady(mode === 'local')
    resetDocumentSaveUi()

    const applyPersisted = (nextPersisted: GreenBeanOrderPersisted, source: 'local' | 'cloud', hasRemote: boolean) => {
      if (cancelled) {
        return
      }
      setPersisted(nextPersisted)
      setStatusMessage(
        source === 'cloud'
          ? '클라우드에서 생두 주문을 불러왔습니다.'
          : hasRemote
            ? '편집 내용은 이 브라우저에 자동 저장됩니다.'
            : '브라우저 생두 주문을 불러왔습니다. 아직 클라우드 문서는 없습니다.',
      )
      setIsCloudReady(true)
      if (source === 'cloud' && mode === 'cloud' && activeCompanyId) {
        writeGreenBeanOrderPersistedToStorage(nextPersisted)
      }
    }

    const loadPersisted = async () => {
      const localPersisted = readGreenBeanOrderPersistedFromStorage()
      if (mode !== 'cloud' || !activeCompanyId) {
        applyPersisted(localPersisted, 'local', true)
        return
      }

      try {
        const remotePersisted = await loadCompanyDocument<GreenBeanOrderPersisted>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.greenBeanOrderPage,
        )
        if (remotePersisted) {
          applyPersisted(normalizePersisted(remotePersisted), 'cloud', true)
        } else {
          applyPersisted(localPersisted, 'local', false)
        }
      } catch (error) {
        console.error('생두 주문 클라우드 문서를 읽지 못했습니다.', error)
        applyPersisted(localPersisted, 'local', true)
      }
    }

    pullGreenBeanFromCloudRef.current = async (isCancelled) => {
      if (mode !== 'cloud' || !activeCompanyId) {
        return
      }
      try {
        const remotePersisted = await loadCompanyDocument<GreenBeanOrderPersisted>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.greenBeanOrderPage,
        )
        if (isCancelled()) {
          return
        }
        if (remotePersisted) {
          applyPersisted(normalizePersisted(remotePersisted), 'cloud', true)
        }
        const remoteAliases = await loadCompanyDocument<BeanNameAliasEntry[]>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.beanNameAliases,
        )
        if (isCancelled()) {
          return
        }
        if (Array.isArray(remoteAliases)) {
          writeCustomBeanNameAliases(remoteAliases)
          setAliasDraftRows(readCustomBeanNameAliases())
          setAliasRevision((n) => n + 1)
          setInventoryHintsTick((n) => n + 1)
        }
      } catch (error) {
        console.error('생두 주문: 협업용 클라우드 다시 읽기에 실패했습니다.', error)
      }
    }

    void loadPersisted()
    return () => {
      cancelled = true
      pullGreenBeanFromCloudRef.current = null
    }
  }, [activeCompanyId, mode, resetDocumentSaveUi])

  useCloudDocumentRefreshPull({
    mode,
    activeCompanyId,
    cloudDocRefreshTick,
    saveState,
    onPull: async (isCancelled) => {
      await (pullGreenBeanFromCloudRef.current?.(isCancelled) ?? Promise.resolve())
    },
  })

  useEffect(() => {
    let cancelled = false
    const applyAliasRows = (rows: BeanNameAliasEntry[]) => {
      if (cancelled) {
        return
      }
      writeCustomBeanNameAliases(rows)
      setAliasDraftRows(readCustomBeanNameAliases())
      setAliasRevision((n) => n + 1)
      setInventoryHintsTick((n) => n + 1)
    }

    const loadAliasRows = async () => {
      const localAliases = readCustomBeanNameAliases()
      if (mode !== 'cloud' || !activeCompanyId) {
        applyAliasRows(localAliases)
        return
      }
      try {
        const remoteAliases = await loadCompanyDocument<BeanNameAliasEntry[]>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.beanNameAliases,
        )
        if (Array.isArray(remoteAliases)) {
          applyAliasRows(remoteAliases)
          return
        }
        applyAliasRows(localAliases)
      } catch (error) {
        console.error('원두 별칭 클라우드 문서를 읽지 못했습니다.', error)
        applyAliasRows(localAliases)
      }
    }

    void loadAliasRows()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, mode])

  useEffect(() => {
    itemNameUnlockedRowIdRef.current = itemNameUnlockedRowId
  }, [itemNameUnlockedRowId])

  useEffect(() => {
    if (itemNameUnlockedRowId && !persisted.rows.some((r) => r.id === itemNameUnlockedRowId)) {
      setItemNameUnlockedRowId(null)
    }
  }, [persisted.rows, itemNameUnlockedRowId])

  useEffect(() => {
    if (!itemNameUnlockedRowId) {
      return
    }
    const el = document.getElementById(`green-bean-item-name-${itemNameUnlockedRowId}`) as HTMLInputElement | null
    queueMicrotask(() => {
      el?.focus()
      try {
        el?.select()
      } catch {
        /* ignore */
      }
    })
  }, [itemNameUnlockedRowId])

  const handleItemNameInputClick = useCallback((rowId: string) => {
    if (itemNameUnlockedRowIdRef.current === rowId) {
      return
    }
    const map = itemNameTripleClickRef.current
    const prev = map[rowId] ?? { count: 0, timeoutId: null }
    if (prev.timeoutId) {
      clearTimeout(prev.timeoutId)
    }
    const nextCount = prev.count + 1
    if (nextCount >= 3) {
      map[rowId] = { count: 0, timeoutId: null }
      setItemNameUnlockedRowId(rowId)
      return
    }
    const timeoutId = setTimeout(() => {
      const cur = map[rowId]
      if (cur) {
        cur.count = 0
        cur.timeoutId = null
      }
    }, 450)
    map[rowId] = { count: nextCount, timeoutId }
  }, [])

  useEffect(() => {
    const snap = persisted.orderSnapshots.find((p) => p.orderDate === recordDate)
    setSnapshotMemoDraft(snap?.memo ?? '')
  }, [recordDate, persisted.orderSnapshots])

  /** 새로고침 후에도 쿨다운 안이면 직전 알마 갱신 UI(강조·단가 목록) 복원 */
  useEffect(() => {
    const cache = readAlmaRefreshCache()
    if (!cache) {
      return
    }
    const cooldown = cache.cooldownMs
    const elapsed = Date.now() - cache.completedAt
    if (elapsed >= cooldown) {
      return
    }
    const rowIds = new Set(persisted.rows.map((r) => r.id))
    const filteredChanges: Record<string, AlmaRefreshRowChange> = {}
    for (const [id, ch] of Object.entries(cache.almaRefreshChanges)) {
      if (rowIds.has(id)) {
        filteredChanges[id] = ch
      }
    }
    const filteredUnchanged: Record<string, true> = {}
    for (const id of Object.keys(cache.almaRefreshUnchangedIds)) {
      if (rowIds.has(id)) {
        filteredUnchanged[id] = true
      }
    }
    setAlmaItems(cache.almaItems)
    setAlmaFetchedAt(cache.almaFetchedAt)
    setAlmaRefreshChanges(filteredChanges)
    setAlmaRefreshUnchangedIds(filteredUnchanged)
    setAlmaRefreshGlobalSameHint(cache.almaRefreshGlobalSameHint)
    const remainMs = cooldown - elapsed
    setStatusMessage(
      `직전 알마 단가 갱신 결과(강조·단가 목록)를 복원했습니다. ${formatAlmaCooldownRemaining(remainMs)} 후에 다시 갱신할 수 있습니다.`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 1회: 저장소 기준 복원만
  }, [])

  useEffect(() => {
    if (mode === 'cloud' && activeCompanyId) {
      return
    }
    writeGreenBeanOrderPersistedToStorage(persisted)
  }, [activeCompanyId, mode, persisted])

  useEffect(() => {
    if (!isCloudReady) {
      return
    }
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }
    if (skipInitialDocumentSave()) {
      return
    }

    markDocumentDirty()

    const timeoutId = window.setTimeout(() => {
      markDocumentSaving()
      void saveCompanyDocument(
        activeCompanyId,
        COMPANY_DOCUMENT_KEYS.greenBeanOrderPage,
        persisted,
        user?.id,
      )
        .then(() => {
          writeGreenBeanOrderPersistedToStorage(persisted)
          markDocumentSaved()
        })
        .catch((error) => {
          console.error('생두 주문 클라우드 저장에 실패했습니다.', error)
          markDocumentError()
        })
    }, 600)

    return () => window.clearTimeout(timeoutId)
  }, [
    activeCompanyId,
    isCloudReady,
    mode,
    persisted,
    user?.id,
    markDocumentDirty,
    markDocumentError,
    markDocumentSaved,
    markDocumentSaving,
    skipInitialDocumentSave,
  ])

  useEffect(() => {
    const bump = () => setInventoryHintsTick((n) => n + 1)
    const onStorage = (e: StorageEvent) => {
      if (e.key === INVENTORY_STATUS_STORAGE_KEY) {
        bump()
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        bump()
      }
    }
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    const syncAliasDraft = () => {
      setAliasDraftRows(readCustomBeanNameAliases())
      setAliasRevision((n) => n + 1)
      setInventoryHintsTick((n) => n + 1)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key && event.key !== BEAN_NAME_ALIASES_STORAGE_KEY) {
        return
      }
      syncAliasDraft()
    }
    window.addEventListener(BEAN_NAME_ALIASES_UPDATED_EVENT, syncAliasDraft)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(BEAN_NAME_ALIASES_UPDATED_EVENT, syncAliasDraft)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const effectiveBeanAliases = useMemo(() => getEffectiveGreenBeanOrderAliases(), [aliasRevision])
  const inventoryOrderHints = useMemo(
    () => readInventoryStockFromStorage(normalizeItemKey, effectiveBeanAliases),
    [inventoryHintsTick, effectiveBeanAliases],
  )

  const inventoryHintBanner = useMemo(() => {
    if (inventoryOrderHints.loadError) {
      return '입출고 저장 데이터를 읽지 못했습니다. 입출고 화면에서 다시 저장한 뒤 이 페이지를 새로고침해 보세요.'
    }
    if (!inventoryOrderHints.hasStoredPayload) {
      return '입출고 표가 아직 저장되지 않았습니다. 입출고 화면에서 저장하면 기말 재고(kg)가 연결됩니다.'
    }
    const ref = inventoryOrderHints.referenceDateLabel
    const n = inventoryOrderHints.inventoryBeanRowCount
    if (ref && n > 0) {
      return `입출고 저장(기준일 ${ref})의 생두 ${n}행과 연결합니다. 이름이 같거나, 아래 "원두명 별칭 관리"에 등록한 별칭이면 기준일 재고(kg)를 보여 줍니다.`
    }
    return '입출고 품목을 불러왔습니다. 주문 품목명이 입출고와 같거나 별칭에 있으면 열에 값이 나옵니다.'
  }, [inventoryOrderHints])

  const baselineMap = useMemo(() => {
    const b = persisted.baseline
    if (!b) {
      return new Map<string, GreenBeanOrderRow>()
    }
    const map = new Map<string, GreenBeanOrderRow>()
    b.rows.forEach((row) => {
      map.set(normalizeItemKey(row.itemName), row)
    })
    return map
  }, [persisted.baseline])

  const currentKeys = useMemo(
    () => new Set(persisted.rows.map((r) => normalizeItemKey(r.itemName)).filter(Boolean)),
    [persisted.rows],
  )

  const currentLinkedInventoryKeys = useMemo(
    () =>
      new Set(
        persisted.rows
          .map((r) => (typeof r.inventoryLinkKey === 'string' ? r.inventoryLinkKey.trim() : ''))
          .filter(Boolean),
      ),
    [persisted.rows],
  )

  const nextLinkedInventoryItem = useMemo(() => {
    const seen = new Set<string>()
    for (const hit of inventoryOrderHints.byItemKey.values()) {
      const name = String(hit.inventoryItemName ?? '').trim()
      const key = normalizeItemKey(name)
      if (!key || seen.has(key)) {
        continue
      }
      seen.add(key)
      if (!currentKeys.has(key) && !currentLinkedInventoryKeys.has(hit.inventoryLinkKey)) {
        return { itemName: name, inventoryLinkKey: hit.inventoryLinkKey }
      }
    }
    return null
  }, [inventoryOrderHints.byItemKey, currentKeys, currentLinkedInventoryKeys])

  const removedBaselineNames = useMemo(() => {
    const b = persisted.baseline
    if (!b || !compareMode) {
      return [] as string[]
    }
    return b.rows
      .map((r) => r.itemName.trim())
      .filter((name) => name && !currentKeys.has(normalizeItemKey(name)))
  }, [persisted.baseline, compareMode, currentKeys])

  const totals = useMemo(() => {
    const sumQty = persisted.rows.reduce((s, r) => s + r.quantityKg, 0)
    const grossMoney = persisted.rows.reduce((s, r) => s + r.lineTotal, 0)
    const d = persisted.orderDeductions
    const almaD = Math.max(0, d.almaWon)
    const gscD = Math.max(0, d.gscWon)
    const otherD = Math.max(0, d.otherWon)
    const sumDeductions = almaD + gscD + otherD
    const sumMoney = netMoneyFromGrossAndDeductions(grossMoney, d)
    return { sumQty, grossMoney, sumMoney, almaD, gscD, otherD, sumDeductions }
  }, [persisted.rows, persisted.orderDeductions])

  const baselineTotals = useMemo(() => {
    const b = persisted.baseline
    if (!b) {
      return null
    }
    const sumQty = b.rows.reduce((s, r) => s + r.quantityKg, 0)
    const sumMoney = b.rows.reduce((s, r) => s + r.lineTotal, 0)
    return { sumQty, sumMoney }
  }, [persisted.baseline])

  const monthlyAggregatedPoints = useMemo(
    () => aggregateOrderSnapshotsToMonthlyPoints(persisted.orderSnapshots),
    [persisted.orderSnapshots],
  )

  const chartRows = useMemo(
    () =>
      [...monthlyAggregatedPoints].map((p) => ({
        ...p,
        monthLabel: formatMonthLabel(p.monthKey),
      })),
    [monthlyAggregatedPoints],
  )

  const orderHistoryTableRows = useMemo(
    () =>
      [...persisted.orderSnapshots].sort(
        (a, b) => b.orderDate.localeCompare(a.orderDate) || b.savedAt.localeCompare(a.savedAt),
      ),
    [persisted.orderSnapshots],
  )

  const latestMonthlyRow = chartRows[chartRows.length - 1] ?? null
  const previousMonthlyRow = chartRows[chartRows.length - 2] ?? null

  const monthlyOverviewCards = useMemo(() => {
    if (!latestMonthlyRow) {
      return []
    }
    return [
      {
        id: 'qty',
        title: '수량 합계',
        latestLabel: latestMonthlyRow.monthLabel,
        latestValue: formatKg(latestMonthlyRow.sumQty),
        latestNumeric: latestMonthlyRow.sumQty,
        previousValue: previousMonthlyRow ? formatKg(previousMonthlyRow.sumQty) : '—',
        deltaText: previousMonthlyRow ? formatSignedNumber(latestMonthlyRow.sumQty - previousMonthlyRow.sumQty, ' kg') : '첫 달',
        deltaPositive: previousMonthlyRow ? latestMonthlyRow.sumQty - previousMonthlyRow.sumQty >= 0 : true,
        lineKey: 'sumQty' as const,
        areaColor: '#2563eb',
      },
      {
        id: 'money',
        title: '총액 합계',
        latestLabel: latestMonthlyRow.monthLabel,
        latestValue: formatMoney(latestMonthlyRow.sumMoney),
        latestNumeric: latestMonthlyRow.sumMoney,
        previousValue: previousMonthlyRow ? formatMoney(previousMonthlyRow.sumMoney) : '—',
        deltaText: previousMonthlyRow ? formatSignedNumber(latestMonthlyRow.sumMoney - previousMonthlyRow.sumMoney, '원') : '첫 달',
        deltaPositive: previousMonthlyRow ? latestMonthlyRow.sumMoney - previousMonthlyRow.sumMoney >= 0 : true,
        lineKey: 'sumMoney' as const,
        areaColor: '#0d9488',
      },
    ]
  }, [latestMonthlyRow, previousMonthlyRow])

  const hasPerItemSnapshots = useMemo(
    () => monthlyAggregatedPoints.some((p) => p.items && p.items.length > 0),
    [monthlyAggregatedPoints],
  )

  const itemSeriesForChart = useMemo(() => {
    const totalsMap = new Map<string, { label: string; totalQty: number; totalMoney: number }>()
    for (const point of monthlyAggregatedPoints) {
      for (const item of point.items ?? []) {
        const key = normalizeItemKey(item.itemName)
        if (!key) {
          continue
        }
        const current = totalsMap.get(key) ?? {
          label: item.itemName.trim(),
          totalQty: 0,
          totalMoney: 0,
        }
        current.totalQty += item.quantityKg
        current.totalMoney += item.lineTotal
        totalsMap.set(key, current)
      }
    }
    return [...totalsMap.entries()]
      .map(([key, value]) => ({ key, ...value }))
      .sort(
        (a, b) =>
          b.totalMoney - a.totalMoney || b.totalQty - a.totalQty || a.label.localeCompare(b.label, 'ko'),
      )
      .map((series, i) => ({
        ...series,
        qtyField: `qty_${i}`,
        moneyField: `money_${i}`,
        color: GREEN_BEAN_SERIES_COLORS[i % GREEN_BEAN_SERIES_COLORS.length],
      }))
  }, [monthlyAggregatedPoints])

  const monthlyPointMap = useMemo(
    () => new Map(monthlyAggregatedPoints.map((point) => [point.monthKey, point])),
    [monthlyAggregatedPoints],
  )

  const rankedItemSeries = useMemo(() => {
    return itemSeriesForChart
      .map((series) => {
        const latestItem = latestMonthlyRow
          ? monthlyPointMap
              .get(latestMonthlyRow.monthKey)
              ?.items?.find((item) => normalizeItemKey(item.itemName) === series.key)
          : undefined
        const previousItem = previousMonthlyRow
          ? monthlyPointMap
              .get(previousMonthlyRow.monthKey)
              ?.items?.find((item) => normalizeItemKey(item.itemName) === series.key)
          : undefined
        return {
          ...series,
          latestQty: latestItem?.quantityKg ?? 0,
          latestMoney: latestItem?.lineTotal ?? 0,
          qtyDelta: latestItem && previousItem ? latestItem.quantityKg - previousItem.quantityKg : latestItem?.quantityKg ?? 0,
          moneyDelta:
            latestItem && previousItem ? latestItem.lineTotal - previousItem.lineTotal : latestItem?.lineTotal ?? 0,
        }
      })
      .sort((a, b) => {
        const valueA = perItemMetric === 'qty' ? a.latestQty : a.latestMoney
        const valueB = perItemMetric === 'qty' ? b.latestQty : b.latestMoney
        return valueB - valueA || b.totalMoney - a.totalMoney || b.totalQty - a.totalQty
      })
  }, [itemSeriesForChart, latestMonthlyRow, monthlyPointMap, perItemMetric, previousMonthlyRow])

  useEffect(() => {
    if (rankedItemSeries.length === 0) {
      if (visibleItemKeys.length > 0) {
        setVisibleItemKeys([])
      }
      return
    }
    const validKeys = new Set(rankedItemSeries.map((series) => series.key))
    const kept = visibleItemKeys.filter((key) => validKeys.has(key))
    const fallback = rankedItemSeries.slice(0, Math.min(5, rankedItemSeries.length)).map((series) => series.key)
    const next = kept.length > 0 ? kept : fallback
    const isSame =
      next.length === visibleItemKeys.length && next.every((key, index) => key === visibleItemKeys[index])
    if (!isSame) {
      setVisibleItemKeys(next)
    }
  }, [rankedItemSeries, visibleItemKeys])

  const visibleItemSeries = useMemo(() => {
    const visible = new Set(visibleItemKeys)
    return itemSeriesForChart.filter((series) => visible.has(series.key))
  }, [itemSeriesForChart, visibleItemKeys])

  const perItemMultiChartRows = useMemo(() => {
    if (itemSeriesForChart.length === 0) {
      return []
    }
    return chartRows.map((row) => {
      const point = monthlyAggregatedPoints.find((p) => p.monthKey === row.monthKey)
      const d: Record<string, string | number> = { monthLabel: row.monthLabel }
      for (const { key, qtyField, moneyField } of itemSeriesForChart) {
        const it = point?.items?.find((x) => normalizeItemKey(x.itemName) === key)
        d[qtyField] = it?.quantityKg ?? 0
        d[moneyField] = it?.lineTotal ?? 0
      }
      return d
    })
  }, [chartRows, monthlyAggregatedPoints, itemSeriesForChart])

  const togglePerItemSeries = (key: string) => {
    setVisibleItemKeys((prev) => {
      if (prev.includes(key)) {
        if (prev.length === 1) {
          return prev
        }
        return prev.filter((itemKey) => itemKey !== key)
      }
      return [...prev, key]
    })
  }

  const setVisibleRankedItemSeries = (count: number | 'all') => {
    setVisibleItemKeys(
      count === 'all' ? rankedItemSeries.map((series) => series.key) : rankedItemSeries.slice(0, count).map((series) => series.key),
    )
  }

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) {
      return
    }

    try {
      const buffer = await file.arrayBuffer()
      const matrix = parseMatrixFromFile(buffer)
      const parsed = parseGreenBeanOrderFromMatrix(matrix)
      if (!parsed) {
        setStatusMessage('시트에서 "구분" 행을 찾지 못했습니다. 생두 주문 양식인지 확인해주세요.')
        return
      }
      setPersisted((prev) => ({
        ...parsed,
        baseline: prev.baseline,
        orderSnapshots: prev.orderSnapshots,
      }))
      setRecordDate((current) => {
        const mk = guessMonthKeyFromTitle(parsed.title)
        if (mk) {
          return `${mk}-01`
        }
        return current
      })
      setStatusMessage(`불러옴: ${file.name} (${parsed.rows.length}품목)`)
    } catch (error) {
      console.error(error)
      setStatusMessage('파일을 읽지 못했습니다.')
    }
  }

  const handleExport = async () => {
    const { matrix, lineBasisHighlightByRow } = buildGreenBeanOrderExportMatrix(persisted)
    const safeName = persisted.title.replace(/[■\s]/g, '').slice(0, 20) || '생두주문'
    await exportStyledGreenBeanOrderExcel(matrix, `${safeName}.xlsx`, { lineBasisHighlightByRow })
    setStatusMessage('엑셀 파일을 내려받았습니다.')
  }

  const handleSetBaseline = () => {
    const snapshot: GreenBeanOrderBaseline = {
      savedAt: new Date().toISOString(),
      title: persisted.title,
      supplierLabels: [...persisted.supplierLabels],
      rows: persisted.rows.map((row) => ({
        ...row,
        id: row.id,
        supplierPrices: [...row.supplierPrices],
      })),
    }
    setPersisted((prev) => ({ ...prev, baseline: snapshot }))
    setStatusMessage(`지금 표를 비교 기준으로 저장했습니다. (${new Date().toLocaleString('ko-KR')})`)
  }

  const handleClearBaseline = () => {
    if (!persisted.baseline) {
      return
    }
    if (!window.confirm('저장해 둔 비교 기준을 지울까요?')) {
      return
    }
    setPersisted((prev) => ({ ...prev, baseline: null }))
    setStatusMessage('비교 기준을 지웠습니다.')
  }

  const handleAddOrderSnapshot = () => {
    const orderDate = recordDate
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) {
      setStatusMessage('주문 일자를 올바르게 선택해 주세요.')
      return
    }
    const existing = persisted.orderSnapshots.find((p) => p.orderDate === orderDate)
    if (
      existing &&
      !window.confirm(
        `${formatOrderDateLabel(orderDate)}에 이미 기록이 있습니다. 지금 표로 덮어쓸까요?`,
      )
    ) {
      return
    }
    const itemCount = persisted.rows.filter((r) => r.itemName.trim()).length
    const items: GreenBeanMonthlyItemSnapshot[] = persisted.rows
      .filter((r) => r.itemName.trim())
      .map((r) => ({
        itemName: r.itemName.trim(),
        quantityKg: r.quantityKg,
        lineTotal: r.lineTotal,
      }))
    const dSnap = parseOrderDeductions(persisted.orderDeductions)
    const snap: GreenBeanOrderDatedSnapshot = {
      id: crypto.randomUUID(),
      orderDate,
      savedAt: new Date().toISOString(),
      sumQty: totals.sumQty,
      sumMoney: totals.sumMoney,
      sumMoneyGross: totals.grossMoney,
      itemCount,
      items: items.length > 0 ? items : undefined,
    }
    if (dSnap.almaWon > 0 || dSnap.gscWon > 0 || dSnap.otherWon > 0) {
      snap.deductions = { ...dSnap }
    }
    const memoTrimmed = snapshotMemoDraft.trim()
    if (memoTrimmed) {
      snap.memo = memoTrimmed.slice(0, 500)
    }
    setPersisted((prev) => {
      const rest = prev.orderSnapshots.filter((p) => p.orderDate !== orderDate)
      return { ...prev, orderSnapshots: [...rest, snap] }
    })
    const mk = monthKeyFromOrderDate(orderDate)
    setStatusMessage(
      `${formatOrderDateLabel(orderDate)} 기록했습니다. (${formatMonthLabel(mk)} 월별 합계에 반영됩니다.)`,
    )
  }

  const handleRemoveOrderSnapshot = (id: string) => {
    const target = persisted.orderSnapshots.find((point) => point.id === id)
    const label = target ? formatOrderDateLabel(target.orderDate) : '선택한 일자'
    if (!window.confirm(`${label} 주문 기록을 삭제할까요? 월별 합계·차트에서도 빠집니다.`)) {
      return
    }
    setPersisted((prev) => ({
      ...prev,
      orderSnapshots: prev.orderSnapshots.filter((p) => p.id !== id),
    }))
    setStatusMessage(`${label} 기록을 삭제했습니다.`)
  }

  const handleRemoveSelectedDateRecord = () => {
    const snap = persisted.orderSnapshots.find((p) => p.orderDate === recordDate)
    if (!snap) {
      return
    }
    const label = formatOrderDateLabel(recordDate)
    if (!window.confirm(`${label}에 저장한 주문 기록을 삭제할까요? 월별 합계·차트에서도 빠집니다.`)) {
      return
    }
    setPersisted((prev) => ({
      ...prev,
      orderSnapshots: prev.orderSnapshots.filter((p) => p.id !== snap.id),
    }))
    setStatusMessage(`${label} 기록을 삭제했습니다.`)
  }

  const handleClearAllOrderSnapshots = () => {
    const n = persisted.orderSnapshots.length
    if (n === 0) {
      return
    }
    if (
      !window.confirm(
        `저장된 주문 기록 ${n}건을 모두 삭제할까요? 월별·원두별 그래프가 모두 비워집니다.`,
      )
    ) {
      return
    }
    setPersisted((prev) => ({ ...prev, orderSnapshots: [] }))
    setStatusMessage('저장된 주문 기록을 모두 삭제했습니다.')
  }

  const hasRecordForSelectedDate = persisted.orderSnapshots.some((p) => p.orderDate === recordDate)

  const upsertAliasDraft = (index: number, key: 'from' | 'to', value: string) => {
    setAliasDraftRows((rows) =>
      rows.map((row, i) =>
        i === index
          ? {
              ...row,
              [key]: value,
            }
          : row,
      ),
    )
  }

  const addAliasDraftRow = () => {
    setAliasDraftRows((rows) => [...rows, { from: '', to: '' }])
  }

  const removeAliasDraftRow = (index: number) => {
    setAliasDraftRows((rows) => rows.filter((_, i) => i !== index))
  }

  const saveAliasDraftRows = async () => {
    const cleaned = normalizeBeanNameAliases(aliasDraftRows)
    if (mode === 'cloud' && activeCompanyId) {
      try {
        await saveCompanyDocument(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.beanNameAliases,
          cleaned,
          user?.id,
        )
        writeCustomBeanNameAliases(cleaned)
        setStatusMessage(`원두 별칭 ${cleaned.length}건을 클라우드에 저장했습니다.`)
      } catch (error) {
        console.error('원두 별칭 클라우드 저장에 실패했습니다.', error)
        setStatusMessage('원두 별칭 클라우드 저장에 실패했습니다. 연결을 확인한 뒤 다시 시도해 주세요.')
      }
      return
    }
    writeCustomBeanNameAliases(cleaned)
    setStatusMessage(`원두 별칭 ${cleaned.length}건을 저장했습니다.`)
  }

  const resetAliasDraftRows = () => {
    setAliasDraftRows(readCustomBeanNameAliases())
    setStatusMessage('저장된 원두 별칭으로 되돌렸습니다.')
  }

  const updateRow = (id: string, patch: Partial<GreenBeanOrderRow>) => {
    if (patch.itemName !== undefined) {
      setAlmaRefreshChanges((ch) => {
        if (!(id in ch)) {
          return ch
        }
        const { [id]: _, ...rest } = ch
        return rest
      })
    }
    setPersisted((prev) => ({
      ...prev,
      rows: prev.rows.map((row) => (row.id === id ? applyLineTotal({ ...row, ...patch }) : row)),
    }))
  }

  const updatePrice = (id: string, supplierIndex: number, value: string) => {
    const almaCol = persisted.supplierLabels.findIndex((label) => label.includes('알마'))
    if (almaCol >= 0 && supplierIndex === almaCol) {
      setAlmaRefreshChanges((ch) => {
        if (!(id in ch)) {
          return ch
        }
        const { [id]: _, ...rest } = ch
        return rest
      })
    }
    setPersisted((prev) => ({
      ...prev,
      rows: prev.rows.map((row) => {
        if (row.id !== id) {
          return row
        }
        const next = [...row.supplierPrices]
        const trimmed = value.trim()
        if (trimmed === '') {
          next[supplierIndex] = ''
        } else if (/품절/i.test(trimmed)) {
          next[supplierIndex] = '품절'
        } else if (/^x$/i.test(trimmed)) {
          next[supplierIndex] = 'X'
        } else {
          const n = Number(trimmed.replaceAll(',', ''))
          next[supplierIndex] = Number.isFinite(n) ? n : trimmed
        }
        return applyLineTotal({ ...row, supplierPrices: next })
      }),
    }))
  }

  const applyRecommendedInventoryLink = (row: GreenBeanOrderRow) => {
    const best = pickBestInventoryMatch(row.itemName, inventoryOrderHints.byItemKey)
    if (!best) {
      setStatusMessage('추천할 입출고 품목을 찾지 못했습니다. 품목명을 조금 더 구체적으로 적어 주세요.')
      return
    }
    updateRow(row.id, {
      itemName: best.inventoryItemName,
      inventoryLinkKey: best.inventoryLinkKey,
      almaSupplyNote: undefined,
    })
    setStatusMessage(`추천 연동을 적용했습니다: ${best.inventoryItemName}`)
  }

  const addRow = () => {
    const newId = crypto.randomUUID()
    const initialItemName = nextLinkedInventoryItem?.itemName ?? ''
    const initialInventoryLinkKey = nextLinkedInventoryItem?.inventoryLinkKey
    setPersisted((prev) => ({
      ...prev,
      rows: [
        ...prev.rows,
        applyLineTotal({
          id: newId,
          itemName: initialItemName,
          inventoryLinkKey: initialInventoryLinkKey,
          supplierPrices: prev.supplierLabels.map(() => ''),
          quantityKg: 0,
          priceSource: 'auto',
          lineTotal: 0,
        }),
      ],
    }))
    setItemNameUnlockedRowId(newId)
  }

  const setRowPriceSource = (id: string, value: string) => {
    const nextSource = value === 'auto' ? 'auto' : Number(value)
    updateRow(id, {
      priceSource: nextSource === 'auto' ? 'auto' : Number.isInteger(nextSource) ? nextSource : 'auto',
    })
  }

  const loadAlmaPrices = async () => {
    try {
      if (!isAlmaRefreshAvailable) {
        setStatusMessage('알마 단가 갱신은 로컬 개발 환경에서만 사용할 수 있습니다.')
        return
      }
      const prevCache = readAlmaRefreshCache()
      const activeCooldown =
        prevCache && prevCache.cooldownMs > 0 ? prevCache.cooldownMs : ALMA_PRICE_REFRESH_COOLDOWN_MS
      if (prevCache && Date.now() - prevCache.completedAt < activeCooldown) {
        const remainMs = prevCache.completedAt + activeCooldown - Date.now()
        setStatusMessage(`알마 단가는 ${formatAlmaCooldownRemaining(remainMs)} 후에 다시 갱신할 수 있습니다.`)
        return
      }

      setIsLoadingAlma(true)
      if (isAlmaRefreshAvailable) {
        setIsRefreshingAlmaJson(true)
        try {
          const refreshRes = await fetch('/api/alma/refresh-member', { method: 'POST' })
          const refreshData = (await refreshRes.json()) as {
            ok?: boolean
            error?: string
            stdout?: string
            stderr?: string
          }
          if (!refreshRes.ok || !refreshData.ok) {
            const detail = [refreshData.error, refreshData.stderr, refreshData.stdout].filter(Boolean).join('\n')
            console.error('알마 단가 갱신 실패:', detail || refreshRes.status)
            const detailShort =
              detail.length > 400 ? `${detail.slice(0, 400)}… (전체는 브라우저 개발자 도구 콘솔)` : detail
            setAlmaRefreshChanges({})
            setAlmaRefreshUnchangedIds({})
            setAlmaRefreshGlobalSameHint(false)
            setStatusMessage(
              detailShort
                ? `단가 목록 갱신에 실패했습니다. 표는 바꾸지 않았습니다.\n${detailShort}`
                : '단가 목록 갱신에 실패했습니다. 표는 바꾸지 않았습니다.',
            )
            return
          }
          setStatusMessage('알마에서 최신 회원 단가를 받았습니다. 표에 반영하는 중…')
        } catch (error) {
          console.error(error)
          setAlmaRefreshChanges({})
          setAlmaRefreshUnchangedIds({})
          setAlmaRefreshGlobalSameHint(false)
          setStatusMessage(
            error instanceof Error
              ? `단가 목록 갱신에 실패했습니다. 표는 바꾸지 않았습니다. (${error.message})`
              : '단가 목록 갱신에 실패했습니다. 표는 바꾸지 않았습니다.',
          )
          return
        } finally {
          setIsRefreshingAlmaJson(false)
        }
      }

      const ts = Date.now()
      const response = await fetch(`/alma-prices-member.json?ts=${ts}`)
      const sourceLabel = '회원 단가표'
      if (!response.ok) {
        throw new Error('회원 단가 파일을 열 수 없습니다. alma-prices-member.json이 있는지 확인해 주세요.')
      }
      const parsed = (await response.json()) as {
        fetchedAt?: string
        items?: Array<{ itemName?: string; price?: number; supplyNote?: string }>
      }
      const items = Array.isArray(parsed.items)
        ? parsed.items
            .map((row) => ({
              itemName: String(row.itemName ?? '').trim(),
              price: Math.max(0, Number(row.price ?? 0)),
              supplyNote:
                typeof row.supplyNote === 'string' ? row.supplyNote.replace(/\s+/g, ' ').trim() : '',
            }))
            .filter((row) => row.itemName && row.price > 0)
        : []
      const map = buildAlmaPriceByNameMap(items)
      const aiPreview = persisted.supplierLabels.findIndex((label) => label.includes('알마'))
      let matchedRowCount = 0
      if (aiPreview >= 0 && items.length > 0) {
        for (const row of persisted.rows) {
          if (findMatchedAlmaForRow(row, items, map)) {
            matchedRowCount += 1
          }
        }
      }

      const nextAlmaRefreshChanges: Record<string, AlmaRefreshRowChange> = {}
      const nextAlmaRefreshUnchanged: Record<string, true> = {}
      if (aiPreview >= 0 && items.length > 0) {
        for (const row of persisted.rows) {
          const prevPrice = unitPriceForAutoPick(row.supplierPrices[aiPreview] ?? '')
          const prevNote = (row.almaSupplyNote ?? '').trim()
          const matched = findMatchedAlmaForRow(row, items, map)
          const nextPrice = matched
            ? matched.price > 0
              ? matched.price
              : null
            : unitPriceForAutoPick(row.supplierPrices[aiPreview] ?? '')
          const nextNote = matched ? (matched.supplyNote ?? '').trim() : ''
          if (prevPrice !== nextPrice || prevNote !== nextNote) {
            nextAlmaRefreshChanges[row.id] = { prevPrice, nextPrice, prevNote, nextNote }
          } else {
            nextAlmaRefreshUnchanged[row.id] = true
          }
        }
      }
      setAlmaRefreshChanges(nextAlmaRefreshChanges)
      setAlmaRefreshUnchangedIds(nextAlmaRefreshUnchanged)
      const almaChangedRowCount = Object.keys(nextAlmaRefreshChanges).length
      const almaUnchangedRowCount = Object.keys(nextAlmaRefreshUnchanged).length
      const hintSame =
        almaChangedRowCount === 0 &&
        aiPreview >= 0 &&
        items.length > 0 &&
        persisted.rows.length > 0 &&
        almaUnchangedRowCount > 0
      setAlmaRefreshGlobalSameHint(hintSame)

      setAlmaItems(items)
      setAlmaFetchedAt(typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : new Date().toISOString())
      setPersisted((prev) => {
        const ai = prev.supplierLabels.findIndex((label) => label.includes('알마'))
        if (ai < 0 || items.length === 0) {
          return prev
        }
        const m = buildAlmaPriceByNameMap(items)
        const nextRows = prev.rows.map((row) => {
          const matched = findMatchedAlmaForRow(row, items, m)
          if (!matched) {
            return applyLineTotal({ ...row, almaSupplyNote: undefined })
          }
          const nextPrices = [...row.supplierPrices]
          while (nextPrices.length < prev.supplierLabels.length) {
            nextPrices.push('')
          }
          nextPrices[ai] = matched.price
          const note = matched.supplyNote?.trim()
          return applyLineTotal({
            ...row,
            supplierPrices: nextPrices,
            almaSupplyNote: note || undefined,
          })
        })
        return { ...prev, rows: nextRows }
      })
      if (aiPreview < 0) {
        setStatusMessage(
          `알마씨엘로 단가 ${items.length}건을 불러왔습니다. (${sourceLabel}) 공급처 열 이름에 「알마」가 없어 표에는 넣지 못했습니다.`,
        )
      } else {
        const changeHint =
          almaChangedRowCount > 0
            ? ` 이전과 달라진 품목 ${almaChangedRowCount}개는 알마 열·차이 열에 강조했습니다.`
            : ' 알마 단가·수급 안내는 갱신 전과 같습니다.'
        setStatusMessage(
          `알마씨엘로 단가 ${items.length}건을 불러왔습니다. (${sourceLabel}) 품목명이 맞는 ${matchedRowCount}개 행에 알마 열 단가를 넣었습니다.${changeHint}`,
        )
      }

      writeAlmaRefreshCache({
        completedAt: Date.now(),
        cooldownMs: ALMA_PRICE_REFRESH_COOLDOWN_MS,
        almaFetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : new Date().toISOString(),
        almaItems: items,
        almaRefreshChanges: nextAlmaRefreshChanges,
        almaRefreshUnchangedIds: nextAlmaRefreshUnchanged,
        almaRefreshGlobalSameHint: hintSame,
      })
    } catch (error) {
      console.error(error)
      setAlmaRefreshChanges({})
      setAlmaRefreshUnchangedIds({})
      setAlmaRefreshGlobalSameHint(false)
      setStatusMessage(error instanceof Error ? error.message : '알마 단가를 불러오지 못했습니다.')
    } finally {
      setIsLoadingAlma(false)
    }
  }

  const gscIndex = useMemo(
    () => persisted.supplierLabels.findIndex((label) => label.toLowerCase().includes('gsc')),
    [persisted.supplierLabels],
  )
  const almaIndex = useMemo(
    () => persisted.supplierLabels.findIndex((label) => label.includes('알마')),
    [persisted.supplierLabels],
  )

  const almaRefreshAnyRowChanged = useMemo(
    () => Object.keys(almaRefreshChanges).length > 0,
    [almaRefreshChanges],
  )

  const removeRow = (id: string) => {
    const row = persisted.rows.find((item) => item.id === id)
    const label = row?.itemName?.trim() ? `「${row.itemName.trim()}」` : '이 행'
    if (!window.confirm(`${label}을(를) 주문표에서 삭제할까요?`)) {
      return
    }
    setPersisted((prev) => ({
      ...prev,
      rows: prev.rows.filter((row) => row.id !== id),
    }))
  }

  const renderPriceDelta = (current: PriceCell, previous: PriceCell | undefined) => {
    if (!compareMode || !persisted.baseline || previous === undefined) {
      return null
    }
    const a = typeof current === 'number' ? current : parseNumber(current)
    const b = typeof previous === 'number' ? previous : parseNumber(previous)
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return null
    }
    const d = a - b
    if (d === 0) {
      return null
    }
    return (
      <span className={d > 0 ? 'green-bean-delta-pos' : 'green-bean-delta-neg'}>
        {formatDelta(d, '원')}
      </span>
    )
  }

  return (
    <div className="meeting-layout green-bean-order-page">
      <section className="panel">
        <div className="green-bean-page-hero-rehome no-print" aria-label="주문 요약">
          <div className="green-bean-hero-metrics-row">
            <div className="green-bean-hero-stat">
              <span className="green-bean-hero-stat-label">주문표 합계</span>
              <strong className="green-bean-hero-stat-value green-bean-hero-summary-line">
                {persisted.rows.filter((r) => r.itemName.trim()).length}개 · {formatKg(totals.sumQty)} · 반영{' '}
                {formatMoney(totals.sumMoney)}
              </strong>
              {totals.sumDeductions > 0 ? (
                <p className="muted tiny green-bean-hero-deduction-hint">
                  품목 소계 {formatMoney(totals.grossMoney)} − 감면 합계 {formatMoney(totals.sumDeductions)}
                </p>
              ) : null}
            </div>
            <div className="green-bean-hero-stat-divider" role="presentation" />
            <div className="green-bean-hero-stat">
              <span className="green-bean-hero-stat-label">기준 시점</span>
              <strong className="green-bean-hero-stat-value green-bean-hero-stat-value--baseline">
                {persisted.baseline
                  ? new Date(persisted.baseline.savedAt).toLocaleString('ko-KR')
                  : '미설정'}
              </strong>
            </div>
          </div>
        </div>
        <div className="panel-header">
          <div>
            <h2>주문표</h2>
            <p className="muted">표 제목·공급처 열 이름은 아래 표 상단에서 수정합니다.</p>
          </div>
        </div>

        <div className="green-bean-toolbar">
          <div className="green-bean-toolbar-row">
            <span className="green-bean-toolbar-label" aria-hidden>
              파일
            </span>
            <div className="green-bean-toolbar-actions">
              <label className="upload-button secondary green-bean-toolbar-control">
                엑셀 불러오기
                <input type="file" accept=".xlsx,.xls" onChange={handleFile} />
              </label>
              <button type="button" className="ghost-button green-bean-toolbar-control" onClick={handleExport}>
                엑셀보내기
              </button>
              <span className="green-bean-toolbar-sep" aria-hidden>
                |
              </span>
              <a className="green-bean-toolbar-link" href="https://www.almacielo.com/" target="_blank" rel="noreferrer">
                알마씨엘로
              </a>
              <button type="button" className="green-bean-toolbar-link" onClick={addRow}>
                행 추가
              </button>
            </div>
          </div>
          <div className="green-bean-toolbar-row">
            <span className="green-bean-toolbar-label" aria-hidden>
              비교
            </span>
            <div className="green-bean-toolbar-actions">
              <button type="button" className="ghost-button green-bean-toolbar-control" onClick={handleSetBaseline}>
                기준 저장
              </button>
              <button
                type="button"
                className="green-bean-toolbar-link green-bean-toolbar-link--danger"
                onClick={handleClearBaseline}
                disabled={!persisted.baseline}
              >
                기준 지우기
              </button>
              <button
                type="button"
                className={
                  compareMode
                    ? 'inventory-toggle-button active green-bean-toolbar-toggle'
                    : 'inventory-toggle-button green-bean-toolbar-toggle'
                }
                onClick={() => setCompareMode((v) => !v)}
                disabled={!persisted.baseline}
              >
                비교 {compareMode ? '켜짐' : '꺼짐'}
              </button>
            </div>
          </div>
        </div>
        <div className="page-status-bar">
          <p className="page-status-message green-bean-status" role="status" aria-live="polite">
            {statusMessage}
          </p>
          <PageSaveStatus mode={mode} saveState={saveState} lastSavedAt={lastSavedAt} />
        </div>
        <p className="muted tiny green-bean-inventory-hint-banner">{inventoryHintBanner}</p>
        <div className="green-bean-alias-admin no-print">
          <button
            type="button"
            className="ghost-button small-hit green-bean-alias-admin-toggle"
            onClick={() => setAliasDraftOpen((v) => !v)}
          >
            {aliasDraftOpen ? '원두명 별칭 관리 닫기' : '원두명 별칭 관리'}
          </button>
          {aliasDraftOpen ? (
            <div className="green-bean-alias-admin-panel">
              <p className="muted tiny">
                주문표 품목명(왼쪽)과 입출고 생두명(오른쪽)이 다를 때 연결용으로 씁니다. 아래 첫 표는 기존 기본 별칭(코드),
                두 번째 표는 직접 추가/수정하는 별칭입니다. 저장하면 이 화면과 거래명세 매핑에서 같이 사용됩니다.
              </p>
              <div className="green-bean-alias-admin-default-block">
                <div className="muted tiny green-bean-alias-admin-subtitle">
                  기본 별칭(읽기 전용) {GREEN_BEAN_ORDER_INVENTORY_ALIASES.length}건
                </div>
                <table className="green-bean-alias-admin-table green-bean-alias-admin-table--readonly">
                  <thead>
                    <tr>
                      <th>주문표 이름(왼쪽)</th>
                      <th>입출고 생두명(오른쪽)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {GREEN_BEAN_ORDER_INVENTORY_ALIASES.map(([from, to], index) => (
                      <tr key={`default-alias-row-${index}`}>
                        <td>{from}</td>
                        <td>{to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="muted tiny green-bean-alias-admin-subtitle">사용자 별칭(편집 가능)</div>
              <table className="green-bean-alias-admin-table">
                <thead>
                  <tr>
                    <th>주문표 이름(왼쪽)</th>
                    <th>입출고 생두명(오른쪽)</th>
                    <th className="green-bean-alias-admin-remove-col" />
                  </tr>
                </thead>
                <tbody>
                  {aliasDraftRows.map((row, index) => (
                    <tr key={`alias-row-${index}`}>
                      <td>
                        <input
                          className="inventory-cell-input"
                          value={row.from}
                          onChange={(e) => upsertAliasDraft(index, 'from', e.target.value)}
                          placeholder="예: 케냐 아이히더 AA PLUS"
                        />
                      </td>
                      <td>
                        <input
                          className="inventory-cell-input"
                          value={row.to}
                          onChange={(e) => upsertAliasDraft(index, 'to', e.target.value)}
                          placeholder="예: Kenya"
                        />
                      </td>
                      <td>
                        <button
                          type="button"
                          className="green-bean-row-remove"
                          onClick={() => removeAliasDraftRow(index)}
                          aria-label={`별칭 ${index + 1} 삭제`}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="green-bean-alias-admin-actions">
                <button type="button" className="ghost-button small-hit" onClick={addAliasDraftRow}>
                  행 추가
                </button>
                <button type="button" className="ghost-button small-hit" onClick={resetAliasDraftRows}>
                  되돌리기
                </button>
                <button type="button" className="ghost-button small-hit active" onClick={saveAliasDraftRows}>
                  별칭 저장
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="green-bean-table-wrap">
          <div className="green-bean-supplier-header-toolbar">
            <div className="green-bean-sheet-title-field">
              <label htmlFor="green-bean-sheet-title">표 제목</label>
              <input
                id="green-bean-sheet-title"
                className="expense-input"
                value={persisted.title}
                onChange={(e) => setPersisted((p) => ({ ...p, title: e.target.value }))}
                placeholder="예: ■ 4월 생두 주문"
              />
            </div>
            <div className="green-bean-table-toolbar-actions">
              <div className="green-bean-alma-inline">
                <button
                  type="button"
                  className="ghost-button small-hit"
                  onClick={() => void loadAlmaPrices()}
                  disabled={!isAlmaRefreshAvailable || isLoadingAlma || isRefreshingAlmaJson}
                  title={
                    isAlmaRefreshAvailable
                      ? `로컬 개발 서버에서 알마 회원 단가를 다시 받은 뒤, 목록을 읽어 알마 열에 넣습니다. 성공 후 ${almaCooldownHumanLabel()} 동안은 재갱신이 제한되고, 그동안 새로고침해도 강조 표시가 유지됩니다.`
                      : '알마 단가 갱신은 로컬 개발 환경에서만 사용할 수 있습니다. 배포본에서는 로컬에서 갱신 후 저장된 결과를 확인하세요.'
                  }
                >
                  {isRefreshingAlmaJson
                    ? '갱신 중…'
                    : isLoadingAlma
                      ? '불러오는 중…'
                      : '알마씨엘로 단가 갱신'}
                </button>
                {almaFetchedAt && (
                  <span className="muted tiny green-bean-alma-fetched-at">
                    {new Date(almaFetchedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                {almaRefreshGlobalSameHint ? (
                  <span
                    className="green-bean-alma-refresh-same-pill"
                    title="갱신한 JSON과 갱신 직전 표의 알마 단가·수급 안내가 모든 행에서 같습니다."
                  >
                    직전 표와 동일
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                className={`ghost-button small-hit${editingSupplierHeaderNames ? ' active' : ''}`}
                onClick={() => {
                  if (editingSupplierHeaderNames) {
                    setPersisted((prev) => ({
                      ...prev,
                      supplierLabels: prev.supplierLabels.map((x) => String(x).trim()),
                    }))
                    setEditingSupplierHeaderNames(false)
                  } else {
                    setEditingSupplierHeaderNames(true)
                  }
                }}
              >
                {editingSupplierHeaderNames ? '이름 편집 끝' : '공급처 이름 편집'}
              </button>
            </div>
          </div>
          <table
            className={`inventory-table green-bean-table${almaItems.length > 0 ? ' green-bean-table--with-alma-ref' : ''}`}
          >
            <thead>
              <tr>
                <th className="inventory-sticky-column green-bean-th-item" scope="col">
                  구분
                </th>
                {persisted.supplierLabels.map((label, i) => (
                  <th key={i} className="green-bean-th-price" scope="col">
                    {editingSupplierHeaderNames ? (
                      <input
                        className="inventory-cell-input green-bean-header-input"
                        value={label}
                        aria-label={`공급처 ${i + 1} 열 이름`}
                        onChange={(e) => {
                          const v = e.target.value
                          setPersisted((prev) => {
                            const nextLabels = [...prev.supplierLabels]
                            nextLabels[i] = v
                            return { ...prev, supplierLabels: nextLabels }
                          })
                        }}
                      />
                    ) : (
                      <span className="green-bean-header-label">{label.trim() || `열 ${i + 1}`}</span>
                    )}
                  </th>
                ))}
                {almaItems.length > 0 && (
                  <th className="green-bean-th-alma-ref" scope="col" title="알마 단가와 GSC 단가의 차이(원/kg)">
                    차이
                  </th>
                )}
                <th
                  className="green-bean-th-num green-bean-th-inv-hint"
                  scope="col"
                  title="입출고와 품목명이 같을 때만 표시. 입출고 기준일 열의 기말 재고(kg)입니다."
                >
                  재고
                  <span className="green-bean-th-inv-hint-unit">kg</span>
                </th>
                <th className="green-bean-th-num" scope="col" title="수량(kg)">
                  kg
                </th>
                <th className="green-bean-th-source" scope="col">
                  단가 기준
                </th>
                <th className="green-bean-th-num" scope="col">
                  총계
                </th>
              </tr>
            </thead>
            <tbody>
              {persisted.rows.map((row) => {
                const keyName = normalizeItemKey(row.itemName)
                const baseRow = keyName ? baselineMap.get(keyName) : undefined
                const isNew = compareMode && !!persisted.baseline && !!keyName && !baseRow
                const autoMode = (row.priceSource ?? 'auto') === 'auto'
                const autoPickedIdx = autoMode ? resolveUnitPriceIndex(row.supplierPrices, 'auto') : -1
                const autoPickedLabel =
                  autoPickedIdx >= 0
                    ? persisted.supplierLabels[autoPickedIdx]?.trim() || `열 ${autoPickedIdx + 1}`
                    : null
                const almaRefChanged = !!almaRefreshChanges[row.id]
                const almaRefreshSummary = almaRefChanged ? summarizeAlmaRefreshChange(almaRefreshChanges[row.id]) : null
                const almaRefSamePartial =
                  !almaRefChanged && !!almaRefreshUnchangedIds[row.id] && almaRefreshAnyRowChanged
                const invMatchByName = keyName ? inventoryOrderHints.byItemKey.get(keyName) : undefined
                const invMatchByLink =
                  row.inventoryLinkKey && row.inventoryLinkKey.trim()
                    ? inventoryOrderHints.byInventoryLinkKey.get(row.inventoryLinkKey.trim())
                    : undefined
                const invMatch = invMatchByLink ?? invMatchByName
                const invStockTitle =
                  invMatch && inventoryOrderHints.referenceDateLabel
                    ? `입출고 기준일 ${inventoryOrderHints.referenceDateLabel} 기말 재고(kg)`
                    : invMatch
                      ? '입출고에 저장된 기말 재고(kg)'
                      : ''

                return (
                  <tr key={row.id} className={isNew ? 'green-bean-row-new' : undefined}>
                    <td className="inventory-sticky-column green-bean-td-item">
                      <div className="green-bean-item-cell">
                        <button
                          type="button"
                          className="green-bean-row-remove"
                          aria-label="행 삭제"
                          disabled={persisted.rows.length <= 1}
                          title={
                            persisted.rows.length <= 1
                              ? '마지막 한 행은 삭제할 수 없습니다.'
                              : '이 행 삭제'
                          }
                          onClick={(e) => {
                            e.stopPropagation()
                            removeRow(row.id)
                          }}
                        >
                          −
                        </button>
                        <div className="green-bean-item-main">
                          <input
                            id={`green-bean-item-name-${row.id}`}
                            className="inventory-cell-input green-bean-input-item"
                            readOnly={itemNameUnlockedRowId !== row.id}
                            value={row.itemName}
                            onClick={() => handleItemNameInputClick(row.id)}
                            onChange={(e) =>
                            updateRow(row.id, {
                              itemName: e.target.value,
                              almaSupplyNote: undefined,
                              inventoryLinkKey:
                                row.inventoryLinkKey ??
                                inventoryOrderHints.byItemKey.get(normalizeItemKey(e.target.value))
                                  ?.inventoryLinkKey,
                            })
                            }
                            onBlur={() => {
                              if (itemNameUnlockedRowId === row.id) {
                                setItemNameUnlockedRowId(null)
                              }
                            }}
                            placeholder="품목명"
                            title={
                              itemNameUnlockedRowId === row.id
                                ? undefined
                                : '마우스로 빠르게 세 번 연속 클릭하면 원두명을 수정할 수 있습니다.'
                            }
                          />
                          {invMatch ? (
                            <span className="green-bean-item-linked-name" title="입출고 품목별 요약의 연결된 이름">
                              {invMatch.inventoryItemName}
                            </span>
                          ) : row.itemName.trim() ? (
                            <button
                              type="button"
                              className="green-bean-item-link-suggest"
                              onClick={() => applyRecommendedInventoryLink(row)}
                              title="입출고 품목명과 가장 비슷한 후보를 찾아 이름/연동키를 맞춥니다"
                            >
                              추천 이름 적용
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    {persisted.supplierLabels.map((_, si) => {
                      const cell = row.supplierPrices[si] ?? ''
                      const display = cell === '' ? '' : typeof cell === 'number' ? String(cell) : cell
                      const prevCell = baseRow?.supplierPrices[si]
                      return (
                        <td
                          key={si}
                          className={`green-bean-td-price${
                            si === almaIndex && almaRefChanged
                              ? ' green-bean-alma-refresh-changed'
                              : si === almaIndex && almaRefSamePartial
                                ? ' green-bean-alma-refresh-same'
                                : ''
                          }`}
                        >
                          <div className="green-bean-cell-stack green-bean-cell-stack--num">
                            <input
                              className="inventory-cell-input green-bean-input-price"
                              value={display}
                              onChange={(e) => updatePrice(row.id, si, e.target.value)}
                              placeholder="원"
                              inputMode="decimal"
                            />
                            {renderPriceDelta(cell, prevCell)}
                            {si === almaIndex && almaRefreshSummary?.line ? (
                              <span
                                className={
                                  almaRefreshSummary.tone === 'up'
                                    ? 'green-bean-alma-refresh-hint green-bean-alma-refresh-hint--up'
                                    : almaRefreshSummary.tone === 'down'
                                      ? 'green-bean-alma-refresh-hint green-bean-alma-refresh-hint--down'
                                      : 'green-bean-alma-refresh-hint green-bean-alma-refresh-hint--neutral'
                                }
                                title={almaRefreshSummary.title}
                              >
                                {almaRefreshSummary.line}
                              </span>
                            ) : null}
                            {si === almaIndex && almaRefSamePartial ? (
                              <span
                                className="green-bean-alma-refresh-hint green-bean-alma-refresh-hint--same"
                                title="갱신 직전 표의 알마 단가·수급 안내와 같습니다."
                              >
                                직전과 동일
                              </span>
                            ) : null}
                            {si === almaIndex && row.almaSupplyNote ? (
                              <span
                                className="green-bean-alma-supply-note muted tiny"
                                title="알마 단가표 수급 안내"
                              >
                                {row.almaSupplyNote}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      )
                    })}
                    {almaItems.length > 0 &&
                      (() => {
                        if (gscIndex < 0 || almaIndex < 0) {
                          return (
                            <td
                              className={`green-bean-td-alma-ref muted${
                                almaRefChanged
                                  ? ' green-bean-alma-diff-cell--refresh-changed'
                                  : almaRefSamePartial
                                    ? ' green-bean-alma-diff-cell--refresh-same'
                                    : ''
                              }`}
                              title="공급처에 GSC와 알마 열이 있어야 차이를 볼 수 있습니다"
                            >
                              —
                            </td>
                          )
                        }
                        const almaVal = unitPriceForAutoPick(row.supplierPrices[almaIndex] ?? '')
                        const gscVal = unitPriceForAutoPick(row.supplierPrices[gscIndex] ?? '')
                        if (almaVal === null || gscVal === null) {
                          return (
                            <td
                              className={`green-bean-td-alma-ref green-bean-alma-diff-cell green-bean-alma-diff--na${
                                almaRefChanged
                                  ? ' green-bean-alma-diff-cell--refresh-changed'
                                  : almaRefSamePartial
                                    ? ' green-bean-alma-diff-cell--refresh-same'
                                    : ''
                              }`}
                            >
                              —
                            </td>
                          )
                        }
                        const diff = almaVal - gscVal
                        const diffCellClass =
                          diff === 0
                            ? 'green-bean-td-alma-ref green-bean-alma-diff-cell green-bean-alma-diff--same'
                            : diff < 0
                              ? 'green-bean-td-alma-ref green-bean-alma-diff-cell green-bean-alma-diff--cheaper'
                              : 'green-bean-td-alma-ref green-bean-alma-diff-cell green-bean-alma-diff--pricier'
                        return (
                          <td
                            className={`${diffCellClass}${
                              almaRefChanged
                                ? ' green-bean-alma-diff-cell--refresh-changed'
                                : almaRefSamePartial
                                  ? ' green-bean-alma-diff-cell--refresh-same'
                                  : ''
                            }`}
                          >
                            {diff === 0 ? (
                              <span className="muted">{formatDelta(diff, '원')}</span>
                            ) : (
                              <span
                                className={diff < 0 ? 'green-bean-delta-alma-cheaper' : 'green-bean-delta-alma-pricier'}
                              >
                                {formatDelta(diff, '원')}
                              </span>
                            )}
                          </td>
                        )
                      })()}
                    <td className="green-bean-td-num green-bean-td-inv-hint">
                      {!inventoryOrderHints.hasStoredPayload || inventoryOrderHints.loadError ? (
                        <span className="muted" title={inventoryHintBanner}>
                          —
                        </span>
                      ) : !keyName ? (
                        <span className="muted">—</span>
                      ) : !invMatch ? (
                        <span
                          className="muted"
                          title="입출고 생두명과 같게 쓰거나, greenBeanOrderInventoryAliases.ts에 주문명→생두명 별칭을 추가하면 연결됩니다."
                        >
                          —
                        </span>
                      ) : (
                        <span className="green-bean-inv-rec-value" title={invStockTitle}>
                          {formatHintKg(invMatch.endingStock)}
                        </span>
                      )}
                    </td>
                    <td className="green-bean-td-num">
                      <div className="green-bean-cell-stack green-bean-cell-stack--num">
                        <input
                          className="inventory-cell-input green-bean-input-num"
                          type="text"
                          inputMode="decimal"
                          value={row.quantityKg === 0 ? '' : String(row.quantityKg)}
                          onChange={(e) => updateRow(row.id, { quantityKg: parseNumber(e.target.value) })}
                        />
                        {compareMode && persisted.baseline && baseRow && (
                          <span
                            className={
                              row.quantityKg - baseRow.quantityKg > 0
                                ? 'green-bean-delta-pos'
                                : row.quantityKg - baseRow.quantityKg < 0
                                  ? 'green-bean-delta-neg'
                                  : 'muted tiny'
                            }
                          >
                            {row.quantityKg === baseRow.quantityKg
                              ? ''
                              : formatDelta(row.quantityKg - baseRow.quantityKg, ' kg')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="green-bean-td-source">
                      <div className="green-bean-source-buttons">
                        <button
                          type="button"
                          className={
                            (row.priceSource ?? 'auto') === 'auto'
                              ? 'green-bean-source-button green-bean-source-button--compact active'
                              : 'green-bean-source-button green-bean-source-button--compact'
                          }
                          title="공급처 열 중 숫자 단가가 가장 낮은 곳으로 총액을 맞춥니다. 같으면 왼쪽 열을 씁니다."
                          onClick={() => setRowPriceSource(row.id, 'auto')}
                        >
                          자동
                        </button>
                        {persisted.supplierLabels.map((label, si) => {
                          const fullLabel = label.trim() || `열 ${si + 1}`
                          return (
                            <button
                              key={si}
                              type="button"
                              className={
                                (row.priceSource ?? 'auto') === si
                                  ? 'green-bean-source-button green-bean-source-button--compact active'
                                  : 'green-bean-source-button green-bean-source-button--compact'
                              }
                              title={`${fullLabel} 단가 기준`}
                              onClick={() => setRowPriceSource(row.id, String(si))}
                            >
                              {formatSupplierSourceButtonLabel(label, si)}
                            </button>
                          )
                        })}
                      </div>
                    </td>
                    <td className="green-bean-td-num">
                      <div className="green-bean-cell-stack green-bean-cell-stack--num">
                        <span className="green-bean-line-total-value">{formatMoney(row.lineTotal)}</span>
                        {autoMode && (
                          <span
                            className="green-bean-auto-total-hint muted tiny"
                            title="자동: 숫자 단가가 가장 낮은 공급처 열을 씁니다. 같으면 왼쪽 열을 씁니다."
                          >
                            {autoPickedLabel ?? '단가 없음'}
                          </span>
                        )}
                        {compareMode && persisted.baseline && baseRow && (
                          <span
                            className={
                              row.lineTotal - baseRow.lineTotal > 0
                                ? 'green-bean-delta-pos'
                                : row.lineTotal - baseRow.lineTotal < 0
                                  ? 'green-bean-delta-neg'
                                  : 'muted tiny'
                            }
                          >
                            {row.lineTotal === baseRow.lineTotal
                              ? ''
                              : formatDelta(row.lineTotal - baseRow.lineTotal, '원')}
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td className="inventory-sticky-column green-bean-td-item green-bean-tfoot-label">
                  <div className="green-bean-tfoot-label-inner">
                    <strong className="green-bean-tfoot-label-main">합계</strong>
                    <span className="green-bean-tfoot-label-kg-title">키로수 합계</span>
                  </div>
                </td>
                {persisted.supplierLabels.map((_, i) => (
                  <td key={i} className="green-bean-td-price green-bean-tfoot-muted" aria-hidden />
                ))}
                {almaItems.length > 0 && <td className="green-bean-td-alma-ref green-bean-tfoot-muted" aria-hidden />}
                <td className="green-bean-td-num green-bean-td-inv-hint green-bean-tfoot-muted" aria-hidden />
                <td className="green-bean-td-num green-bean-tfoot-num green-bean-tfoot-qty-cell">
                  <strong className="green-bean-tfoot-qty-value">{formatKg(totals.sumQty)}</strong>
                  {baselineTotals && compareMode && persisted.baseline && (
                    <div className="green-bean-tfoot-delta muted tiny">
                      {formatDelta(totals.sumQty - baselineTotals.sumQty, ' kg')}
                    </div>
                  )}
                </td>
                <td className="green-bean-td-source green-bean-tfoot-muted" aria-hidden />
                <td className="green-bean-td-num green-bean-tfoot-num green-bean-tfoot-money-cell">
                  <div className="green-bean-tfoot-money-stack">
                    <div className="green-bean-tfoot-money-line" title="쿠폰·감면을 뺀 금액입니다.">
                      반영 {formatMoney(totals.sumMoney)}
                    </div>
                    {totals.sumDeductions > 0 ? (
                      <div className="green-bean-tfoot-money-line">소계 {formatMoney(totals.grossMoney)}</div>
                    ) : null}
                  </div>
                  {baselineTotals && compareMode && persisted.baseline && (
                    <div className="green-bean-tfoot-delta muted tiny">
                      {formatDelta(totals.grossMoney - baselineTotals.sumMoney, '원')}
                      <span className="green-bean-tfoot-delta-caption"> (품목 소계 기준)</span>
                    </div>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
          <div className="green-bean-deduction-panel">
            <h3 className="green-bean-deduction-title">쿠폰 · 감면 (원)</h3>
            <div className="green-bean-deduction-grid">
              <label className="green-bean-deduction-field">
                <span>알마씨엘로 차감</span>
                <input
                  className="expense-input green-bean-deduction-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={persisted.orderDeductions.almaWon === 0 ? '' : String(persisted.orderDeductions.almaWon)}
                  onChange={(e) => {
                    const almaWon = Math.max(0, parseNumber(e.target.value))
                    setPersisted((p) => ({
                      ...p,
                      orderDeductions: { ...p.orderDeductions, almaWon },
                    }))
                  }}
                />
              </label>
              <label className="green-bean-deduction-field">
                <span>GSC 차감</span>
                <input
                  className="expense-input green-bean-deduction-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={persisted.orderDeductions.gscWon === 0 ? '' : String(persisted.orderDeductions.gscWon)}
                  onChange={(e) => {
                    const gscWon = Math.max(0, parseNumber(e.target.value))
                    setPersisted((p) => ({
                      ...p,
                      orderDeductions: { ...p.orderDeductions, gscWon },
                    }))
                  }}
                />
              </label>
              <label className="green-bean-deduction-field">
                <span>기타 감면</span>
                <input
                  className="expense-input green-bean-deduction-input"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={persisted.orderDeductions.otherWon === 0 ? '' : String(persisted.orderDeductions.otherWon)}
                  onChange={(e) => {
                    const otherWon = Math.max(0, parseNumber(e.target.value))
                    setPersisted((p) => ({
                      ...p,
                      orderDeductions: { ...p.orderDeductions, otherWon },
                    }))
                  }}
                />
              </label>
            </div>
            {totals.sumDeductions > 0 ? (
              <p className="green-bean-deduction-summary">
                품목 소계 <strong>{formatMoney(totals.grossMoney)}</strong>
                <span className="green-bean-deduction-summary-sep"> − </span>
                감면 <strong>{formatMoney(totals.sumDeductions)}</strong>
                <span className="green-bean-deduction-summary-sep"> = </span>
                반영 <strong>{formatMoney(totals.sumMoney)}</strong>
              </p>
            ) : null}
            <div
              className="green-bean-deduction-snapshot-block"
              title="주문이 있었던 날짜를 고르고 저장합니다. 같은 날짜에 다시 저장하면 덮어씁니다. 월별 그래프는 같은 달의 일자별 기록을 합산합니다."
            >
              <h4 className="green-bean-snapshot-section-title">일자 기록</h4>
              <div className="green-bean-snapshot-controls-row">
                <label className="green-bean-month-field green-bean-month-field--inline">
                  <span>주문 일자</span>
                  <input
                    type="date"
                    className="expense-input green-bean-month-input green-bean-month-input--compact"
                    value={recordDate}
                    onChange={(e) => setRecordDate(e.target.value)}
                  />
                </label>
                <div className="green-bean-month-actions">
                  <button
                    type="button"
                    className="primary-button green-bean-month-primary"
                    onClick={handleAddOrderSnapshot}
                    title="현재 주문표 합계를 선택한 일자로 저장합니다. 같은 날짜는 덮어씁니다."
                  >
                    이 날짜로 기록
                  </button>
                  <button
                    type="button"
                    className="ghost-button green-bean-month-delete-btn"
                    onClick={handleRemoveSelectedDateRecord}
                    disabled={!hasRecordForSelectedDate}
                    title={
                      hasRecordForSelectedDate
                        ? `${formatOrderDateLabel(recordDate)} 저장분만 삭제합니다.`
                        : '이 날짜에 저장된 기록이 없습니다.'
                    }
                  >
                    이 날짜 삭제
                  </button>
                </div>
              </div>
              <label className="green-bean-snapshot-memo-field green-bean-snapshot-memo-field--in-panel">
                <span>기록 메모 (선택)</span>
                <textarea
                  className="expense-input green-bean-snapshot-memo-input green-bean-snapshot-memo-input--compact"
                  rows={2}
                  maxLength={500}
                  value={snapshotMemoDraft}
                  onChange={(e) => setSnapshotMemoDraft(e.target.value.slice(0, 500))}
                  placeholder="예: 알마 쿠폰 적용, 분할 입고 등"
                  title="이 날짜로 저장할 때 함께 보관됩니다. 최대 500자입니다."
                />
              </label>
            </div>
          </div>
        </div>

        {removedBaselineNames.length > 0 && (
          <div className="green-bean-removed-panel">
            <h3>기준에는 있었지만 현재 표에서 빠진 품목</h3>
            <ul>
              {removedBaselineNames.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="panel green-bean-chart-panel">
        <div className="panel-header green-bean-chart-panel-header">
          <h2>월별 추이</h2>
        </div>

        {chartRows.length === 0 ? (
          <p className="green-bean-chart-empty muted">
            기록이 없습니다. 위 주문표의 「일자 기록」에서 날짜를 고른 뒤 「이 날짜로 기록」을 누르세요.
          </p>
        ) : (
          <div className="green-bean-overview-grid">
            {monthlyOverviewCards.map((card) => (
              <section key={card.id} className="green-bean-overview-card">
                <div className="green-bean-overview-header">
                  <h3 className="green-bean-chart-title green-bean-overview-card-title">{card.title}</h3>
                  <span
                    className={
                      card.deltaPositive ? 'green-bean-overview-delta green-bean-overview-delta--up' : 'green-bean-overview-delta green-bean-overview-delta--down'
                    }
                    title={previousMonthlyRow ? `최신 ${card.latestLabel} vs 직전 월` : undefined}
                  >
                    {card.deltaText}
                  </span>
                </div>
                <div className="green-bean-overview-kpis">
                  <div className="green-bean-overview-kpi">
                    <span>최신 ({card.latestLabel})</span>
                    <strong>{card.latestValue}</strong>
                  </div>
                  <div className="green-bean-overview-kpi">
                    <span>직전 월</span>
                    <strong>{card.previousValue}</strong>
                  </div>
                </div>
                <div className="green-bean-chart-canvas green-bean-chart-canvas--overview">
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={chartRows} margin={{ top: 10, right: 12, left: 4, bottom: 8 }}>
                      <defs>
                        <linearGradient id={`green-bean-${card.id}-fill`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={card.areaColor} stopOpacity={0.26} />
                          <stop offset="100%" stopColor={card.areaColor} stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                      <XAxis dataKey="monthLabel" tick={{ fontSize: 11 }} tickLine={false} />
                      <YAxis
                        tickFormatter={(v) =>
                          card.id === 'qty' ? currencyFormatter.format(Number(v ?? 0)) : formatAxisMoney(Number(v))
                        }
                        width={56}
                        tick={{ fontSize: 10 }}
                      />
                      <Tooltip
                        contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0' }}
                        formatter={(value) => {
                          const v = Number(value ?? 0)
                          return [card.id === 'qty' ? `${currencyFormatter.format(v)} kg` : formatMoney(v), card.title]
                        }}
                        labelFormatter={(label) => `${label}`}
                      />
                      <Area
                        type="monotone"
                        dataKey={card.lineKey}
                        stroke={card.areaColor}
                        strokeWidth={2.5}
                        fill={`url(#green-bean-${card.id}-fill)`}
                        fillOpacity={1}
                        dot={{ r: 3, strokeWidth: 1.5, fill: '#fff' }}
                        activeDot={{ r: 5 }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
            ))}
          </div>
        )}

        {chartRows.length > 0 && (
          <div className="green-bean-per-item-section">
            <h3 className="green-bean-chart-title green-bean-per-item-section-title">원두별 추이</h3>
            {!hasPerItemSnapshots ? (
              <p className="muted green-bean-per-item-empty">
                원별 선이 없으면 위 「일자 기록」에서 「이 날짜로 기록」을 다시 눌러 저장하세요.
              </p>
            ) : (
              <>
                <div className="green-bean-per-item-toolbar">
                  <div className="green-bean-per-item-tabs">
                    <button
                      type="button"
                      className={perItemMetric === 'qty' ? 'green-bean-per-item-tab active' : 'green-bean-per-item-tab'}
                      onClick={() => setPerItemMetric('qty')}
                    >
                      수량
                    </button>
                    <button
                      type="button"
                      className={perItemMetric === 'money' ? 'green-bean-per-item-tab active' : 'green-bean-per-item-tab'}
                      onClick={() => setPerItemMetric('money')}
                    >
                      총액
                    </button>
                  </div>
                </div>
                <div className="green-bean-per-item-layout">
                  <aside className="green-bean-per-item-sidebar">
                    <div className="green-bean-per-item-quick-actions">
                      <button type="button" className="ghost-button small-hit" onClick={() => setVisibleRankedItemSeries(5)}>
                        상위 5
                      </button>
                      <button type="button" className="ghost-button small-hit" onClick={() => setVisibleRankedItemSeries(8)}>
                        상위 8
                      </button>
                      <button type="button" className="ghost-button small-hit" onClick={() => setVisibleRankedItemSeries('all')}>
                        전체
                      </button>
                    </div>
                    <div className="green-bean-per-item-list" aria-label="표시할 원두 선택">
                      {rankedItemSeries.map((series, index) => {
                        const active = visibleItemKeys.includes(series.key)
                        const metricValue = perItemMetric === 'qty' ? formatKg(series.latestQty) : formatMoney(series.latestMoney)
                        const metricDelta = perItemMetric === 'qty' ? formatSignedNumber(series.qtyDelta, ' kg') : formatSignedNumber(series.moneyDelta, '원')
                        const deltaPositive = perItemMetric === 'qty' ? series.qtyDelta >= 0 : series.moneyDelta >= 0
                        return (
                          <button
                            key={series.key}
                            type="button"
                            className={active ? 'green-bean-per-item-row active' : 'green-bean-per-item-row'}
                            aria-pressed={active}
                            onClick={() => togglePerItemSeries(series.key)}
                            style={active ? { borderColor: series.color, boxShadow: `inset 3px 0 0 ${series.color}` } : undefined}
                          >
                            <div className="green-bean-per-item-row-main">
                              <span className="green-bean-per-item-rank">{index + 1}</span>
                              <span className="green-bean-per-item-row-dot" style={{ backgroundColor: series.color }} />
                              <span className="green-bean-per-item-row-name">{series.label}</span>
                            </div>
                            <div className="green-bean-per-item-row-metrics">
                              <strong>{metricValue}</strong>
                              <span
                                className={
                                  deltaPositive
                                    ? 'green-bean-per-item-row-delta green-bean-per-item-row-delta--up'
                                    : 'green-bean-per-item-row-delta green-bean-per-item-row-delta--down'
                                }
                              >
                                {previousMonthlyRow ? metricDelta : '—'}
                              </span>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </aside>
                  <div className="green-bean-per-item-chart-card">
                    <div className="green-bean-per-item-chart-header">
                      <h4 className="green-bean-per-item-subtitle">
                        {perItemMetric === 'qty' ? '수량 (kg)' : '총액'}
                      </h4>
                      <span className="green-bean-per-item-count">{visibleItemSeries.length}개</span>
                    </div>
                    <div className="green-bean-chart-canvas green-bean-chart-canvas--multi">
                      <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={perItemMultiChartRows} margin={{ top: 10, right: 16, left: 4, bottom: 10 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                          <XAxis dataKey="monthLabel" tick={{ fontSize: 11 }} tickLine={false} />
                          <YAxis
                            tickFormatter={(v) =>
                              perItemMetric === 'qty'
                                ? currencyFormatter.format(Number(v ?? 0))
                                : formatAxisMoney(Number(v))
                            }
                            width={56}
                            tick={{ fontSize: 10 }}
                          />
                          <Tooltip
                            shared={false}
                            contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0' }}
                            formatter={(value, name) => {
                              const v = Number(value ?? 0)
                              return [
                                perItemMetric === 'qty' ? `${currencyFormatter.format(v)} kg` : formatMoney(v),
                                String(name),
                              ]
                            }}
                            labelFormatter={(label) => String(label)}
                          />
                          {visibleItemSeries.map(({ label, qtyField, moneyField, color }) => (
                            <Line
                              key={perItemMetric === 'qty' ? qtyField : moneyField}
                              type="linear"
                              dataKey={perItemMetric === 'qty' ? qtyField : moneyField}
                              name={label}
                              stroke={color}
                              strokeWidth={2.5}
                              dot={{ r: 3, strokeWidth: 1.5, fill: '#fff' }}
                              activeDot={{ r: 5 }}
                            />
                          ))}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {chartRows.length > 0 && (
          <div className="green-bean-history-table-wrap">
            <div className="green-bean-history-heading-row">
              <h3 className="green-bean-history-heading">일자별 저장 내역</h3>
              <button
                type="button"
                className="ghost-button small-hit green-bean-history-clear-all"
                onClick={handleClearAllOrderSnapshots}
                title="저장된 모든 일자 기록을 한 번에 삭제합니다."
              >
                전부 삭제
              </button>
            </div>
            <p className="muted tiny green-bean-history-hint">
              아래는 날짜마다 저장한 건입니다. 위 월별 그래프·원두별 추이는 같은 달에 저장된 건을 합산한 값입니다.
            </p>
            <div className="green-bean-history-scroll">
              <table className="meeting-table green-bean-history-table">
                <thead>
                  <tr>
                    <th scope="col">주문 일자</th>
                    <th scope="col">저장 시각</th>
                    <th scope="col">품목 수</th>
                    <th scope="col">수량</th>
                    <th scope="col">품목 소계</th>
                    <th scope="col">감면</th>
                    <th scope="col">반영 총액</th>
                    <th scope="col">메모</th>
                    <th scope="col" className="green-bean-history-actions">
                      {'\u00a0'}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {orderHistoryTableRows.map((row) => (
                    <tr key={row.id}>
                      <td>{formatOrderDateLabel(row.orderDate)}</td>
                      <td>{new Date(row.savedAt).toLocaleString('ko-KR')}</td>
                      <td>{row.itemCount}개</td>
                      <td>{formatKg(row.sumQty)}</td>
                      <td>{formatMoney(snapshotGrossMoney(row))}</td>
                      <td className="green-bean-history-deduction-cell">{snapshotDeductionSummary(row)}</td>
                      <td>{formatMoney(row.sumMoney)}</td>
                      <td className="green-bean-history-memo-cell">
                        {row.memo?.trim() ? (
                          <span title={row.memo.trim()}>{row.memo.trim()}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="green-bean-history-actions">
                        <button
                          type="button"
                          className="ghost-button small-hit"
                          title="이 일자에 저장한 기록만 삭제합니다."
                          onClick={() => handleRemoveOrderSnapshot(row.id)}
                        >
                          삭제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
