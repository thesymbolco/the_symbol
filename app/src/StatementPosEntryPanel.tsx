import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

type Props = {
  clientOptions: string[]
  pricingRules: PosPricingRule[]
  masterItems: PosMasterItem[]
  defaultDeliveryDate: string
  defaultNote: string
  noteOptions: readonly string[]
  existingRecords: PosStatementRecord[]
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

function StatementPosEntryPanel({
  clientOptions,
  pricingRules,
  masterItems,
  defaultDeliveryDate,
  defaultNote,
  noteOptions,
  existingRecords,
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
  const cartListRef = useRef<HTMLDivElement | null>(null)

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

  const filteredClients = useMemo(() => {
    const q = normalize(clientSearch)
    if (!q) return clientOptions
    return clientOptions.filter((name) => normalize(name).includes(q))
  }, [clientOptions, clientSearch])

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
            normalize(line.specUnit) === normalize(catalogItem.specUnit) &&
            line.note === note &&
            line.isCashHandled === isCashHandled,
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

  const activeLine = cart.find((line) => line.id === activeLineId) ?? null

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
        <label className="pos-field pos-field--note">
          <span>과세</span>
          <select value={note} onChange={(event) => setNote(event.target.value)}>
            {noteOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`pos-toggle ${isCashHandled ? 'pos-toggle--on' : ''}`}
          aria-pressed={isCashHandled}
          onClick={() => setIsCashHandled((v) => !v)}
        >
          현금 {isCashHandled ? 'ON' : 'OFF'}
        </button>
        <button type="button" className="pos-topbar-close" onClick={onClose}>
          닫기
        </button>
      </div>

      <div className="pos-entry-body">
        <div className="pos-entry-left">
          <div className="pos-client-bar">
            <input
              type="search"
              className="pos-search"
              placeholder="거래처 검색"
              value={clientSearch}
              onChange={(event) => setClientSearch(event.target.value)}
            />
            <div className="pos-client-chips">
              {filteredClients.length === 0 ? (
                <span className="pos-empty">일치하는 거래처가 없습니다.</span>
              ) : (
                filteredClients.map((client) => (
                  <button
                    key={client}
                    type="button"
                    className={`pos-client-chip ${
                      normalize(client) === normalize(selectedClient) ? 'pos-client-chip--on' : ''
                    }`}
                    onClick={() => setSelectedClient(client)}
                  >
                    {client}
                  </button>
                ))
              )}
            </div>
          </div>

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
                등록된 품목이 없습니다. 우측 「직접 추가」로 입력하세요.
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
        </div>

        <div className="pos-entry-right">
          <div className="pos-cart-header">
            <strong>장바구니</strong>
            <span>{selectedClient || '거래처 미선택'}</span>
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
              {['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '00'].map((key) => (
                <button
                  key={key}
                  type="button"
                  disabled={!activeLine}
                  onClick={() => handleKeypadInput(key)}
                >
                  {key}
                </button>
              ))}
              <button
                type="button"
                className="pos-keypad-back"
                disabled={!activeLine}
                onClick={() => handleKeypadInput('back')}
              >
                ←
              </button>
              <button
                type="button"
                className="pos-keypad-clear"
                disabled={!activeLine}
                onClick={() => handleKeypadInput('clear')}
              >
                C
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
    </div>
  )
}

export default StatementPosEntryPanel
