/**
 * 웹앱 「지출 엑셀 업로드」 첫 시트 파싱 규칙에 맞춘 예시 파일을 생성합니다.
 * 실행: npm run sample:expense-xlsx (app 디렉터리에서)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const outPath = path.join(repoRoot, 'docs', '지출표_업로드_예시.xlsx')

const header = [
  '지출일',
  '거래처',
  '카테고리',
  '용도',
  '세부항목',
  '결제금액',
  '과세구분',
  '지급수단',
  '상태',
  '증빙여부',
  '비고',
]

/** 날짜·거래처·금액 헤더 매칭 + 용도(기타경비/운영경비) 반영 예시 */
const rows = [
  header,
  [
    '2026-04-01',
    '○○생두 무역',
    '원재료비',
    '',
    '에티오피아 Yirgacheffe',
    350000,
    '과세',
    '카드',
    '지급완료',
    'Y',
    '카테고리만 적음 → 월마감 ①재료비 쪽 연동',
  ],
  [
    '2026-04-03',
    '사무용품샵',
    '기타운영비',
    '기타경비',
    '다이소 소모품',
    42800,
    '면세',
    '카드',
    '지급완료',
    '',
    '레거시 분류 + 용도 기타경비 → 기타경비로 반영',
  ],
  [
    '2026-04-05',
    '지역세무서',
    '',
    '운영경비',
    '4월 간이 과세 신고 소프트웨어',
    120000,
    '과세',
    '계좌이체',
    '지급완료',
    '이체완료',
    '카테고리 비움 + 용도 운영경비',
  ],
  [
    '2026-04-08',
    '○○통신판매',
    '운영경비',
    '',
    '포장 테이프·박스',
    89200,
    '과세',
    '카드',
    '지급완료',
    'Y',
    '카테고리에 직접 운영경비',
  ],
  [
    '2026-04-10',
    '빌딩관리사무소',
    '임차료',
    '',
    '매장 관리비(4월분)',
    1100000,
    '과세',
    '자동이체',
    '지급완료',
    '',
    '',
  ],
  [
    '2026-04-12',
    '한국전력',
    '전기/수도/가스',
    '',
    '전기',
    185400,
    '과세',
    '자동이체',
    '지급완료',
    '',
    '',
  ],
  [
    '2026-04-15',
    '(주)인력솔루션',
    '인건비',
    '',
    '알바 주휴 수당 외',
    645000,
    '과세',
    '계좌이체',
    '미지급',
    '',
    '미지급 예시 행',
  ],
  [
    '2026-04-18',
    '배달의민족',
    '수수료',
    '',
    '배달 수수료 자동 차감',
    73400,
    '과세',
    '카드',
    '지급완료',
    '',
    '기타 카테고리 → 월마감 그 외 비용(②기타) 흐름',
  ],
  [
    '2026-04-22',
    '○○건설',
    '기타운영비',
    '운영경비',
    '시설 경미 수리',
    220000,
    '과세',
    '카드',
    '지급완료',
    '영수증',
    '레거시 분류 + 용도 운영경비 → 운영경비 반영',
  ],
]

fs.mkdirSync(path.dirname(outPath), { recursive: true })

const worksheet = XLSX.utils.aoa_to_sheet(rows)
const workbook = XLSX.utils.book_new()

const colWidths = header.map((h, i) => {
  let w = Math.min(Math.max(...rows.map((r) => String(r[i] ?? '').length), String(h).length), 52)
  w = Math.max(w, 12)
  return { wch: w }
})
worksheet['!cols'] = colWidths

XLSX.utils.book_append_sheet(workbook, worksheet, '지출예시')

XLSX.writeFile(workbook, outPath)
console.log(`Wrote ${outPath}`)
