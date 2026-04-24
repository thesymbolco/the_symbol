import { useCallback, useEffect, useMemo, useState } from 'react'
import { BLEND_WON_OVERRIDES_SAVED_EVENT, readBlendWonOverridesByLabel, setBlendWonOverride } from './beanBlendWonOverrides'
import { getLatestGreenOrderWonPerKgByInventoryLabel } from './beanSalesGreenOrderUnitPrice'
import { GREEN_BEAN_ORDER_SAVED_EVENT } from './GreenBeanOrderPage'
import {
  isBlendingDarkBeanRow,
  isBlendingDecaffeineBeanRow,
  isBlendingLightBeanRow,
} from './inventoryBlendRecipes'
import {
  INVENTORY_STATUS_CACHE_EVENT,
  INVENTORY_STATUS_STORAGE_KEY,
  inventoryPageScopedKey,
} from './InventoryStatusPage'
import {
  BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT,
  hasAnyStatementManualForItem,
  readStatementInventoryManuals,
  saveStatementInventoryManualsWithCloud,
  syncStatementInventoryManualsFromCloud,
  type StatementInventoryManualEntry,
} from './beanStatementManualMappings'
import { COMPANY_DOCUMENT_KEYS, loadCompanyDocument } from './lib/companyDocuments'
import { formatBeanRowLabel, mapStatementItemToInventoryLabel, type MapStatementItemToInventoryOptions } from './beanSalesStatementMapping'
import { normalizeInventoryStatusState, type BlendingRecipe, type InventoryBeanRow } from './inventoryStatusUtils'

const STATEMENT_RECORDS_KEY = 'statement-records-v1'

const formatWon = (n: number) => new Intl.NumberFormat('ko-KR').format(Math.round(n))

type BlendWonFieldProps = {
  mappedLabel: string
  wonPerKg: number | null
  hasOverride: boolean
  mapOpts: MapStatementItemToInventoryOptions
}

function BlendWonField({ mappedLabel, wonPerKg, hasOverride, mapOpts }: BlendWonFieldProps) {
  const [text, setText] = useState(
    () => (wonPerKg != null && Number.isFinite(wonPerKg) ? String(Math.round(wonPerKg)) : ''),
  )
  useEffect(() => {
    setText(wonPerKg != null && Number.isFinite(wonPerKg) ? String(Math.round(wonPerKg)) : '')
  }, [mappedLabel, wonPerKg])
  const commit = () => {
    const t = text.replace(/,/g, '').trim()
    if (!t) {
      setBlendWonOverride(mapOpts, mappedLabel, null)
      return
    }
    const n = parseFloat(t.replace(/,/g, ''))
    if (!Number.isFinite(n) || n <= 0) {
      return
    }
    setBlendWonOverride(mapOpts, mappedLabel, n)
  }
  return (
    <div className="stmt-inv-link__blend-won-wrap">
      <input
        type="text"
        className="stmt-inv-link__blend-won-input"
        inputMode="numeric"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        placeholder="원/kg (입력·저장)"
        aria-label={`${mappedLabel} 최근 주문 원/kg`}
      />
      {hasOverride ? (
        <span className="stmt-inv-link__blend-ovr-badge" title="생두 주문가 대신 직접 입력">
          직접
        </span>
      ) : null}
    </div>
  )
}

type StatementRecord = { itemName: string }

type Props = {
  open: boolean
  onClose: () => void
  inventoryBeanRows: readonly InventoryBeanRow[]
  mode: 'local' | 'cloud'
  activeCompanyId: string | null
  preferredToLabel?: string | null
}

function StatementInventoryLinkModal({
  open,
  onClose,
  inventoryBeanRows,
  mode,
  activeCompanyId,
  preferredToLabel = null,
}: Props) {
  const [rows, setRows] = useState<StatementInventoryManualEntry[]>([])
  const [stmtPickTick, setStmtPickTick] = useState(0)
  const [showMatchedItems, setShowMatchedItems] = useState(false)
  const [draftFrom, setDraftFrom] = useState('')
  const [draftTo, setDraftTo] = useState('')
  const [costRefreshTick, setCostRefreshTick] = useState(0)

  const mapOpts = useMemo(
    () => ({ mode, companyId: activeCompanyId } as const),
    [mode, activeCompanyId],
  )

  const labelOptions = useMemo(
    () => inventoryBeanRows.map((b) => formatBeanRowLabel(b)),
    [inventoryBeanRows],
  )

  const allowedSet = useMemo(
    () => new Set(inventoryBeanRows.map((b) => formatBeanRowLabel(b))),
    [inventoryBeanRows],
  )

  const statementItemNames = useMemo(() => {
    const all = new Set<string>()
    try {
      const raw = window.localStorage.getItem(STATEMENT_RECORDS_KEY)
      if (raw) {
        const recs = JSON.parse(raw) as StatementRecord[]
        if (Array.isArray(recs)) {
          for (const r of recs) {
            if (r?.itemName?.trim()) {
              all.add(r.itemName.trim())
            }
          }
        }
      }
    } catch {
      // ignore
    }
    if (inventoryBeanRows.length === 0) {
      return []
    }
    return [...all].sort((a, b) => a.localeCompare(b, 'ko'))
  }, [open, stmtPickTick, inventoryBeanRows.length])

  const pickableItemNames = useMemo(() => {
    const manualFiltered = statementItemNames.filter(
      (name) => !hasAnyStatementManualForItem(name, mode, activeCompanyId),
    )
    if (showMatchedItems) {
      return manualFiltered
    }
    return manualFiltered.filter((name) => {
      const { label } = mapStatementItemToInventoryLabel(name, inventoryBeanRows, mapOpts)
      return !allowedSet.has(label)
    })
  }, [statementItemNames, mode, activeCompanyId, showMatchedItems, inventoryBeanRows, mapOpts, allowedSet, rows])

  const linkedPreviewItems = useMemo(() => {
    if (!preferredToLabel) {
      return []
    }
    return statementItemNames
      .map((name) => {
        const mapped = mapStatementItemToInventoryLabel(name, inventoryBeanRows, mapOpts)
        if (mapped.label !== preferredToLabel) {
          return null
        }
        return {
          name,
          source: hasAnyStatementManualForItem(name, mode, activeCompanyId) ? 'manual' : 'auto',
        } as const
      })
      .filter((v): v is { name: string; source: 'manual' | 'auto' } => Boolean(v))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  }, [preferredToLabel, statementItemNames, inventoryBeanRows, mapOpts, mode, activeCompanyId, rows])

  const blendRecipeSnapshot = useMemo(() => {
    const read = (key: string) => {
      try {
        const raw = window.localStorage.getItem(key)
        if (!raw) {
          return null
        }
        const st = normalizeInventoryStatusState(JSON.parse(raw))
        if (!st) {
          return null
        }
        return {
          dark: st.blendingDarkRecipe ?? null,
          light: st.blendingLightRecipe ?? null,
          decaf: st.blendingDecaffeineRecipe ?? null,
        }
      } catch {
        return null
      }
    }
    const primaryKey = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
    return read(primaryKey) ?? read(INVENTORY_STATUS_STORAGE_KEY) ?? { dark: null, light: null, decaf: null }
  }, [mode, activeCompanyId, open, costRefreshTick, stmtPickTick])

  const blendCostBreakdown = useMemo(() => {
    if (!open || !preferredToLabel) {
      return null
    }
    const targetBean = inventoryBeanRows.find((b) => formatBeanRowLabel(b) === preferredToLabel)
    if (!targetBean) {
      return null
    }
    const labelKind = isBlendingDarkBeanRow(targetBean)
      ? ('다크' as const)
      : isBlendingLightBeanRow(targetBean)
        ? ('라이트' as const)
        : isBlendingDecaffeineBeanRow(targetBean)
          ? ('디카페인' as const)
          : null
    if (!labelKind) {
      return null
    }
    const recipe: BlendingRecipe | null = isBlendingDarkBeanRow(targetBean)
      ? blendRecipeSnapshot.dark
      : isBlendingLightBeanRow(targetBean)
        ? blendRecipeSnapshot.light
        : blendRecipeSnapshot.decaf
    if (!recipe?.components?.length) {
      return {
        kind: labelKind,
        rows: [] as Array<{
          mappedLabel: string
          rawPerCycle: number
          wonPerKg: number | null
          hasOverride: boolean
        }>,
        weightedWonPerKg: null,
        totalRawForWeight: 0,
        roastedPerCycle: recipe?.roastedPerCycle ?? 0,
      }
    }
    const ovr = readBlendWonOverridesByLabel(mapOpts)
    const costMap = getLatestGreenOrderWonPerKgByInventoryLabel(
      inventoryBeanRows,
      mapOpts,
      blendRecipeSnapshot,
    )
    const rows = recipe.components.map((comp) => {
      const { label: mappedLabel } = mapStatementItemToInventoryLabel(
        comp.beanName,
        inventoryBeanRows,
        mapOpts,
      )
      const c = costMap.get(mappedLabel)
      return {
        mappedLabel,
        rawPerCycle: comp.rawPerCycle,
        hasOverride: ovr.has(mappedLabel),
        wonPerKg: c != null ? c.wonPerKg : null,
      }
    })
    let weighted = 0
    let totalRaw = 0
    for (const r of rows) {
      if (r.wonPerKg != null && r.rawPerCycle > 0) {
        weighted += r.wonPerKg * r.rawPerCycle
        totalRaw += r.rawPerCycle
      }
    }
    return {
      kind: labelKind,
      rows,
      weightedWonPerKg: totalRaw > 0 ? weighted / totalRaw : null,
      totalRawForWeight: totalRaw,
      roastedPerCycle: recipe.roastedPerCycle,
    }
  }, [
    open,
    preferredToLabel,
    inventoryBeanRows,
    mapOpts,
    blendRecipeSnapshot,
    costRefreshTick,
    stmtPickTick,
  ])

  const load = useCallback(() => {
    setRows(readStatementInventoryManuals(mode, activeCompanyId))
  }, [mode, activeCompanyId])

  useEffect(() => {
    if (open) {
      void (async () => {
        await syncStatementInventoryManualsFromCloud(mode, activeCompanyId)
        if (mode === 'cloud' && activeCompanyId) {
          try {
            const remoteStatement = await loadCompanyDocument<{ records?: Array<{ itemName?: string }> }>(
              activeCompanyId,
              COMPANY_DOCUMENT_KEYS.statementPage,
            )
            if (Array.isArray(remoteStatement?.records)) {
              window.localStorage.setItem(STATEMENT_RECORDS_KEY, JSON.stringify(remoteStatement.records))
            }
          } catch (error) {
            console.error('명세↔입고 모달: 거래명세 클라우드 문서를 읽지 못했습니다.', error)
          }
          try {
            const remoteInventory = await loadCompanyDocument<{ inventoryState?: unknown }>(
              activeCompanyId,
              COMPANY_DOCUMENT_KEYS.inventoryPage,
            )
            const candidate = remoteInventory?.inventoryState ?? remoteInventory
            if (candidate) {
              const st = normalizeInventoryStatusState(candidate)
              if (st) {
                const key = inventoryPageScopedKey(INVENTORY_STATUS_STORAGE_KEY, mode, activeCompanyId)
                window.localStorage.setItem(key, JSON.stringify(st))
              }
            }
          } catch (error) {
            console.error('명세↔입고 모달: 입출고 클라우드 문서를 읽지 못했습니다.', error)
          }
        }
        load()
      })()
      setDraftFrom('')
      if (preferredToLabel && labelOptions.includes(preferredToLabel)) {
        setShowMatchedItems(true)
        setDraftTo(preferredToLabel)
      } else {
        setDraftTo('')
      }
    }
  }, [open, load, preferredToLabel, labelOptions])

  useEffect(() => {
    if (draftFrom && !pickableItemNames.includes(draftFrom)) {
      setDraftFrom('')
    }
  }, [draftFrom, pickableItemNames])

  useEffect(() => {
    const on = () => setStmtPickTick((n) => n + 1)
    window.addEventListener(BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT, on)
    return () => window.removeEventListener(BEAN_STATEMENT_MANUAL_MAPPINGS_EVENT, on)
  }, [])

  useEffect(() => {
    if (!open) {
      return
    }
    const bump = () => setCostRefreshTick((n) => n + 1)
    window.addEventListener(INVENTORY_STATUS_CACHE_EVENT, bump)
    window.addEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, bump)
    window.addEventListener(BLEND_WON_OVERRIDES_SAVED_EVENT, bump)
    return () => {
      window.removeEventListener(INVENTORY_STATUS_CACHE_EVENT, bump)
      window.removeEventListener(GREEN_BEAN_ORDER_SAVED_EVENT, bump)
      window.removeEventListener(BLEND_WON_OVERRIDES_SAVED_EVENT, bump)
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const saveAll = (next: StatementInventoryManualEntry[]) => {
    setRows(next)
    void saveStatementInventoryManualsWithCloud(mode, activeCompanyId, next)
  }

  const addLink = () => {
    const from = draftFrom.trim()
    const to = draftTo.trim()
    if (!from || !to) {
      return
    }
    const next = rows.filter((r) => r.from !== from)
    next.push({ from, toLabel: to })
    saveAll(next)
    setDraftFrom('')
    setDraftTo('')
  }

  const updateRow = (index: number, toLabel: string) => {
    const next = rows.map((r, i) => (i === index ? { ...r, toLabel } : r))
    saveAll(next)
  }

  const removeRow = (index: number) => {
    saveAll(rows.filter((_, i) => i !== index))
  }

  if (!open) {
    return null
  }

  return (
    <div
      className="stmt-inv-modal-overlay"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="stmt-inv-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="stmt-inv-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="stmt-inv-modal-header">
          <h2 id="stmt-inv-modal-title">명세↔입고 연결</h2>
          <button type="button" className="stmt-inv-modal-close" onClick={onClose} aria-label="닫기">
            ×
          </button>
        </div>
        <p className="stmt-inv-modal-lead">
          기본은 <strong>미매칭 거래 품목만</strong> 목록에 뜹니다. 필요하면 <strong>이미 자동 매칭된 항목도 보기</strong>를
          켜서 수동으로 덮어쓸 수 있습니다(수동이 자동보다 먼저 적용).
        </p>

        <section className="stmt-inv-link__add" aria-label="새 연결">
          {preferredToLabel ? (
            <>
            <div className="stmt-inv-link__prefill">
              <strong>현재 선택 입고:</strong> {preferredToLabel}
              <div className="stmt-inv-link__prefill-list">
                {linkedPreviewItems.length > 0 ? (
                  linkedPreviewItems.map((item) => (
                    <span key={item.name} className="stmt-inv-link__chip" title={item.source === 'manual' ? '수동 연결' : '자동 매칭'}>
                      {item.name} · {item.source === 'manual' ? '수동' : '자동'}
                    </span>
                  ))
                ) : (
                  <span className="stmt-inv-link__prefill-empty">현재 이 입고로 잡힌 거래 품목이 없습니다.</span>
                )}
              </div>
            </div>
            {blendCostBreakdown ? (
              <div className="stmt-inv-link__blend" aria-label="블렌딩 원가 구성(입출고 레시피·생두 주문)">
                <div className="stmt-inv-link__blend-head">
                  <strong>블렌딩·{blendCostBreakdown.kind}</strong>
                  <span className="stmt-inv-link__blend-hint">
                    입출고 레시피; 최근 주문(원/kg)은 생두 주문「일자 기록」. 없을 때·틀릴 때 아래에 직접 입력(탭/엔터로 저장)합니다.
                  </span>
                </div>
                {blendCostBreakdown.rows.length === 0 ? (
                  <p className="stmt-inv-link__blend-empty">
                    이 블렌드는 입출고 · 일자별 로스팅에서 <strong>레시피(재료)</strong>를 아직 넣지 않았습니다. 거기서 재료를
                    추가하면 이 표가 채워집니다.
                  </p>
                ) : (
                  <>
                    <div className="stmt-inv-link__blend-table-wrap">
                      <table className="stmt-inv-link__blend-table">
                        <thead>
                          <tr>
                            <th scope="col">재료 라벨(입고)</th>
                            <th scope="col">최근 주문(원/kg)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {blendCostBreakdown.rows.map((r, idx) => (
                            <tr key={`${r.mappedLabel}-${idx}`}>
                              <td className="stmt-inv-link__blend-td-label">{r.mappedLabel}</td>
                              <td className="stmt-inv-link__blend-td-won">
                                <BlendWonField
                                  mappedLabel={r.mappedLabel}
                                  wonPerKg={r.wonPerKg}
                                  hasOverride={r.hasOverride}
                                  mapOpts={mapOpts}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {blendCostBreakdown.totalRawForWeight > 0 && blendCostBreakdown.weightedWonPerKg != null ? (
                      <p className="stmt-inv-link__blend-avg">
                        <strong>레시피 가중 평균(원/kg):</strong> {formatWon(blendCostBreakdown.weightedWonPerKg)}원
                        <span className="stmt-inv-link__td-muted"> · raw 합 {blendCostBreakdown.totalRawForWeight}kg</span>
                        {blendCostBreakdown.roastedPerCycle > 0 ? (
                          <span className="stmt-inv-link__td-muted">
                            {' '}
                            · 사이클당 로스팅 {blendCostBreakdown.roastedPerCycle}kg
                          </span>
                        ) : null}
                      </p>
                    ) : (
                      <p className="stmt-inv-link__blend-warn">구성 원두 중 주문가가 잡힌 항목이 없으면 가중 평균을 못 씁니다.</p>
                    )}
                  </>
                )}
              </div>
            ) : null}
            </>
          ) : null}
          <label className="stmt-inv-link__toggle">
            <input
              type="checkbox"
              checked={showMatchedItems}
              onChange={(e) => setShowMatchedItems(e.target.checked)}
            />
            이미 자동 매칭된 항목도 보기
          </label>
          <div className="stmt-inv-link__row">
            <label>
              <span>거래 품목</span>
              <select
                className="stmt-inv-link__from-select"
                value={draftFrom}
                onChange={(e) => setDraftFrom(e.target.value)}
              >
                <option value="">— 선택 —</option>
                {pickableItemNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <span className="stmt-inv-link__arrow" aria-hidden>
              →
            </span>
            <label>
              <span>입고</span>
              <select value={draftTo} onChange={(e) => setDraftTo(e.target.value)}>
                <option value="">선택</option>
                {labelOptions.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="stmt-inv-link__btn" onClick={addLink} disabled={!draftFrom.trim() || !draftTo}>
              연결
            </button>
          </div>
          {labelOptions.length === 0 ? (
            <p className="stmt-inv-link__warn">입출고 생두가 비어 있으면, 먼저 입출고 현황에 품목을 둡니다.</p>
          ) : pickableItemNames.length === 0 ? (
            <p className="stmt-inv-link__hint">
              {showMatchedItems
                ? '지금은 새로 잡을 거래 품목이 없습니다. 저장된 연결은 아래에서 수정·삭제할 수 있습니다.'
                : '지금은 추가로 잡을 미매칭 품목이 없습니다. 자동 매칭 항목을 수정하려면 "이미 자동 매칭된 항목도 보기"를 켜세요.'}
            </p>
          ) : null}
        </section>

        <section className="stmt-inv-link__list" aria-label="저장된 연결">
          <div className="stmt-inv-link__list-head">
            <h3>저장됨 {rows.length}건</h3>
            <button type="button" className="stmt-inv-link__aux" onClick={() => setStmtPickTick((n) => n + 1)}>
              거래 품목 다시 읽기
            </button>
          </div>
          {rows.length === 0 ? (
            <p className="stmt-inv-link__empty">아직 없음</p>
          ) : (
            <ul>
              {rows.map((r, i) => (
                <li key={`${r.from}-${i}`} className="stmt-inv-link__line">
                  <code className="stmt-inv-link__from" title="거래명세 itemName">
                    {r.from}
                  </code>
                  <span className="stmt-inv-link__arrow">→</span>
                  <select
                    className="stmt-inv-link__sel"
                    value={r.toLabel}
                    onChange={(e) => updateRow(i, e.target.value)}
                  >
                    {labelOptions.includes(r.toLabel) || !r.toLabel ? null : (
                      <option value={r.toLabel}>
                        {r.toLabel} (입고에 없음 — 정리 권장)
                      </option>
                    )}
                    {labelOptions.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="stmt-inv-link__rm" onClick={() => removeRow(i)} title="삭제">
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <style>{`
        .stmt-inv-modal-overlay { position: fixed; inset: 0; z-index: 5000; background: rgba(0,0,0,0.45);
          display: flex; align-items: center; justify-content: center; padding: 16px; }
        .stmt-inv-modal-panel { width: 100%; max-width: 640px; max-height: min(90vh, 700px); overflow: auto;
          background: #fff; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,0.2); padding: 16px 18px 20px; }
        .stmt-inv-modal-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
        .stmt-inv-modal-header h2 { margin: 0; font-size: 1.1rem; color: #222; }
        .stmt-inv-modal-close { border: none; background: #eee; width: 36px; height: 36px; border-radius: 6px; font-size: 22px; line-height: 1; cursor: pointer; color: #555; }
        .stmt-inv-modal-close:hover { background: #e0e0e0; }
        .stmt-inv-modal-lead { font-size: 0.85rem; color: #555; line-height: 1.45; margin: 0 0 14px; }
        .stmt-inv-link__add { margin: 0 0 12px; padding: 10px; background: #f5f6f8; border-radius: 8px; border: 1px solid #e3e5e8; }
        .stmt-inv-link__prefill { margin: 0 0 9px; font-size: 12px; color: #444; }
        .stmt-inv-link__prefill-list { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 5px; }
        .stmt-inv-link__chip { display: inline-block; border: 1px solid #d9dfe7; background: #fff; color: #455; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
        .stmt-inv-link__prefill-empty { font-size: 11px; color: #777; }
        .stmt-inv-link__blend { margin: 10px 0 0; padding: 10px; background: #f0f7ff; border: 1px solid #cfe2ff; border-radius: 8px; font-size: 12px; color: #333; overflow-x: hidden; max-width: 100%; box-sizing: border-box; }
        .stmt-inv-link__blend-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 8px; }
        .stmt-inv-link__blend-hint { font-size: 10px; color: #666; font-weight: 400; }
        .stmt-inv-link__blend-empty { margin: 0; font-size: 11px; color: #555; line-height: 1.45; }
        .stmt-inv-link__blend-table-wrap { overflow-x: hidden; min-width: 0; }
        .stmt-inv-link__blend-table { width: 100%; border-collapse: collapse; font-size: 11px; table-layout: fixed; min-width: 0; }
        .stmt-inv-link__blend-table th, .stmt-inv-link__blend-table td { border: 1px solid #d0dbe8; padding: 4px 6px; text-align: left; vertical-align: middle; }
        .stmt-inv-link__blend-table th { background: #e8f2fc; color: #444; font-weight: 600; }
        .stmt-inv-link__blend-table th:first-child { width: 45%; }
        .stmt-inv-link__blend-table th:last-child { width: 55%; }
        .stmt-inv-link__blend-td-label { word-break: break-word; font-size: 11px; color: #333; }
        .stmt-inv-link__blend-td-won { padding: 3px 4px !important; }
        .stmt-inv-link__blend-won-wrap { display: flex; align-items: center; gap: 6px; min-width: 0; }
        .stmt-inv-link__blend-won-input { flex: 1; min-width: 0; box-sizing: border-box; font-size: 12px; padding: 5px 7px; border: 1px solid #9db4cc; border-radius: 4px; background: #fff; }
        .stmt-inv-link__blend-won-input:focus { border-color: #0d6efd; outline: none; }
        .stmt-inv-link__blend-ovr-badge { flex: 0 0 auto; font-size: 10px; color: #0a58ca; background: #e7f0ff; border-radius: 4px; padding: 1px 5px; }
        .stmt-inv-link__code { font-size: 10px; background: #fff; padding: 1px 4px; border-radius: 3px; word-break: break-all; }
        .stmt-inv-link__td-muted { color: #666; }
        .stmt-inv-link__td-warn { color: #a50; font-size: 11px; }
        .stmt-inv-link__won { color: #0a58ca; }
        .stmt-inv-link__blend-avg { margin: 8px 0 0; font-size: 12px; color: #222; }
        .stmt-inv-link__blend-warn { margin: 6px 0 0; font-size: 11px; color: #8a4; }
        .stmt-inv-link__toggle { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: #555; margin: 0 0 8px; }
        .stmt-inv-link__row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px; }
        .stmt-inv-link__row label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: #666; }
        .stmt-inv-link__row select, .stmt-inv-link__sel {
          min-width: 0; max-width: 100%; font-size: 14px; padding: 5px 8px; border: 1px solid #ccc; border-radius: 4px;
        }
        .stmt-inv-link__from-select { min-width: 240px; max-width: 100%; }
        .stmt-inv-link__row label:has(.stmt-inv-link__from-select) + .stmt-inv-link__arrow + label select { min-width: 180px; }
        .stmt-inv-link__arrow { color: #999; font-weight: 600; padding: 0 2px; }
        .stmt-inv-link__btn { padding: 6px 12px; font-size: 14px; border-radius: 4px; border: none; background: #0d6efd; color: #fff; cursor: pointer; }
        .stmt-inv-link__btn:disabled { opacity: 0.45; cursor: not-allowed; }
        .stmt-inv-link__btn:not(:disabled):hover { background: #0b5ed7; }
        .stmt-inv-link__warn { font-size: 0.75rem; color: #a66; margin: 6px 0 0; }
        .stmt-inv-link__hint { font-size: 0.75rem; color: #666; margin: 6px 0 0; }
        .stmt-inv-link__list-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
        .stmt-inv-link__list h3 { font-size: 0.9rem; margin: 0; color: #333; }
        .stmt-inv-link__aux { font-size: 0.75rem; padding: 3px 8px; border: 1px solid #ccc; border-radius: 4px; background: #fff; cursor: pointer; color: #555; }
        .stmt-inv-link__aux:hover { background: #f0f0f0; }
        .stmt-inv-link__empty { font-size: 0.82rem; color: #777; }
        .stmt-inv-link__list ul { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow: auto; }
        .stmt-inv-link__line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px solid #eee; font-size: 13px; }
        .stmt-inv-link__from { flex: 1; min-width: 100px; background: #fafafa; padding: 3px 6px; border-radius: 4px; font-size: 12px; word-break: break-all; }
        .stmt-inv-link__sel { flex: 1; min-width: 160px; }
        .stmt-inv-link__rm { border: none; background: #eee; width: 26px; height: 26px; border-radius: 4px; cursor: pointer; font-size: 16px; line-height: 1; color: #666; }
        .stmt-inv-link__rm:hover { background: #f2dede; color: #a00; }
      `}</style>
    </div>
  )
}

export default StatementInventoryLinkModal
