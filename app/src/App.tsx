import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ExcelJS from 'exceljs'
import BeanSalesAnalysisPage from './BeanSalesAnalysisPage'
import ExpensePage, { EXPENSE_PAGE_STORAGE_KEY } from './ExpensePage'
import MemoPage, { MEMO_PAGE_STORAGE_KEY } from './MemoPage'
import TeamManagementPage from './TeamManagementPage'
import GreenBeanOrderPage, { GREEN_BEAN_ORDER_STORAGE_KEY } from './GreenBeanOrderPage'
import StaffPayrollPage, { STAFF_PAYROLL_STORAGE_KEY } from './StaffPayrollPage.tsx'
import InventoryStatusPage, {
  getLowGreenBeanWarningItems,
  INVENTORY_STATUS_CACHE_EVENT,
  INVENTORY_AUTO_STOCK_MODE_KEY,
  INVENTORY_STATUS_BASELINE_STORAGE_KEY,
  INVENTORY_STATUS_STORAGE_KEY,
  INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY,
  INVENTORY_STATUS_TEMPLATE_STORAGE_KEY,
  inventoryPageScopedKey,
  type LowGreenBeanWarningItem,
} from './InventoryStatusPage'
import { normalizeInventoryStatusState } from './inventoryStatusUtils'
import MonthlyMeetingPage, {
  MONTHLY_MEETING_DATA_KEY,
  STATEMENT_RECORDS_SAVED_EVENT,
  STATEMENT_RECORDS_STORAGE_KEY,
} from './MonthlyMeetingPage'
import { ADMIN_FOUR_DIGIT_PIN } from './adminPin.ts'
import {
  buildStyledStatementInputListBuffer,
  buildStyledStatementMonthlySummaryBuffer,
  statementInputListDefaultColumnWidths,
} from './statementExcelStyledExport.ts'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument, saveCompanyDocument } from './lib/companyDocuments'
import { readStatementRecordsFromLocalStorage, writeStatementRecordsToMirror } from './statementRecordsMirror'
import { useDocumentSaveUi } from './lib/documentSaveUi'
import { useAppRuntime } from './providers/AppRuntimeProvider.tsx'
import './App.css'

const STORAGE_KEY = STATEMENT_RECORDS_STORAGE_KEY
const PRICING_RULES_STORAGE_KEY = 'pricing-rules-v1'
const MASTER_ITEMS_STORAGE_KEY = 'master-items-v1'
const ACTIVE_PAGE_STORAGE_KEY = 'active-page-v1'
const STATEMENT_TEMPLATE_STORAGE_KEY = 'statement-template-base64-v1'
const STATEMENT_TEMPLATE_NAME_STORAGE_KEY = 'statement-template-name-v1'
const STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY = 'statement-template-updated-at-v1'
const STATEMENT_TEMPLATE_SETTINGS_STORAGE_KEY = 'statement-template-settings-v1'
const CURRENT_YEAR = new Date().getFullYear()
const MONTH_LABELS = Array.from({ length: 12 }, (_, index) => `${index + 1}월`)

type AppActivePage =
  | 'statements'
  | 'beanSalesAnalysis'
  | 'meeting'
  | 'inventory'
  | 'expense'
  | 'staffPayroll'
  | 'greenBeanOrder'
  | 'memo'
  | 'dailyMeeting'
  | 'team'

type PageCategoryId = 'trade' | 'closing' | 'supply' | 'org'

const PAGE_CATEGORY_GROUPS: {
  id: PageCategoryId
  label: string
  pages: { page: AppActivePage; label: string }[]
}[] = [
  { 
    id: 'trade', 
    label: '거래·명세', 
    pages: [
      { page: 'statements', label: '거래명세 관리' },
      { page: 'beanSalesAnalysis', label: '원두별 매출 분석' }
    ] 
  },
  {
    id: 'closing',
    label: '마감·지출',
    pages: [
      { page: 'expense', label: '지출표' },
      { page: 'meeting', label: '월 마감회의' },
    ],
  },
  {
    id: 'supply',
    label: '재고·생두',
    pages: [
      { page: 'inventory', label: '입출고 현황' },
      { page: 'greenBeanOrder', label: '생두 주문' },
    ],
  },
  {
    id: 'org',
    label: '직원·메모',
    pages: [
      { page: 'dailyMeeting', label: '일일회의' },
      { page: 'staffPayroll', label: '직원·급여' },
      { page: 'team', label: '팀 관리' },
    ],
  },
]

const PAGE_HEADER_META: Record<AppActivePage, { title: string; description: string }> = {
  statements: {
    title: '거래명세 관리',
    description: '거래명세 입력, 단가 관리, 월별 납품현황을 한 화면에서 이어서 관리합니다.',
  },
  beanSalesAnalysis: {
    title: '원두별 매출 분석',
    description: '거래명세서 데이터를 기반으로 원두별 매출과 수익성을 분석합니다.',
  },
  meeting: {
    title: '월 마감회의',
    description: '월 요약, 비용 현황, 생산과 판매 지표를 한 번에 정리하는 회의 화면입니다.',
  },
  inventory: {
    title: '입출고 현황',
    description: '입고·생산·출고 흐름과 재고 기준일을 같은 맥락으로 확인합니다.',
  },
  expense: {
    title: '지출표',
    description: '월별 지출 내역과 결제 상태, 비용 합계를 빠르게 정리합니다.',
  },
  staffPayroll: {
    title: '직원·급여',
    description: '직원 정보와 월 지급액, 수정 잠금 상태를 함께 관리합니다.',
  },
  greenBeanOrder: {
    title: '생두 주문',
    description: '생두 주문, 가격 비교, 재고 연동 정보를 한곳에서 확인합니다.',
  },
  memo: {
    title: '메모',
    description: '업무 메모와 링크 메모를 한곳에서 관리합니다.',
  },
  dailyMeeting: {
    title: '일일회의',
    description: '당일 메모와 회의 정리를 빠르게 남기고 이어서 확인합니다.',
  },
  team: {
    title: '팀 관리',
    description: '회사 구성원 계정을 만들고 역할과 연락처를 관리합니다.',
  },
}

/** `#root … > header`(app-home-shell) 안 전체 너비 히어로 — 각 화면 본문의 hero-panel과 중복되지 않게 여기만 사용 */
const WORKSPACE_SHELL_PAGE_HERO: Record<
  AppActivePage,
  { headline: string; copyLocal: string; copyCloud: string }
> = {
  statements: {
    headline: '거래명세서 입력 및 월별 납품현황 관리',
    copyLocal:
      '거래명세서를 먼저 입력하고, 같은 데이터를 기반으로 월별 납품현황을 자동 집계할 수 있게 만든 화면입니다. 저장 데이터는 현재 브라우저에만 보관됩니다.',
    copyCloud:
      '거래명세, 단가표, 템플릿 설정이 같은 회사 문서로 함께 동기화됩니다. 입력 내용은 다른 기기에서도 이어서 확인할 수 있습니다.',
  },
  beanSalesAnalysis: {
    headline: '원두별 매출 및 수익성 분석',
    copyLocal:
      '거래명세서와 생두 주문 데이터를 연동해 원두별 매출, 원가, 수익을 분석합니다. 데이터는 현재 브라우저에 저장됩니다.',
    copyCloud:
      '거래명세서와 생두 주문 데이터를 연동해 원두별 매출, 원가, 수익을 분석합니다. 회사 문서로 동기화되어 팀원과 공유할 수 있습니다.',
  },
  expense: {
    headline: '지출표 관리',
    copyLocal:
      '건별 입력·엑셀 반영이 가능하고, 데이터는 이 브라우저에만 저장됩니다. 아래 표·요약은 같은 조건으로 맞춰집니다.',
    copyCloud:
      '건별 입력·엑셀 반영이 가능합니다. 회사 문서로 동기화되면 팀·다른 기기에서도 같은 지출표를 이어서 볼 수 있습니다.',
  },
  inventory: {
    headline: '생두 / 로스팅 현황',
    copyLocal:
      '입고·생산·출고 흐름과 재고 기준일을 같은 맥락으로 확인합니다. 저장 데이터는 이 브라우저에만 보관될 수 있습니다.',
    copyCloud:
      '입고·생산·출고 흐름과 재고 기준일을 같은 맥락으로 확인합니다. 회사 문서로 동기화되면 팀과 같은 재고 표를 공유합니다.',
  },
  meeting: {
    headline: '월 마감회의',
    copyLocal:
      '월별 회의 내용을 입력하면 합계와 점유비가 자동 계산되도록 정리했습니다. 상단 두 번째 숫자는 입금 합계에서 출금 합계를 뺀 입출금 순손익으로, 1번 요약 맨 아래 표와 같습니다.',
    copyCloud:
      '월별 회의 내용을 입력하면 합계와 점유비가 자동 계산되도록 정리했습니다. 회의 문서가 클라우드에 있으면 팀과 함께 수정·확인할 수 있습니다.',
  },
  staffPayroll: {
    headline: '직원·급여·근무',
    copyLocal:
      '매장명·직책·부서·월 급여·지급일·재직 여부를 한곳에 적어 두는 용도입니다. 3.3%·4대보험은 단순 추정이며, 실제 세액·보험과 다를 수 있습니다. 데이터는 이 브라우저에만 저장될 수 있습니다.',
    copyCloud:
      '매장명·직책·부서·월 급여·지급일·재직 여부를 한곳에 적어 두는 용도입니다. 3.3%·4대보험은 단순 추정이며, 실제 세액·보험과 다를 수 있습니다. 회사 문서로 동기화되면 팀과 공유할 수 있습니다.',
  },
  greenBeanOrder: {
    headline: '생두 주문',
    copyLocal:
      '생두 주문, 가격 비교, 재고 연동 정보를 한곳에서 확인합니다. 저장 데이터는 이 브라우저에만 보관될 수 있습니다.',
    copyCloud:
      '생두 주문, 가격 비교, 재고 연동 정보를 한곳에서 확인합니다. 회사 문서로 동기화되면 주문표를 팀과 함께 관리할 수 있습니다.',
  },
  memo: {
    headline: '메모',
    copyLocal: `${PAGE_HEADER_META.memo.description} 이 브라우저에만 저장될 수 있습니다.`,
    copyCloud: `${PAGE_HEADER_META.memo.description} 회사 문서로 동기화되면 팀과 공유할 수 있습니다.`,
  },
  dailyMeeting: {
    headline: '일일회의',
    copyLocal: `${PAGE_HEADER_META.dailyMeeting.description} 이 브라우저에만 저장될 수 있습니다.`,
    copyCloud: `${PAGE_HEADER_META.dailyMeeting.description} 회사 문서로 동기화되면 팀과 공유할 수 있습니다.`,
  },
  team: {
    headline: '팀 관리',
    copyLocal: `${PAGE_HEADER_META.team.description} 이 브라우저에만 저장될 수 있습니다.`,
    copyCloud: `${PAGE_HEADER_META.team.description} 클라우드 회사에서 구성원을 함께 관리합니다.`,
  },
}

function categoryIdForPage(page: AppActivePage): PageCategoryId {
  for (const g of PAGE_CATEGORY_GROUPS) {
    if (g.pages.some((p) => p.page === page)) {
      return g.id
    }
  }
  return 'trade'
}
const currencyFormatter = new Intl.NumberFormat('ko-KR')
const CUSTOM_CLIENT_OPTION = '__custom_client__'
const CUSTOM_ITEM_OPTION = '__custom__'
/** 거래 품목 셀렉트: 코드에 샘플 품목을 넣지 않고, 품목 마스터·단가·납품 기록에서만 옵션을 만든다. */
const DEFAULT_ITEM_OPTIONS = [] as const
const DEFAULT_SPEC_OPTIONS = ['1/KG', '200/G', '1/L', '500/ML', '250/ML'] as const
const NOTE_OPTIONS = ['부가세 별도', '부가세 없음'] as const
const STATEMENT_PREVIEW_LABEL = '공급받는자용'
const QUICK_SPEC_OPTIONS_BEAN = [
  { label: '1kg', value: '1/KG' },
  { label: '200g', value: '200/G' },
] as const
const QUICK_SPEC_OPTIONS_DUTCH = [
  { label: '250ml', value: '250/ML' },
  { label: '500ml', value: '500/ML' },
  { label: '1L', value: '1/L' },
] as const
const QUICK_SPEC_OPTIONS = [...QUICK_SPEC_OPTIONS_BEAN, ...QUICK_SPEC_OPTIONS_DUTCH] as const
const QUICK_SPEC_VALUES = new Set<string>(QUICK_SPEC_OPTIONS.map((option) => option.value))
const isDutchItemName = (value: string) => /더치|dutch|cold.?brew|콜드브루/i.test(value)

type StatementRecord = {
  id: string
  deliveryDate: string
  issueDate: string
  paymentDate: string
  deliveryCount: string
  clientName: string
  itemName: string
  specUnit: string
  quantity: number
  unitPrice: number
  note: string
  supplyAmount: number
  taxAmount: number
  totalAmount: number
  /** 이분 기준 월·번 순: 마지막으로 저장한 건이 해당 월에서 가장 큰 번호 */
  savedAt?: string
}

type FormState = {
  deliveryDate: string
  deliveryCount: string
  clientName: string
  itemName: string
  specUnit: string
  quantity: string
  unitPrice: string
  note: string
}

type MonthlySummaryRow = {
  clientName: string
  totalAmount: number
  share: number
  months: {
    amount: number
    issueDate: string
    paymentDate: string
  }[]
}

type PricingRule = {
  id: string
  clientName: string
  itemName: string
  specUnit: string
  unitPrice: number
}

/** 품목 마스터 (거래처 공통 기본 단가). 거래처별 단가표가 없을 때 이 값을 자동 적용합니다. */
type MasterItem = {
  id: string
  itemName: string
  specUnit: string
  unitPrice: number
}

type StatementSheetGroup = {
  key: string
  deliveryDate: string
  issueDate: string
  clientName: string
  deliveryCount: string
  records: StatementRecord[]
  supplyAmount: number
  taxAmount: number
  totalAmount: number
}

type AppBackupPayload = {
  version: 2
  savedAt: string
  records: StatementRecord[]
  pricingRules: PricingRule[]
  activePage?: AppActivePage
  monthlyMeetingState?: string
  inventoryState?: string
  inventoryBaselineState?: string
  inventoryTemplateBase64?: string
  inventoryTemplateFileName?: string
  inventoryAutoStockMode?: boolean
  expenseState?: string
  staffPayrollState?: string
  greenBeanOrderState?: string
  memoState?: string
  statementTemplateBase64?: string
  statementTemplateFileName?: string
  statementTemplateUpdatedAt?: string
  statementTemplateSettings?: string
}

type StatementTemplateSettings = {
  businessNumber: string
  companyName: string
  ownerName: string
  address: string
  businessType: string
  businessItem: string
  phone: string
  account: string
}

type StatementPageDocument = {
  records: StatementRecord[]
  pricingRules: PricingRule[]
  masterItems: MasterItem[]
  statementTemplateBase64: string | null
  statementTemplateFileName: string
  statementTemplateUpdatedAt: string
  statementTemplateSettings: StatementTemplateSettings
}

/** 클라우드 자동저장: 내용이 직전 성공 본과 같으면 dirty/저장 스케줄을 생략(원격·탭 복제 시 루프 방지) */
const statementPageDocumentPayloadSig = (doc: StatementPageDocument): string =>
  JSON.stringify({
    records: doc.records,
    pricingRules: doc.pricingRules,
    masterItems: doc.masterItems,
    statementTemplateBase64: doc.statementTemplateBase64,
    statementTemplateFileName: doc.statementTemplateFileName,
    statementTemplateUpdatedAt: doc.statementTemplateUpdatedAt,
    statementTemplateSettings: doc.statementTemplateSettings,
  })

const DEFAULT_STATEMENT_TEMPLATE_SETTINGS: StatementTemplateSettings = {
  businessNumber: '560.17.02264',
  companyName: '이오도',
  ownerName: '유성덕',
  address: '부산시 남구 용소로34번길 24-6',
  businessType: '제조업',
  businessItem: '커피차',
  phone: '051.621.9771',
  account: '부산은행 101.2087.7763.06 / 이오도 유성덕',
}

const today = new Date().toISOString().slice(0, 10)

const defaultFormState = (): FormState => ({
  deliveryDate: today,
  deliveryCount: '1',
  clientName: '',
  itemName: '',
  specUnit: '',
  quantity: '',
  unitPrice: '',
  note: '부가세 별도',
})

const parseNumber = (value: string) => {
  const normalized = value.replaceAll(',', '').trim()
  return normalized ? Number(normalized) : 0
}

/** 엑셀에 넣을 `Date`. 자정(로컬)만 쓰면 ExcelJS가 UTC로 바꿀 때 전날로 떨어져 하루 적게 찍히는 경우가 있어 정오(로컬)로 고정합니다. */
const parseIsoDateToDate = (value: string) => {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, (month || 1) - 1, day || 1, 12, 0, 0, 0)
}

const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  let binary = ''

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }

  return window.btoa(binary)
}

const base64ToUint8Array = (value: string) => {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}

const toArrayBuffer = (value: ArrayBuffer | Uint8Array) => {
  if (value instanceof ArrayBuffer) {
    return value
  }

  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

const downloadExcelBuffer = (buffer: ArrayBuffer | Uint8Array, filename: string) => {
  const blob = new Blob([toArrayBuffer(buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = window.URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.URL.revokeObjectURL(url)
}

const normalizeStatementTemplateSettings = (value: unknown): StatementTemplateSettings => {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_STATEMENT_TEMPLATE_SETTINGS }
  }

  const source = value as Partial<StatementTemplateSettings>
  return {
    businessNumber: String(source.businessNumber ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.businessNumber),
    companyName: String(source.companyName ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.companyName),
    ownerName: String(source.ownerName ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.ownerName),
    address: String(source.address ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.address),
    businessType: String(source.businessType ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.businessType),
    businessItem: String(source.businessItem ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.businessItem),
    phone: String(source.phone ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.phone),
    account: String(source.account ?? DEFAULT_STATEMENT_TEMPLATE_SETTINGS.account),
  }
}

const readStatementPageLocalState = (): StatementPageDocument => {
  /** `statementRecordsMirror`·원두별 매출과 동일 키/동일 읽기 — 로컬 한 벌만 쓴다 */
  const rawRows = readStatementRecordsFromLocalStorage<StatementRecord & { note?: string }>()
  const records: StatementRecord[] = rawRows.length
    ? normalizeLoadedRecords(rawRows)
    : []

  let pricingRules: PricingRule[] = []
  const savedPricingRules = window.localStorage.getItem(PRICING_RULES_STORAGE_KEY)
  if (savedPricingRules) {
    try {
      pricingRules = JSON.parse(savedPricingRules) as PricingRule[]
    } catch (error) {
      console.error('저장된 단가표를 읽지 못했습니다.', error)
    }
  }

  let masterItems: MasterItem[] = []
  const savedMasterItems = window.localStorage.getItem(MASTER_ITEMS_STORAGE_KEY)
  if (savedMasterItems) {
    try {
      masterItems = normalizeMasterItemsList(JSON.parse(savedMasterItems))
    } catch (error) {
      console.error('저장된 품목 마스터를 읽지 못했습니다.', error)
    }
  }

  let statementTemplateSettings = { ...DEFAULT_STATEMENT_TEMPLATE_SETTINGS }
  const savedStatementTemplateSettings = window.localStorage.getItem(STATEMENT_TEMPLATE_SETTINGS_STORAGE_KEY)
  if (savedStatementTemplateSettings) {
    try {
      statementTemplateSettings = normalizeStatementTemplateSettings(JSON.parse(savedStatementTemplateSettings))
    } catch {
      statementTemplateSettings = { ...DEFAULT_STATEMENT_TEMPLATE_SETTINGS }
    }
  }

  return {
    records,
    pricingRules,
    masterItems,
    statementTemplateBase64: window.localStorage.getItem(STATEMENT_TEMPLATE_STORAGE_KEY),
    statementTemplateFileName: window.localStorage.getItem(STATEMENT_TEMPLATE_NAME_STORAGE_KEY) ?? '',
    statementTemplateUpdatedAt: window.localStorage.getItem(STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY) ?? '',
    statementTemplateSettings,
  }
}

const writeStatementPageLocalState = (doc: StatementPageDocument) => {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc.records))
  window.localStorage.setItem(PRICING_RULES_STORAGE_KEY, JSON.stringify(doc.pricingRules))
  window.localStorage.setItem(MASTER_ITEMS_STORAGE_KEY, JSON.stringify(doc.masterItems))
  if (doc.statementTemplateBase64) {
    window.localStorage.setItem(STATEMENT_TEMPLATE_STORAGE_KEY, doc.statementTemplateBase64)
  } else {
    window.localStorage.removeItem(STATEMENT_TEMPLATE_STORAGE_KEY)
  }
  if (doc.statementTemplateFileName) {
    window.localStorage.setItem(STATEMENT_TEMPLATE_NAME_STORAGE_KEY, doc.statementTemplateFileName)
  } else {
    window.localStorage.removeItem(STATEMENT_TEMPLATE_NAME_STORAGE_KEY)
  }
  if (doc.statementTemplateUpdatedAt) {
    window.localStorage.setItem(STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY, doc.statementTemplateUpdatedAt)
  } else {
    window.localStorage.removeItem(STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY)
  }
  window.localStorage.setItem(STATEMENT_TEMPLATE_SETTINGS_STORAGE_KEY, JSON.stringify(doc.statementTemplateSettings))
  window.dispatchEvent(new Event(STATEMENT_RECORDS_SAVED_EVENT))
}

const normalizeMasterItemsList = (value: unknown): MasterItem[] => {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const next: MasterItem[] = []
  value.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return
    }
    const item = entry as Partial<MasterItem>
    const itemName = typeof item.itemName === 'string' ? item.itemName.trim() : ''
    if (!itemName) {
      return
    }
    const key = itemName.replace(/\s+/g, ' ').toLowerCase()
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    next.push({
      id: typeof item.id === 'string' && item.id ? item.id : `master-${Date.now()}-${index}`,
      itemName,
      specUnit: typeof item.specUnit === 'string' ? item.specUnit.trim() : '',
      unitPrice: typeof item.unitPrice === 'number' && Number.isFinite(item.unitPrice) ? item.unitPrice : 0,
    })
  })
  return next
}

const normalizeStatementPageDocument = (value: unknown): StatementPageDocument => {
  if (!value || typeof value !== 'object') {
    return {
      records: [],
      pricingRules: [],
      masterItems: [],
      statementTemplateBase64: null,
      statementTemplateFileName: '',
      statementTemplateUpdatedAt: '',
      statementTemplateSettings: { ...DEFAULT_STATEMENT_TEMPLATE_SETTINGS },
    }
  }

  const source = value as Partial<StatementPageDocument>
  return {
    records: Array.isArray(source.records)
      ? normalizeLoadedRecords(source.records as Array<StatementRecord & { note?: string }>)
      : [],
    pricingRules: Array.isArray(source.pricingRules) ? (source.pricingRules as PricingRule[]) : [],
    masterItems: normalizeMasterItemsList(source.masterItems),
    statementTemplateBase64:
      typeof source.statementTemplateBase64 === 'string' && source.statementTemplateBase64.length > 0
        ? source.statementTemplateBase64
        : null,
    statementTemplateFileName:
      typeof source.statementTemplateFileName === 'string' ? source.statementTemplateFileName : '',
    statementTemplateUpdatedAt:
      typeof source.statementTemplateUpdatedAt === 'string' ? source.statementTemplateUpdatedAt : '',
    statementTemplateSettings: normalizeStatementTemplateSettings(source.statementTemplateSettings),
  }
}

const statementRecordById = (list: StatementRecord[]) => {
  const map = new Map<string, StatementRecord>()
  for (const r of list) {
    map.set(r.id, r)
  }
  return map
}

/**
 * 클라우드 F5·삭제 직후: 서버가 아직 upsert를 반영하지 않았는데, 로컬은 이미 삭제(또는 미반영 입력)을 반영한 경우.
 * id 집합이 한쪽이 다른쪽의 부분집합이고, 겹치는 id의 row 내용이 같으면 `records`만 로컬(더 짧은/긴)을 따른다.
 * (동시에 다른 팀원이 id를 추가·삭제한 충돌은 여전히 `remote` 기준)
 */
const mergeStatementPageDocumentOnCloudLoad = (
  local: StatementPageDocument,
  remote: StatementPageDocument,
): StatementPageDocument => {
  const L = local.records
  const R = remote.records
  if (L.length === 0) {
    return R.length === 0 ? local : remote
  }
  if (R.length === 0) {
    return { ...remote, records: L }
  }
  const Lm = statementRecordById(L)
  const Rm = statementRecordById(R)
  const Lids = new Set(Lm.keys())
  const Rids = new Set(Rm.keys())
  const sameRow = (id: string) => JSON.stringify(Lm.get(id)) === JSON.stringify(Rm.get(id))

  const lSubsetR = [...Lids].every((id) => Rids.has(id))
  if (lSubsetR && Lids.size < Rids.size) {
    for (const id of Lids) {
      if (!sameRow(id)) {
        return remote
      }
    }
    return { ...remote, records: L }
  }

  const rSubsetL = [...Rids].every((id) => Lids.has(id))
  if (rSubsetL && Rids.size < Lids.size) {
    for (const id of Rids) {
      if (!sameRow(id)) {
        return remote
      }
    }
    return { ...remote, records: L }
  }

  return remote
}

const createWorksheetCopy = (
  workbook: ExcelJS.Workbook,
  source: ExcelJS.Worksheet,
  sheetName: string,
) => {
  const target = workbook.addWorksheet(sheetName)
  target.properties = { ...source.properties }
  target.pageSetup = { ...source.pageSetup }
  target.headerFooter = { ...source.headerFooter }
  target.state = source.state
  target.views = source.views.map((view) => ({ ...view }))

  source.columns.forEach((column, index) => {
    const targetColumn = target.getColumn(index + 1)
    targetColumn.width = column.width
    targetColumn.hidden = Boolean(column.hidden)
    targetColumn.style = JSON.parse(JSON.stringify(column.style ?? {}))
  })

  for (let rowNumber = 1; rowNumber <= source.rowCount; rowNumber += 1) {
    const sourceRow = source.getRow(rowNumber)
    const targetRow = target.getRow(rowNumber)
    targetRow.height = sourceRow.height
    targetRow.hidden = sourceRow.hidden

    sourceRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const targetCell = targetRow.getCell(colNumber)
      targetCell.value = cell.value as ExcelJS.CellValue
      targetCell.style = JSON.parse(JSON.stringify(cell.style ?? {}))
    })
  }

  ;(source.model.merges ?? []).forEach((merge) => {
    target.mergeCells(merge)
  })

  return target
}

type WorksheetLayoutSnapshot = {
  columns: Array<{
    min: number
    max: number
    width?: number
    hidden?: boolean
    outlineLevel?: number
    collapsed?: boolean
  }>
  rows: Array<{
    number: number
    height?: number
    hidden?: boolean
    outlineLevel?: number
    collapsed?: boolean
  }>
  defaultColWidth?: number
  defaultRowHeight?: number
}

const captureWorksheetLayout = (worksheet: ExcelJS.Worksheet): WorksheetLayoutSnapshot => {
  const sheetModel = worksheet.model as {
    cols?: Array<{
      min?: number
      max?: number
      width?: number
      hidden?: boolean
      outlineLevel?: number
      collapsed?: boolean
    }>
    rows?: Array<{
      number?: number
      height?: number
      hidden?: boolean
      outlineLevel?: number
      collapsed?: boolean
    }>
  }

  const modelColumns = (sheetModel.cols ?? []).map((col) => ({
    min: Number(col.min),
    max: Number(col.max),
    width: typeof col.width === 'number' ? col.width : undefined,
    hidden: Boolean(col.hidden),
    outlineLevel: typeof col.outlineLevel === 'number' ? col.outlineLevel : undefined,
    collapsed: typeof col.collapsed === 'boolean' ? col.collapsed : undefined,
  }))

  const modelRows = (sheetModel.rows ?? []).map((row) => ({
    number: Number(row.number),
    height: typeof row.height === 'number' ? row.height : undefined,
    hidden: Boolean(row.hidden),
    outlineLevel: typeof row.outlineLevel === 'number' ? row.outlineLevel : undefined,
    collapsed: typeof row.collapsed === 'boolean' ? row.collapsed : undefined,
  }))

  return {
    columns: modelColumns,
    rows: modelRows,
    defaultColWidth:
      typeof worksheet.properties.defaultColWidth === 'number'
        ? worksheet.properties.defaultColWidth
        : undefined,
    defaultRowHeight:
      typeof worksheet.properties.defaultRowHeight === 'number'
        ? worksheet.properties.defaultRowHeight
        : undefined,
  }
}

const applyWorksheetLayout = (worksheet: ExcelJS.Worksheet, snapshot: WorksheetLayoutSnapshot) => {
  if (typeof snapshot.defaultColWidth === 'number') {
    worksheet.properties.defaultColWidth = snapshot.defaultColWidth
  }
  if (typeof snapshot.defaultRowHeight === 'number') {
    worksheet.properties.defaultRowHeight = snapshot.defaultRowHeight
  }

  snapshot.columns.forEach((entry) => {
    const start = Math.max(1, entry.min)
    const end = Math.max(start, entry.max)
    for (let colNumber = start; colNumber <= end; colNumber += 1) {
      const col = worksheet.getColumn(colNumber)
      if (typeof entry.width === 'number') {
        col.width = entry.width
      }
      if (typeof entry.hidden === 'boolean') {
        col.hidden = entry.hidden
      }
      if (typeof entry.outlineLevel === 'number') {
        col.outlineLevel = entry.outlineLevel
      }
    }
  })

  snapshot.rows.forEach((entry) => {
    if (!Number.isFinite(entry.number) || entry.number <= 0) {
      return
    }
    const row = worksheet.getRow(entry.number)
    if (typeof entry.height === 'number') {
      row.height = entry.height
    }
    if (typeof entry.hidden === 'boolean') {
      row.hidden = entry.hidden
    }
    if (typeof entry.outlineLevel === 'number') {
      row.outlineLevel = entry.outlineLevel
    }
  })
}

const statementCellTextHasHangul = (value: string) => /[\uAC00-\uD7A3]/.test(value)

/** 양식에 남은 숫자·날짜 서식 때문에 한글·혼합 문자열이 깨지지 않게 합니다. */
const setStatementTemplateCellText = (worksheet: ExcelJS.Worksheet, address: string, text: string) => {
  const cell = worksheet.getCell(address)
  cell.numFmt = '@'
  if (text === '') {
    cell.value = ''
    return
  }
  if (statementCellTextHasHangul(text)) {
    cell.value = { richText: [{ text }] } as ExcelJS.CellRichTextValue
    return
  }
  cell.value = text
}

/**
 * 납품일 월·일 표시 칸: 값은 숫자, 표시는 양식과 같이 `4권` `13호` 형태(Excel 사용자 지정 `0"권"` / `0"호"`).
 * 숫자만 넣으면 서식이 빠져 `4`·`13`만 보이는 문제를 막습니다.
 */
/** `거래명세서양식` 시트: 본문 품목 행 10~24행 다음의 공급가액·세액 합계 행(좌·우 동일 블록). */
const STATEMENT_TEMPLATE_FOOTER_SUPPLY_COLS = ['M', 'AF'] as const
const STATEMENT_TEMPLATE_FOOTER_TAX_COLS = ['P', 'AI'] as const
const STATEMENT_TEMPLATE_FOOTER_ROW = 25

const setStatementTemplateFooterTotals = (
  worksheet: ExcelJS.Worksheet,
  supplyTotal: number,
  taxTotal: number,
) => {
  const assignNumber = (address: string, value: number) => {
    const cell = worksheet.getCell(address)
    cell.value = value
    cell.numFmt = '#,##0'
  }
  for (const col of STATEMENT_TEMPLATE_FOOTER_SUPPLY_COLS) {
    assignNumber(`${col}${STATEMENT_TEMPLATE_FOOTER_ROW}`, supplyTotal)
  }
  for (const col of STATEMENT_TEMPLATE_FOOTER_TAX_COLS) {
    assignNumber(`${col}${STATEMENT_TEMPLATE_FOOTER_ROW}`, taxTotal)
  }
}

const setStatementDeliveryBadgeCells = (
  worksheet: ExcelJS.Worksheet,
  monthAddress: string,
  dayAddress: string,
  deliveryDate: string,
) => {
  const month = Number(deliveryDate.slice(5, 7))
  const day = Number(deliveryDate.slice(8, 10))
  const monthCell = worksheet.getCell(monthAddress)
  const dayCell = worksheet.getCell(dayAddress)
  monthCell.value = month
  dayCell.value = day
  monthCell.numFmt = '0"권"'
  dayCell.numFmt = '0"호"'
}

const fillStatementTemplateWorksheet = (
  worksheet: ExcelJS.Worksheet,
  statementSheet: StatementSheetGroup,
  settings: StatementTemplateSettings,
  recordOffset: number,
  pageSize: number,
) => {
  const applyFontSize = (address: string, size: number) => {
    const cell = worksheet.getCell(address)
    cell.font = {
      ...(cell.font ?? {}),
      size,
    }
  }

  setStatementDeliveryBadgeCells(worksheet, 'A1', 'C1', statementSheet.deliveryDate)
  worksheet.getCell('D2').value = parseIsoDateToDate(statementSheet.issueDate || today)
  setStatementTemplateCellText(worksheet, 'D3', statementSheet.clientName)
  setStatementTemplateCellText(worksheet, 'L3', settings.companyName)
  setStatementTemplateCellText(worksheet, 'N2', settings.businessNumber)
  setStatementTemplateCellText(worksheet, 'Q3', settings.ownerName)
  setStatementTemplateCellText(worksheet, 'L4', settings.address)
  setStatementTemplateCellText(worksheet, 'L5', settings.businessType)
  setStatementTemplateCellText(worksheet, 'P5', settings.businessItem)
  setStatementTemplateCellText(worksheet, 'M6', settings.phone)
  setStatementTemplateCellText(worksheet, 'C26', settings.account)
  setStatementDeliveryBadgeCells(worksheet, 'T1', 'V1', statementSheet.deliveryDate)
  worksheet.getCell('W2').value = parseIsoDateToDate(statementSheet.issueDate || today)
  setStatementTemplateCellText(worksheet, 'W3', statementSheet.clientName)
  setStatementTemplateCellText(worksheet, 'AE3', settings.companyName)
  setStatementTemplateCellText(worksheet, 'AG2', settings.businessNumber)
  setStatementTemplateCellText(worksheet, 'AJ3', settings.ownerName)
  setStatementTemplateCellText(worksheet, 'AE4', settings.address)
  setStatementTemplateCellText(worksheet, 'AE5', settings.businessType)
  setStatementTemplateCellText(worksheet, 'AI5', settings.businessItem)
  setStatementTemplateCellText(worksheet, 'AF6', settings.phone)
  setStatementTemplateCellText(worksheet, 'V26', settings.account)

  applyFontSize('L3', 9)
  applyFontSize('L4', 9)
  applyFontSize('AE3', 9)
  applyFontSize('AE4', 9)

  Array.from({ length: pageSize }, (_, index) => index + 10).forEach((rowNumber) => {
    const row = statementSheet.records[recordOffset + rowNumber - 10]
    worksheet.getCell(`A${rowNumber}`).value = row ? rowNumber - 9 : ''
    setStatementTemplateCellText(worksheet, `B${rowNumber}`, row?.itemName ?? '')
    setStatementTemplateCellText(worksheet, `F${rowNumber}`, row?.specUnit ?? '')
    worksheet.getCell(`I${rowNumber}`).value = row?.quantity ?? ''
    worksheet.getCell(`J${rowNumber}`).value = row?.unitPrice ?? ''
    worksheet.getCell(`M${rowNumber}`).value = row?.supplyAmount ?? ''
    worksheet.getCell(`P${rowNumber}`).value = row?.taxAmount ?? ''
    worksheet.getCell(`T${rowNumber}`).value = row ? rowNumber - 9 : ''
    setStatementTemplateCellText(worksheet, `U${rowNumber}`, row?.itemName ?? '')
    setStatementTemplateCellText(worksheet, `Y${rowNumber}`, row?.specUnit ?? '')
    worksheet.getCell(`AB${rowNumber}`).value = row?.quantity ?? ''
    worksheet.getCell(`AC${rowNumber}`).value = row?.unitPrice ?? ''
    worksheet.getCell(`AF${rowNumber}`).value = row?.supplyAmount ?? ''
    worksheet.getCell(`AI${rowNumber}`).value = row?.taxAmount ?? ''
  })

  // 양식에 남은 SUM / ROUND(공급*10%) 식은 줄별 세액(내림·1원 보정) 합과 어긋날 수 있음 → 앱 집계와 동일하게 고정
  setStatementTemplateFooterTotals(worksheet, statementSheet.supplyAmount, statementSheet.taxAmount)
}

const normalizeName = (value: string) => value.trim().replace(/\s+/g, ' ')

const buildEditFormStateFromRecord = (
  record: StatementRecord,
  pricingRules: PricingRule[],
  records: StatementRecord[],
): { form: FormState; isCustomClient: boolean; isCustomItem: boolean; isCustomSpec: boolean } => {
  const mergedClients = new Set<string>()
  pricingRules.forEach((rule) => mergedClients.add(rule.clientName))
  records.forEach((r) => {
    if (r.clientName.trim()) {
      mergedClients.add(r.clientName.trim())
    }
  })
  const trimmedClient = record.clientName.trim()
  const isCustomClient = !Array.from(mergedClients).some((c) => c === trimmedClient)

  const nextClientRules = pricingRules.filter(
    (rule) => normalizeName(rule.clientName) === normalizeName(trimmedClient),
  )

  const allItems = new Set<string>([...DEFAULT_ITEM_OPTIONS])
  pricingRules.forEach((rule) => {
    if (rule.itemName.trim()) {
      allItems.add(rule.itemName.trim())
    }
  })
  records.forEach((r) => {
    if (r.itemName.trim()) {
      allItems.add(r.itemName.trim())
    }
  })
  const itemsForClient =
    nextClientRules.length === 0
      ? Array.from(allItems)
      : Array.from(new Set(nextClientRules.map((r) => r.itemName.trim()).filter(Boolean)))

  const trimmedItem = record.itemName.trim()
  const isCustomItem = !itemsForClient.some(
    (name) => normalizeName(name) === normalizeName(trimmedItem),
  )

  const matchedSpecs = nextClientRules
    .filter((rule) => normalizeName(rule.itemName) === normalizeName(trimmedItem))
    .map((rule) => rule.specUnit)
    .filter(Boolean)

  const mergedSpecs = new Set<string>([...DEFAULT_SPEC_OPTIONS])
  pricingRules.forEach((rule) => {
    if (rule.specUnit.trim()) {
      mergedSpecs.add(rule.specUnit.trim())
    }
  })
  records.forEach((r) => {
    if (r.specUnit.trim()) {
      mergedSpecs.add(r.specUnit.trim())
    }
  })
  const specChoices =
    matchedSpecs.length > 0 ? Array.from(new Set(matchedSpecs)) : Array.from(mergedSpecs)

  const trimmedSpec = record.specUnit.trim()
  const specInChoices = specChoices.some((choice) => choice === trimmedSpec)
  const isCustomSpec =
    trimmedSpec !== '' && !specInChoices && !QUICK_SPEC_VALUES.has(trimmedSpec)

  return {
    form: {
      deliveryDate: record.deliveryDate,
      deliveryCount: record.deliveryCount,
      clientName: trimmedClient,
      itemName: trimmedItem,
      specUnit: trimmedSpec,
      quantity: String(record.quantity),
      unitPrice: String(record.unitPrice),
      note: record.note,
    },
    isCustomClient,
    isCustomItem,
    isCustomSpec,
  }
}

const formatCurrency = (value: number) => currencyFormatter.format(value)

const formatDateLabel = (value: string) => (value ? value.replaceAll('-', '.') : '-')

const formatLongDateLabel = (value: string) => {
  if (!value) {
    return '-'
  }
  const [year, month, day] = value.split('-')
  return `${year}년 ${Number(month)}월 ${Number(day)}일`
}

const formatStatementAmountText = (value: number) => `일금 ${formatCurrency(value)}원정`

const isTaxFreeNote = (note: string) => normalizeName(note) === '부가세 없음'
const calculateTaxAmount = (supplyAmount: number, note: string) => {
  if (isTaxFreeNote(note)) {
    return 0
  }
  const baseTax = Math.floor(supplyAmount * 0.1)
  const totalAmount = supplyAmount + baseTax
  // 실무상 1원 청구를 피하기 위해 계가 1원으로 끝나면 1원 내림 보정
  return totalAmount % 10 === 1 ? Math.max(0, baseTax - 1) : baseTax
}

/** 거래처별 단가표 우선, 없으면 품목 마스터 단가 (단건 입력과 동일). */
const resolveStatementPricingForClientItem = (
  pricingRules: PricingRule[],
  masterItems: MasterItem[],
  clientName: string,
  itemName: string,
): { specUnit: string; unitPrice: number } | null => {
  const rule =
    pricingRules.find(
      (entry) =>
        normalizeName(entry.clientName) === normalizeName(clientName) &&
        normalizeName(entry.itemName) === normalizeName(itemName),
    ) ?? null
  if (rule) {
    return { specUnit: rule.specUnit.trim(), unitPrice: rule.unitPrice }
  }
  const master =
    masterItems.find((entry) => normalizeName(entry.itemName) === normalizeName(itemName)) ?? null
  if (master) {
    return { specUnit: master.specUnit.trim(), unitPrice: master.unitPrice }
  }
  return null
}

const normalizeLoadedRecords = (records: Array<StatementRecord & { note?: string; savedAt?: string }>) =>
  records.map((record) => {
    const savedAt = typeof record.savedAt === 'string' && record.savedAt ? record.savedAt : undefined
    return {
      ...record,
      note: record.note ?? (record.taxAmount === 0 ? '부가세 없음' : '부가세 별도'),
      ...(savedAt ? { savedAt } : {}),
    }
  })

const FILE_HANDLE_DB_NAME = 'statement-file-handle-db'
const FILE_HANDLE_STORE_NAME = 'handles'
const FILE_HANDLE_KEY = 'primary-backup-file'
const EXCEL_EXPORT_DIRECTORY_KEY = 'excel-export-directory'
type FileHandleWithPermission = FileSystemFileHandle & {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

const openFileHandleDb = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(FILE_HANDLE_DB_NAME, 1)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(FILE_HANDLE_STORE_NAME)) {
        database.createObjectStore(FILE_HANDLE_STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const loadStoredFileHandle = async (): Promise<FileSystemFileHandle | null> => {
  const database = await openFileHandleDb()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_HANDLE_STORE_NAME, 'readonly')
    const store = transaction.objectStore(FILE_HANDLE_STORE_NAME)
    const request = store.get(FILE_HANDLE_KEY)

    request.onsuccess = () => {
      resolve((request.result as FileSystemFileHandle | undefined) ?? null)
      database.close()
    }
    request.onerror = () => {
      reject(request.error)
      database.close()
    }
  })
}

const loadStoredExportDirectoryHandle = async (): Promise<FileSystemDirectoryHandle | null> => {
  const database = await openFileHandleDb()

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(FILE_HANDLE_STORE_NAME, 'readonly')
    const store = transaction.objectStore(FILE_HANDLE_STORE_NAME)
    const request = store.get(EXCEL_EXPORT_DIRECTORY_KEY)

    request.onsuccess = () => {
      resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null)
      database.close()
    }
    request.onerror = () => {
      reject(request.error)
      database.close()
    }
  })
}

const saveStoredExportDirectoryHandle = async (directoryHandle: FileSystemDirectoryHandle) => {
  const database = await openFileHandleDb()

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(FILE_HANDLE_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(FILE_HANDLE_STORE_NAME)
    const request = store.put(directoryHandle, EXCEL_EXPORT_DIRECTORY_KEY)

    request.onsuccess = () => {
      resolve()
      database.close()
    }
    request.onerror = () => {
      reject(request.error)
      database.close()
    }
  })
}

const clearStoredExportDirectoryHandle = async () => {
  const database = await openFileHandleDb()

  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(FILE_HANDLE_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(FILE_HANDLE_STORE_NAME)
    const request = store.delete(EXCEL_EXPORT_DIRECTORY_KEY)

    request.onsuccess = () => {
      resolve()
      database.close()
    }
    request.onerror = () => {
      reject(request.error)
      database.close()
    }
  })
}

type DirectoryHandleWithPermission = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>
}

const writeBufferToDirectory = async (
  directoryHandle: FileSystemDirectoryHandle,
  filename: string,
  buffer: ArrayBuffer | Uint8Array,
) => {
  const fileHandle = await directoryHandle.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(toArrayBuffer(buffer))
  await writable.close()
}

const getBackupPayload = (
  records: StatementRecord[],
  pricingRules: PricingRule[],
): AppBackupPayload => ({
  version: 2,
  savedAt: new Date().toISOString(),
  records,
  pricingRules,
  activePage:
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'meeting' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'inventory' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'statements' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'expense' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'staffPayroll' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'greenBeanOrder' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'memo' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'dailyMeeting' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'team' ||
    window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) === 'beanSalesAnalysis'
      ? (window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY) as AppActivePage)
      : undefined,
  monthlyMeetingState: window.localStorage.getItem(MONTHLY_MEETING_DATA_KEY) ?? '',
  inventoryState: window.localStorage.getItem(INVENTORY_STATUS_STORAGE_KEY) ?? '',
  inventoryBaselineState: window.localStorage.getItem(INVENTORY_STATUS_BASELINE_STORAGE_KEY) ?? '',
  inventoryTemplateBase64: window.localStorage.getItem(INVENTORY_STATUS_TEMPLATE_STORAGE_KEY) ?? '',
  inventoryTemplateFileName: window.localStorage.getItem(INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY) ?? '',
  inventoryAutoStockMode: true,
  expenseState: window.localStorage.getItem(EXPENSE_PAGE_STORAGE_KEY) ?? '',
  staffPayrollState: window.localStorage.getItem(STAFF_PAYROLL_STORAGE_KEY) ?? '',
  greenBeanOrderState: window.localStorage.getItem(GREEN_BEAN_ORDER_STORAGE_KEY) ?? '',
  memoState: window.localStorage.getItem(MEMO_PAGE_STORAGE_KEY) ?? '',
  statementTemplateBase64: window.localStorage.getItem(STATEMENT_TEMPLATE_STORAGE_KEY) ?? '',
  statementTemplateFileName: window.localStorage.getItem(STATEMENT_TEMPLATE_NAME_STORAGE_KEY) ?? '',
  statementTemplateUpdatedAt:
    window.localStorage.getItem(STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY) ?? '',
  statementTemplateSettings: window.localStorage.getItem(STATEMENT_TEMPLATE_SETTINGS_STORAGE_KEY) ?? '',
})

const getBackupSnapshot = (records: StatementRecord[], pricingRules: PricingRule[]) =>
  JSON.stringify({
    ...getBackupPayload(records, pricingRules),
    savedAt: '',
  })

const writeBackupFile = async (
  fileHandle: FileSystemFileHandle,
  records: StatementRecord[],
  pricingRules: PricingRule[],
) => {
  const writable = await fileHandle.createWritable()
  await writable.write(JSON.stringify(getBackupPayload(records, pricingRules), null, 2))
  await writable.close()
}

const readBackupFile = async (fileHandle: FileSystemFileHandle): Promise<AppBackupPayload | null> => {
  const file = await fileHandle.getFile()
  const text = await file.text()

  if (!text.trim()) {
    return null
  }

  const parsed = JSON.parse(text) as Partial<AppBackupPayload>
  return {
    version: 2,
    savedAt: String(parsed.savedAt ?? ''),
    records: normalizeLoadedRecords(
      Array.isArray(parsed.records)
        ? (parsed.records as Array<StatementRecord & { note?: string }>)
        : [],
    ),
    pricingRules: Array.isArray(parsed.pricingRules) ? (parsed.pricingRules as PricingRule[]) : [],
    activePage:
      parsed.activePage === 'meeting' ||
      parsed.activePage === 'inventory' ||
      parsed.activePage === 'statements' ||
      parsed.activePage === 'expense' ||
      parsed.activePage === 'staffPayroll' ||
      parsed.activePage === 'greenBeanOrder' ||
      parsed.activePage === 'memo' ||
      parsed.activePage === 'dailyMeeting' ||
      parsed.activePage === 'team' ||
      parsed.activePage === 'beanSalesAnalysis'
        ? parsed.activePage
        : undefined,
    monthlyMeetingState: String(parsed.monthlyMeetingState ?? ''),
    inventoryState: String(parsed.inventoryState ?? ''),
    inventoryBaselineState: String(parsed.inventoryBaselineState ?? ''),
    inventoryTemplateBase64: String(parsed.inventoryTemplateBase64 ?? ''),
    inventoryTemplateFileName: String(parsed.inventoryTemplateFileName ?? ''),
    inventoryAutoStockMode: parsed.inventoryAutoStockMode === true,
    expenseState: String(parsed.expenseState ?? ''),
    staffPayrollState: String(parsed.staffPayrollState ?? ''),
    // 생두 주문은 이전 백업값을 자동 복원하지 않음(기본 초기 상태 유지)
    greenBeanOrderState: '',
    statementTemplateBase64: String(parsed.statementTemplateBase64 ?? ''),
    statementTemplateFileName: String(parsed.statementTemplateFileName ?? ''),
    statementTemplateUpdatedAt: String(parsed.statementTemplateUpdatedAt ?? ''),
    statementTemplateSettings: String(parsed.statementTemplateSettings ?? ''),
    memoState: String(parsed.memoState ?? ''),
  }
}

const syncBackupStorageValue = (key: string, value: string) => {
  if (value) {
    window.localStorage.setItem(key, value)
  } else {
    window.localStorage.removeItem(key)
  }
}

const pickLatestDate = (dates: string[]) => {
  const filtered = dates.filter(Boolean).sort()
  return filtered.at(-1) ?? ''
}

/** 납품월이 같은 건: 저장 순(오래될수록 1, 가장 나중에 저장한 건이 해당 월 최대 번호). 예전 데이터는 납품일·거래처·id */

const monthSeqSortKey = (r: StatementRecord) => {
  if (r.savedAt) {
    return r.savedAt
  }
  return `${r.deliveryDate}\0${r.clientName}\0${r.id}`
}

const statementRecordDeliveryMonthSeqById = (records: StatementRecord[]): Map<string, number> => {
  const byMonth = new Map<string, StatementRecord[]>()
  for (const r of records) {
    const ym = r.deliveryDate.length >= 7 ? r.deliveryDate.slice(0, 7) : ''
    if (!ym) {
      continue
    }
    const list = byMonth.get(ym)
    if (list) {
      list.push(r)
    } else {
      byMonth.set(ym, [r])
    }
  }
  const idToSeq = new Map<string, number>()
  for (const list of byMonth.values()) {
    const sorted = [...list].sort((a, b) => monthSeqSortKey(a).localeCompare(monthSeqSortKey(b)))
    sorted.forEach((rec, i) => idToSeq.set(rec.id, i + 1))
  }
  return idToSeq
}

/** 목록·저장 배열: 납품일 최신순. 같은 날짜는 거래처·id 역순(월 내 번호가 큰 쪽이 위). */
const compareStatementRecordsNewestFirst = (a: StatementRecord, b: StatementRecord) => {
  const dateCompare = b.deliveryDate.localeCompare(a.deliveryDate)
  if (dateCompare !== 0) {
    return dateCompare
  }
  const clientCompare = b.clientName.localeCompare(a.clientName, 'ko')
  if (clientCompare !== 0) {
    return clientCompare
  }
  return b.id.localeCompare(a.id)
}

type StatementListSortKey = 'number' | 'deliveryDate' | 'clientName' | 'itemName'

/** 입력목록 탭: 번호(월별)·납품일·거래처·품목 열 정렬. */
const compareStatementRecordsForListSort = (
  a: StatementRecord,
  b: StatementRecord,
  sort: { key: StatementListSortKey; dir: 'asc' | 'desc' },
  seqById: Map<string, number>,
): number => {
  if (sort.key === 'number') {
    const ymA = a.deliveryDate.length >= 7 ? a.deliveryDate.slice(0, 7) : ''
    const ymB = b.deliveryDate.length >= 7 ? b.deliveryDate.slice(0, 7) : ''
    if (ymA !== ymB) {
      return sort.dir === 'desc' ? ymB.localeCompare(ymA) : ymA.localeCompare(ymB)
    }
    const sA = seqById.get(a.id) ?? 0
    const sB = seqById.get(b.id) ?? 0
    if (sA !== sB) {
      return sort.dir === 'desc' ? sB - sA : sA - sB
    }
    return b.id.localeCompare(a.id)
  }
  if (sort.key === 'deliveryDate') {
    const c = a.deliveryDate.localeCompare(b.deliveryDate)
    if (c !== 0) {
      return sort.dir === 'desc' ? -c : c
    }
    return a.id.localeCompare(b.id)
  }
  if (sort.key === 'clientName') {
    const c = a.clientName.localeCompare(b.clientName, 'ko', { sensitivity: 'base' })
    if (c !== 0) {
      return sort.dir === 'desc' ? -c : c
    }
    return a.id.localeCompare(b.id)
  }
  const c = a.itemName.localeCompare(b.itemName, 'ko', { sensitivity: 'base' })
  if (c !== 0) {
    return sort.dir === 'desc' ? -c : c
  }
  return a.id.localeCompare(b.id)
}

function App() {
  const { mode, activeCompany, activeCompanyId, user, signOut, cloudDocRefreshTick } = useAppRuntime()
  const [form, setForm] = useState<FormState>(() => defaultFormState())
  const [records, setRecords] = useState<StatementRecord[]>([])
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([])
  const [masterItems, setMasterItems] = useState<MasterItem[]>([])
  const [masterItemDraft, setMasterItemDraft] = useState<{
    itemName: string
    specUnit: string
    unitPrice: string
  }>({ itemName: '', specUnit: '', unitPrice: '' })
  const [editingMasterItemId, setEditingMasterItemId] = useState<string | null>(null)
  const [editingMasterItemDraft, setEditingMasterItemDraft] = useState<{
    itemName: string
    specUnit: string
    unitPrice: string
  }>({ itemName: '', specUnit: '', unitPrice: '' })
  const [masterItemMessage, setMasterItemMessage] = useState('')
  const [activePage, setActivePage] = useState<AppActivePage>(() => {
    const savedPage = window.localStorage.getItem(ACTIVE_PAGE_STORAGE_KEY)
    if (
      savedPage === 'meeting' ||
      savedPage === 'inventory' ||
      savedPage === 'statements' ||
      savedPage === 'expense' ||
      savedPage === 'staffPayroll' ||
      savedPage === 'greenBeanOrder' ||
      savedPage === 'dailyMeeting' ||
      savedPage === 'team' ||
      savedPage === 'beanSalesAnalysis'
    ) {
      return savedPage
    }
    if (savedPage === 'memo') {
      return 'dailyMeeting'
    }

    return 'statements'
  })

  const activeCategoryId = useMemo(() => categoryIdForPage(activePage), [activePage])
  const activeCategoryLabel = useMemo(
    () => PAGE_CATEGORY_GROUPS.find((g) => g.id === activeCategoryId)?.label ?? '업무',
    [activeCategoryId],
  )
  const activePageMeta = useMemo(() => PAGE_HEADER_META[activePage], [activePage])
  const activeCategoryGroup = useMemo(
    () => PAGE_CATEGORY_GROUPS.find((g) => g.id === activeCategoryId) ?? PAGE_CATEGORY_GROUPS[0],
    [activeCategoryId],
  )
  const totalWorkspacePages = useMemo(
    () => PAGE_CATEGORY_GROUPS.reduce((sum, group) => sum + group.pages.length, 0),
    [],
  )

  const [lowGreenBeanWarningItems, setLowGreenBeanWarningItems] = useState<LowGreenBeanWarningItem[]>([])

  const lowGreenBeanWarningDigest = useMemo(
    () =>
      lowGreenBeanWarningItems
        .map((i) => `${i.name}\0${i.kg.toFixed(4)}\0${i.threshold}`)
        .join('|'),
    [lowGreenBeanWarningItems],
  )
  const [isLowGreenBeanPanelDismissed, setIsLowGreenBeanPanelDismissed] = useState(false)
  useEffect(() => {
    setIsLowGreenBeanPanelDismissed(false)
  }, [lowGreenBeanWarningDigest])

  const refreshLowGreenBeanWarnings = useCallback(() => {
    try {
      const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
      const raw = window.localStorage.getItem(key)
      if (!raw) {
        setLowGreenBeanWarningItems([])
        return
      }
      const state = normalizeInventoryStatusState(JSON.parse(raw) as unknown)
      if (!state) {
        setLowGreenBeanWarningItems([])
        return
      }
      setLowGreenBeanWarningItems(getLowGreenBeanWarningItems(state))
    } catch {
      setLowGreenBeanWarningItems([])
    }
  }, [mode, activeCompanyId])

  const [selectedYear, setSelectedYear] = useState(String(CURRENT_YEAR))
  const [activeView, setActiveView] = useState<'records' | 'summary' | 'cards' | 'calendar'>('cards')
  const [recordsSearchQuery, setRecordsSearchQuery] = useState('')
  const [recordsRangeFilter, setRecordsRangeFilter] = useState<'all' | 'week' | 'month' | 'year'>('month')
  const [recordsNoteFilter, setRecordsNoteFilter] = useState<'all' | '부가세 별도' | '부가세 없음'>(
    'all',
  )
  const [recordListSort, setRecordListSort] = useState<{
    key: StatementListSortKey
    dir: 'asc' | 'desc'
  }>({ key: 'number', dir: 'desc' })
  const [inlineEditRecordId, setInlineEditRecordId] = useState<string | null>(null)
  const [inlineEditDraft, setInlineEditDraft] = useState<{
    deliveryDate: string
    deliveryCount: string
    clientName: string
    itemName: string
    specUnit: string
    quantity: string
    unitPrice: string
    note: string
  }>({
    deliveryDate: '',
    deliveryCount: '',
    clientName: '',
    itemName: '',
    specUnit: '',
    quantity: '',
    unitPrice: '',
    note: '부가세 별도',
  })
  const [calendarMonth, setCalendarMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null)
  const [statementEntryModalOpen, setStatementEntryModalOpen] = useState(false)
  const [statementSaveToastVisible, setStatementSaveToastVisible] = useState(false)
  const statementSaveToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [bulkItemPickerOpen, setBulkItemPickerOpen] = useState(false)
  const [bulkItemPickerQuery, setBulkItemPickerQuery] = useState('')
  const [bulkItemPickerPick, setBulkItemPickerPick] = useState<{
    selected: Set<string>
    quantities: Record<string, string>
  }>(() => ({ selected: new Set(), quantities: {} }))
  const [pricingAdminClientKey, setPricingAdminClientKey] = useState('')
  const [pricingAdminClientInput, setPricingAdminClientInput] = useState('')
  const [pricingAdminLineDraft, setPricingAdminLineDraft] = useState({
    itemName: '',
    specUnit: '',
    unitPrice: '',
  })
  const [pricingRuleFormMessage, setPricingRuleFormMessage] = useState('')
  const [isCustomClient, setIsCustomClient] = useState(false)
  const [isCustomItem, setIsCustomItem] = useState(false)
  const [isCustomSpec, setIsCustomSpec] = useState(false)
  const [selectedSheetKey, setSelectedSheetKey] = useState('')
  const [isAdminOpen, setIsAdminOpen] = useState(false)
  const [isAdminUnlockDialogOpen, setIsAdminUnlockDialogOpen] = useState(false)
  const [adminUnlockPin, setAdminUnlockPin] = useState('')
  const [adminUnlockError, setAdminUnlockError] = useState('')
  const [statementTemplateBase64, setStatementTemplateBase64] = useState<string | null>(() =>
    window.localStorage.getItem(STATEMENT_TEMPLATE_STORAGE_KEY),
  )
  const [statementTemplateFileName, setStatementTemplateFileName] = useState(() =>
    window.localStorage.getItem(STATEMENT_TEMPLATE_NAME_STORAGE_KEY) ?? '',
  )
  const [statementTemplateUpdatedAt, setStatementTemplateUpdatedAt] = useState(() =>
    window.localStorage.getItem(STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY) ?? '',
  )
  const [statementTemplateSettings, setStatementTemplateSettings] = useState<StatementTemplateSettings>(() => {
    const saved = window.localStorage.getItem(STATEMENT_TEMPLATE_SETTINGS_STORAGE_KEY)
    if (!saved) {
      return { ...DEFAULT_STATEMENT_TEMPLATE_SETTINGS }
    }

    try {
      return normalizeStatementTemplateSettings(JSON.parse(saved))
    } catch {
      return { ...DEFAULT_STATEMENT_TEMPLATE_SETTINGS }
    }
  })
  const [isStatementTemplateEditMode, setIsStatementTemplateEditMode] = useState(false)
  const [statementTemplateMessage, setStatementTemplateMessage] = useState('')
  const [isStatementPreviewOpen, setIsStatementPreviewOpen] = useState(false)
  const [backupFileHandle, setBackupFileHandle] = useState<FileSystemFileHandle | null>(null)
  const [excelExportDirHandle, setExcelExportDirHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [excelExportFolderMessage, setExcelExportFolderMessage] = useState('')
  const [isBackupReady, setIsBackupReady] = useState(false)
  const lastBackupSnapshotRef = useRef('')
  const [isRecordsStorageReady, setIsRecordsStorageReady] = useState(false)
  const [isPricingStorageReady, setIsPricingStorageReady] = useState(false)
  const [isMasterItemsStorageReady, setIsMasterItemsStorageReady] = useState(false)
  const [isStatementCloudReady, setIsStatementCloudReady] = useState(mode === 'local')
  const {
    markDocumentDirty: markStatementDirty,
    markDocumentError: markStatementError,
    markDocumentSaved: markStatementSaved,
    markDocumentSaving: markStatementSaving,
    resetDocumentSaveUi: resetStatementSaveUi,
    saveState: statementSaveState,
    skipInitialDocumentSave: skipInitialStatementSave,
  } = useDocumentSaveUi(mode)

  const statementMainTableScrollRef = useRef<HTMLDivElement | null>(null)
  const statementStickyHScrollRef = useRef<HTMLDivElement | null>(null)
  const statementStickyHScrollInnerRef = useRef<HTMLDivElement | null>(null)
  const statementHScrollSyncingRef = useRef(false)
  const [statementStickyHScrollVisible, setStatementStickyHScrollVisible] = useState(false)
  const statementCloudSaveSigRef = useRef<string>('')

  useEffect(() => {
    let cancelled = false

    setIsRecordsStorageReady(false)
    setIsPricingStorageReady(false)
    setIsMasterItemsStorageReady(false)
    setIsStatementCloudReady(mode === 'local')
    resetStatementSaveUi()
    statementCloudSaveSigRef.current = ''

    const applyState = (next: StatementPageDocument) => {
      if (cancelled) {
        return
      }
      setRecords(next.records)
      setPricingRules(next.pricingRules)
      setMasterItems(next.masterItems)
      setStatementTemplateBase64(next.statementTemplateBase64)
      setStatementTemplateFileName(next.statementTemplateFileName)
      setStatementTemplateUpdatedAt(next.statementTemplateUpdatedAt)
      setStatementTemplateSettings(next.statementTemplateSettings)
      setIsRecordsStorageReady(true)
      setIsPricingStorageReady(true)
      setIsMasterItemsStorageReady(true)
      setIsStatementCloudReady(true)
    }

    const loadStatementState = async () => {
      const localState = readStatementPageLocalState()
      if (mode !== 'cloud' || !activeCompanyId) {
        applyState(localState)
        statementCloudSaveSigRef.current = statementPageDocumentPayloadSig(localState)
        return
      }

      try {
        const remoteState = await loadCompanyDocument<StatementPageDocument>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.statementPage,
        )
        const remoteNorm = remoteState ? normalizeStatementPageDocument(remoteState) : null
        const toApply = remoteNorm
          ? mergeStatementPageDocumentOnCloudLoad(localState, remoteNorm)
          : localState
        applyState(toApply)
        if (remoteNorm) {
          writeStatementPageLocalState(toApply)
        }
        statementCloudSaveSigRef.current = statementPageDocumentPayloadSig(toApply)
      } catch (error) {
        console.error('거래명세 클라우드 문서를 읽지 못했습니다.', error)
        applyState(localState)
        statementCloudSaveSigRef.current = statementPageDocumentPayloadSig(localState)
      }
    }

    void loadStatementState()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, mode, resetStatementSaveUi])

  useEffect(() => {
    if (mode !== 'cloud' || !activeCompanyId || cloudDocRefreshTick === 0) {
      return
    }
    if (statementSaveState === 'dirty' || statementSaveState === 'saving') {
      return
    }
    let cancelled = false
    const pullRemote = async () => {
      try {
        const remoteState = await loadCompanyDocument<StatementPageDocument>(
          activeCompanyId,
          COMPANY_DOCUMENT_KEYS.statementPage,
        )
        if (cancelled) {
          return
        }
        const local = readStatementPageLocalState()
        const remoteNorm = remoteState ? normalizeStatementPageDocument(remoteState) : null
        const toApply = remoteNorm
          ? mergeStatementPageDocumentOnCloudLoad(local, remoteNorm)
          : local
        setRecords(toApply.records)
        setPricingRules(toApply.pricingRules)
        setMasterItems(toApply.masterItems)
        setStatementTemplateBase64(toApply.statementTemplateBase64)
        setStatementTemplateFileName(toApply.statementTemplateFileName)
        setStatementTemplateUpdatedAt(toApply.statementTemplateUpdatedAt)
        setStatementTemplateSettings(toApply.statementTemplateSettings)
        if (remoteState) {
          writeStatementPageLocalState(toApply)
        }
        statementCloudSaveSigRef.current = statementPageDocumentPayloadSig(toApply)
      } catch (error) {
        console.error('거래명세: 다른 기기/탭 동기화용 클라우드 다시 읽기에 실패했습니다.', error)
      }
    }
    void pullRemote()
    return () => {
      cancelled = true
    }
  }, [activeCompanyId, cloudDocRefreshTick, mode, statementSaveState])

  /**
   * 다른 **탭/창**이 `statement-*` `localStorage` 키를 갱신하면(거래명세·원두분석·저장 루프가 동기화)
   * 이 탭의 거래명세 React state는 자동 갱신되지 않는다(브라우저는 `storage`를 그 탭에만 쏨).
   * 원두별 매출은 `STATEMENT_RECORDS_SAVED_EVENT`·재조회에 묶여 "바로" 보이는 것처럼 느껴지지만,
   * 거래명세 본인 화면은 그렇지 않아 이벤트가 아니라 **storage**로 맞춘다(저장 대기/저장 중이면 덮어쓰지 않음).
   */
  useEffect(() => {
    if (!isStatementCloudReady || !isRecordsStorageReady || !isPricingStorageReady || !isMasterItemsStorageReady) {
      return
    }
    const statementStorageKeys = new Set<string>([
      STORAGE_KEY,
      PRICING_RULES_STORAGE_KEY,
      MASTER_ITEMS_STORAGE_KEY,
      STATEMENT_TEMPLATE_STORAGE_KEY,
      STATEMENT_TEMPLATE_NAME_STORAGE_KEY,
      STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY,
      STATEMENT_TEMPLATE_SETTINGS_STORAGE_KEY,
    ])
    const applyFromOtherTabLocal = () => {
      if (mode === 'cloud' && activeCompanyId && (statementSaveState === 'dirty' || statementSaveState === 'saving')) {
        return
      }
      const next = readStatementPageLocalState()
      setRecords(next.records)
      setPricingRules(next.pricingRules)
      setMasterItems(next.masterItems)
      setStatementTemplateBase64(next.statementTemplateBase64)
      setStatementTemplateFileName(next.statementTemplateFileName)
      setStatementTemplateUpdatedAt(next.statementTemplateUpdatedAt)
      setStatementTemplateSettings(next.statementTemplateSettings)
      statementCloudSaveSigRef.current = statementPageDocumentPayloadSig(next)
    }
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return
      }
      if (!event.key || !statementStorageKeys.has(event.key)) {
        return
      }
      applyFromOtherTabLocal()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [
    activeCompanyId,
    isStatementCloudReady,
    isMasterItemsStorageReady,
    isRecordsStorageReady,
    isPricingStorageReady,
    mode,
    statementSaveState,
  ])

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, activePage)
  }, [activePage])

  useEffect(() => {
    void refreshLowGreenBeanWarnings()
    const onCacheOrStorage = () => {
      void refreshLowGreenBeanWarnings()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void refreshLowGreenBeanWarnings()
      }
    }
    window.addEventListener(INVENTORY_STATUS_CACHE_EVENT, onCacheOrStorage)
    window.addEventListener('storage', onCacheOrStorage)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener(INVENTORY_STATUS_CACHE_EVENT, onCacheOrStorage)
      window.removeEventListener('storage', onCacheOrStorage)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshLowGreenBeanWarnings])

  useEffect(() => {
    void refreshLowGreenBeanWarnings()
  }, [activePage, refreshLowGreenBeanWarnings])

  useEffect(() => {
    if (!isRecordsStorageReady || !isPricingStorageReady || !isMasterItemsStorageReady) {
      return
    }
    if (mode === 'cloud' && activeCompanyId) {
      return
    }
    writeStatementPageLocalState({
      records,
      pricingRules,
      masterItems,
      statementTemplateBase64,
      statementTemplateFileName,
      statementTemplateUpdatedAt,
      statementTemplateSettings,
    })
  }, [
    activeCompanyId,
    isMasterItemsStorageReady,
    isPricingStorageReady,
    isRecordsStorageReady,
    masterItems,
    mode,
    pricingRules,
    records,
    statementTemplateBase64,
    statementTemplateFileName,
    statementTemplateSettings,
    statementTemplateUpdatedAt,
  ])

  /**
   * 클라우드 모드: 전체 문서 저장(디바운스) 전이라도, 같은 탭·다른 화면(월마감·원두분석)이
   * `statement-records`와 STATEMENT_RECORDS_SAVED_EVENT로 즉시 읽을 수 있게 `records`만 로컬에 반영.
   * (팀 정본은 여전히 saveCompanyDocument 성공 시 전체 `writeStatementPageLocalState`로 맞춤)
   */
  useEffect(() => {
    if (!isRecordsStorageReady) {
      return
    }
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }
    writeStatementRecordsToMirror(records)
  }, [activeCompanyId, isRecordsStorageReady, mode, records])

  useEffect(() => {
    if (activePage !== 'statements') {
      setStatementEntryModalOpen(false)
    }
  }, [activePage])

  useEffect(() => {
    if (!statementEntryModalOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      if (bulkItemPickerOpen || isAdminUnlockDialogOpen) {
        return
      }
      setStatementEntryModalOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [statementEntryModalOpen, bulkItemPickerOpen, isAdminUnlockDialogOpen])

  useEffect(() => {
    return () => {
      if (statementSaveToastTimerRef.current) {
        clearTimeout(statementSaveToastTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (
      !isRecordsStorageReady ||
      !isPricingStorageReady ||
      !isMasterItemsStorageReady ||
      !isStatementCloudReady
    ) {
      return
    }
    if (mode !== 'cloud' || !activeCompanyId) {
      return
    }
    if (skipInitialStatementSave()) {
      return
    }

    const statementPayload: StatementPageDocument = {
      records,
      pricingRules,
      masterItems,
      statementTemplateBase64,
      statementTemplateFileName,
      statementTemplateUpdatedAt,
      statementTemplateSettings,
    }
    const nextSig = statementPageDocumentPayloadSig(statementPayload)
    if (nextSig === statementCloudSaveSigRef.current) {
      if (statementSaveState === 'dirty') {
        markStatementSaved()
      }
      return
    }

    markStatementDirty()

    const timeoutId = window.setTimeout(() => {
      markStatementSaving()
      void saveCompanyDocument(
        activeCompanyId,
        COMPANY_DOCUMENT_KEYS.statementPage,
        statementPayload,
        user?.id,
      )
        .then(() => {
          writeStatementPageLocalState(statementPayload)
          statementCloudSaveSigRef.current = nextSig
          markStatementSaved()
        })
        .catch((error) => {
          console.error('거래명세 클라우드 저장에 실패했습니다.', error)
          markStatementError()
        })
    }, 600)

    return () => window.clearTimeout(timeoutId)
  }, [
    activeCompanyId,
    isPricingStorageReady,
    isMasterItemsStorageReady,
    isRecordsStorageReady,
    isStatementCloudReady,
    masterItems,
    mode,
    pricingRules,
    records,
    statementTemplateBase64,
    statementTemplateFileName,
    statementTemplateSettings,
    statementTemplateUpdatedAt,
    user?.id,
    markStatementDirty,
    markStatementError,
    markStatementSaved,
    markStatementSaving,
    skipInitialStatementSave,
    statementSaveState,
  ])

  useEffect(() => {
    let isMounted = true

    if (mode === 'cloud') {
      setIsBackupReady(true)
      return () => {
        isMounted = false
      }
    }

    const restoreBackupFile = async () => {
      try {
        const storedHandle = await loadStoredFileHandle()

        if (!storedHandle) {
          if (isMounted) {
            setIsBackupReady(true)
          }
          return
        }

        const permission =
          (await (storedHandle as FileHandleWithPermission).queryPermission?.({
            mode: 'readwrite',
          })) ?? 'granted'

        if (permission !== 'granted') {
          if (isMounted) {
            setIsBackupReady(true)
          }
          return
        }

        const backupPayload = await readBackupFile(storedHandle)

        if (!isMounted) {
          return
        }

        setBackupFileHandle(storedHandle)
        if (backupPayload) {
          lastBackupSnapshotRef.current = JSON.stringify({
            ...backupPayload,
            savedAt: '',
          })
          setRecords(backupPayload.records)
          setPricingRules(backupPayload.pricingRules)
          if (backupPayload.activePage) {
            setActivePage(backupPayload.activePage)
            window.localStorage.setItem(ACTIVE_PAGE_STORAGE_KEY, backupPayload.activePage)
          }
          syncBackupStorageValue(MONTHLY_MEETING_DATA_KEY, backupPayload.monthlyMeetingState ?? '')
          syncBackupStorageValue(INVENTORY_STATUS_STORAGE_KEY, backupPayload.inventoryState ?? '')
          syncBackupStorageValue(
            INVENTORY_STATUS_BASELINE_STORAGE_KEY,
            backupPayload.inventoryBaselineState ?? '',
          )
          syncBackupStorageValue(
            INVENTORY_STATUS_TEMPLATE_STORAGE_KEY,
            backupPayload.inventoryTemplateBase64 ?? '',
          )
          syncBackupStorageValue(
            INVENTORY_STATUS_TEMPLATE_NAME_STORAGE_KEY,
            backupPayload.inventoryTemplateFileName ?? '',
          )
          window.localStorage.setItem(INVENTORY_AUTO_STOCK_MODE_KEY, 'true')
          syncBackupStorageValue(EXPENSE_PAGE_STORAGE_KEY, backupPayload.expenseState ?? '')
          syncBackupStorageValue(STAFF_PAYROLL_STORAGE_KEY, backupPayload.staffPayrollState ?? '')
          syncBackupStorageValue(GREEN_BEAN_ORDER_STORAGE_KEY, backupPayload.greenBeanOrderState ?? '')
          syncBackupStorageValue(MEMO_PAGE_STORAGE_KEY, backupPayload.memoState ?? '')
          syncBackupStorageValue(STATEMENT_TEMPLATE_STORAGE_KEY, backupPayload.statementTemplateBase64 ?? '')
          syncBackupStorageValue(
            STATEMENT_TEMPLATE_NAME_STORAGE_KEY,
            backupPayload.statementTemplateFileName ?? '',
          )
          syncBackupStorageValue(
            STATEMENT_TEMPLATE_UPDATED_AT_STORAGE_KEY,
            backupPayload.statementTemplateUpdatedAt ?? '',
          )
          syncBackupStorageValue(
            STATEMENT_TEMPLATE_SETTINGS_STORAGE_KEY,
            backupPayload.statementTemplateSettings ?? '',
          )
          setStatementTemplateBase64(backupPayload.statementTemplateBase64 || null)
          setStatementTemplateFileName(backupPayload.statementTemplateFileName ?? '')
          setStatementTemplateUpdatedAt(backupPayload.statementTemplateUpdatedAt ?? '')
          try {
            setStatementTemplateSettings(
              normalizeStatementTemplateSettings(
                backupPayload.statementTemplateSettings
                  ? JSON.parse(backupPayload.statementTemplateSettings)
                  : null,
              ),
            )
          } catch {
            setStatementTemplateSettings({ ...DEFAULT_STATEMENT_TEMPLATE_SETTINGS })
          }
        }
      } catch (error) {
        console.error('로컬 저장 파일을 복원하지 못했습니다.', error)
      } finally {
        if (isMounted) {
          setIsBackupReady(true)
        }
      }
    }

    void restoreBackupFile()

    return () => {
      isMounted = false
    }
  }, [mode])

  useEffect(() => {
    let isMounted = true

    const restoreExcelExportDir = async () => {
      try {
        const dir = await loadStoredExportDirectoryHandle()
        if (!dir || !isMounted) {
          return
        }

        const perm =
          (await (dir as DirectoryHandleWithPermission).queryPermission?.({
            mode: 'readwrite',
          })) ?? 'granted'

        if (perm !== 'granted') {
          if (isMounted) {
            setExcelExportFolderMessage(
              '저장 폴더 권한이 없습니다.「저장 폴더」를 다시 눌러주세요.',
            )
          }
          return
        }

        if (isMounted) {
          setExcelExportDirHandle(dir)
          setExcelExportFolderMessage('')
        }
      } catch (error) {
        console.error('저장된 엑셀 폴더를 불러오지 못했습니다.', error)
      }
    }

    void restoreExcelExportDir()

    return () => {
      isMounted = false
    }
  }, [])

  useEffect(() => {
    if (!backupFileHandle || !isBackupReady) {
      return
    }

    const saveBackup = async () => {
      try {
        const snapshot = getBackupSnapshot(records, pricingRules)
        if (snapshot === lastBackupSnapshotRef.current) {
          return
        }

        await writeBackupFile(backupFileHandle, records, pricingRules)
        lastBackupSnapshotRef.current = snapshot
      } catch (error) {
        console.error('로컬 저장 파일에 쓰지 못했습니다.', error)
      }
    }

    void saveBackup()
  }, [backupFileHandle, isBackupReady, pricingRules, records])

  useEffect(() => {
    if (!backupFileHandle || !isBackupReady) {
      return
    }

    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const snapshot = getBackupSnapshot(records, pricingRules)
          if (snapshot === lastBackupSnapshotRef.current) {
            return
          }

          await writeBackupFile(backupFileHandle, records, pricingRules)
          lastBackupSnapshotRef.current = snapshot
        } catch (error) {
          console.error('전체 백업 자동 저장에 실패했습니다.', error)
        }
      })()
    }, 3000)

    return () => window.clearInterval(interval)
  }, [backupFileHandle, isBackupReady, pricingRules, records])

  const calculatedAmounts = useMemo(() => {
    const quantity = parseNumber(form.quantity)
    const unitPrice = parseNumber(form.unitPrice)
    const supplyAmount = quantity * unitPrice
    const taxAmount = calculateTaxAmount(supplyAmount, form.note)
    const totalAmount = supplyAmount + taxAmount

    return { quantity, unitPrice, supplyAmount, taxAmount, totalAmount }
  }, [form.note, form.quantity, form.unitPrice])

  const grandTotal = useMemo(
    () => records.reduce((sum, record) => sum + record.totalAmount, 0),
    [records],
  )

  const availableYears = useMemo(() => {
    const years = new Set([String(CURRENT_YEAR)])
    records.forEach((record) => years.add(record.deliveryDate.slice(0, 4)))
    return Array.from(years).sort((a, b) => Number(b) - Number(a))
  }, [records])

  const clientOptions = useMemo(() => {
    const merged = new Set<string>()
    pricingRules.forEach((rule) => merged.add(rule.clientName))
    records.forEach((record) => {
      if (record.clientName.trim()) {
        merged.add(record.clientName.trim())
      }
    })
    return Array.from(merged).sort((a, b) => a.localeCompare(b, 'ko'))
  }, [pricingRules, records])

  const pricingRulesGrouped = useMemo(() => {
    const map = new Map<string, { displayName: string; rules: PricingRule[] }>()
    for (const rule of pricingRules) {
      const key = normalizeName(rule.clientName)
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { displayName: rule.clientName.trim(), rules: [rule] })
      } else {
        existing.rules.push(rule)
      }
    }
    for (const bucket of map.values()) {
      bucket.rules.sort((a, b) =>
        `${a.itemName}\u0000${a.specUnit}`.localeCompare(`${b.itemName}\u0000${b.specUnit}`, 'ko'),
      )
    }
    return Array.from(map.entries())
      .map(([clientKey, bucket]) => ({ clientKey, displayName: bucket.displayName, rules: bucket.rules }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'))
  }, [pricingRules])

  const pricingAdminRulesForView = useMemo(() => {
    if (!pricingAdminClientKey) {
      return []
    }
    return pricingRules.filter((r) => normalizeName(r.clientName) === pricingAdminClientKey)
  }, [pricingAdminClientKey, pricingRules])

  const pricingAdminClientSaveLabel = useMemo(() => {
    if (!pricingAdminClientKey) {
      return ''
    }
    const fromRule = pricingRules.find((r) => normalizeName(r.clientName) === pricingAdminClientKey)
    if (fromRule?.clientName.trim()) {
      return fromRule.clientName.trim()
    }
    return pricingAdminClientInput.trim()
  }, [pricingAdminClientKey, pricingAdminClientInput, pricingRules])

  useEffect(() => {
    setPricingAdminLineDraft({ itemName: '', specUnit: '', unitPrice: '' })
  }, [pricingAdminClientKey])

  const selectedClientPricingRules = useMemo(
    () =>
      pricingRules.filter(
        (rule) => normalizeName(rule.clientName) === normalizeName(form.clientName),
      ),
    [form.clientName, pricingRules],
  )

  const hasPricingForSelectedClient = selectedClientPricingRules.length > 0

  const allItemOptions = useMemo(() => {
    const merged = new Set<string>(DEFAULT_ITEM_OPTIONS)
    masterItems.forEach((item) => {
      if (item.itemName.trim()) {
        merged.add(item.itemName.trim())
      }
    })
    pricingRules.forEach((rule) => {
      if (rule.itemName.trim()) {
        merged.add(rule.itemName.trim())
      }
    })
    records.forEach((record) => {
      if (record.itemName.trim()) {
        merged.add(record.itemName.trim())
      }
    })
    return Array.from(merged)
  }, [masterItems, pricingRules, records])

  const itemOptions = useMemo(() => {
    const clientItems = selectedClientPricingRules.map((rule) => rule.itemName)
    const masterNames = masterItems.map((item) => item.itemName)

    if (clientItems.length === 0) {
      return allItemOptions
    }

    return Array.from(new Set([...clientItems, ...masterNames])).sort((a, b) => a.localeCompare(b, 'ko'))
  }, [allItemOptions, masterItems, selectedClientPricingRules])

  const bulkPickerVisibleItems = useMemo(() => {
    const q = bulkItemPickerQuery.trim().toLowerCase()
    if (!q) {
      return itemOptions
    }
    return itemOptions.filter((name) => name.toLowerCase().includes(q))
  }, [bulkItemPickerQuery, itemOptions])

  const matchingPricingRule = useMemo(
    () =>
      selectedClientPricingRules.find(
        (rule) =>
          normalizeName(rule.itemName) === normalizeName(form.itemName),
      ) ?? null,
    [form.itemName, selectedClientPricingRules],
  )

  const matchingMasterItem = useMemo(
    () =>
      masterItems.find(
        (item) => normalizeName(item.itemName) === normalizeName(form.itemName),
      ) ?? null,
    [form.itemName, masterItems],
  )

  const showSpecOtherInput = useMemo(() => {
    const specTrim = form.specUnit.trim()
    return (
      (specTrim !== '' && !QUICK_SPEC_VALUES.has(specTrim)) ||
      (isCustomSpec && specTrim === '')
    )
  }, [form.specUnit, isCustomSpec])

  const activeQuickSpecOptions = useMemo(() => {
    if (isDutchItemName(form.itemName)) {
      return QUICK_SPEC_OPTIONS_DUTCH
    }
    return QUICK_SPEC_OPTIONS_BEAN
  }, [form.itemName])

  const filteredRecords = useMemo(
    () => records.filter((record) => record.deliveryDate.startsWith(selectedYear)),
    [records, selectedYear],
  )

  const statementPreviewRecords = useMemo(
    () => [...records].sort(compareStatementRecordsNewestFirst),
    [records],
  )

  const recordsSortedForMainList = useMemo(() => {
    const seqById = statementRecordDeliveryMonthSeqById(records)
    return [...statementPreviewRecords].sort((a, b) =>
      compareStatementRecordsForListSort(a, b, recordListSort, seqById),
    )
  }, [recordListSort, records, statementPreviewRecords])

  const visibleRecords = useMemo(() => {
    const todayIso = new Date().toISOString().slice(0, 10)
    const today = new Date(todayIso)
    const startOfWeek = new Date(today)
    startOfWeek.setDate(today.getDate() - 6)
    const startOfWeekIso = startOfWeek.toISOString().slice(0, 10)
    const currentMonth = todayIso.slice(0, 7)
    const query = recordsSearchQuery.trim().toLowerCase()

    return recordsSortedForMainList.filter((record) => {
      if (recordsRangeFilter === 'year' && !record.deliveryDate.startsWith(selectedYear)) {
        return false
      }
      if (recordsRangeFilter === 'month' && !record.deliveryDate.startsWith(currentMonth)) {
        return false
      }
      if (recordsRangeFilter === 'week' && record.deliveryDate < startOfWeekIso) {
        return false
      }
      if (recordsNoteFilter !== 'all' && record.note !== recordsNoteFilter) {
        return false
      }
      if (query) {
        const haystack = `${record.clientName} ${record.itemName} ${record.specUnit} ${record.note}`.toLowerCase()
        if (!haystack.includes(query)) {
          return false
        }
      }
      return true
    })
  }, [recordsRangeFilter, recordsNoteFilter, recordsSearchQuery, recordsSortedForMainList, selectedYear])

  const handleRecordListSortClick = useCallback((key: StatementListSortKey) => {
    setRecordListSort((prev) => {
      if (prev.key === key) {
        return { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      }
      if (key === 'number') {
        return { key: 'number', dir: 'desc' }
      }
      if (key === 'deliveryDate') {
        return { key: 'deliveryDate', dir: 'desc' }
      }
      if (key === 'clientName') {
        return { key: 'clientName', dir: 'asc' }
      }
      return { key: 'itemName', dir: 'asc' }
    })
  }, [])

  const visibleTotals = useMemo(() => {
    return visibleRecords.reduce(
      (acc, record) => {
        acc.supply += record.supplyAmount
        acc.tax += record.taxAmount
        acc.total += record.totalAmount
        return acc
      },
      { supply: 0, tax: 0, total: 0 },
    )
  }, [visibleRecords])

  const recentRecordsForClient = useMemo(() => {
    const clientKey = normalizeName(form.clientName)
    if (!clientKey) {
      return []
    }
    return statementPreviewRecords
      .filter((record) => normalizeName(record.clientName) === clientKey)
      .slice(0, 5)
  }, [form.clientName, statementPreviewRecords])

  const clientMonthSnapshot = useMemo(() => {
    const clientKey = normalizeName(form.clientName)
    if (!clientKey) {
      return null
    }
    const currentMonth = new Date().toISOString().slice(0, 7)
    let count = 0
    let totalAmount = 0
    let quantity = 0
    let lastDeliveryDate = ''
    records.forEach((record) => {
      if (normalizeName(record.clientName) !== clientKey) {
        return
      }
      if (!lastDeliveryDate || record.deliveryDate > lastDeliveryDate) {
        lastDeliveryDate = record.deliveryDate
      }
      if (record.deliveryDate.startsWith(currentMonth)) {
        count += 1
        totalAmount += record.totalAmount
        quantity += record.quantity
      }
    })
    return { count, totalAmount, quantity, lastDeliveryDate, currentMonth }
  }, [form.clientName, records])

  const duplicateCandidate = useMemo(() => {
    const clientKey = normalizeName(form.clientName)
    const itemKey = normalizeName(form.itemName)
    if (!clientKey || !itemKey || !form.deliveryDate) {
      return null
    }
    const match = records.find(
      (record) =>
        record.id !== editingRecordId &&
        record.deliveryDate === form.deliveryDate &&
        normalizeName(record.clientName) === clientKey &&
        normalizeName(record.itemName) === itemKey,
    )
    return match ?? null
  }, [form.clientName, form.deliveryDate, form.itemName, records, editingRecordId])

  const clientCardStats = useMemo(() => {
    const grouped = new Map<
      string,
      {
        clientName: string
        totalAmount: number
        count: number
        lastDeliveryDate: string
        monthAmount: number
      }
    >()
    const currentMonth = new Date().toISOString().slice(0, 7)
    statementPreviewRecords.forEach((record) => {
      const key = normalizeName(record.clientName)
      if (!key) return
      const existing = grouped.get(key) ?? {
        clientName: record.clientName,
        totalAmount: 0,
        count: 0,
        lastDeliveryDate: '',
        monthAmount: 0,
      }
      existing.totalAmount += record.totalAmount
      existing.count += 1
      if (!existing.lastDeliveryDate || record.deliveryDate > existing.lastDeliveryDate) {
        existing.lastDeliveryDate = record.deliveryDate
      }
      if (record.deliveryDate.startsWith(currentMonth)) {
        existing.monthAmount += record.totalAmount
      }
      grouped.set(key, existing)
    })
    return Array.from(grouped.values()).sort((a, b) => b.totalAmount - a.totalAmount)
  }, [statementPreviewRecords])

  const calendarEntries = useMemo(() => {
    const map = new Map<string, { count: number; totalAmount: number; records: StatementRecord[] }>()
    statementPreviewRecords.forEach((record) => {
      if (!record.deliveryDate.startsWith(calendarMonth)) {
        return
      }
      const existing = map.get(record.deliveryDate) ?? {
        count: 0,
        totalAmount: 0,
        records: [] as StatementRecord[],
      }
      existing.count += 1
      existing.totalAmount += record.totalAmount
      existing.records.push(record)
      map.set(record.deliveryDate, existing)
    })
    return map
  }, [statementPreviewRecords, calendarMonth])

  const statementDeliveryMonthSeqById = useMemo(
    () => statementRecordDeliveryMonthSeqById(records),
    [records],
  )

  const totalSupplyAmount = useMemo(
    () => statementPreviewRecords.reduce((sum, record) => sum + record.supplyAmount, 0),
    [statementPreviewRecords],
  )

  const yearlyTotal = useMemo(
    () => filteredRecords.reduce((sum, row) => sum + row.totalAmount, 0),
    [filteredRecords],
  )

  const monthlyTotals = useMemo(
    () =>
      MONTH_LABELS.map((_, index) =>
        filteredRecords.reduce((sum, record) => {
          const monthIndex = Number(record.deliveryDate.slice(5, 7)) - 1
          return monthIndex === index ? sum + record.totalAmount : sum
        }, 0),
      ),
    [filteredRecords],
  )

  const statementSheetGroups = useMemo(() => {
    const grouped = new Map<string, StatementSheetGroup>()

    statementPreviewRecords.forEach((record) => {
      const key = `${record.deliveryDate}__${record.clientName}__${record.deliveryCount}`
      const existing =
        grouped.get(key) ??
        ({
          key,
          deliveryDate: record.deliveryDate,
          issueDate: record.issueDate,
          clientName: record.clientName,
          deliveryCount: record.deliveryCount,
          records: [],
          supplyAmount: 0,
          taxAmount: 0,
          totalAmount: 0,
        } satisfies StatementSheetGroup)

      existing.records.push(record)
      existing.supplyAmount += record.supplyAmount
      existing.taxAmount += record.taxAmount
      existing.totalAmount += record.totalAmount

      grouped.set(key, existing)
    })

    return Array.from(grouped.values())
  }, [statementPreviewRecords])

  const selectedSheet = useMemo(() => {
    if (statementSheetGroups.length === 0) {
      return null
    }

    return (
      statementSheetGroups.find((group) => group.key === selectedSheetKey) ?? statementSheetGroups[0]
    )
  }, [selectedSheetKey, statementSheetGroups])

  useEffect(() => {
    if (statementSheetGroups.length === 0) {
      if (selectedSheetKey) {
        setSelectedSheetKey('')
      }
      return
    }

    const hasSelected = statementSheetGroups.some((group) => group.key === selectedSheetKey)

    if (!hasSelected) {
      setSelectedSheetKey(statementSheetGroups[0].key)
    }
  }, [selectedSheetKey, statementSheetGroups])

  useEffect(() => {
    if (matchingPricingRule) {
      setForm((current) => ({
        ...current,
        specUnit: matchingPricingRule.specUnit || current.specUnit,
        unitPrice: String(matchingPricingRule.unitPrice),
      }))

      if (matchingPricingRule.specUnit) {
        setIsCustomSpec(false)
      }
      return
    }

    if (matchingMasterItem) {
      setForm((current) => ({
        ...current,
        specUnit: matchingMasterItem.specUnit || current.specUnit,
        unitPrice: String(matchingMasterItem.unitPrice),
      }))

      if (matchingMasterItem.specUnit) {
        setIsCustomSpec(false)
      }
      return
    }

    if (hasPricingForSelectedClient && form.itemName) {
      setForm((current) => ({
        ...current,
        unitPrice: '',
        specUnit: isCustomSpec ? current.specUnit : '',
      }))
    }
  }, [form.itemName, hasPricingForSelectedClient, isCustomSpec, matchingMasterItem, matchingPricingRule])

  const summaryRows = useMemo(() => {
    const grouped = new Map<string, MonthlySummaryRow>()

    filteredRecords.forEach((record) => {
      const monthIndex = Number(record.deliveryDate.slice(5, 7)) - 1
      const existing =
        grouped.get(record.clientName) ??
        ({
          clientName: record.clientName,
          totalAmount: 0,
          share: 0,
          months: Array.from({ length: 12 }, () => ({
            amount: 0,
            issueDate: '',
            paymentDate: '',
          })),
        } satisfies MonthlySummaryRow)

      const currentMonth = existing.months[monthIndex]

      existing.totalAmount += record.totalAmount
      currentMonth.amount += record.totalAmount
      currentMonth.issueDate = pickLatestDate([currentMonth.issueDate, record.issueDate])
      currentMonth.paymentDate = pickLatestDate([currentMonth.paymentDate, record.paymentDate])

      grouped.set(record.clientName, existing)
    })

    return Array.from(grouped.values())
      .map((row) => ({
        ...row,
        share: yearlyTotal ? (row.totalAmount / yearlyTotal) * 100 : 0,
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount)
  }, [filteredRecords])

  useLayoutEffect(() => {
    if (activePage !== 'statements') {
      setStatementStickyHScrollVisible(false)
      return
    }

    const tableHost = statementMainTableScrollRef.current
    const sticky = statementStickyHScrollRef.current
    const inner = statementStickyHScrollInnerRef.current
    if (!tableHost || !sticky || !inner) {
      return
    }

    const table = tableHost.querySelector('table')

    const measureAndSync = () => {
      const scrollW = tableHost.scrollWidth
      const clientW = tableHost.clientWidth
      const needBar = scrollW > clientW + 1
      setStatementStickyHScrollVisible(needBar)
      inner.style.width = `${scrollW}px`
      if (needBar) {
        sticky.scrollLeft = tableHost.scrollLeft
      }
    }

    const onTableScroll = () => {
      if (statementHScrollSyncingRef.current) {
        return
      }
      statementHScrollSyncingRef.current = true
      sticky.scrollLeft = tableHost.scrollLeft
      statementHScrollSyncingRef.current = false
    }

    const onStickyScroll = () => {
      if (statementHScrollSyncingRef.current) {
        return
      }
      statementHScrollSyncingRef.current = true
      tableHost.scrollLeft = sticky.scrollLeft
      statementHScrollSyncingRef.current = false
    }

    tableHost.addEventListener('scroll', onTableScroll, { passive: true })
    sticky.addEventListener('scroll', onStickyScroll, { passive: true })

    const ro = new ResizeObserver(() => {
      requestAnimationFrame(measureAndSync)
    })
    ro.observe(tableHost)
    if (table) {
      ro.observe(table)
    }

    window.addEventListener('resize', measureAndSync)

    measureAndSync()

    return () => {
      tableHost.removeEventListener('scroll', onTableScroll)
      sticky.removeEventListener('scroll', onStickyScroll)
      ro.disconnect()
      window.removeEventListener('resize', measureAndSync)
    }
  }, [activePage, activeView, records, filteredRecords, summaryRows, selectedYear])

  const handleFieldChange = (field: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const applyPricingRuleToForm = (clientName: string, itemName: string) => {
    const rule = pricingRules.find(
      (entry) =>
        normalizeName(entry.clientName) === normalizeName(clientName) &&
        normalizeName(entry.itemName) === normalizeName(itemName),
    )

    if (rule) {
      setForm((current) => ({
        ...current,
        clientName,
        itemName,
        specUnit: rule.specUnit || current.specUnit,
        unitPrice: String(rule.unitPrice),
      }))

      if (rule.specUnit) {
        setIsCustomSpec(false)
      }
      return
    }

    const master = masterItems.find(
      (entry) => normalizeName(entry.itemName) === normalizeName(itemName),
    )

    if (!master) {
      return
    }

    setForm((current) => ({
      ...current,
      clientName,
      itemName,
      specUnit: master.specUnit || current.specUnit,
      unitPrice: String(master.unitPrice),
    }))

    if (master.specUnit) {
      setIsCustomSpec(false)
    }
  }

  const handleClientSelectionChange = (value: string) => {
    if (value === CUSTOM_CLIENT_OPTION) {
      setIsCustomClient(true)
      setForm((current) => ({ ...current, clientName: '', itemName: '', specUnit: '', unitPrice: '' }))
      setIsCustomItem(false)
      setIsCustomSpec(false)
      return
    }

    setIsCustomClient(false)
    const nextClientRules = pricingRules.filter(
      (rule) => normalizeName(rule.clientName) === normalizeName(value),
    )

    setForm((current) => ({
      ...current,
      clientName: value,
      itemName:
        nextClientRules.some(
          (rule) => normalizeName(rule.itemName) === normalizeName(current.itemName),
        ) || nextClientRules.length === 0
          ? current.itemName
          : '',
      specUnit:
        nextClientRules.some(
          (rule) => normalizeName(rule.itemName) === normalizeName(current.itemName),
        ) || nextClientRules.length === 0
          ? current.specUnit
          : '',
      unitPrice:
        nextClientRules.some(
          (rule) => normalizeName(rule.itemName) === normalizeName(current.itemName),
        ) || nextClientRules.length === 0
          ? current.unitPrice
          : '',
    }))

    if (nextClientRules.length > 0) {
      setIsCustomItem(false)
      setIsCustomSpec(false)
    }

    applyPricingRuleToForm(value, form.itemName)
  }

  const handleItemSelectionChange = (value: string) => {
    if (value === CUSTOM_ITEM_OPTION) {
      setIsCustomItem(true)
      setForm((current) => ({ ...current, itemName: '' }))
      return
    }

    setIsCustomItem(false)
    setForm((current) => ({ ...current, itemName: value }))
    applyPricingRuleToForm(form.clientName, value)
  }

  const resetBulkItemPickerPick = () =>
    setBulkItemPickerPick({ selected: new Set(), quantities: {} })

  const handleOpenBulkItemPicker = () => {
    if (!form.clientName.trim()) {
      window.alert('거래처명을 먼저 선택하거나 입력해주세요.')
      return
    }
    setBulkItemPickerQuery('')
    resetBulkItemPickerPick()
    setBulkItemPickerOpen(true)
  }

  const handleCloseBulkItemPicker = () => {
    setBulkItemPickerOpen(false)
    setBulkItemPickerQuery('')
    resetBulkItemPickerPick()
  }

  const bulkPickerDefaultQtyString = () => {
    const q = parseNumber(form.quantity)
    return q > 0 ? String(q) : '1'
  }

  const handleBulkItemPickerToggle = (itemName: string) => {
    setBulkItemPickerPick((prev) => {
      const selected = new Set(prev.selected)
      const quantities = { ...prev.quantities }
      const def = bulkPickerDefaultQtyString()
      if (selected.has(itemName)) {
        selected.delete(itemName)
        delete quantities[itemName]
      } else {
        selected.add(itemName)
        quantities[itemName] = quantities[itemName] ?? def
      }
      return { selected, quantities }
    })
  }

  const handleBulkItemPickerSelectAllVisible = () => {
    setBulkItemPickerPick((prev) => {
      const selected = new Set(prev.selected)
      const quantities = { ...prev.quantities }
      const def = bulkPickerDefaultQtyString()
      bulkPickerVisibleItems.forEach((name) => {
        selected.add(name)
        if (!quantities[name]) {
          quantities[name] = def
        }
      })
      return { selected, quantities }
    })
  }

  const handleBulkItemPickerClearVisible = () => {
    setBulkItemPickerPick((prev) => {
      const selected = new Set(prev.selected)
      const quantities = { ...prev.quantities }
      bulkPickerVisibleItems.forEach((name) => {
        selected.delete(name)
        delete quantities[name]
      })
      return { selected, quantities }
    })
  }

  const handleBulkItemPickerQtyChange = (itemName: string, value: string) => {
    setBulkItemPickerPick((prev) => ({
      selected: new Set(prev.selected),
      quantities: { ...prev.quantities, [itemName]: value },
    }))
  }

  const handleBulkAddStatementItems = () => {
    const clientTrim = form.clientName.trim()
    if (!clientTrim) {
      window.alert('거래처명을 먼저 선택하거나 입력해주세요.')
      return
    }
    if (!form.deliveryDate) {
      window.alert('납품일을 입력해주세요.')
      return
    }
    const selectedNames = Array.from(bulkItemPickerPick.selected)
    if (selectedNames.length === 0) {
      window.alert('추가할 품목을 하나 이상 선택해주세요.')
      return
    }

    const unresolved: string[] = []
    const zeroPrice: string[] = []
    const newRecords: StatementRecord[] = []

    for (const rawName of selectedNames) {
      const itemLabel = rawName.trim()
      const resolved = resolveStatementPricingForClientItem(
        pricingRules,
        masterItems,
        clientTrim,
        itemLabel,
      )
      if (!resolved) {
        unresolved.push(itemLabel)
        continue
      }
      if (resolved.unitPrice <= 0) {
        zeroPrice.push(itemLabel)
        continue
      }
      const qtyRaw = bulkItemPickerPick.quantities[itemLabel] ?? ''
      let quantity = parseNumber(qtyRaw)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        quantity = 1
      }
      const supplyAmount = quantity * resolved.unitPrice
      const taxAmount = calculateTaxAmount(supplyAmount, form.note)
      newRecords.push({
        id: crypto.randomUUID(),
        deliveryDate: form.deliveryDate,
        issueDate: form.deliveryDate,
        paymentDate: '',
        deliveryCount: form.deliveryCount,
        clientName: clientTrim,
        itemName: itemLabel,
        specUnit: resolved.specUnit,
        quantity,
        unitPrice: resolved.unitPrice,
        note: form.note,
        supplyAmount,
        taxAmount,
        totalAmount: supplyAmount + taxAmount,
        savedAt: new Date(Date.now() + newRecords.length).toISOString(),
      })
    }

    const skipped = [...unresolved, ...zeroPrice]

    if (newRecords.length === 0) {
      window.alert(
        skipped.length
          ? `단가를 적용할 수 있는 품목이 없습니다.\n제외: ${skipped.join(', ')}`
          : '추가할 수 있는 품목이 없습니다.',
      )
      return
    }

    const hasDuplicateAgainstExisting = newRecords.some((r) =>
      records.some(
        (rec) =>
          rec.id !== editingRecordId &&
          rec.deliveryDate === r.deliveryDate &&
          normalizeName(rec.clientName) === normalizeName(r.clientName) &&
          normalizeName(rec.itemName) === normalizeName(r.itemName),
      ),
    )
    if (
      hasDuplicateAgainstExisting &&
      !window.confirm('선택한 품목 중 일부는 같은 날짜·거래처에 이미 있습니다. 그래도 추가할까요?')
    ) {
      return
    }

    setRecords((current) => [...newRecords, ...current].sort(compareStatementRecordsNewestFirst))
    handleCloseBulkItemPicker()

    if (skipped.length > 0) {
      window.alert(`${newRecords.length}건을 추가했습니다.\n단가 없음·0원으로 제외: ${skipped.join(', ')}`)
    }
  }

  const handleSpecSelectionChange = (value: string) => {
    setIsCustomSpec(false)
    setForm((current) => ({ ...current, specUnit: value }))
  }

  const handleSpecOtherInputChange = (value: string) => {
    handleFieldChange('specUnit', value)
    setIsCustomSpec(value.trim() !== '' && !QUICK_SPEC_VALUES.has(value.trim()))
  }

  const saveExcelToPreferredFolder = async (
    buffer: ArrayBuffer | Uint8Array,
    filename: string,
  ): Promise<boolean> => {
    const dir = excelExportDirHandle
    if (!dir) {
      downloadExcelBuffer(buffer, filename)
      return true
    }

    try {
      let perm =
        (await (dir as DirectoryHandleWithPermission).queryPermission?.({
          mode: 'readwrite',
        })) ?? 'granted'

      if (perm !== 'granted') {
        const requested = await (dir as DirectoryHandleWithPermission).requestPermission?.({
          mode: 'readwrite',
        })
        perm = requested ?? 'denied'
      }

      if (perm !== 'granted') {
        setExcelExportFolderMessage('폴더 쓰기 권한이 없어 다운로드로 저장했습니다.')
        downloadExcelBuffer(buffer, filename)
        return true
      }

      const showSaveFilePicker = (
        window as Window & {
          showSaveFilePicker?: (options?: {
            suggestedName?: string
            startIn?: FileSystemHandle
            types?: Array<{ description: string; accept: Record<string, string[]> }>
          }) => Promise<FileSystemFileHandle>
        }
      ).showSaveFilePicker

      if (showSaveFilePicker) {
        try {
          const fileHandle = await showSaveFilePicker({
            suggestedName: filename,
            startIn: dir,
            types: [
              {
                description: 'Excel 통합문서',
                accept: {
                  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
                },
              },
            ],
          })
          const writable = await fileHandle.createWritable()
          await writable.write(toArrayBuffer(buffer))
          await writable.close()
          setExcelExportFolderMessage(`저장했습니다. (${filename})`)
          return true
        } catch (pickerError) {
          if (pickerError instanceof DOMException && pickerError.name === 'AbortError') {
            setExcelExportFolderMessage('저장 창에서 취소했습니다. 파일은 저장되지 않았습니다.')
            return false
          }
          console.error('저장 창으로 저장 실패, 지정 폴더에 바로 씁니다:', pickerError)
        }
      }

      await writeBufferToDirectory(dir, filename, buffer)
      setExcelExportFolderMessage(`저장함: ${dir.name} / ${filename}`)
      return true
    } catch (error) {
      console.error('엑셀 폴더 저장 실패:', error)
      setExcelExportFolderMessage('지정 폴더에 저장하지 못해 다운로드로 저장했습니다.')
      downloadExcelBuffer(buffer, filename)
      return true
    }
  }

  const handlePickExcelExportFolder = async () => {
    const picker = (
      window as Window & { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> }
    ).showDirectoryPicker

    if (!picker) {
      setExcelExportFolderMessage('이 브라우저는 폴더 지정을 지원하지 않습니다. (Chrome·Edge 권장)')
      return
    }

    try {
      const dir = await picker()
      await saveStoredExportDirectoryHandle(dir)
      setExcelExportDirHandle(dir)
      setExcelExportFolderMessage('')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }

      console.error('엑셀 저장 폴더 선택 실패:', error)
      setExcelExportFolderMessage(
        error instanceof Error ? error.message : '폴더를 선택하지 못했습니다.',
      )
    }
  }

  const handleClearExcelExportFolder = async () => {
    try {
      await clearStoredExportDirectoryHandle()
      setExcelExportDirHandle(null)
      setExcelExportFolderMessage('저장 폴더 지정을 해제했습니다. 이후는 기본 다운로드로 저장됩니다.')
    } catch (error) {
      console.error('엑셀 저장 폴더 해제 실패:', error)
      setExcelExportFolderMessage('폴더 해제에 실패했습니다.')
    }
  }

  const pricingRuleDedupeKey = (clientName: string, itemName: string, specUnit: string) =>
    [normalizeName(clientName), normalizeName(itemName), normalizeName(specUnit)].join('\0')

  const upsertPricingRuleRow = (
    rawClient: string,
    rawItem: string,
    rawSpec: string,
    rawUnitPrice: string,
  ): boolean => {
    const clientName = rawClient.trim()
    const itemName = rawItem.trim()
    const specUnit = rawSpec.trim()
    const unitPrice = Number(rawUnitPrice.replaceAll(',', '').trim() || '0')

    if (!clientName || !itemName) {
      setPricingRuleFormMessage('거래처명과 품목은 꼭 입력해주세요.')
      return false
    }
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      setPricingRuleFormMessage('단가는 0보다 큰 숫자로 입력해주세요.')
      return false
    }

    const dedupe = pricingRuleDedupeKey(clientName, itemName, specUnit)
    setPricingRules((current) => {
      const filtered = current.filter(
        (r) => pricingRuleDedupeKey(r.clientName, r.itemName, r.specUnit) !== dedupe,
      )
      const nextRule: PricingRule = {
        id: crypto.randomUUID(),
        clientName,
        itemName,
        specUnit,
        unitPrice,
      }
      return [...filtered, nextRule].sort((a, b) =>
        `${a.clientName}-${a.itemName}`.localeCompare(`${b.clientName}-${b.itemName}`, 'ko'),
      )
    })
    setPricingRuleFormMessage(`「${clientName}」·「${itemName}」 저장`)
    return true
  }

  const handlePricingAdminDropdownChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value
    if (!value) {
      setPricingAdminClientKey('')
      setPricingAdminClientInput('')
      return
    }
    const row = pricingRulesGrouped.find((g) => g.clientKey === value)
    setPricingAdminClientKey(value)
    setPricingAdminClientInput(row?.displayName ?? '')
  }

  const handleOpenPricingAdminClientFromInput = () => {
    const raw = pricingAdminClientInput.trim()
    if (!raw) {
      setPricingRuleFormMessage('거래처명을 입력하거나 목록에서 고르세요.')
      return
    }
    const key = normalizeName(raw)
    const row = pricingRulesGrouped.find((g) => g.clientKey === key)
    setPricingAdminClientKey(key)
    setPricingAdminClientInput(row?.displayName ?? raw)
    setPricingRuleFormMessage('')
  }

  const handleSavePricingAdminLine = () => {
    if (!pricingAdminClientKey || !pricingAdminClientSaveLabel) {
      setPricingRuleFormMessage('거래처를 먼저 선택하세요.')
      return
    }
    if (
      upsertPricingRuleRow(
        pricingAdminClientSaveLabel,
        pricingAdminLineDraft.itemName,
        pricingAdminLineDraft.specUnit,
        pricingAdminLineDraft.unitPrice,
      )
    ) {
      setPricingAdminLineDraft({ itemName: '', specUnit: '', unitPrice: '' })
    }
  }

  const handleRemovePricingRule = (id: string) => {
    const target = pricingRules.find((r) => r.id === id)
    if (!target) {
      return
    }
    if (!window.confirm(`「${target.clientName}」·「${target.itemName}」 단가 규칙을 삭제할까요?`)) {
      return
    }
    setPricingRules((current) => current.filter((r) => r.id !== id))
    setPricingRuleFormMessage('단가 규칙을 삭제했습니다.')
  }

  const handleAddMasterItem = () => {
    const itemName = masterItemDraft.itemName.trim()
    if (!itemName) {
      setMasterItemMessage('품목명을 입력해주세요.')
      return
    }
    const unitPrice = Number(masterItemDraft.unitPrice.replaceAll(',', '').trim() || '0')
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setMasterItemMessage('단가는 0 이상의 숫자로 입력해주세요.')
      return
    }
    const specUnit = masterItemDraft.specUnit.trim()
    const existing = masterItems.find(
      (item) => normalizeName(item.itemName) === normalizeName(itemName),
    )
    if (existing) {
      setMasterItems((current) =>
        current.map((item) =>
          item.id === existing.id ? { ...item, itemName, specUnit, unitPrice } : item,
        ),
      )
      setMasterItemMessage(`「${itemName}」 품목 단가를 업데이트했습니다.`)
    } else {
      const next: MasterItem = {
        id: `master-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        itemName,
        specUnit,
        unitPrice,
      }
      setMasterItems((current) => [...current, next])
      setMasterItemMessage(`「${itemName}」 품목을 추가했습니다.`)
    }
    setMasterItemDraft({ itemName: '', specUnit: '', unitPrice: '' })
  }

  const handleStartEditMasterItem = (item: MasterItem) => {
    setEditingMasterItemId(item.id)
    setEditingMasterItemDraft({
      itemName: item.itemName,
      specUnit: item.specUnit,
      unitPrice: String(item.unitPrice),
    })
    setMasterItemMessage('')
  }

  const handleCancelEditMasterItem = () => {
    setEditingMasterItemId(null)
    setEditingMasterItemDraft({ itemName: '', specUnit: '', unitPrice: '' })
  }

  const handleSaveEditMasterItem = () => {
    if (!editingMasterItemId) {
      return
    }
    const itemName = editingMasterItemDraft.itemName.trim()
    if (!itemName) {
      setMasterItemMessage('품목명을 입력해주세요.')
      return
    }
    const unitPrice = Number(editingMasterItemDraft.unitPrice.replaceAll(',', '').trim() || '0')
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      setMasterItemMessage('단가는 0 이상의 숫자로 입력해주세요.')
      return
    }
    const duplicated = masterItems.find(
      (item) =>
        item.id !== editingMasterItemId &&
        normalizeName(item.itemName) === normalizeName(itemName),
    )
    if (duplicated) {
      setMasterItemMessage('같은 이름의 품목이 이미 있습니다.')
      return
    }
    setMasterItems((current) =>
      current.map((item) =>
        item.id === editingMasterItemId
          ? {
              ...item,
              itemName,
              specUnit: editingMasterItemDraft.specUnit.trim(),
              unitPrice,
            }
          : item,
      ),
    )
    setMasterItemMessage(`「${itemName}」 품목을 수정했습니다.`)
    handleCancelEditMasterItem()
  }

  const handleRemoveMasterItem = (id: string) => {
    const target = masterItems.find((item) => item.id === id)
    if (!target) {
      return
    }
    if (!window.confirm(`「${target.itemName}」 품목 마스터를 삭제할까요?`)) {
      return
    }
    setMasterItems((current) => current.filter((item) => item.id !== id))
    if (editingMasterItemId === id) {
      handleCancelEditMasterItem()
    }
    setMasterItemMessage(`「${target.itemName}」 품목을 삭제했습니다.`)
  }

  const resetStatementFormAfterSave = () => {
    setForm((current) => ({
      ...defaultFormState(),
      clientName: current.clientName,
      deliveryDate: current.deliveryDate,
    }))
    setIsCustomClient(false)
    setIsCustomItem(false)
    setIsCustomSpec(false)
    setEditingRecordId(null)
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!form.deliveryDate || !form.clientName.trim() || !form.itemName.trim()) {
      window.alert('납품일, 거래처명, 품목은 꼭 입력해주세요.')
      return
    }

    if (calculatedAmounts.quantity <= 0 || calculatedAmounts.unitPrice <= 0) {
      window.alert('수량과 단가는 0보다 커야 합니다.')
      return
    }

    if (duplicateCandidate && !editingRecordId) {
      const confirmDup = window.confirm(
        `이미 같은 날(${formatDateLabel(duplicateCandidate.deliveryDate)}) ${duplicateCandidate.clientName}에 「${duplicateCandidate.itemName}」 ${duplicateCandidate.quantity}개 건이 있습니다.\n그래도 새로 저장할까요?`,
      )
      if (!confirmDup) {
        return
      }
    }

    const existingSaved = editingRecordId
      ? records.find((row) => row.id === editingRecordId)?.savedAt
      : undefined
    const nextRecord: StatementRecord = {
      id: editingRecordId ?? crypto.randomUUID(),
      deliveryDate: form.deliveryDate,
      issueDate: form.deliveryDate,
      paymentDate: '',
      deliveryCount: form.deliveryCount,
      clientName: form.clientName.trim(),
      itemName: form.itemName.trim(),
      specUnit: form.specUnit.trim(),
      quantity: calculatedAmounts.quantity,
      unitPrice: calculatedAmounts.unitPrice,
      note: form.note,
      supplyAmount: calculatedAmounts.supplyAmount,
      taxAmount: calculatedAmounts.taxAmount,
      totalAmount: calculatedAmounts.totalAmount,
      ...(editingRecordId
        ? existingSaved
          ? { savedAt: existingSaved }
          : {}
        : { savedAt: new Date().toISOString() }),
    }

    if (editingRecordId) {
      setRecords((current) =>
        current
          .map((row) => (row.id === editingRecordId ? nextRecord : row))
          .sort(compareStatementRecordsNewestFirst),
      )
    } else {
      setRecords((current) =>
        [nextRecord, ...current].sort(compareStatementRecordsNewestFirst),
      )
    }

    resetStatementFormAfterSave()

    if (statementSaveToastTimerRef.current) {
      clearTimeout(statementSaveToastTimerRef.current)
    }
    setStatementSaveToastVisible(true)
    statementSaveToastTimerRef.current = setTimeout(() => {
      setStatementSaveToastVisible(false)
      statementSaveToastTimerRef.current = null
    }, 2000)
  }

  const handleCancelStatementEdit = () => {
    resetStatementFormAfterSave()
  }

  const handleStartEditStatementRecord = (record: StatementRecord) => {
    const { form: nextForm, isCustomClient: nextCustomClient, isCustomItem: nextCustomItem, isCustomSpec: nextCustomSpec } =
      buildEditFormStateFromRecord(record, pricingRules, records)
    setForm(nextForm)
    setIsCustomClient(nextCustomClient)
    setIsCustomItem(nextCustomItem)
    setIsCustomSpec(nextCustomSpec)
    setEditingRecordId(record.id)
    setStatementEntryModalOpen(true)
    setActiveView('records')
    const formPanel = document.querySelector('.statements-form-compact')
    window.requestAnimationFrame(() => formPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }

  const handleDelete = useCallback(
    async (id: string) => {
      if (editingRecordId === id) {
        resetStatementFormAfterSave()
      }
      const nextRecords = records.filter((record) => record.id !== id)
      setRecords(nextRecords)
      if (mode !== 'cloud' || !activeCompanyId) {
        return
      }
      // 삭제만 적용한 뒤 곧바로 F5 하면 `load`가 서버(옛 data)에 이김. 디바운스 600ms 기다리지 않고 즉시 upsert.
      const payload: StatementPageDocument = {
        records: nextRecords,
        pricingRules,
        masterItems,
        statementTemplateBase64,
        statementTemplateFileName,
        statementTemplateUpdatedAt,
        statementTemplateSettings,
      }
      const nextSig = statementPageDocumentPayloadSig(payload)
      statementCloudSaveSigRef.current = nextSig
      markStatementSaving()
      const beforeDoc: StatementPageDocument = {
        records,
        pricingRules,
        masterItems,
        statementTemplateBase64,
        statementTemplateFileName,
        statementTemplateUpdatedAt,
        statementTemplateSettings,
      }
      const prevSig = statementPageDocumentPayloadSig(beforeDoc)
      try {
        await saveCompanyDocument(activeCompanyId, COMPANY_DOCUMENT_KEYS.statementPage, payload, user?.id)
        writeStatementPageLocalState(payload)
        markStatementSaved()
      } catch (error) {
        console.error('거래명세 삭제를 클라우드에 반영하지 못했습니다.', error)
        setRecords(records)
        statementCloudSaveSigRef.current = prevSig
        writeStatementPageLocalState(beforeDoc)
        markStatementError()
      }
    },
    [
      activeCompanyId,
      editingRecordId,
      markStatementError,
      markStatementSaved,
      markStatementSaving,
      masterItems,
      mode,
      pricingRules,
      records,
      statementTemplateBase64,
      statementTemplateFileName,
      statementTemplateSettings,
      statementTemplateUpdatedAt,
      user?.id,
    ],
  )

  const handleCopyFromRecentRecord = (record: StatementRecord) => {
    setEditingRecordId(null)
    setIsCustomClient(false)
    setIsCustomItem(false)
    setIsCustomSpec(!QUICK_SPEC_VALUES.has(record.specUnit.trim()) && record.specUnit.trim() !== '')
    setForm({
      deliveryDate: new Date().toISOString().slice(0, 10),
      deliveryCount: record.deliveryCount,
      clientName: record.clientName,
      itemName: record.itemName,
      specUnit: record.specUnit,
      quantity: String(record.quantity),
      unitPrice: String(record.unitPrice),
      note: record.note,
    })
    setStatementEntryModalOpen(true)
    const formPanel = document.querySelector('.statements-form-compact')
    window.requestAnimationFrame(() => formPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }

  const handleFilterByClient = (clientName: string) => {
    setRecordsSearchQuery(clientName)
    setActiveView('records')
  }

  const handleStartInlineEdit = (record: StatementRecord) => {
    setInlineEditRecordId(record.id)
    setInlineEditDraft({
      deliveryDate: record.deliveryDate,
      deliveryCount: record.deliveryCount,
      clientName: record.clientName,
      itemName: record.itemName,
      specUnit: record.specUnit,
      quantity: String(record.quantity),
      unitPrice: String(record.unitPrice),
      note: record.note,
    })
  }

  const handleCancelInlineEdit = () => {
    setInlineEditRecordId(null)
  }

  const handleSaveInlineEdit = () => {
    if (!inlineEditRecordId) {
      return
    }
    const quantity = parseNumber(inlineEditDraft.quantity)
    const unitPrice = parseNumber(inlineEditDraft.unitPrice)
    if (!inlineEditDraft.deliveryDate || !inlineEditDraft.clientName.trim() || !inlineEditDraft.itemName.trim()) {
      window.alert('납품일, 거래처명, 품목은 비워둘 수 없습니다.')
      return
    }
    if (quantity <= 0 || unitPrice <= 0) {
      window.alert('수량과 단가는 0보다 커야 합니다.')
      return
    }
    const supplyAmount = quantity * unitPrice
    const taxAmount = calculateTaxAmount(supplyAmount, inlineEditDraft.note)
    const totalAmount = supplyAmount + taxAmount
    setRecords((current) =>
      current
        .map((record) =>
          record.id === inlineEditRecordId
            ? {
                ...record,
                deliveryDate: inlineEditDraft.deliveryDate,
                issueDate: record.issueDate || inlineEditDraft.deliveryDate,
                deliveryCount: inlineEditDraft.deliveryCount || '1',
                clientName: inlineEditDraft.clientName.trim(),
                itemName: inlineEditDraft.itemName.trim(),
                specUnit: inlineEditDraft.specUnit.trim(),
                quantity,
                unitPrice,
                note: inlineEditDraft.note,
                supplyAmount,
                taxAmount,
                totalAmount,
              }
            : record,
        )
        .sort(compareStatementRecordsNewestFirst),
    )
    setInlineEditRecordId(null)
  }

  const handleCalendarShiftMonth = (delta: number) => {
    setCalendarMonth((current) => {
      const [year, month] = current.split('-').map(Number)
      const date = new Date(year, (month || 1) - 1 + delta, 1)
      const nextYear = date.getFullYear()
      const nextMonth = String(date.getMonth() + 1).padStart(2, '0')
      return `${nextYear}-${nextMonth}`
    })
  }

  const handleStatementTemplateUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    try {
      const buffer = await file.arrayBuffer()
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(buffer)
      const worksheet = workbook.getWorksheet('거래명세서양식')

      if (!worksheet) {
        setStatementTemplateMessage('`거래명세서양식` 시트를 찾지 못했습니다.')
        return
      }

      setStatementTemplateBase64(arrayBufferToBase64(buffer))
      setStatementTemplateFileName(file.name)
      setStatementTemplateUpdatedAt(new Date().toISOString())
      setStatementTemplateMessage(`양식 교체 완료: ${file.name}`)
    } catch (error) {
      setStatementTemplateMessage(
        error instanceof Error ? error.message : '거래명세서 양식 파일을 읽지 못했습니다.',
      )
    } finally {
      event.target.value = ''
    }
  }

  const exportSelectedStatementSheetToTemplate = async () => {
    if (!selectedSheet) {
      setStatementTemplateMessage('채울 거래명세표가 없습니다.')
      return
    }

    if (!statementTemplateBase64) {
      setStatementTemplateMessage('먼저 거래명세서 양식 엑셀을 업로드해주세요.')
      return
    }

    try {
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.load(toArrayBuffer(base64ToUint8Array(statementTemplateBase64)))
      workbook.calcProperties.fullCalcOnLoad = true
      const worksheet = workbook.getWorksheet('거래명세서양식')

      if (!worksheet) {
        setStatementTemplateMessage('업로드한 양식에서 `거래명세서양식` 시트를 찾지 못했습니다.')
        return
      }
      const layoutSnapshot = captureWorksheetLayout(worksheet)

      const safeClientName = selectedSheet.clientName.replace(/[\\/:*?"<>|]/g, '_')
      const pageSize = 15
      const pageCount = Math.max(1, Math.ceil(selectedSheet.records.length / pageSize))

      const sheetsToExport: ExcelJS.Worksheet[] = []

      worksheet.name = pageCount === 1 ? `${safeClientName}` : `${safeClientName}_1`
      fillStatementTemplateWorksheet(worksheet, selectedSheet, statementTemplateSettings, 0, pageSize)
      applyWorksheetLayout(worksheet, layoutSnapshot)
      sheetsToExport.push(worksheet)

      for (let pageIndex = 1; pageIndex < pageCount; pageIndex += 1) {
        const copiedSheet = createWorksheetCopy(workbook, worksheet, `${safeClientName}_${pageIndex + 1}`)
        fillStatementTemplateWorksheet(
          copiedSheet,
          selectedSheet,
          statementTemplateSettings,
          pageIndex * pageSize,
          pageSize,
        )
        applyWorksheetLayout(copiedSheet, layoutSnapshot)
        sheetsToExport.push(copiedSheet)
      }

      const keepIds = new Set(sheetsToExport.map((s) => s.id))
      const removeIds: number[] = []
      workbook.eachSheet((sheet) => {
        if (!keepIds.has(sheet.id)) {
          removeIds.push(sheet.id)
        }
      })
      removeIds.forEach((id) => workbook.removeWorksheet(id))

      const exportFileName = `거래명세서_${safeClientName}_${selectedSheet.deliveryDate}.xlsx`
      const buffer = await workbook.xlsx.writeBuffer()
      const saved = await saveExcelToPreferredFolder(buffer as ArrayBuffer, exportFileName)
      if (saved) {
        setStatementTemplateMessage(
          pageCount > 1
            ? `양식에 거래명세표를 ${pageCount}장으로 나눠 저장했습니다.`
            : '양식에 거래명세표를 채워 저장했습니다.',
        )
      }
    } catch (error) {
      setStatementTemplateMessage(
        error instanceof Error ? error.message : '거래명세서 양식 저장 중 오류가 발생했습니다.',
      )
    }
  }

  const updateStatementTemplateSetting = (
    field: keyof StatementTemplateSettings,
    value: string,
  ) => {
    setStatementTemplateSettings((current) => ({
      ...current,
      [field]: value,
    }))
  }

  const handleClearStatementTemplate = () => {
    setStatementTemplateBase64(null)
    setStatementTemplateFileName('')
    setStatementTemplateUpdatedAt('')
    setStatementTemplateMessage('연결된 거래명세서 양식을 제거했습니다.')
  }

  const exportStatementsToExcel = async () => {
    const totalTaxAmount = statementPreviewRecords.reduce((sum, record) => sum + record.taxAmount, 0)
    const totalColumnCount = 12
    const seqById = statementRecordDeliveryMonthSeqById(records)

    const sheetData: (string | number)[][] = [
      ['[거래명세서]', ...Array.from({ length: totalColumnCount - 1 }, () => '')],
      ['출력일', formatDateLabel(today), '저장 건수', records.length, '', '', '', '', '', '', '', ''],
      ['번호', '납품일', '횟수', '거래처명', '품목', '규격/단위', '수량', '단가', '과세구분', '공급가액', '세액', '계'],
      ...recordsSortedForMainList.map((record) => [
        seqById.get(record.id) ?? '',
        record.deliveryDate.slice(5).replace('-', '/'),
        record.deliveryCount,
        record.clientName,
        record.itemName,
        record.specUnit,
        record.quantity,
        record.unitPrice,
        record.note,
        record.supplyAmount,
        record.taxAmount,
        record.totalAmount,
      ]),
      ['', '', '', '', '', '', '', '', '합계', totalSupplyAmount, totalTaxAmount, grandTotal],
    ]

    try {
      const outBuffer = await buildStyledStatementInputListBuffer(
        sheetData,
        statementInputListDefaultColumnWidths(),
      )
      await saveExcelToPreferredFolder(outBuffer, `거래명세서_입력목록_${today}.xlsx`)
    } catch (error) {
      console.error(error)
    }
  }

  const exportSummaryToExcel = async () => {
    const totalColumnCount = 4 + MONTH_LABELS.length * 3

    const sheetData: (string | number)[][] = [
      [`[${selectedYear} 납품 월별 거래내역]`, ...Array.from({ length: totalColumnCount - 1 }, () => '')],
      Array.from({ length: totalColumnCount }, () => ''),
      ['NO', '거래처명', '합계(부가세포함)', '', ...MONTH_LABELS.flatMap((label) => [label, '', ''])],
      [
        '',
        '',
        '판매대금',
        '점유율',
        ...MONTH_LABELS.flatMap(() => ['금액', '발행일자', '입금일자']),
      ],
      ...summaryRows.map((row, index) => [
        index + 1,
        row.clientName,
        row.totalAmount,
        `${row.share.toFixed(1)}%`,
        ...row.months.flatMap((month) => [
          month.amount || '',
          month.issueDate ? formatDateLabel(month.issueDate) : '',
          month.paymentDate ? formatDateLabel(month.paymentDate) : '',
        ]),
      ]),
      [
        '',
        '합계',
        yearlyTotal,
        '100%',
        ...monthlyTotals.flatMap((amount) => [amount || '', '', '']),
      ],
    ]

    const summaryMerges = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: totalColumnCount - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } },
      { s: { r: 2, c: 1 }, e: { r: 3, c: 1 } },
      { s: { r: 2, c: 2 }, e: { r: 2, c: 3 } },
      ...MONTH_LABELS.map((_, index) => {
        const startColumn = 4 + index * 3
        return {
          s: { r: 2, c: startColumn },
          e: { r: 2, c: startColumn + 2 },
        }
      }),
    ]

    const summaryColumnWidths = [
      6,
      24,
      14,
      10,
      ...MONTH_LABELS.flatMap(() => [12, 12, 12]),
    ]

    try {
      const outBuffer = await buildStyledStatementMonthlySummaryBuffer(
        sheetData,
        summaryMerges,
        summaryColumnWidths,
        `${selectedYear} 월별현황`,
      )
      await saveExcelToPreferredFolder(outBuffer, `월별납품현황_${selectedYear}.xlsx`)
    } catch (error) {
      console.error(error)
    }
  }

  const closeAdminUnlockDialog = useCallback(() => {
    setIsAdminUnlockDialogOpen(false)
    setAdminUnlockPin('')
    setAdminUnlockError('')
  }, [])

  const handleAdminModeButtonClick = () => {
    if (isAdminOpen) {
      setIsAdminOpen(false)
      return
    }
    setAdminUnlockError('')
    setAdminUnlockPin('')
    setIsAdminUnlockDialogOpen(true)
  }

  const handleAdminUnlockConfirm = () => {
    if (adminUnlockPin !== ADMIN_FOUR_DIGIT_PIN) {
      setAdminUnlockError('비밀번호가 올바르지 않습니다.')
      return
    }
    closeAdminUnlockDialog()
    setIsAdminOpen(true)
  }

  useEffect(() => {
    if (!isAdminUnlockDialogOpen) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeAdminUnlockDialog()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isAdminUnlockDialogOpen, closeAdminUnlockDialog])

  useEffect(() => {
    if (activePage !== 'statements' && isAdminUnlockDialogOpen) {
      closeAdminUnlockDialog()
    }
  }, [activePage, isAdminUnlockDialogOpen, closeAdminUnlockDialog])

  return (
    <div
      className={`app-shell${activePage === 'statements' && statementStickyHScrollVisible ? ' app-shell--sticky-hscroll-pad' : ''}`}
    >
      <header className="app-home-shell no-print" aria-label="워크스페이스 홈">
        <aside className="app-home-rail">
          <div className="app-home-rail-brand">
            <span className="app-home-rail-eyebrow">The Symbol Edit</span>
            <strong>{mode === 'cloud' ? activeCompany?.companyName ?? 'Cloud workspace' : 'Local workspace'}</strong>
            <p>{mode === 'cloud' ? '팀이 함께 보는 업무 허브' : '이 브라우저에서 사용하는 개인 업무 허브'}</p>
          </div>

          <nav className="app-home-rail-nav" aria-label="상위 구역">
            {PAGE_CATEGORY_GROUPS.map((group) => {
              const isActiveGroup = group.id === activeCategoryId
              return (
                <button
                  key={group.id}
                  type="button"
                  className={`app-home-rail-link${isActiveGroup ? ' active' : ''}`}
                  onClick={() => {
                    if (group.pages[0]) {
                      setActivePage(group.pages[0].page)
                    }
                  }}
                >
                  <span>{group.label}</span>
                  <strong>{group.pages[0]?.label ?? group.label}</strong>
                </button>
              )
            })}
          </nav>

          <div className="app-home-rail-subnav" aria-label="현재 구역 화면">
            <span className="app-home-rail-subnav-label">현재 구역</span>
            {activeCategoryGroup.pages.map((p) => (
              <button
                key={p.page}
                type="button"
                className={`app-home-rail-subnav-link${activePage === p.page ? ' active' : ''}`}
                onClick={() => setActivePage(p.page)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {mode === 'cloud' && activeCompany ? (
            <div className="app-home-rail-session">
              <div className="page-nav-session-meta">
                <strong>{activeCompany.companyName}</strong>
                <span>{user?.email ?? ''}</span>
              </div>
              <div className="app-home-rail-session-footer">
                <button
                  type="button"
                  className="app-home-rail-signout-button"
                  onClick={() => void signOut()}
                >
                  로그아웃
                </button>
              </div>
            </div>
          ) : null}
        </aside>

        <section className="app-home-stage">
          <div className="app-home-stage-hero">
            <div className="app-home-stage-copy">
              <span className="app-home-stage-eyebrow">{activeCategoryLabel}</span>
              <h2>{activePageMeta.title}</h2>
              <p>{activePageMeta.description}</p>
            </div>
            <div className="app-home-stage-pills" aria-label="현재 작업 정보">
              <span className="workspace-showcase-pill">{mode === 'cloud' ? '클라우드 동기화' : '브라우저 저장'}</span>
              <span className="workspace-showcase-pill">{totalWorkspacePages}개 업무 화면</span>
              <span className="workspace-showcase-pill">{activeCategoryGroup.pages.length}개 현재 구역 화면</span>
            </div>
          </div>

          <div className="app-home-stage-grid">
            <section className="workspace-overview-card" aria-label="워크스페이스 요약">
              <div className="workspace-overview-header">
                <span className="workspace-showcase-eyebrow">Workspace overview</span>
                <h3>{mode === 'cloud' ? `${activeCompany?.companyName ?? '클라우드'} 워크스페이스` : '로컬 워크스페이스'}</h3>
              </div>
              <p className="workspace-overview-copy">
                현재 <strong>{activePageMeta.title}</strong> 화면을 보고 있습니다. 같은 구역의 화면을 빠르게
                넘기거나, 다른 업무 구역으로 바로 이동할 수 있습니다.
              </p>
              <div className="workspace-overview-pills">
                <span className="workspace-showcase-pill">{activeCategoryLabel}</span>
                <span className="workspace-showcase-pill">
                  {mode === 'cloud' ? activeCompany?.companyName ?? '팀 워크스페이스' : '개인 워크스페이스'}
                </span>
                <span className="workspace-showcase-pill">
                  {mode === 'cloud' ? '팀 공유 모드' : '개인 브라우저 모드'}
                </span>
              </div>
            </section>

            <div className="workspace-showcase-stats">
              <article className="workspace-stat-card">
                <span>현재 화면</span>
                <strong>{activePageMeta.title}</strong>
              </article>
              <article className="workspace-stat-card">
                <span>현재 구역</span>
                <strong>{activeCategoryLabel}</strong>
              </article>
              <article className="workspace-stat-card">
                <span>명세 데이터</span>
                <strong>{records.length}건</strong>
              </article>
              <article className="workspace-stat-card">
                <span>하위 메뉴</span>
                <strong>{activeCategoryGroup.pages.length}개</strong>
              </article>
            </div>

            <header
              className="hero-panel statements-hero-compact statements-hero-embedded app-home-workspace-page-hero-span no-print"
              aria-label="현재 화면 안내"
            >
              <div>
                <p className="eyebrow">
                  {mode === 'cloud' ? activeCompany?.companyName ?? '클라우드 워크스페이스' : '로컬 워크스페이스'}
                </p>
                <h1>{WORKSPACE_SHELL_PAGE_HERO[activePage].headline}</h1>
                <p className="hero-copy">
                  {mode === 'cloud'
                    ? WORKSPACE_SHELL_PAGE_HERO[activePage].copyCloud
                    : WORKSPACE_SHELL_PAGE_HERO[activePage].copyLocal}
                </p>
                <div className="hero-meta-row no-print">
                  <span className="page-hero-pill">
                    {mode === 'cloud' ? '회사 공용 문서' : '개인 브라우저 문서'}
                  </span>
                  {activePage === 'statements' ? (
                    mode !== 'cloud' ? (
                      <span className="page-hero-pill">브라우저에 자동 저장</span>
                    ) : statementSaveState === 'saving' ? (
                      <span className="page-hero-pill page-save-state--saving">클라우드에 반영 중…</span>
                    ) : statementSaveState === 'error' ? (
                      <span className="page-hero-pill page-save-state--error">클라우드 반영 실패 — 다시 저장해 주세요</span>
                    ) : (
                      <span className="page-hero-pill">클라우드 자동 반영 · 원두·명세 동일 데이터</span>
                    )
                  ) : null}
                </div>
              </div>
              <div className="hero-metrics">
                {activePage === 'statements' ? (
                  <>
                    <div className="metric-card">
                      <span>저장 건수</span>
                      <strong>{records.length}건</strong>
                    </div>
                    <div className="metric-card">
                      <span>전체 총액</span>
                      <strong>{formatCurrency(grandTotal)}원</strong>
                    </div>
                    <div className="metric-card">
                      <span>{selectedYear} 집계 거래처</span>
                      <strong>{summaryRows.length}곳</strong>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="metric-card">
                      <span>업무 구역</span>
                      <strong>{activeCategoryLabel}</strong>
                    </div>
                    <div className="metric-card">
                      <span>이 화면</span>
                      <strong>{activePageMeta.title}</strong>
                    </div>
                    <div className="metric-card">
                      <span>저장·연동</span>
                      <strong>{mode === 'cloud' ? '클라우드' : '로컬'}</strong>
                    </div>
                  </>
                )}
              </div>
            </header>
          </div>

        </section>
      </header>

      {activePage === 'statements' ? (
        <>
      <div className="statements-page">
      <main className="statements-main">
        <section className="panel statements-records-panel">
          <div className="panel-header controls statements-records-panel-toolbar">
            <div className="statements-records-toolbar-left no-print">
              <div className="segmented statements-records-view-toggle">
                <button
                  type="button"
                  className={activeView === 'cards' ? 'active' : ''}
                  onClick={() => setActiveView('cards')}
                >
                  거래처 카드
                </button>
                <button
                  type="button"
                  className={activeView === 'records' ? 'active' : ''}
                  onClick={() => {
                    setRecordsRangeFilter('month')
                    setActiveView('records')
                  }}
                >
                  입력 목록
                </button>
                <button
                  type="button"
                  className={activeView === 'calendar' ? 'active' : ''}
                  onClick={() => setActiveView('calendar')}
                >
                  캘린더
                </button>
                <button
                  type="button"
                  className={activeView === 'summary' ? 'active' : ''}
                  onClick={() => setActiveView('summary')}
                >
                  월별 납품현황
                </button>
              </div>
              <div className="segmented statements-records-launch">
                <button type="button" onClick={() => setStatementEntryModalOpen(true)}>
                  거래명세서 입력
                </button>
              </div>
            </div>

            <div className="toolbar statements-records-toolbar-actions">
              <select
                className="statements-records-year-select"
                value={selectedYear}
                onChange={(event) => setSelectedYear(event.target.value)}
              >
                {availableYears.map((year) => (
                  <option key={year} value={year}>
                    {year}년
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ghost-button statements-records-excel-btn"
                onClick={exportStatementsToExcel}
              >
                입력목록 엑셀 저장
              </button>
              <button
                type="button"
                className="ghost-button statements-records-excel-btn"
                onClick={exportSummaryToExcel}
              >
                월별현황 엑셀 저장
              </button>
            </div>
          </div>

          {activeView === 'records' ? (
            <div className="statements-records-filterbar">
              <div className="statements-records-search">
                <input
                  type="text"
                  value={recordsSearchQuery}
                  onChange={(event) => setRecordsSearchQuery(event.target.value)}
                  placeholder="거래처·품목·메모 검색"
                  autoComplete="off"
                  inputMode="search"
                  enterKeyHint="search"
                  aria-label="입력 목록 검색"
                />
                {recordsSearchQuery ? (
                  <button
                    type="button"
                    className="statements-records-search-clear"
                    onClick={() => setRecordsSearchQuery('')}
                    aria-label="검색 초기화"
                  >
                    ×
                  </button>
                ) : null}
              </div>
              <div className="statements-records-chips">
                {[
                  { id: 'week', label: '최근 7일' },
                  { id: 'month', label: '이번달' },
                  { id: 'year', label: `${selectedYear}년` },
                  { id: 'all', label: '전체' },
                ].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`filter-chip${recordsRangeFilter === option.id ? ' active' : ''}`}
                    onClick={() =>
                      setRecordsRangeFilter(option.id as typeof recordsRangeFilter)
                    }
                  >
                    {option.label}
                  </button>
                ))}
                <span className="statements-records-chips-divider" aria-hidden="true" />
                {[
                  { id: 'all', label: '전체 과세' },
                  { id: '부가세 별도', label: '별도' },
                  { id: '부가세 없음', label: '없음' },
                ].map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    className={`filter-chip${recordsNoteFilter === option.id ? ' active' : ''}`}
                    onClick={() =>
                      setRecordsNoteFilter(option.id as typeof recordsNoteFilter)
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="statements-records-filter-summary">
                <strong>{visibleRecords.length.toLocaleString('ko-KR')}건</strong>
                <span>·</span>
                <strong>{formatCurrency(visibleTotals.total)}원</strong>
              </div>
            </div>
          ) : null}

          {statementTemplateMessage ? <p className="admin-status">{statementTemplateMessage}</p> : null}
          {statementTemplateFileName ? (
            <p className="local-save-status">
              일반 저장은 `입력목록 엑셀 저장`, 양식 반영 저장은 아래 거래명세표의 `선택 문서 양식 저장`을 사용하세요.
            </p>
          ) : null}

          <div className="statements-table-viewport">
          {activeView === 'records' ? (
            <div className="table-wrapper statements-main-table-hscroll" ref={statementMainTableScrollRef}>
              <table>
                <thead>
                  <tr>
                    <th>
                      <button
                        type="button"
                        className="statement-th-sort"
                        title="같은 납품월에서 입력·저장한 순서(가장 나중에 저장한 건이 가장 큰 번호). 클릭: 번호순 · 다시 클릭: 순서 반대"
                        onClick={() => handleRecordListSortClick('number')}
                      >
                        번호
                        {recordListSort.key === 'number' ? (
                          <span className="statement-th-sort-mark" aria-hidden="true">
                            {recordListSort.dir === 'desc' ? ' ↓' : ' ↑'}
                          </span>
                        ) : null}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="statement-th-sort"
                        title="납품일 기준 · 최신순/과거순 전환"
                        onClick={() => handleRecordListSortClick('deliveryDate')}
                      >
                        납품일
                        {recordListSort.key === 'deliveryDate' ? (
                          <span className="statement-th-sort-mark" aria-hidden="true">
                            {recordListSort.dir === 'desc' ? ' ↓' : ' ↑'}
                          </span>
                        ) : null}
                      </button>
                    </th>
                    <th>횟수</th>
                    <th>
                      <button
                        type="button"
                        className="statement-th-sort"
                        title="거래처명 가나다순 · 클릭으로 오름·내림 전환"
                        onClick={() => handleRecordListSortClick('clientName')}
                      >
                        거래처명
                        {recordListSort.key === 'clientName' ? (
                          <span className="statement-th-sort-mark" aria-hidden="true">
                            {recordListSort.dir === 'asc' ? ' ↑' : ' ↓'}
                          </span>
                        ) : null}
                      </button>
                    </th>
                    <th>
                      <button
                        type="button"
                        className="statement-th-sort"
                        title="품목명 가나다순 · 클릭으로 오름·내림 전환"
                        onClick={() => handleRecordListSortClick('itemName')}
                      >
                        품목
                        {recordListSort.key === 'itemName' ? (
                          <span className="statement-th-sort-mark" aria-hidden="true">
                            {recordListSort.dir === 'asc' ? ' ↑' : ' ↓'}
                          </span>
                        ) : null}
                      </button>
                    </th>
                    <th>규격/단위</th>
                    <th>수량</th>
                    <th>단가</th>
                    <th>과세구분</th>
                    <th>공급가액</th>
                    <th>세액</th>
                    <th>계</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRecords.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="empty-state">
                        {records.length === 0
                          ? '아직 저장된 거래명세서가 없습니다.'
                          : '현재 조건에 맞는 건이 없습니다. 필터나 검색어를 변경해 보세요.'}
                      </td>
                    </tr>
                  ) : (
                    visibleRecords.map((record) => {
                      const isInlineEditing = inlineEditRecordId === record.id
                      if (isInlineEditing) {
                        return (
                          <tr key={record.id} className="statement-row-editing">
                            <td>{statementDeliveryMonthSeqById.get(record.id) ?? '—'}</td>
                            <td>
                              <input
                                type="date"
                                value={inlineEditDraft.deliveryDate}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    deliveryDate: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                value={inlineEditDraft.deliveryCount}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    deliveryCount: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                value={inlineEditDraft.clientName}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    clientName: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                value={inlineEditDraft.itemName}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    itemName: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                value={inlineEditDraft.specUnit}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    specUnit: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={inlineEditDraft.quantity}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    quantity: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={inlineEditDraft.unitPrice}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    unitPrice: event.target.value,
                                  }))
                                }
                              />
                            </td>
                            <td>
                              <select
                                value={inlineEditDraft.note}
                                onChange={(event) =>
                                  setInlineEditDraft((current) => ({
                                    ...current,
                                    note: event.target.value,
                                  }))
                                }
                              >
                                {NOTE_OPTIONS.map((option) => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td colSpan={3} className="statement-inline-preview">
                              {(() => {
                                const q = parseNumber(inlineEditDraft.quantity)
                                const p = parseNumber(inlineEditDraft.unitPrice)
                                const supply = q * p
                                const tax = calculateTaxAmount(supply, inlineEditDraft.note)
                                return `공급 ${formatCurrency(supply)} · 세액 ${formatCurrency(tax)} · 계 ${formatCurrency(supply + tax)}`
                              })()}
                            </td>
                            <td className="statement-record-actions">
                              <button
                                type="button"
                                className="table-action primary"
                                onClick={handleSaveInlineEdit}
                              >
                                저장
                              </button>
                              <button
                                type="button"
                                className="table-action"
                                onClick={handleCancelInlineEdit}
                              >
                                취소
                              </button>
                            </td>
                          </tr>
                        )
                      }
                      return (
                        <tr
                          key={record.id}
                          className={`statement-row${editingRecordId === record.id ? ' statement-row-editing' : ''}`}
                          onDoubleClick={() => handleStartInlineEdit(record)}
                          title="더블클릭하면 바로 수정합니다"
                        >
                          <td>{statementDeliveryMonthSeqById.get(record.id) ?? '—'}</td>
                          <td>{formatDateLabel(record.deliveryDate)}</td>
                          <td>{record.deliveryCount}</td>
                          <td>{record.clientName}</td>
                          <td>{record.itemName}</td>
                          <td>{record.specUnit || '-'}</td>
                          <td>{record.quantity}</td>
                          <td>{formatCurrency(record.unitPrice)}</td>
                          <td>{record.note}</td>
                          <td>{formatCurrency(record.supplyAmount)}</td>
                          <td>{formatCurrency(record.taxAmount)}</td>
                          <td>{formatCurrency(record.totalAmount)}</td>
                          <td className="statement-record-actions">
                            <button
                              type="button"
                              className="table-action statement-record-action-mini"
                              onClick={() => handleStartInlineEdit(record)}
                              title="현재 행에서 바로 수정"
                            >
                              빠른수정
                            </button>
                            <button
                              type="button"
                              className="table-action statement-record-action-mini"
                              onClick={() => handleStartEditStatementRecord(record)}
                              title="상단 입력 폼에서 수정"
                            >
                              폼수정
                            </button>
                            <button
                              type="button"
                              className="table-action statement-record-action-mini"
                              onClick={() => handleDelete(record.id)}
                            >
                              삭제
                            </button>
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>
          ) : activeView === 'cards' ? (
            <div className="statements-cards-viewport">
              {clientCardStats.length === 0 ? (
                <p className="empty-state">아직 저장된 거래처가 없습니다.</p>
              ) : (
                <div className="statements-cards-grid">
                  {clientCardStats.map((card) => (
                    <button
                      key={card.clientName}
                      type="button"
                      className="statements-client-card"
                      onClick={() => handleFilterByClient(card.clientName)}
                      title="입력 목록에서 이 거래처만 필터링"
                    >
                      <div className="statements-client-card-head">
                        <strong>{card.clientName}</strong>
                        <span>{card.count}건</span>
                      </div>
                      <div className="statements-client-card-amount">
                        {formatCurrency(card.totalAmount)}원
                      </div>
                      <dl className="statements-client-card-meta">
                        <div>
                          <dt>이번달</dt>
                          <dd>{formatCurrency(card.monthAmount)}원</dd>
                        </div>
                        <div>
                          <dt>마지막 납품</dt>
                          <dd>
                            {card.lastDeliveryDate ? formatDateLabel(card.lastDeliveryDate) : '—'}
                          </dd>
                        </div>
                      </dl>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : activeView === 'calendar' ? (
            <div className="statements-calendar-viewport">
              <div className="statements-calendar-toolbar">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => handleCalendarShiftMonth(-1)}
                >
                  ◀
                </button>
                <strong>{calendarMonth.replace('-', '.')}</strong>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => handleCalendarShiftMonth(1)}
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() =>
                    setCalendarMonth(new Date().toISOString().slice(0, 7))
                  }
                >
                  이번달
                </button>
              </div>
              {(() => {
                const [cy, cm] = calendarMonth.split('-').map(Number)
                const firstDay = new Date(cy, (cm || 1) - 1, 1)
                const daysInMonth = new Date(cy, cm || 1, 0).getDate()
                const leadingBlanks = firstDay.getDay()
                const cells: Array<{ key: string; date?: string; day?: number }> = []
                for (let i = 0; i < leadingBlanks; i += 1) {
                  cells.push({ key: `blank-${i}` })
                }
                for (let d = 1; d <= daysInMonth; d += 1) {
                  const dateIso = `${cy}-${String(cm).padStart(2, '0')}-${String(d).padStart(2, '0')}`
                  cells.push({ key: dateIso, date: dateIso, day: d })
                }
                return (
                  <div className="statements-calendar-grid">
                    {['일', '월', '화', '수', '목', '금', '토'].map((dow) => (
                      <div key={dow} className="statements-calendar-dow">
                        {dow}
                      </div>
                    ))}
                    {cells.map((cell) => {
                      if (!cell.date) {
                        return <div key={cell.key} className="statements-calendar-cell is-blank" />
                      }
                      const entry = calendarEntries.get(cell.date)
                      return (
                        <div
                          key={cell.key}
                          className={`statements-calendar-cell${entry ? ' has-records' : ''}`}
                        >
                          <div className="statements-calendar-cell-head">
                            <span>{cell.day}</span>
                            {entry ? <em>{entry.count}건</em> : null}
                          </div>
                          {entry ? (
                            <div className="statements-calendar-cell-body">
                              <strong>{formatCurrency(entry.totalAmount)}원</strong>
                              <ul>
                                {entry.records.slice(0, 3).map((record) => (
                                  <li
                                    key={record.id}
                                    title={`${record.clientName} · ${record.itemName} · ${record.quantity}`}
                                  >
                                    {record.clientName} · {record.itemName} {record.quantity}
                                  </li>
                                ))}
                                {entry.records.length > 3 ? (
                                  <li className="statements-calendar-more">
                                    +{entry.records.length - 3}건
                                    <div className="statements-calendar-more-tooltip" role="tooltip">
                                      {entry.records.slice(3).map((record) => (
                                        <div key={`more-${record.id}`}>
                                          {record.clientName} · {record.itemName} {record.quantity}
                                        </div>
                                      ))}
                                    </div>
                                  </li>
                                ) : null}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                )
              })()}
            </div>
          ) : (
            <div className="table-wrapper statements-main-table-hscroll" ref={statementMainTableScrollRef}>
              <table className="summary-table">
                <thead>
                  <tr>
                    <th rowSpan={2}>NO</th>
                    <th rowSpan={2}>거래처명</th>
                    <th rowSpan={2}>합계(부가세포함)</th>
                    <th rowSpan={2}>점유율</th>
                    {MONTH_LABELS.map((label) => (
                      <th key={label} colSpan={3}>
                        {label}
                      </th>
                    ))}
                  </tr>
                  <tr>
                    {MONTH_LABELS.flatMap((label) => [
                      <th key={`${label}-amount`}>금액</th>,
                      <th key={`${label}-issue`}>발행일자</th>,
                      <th key={`${label}-payment`}>입금일자</th>,
                    ])}
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={40} className="empty-state">
                        {selectedYear}년에 해당하는 데이터가 없습니다.
                      </td>
                    </tr>
                  ) : (
                    summaryRows.map((row, index) => (
                      <tr key={row.clientName}>
                        <td>{index + 1}</td>
                        <td>{row.clientName}</td>
                        <td>{formatCurrency(row.totalAmount)}</td>
                        <td>{row.share.toFixed(1)}%</td>
                        {row.months.flatMap((month, monthIndex) => [
                          <td key={`${row.clientName}-${monthIndex}-amount`}>
                            {month.amount ? formatCurrency(month.amount) : ''}
                          </td>,
                          <td key={`${row.clientName}-${monthIndex}-issue`}>
                            {month.issueDate ? formatDateLabel(month.issueDate) : ''}
                          </td>,
                          <td key={`${row.clientName}-${monthIndex}-payment`}>
                            {month.paymentDate ? formatDateLabel(month.paymentDate) : ''}
                          </td>,
                        ])}
                      </tr>
                    ))
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>합계</td>
                    <td>{formatCurrency(filteredRecords.reduce((sum, row) => sum + row.totalAmount, 0))}</td>
                    <td>100%</td>
                    <td colSpan={36}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          </div>
        </section>
      </main>

      <section className="panel preview-panel statements-preview-panel">
        <div className="panel-header statement-sheet-panel-header">
          <h2>거래명세표</h2>
        </div>

        <div className="preview-stack">
          <article className="excel-preview-card statement-print-root">
            <div className="statement-sheet-toolbar-row no-print">
              <button
                type="button"
                className="ghost-button statement-preview-toggle"
                onClick={() => setIsStatementPreviewOpen((open) => !open)}
                aria-expanded={isStatementPreviewOpen}
              >
                [거래명세표 미리보기] {isStatementPreviewOpen ? '▾' : '▸'}
              </button>
              {statementSheetGroups.length > 0 ? (
                <div className="sheet-toolbar sheet-toolbar--compact sheet-toolbar-inline">
                  <select
                    className="sheet-select"
                    value={selectedSheet?.key ?? ''}
                    onChange={(event) => setSelectedSheetKey(event.target.value)}
                  >
                    {statementSheetGroups.map((group) => (
                      <option key={group.key} value={group.key}>
                        {formatDateLabel(group.deliveryDate)} / {group.clientName} / {group.deliveryCount}회
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setIsStatementTemplateEditMode((current) => !current)}
                  >
                    {isStatementTemplateEditMode ? '완료' : '수정'}
                  </button>
                  {isStatementTemplateEditMode ? (
                    <>
                      <label className="upload-button secondary">
                        {statementTemplateFileName ? '양식 다시 업로드' : '양식 업로드'}
                        <input type="file" accept=".xlsx" onChange={handleStatementTemplateUpload} />
                      </label>
                      {statementTemplateFileName ? (
                        <button
                          type="button"
                          className="ghost-button"
                          onClick={handleClearStatementTemplate}
                        >
                          양식 제거
                        </button>
                      ) : null}
                    </>
                  ) : null}
                  <button
                    type="button"
                    className="primary-button sheet-toolbar-save-button"
                    onClick={exportSelectedStatementSheetToTemplate}
                  >
                    저장
                  </button>
                </div>
              ) : (
                <span className="statement-sheet-empty-hint">미리볼 문서 없음</span>
              )}
              <div className="statement-excel-folder-controls">
                <button
                  type="button"
                  className="ghost-button statement-excel-folder-pick"
                  onClick={() => void handlePickExcelExportFolder()}
                  title={
                    excelExportDirHandle
                      ? '엑셀 저장 시 이 폴더를 연 채로 저장 창이 뜹니다. 다른 폴더로 바꾸려면 클릭 (Chrome·Edge 등)'
                      : '엑셀 저장 시 사용할 폴더입니다. 지정 후 저장하면 해당 폴더가 열린 저장 창이 뜹니다. 입력목록·월별현황에도 같이 적용됩니다.'
                  }
                >
                  {excelExportDirHandle ? excelExportDirHandle.name : '저장 폴더'}
                </button>
                {excelExportDirHandle ? (
                  <button
                    type="button"
                    className="ghost-button statement-excel-folder-clear"
                    onClick={() => void handleClearExcelExportFolder()}
                    aria-label="저장 폴더 지정 해제"
                  >
                    해제
                  </button>
                ) : null}
              </div>
            </div>
            {excelExportFolderMessage ? (
              <p className="statement-excel-folder-status no-print">{excelExportFolderMessage}</p>
            ) : null}

            <div
              className={
                isStatementPreviewOpen
                  ? 'statement-preview-collapse is-open'
                  : 'statement-preview-collapse'
              }
            >
              {isStatementTemplateEditMode && statementTemplateFileName ? (
                <p className="local-save-status no-print statement-linked-template-line">
                  현재 연결 양식: {statementTemplateFileName}
                  {statementTemplateUpdatedAt
                    ? ` (최근 교체: ${new Date(statementTemplateUpdatedAt).toLocaleTimeString('ko-KR')})`
                    : ''}
                </p>
              ) : null}

              {isStatementTemplateEditMode ? (
                <div className="statement-template-settings no-print">
                <div className="statement-template-settings-header">
                  <strong>거래명세표 양식 정보</strong>
                  <span>자주 바뀔 수 있는 사업자 정보만 수정할 수 있습니다.</span>
                </div>
                <div className="statement-template-settings-grid">
                  <label>
                    사업자번호
                    <input
                      type="text"
                      value={statementTemplateSettings.businessNumber}
                      onChange={(event) =>
                        updateStatementTemplateSetting('businessNumber', event.target.value)
                      }
                    />
                  </label>
                  <label>
                    상호명
                    <input
                      type="text"
                      value={statementTemplateSettings.companyName}
                      onChange={(event) =>
                        updateStatementTemplateSetting('companyName', event.target.value)
                      }
                    />
                  </label>
                  <label>
                    성명
                    <input
                      type="text"
                      value={statementTemplateSettings.ownerName}
                      onChange={(event) => updateStatementTemplateSetting('ownerName', event.target.value)}
                    />
                  </label>
                  <label>
                    전화번호
                    <input
                      type="text"
                      value={statementTemplateSettings.phone}
                      onChange={(event) => updateStatementTemplateSetting('phone', event.target.value)}
                    />
                  </label>
                  <label className="span-2">
                    주소
                    <input
                      type="text"
                      value={statementTemplateSettings.address}
                      onChange={(event) => updateStatementTemplateSetting('address', event.target.value)}
                    />
                  </label>
                  <label>
                    업태
                    <input
                      type="text"
                      value={statementTemplateSettings.businessType}
                      onChange={(event) =>
                        updateStatementTemplateSetting('businessType', event.target.value)
                      }
                    />
                  </label>
                  <label>
                    종목
                    <input
                      type="text"
                      value={statementTemplateSettings.businessItem}
                      onChange={(event) =>
                        updateStatementTemplateSetting('businessItem', event.target.value)
                      }
                    />
                  </label>
                  <label className="span-2">
                    입금계좌
                    <input
                      type="text"
                      value={statementTemplateSettings.account}
                      onChange={(event) => updateStatementTemplateSetting('account', event.target.value)}
                    />
                  </label>
                </div>
                </div>
              ) : null}

              {selectedSheet ? (
                <div className="statement-sheet-pair statement-sheet-pair--single">
                  <div className="statement-sheet">
                  <div className="statement-copy-label">{STATEMENT_PREVIEW_LABEL}</div>

                  <div className="statement-sheet-header">
                    <div className="statement-doc-date-line">
                      납품일 {formatDateLabel(selectedSheet.deliveryDate)}
                    </div>
                    <h3>거래명세표</h3>
                    <div className="statement-header-spacer"></div>
                  </div>

                  <table className="statement-meta-table">
                    <colgroup>
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '4%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '17.33%' }} />
                      <col style={{ width: '17.33%' }} />
                      <col style={{ width: '17.34%' }} />
                    </colgroup>
                    <tbody>
                      <tr>
                        <th className="sheet-left-label">작성일자</th>
                        <td className="sheet-left-value">{formatLongDateLabel(selectedSheet.issueDate)}</td>
                        <th className="provider-mark" rowSpan={4}>
                          공
                          <br />
                          급
                        </th>
                        <th>사업자번호</th>
                        <td colSpan={3}>{statementTemplateSettings.businessNumber}</td>
                      </tr>
                      <tr>
                        <th className="sheet-left-label" rowSpan={3}>
                          공급받는자
                        </th>
                        <td className="sheet-left-value" rowSpan={3}>
                          {selectedSheet.clientName}
                        </td>
                        <th>상호명</th>
                        <td>{statementTemplateSettings.companyName}</td>
                        <th>성명</th>
                        <td>{statementTemplateSettings.ownerName}</td>
                      </tr>
                      <tr>
                        <th>주소</th>
                        <td colSpan={3}>{statementTemplateSettings.address}</td>
                      </tr>
                      <tr>
                        <th>업태</th>
                        <td>{statementTemplateSettings.businessType}</td>
                        <th>종목</th>
                        <td>{statementTemplateSettings.businessItem}</td>
                      </tr>
                    </tbody>
                  </table>

                  <table className="statement-amount-table">
                    <colgroup>
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '4%' }} />
                      <col style={{ width: '14%' }} />
                      <col style={{ width: '17.33%' }} />
                      <col style={{ width: '17.33%' }} />
                      <col style={{ width: '17.34%' }} />
                    </colgroup>
                    <tbody>
                      <tr>
                        <th className="sheet-left-label">아래와 같이 계산합니다.</th>
                        <td className="sheet-left-value">{formatStatementAmountText(selectedSheet.totalAmount)}</td>
                        <th className="provider-mark">자</th>
                        <th>전화번호</th>
                        <td colSpan={3}>{statementTemplateSettings.phone}</td>
                      </tr>
                    </tbody>
                  </table>

                  <div className="table-wrapper statement-sheet-table-wrapper">
                    <table className="statement-sheet-table">
                      <thead>
                        <tr>
                          <th>NO</th>
                          <th>품목</th>
                          <th>규격/단위</th>
                          <th>수량</th>
                          <th>단가</th>
                          <th>공급가액</th>
                          <th>세액</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: 15 }).map((_, index) => {
                          const record = selectedSheet.records[index]
                          return (
                            <tr key={`statement-sheet-row-${index}`}>
                              <td>{record ? index + 1 : ''}</td>
                              <td>{record?.itemName ?? ''}</td>
                              <td>{record?.specUnit ?? ''}</td>
                              <td>{record ? record.quantity : ''}</td>
                              <td>{record ? formatCurrency(record.unitPrice) : ''}</td>
                              <td>{record ? formatCurrency(record.supplyAmount) : ''}</td>
                              <td>{record ? formatCurrency(record.taxAmount) : ''}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={5}>계</td>
                          <td>{formatCurrency(selectedSheet.supplyAmount)}</td>
                          <td>{formatCurrency(selectedSheet.taxAmount)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  <table className="statement-sign-table">
                    <tbody>
                      <tr>
                        <th>입금계좌</th>
                        <td>{statementTemplateSettings.account}</td>
                        <th>인수자</th>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                </div>
              ) : (
                <div className="statement-sheet-empty">거래명세표로 묶을 데이터가 없습니다.</div>
              )}
            </div>
          </article>
        </div>
      </section>
      </div>

      {statementEntryModalOpen ? (
        <div
          className="statement-entry-modal-backdrop"
          role="presentation"
          onClick={() => setStatementEntryModalOpen(false)}
        >
          <div
            className="statement-entry-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="statement-entry-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
                    <section className="panel form-panel statements-form-compact">
          <div className="panel-header">
            <div>
              <h2 id="statement-entry-dialog-title">거래명세서 입력</h2>
              <p>입력하면 아래 목록과 월별 납품현황에 바로 반영됩니다.</p>
            </div>
            <div className="form-panel-actions">
              <button
                type="button"
                className="ghost-button statement-header-close"
                onClick={() => setStatementEntryModalOpen(false)}
                aria-label="입력창 닫기"
              >
                닫기
              </button>
              <button
                type="button"
                className="ghost-button statement-header-admin"
                onClick={handleAdminModeButtonClick}
              >
                {isAdminOpen ? '관리자 모드 닫기' : '관리자 모드'}
              </button>
              <button
                type="submit"
                form="statement-entry-form"
                className="primary-button statement-header-save"
              >
                저장
              </button>
            </div>
          </div>

          {isAdminOpen ? (
            <div className="admin-panel admin-panel--compact">
              <div className="admin-panel-header">
                <div>
                  <strong>단가 (거래처별)</strong>
                  <p className="admin-panel-line">
                    거래처 선택·열기 → 표 편집. 입력 화면에서는 해당 거래처 품목만 제안.
                  </p>
                </div>
                <span className="admin-panel-pill">{pricingRules.length}규칙</span>
              </div>

              <p className="admin-hint admin-hint--tight">품목은 제안·직접입력.</p>

              <div className="pricing-admin-client-bar">
                <label className="pricing-admin-client-bar-field">
                  <span>저장된 거래처</span>
                  <select
                    value={
                      pricingAdminClientKey &&
                      pricingRulesGrouped.some((g) => g.clientKey === pricingAdminClientKey)
                        ? pricingAdminClientKey
                        : ''
                    }
                    onChange={handlePricingAdminDropdownChange}
                  >
                    <option value="">거래처 선택…</option>
                    {pricingRulesGrouped.map(({ clientKey, displayName, rules }) => (
                      <option key={clientKey} value={clientKey}>
                        {displayName} ({rules.length}건)
                      </option>
                    ))}
                  </select>
                </label>
                <span className="pricing-admin-client-bar-or">또는</span>
                <input
                  type="text"
                  list="statement-pricing-client-datalist"
                  value={pricingAdminClientInput}
                  onChange={(event) => setPricingAdminClientInput(event.target.value)}
                  placeholder="거래처명 입력 후 열기"
                  aria-label="거래처명으로 열기"
                />
                <button type="button" className="primary-button" onClick={handleOpenPricingAdminClientFromInput}>
                  이 거래처 열기
                </button>
              </div>
              <datalist id="statement-pricing-client-datalist">
                {clientOptions.map((client) => (
                  <option key={client} value={client} />
                ))}
              </datalist>
              <datalist id="statement-pricing-item-datalist">
                {allItemOptions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              {pricingRuleFormMessage ? <p className="admin-status admin-status--tight">{pricingRuleFormMessage}</p> : null}

              {!pricingAdminClientKey ? (
                <p className="admin-status admin-status--muted">거래처 선택 또는 이름 입력 → 열기</p>
              ) : (
                <div className="pricing-client-sheet">
                  <h3 className="pricing-client-sheet-title">{pricingAdminClientSaveLabel}</h3>
                  <div className="table-wrapper admin-table-wrapper">
                    <table className="admin-table">
                      <thead>
                        <tr>
                          <th>품목</th>
                          <th>규격/단위</th>
                          <th>단가</th>
                          <th style={{ width: 100 }}>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pricingAdminRulesForView.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="empty-state">
                              이 거래처에 저장된 단가가 없습니다. 아래에서 품목을 추가하세요.
                            </td>
                          </tr>
                        ) : (
                          pricingAdminRulesForView.map((rule) => (
                            <tr key={rule.id}>
                              <td>{rule.itemName}</td>
                              <td>{rule.specUnit || '-'}</td>
                              <td>{formatCurrency(rule.unitPrice)}</td>
                              <td className="admin-table-pricing-actions">
                                <button
                                  type="button"
                                  className="ghost-button small danger"
                                  onClick={() => handleRemovePricingRule(rule.id)}
                                >
                                  삭제
                                </button>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="pricing-client-sheet-add-row">
                    <input
                      type="text"
                      list="statement-pricing-item-datalist"
                      value={pricingAdminLineDraft.itemName}
                      onChange={(event) =>
                        setPricingAdminLineDraft((current) => ({ ...current, itemName: event.target.value }))
                      }
                      placeholder="품목 (목록 또는 직접)"
                      aria-label="품목 추가"
                    />
                    <input
                      type="text"
                      value={pricingAdminLineDraft.specUnit}
                      onChange={(event) =>
                        setPricingAdminLineDraft((current) => ({ ...current, specUnit: event.target.value }))
                      }
                      placeholder="규격/단위"
                      aria-label="규격 단위"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      value={pricingAdminLineDraft.unitPrice}
                      onChange={(event) =>
                        setPricingAdminLineDraft((current) => ({ ...current, unitPrice: event.target.value }))
                      }
                      placeholder="단가 (원)"
                      aria-label="단가"
                    />
                    <button type="button" className="primary-button" onClick={handleSavePricingAdminLine}>
                      품목 줄 저장
                    </button>
                  </div>
                </div>
              )}

              <div className="admin-panel-header admin-panel-section">
                <div>
                  <strong>품목 마스터 (공통 기본)</strong>
                  <p className="admin-panel-line">거래처 단가 없을 때만 적용.</p>
                </div>
                <span className="admin-panel-pill">{masterItems.length}품목</span>
              </div>

              <div className="master-item-form">
                <input
                  type="text"
                  value={masterItemDraft.itemName}
                  onChange={(event) =>
                    setMasterItemDraft((current) => ({ ...current, itemName: event.target.value }))
                  }
                  placeholder="품목명 (예: 더치 오리지널 500ml)"
                />
                <input
                  type="text"
                  value={masterItemDraft.specUnit}
                  onChange={(event) =>
                    setMasterItemDraft((current) => ({ ...current, specUnit: event.target.value }))
                  }
                  placeholder="규격/단위 (예: 500/ML)"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  value={masterItemDraft.unitPrice}
                  onChange={(event) =>
                    setMasterItemDraft((current) => ({ ...current, unitPrice: event.target.value }))
                  }
                  placeholder="단가 (원)"
                />
                <button type="button" className="primary-button" onClick={handleAddMasterItem}>
                  추가/수정
                </button>
              </div>

              {masterItemMessage ? <p className="admin-status">{masterItemMessage}</p> : null}

              <div className="table-wrapper admin-table-wrapper">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>품목</th>
                      <th>규격/단위</th>
                      <th>단가</th>
                      <th style={{ width: 160 }}>관리</th>
                    </tr>
                  </thead>
                  <tbody>
                    {masterItems.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="empty-state">
                          아직 등록된 품목 마스터가 없습니다.
                        </td>
                      </tr>
                    ) : (
                      masterItems.map((item) => {
                        const isEditing = editingMasterItemId === item.id
                        return (
                          <tr key={item.id}>
                            <td>
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={editingMasterItemDraft.itemName}
                                  onChange={(event) =>
                                    setEditingMasterItemDraft((current) => ({
                                      ...current,
                                      itemName: event.target.value,
                                    }))
                                  }
                                />
                              ) : (
                                item.itemName
                              )}
                            </td>
                            <td>
                              {isEditing ? (
                                <input
                                  type="text"
                                  value={editingMasterItemDraft.specUnit}
                                  onChange={(event) =>
                                    setEditingMasterItemDraft((current) => ({
                                      ...current,
                                      specUnit: event.target.value,
                                    }))
                                  }
                                  placeholder="예: 500/ML"
                                />
                              ) : (
                                item.specUnit || '-'
                              )}
                            </td>
                            <td>
                              {isEditing ? (
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={editingMasterItemDraft.unitPrice}
                                  onChange={(event) =>
                                    setEditingMasterItemDraft((current) => ({
                                      ...current,
                                      unitPrice: event.target.value,
                                    }))
                                  }
                                />
                              ) : (
                                `${formatCurrency(item.unitPrice)}원`
                              )}
                            </td>
                            <td className="master-item-actions">
                              {isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    className="ghost-button small"
                                    onClick={handleSaveEditMasterItem}
                                  >
                                    저장
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-button small"
                                    onClick={handleCancelEditMasterItem}
                                  >
                                    취소
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="ghost-button small"
                                    onClick={() => handleStartEditMasterItem(item)}
                                  >
                                    수정
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-button small danger"
                                    onClick={() => handleRemoveMasterItem(item.id)}
                                  >
                                    삭제
                                  </button>
                                </>
                              )}
                            </td>
                          </tr>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          <form id="statement-entry-form" className="statement-form" onSubmit={handleSubmit}>
            {editingRecordId ? (
              <p className="statement-edit-hint">
                입력 목록에서 선택한 건을 수정 중입니다. 반영하려면 위의 「저장」, 취소하려면 「수정 취소」를
                눌러주세요.
              </p>
            ) : null}

            {clientMonthSnapshot && clientMonthSnapshot.count > 0 ? (
              <div className="statement-client-snapshot" role="status">
                <span className="statement-client-snapshot-title">
                  {form.clientName} · {clientMonthSnapshot.currentMonth.replace('-', '.')} 월 요약
                </span>
                <span className="statement-client-snapshot-pill">{clientMonthSnapshot.count}건</span>
                <span className="statement-client-snapshot-pill">
                  {formatCurrency(clientMonthSnapshot.totalAmount)}원
                </span>
                <span className="statement-client-snapshot-pill">누적 {clientMonthSnapshot.quantity}개</span>
                {clientMonthSnapshot.lastDeliveryDate ? (
                  <span className="statement-client-snapshot-pill">
                    마지막 납품 {formatDateLabel(clientMonthSnapshot.lastDeliveryDate)}
                  </span>
                ) : null}
              </div>
            ) : null}

            {recentRecordsForClient.length > 0 && !editingRecordId ? (
              <div className="statement-recent-panel">
                <div className="statement-recent-panel-head">
                  <strong>최근 납품</strong>
                  <span>{form.clientName} · 클릭하면 오늘 날짜로 자동 입력</span>
                </div>
                <div className="statement-recent-panel-list">
                  {recentRecordsForClient.map((record) => (
                    <button
                      key={record.id}
                      type="button"
                      className="statement-recent-panel-item"
                      onClick={() => handleCopyFromRecentRecord(record)}
                      title="이 납품을 오늘 날짜로 복제합니다"
                    >
                      <span className="statement-recent-panel-item-date">
                        {formatDateLabel(record.deliveryDate)}
                      </span>
                      <span className="statement-recent-panel-item-name">{record.itemName}</span>
                      <span className="statement-recent-panel-item-meta">
                        {record.specUnit || '-'} · {record.quantity}개 · {formatCurrency(record.unitPrice)}원
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {duplicateCandidate && !editingRecordId ? (
              <p className="statement-duplicate-warning" role="alert">
                같은 날 {duplicateCandidate.clientName}에 「{duplicateCandidate.itemName}」 {duplicateCandidate.quantity}개 건이 이미 있습니다.
                그대로 저장하면 중복으로 들어갑니다.
              </p>
            ) : null}
            <div className="statement-form-primary-row">
              <label className="statement-form-field statement-form-field--date">
                납품일
                <input
                  type="date"
                  value={form.deliveryDate}
                  onChange={(event) => handleFieldChange('deliveryDate', event.target.value)}
                />
              </label>
              <label className="statement-form-field statement-form-field--count">
                횟수
                <input
                  type="text"
                  value={form.deliveryCount}
                  onChange={(event) => handleFieldChange('deliveryCount', event.target.value)}
                  placeholder="예: 1"
                />
              </label>
              <label className="statement-form-field statement-form-field--client">
                거래처명
                <select
                  value={isCustomClient ? CUSTOM_CLIENT_OPTION : form.clientName}
                  onChange={(event) => handleClientSelectionChange(event.target.value)}
                >
                  <option value="">거래처를 선택하세요</option>
                  {clientOptions.map((client) => (
                    <option key={client} value={client}>
                      {client}
                    </option>
                  ))}
                  <option value={CUSTOM_CLIENT_OPTION}>직접 입력</option>
                </select>
                {isCustomClient ? (
                  <input
                    type="text"
                    value={form.clientName}
                    onChange={(event) => handleFieldChange('clientName', event.target.value)}
                    placeholder="예: 길 인천점"
                  />
                ) : null}
              </label>
              <label className="statement-form-field statement-form-field--item">
                품목
                <div className="statement-item-field-row">
                  <select
                    value={isCustomItem ? CUSTOM_ITEM_OPTION : form.itemName}
                    onChange={(event) => handleItemSelectionChange(event.target.value)}
                  >
                    <option value="">품목을 선택하세요</option>
                    {itemOptions.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                    <option value={CUSTOM_ITEM_OPTION}>직접 입력</option>
                  </select>
                  <button
                    type="button"
                    className="ghost-button small"
                    onClick={handleOpenBulkItemPicker}
                    disabled={!form.clientName.trim()}
                    title={
                      form.clientName.trim()
                        ? '선택한 품목을 여러 개 한 번에 입력 목록에 추가'
                        : '거래처를 먼저 선택하세요'
                    }
                  >
                    여러 품목
                  </button>
                </div>
                {isCustomItem ? (
                  <input
                    type="text"
                    value={form.itemName}
                    onChange={(event) => handleFieldChange('itemName', event.target.value)}
                    placeholder="목록에 없는 품목 직접 입력"
                  />
                ) : null}
                {matchingPricingRule ? (
                  <span className="field-help">
                    거래처 전용 단가 {formatCurrency(matchingPricingRule.unitPrice)}원 자동 적용
                  </span>
                ) : matchingMasterItem ? (
                  <span className="field-help">
                    품목 기본 단가 {formatCurrency(matchingMasterItem.unitPrice)}원 자동 적용
                  </span>
                ) : hasPricingForSelectedClient && form.itemName ? (
                  <span className="field-help warning">
                    선택한 거래처 단가표에 없는 품목입니다. 거래처용 품목을 다시 선택해주세요.
                  </span>
                ) : null}
              </label>
            </div>
            <div className="statement-form-secondary-row">
              <label className="statement-form-field statement-form-field--spec">
                규격/단위
                <div className="quick-option-row">
                  {activeQuickSpecOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={form.specUnit === option.value ? 'quick-option active' : 'quick-option'}
                      onClick={() => handleSpecSelectionChange(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {showSpecOtherInput ? (
                  <input
                    type="text"
                    value={form.specUnit}
                    onChange={(event) => handleSpecOtherInputChange(event.target.value)}
                    placeholder={isDutchItemName(form.itemName) ? '예: 2/L' : '예: 500/G'}
                  />
                ) : null}
              </label>
              <label className="statement-form-field statement-form-field--qty">
                수량
                <input
                  type="text"
                  inputMode="decimal"
                  value={form.quantity}
                  onChange={(event) => handleFieldChange('quantity', event.target.value)}
                  placeholder="예: 10"
                />
              </label>
              <label className="statement-form-field statement-form-field--price">
                단가
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.unitPrice}
                  onChange={(event) => handleFieldChange('unitPrice', event.target.value)}
                  placeholder="예: 33000"
                />
              </label>
              <label className="statement-form-field statement-form-field--tax">
                과세구분
                <select
                  value={form.note}
                  onChange={(event) => handleFieldChange('note', event.target.value)}
                >
                  {NOTE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="calculation-card span-2">
              <div>
                <span>공급가액</span>
                <strong>{formatCurrency(calculatedAmounts.supplyAmount)}원</strong>
              </div>
              <div>
                <span>세액</span>
                <strong>{formatCurrency(calculatedAmounts.taxAmount)}원</strong>
              </div>
              <div>
                <span>계</span>
                <strong>{formatCurrency(calculatedAmounts.totalAmount)}원</strong>
              </div>
            </div>

            {editingRecordId ? (
              <div className="statement-form-submit-row span-2">
                <button type="button" className="ghost-button" onClick={handleCancelStatementEdit}>
                  수정 취소
                </button>
              </div>
            ) : null}
          </form>
        </section>
          </div>
        </div>
      ) : null}

      {bulkItemPickerOpen ? (
        <div
          className="inventory-reset-dialog-backdrop"
          role="presentation"
          onClick={handleCloseBulkItemPicker}
        >
          <div
            className="inventory-reset-dialog statement-bulk-item-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="statement-bulk-item-picker-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="statement-bulk-item-picker-title" className="inventory-reset-dialog-title">
              품목 여러 개 추가
            </h2>
            <p className="inventory-reset-dialog-body">
              현재 폼의 <strong>납품일·횟수·과세구분</strong>은 공통으로 적용됩니다. 각 품목 옆 <strong>수량</strong>
              을 바꿀 수 있고, 새로 체크할 때는 폼 수량란 값(비어 있으면 1)이 기본으로 들어갑니다. 단가는 거래처
              단가표가 있으면 우선 적용하고, 없으면 품목 마스터 단가를 씁니다.
            </p>
            <label className="inventory-reset-dialog-field">
              <span className="inventory-reset-dialog-label">품목 검색</span>
              <input
                type="text"
                className="statement-bulk-item-dialog-search"
                value={bulkItemPickerQuery}
                onChange={(event) => setBulkItemPickerQuery(event.target.value)}
                placeholder="이름 일부로 좁히기"
                autoComplete="off"
                inputMode="search"
                aria-label="품목 검색"
              />
            </label>
            <div className="statement-bulk-item-dialog-toolbar">
              <button type="button" className="ghost-button small" onClick={handleBulkItemPickerSelectAllVisible}>
                보이는 항목 전체 선택
              </button>
              <button type="button" className="ghost-button small" onClick={handleBulkItemPickerClearVisible}>
                보이는 항목 선택 해제
              </button>
              <span className="statement-bulk-item-dialog-count">{bulkItemPickerPick.selected.size}개 선택</span>
            </div>
            <div className="statement-bulk-item-dialog-list" role="list">
              {bulkPickerVisibleItems.length === 0 ? (
                <p className="statement-bulk-item-dialog-empty">표시할 품목이 없습니다.</p>
              ) : (
                bulkPickerVisibleItems.map((name) => {
                  const preview = resolveStatementPricingForClientItem(
                    pricingRules,
                    masterItems,
                    form.clientName.trim(),
                    name,
                  )
                  const checked = bulkItemPickerPick.selected.has(name)
                  return (
                    <div key={name} className="statement-bulk-item-dialog-row" role="listitem">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => handleBulkItemPickerToggle(name)}
                        aria-label={`${name} 선택`}
                      />
                      <div className="statement-bulk-item-dialog-row-main">
                        <span className="statement-bulk-item-dialog-row-name">{name}</span>
                        <span className="statement-bulk-item-dialog-row-meta">
                          {preview && preview.unitPrice > 0
                            ? `${preview.specUnit ? `${preview.specUnit} · ` : ''}${formatCurrency(preview.unitPrice)}원`
                            : '단가 없음'}
                        </span>
                      </div>
                      <input
                        type="text"
                        inputMode="numeric"
                        className="statement-bulk-item-dialog-qty"
                        disabled={!checked}
                        value={checked ? bulkItemPickerPick.quantities[name] ?? '' : ''}
                        onChange={(event) => handleBulkItemPickerQtyChange(name, event.target.value)}
                        aria-label={`${name} 수량`}
                      />
                    </div>
                  )
                })
              )}
            </div>
            <div className="inventory-reset-dialog-actions">
              <button type="button" className="ghost-button" onClick={handleCloseBulkItemPicker}>
                닫기
              </button>
              <button type="button" className="primary-button" onClick={handleBulkAddStatementItems}>
                선택 항목 입력 목록에 추가
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {isAdminUnlockDialogOpen ? (
        <div
          className="inventory-reset-dialog-backdrop"
          role="presentation"
          onClick={closeAdminUnlockDialog}
        >
          <div
            className="inventory-reset-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="statement-admin-unlock-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="statement-admin-unlock-title" className="inventory-reset-dialog-title">
              관리자 모드
            </h2>
            <p className="inventory-reset-dialog-body">
              입출고 현황의 「전체 초기화」와 동일한 4자리 비밀번호를 입력한 뒤 확인을 누르세요.
            </p>
            <label className="inventory-reset-dialog-field">
              <span className="inventory-reset-dialog-label">비밀번호 (4자리)</span>
              <input
                className="inventory-reset-dialog-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                placeholder="0000"
                aria-invalid={adminUnlockError ? true : undefined}
                autoFocus
                value={adminUnlockPin}
                onChange={(event) => {
                  setAdminUnlockError('')
                  const next = event.target.value.replace(/\D/g, '').slice(0, 4)
                  setAdminUnlockPin(next)
                }}
              />
            </label>
            {adminUnlockError ? (
              <p className="inventory-reset-dialog-error" role="alert">
                {adminUnlockError}
              </p>
            ) : null}
            <div className="inventory-reset-dialog-actions">
              <button type="button" className="ghost-button" onClick={closeAdminUnlockDialog}>
                취소
              </button>
              <button type="button" className="primary-button" onClick={handleAdminUnlockConfirm}>
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
        </>
      ) : activePage === 'beanSalesAnalysis' ? (
        <BeanSalesAnalysisPage />
      ) : activePage === 'meeting' ? (
        <MonthlyMeetingPage />
      ) : activePage === 'expense' ? (
        <ExpensePage />
      ) : activePage === 'staffPayroll' ? (
        <StaffPayrollPage />
      ) : activePage === 'greenBeanOrder' ? (
        <GreenBeanOrderPage />
      ) : activePage === 'dailyMeeting' ? (
        <MemoPage mode="dailyOnly" />
      ) : activePage === 'team' ? (
        <TeamManagementPage />
      ) : (
        <InventoryStatusPage />
      )}
      {activePage === 'statements' ? (
        <div
          ref={statementStickyHScrollRef}
          className={`statements-sticky-hscroll${statementStickyHScrollVisible ? ' is-visible' : ''}`}
          aria-hidden={!statementStickyHScrollVisible}
        >
          <div ref={statementStickyHScrollInnerRef} className="statements-sticky-hscroll-inner" />
        </div>
      ) : null}

      {lowGreenBeanWarningItems.length > 0 && !isLowGreenBeanPanelDismissed ? (
        <div
          className="app-low-green-bean-floating no-print"
          role="dialog"
          aria-modal="false"
          aria-labelledby="app-low-green-bean-floating-title"
          aria-live="polite"
        >
          <div className="app-low-green-bean-floating-header">
            <span id="app-low-green-bean-floating-title" className="app-low-green-bean-floating-title">
              생두 재고 경고
            </span>
            <button
              type="button"
              className="app-low-green-bean-floating-close"
              onClick={() => setIsLowGreenBeanPanelDismissed(true)}
              aria-label="경고 닫기"
            >
              ×
            </button>
          </div>
          <p className="app-low-green-bean-floating-hint">
            DARK / LIGHT / DECAFFEINE BLEND 제외. Brazil·Narino·Sidamo 계열 <strong>40kg</strong> 미만, 그 밖 <strong>5kg</strong>{' '}
            미만.
          </p>
          <ul className="app-low-green-bean-floating-list">
            {lowGreenBeanWarningItems.map((item) => (
              <li key={item.name}>
                <span className="app-low-green-bean-floating-name">{item.name}</span>
                <span className="app-low-green-bean-floating-value">
                  {item.kg.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}kg
                </span>
                <span className="app-low-green-bean-floating-thr">(기준 {item.threshold}kg)</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {statementSaveToastVisible ? (
        <div className="statement-entry-save-toast" role="status" aria-live="polite">
          저장되었습니다
        </div>
      ) : null}
    </div>
  )
}

export default App
