import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ADMIN_FOUR_DIGIT_PIN } from './adminPin'

export type PosStatementRecord = {
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
  createdAt?: string
  isCashHandled?: boolean
}

export type PosPricingRule = {
  id: string
  clientName: string
  itemName: string
  specUnit: string
  unitPrice: number
}

export type PosMasterItem = {
  id: string
  itemName: string
  specUnit: string
  unitPrice: number
}

export const POS_FAVORITE_CLIENTS_STORAGE_KEY = 'statement-pos-favorite-clients-v1'

const POS_RECENT_DAYS = 14
const POS_RECENT_MAX = 10
const POS_SEARCH_MAX = 24

export type PosPricingAdminSaveResult = { ok: boolean; message: string }

type Props = {
  clientOptions: string[]
  pricingRules: PosPricingRule[]
  masterItems: PosMasterItem[]
  defaultDeliveryDate: string
  defaultNote: string
  existingRecords: PosStatementRecord[]
  favoriteClientsStorageKey: string
  allItemOptions: string[]
  onSaveClientPricingRule: (
    clientName: string,
    itemName: string,
    specUnit: string,
    unitPrice: string,
  ) => PosPricingAdminSaveResult
  onRemoveClientPricingRule: (id: string) => void
  onSaveMasterItem: (itemName: string, specUnit: string, unitPrice: string) => PosPricingAdminSaveResult
  onRemoveMasterItem: (id: string) => void
  onCommit: (records: PosStatementRecord[]) => void
  onClose: () => void
}

type PosCartLine = {
  id: string
  itemName: string
  specUnit: string
  quantity: number
  unitPrice: number
  note: string
  isCashHandled: boolean
  pricingSource: 'rule' | 'master' | 'manual'
}

type KeypadField = 'quantity' | 'unitPrice'

const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, '')

const isTaxFreeNote = (note: string) => normalize(note) === normalize('부가세 없음')

const calcTax = (supply: number, note: string) => {
  if (isTaxFreeNote(note)) return 0
  const base = Math.floor(supply * 0.1)
  const total = supply + base
  return total % 10 === 1 ? Math.max(0, base - 1) : base
}

const formatNumber = (value: number) =>
  Number.isFinite(value) ? value.toLocaleString('ko-KR') : '0'

const formatDecimal = (value: number) => {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? value.toString() : value.toString()
}

const readFavoriteClientsFromStorage = (key: string): string[] => {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.map((value) => String(value).trim()).filter(Boolean)
  } catch {
    return []
  }
}

function StatementPosEntryPanel({
  clientOptions,
  pricingRules,
  masterItems,
  defaultDeliveryDate,
  defaultNote,
  existingRecords,
  favoriteClientsStorageKey,
  allItemOptions,
  onSaveClientPricingRule,
  onRemoveClientPricingRule,
  onSaveMasterItem,
  onRemoveMasterItem,
  onCommit,
  onClose,
}: Props) {
  const [deliveryDate, setDeliveryDate] = useState(defaultDeliveryDate)
  const [selectedClient, setSelectedClient] = useState('')
  const [clientSearch, setClientSearch] = useState('')
  const [itemSearch, setItemSearch] = useState('')
  const [note, setNote] = useState(defaultNote)
  const [isCashHandled, setIsCashHandled] = useState(false)
  const [cart, setCart] = useState<PosCartLine[]>([])
  const [activeLineId, setActiveLineId] = useState<string | null>(null)
  const [keypadField, setKeypadField] = useState<KeypadField>('quantity')
  const [customItemDraft, setCustomItemDraft] = useState({
    itemName: '',
    specUnit: '',
    unitPrice: '',
  })
  const [keypadBuffer, setKeypadBuffer] = useState<string | null>(null)
  const [favoriteClients, setFavoriteClients] = useState<string[]>(() =>
    readFavoriteClientsFromStorage(favoriteClientsStorageKey),
  )
  const [posAdminUnlocked, setPosAdminUnlocked] = useState(false)
  const [posLeftView, setPosLeftView] = useState<'catalog' | 'pricing'>('catalog')
  const [posAdminPinOpen, setPosAdminPinOpen] = useState(false)
  const [posAdminPin, setPosAdminPin] = useState('')
  const [posAdminPinError, setPosAdminPinError] = useState('')
  const [posAdminMessage, setPosAdminMessage] = useState('')
  const [posAdminLineDraft, setPosAdminLineDraft] = useState({
    itemName: '',
    specUnit: '',
    unitPrice: '',
  })
  const [posMasterDraft, setPosMasterDraft] = useState({
    itemName: '',
    specUnit: '',
    unitPrice: '',
  })
  const [posMasterOpen, setPosMasterOpen] = useState(false)
  const cartListRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setFavoriteClients(readFavoriteClientsFromStorage(favoriteClientsStorageKey))
  }, [favoriteClientsStorageKey])

  useEffect(() => {
    window.localStorage.setItem(favoriteClientsStorageKey, JSON.stringify(favoriteClients))
  }, [favoriteClients, favoriteClientsStorageKey])

  // 거래처별 단가표 (없으면 마스터)
  const itemCatalogForClient = useMemo(() => {
    const clientKey = normalize(selectedClient)
    const rules = clientKey
      ? pricingRules.filter((rule) => normalize(rule.clientName) === clientKey)
      : []
    const byKey = new Map<
      string,
      { itemName: string; specUnit: string; unitPrice: number; source: 'rule' | 'master' }
    >()
    for (const rule of rules) {
      const key = `${normalize(rule.itemName)}@${normalize(rule.specUnit)}`
      byKey.set(key, {
        itemName: rule.itemName.trim(),
        specUnit: rule.specUnit.trim(),
        unitPrice: rule.unitPrice,
        source: 'rule',
      })
    }
    if (rules.length === 0) {
      for (const master of masterItems) {
        const key = `${normalize(master.itemName)}@${normalize(master.specUnit)}`
        byKey.set(key, {
          itemName: master.itemName.trim(),
          specUnit: master.specUnit.trim(),
          unitPrice: master.unitPrice,
          source: 'master',
        })
      }
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.itemName.localeCompare(b.itemName, 'ko'),
    )
  }, [masterItems, pricingRules, selectedClient])

  const filteredCatalog = useMemo(() => {
    const q = normalize(itemSearch)
    if (!q) return itemCatalogForClient
    return itemCatalogForClient.filter(
      (item) =>
        normalize(item.itemName).includes(q) || normalize(item.specUnit).includes(q),
    )
  }, [itemCatalogForClient, itemSearch])

  const clientDisplayByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const name of clientOptions) {
      const trimmed = name.trim()
      if (trimmed) {
        map.set(normalize(trimmed), trimmed)
      }
    }
    return map
  }, [clientOptions])

  const favoriteSet = useMemo(
    () => new Set(favoriteClients.map((client) => normalize(client))),
    [favoriteClients],
  )

  const favoriteClientsResolved = useMemo(() => {
    const out: string[] = []
    const seen = new Set<string>()
    for (const stored of favoriteClients) {
      const key = normalize(stored)
      if (seen.has(key)) {
        continue
      }
      const display = clientDisplayByKey.get(key) ?? stored.trim()
      if (!display) {
        continue
      }
      seen.add(key)
      out.push(display)
    }
    return out.sort((a, b) => a.localeCompare(b, 'ko'))
  }, [clientDisplayByKey, favoriteClients])

  const recentClients = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - POS_RECENT_DAYS)
    const cutoffIso = cutoff.toISOString().slice(0, 10)
    const seen = new Set<string>()
    const ordered: string[] = []
    const sorted = [...existingRecords].sort((a, b) => {
      const byDate = b.deliveryDate.localeCompare(a.deliveryDate)
      if (byDate !== 0) {
        return byDate
      }
      return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    })
    for (const record of sorted) {
      if (record.deliveryDate < cutoffIso) {
        continue
      }
      const key = normalize(record.clientName)
      if (!key || seen.has(key)) {
        continue
      }
      const display = clientDisplayByKey.get(key) ?? record.clientName.trim()
      if (!display) {
        continue
      }
      seen.add(key)
      ordered.push(display)
      if (ordered.length >= POS_RECENT_MAX) {
        break
      }
    }
    return ordered
  }, [clientDisplayByKey, existingRecords])

  const recentClientsWithoutFavorites = useMemo(
    () => recentClients.filter((name) => !favoriteSet.has(normalize(name))),
    [favoriteSet, recentClients],
  )

  const searchResults = useMemo(() => {
    const q = normalize(clientSearch)
    if (!q) {
      return [] as string[]
    }
    return clientOptions.filter((name) => normalize(name).includes(q)).slice(0, POS_SEARCH_MAX)
  }, [clientOptions, clientSearch])

  const isClientSearchMode = normalize(clientSearch).length > 0

  const toggleFavoriteClient = useCallback((clientName: string) => {
    const key = normalize(clientName)
    setFavoriteClients((current) => {
      if (current.some((client) => normalize(client) === key)) {
        return current.filter((client) => normalize(client) !== key)
      }
      return [...current, clientName.trim()]
    })
  }, [])

  const clientPricingRules = useMemo(() => {
    const clientKey = normalize(selectedClient)
    if (!clientKey) {
      return [] as PosPricingRule[]
    }
    return pricingRules
      .filter((rule) => normalize(rule.clientName) === clientKey)
      .sort((a, b) =>
        `${a.itemName}\u0000${a.specUnit}`.localeCompare(`${b.itemName}\u0000${b.specUnit}`, 'ko'),
      )
  }, [pricingRules, selectedClient])

  const usesMasterCatalogForClient = selectedClient.trim().length > 0 && clientPricingRules.length === 0

  useEffect(() => {
    setPosAdminLineDraft({ itemName: '', specUnit: '', unitPrice: '' })
    setPosAdminMessage('')
  }, [selectedClient])

  const handlePosAdminButtonClick = () => {
    if (posAdminUnlocked) {
      setPosAdminUnlocked(false)
      setPosLeftView('catalog')
      setPosAdminMessage('')
      return
    }
    setPosAdminPin('')
    setPosAdminPinError('')
    setPosAdminPinOpen(true)
  }

  const confirmPosAdminPin = () => {
    if (posAdminPin !== ADMIN_FOUR_DIGIT_PIN) {
      setPosAdminPinError('비밀번호가 올바르지 않습니다.')
      return
    }
    setPosAdminPinOpen(false)
    setPosAdminPin('')
    setPosAdminPinError('')
    setPosAdminUnlocked(true)
    setPosLeftView('pricing')
    setPosAdminMessage('단가 관리 모드입니다. 거래처를 고른 뒤 품목·단가를 추가하세요.')
  }

  const handleSavePosAdminLine = () => {
    if (!selectedClient.trim()) {
      setPosAdminMessage('먼저 거래처를 선택하세요.')
      return
    }
    const result = onSaveClientPricingRule(
      selectedClient,
      posAdminLineDraft.itemName,
      posAdminLineDraft.specUnit,
      posAdminLineDraft.unitPrice,
    )
    setPosAdminMessage(result.message)
    if (result.ok) {
      setPosAdminLineDraft({ itemName: '', specUnit: '', unitPrice: '' })
    }
  }

  const handleSavePosMasterLine = () => {
    const result = onSaveMasterItem(
      posMasterDraft.itemName,
      posMasterDraft.specUnit,
      posMasterDraft.unitPrice,
    )
    setPosAdminMessage(result.message)
    if (result.ok) {
      setPosMasterDraft({ itemName: '', specUnit: '', unitPrice: '' })
    }
  }

  // 거래처 변경 시 카트 초기화 (혼동 방지)
  useEffect(() => {
    setCart([])
    setActiveLineId(null)
    setKeypadBuffer(null)
  }, [selectedClient])

  // 새로 추가된 줄에 활성 포커스
  useEffect(() => {
    if (!activeLineId) return
    const el = cartListRef.current?.querySelector<HTMLElement>(
      `[data-line-id="${activeLineId}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeLineId])

  const totals = useMemo(() => {
    return cart.reduce(
      (acc, line) => {
        const supply = Math.round(line.quantity * line.unitPrice)
        const tax = calcTax(supply, line.note)
        acc.supply += supply
        acc.tax += tax
        acc.total += supply + tax
        acc.qty += line.quantity
        return acc
      },
      { supply: 0, tax: 0, total: 0, qty: 0 },
    )
  }, [cart])

  const addItemToCart = useCallback(
    (catalogItem: { itemName: string; specUnit: string; unitPrice: number; source: 'rule' | 'master' }) => {
      if (!selectedClient.trim()) {
        window.alert('먼저 거래처를 선택하세요.')
        return
      }
      const newId = crypto.randomUUID()
      setCart((current) => {
        // 같은 품목·규격이 이미 있으면 수량만 +1
        const existingIndex = current.findIndex(
          (line) =>
            normalize(line.itemName) === normalize(catalogItem.itemName) &&
            normalize(line.specUnit) === normalize(catalogItem.specUnit),
        )
        if (existingIndex >= 0) {
          const updated = [...current]
          updated[existingIndex] = {
            ...updated[existingIndex],
            quantity: updated[existingIndex].quantity + 1,
          }
          setActiveLineId(updated[existingIndex].id)
          return updated
        }
        const newLine: PosCartLine = {
          id: newId,
          itemName: catalogItem.itemName,
          specUnit: catalogItem.specUnit,
          quantity: 1,
          unitPrice: catalogItem.unitPrice,
          note,
          isCashHandled,
          pricingSource: catalogItem.source,
        }
        setActiveLineId(newId)
        return [...current, newLine]
      })
      setKeypadField('quantity')
      setKeypadBuffer(null)
    },
    [isCashHandled, note, selectedClient],
  )

  const handleAddCustomLine = useCallback(() => {
    if (!selectedClient.trim()) {
      window.alert('먼저 거래처를 선택하세요.')
      return
    }
    const itemName = customItemDraft.itemName.trim()
    if (!itemName) {
      window.alert('품목명을 입력하세요.')
      return
    }
    const unitPrice = Number(customItemDraft.unitPrice.replaceAll(',', '').trim() || '0')
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      window.alert('단가는 0 이상의 숫자만 입력 가능합니다.')
      return
    }
    const newId = crypto.randomUUID()
    setCart((current) => [
      ...current,
      {
        id: newId,
        itemName,
        specUnit: customItemDraft.specUnit.trim(),
        quantity: 1,
        unitPrice,
        note,
        isCashHandled,
        pricingSource: 'manual',
      },
    ])
    setActiveLineId(newId)
    setKeypadField('quantity')
    setKeypadBuffer(null)
    setCustomItemDraft({ itemName: '', specUnit: '', unitPrice: '' })
  }, [customItemDraft, isCashHandled, note, selectedClient])

  const updateLine = useCallback((id: string, patch: Partial<PosCartLine>) => {
    setCart((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    )
  }, [])

  const removeLine = useCallback((id: string) => {
    setCart((current) => current.filter((line) => line.id !== id))
    setActiveLineId((prev) => (prev === id ? null : prev))
    setKeypadBuffer(null)
  }, [])

  const adjustQuantity = useCallback((id: string, delta: number) => {
    setCart((current) =>
      current.map((line) =>
        line.id === id
          ? { ...line, quantity: Math.max(0, Number((line.quantity + delta).toFixed(3))) }
          : line,
      ),
    )
    setKeypadBuffer(null)
  }, [])

  // 키패드 입력
  const handleKeypadInput = useCallback(
    (key: string) => {
      if (!activeLineId) return
      const activeLine = cart.find((line) => line.id === activeLineId)
      if (!activeLine) return

      const currentValue =
        keypadField === 'quantity'
          ? formatDecimal(activeLine.quantity)
          : formatDecimal(activeLine.unitPrice)

      let buffer = keypadBuffer ?? currentValue

      if (key === 'clear') {
        buffer = '0'
      } else if (key === 'back') {
        buffer = buffer.length <= 1 ? '0' : buffer.slice(0, -1)
      } else if (key === '.') {
        if (!buffer.includes('.')) buffer = (buffer || '0') + '.'
      } else if (/^[0-9]$/.test(key)) {
        buffer = buffer === '0' ? key : buffer + key
      } else if (key === '00') {
        buffer = buffer === '0' ? '0' : buffer + '00'
      }

      const numeric = Number(buffer)
      const safe = Number.isFinite(numeric) ? numeric : 0
      updateLine(activeLineId, keypadField === 'quantity' ? { quantity: safe } : { unitPrice: safe })
      setKeypadBuffer(buffer)
    },
    [activeLineId, cart, keypadBuffer, keypadField, updateLine],
  )

  // 활성 줄/필드가 바뀌면 버퍼 초기화 (다음 키 입력 시 덮어쓰기)
  useEffect(() => {
    setKeypadBuffer(null)
  }, [activeLineId, keypadField])

  const handleCommit = useCallback(() => {
    if (!selectedClient.trim()) {
      window.alert('거래처를 선택하세요.')
      return
    }
    if (cart.length === 0) {
      window.alert('장바구니가 비어 있습니다.')
      return
    }
    const validLines = cart.filter((line) => line.quantity > 0 && line.unitPrice >= 0)
    if (validLines.length === 0) {
      window.alert('수량이 0인 줄은 저장할 수 없습니다.')
      return
    }

    const newRecords: PosStatementRecord[] = validLines.map((line) => {
      const supply = Math.round(line.quantity * line.unitPrice)
      const tax = calcTax(supply, line.note)
      return {
        id: crypto.randomUUID(),
        deliveryDate,
        issueDate: '',
        paymentDate: '',
        deliveryCount: '1',
        clientName: selectedClient.trim(),
        itemName: line.itemName,
        specUnit: line.specUnit,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        note: line.note,
        supplyAmount: supply,
        taxAmount: tax,
        totalAmount: supply + tax,
        createdAt: new Date().toISOString(),
        isCashHandled: line.isCashHandled,
      }
    })

    const hasDuplicate = newRecords.some((r) =>
      existingRecords.some(
        (rec) =>
          rec.deliveryDate === r.deliveryDate &&
          normalize(rec.clientName) === normalize(r.clientName) &&
          normalize(rec.itemName) === normalize(r.itemName),
      ),
    )
    if (
      hasDuplicate &&
      !window.confirm('같은 날짜·거래처에 동일 품목이 이미 있습니다. 그래도 저장할까요?')
    ) {
      return
    }

    onCommit(newRecords)
    setCart([])
    setActiveLineId(null)
    setKeypadBuffer(null)
  }, [cart, deliveryDate, existingRecords, onCommit, selectedClient])

  const handleTaxToggle = useCallback(() => {
    const next = isTaxFreeNote(note) ? '부가세 별도' : '부가세 없음'
    setNote(next)
    setCart((current) => current.map((line) => ({ ...line, note: next })))
  }, [note])

  const handleCashToggle = useCallback(() => {
    setIsCashHandled((current) => {
      const next = !current
      setCart((lines) => lines.map((line) => ({ ...line, isCashHandled: next })))
      return next
    })
  }, [])

  const activeLine = cart.find((line) => line.id === activeLineId) ?? null
  const isTaxSeparate = !isTaxFreeNote(note)
  const checkoutDisabled = cart.length === 0

  const renderClientChip = (client: string) => {
    const isSelected = normalize(client) === normalize(selectedClient)
    const isFavorite = favoriteSet.has(normalize(client))
    return (
      <div key={client} className="pos-client-chip-wrap">
        <button
          type="button"
          className={`pos-client-chip${isSelected ? ' pos-client-chip--on' : ''}`}
          onClick={() => setSelectedClient(client)}
        >
          {client}
        </button>
        <button
          type="button"
          className={`pos-client-fav${isFavorite ? ' pos-client-fav--on' : ''}`}
          aria-label={isFavorite ? `${client} 즐겨찾기 해제` : `${client} 즐겨찾기`}
          title={isFavorite ? '즐겨찾기 해제' : '즐겨찾기'}
          onClick={() => toggleFavoriteClient(client)}
        >
          ★
        </button>
      </div>
    )
  }

  return (
    <div className="pos-entry-panel">
      <div className="pos-entry-topbar">
        <label className="pos-field">
          <span>납품일</span>
          <input
            type="date"
            value={deliveryDate}
            onChange={(event) => setDeliveryDate(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={`pos-toggle pos-toggle--admin${posAdminUnlocked ? ' pos-toggle--on' : ''}`}
          aria-pressed={posAdminUnlocked}
          onClick={handlePosAdminButtonClick}
        >
          관리자 {posAdminUnlocked ? 'ON' : ''}
        </button>
        <button type="button" className="pos-topbar-close" onClick={onClose}>
          닫기
        </button>
      </div>

      <div className="pos-entry-body">
        <div className="pos-entry-left">
          <div className="pos-client-bar pos-client-bar--structured">
            <input
              type="search"
              className="pos-search pos-search--full"
              placeholder="거래처 검색 (이름 일부 입력)"
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
            />
            {isClientSearchMode ? (
              <div className="pos-client-section">
                <div className="pos-client-section-label">검색 결과</div>
                <div className="pos-client-chips">
                  {searchResults.length === 0 ? (
                    <span className="pos-empty">일치하는 거래처가 없습니다.</span>
                  ) : (
                    searchResults.map((client) => renderClientChip(client))
                  )}
                </div>
              </div>
            ) : (
              <div className="pos-client-sections">
                {favoriteClientsResolved.length > 0 ? (
                  <div className="pos-client-section">
                    <div className="pos-client-section-label">즐겨찾기</div>
                    <div className="pos-client-chips">
                      {favoriteClientsResolved.map((client) => renderClientChip(client))}
                    </div>
                  </div>
                ) : null}
                {recentClientsWithoutFavorites.length > 0 ? (
                  <div className="pos-client-section">
                    <div className="pos-client-section-label">최근 {POS_RECENT_DAYS}일</div>
                    <div className="pos-client-chips">
                      {recentClientsWithoutFavorites.map((client) => renderClientChip(client))}
                    </div>
                  </div>
                ) : null}
                {favoriteClientsResolved.length === 0 && recentClientsWithoutFavorites.length === 0 ? (
                  <p className="pos-client-hint">
                    즐겨찾기(★)로 자주 쓰는 거래처를 고정하거나, 이름을 검색해 선택하세요. 납품 기록이 쌓이면
                    최근 거래처도 여기에 표시됩니다.
                  </p>
                ) : (
                  <p className="pos-client-hint pos-client-hint--compact">
                    그 외 거래처는 위 검색창에서 찾을 수 있습니다.
                  </p>
                )}
              </div>
            )}
          </div>

          {posAdminUnlocked ? (
            <div className="pos-admin-view-toggle" role="tablist" aria-label="POS 좌측 화면">
              <button
                type="button"
                role="tab"
                aria-selected={posLeftView === 'catalog'}
                className={posLeftView === 'catalog' ? 'is-active' : ''}
                onClick={() => setPosLeftView('catalog')}
              >
                품목 입력
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={posLeftView === 'pricing'}
                className={posLeftView === 'pricing' ? 'is-active' : ''}
                onClick={() => setPosLeftView('pricing')}
              >
                단가 관리
              </button>
            </div>
          ) : null}

          {posAdminUnlocked && posLeftView === 'pricing' ? (
            <div className="pos-admin-panel">
              {!selectedClient.trim() ? (
                <p className="pos-empty pos-empty--block">단가를 관리할 거래처를 먼저 선택하세요.</p>
              ) : (
                <>
                  <div className="pos-admin-panel-head">
                    <div>
                      <strong>{selectedClient}</strong>
                      <span className="pos-admin-panel-sub">
                        {usesMasterCatalogForClient
                          ? '전용 단가 없음 · 공통 마스터 품목이 표시됩니다'
                          : `거래처 전용 단가 ${clientPricingRules.length}건`}
                      </span>
                    </div>
                  </div>
                  {posAdminMessage ? <p className="pos-admin-status">{posAdminMessage}</p> : null}
                  <div className="pos-admin-table-wrap">
                    <table className="pos-admin-table">
                      <thead>
                        <tr>
                          <th>품목</th>
                          <th>규격/단위</th>
                          <th>단가</th>
                          <th aria-label="관리" />
                        </tr>
                      </thead>
                      <tbody>
                        {clientPricingRules.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="pos-admin-empty-cell">
                              아래에서 품목·단가를 추가하면 이 거래처 POS 카탈로그에 바로 반영됩니다.
                            </td>
                          </tr>
                        ) : (
                          clientPricingRules.map((rule) => (
                            <tr key={rule.id}>
                              <td>{rule.itemName}</td>
                              <td>{rule.specUnit || '-'}</td>
                              <td>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  className="pos-admin-inline-input"
                                  defaultValue={String(rule.unitPrice)}
                                  onBlur={(event) => {
                                    const next = event.target.value.trim()
                                    if (next === String(rule.unitPrice)) {
                                      return
                                    }
                                    const result = onSaveClientPricingRule(
                                      selectedClient,
                                      rule.itemName,
                                      rule.specUnit,
                                      next,
                                    )
                                    setPosAdminMessage(result.message)
                                  }}
                                  onKeyDown={(event) => {
                                    if (event.key === 'Enter') {
                                      ;(event.target as HTMLInputElement).blur()
                                    }
                                  }}
                                  aria-label={`${rule.itemName} 단가`}
                                />
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="ghost-button small danger"
                                  onClick={() => onRemoveClientPricingRule(rule.id)}
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
                  <div className="pos-admin-add-row">
                    <input
                      type="text"
                      list="pos-admin-item-datalist"
                      placeholder="품목 (목록 또는 직접)"
                      value={posAdminLineDraft.itemName}
                      onChange={(event) =>
                        setPosAdminLineDraft((current) => ({ ...current, itemName: event.target.value }))
                      }
                    />
                    <input
                      type="text"
                      placeholder="규격/단위"
                      value={posAdminLineDraft.specUnit}
                      onChange={(event) =>
                        setPosAdminLineDraft((current) => ({ ...current, specUnit: event.target.value }))
                      }
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="단가 (원)"
                      value={posAdminLineDraft.unitPrice}
                      onChange={(event) =>
                        setPosAdminLineDraft((current) => ({ ...current, unitPrice: event.target.value }))
                      }
                    />
                    <button type="button" className="primary-button" onClick={handleSavePosAdminLine}>
                      품목 추가
                    </button>
                  </div>
                  <datalist id="pos-admin-item-datalist">
                    {allItemOptions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                  <details
                    className="pos-admin-master"
                    open={posMasterOpen}
                    onToggle={(event) => setPosMasterOpen((event.target as HTMLDetailsElement).open)}
                  >
                    <summary>공통 품목 마스터 ({masterItems.length}건)</summary>
                    <p className="pos-admin-master-hint">
                      거래처 전용 단가가 없을 때만 POS에 표시됩니다. 모든 거래처에 공통으로 쓰는 품목·단가를
                      관리합니다.
                    </p>
                    <div className="pos-admin-add-row">
                      <input
                        type="text"
                        placeholder="품목명"
                        value={posMasterDraft.itemName}
                        onChange={(event) =>
                          setPosMasterDraft((current) => ({ ...current, itemName: event.target.value }))
                        }
                      />
                      <input
                        type="text"
                        placeholder="규격/단위"
                        value={posMasterDraft.specUnit}
                        onChange={(event) =>
                          setPosMasterDraft((current) => ({ ...current, specUnit: event.target.value }))
                        }
                      />
                      <input
                        type="text"
                        inputMode="numeric"
                        placeholder="단가 (원)"
                        value={posMasterDraft.unitPrice}
                        onChange={(event) =>
                          setPosMasterDraft((current) => ({ ...current, unitPrice: event.target.value }))
                        }
                      />
                      <button type="button" className="primary-button" onClick={handleSavePosMasterLine}>
                        마스터 추가/수정
                      </button>
                    </div>
                    <div className="pos-admin-table-wrap pos-admin-table-wrap--compact">
                      <table className="pos-admin-table">
                        <thead>
                          <tr>
                            <th>품목</th>
                            <th>규격/단위</th>
                            <th>단가</th>
                            <th aria-label="관리" />
                          </tr>
                        </thead>
                        <tbody>
                          {masterItems.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="pos-admin-empty-cell">
                                등록된 공통 품목이 없습니다.
                              </td>
                            </tr>
                          ) : (
                            masterItems.map((item) => (
                              <tr key={item.id}>
                                <td>{item.itemName}</td>
                                <td>{item.specUnit || '-'}</td>
                                <td>{formatNumber(item.unitPrice)}원</td>
                                <td>
                                  <button
                                    type="button"
                                    className="ghost-button small"
                                    onClick={() => {
                                      setPosMasterDraft({
                                        itemName: item.itemName,
                                        specUnit: item.specUnit,
                                        unitPrice: String(item.unitPrice),
                                      })
                                      setPosMasterOpen(true)
                                    }}
                                  >
                                    불러오기
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost-button small danger"
                                    onClick={() => onRemoveMasterItem(item.id)}
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
                  </details>
                </>
              )}
            </div>
          ) : (
            <>
          <div className="pos-item-toolbar">
            <input
              type="search"
              className="pos-search"
              placeholder="품목 검색"
              value={itemSearch}
              onChange={(event) => setItemSearch(event.target.value)}
            />
            <span className="pos-item-count">
              {selectedClient
                ? `${filteredCatalog.length}건${
                    itemCatalogForClient.length > 0 && itemCatalogForClient[0]
                      ? itemCatalogForClient[0].source === 'master'
                        ? ' (공통 마스터)'
                        : ' (거래처 단가)'
                      : ''
                  }`
                : '거래처 선택 시 품목 표시'}
            </span>
          </div>

          <div className="pos-item-grid">
            {!selectedClient ? (
              <div className="pos-empty pos-empty--block">먼저 거래처를 선택하세요.</div>
            ) : filteredCatalog.length === 0 ? (
              <div className="pos-empty pos-empty--block">
                등록된 품목이 없습니다. 상단 「관리자」→「단가 관리」에서 품목을 추가하거나, 아래 직접 추가를
                사용하세요.
              </div>
            ) : (
              filteredCatalog.map((item) => (
                <button
                  key={`${item.itemName}@${item.specUnit}`}
                  type="button"
                  className="pos-item-card"
                  onClick={() => addItemToCart(item)}
                  title="탭하면 장바구니에 추가됩니다"
                >
                  <span className="pos-item-card-name">{item.itemName}</span>
                  <span className="pos-item-card-spec">{item.specUnit || '-'}</span>
                  <span className="pos-item-card-price">
                    {formatNumber(item.unitPrice)}원
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="pos-custom-row">
            <input
              type="text"
              placeholder="직접 추가: 품목"
              value={customItemDraft.itemName}
              onChange={(event) =>
                setCustomItemDraft((c) => ({ ...c, itemName: event.target.value }))
              }
            />
            <input
              type="text"
              placeholder="규격"
              value={customItemDraft.specUnit}
              onChange={(event) =>
                setCustomItemDraft((c) => ({ ...c, specUnit: event.target.value }))
              }
            />
            <input
              type="text"
              inputMode="numeric"
              placeholder="단가"
              value={customItemDraft.unitPrice}
              onChange={(event) =>
                setCustomItemDraft((c) => ({ ...c, unitPrice: event.target.value }))
              }
            />
            <button type="button" className="pos-custom-add" onClick={handleAddCustomLine}>
              + 줄 추가
            </button>
          </div>
            </>
          )}
        </div>

        <div className="pos-entry-right">
          <div className="pos-cart-header">
            <strong>장바구니</strong>
            <span className="pos-cart-client">
              {selectedClient ? (
                <>
                  {selectedClient}
                  <button
                    type="button"
                    className={`pos-client-fav pos-client-fav--inline${
                      favoriteSet.has(normalize(selectedClient)) ? ' pos-client-fav--on' : ''
                    }`}
                    aria-label={
                      favoriteSet.has(normalize(selectedClient))
                        ? `${selectedClient} 즐겨찾기 해제`
                        : `${selectedClient} 즐겨찾기`
                    }
                    title={
                      favoriteSet.has(normalize(selectedClient)) ? '즐겨찾기 해제' : '즐겨찾기에 추가'
                    }
                    onClick={() => toggleFavoriteClient(selectedClient)}
                  >
                    ★
                  </button>
                </>
              ) : (
                '거래처 미선택'
              )}
            </span>
          </div>
          <div className="pos-cart-list" ref={cartListRef}>
            {cart.length === 0 ? (
              <div className="pos-empty pos-empty--block">좌측 품목을 탭해 담아보세요.</div>
            ) : (
              cart.map((line) => {
                const supply = Math.round(line.quantity * line.unitPrice)
                const tax = calcTax(supply, line.note)
                const total = supply + tax
                const isActive = line.id === activeLineId
                return (
                  <div
                    key={line.id}
                    data-line-id={line.id}
                    className={`pos-cart-line ${isActive ? 'pos-cart-line--active' : ''}`}
                    onClick={() => setActiveLineId(line.id)}
                  >
                    <div className="pos-cart-line-main">
                      <span className="pos-cart-line-name">{line.itemName}</span>
                      <span className="pos-cart-line-spec">{line.specUnit || '-'}</span>
                    </div>
                    <div className="pos-cart-line-qty">
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          adjustQuantity(line.id, -1)
                        }}
                      >
                        −
                      </button>
                      <button
                        type="button"
                        className={`pos-cart-line-qty-display ${
                          isActive && keypadField === 'quantity' ? 'pos-cart-line-focus' : ''
                        }`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setActiveLineId(line.id)
                          setKeypadField('quantity')
                        }}
                      >
                        {formatDecimal(line.quantity)}
                      </button>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          adjustQuantity(line.id, 1)
                        }}
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      className={`pos-cart-line-price ${
                        isActive && keypadField === 'unitPrice' ? 'pos-cart-line-focus' : ''
                      }`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setActiveLineId(line.id)
                        setKeypadField('unitPrice')
                      }}
                    >
                      {formatNumber(line.unitPrice)}원
                    </button>
                    <span className="pos-cart-line-total">{formatNumber(total)}원</span>
                    <button
                      type="button"
                      className="pos-cart-line-remove"
                      onClick={(event) => {
                        event.stopPropagation()
                        removeLine(line.id)
                      }}
                      aria-label="줄 삭제"
                    >
                      ×
                    </button>
                  </div>
                )
              })
            )}
          </div>

          <div className="pos-cart-summary">
            <div>
              <span>품목수</span>
              <strong>{cart.length}건</strong>
            </div>
            <div>
              <span>수량</span>
              <strong>{formatDecimal(totals.qty)}</strong>
            </div>
            <div>
              <span>공급가</span>
              <strong>{formatNumber(totals.supply)}원</strong>
            </div>
            <div>
              <span>세액</span>
              <strong>{formatNumber(totals.tax)}원</strong>
            </div>
            <div className="pos-cart-summary-total">
              <span>합계</span>
              <strong>{formatNumber(totals.total)}원</strong>
            </div>
          </div>

          <div className="pos-keypad-wrap">
            <div className="pos-keypad-mode">
              <button
                type="button"
                className={keypadField === 'quantity' ? 'on' : ''}
                onClick={() => setKeypadField('quantity')}
                disabled={!activeLine}
              >
                수량
              </button>
              <button
                type="button"
                className={keypadField === 'unitPrice' ? 'on' : ''}
                onClick={() => setKeypadField('unitPrice')}
                disabled={!activeLine}
              >
                단가
              </button>
              <span className="pos-keypad-target">
                {activeLine
                  ? `${activeLine.itemName} → ${
                      keypadField === 'quantity'
                        ? formatDecimal(activeLine.quantity)
                        : `${formatNumber(activeLine.unitPrice)}원`
                    }`
                  : '줄을 선택하세요'}
              </span>
            </div>
            <div className="pos-keypad-grid">
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('7')}>
                7
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('8')}>
                8
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('9')}>
                9
              </button>
              <button
                type="button"
                className="pos-keypad-action pos-keypad-back"
                disabled={!activeLine}
                onClick={() => handleKeypadInput('back')}
              >
                ⌫
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('4')}>
                4
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('5')}>
                5
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('6')}>
                6
              </button>
              <button
                type="button"
                className="pos-keypad-action pos-keypad-clear"
                disabled={!activeLine}
                onClick={() => handleKeypadInput('clear')}
              >
                C
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('1')}>
                1
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('2')}>
                2
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('3')}>
                3
              </button>
              <button
                type="button"
                className={`pos-keypad-option${isTaxSeparate ? ' pos-keypad-option--on' : ''}`}
                disabled={checkoutDisabled}
                aria-pressed={isTaxSeparate}
                onClick={handleTaxToggle}
              >
                부가세 별도
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('.')}>
                .
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('0')}>
                0
              </button>
              <button type="button" disabled={!activeLine} onClick={() => handleKeypadInput('00')}>
                00
              </button>
              <button
                type="button"
                className={`pos-keypad-option${isCashHandled ? ' pos-keypad-option--on' : ''}`}
                disabled={checkoutDisabled}
                aria-pressed={isCashHandled}
                onClick={handleCashToggle}
              >
                현금
              </button>
            </div>
          </div>

          <button
            type="button"
            className="pos-commit"
            onClick={handleCommit}
            disabled={cart.length === 0 || !selectedClient}
          >
            입력 목록에 저장 ({cart.length}건)
          </button>
        </div>
      </div>

      {posAdminPinOpen ? (
        <div
          className="pos-admin-pin-backdrop"
          role="presentation"
          onClick={() => setPosAdminPinOpen(false)}
        >
          <div
            className="pos-admin-pin-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pos-admin-pin-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="pos-admin-pin-title">POS 관리자 모드</h3>
            <p>거래처별 품목·단가를 관리하려면 4자리 비밀번호를 입력하세요.</p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoFocus
              value={posAdminPin}
              onChange={(event) => {
                setPosAdminPin(event.target.value.replace(/\D/g, '').slice(0, 4))
                setPosAdminPinError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  confirmPosAdminPin()
                }
              }}
              aria-label="관리자 비밀번호 4자리"
            />
            {posAdminPinError ? <p className="pos-admin-pin-error">{posAdminPinError}</p> : null}
            <div className="pos-admin-pin-actions">
              <button type="button" className="ghost-button" onClick={() => setPosAdminPinOpen(false)}>
                취소
              </button>
              <button type="button" className="primary-button" onClick={confirmPosAdminPin}>
                확인
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default StatementPosEntryPanel
