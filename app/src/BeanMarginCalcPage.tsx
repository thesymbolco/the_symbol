import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from 'react'
import { getGreenOrderWonPerKgByInventoryLabel } from './beanSalesGreenOrderUnitPrice'
import { mapStatementItemToInventoryLabel } from './beanSalesStatementMapping'
import { INVENTORY_STATUS_STORAGE_KEY } from './InventoryStatusPage'
import { parseInventoryStatusStateFromLocalStorageJson, type InventoryBeanRow } from './inventoryStatusUtils'
import {
  BEAN_MARGIN_CALC_STORAGE_KEY,
  DEFAULT_BEAN_MARGIN_STATE,
  buildGreenPriceMap,
  computeBeanMarginRows,
  computeBlendGreenPrice,
  normalizeBeanMarginState,
  type BeanMarginCalcState,
  type BeanMarginOperatingInputs,
  type BeanMarginProduct,
} from './beanMarginCalcModel'

type ModalId = 'opex' | 'blend' | 'guide' | null

const currency = new Intl.NumberFormat('ko-KR')
const fmtWon = (n: number) => currency.format(Math.round(n))
const fmtPct = (n: number | null) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`)

function NumInput({
  value,
  onChange,
  className = '',
  step = 1,
  min,
}: {
  value: number
  onChange: (v: number) => void
  className?: string
  step?: number
  min?: number
}) {
  return (
    <input
      type="number"
      className={`bean-margin-num-input ${className}`.trim()}
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        const next = Number(e.target.value)
        onChange(Number.isFinite(next) ? next : 0)
      }}
    />
  )
}

function OptionalNumInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | null
  onChange: (v: number | null) => void
  placeholder?: string
}) {
  return (
    <input
      type="number"
      className="bean-margin-num-input"
      value={value == null ? '' : value}
      placeholder={placeholder}
      step={1}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value.trim()
        if (raw === '') {
          onChange(null)
          return
        }
        const next = Number(raw)
        onChange(Number.isFinite(next) ? next : null)
      }}
    />
  )
}

function BeanMarginModal({
  open,
  titleId,
  title,
  hint,
  children,
  onClose,
}: {
  open: boolean
  titleId: string
  title: string
  hint?: string
  children: ReactNode
  onClose: () => void
}) {
  if (!open) {
    return null
  }
  return (
    <div className="inventory-reset-dialog-backdrop bean-margin-modal-backdrop" onClick={onClose}>
      <div
        className="inventory-reset-dialog bean-margin-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="inventory-reset-dialog-title">
          {title}
        </h2>
        {hint ? <p className="inventory-reset-dialog-body">{hint}</p> : null}
        <div className="bean-margin-modal-body">{children}</div>
        <div className="inventory-reset-dialog-actions">
          <button type="button" className="primary-button" onClick={onClose}>
            확인
          </button>
        </div>
      </div>
    </div>
  )
}

function OperatingExpenseForm({
  opex,
  opexTotals,
  patchOperating,
}: {
  opex: BeanMarginOperatingInputs
  opexTotals: ReturnType<typeof computeBeanMarginRows>['operating']
  patchOperating: (patch: Partial<BeanMarginOperatingInputs>) => void
}) {
  return (
    <table className="bean-margin-opex-table">
      <thead>
        <tr>
          <th>항목</th>
          <th>1kg</th>
          <th>200g</th>
          <th>설명</th>
        </tr>
      </thead>
      <tbody>
        <tr className="bean-margin-opex-group">
          <th colSpan={4}>포장</th>
        </tr>
        <tr>
          <th scope="row">봉지</th>
          <td>
            <NumInput value={opex.bag1kg} onChange={(v) => patchOperating({ bag1kg: v })} />
          </td>
          <td>
            <NumInput value={opex.bag200g} onChange={(v) => patchOperating({ bag200g: v })} />
          </td>
          <td>밸브백·크라프트 등</td>
        </tr>
        <tr>
          <th scope="row">라벨</th>
          <td>
            <NumInput value={opex.label1kg} onChange={(v) => patchOperating({ label1kg: v })} />
          </td>
          <td>
            <NumInput value={opex.label200g} onChange={(v) => patchOperating({ label200g: v })} />
          </td>
          <td>라벨·인쇄비</td>
        </tr>
        <tr>
          <th scope="row">스티커·테이프 등</th>
          <td>
            <NumInput value={opex.sticker1kg} onChange={(v) => patchOperating({ sticker1kg: v })} />
          </td>
          <td>
            <NumInput value={opex.sticker200g} onChange={(v) => patchOperating({ sticker200g: v })} />
          </td>
          <td>기타 포장재</td>
        </tr>
        <tr className="bean-margin-opex-subtotal">
          <th scope="row">포장 소계</th>
          <td>{fmtWon(opexTotals.packaging1kg)}</td>
          <td>{fmtWon(opexTotals.packaging200g)}</td>
          <td />
        </tr>
        <tr className="bean-margin-opex-group">
          <th colSpan={4}>충전·인건</th>
        </tr>
        <tr>
          <th scope="row">충전시간 (분)</th>
          <td>
            <NumInput value={opex.fillMinutes1kg} step={0.1} onChange={(v) => patchOperating({ fillMinutes1kg: v })} />
          </td>
          <td>
            <NumInput value={opex.fillMinutes200g} step={0.1} onChange={(v) => patchOperating({ fillMinutes200g: v })} />
          </td>
          <td>팩당 계량·충전·밀봉</td>
        </tr>
        <tr>
          <th scope="row">시급 (원/시간)</th>
          <td colSpan={2}>
            <NumInput value={opex.hourlyWage} step={500} onChange={(v) => patchOperating({ hourlyWage: v })} />
          </td>
          <td>분÷60×시급</td>
        </tr>
        <tr>
          <th scope="row">충전 인건비</th>
          <td>{fmtWon(opexTotals.labor1kg)}</td>
          <td>{fmtWon(opexTotals.labor200g)}</td>
          <td />
        </tr>
        <tr className="bean-margin-opex-group">
          <th colSpan={4}>손실·재작업</th>
        </tr>
        <tr>
          <th scope="row">예비비 (원)</th>
          <td>
            <NumInput value={opex.reserve1kg} onChange={(v) => patchOperating({ reserve1kg: v })} />
          </td>
          <td>
            <NumInput value={opex.reserve200g} onChange={(v) => patchOperating({ reserve200g: v })} />
          </td>
          <td />
        </tr>
        <tr className="bean-margin-opex-group">
          <th colSpan={4}>배송 안분</th>
        </tr>
        <tr>
          <th scope="row">택배비 (원/건)</th>
          <td colSpan={2}>
            <NumInput value={opex.shippingPerOrder} onChange={(v) => patchOperating({ shippingPerOrder: v })} />
          </td>
          <td />
        </tr>
        <tr>
          <th scope="row">주문당 평균 팩 수</th>
          <td>
            <NumInput value={opex.packsPerOrder1kg} step={0.1} onChange={(v) => patchOperating({ packsPerOrder1kg: v })} />
          </td>
          <td>
            <NumInput value={opex.packsPerOrder200g} step={0.1} onChange={(v) => patchOperating({ packsPerOrder200g: v })} />
          </td>
          <td />
        </tr>
        <tr>
          <th scope="row">배송 안분</th>
          <td>{fmtWon(opexTotals.shipping1kg)}</td>
          <td>
            {opex.shippingOverride200g != null ? (
              <NumInput
                value={opex.shippingOverride200g}
                onChange={(v) => patchOperating({ shippingOverride200g: v })}
              />
            ) : (
              fmtWon(opexTotals.shipping200g)
            )}
          </td>
          <td>
            <button
              type="button"
              className="ghost-button bean-margin-inline-btn"
              onClick={() =>
                patchOperating({
                  shippingOverride200g: opex.shippingOverride200g == null ? opexTotals.shipping200g : null,
                })
              }
            >
              {opex.shippingOverride200g == null ? '200g 직접 입력' : '수식으로 복귀'}
            </button>
          </td>
        </tr>
        <tr className="bean-margin-opex-group">
          <th colSpan={4}>월 고정비 안분 (선택)</th>
        </tr>
        <tr>
          <th scope="row">월 고정비 합계 (원)</th>
          <td colSpan={2}>
            <NumInput value={opex.monthlyFixed} onChange={(v) => patchOperating({ monthlyFixed: v })} />
          </td>
          <td />
        </tr>
        <tr>
          <th scope="row">월 판매량 (kg)</th>
          <td colSpan={2}>
            <NumInput value={opex.monthlySalesKg} step={1} onChange={(v) => patchOperating({ monthlySalesKg: v })} />
          </td>
          <td />
        </tr>
        <tr>
          <th scope="row">고정비 안분</th>
          <td>{fmtWon(opexTotals.fixed1kg)}</td>
          <td>{fmtWon(opexTotals.fixed200g)}</td>
          <td>200g = 1kg×0.2</td>
        </tr>
        <tr className="bean-margin-opex-total">
          <th scope="row">운영경비 합계</th>
          <td>{fmtWon(opexTotals.total1kg)}</td>
          <td>{fmtWon(opexTotals.total200g)}</td>
          <td>→ 원두별 마진에 연동</td>
        </tr>
      </tbody>
    </table>
  )
}

function BlendRecipeForm({
  blends,
  greenMap,
  patchBlendRatio,
}: {
  blends: BeanMarginCalcState['blends']
  greenMap: Map<string, number>
  patchBlendRatio: (recipeId: 'dark' | 'light', productId: string, ratio: number) => void
}) {
  return (
    <div className="bean-margin-blend-section">
      {blends.map((recipe) => {
        const blendGreen = computeBlendGreenPrice(recipe, greenMap)
        return (
          <article key={recipe.id} className="bean-margin-blend-card">
            <h3>{recipe.title}</h3>
            <table className="bean-margin-opex-table">
              <thead>
                <tr>
                  <th>구성 원두</th>
                  <th>비율</th>
                  <th>생두가(연동)</th>
                  <th>비율×가격</th>
                </tr>
              </thead>
              <tbody>
                {recipe.components.map((c) => {
                  const linked = greenMap.get(c.productId) ?? 0
                  return (
                    <tr key={`${recipe.id}-${c.productId}`}>
                      <th scope="row">{c.label}</th>
                      <td>
                        <NumInput
                          value={c.ratio}
                          step={0.1}
                          min={0}
                          onChange={(v) => patchBlendRatio(recipe.id, c.productId, v)}
                        />
                      </td>
                      <td>{fmtWon(linked)}</td>
                      <td>{fmtWon(c.ratio * linked)}</td>
                    </tr>
                  )
                })}
                <tr className="bean-margin-opex-subtotal">
                  <th scope="row">블렌드 생두가</th>
                  <td colSpan={2}>가중평균</td>
                  <td>{blendGreen == null ? '—' : `${fmtWon(blendGreen)} 원/kg`}</td>
                </tr>
              </tbody>
            </table>
          </article>
        )
      })}
    </div>
  )
}

export default function BeanMarginCalcPage() {
  const [modal, setModal] = useState<ModalId>(null)
  const [state, setState] = useState<BeanMarginCalcState>(() => {
    try {
      const raw = window.localStorage.getItem(BEAN_MARGIN_CALC_STORAGE_KEY)
      if (!raw) {
        return DEFAULT_BEAN_MARGIN_STATE
      }
      return normalizeBeanMarginState(JSON.parse(raw))
    } catch {
      return DEFAULT_BEAN_MARGIN_STATE
    }
  })

  useEffect(() => {
    window.localStorage.setItem(BEAN_MARGIN_CALC_STORAGE_KEY, JSON.stringify(state))
  }, [state])

  useEffect(() => {
    if (!modal) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModal(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])

  const computed = useMemo(() => computeBeanMarginRows(state), [state])
  const greenMap = useMemo(() => buildGreenPriceMap(state), [state])

  const patchSettings = useCallback((patch: Partial<BeanMarginCalcState['settings']>) => {
    setState((prev) => ({ ...prev, settings: { ...prev.settings, ...patch } }))
  }, [])

  const patchOperating = useCallback((patch: Partial<BeanMarginOperatingInputs>) => {
    setState((prev) => ({ ...prev, operating: { ...prev.operating, ...patch } }))
  }, [])

  const patchProduct = useCallback((id: string, patch: Partial<BeanMarginProduct>) => {
    setState((prev) => ({
      ...prev,
      products: prev.products.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }))
  }, [])

  const patchBlendRatio = useCallback((recipeId: 'dark' | 'light', productId: string, ratio: number) => {
    setState((prev) => ({
      ...prev,
      blends: prev.blends.map((b) =>
        b.id !== recipeId
          ? b
          : {
              ...b,
              components: b.components.map((c) => (c.productId === productId ? { ...c, ratio } : c)),
            },
      ),
    }))
  }, [])

  const resetDefaults = () => {
    if (window.confirm('엑셀 기본값으로 되돌릴까요? 입력한 생두가·운영경비·판매가가 모두 초기화됩니다.')) {
      setState(DEFAULT_BEAN_MARGIN_STATE)
    }
  }

  const importMonthlyGreenPrices = () => {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    let beanRows: InventoryBeanRow[] = []
    try {
      const raw = window.localStorage.getItem(INVENTORY_STATUS_STORAGE_KEY)
      if (raw) {
        const st = parseInventoryStatusStateFromLocalStorageJson(JSON.parse(raw))
        beanRows = Array.isArray(st?.beanRows) ? st.beanRows : []
      }
    } catch {
      beanRows = []
    }
    const priceMap = getGreenOrderWonPerKgByInventoryLabel(beanRows, { mode: 'monthly_avg', ym })
    let updated = 0
    setState((prev) => ({
      ...prev,
      products: prev.products.map((p) => {
        if (p.kind !== 'single') {
          return p
        }
        const { label } = mapStatementItemToInventoryLabel(p.name, beanRows)
        const c = priceMap.get(label)
        if (!c || !Number.isFinite(c.wonPerKg)) {
          return p
        }
        updated += 1
        return { ...p, greenWonPerKg: Math.round(c.wonPerKg) }
      }),
    }))
    window.alert(
      updated > 0
        ? `${ym} 생두 주문 가중평균으로 싱글 오리진 ${updated}건 생두가를 채웠습니다.`
        : `${ym} 생두 주문·입출고 매칭 데이터가 없어 바뀐 항목이 없습니다.`,
    )
  }

  const opex = state.operating
  const opexTotals = computed.operating

  return (
    <div className="bean-margin-page">
      <section className="bean-margin-section">
        <div className="bean-margin-settings-bar">
          <div className="bean-margin-settings-grid">
          <label className="bean-margin-field">
            <span>로스율 (0.2 = 20%)</span>
            <NumInput
              className="bean-margin-input-editable"
              value={state.settings.roastLossRate}
              step={0.01}
              min={0}
              onChange={(v) => patchSettings({ roastLossRate: Math.min(0.99, Math.max(0, v)) })}
            />
          </label>
          <label className="bean-margin-field">
            <span>생두배수 1÷(1−로스율)</span>
            <output className="bean-margin-readonly">{computed.settings.greenMultiplier.toFixed(4)}</output>
          </label>
          <label className="bean-margin-field">
            <span>목표 마진율</span>
            <NumInput
              className="bean-margin-input-editable"
              value={state.settings.targetMarginRate}
              step={0.01}
              min={0}
              onChange={(v) => patchSettings({ targetMarginRate: Math.min(0.99, Math.max(0, v)) })}
            />
          </label>
          <label className="bean-margin-field">
            <span>운영경비 1kg (자동)</span>
            <output className="bean-margin-readonly">
              {fmtWon(opexTotals.total1kg)}원
              <button type="button" className="bean-margin-field-link" onClick={() => setModal('opex')}>
                수정
              </button>
            </output>
          </label>
          <label className="bean-margin-field">
            <span>운영경비 200g (자동)</span>
            <output className="bean-margin-readonly">
              {fmtWon(opexTotals.total200g)}원
              <button type="button" className="bean-margin-field-link" onClick={() => setModal('opex')}>
                수정
              </button>
            </output>
          </label>
          </div>
          <nav className="bean-margin-aux-actions" aria-label="보조 설정">
            <button type="button" className="green-bean-toolbar-link bean-margin-aux-link" onClick={() => setModal('opex')}>
              운영경비
            </button>
            <span className="bean-margin-aux-sep" aria-hidden>
              |
            </span>
            <button type="button" className="green-bean-toolbar-link bean-margin-aux-link" onClick={() => setModal('blend')}>
              블렌딩
            </button>
            <span className="bean-margin-aux-sep" aria-hidden>
              |
            </span>
            <button
              type="button"
              className="green-bean-toolbar-link bean-margin-aux-link"
              onClick={importMonthlyGreenPrices}
              title="이번 달 생두 주문 일자 기록의 품목별 가중평균 원/kg을 싱글 오리진 생두가에 반영합니다."
            >
              당월 생두가
            </button>
            <span className="bean-margin-aux-sep" aria-hidden>
              |
            </span>
            <button type="button" className="green-bean-toolbar-link bean-margin-aux-link" onClick={() => setModal('guide')}>
              사용법
            </button>
            <span className="bean-margin-aux-sep" aria-hidden>
              ·
            </span>
            <button
              type="button"
              className="green-bean-toolbar-link bean-margin-aux-link bean-margin-aux-link--muted"
              onClick={resetDefaults}
            >
              기본값
            </button>
          </nav>
        </div>

        <p className="bean-margin-hint">
          노란 = 생두가·판매가 · 하늘 = 블렌드(자동) · 판매가 비우면 목표마진 기준 자동(천·오백원 반올림)
        </p>

        <div className="bean-margin-table-wrap">
          <table className="bean-margin-table">
            <thead>
              <tr>
                <th rowSpan={2}>품목</th>
                <th rowSpan={2}>
                  생두가
                  <br />
                  (원/kg)
                </th>
                <th colSpan={2}>원두원가</th>
                <th colSpan={2}>운영경비</th>
                <th colSpan={2}>판매가</th>
                <th colSpan={2}>마진액</th>
                <th colSpan={2}>마진율</th>
              </tr>
              <tr>
                <th>1kg</th>
                <th>200g</th>
                <th>1kg</th>
                <th>200g</th>
                <th>1kg</th>
                <th>200g</th>
                <th>1kg</th>
                <th>200g</th>
                <th>1kg</th>
                <th>200g</th>
              </tr>
            </thead>
            <tbody>
              {computed.rows.map((row) => {
                const product = state.products.find((p) => p.id === row.productId)
                const isBlend = row.kind === 'blend'
                return (
                  <tr key={row.productId} className={isBlend ? 'bean-margin-row--blend' : undefined}>
                    <th scope="row">{row.name}</th>
                    <td className={isBlend ? 'bean-margin-cell--blend' : 'bean-margin-cell--editable'}>
                      {isBlend ? (
                        fmtWon(row.greenWonPerKg)
                      ) : (
                        <NumInput
                          value={product?.greenWonPerKg ?? 0}
                          step={100}
                          min={0}
                          onChange={(v) => patchProduct(row.productId, { greenWonPerKg: v })}
                        />
                      )}
                    </td>
                    <td>{fmtWon(row.beanCost1kg)}</td>
                    <td>{fmtWon(row.beanCost200g)}</td>
                    <td>{fmtWon(row.opex1kg)}</td>
                    <td>{fmtWon(row.opex200g)}</td>
                    <td className="bean-margin-cell--sale">
                      <OptionalNumInput
                        value={product?.salePrice1kg ?? null}
                        placeholder={fmtWon(row.sale1kg)}
                        onChange={(v) => patchProduct(row.productId, { salePrice1kg: v })}
                      />
                      {row.sale1kgIsAuto ? <span className="bean-margin-auto-tag">자동</span> : null}
                    </td>
                    <td className="bean-margin-cell--sale">
                      <OptionalNumInput
                        value={product?.salePrice200g ?? null}
                        placeholder={fmtWon(row.sale200g)}
                        onChange={(v) => patchProduct(row.productId, { salePrice200g: v })}
                      />
                      {row.sale200gIsAuto ? <span className="bean-margin-auto-tag">자동</span> : null}
                    </td>
                    <td>{fmtWon(row.marginAmount1kg)}</td>
                    <td>{fmtWon(row.marginAmount200g)}</td>
                    <td>{fmtPct(row.marginRate1kg)}</td>
                    <td>{fmtPct(row.marginRate200g)}</td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={10} scope="row">
                  평균 마진율
                </th>
                <td>{fmtPct(computed.avgMarginRate1kg)}</td>
                <td>{fmtPct(computed.avgMarginRate200g)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      <BeanMarginModal
        open={modal === 'opex'}
        titleId="bean-margin-opex-modal-title"
        title="운영경비 계산"
        hint="노란 셀만 수정하면 합계가 원두별 마진 표의 운영경비 열에 반영됩니다."
        onClose={() => setModal(null)}
      >
        <OperatingExpenseForm opex={opex} opexTotals={opexTotals} patchOperating={patchOperating} />
      </BeanMarginModal>

      <BeanMarginModal
        open={modal === 'blend'}
        titleId="bean-margin-blend-modal-title"
        title="블렌딩 레시피"
        hint="비율(노란) 수정 → 가중평균 생두가가 블렌드 품목에 반영됩니다. 생두가(연동) = 싱글 오리진 생두가."
        onClose={() => setModal(null)}
      >
        <BlendRecipeForm blends={state.blends} greenMap={greenMap} patchBlendRatio={patchBlendRatio} />
      </BeanMarginModal>

      <BeanMarginModal
        open={modal === 'guide'}
        titleId="bean-margin-guide-modal-title"
        title="사용법"
        onClose={() => setModal(null)}
      >
        <section className="bean-margin-guide">
          <h3>구성</h3>
          <ul>
            <li>운영경비 계산 · 블렌딩 레시피는 상단 버튼(모달) · 원두별 마진은 본 화면</li>
          </ul>
          <h3>블렌딩 생두가</h3>
          <ul>
            <li>싱글 오리진 생두가를 바꾸면 블렌드 가격이 자동 반영됩니다.</li>
            <li>블렌딩 레시피 모달에서 비율을 수정할 수 있습니다.</li>
            <li>공식: (비율1×생두가1 + 비율2×생두가2 + …) ÷ 비율 합</li>
          </ul>
          <h3>운영경비</h3>
          <ul>
            <li>운영경비 계산 모달 입력값 → 마진 표 운영경비 열에 연동</li>
          </ul>
          <h3>원두별 마진</h3>
          <ul>
            <li>노란 = 싱글 생두가 · 하늘 = 블렌드(자동) · 주황 = 판매가(비우면 목표마진 기준 자동)</li>
          </ul>
        </section>
      </BeanMarginModal>
    </div>
  )
}
