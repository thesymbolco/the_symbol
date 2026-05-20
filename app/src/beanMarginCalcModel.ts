/** 원두별_마진_계산.xlsx — 운영경비·블렌딩·마진 시트 수식을 코드로 재현 */

export type BeanMarginOperatingInputs = {
  bag1kg: number
  bag200g: number
  label1kg: number
  label200g: number
  sticker1kg: number
  sticker200g: number
  fillMinutes1kg: number
  fillMinutes200g: number
  hourlyWage: number
  reserve1kg: number
  reserve200g: number
  shippingPerOrder: number
  packsPerOrder1kg: number
  packsPerOrder200g: number
  monthlyFixed: number
  monthlySalesKg: number
  /** 200g 배송 안분 직접 입력(엑셀 C19). null이면 B17/C18 수식 */
  shippingOverride200g: number | null
}

export type BeanMarginBlendComponent = {
  productId: string
  label: string
  ratio: number
}

export type BeanMarginBlendRecipe = {
  id: 'dark' | 'light'
  title: string
  components: BeanMarginBlendComponent[]
}

export type BeanMarginProduct = {
  id: string
  name: string
  kind: 'single' | 'blend'
  blendRecipeId?: 'dark' | 'light'
  /** 싱글 오리진만 입력(원/kg). 블렌드는 레시피로 계산 */
  greenWonPerKg: number
  /** null = 제안판매가(천·오백원 단위 반올림) 자동 */
  salePrice1kg: number | null
  salePrice200g: number | null
}

export type BeanMarginSettings = {
  roastLossRate: number
  targetMarginRate: number
}

export type BeanMarginCalcState = {
  settings: BeanMarginSettings
  operating: BeanMarginOperatingInputs
  blends: BeanMarginBlendRecipe[]
  products: BeanMarginProduct[]
}

export const BEAN_MARGIN_CALC_STORAGE_KEY = 'bean-margin-calc-v1'

export const DEFAULT_BEAN_MARGIN_STATE: BeanMarginCalcState = {
  settings: {
    roastLossRate: 0.2,
    targetMarginRate: 0.4,
  },
  operating: {
    bag1kg: 2000,
    bag200g: 900,
    label1kg: 800,
    label200g: 700,
    sticker1kg: 200,
    sticker200g: 200,
    fillMinutes1kg: 2,
    fillMinutes200g: 2.5,
    hourlyWage: 12000,
    reserve1kg: 200,
    reserve200g: 150,
    shippingPerOrder: 3500,
    packsPerOrder1kg: 2.5,
    packsPerOrder200g: 5,
    monthlyFixed: 0,
    monthlySalesKg: 200,
    shippingOverride200g: null,
  },
  blends: [
    {
      id: 'dark',
      title: '블렌딩 다크 (세라도:시다모:나리노=3:1:1)',
      components: [
        { productId: 'brazil-cerrado', label: '브라질 세라도', ratio: 3 },
        { productId: 'ethiopia-sidamo-g4', label: '에티오피아 시다모 G4', ratio: 1 },
        { productId: 'colombia-narino', label: '콜롬비아 나리노 수프리모', ratio: 1 },
      ],
    },
    {
      id: 'light',
      title: '블렌딩 라이트 (예가체프:시다모:나리노=1:1:2)',
      components: [
        { productId: 'ethiopia-yirgacheffe-g2', label: '에티오피아 예가체프 G2', ratio: 1 },
        { productId: 'ethiopia-sidamo-g4', label: '에티오피아 시다모 G4', ratio: 1 },
        { productId: 'colombia-narino', label: '콜롬비아 나리노 수프리모', ratio: 2 },
      ],
    },
  ],
  products: [
    { id: 'ethiopia-koke-honey-g1', name: '에티오피아 코케허니 예가체프 G1', kind: 'single', greenWonPerKg: 22400, salePrice1kg: null, salePrice200g: null },
    { id: 'ethiopia-yirgacheffe-g2', name: '에티오피아 예가체프 G2', kind: 'single', greenWonPerKg: 16900, salePrice1kg: null, salePrice200g: null },
    { id: 'ethiopia-momora-guji-g1', name: '에티오피아 모모라 워시드 구지 G1', kind: 'single', greenWonPerKg: 23000, salePrice1kg: null, salePrice200g: null },
    { id: 'kenya-aa-faq', name: '케냐 AA FAQ', kind: 'single', greenWonPerKg: 16800, salePrice1kg: null, salePrice200g: null },
    { id: 'indonesia-aceh-gayo-g1', name: '인도네시아 아체가요 G1', kind: 'single', greenWonPerKg: 18600, salePrice1kg: null, salePrice200g: null },
    { id: 'indonesia-mandheling-g1', name: '인도네시아 만델링 G1', kind: 'single', greenWonPerKg: 15800, salePrice1kg: null, salePrice200g: null },
    { id: 'guatemala-antigua-shb', name: '과테말라 안티구아 SHB', kind: 'single', greenWonPerKg: 16000, salePrice1kg: null, salePrice200g: null },
    { id: 'brazil-cerrado', name: '브라질 세라도', kind: 'single', greenWonPerKg: 13000, salePrice1kg: null, salePrice200g: null },
    { id: 'colombia-narino', name: '콜롬비아 나리노 수프리모', kind: 'single', greenWonPerKg: 15600, salePrice1kg: null, salePrice200g: null },
    { id: 'guatemala-antigua-decaf', name: '과테말라 안티구아 디카페인', kind: 'single', greenWonPerKg: 25000, salePrice1kg: null, salePrice200g: null },
    { id: 'brazil-sugarcane-decaf', name: '브라질 슈가케인 디카페인', kind: 'single', greenWonPerKg: 22000, salePrice1kg: null, salePrice200g: null },
    { id: 'ethiopia-sidamo-g4', name: '에티오피아 시다모 G4', kind: 'single', greenWonPerKg: 13500, salePrice1kg: null, salePrice200g: null },
    {
      id: 'blend-dark',
      name: '블렌딩 다크 (세라도:시다모:나리노=3:1:1)',
      kind: 'blend',
      blendRecipeId: 'dark',
      greenWonPerKg: 0,
      salePrice1kg: null,
      salePrice200g: null,
    },
    {
      id: 'blend-light',
      name: '블렌딩 라이트 (예가체프:시다모:나리노=1:1:2)',
      kind: 'blend',
      blendRecipeId: 'light',
      greenWonPerKg: 0,
      salePrice1kg: null,
      salePrice200g: null,
    },
  ],
}

export type BeanMarginOperatingTotals = {
  packaging1kg: number
  packaging200g: number
  labor1kg: number
  labor200g: number
  shipping1kg: number
  shipping200g: number
  fixed1kg: number
  fixed200g: number
  total1kg: number
  total200g: number
}

export type BeanMarginProductRow = {
  productId: string
  name: string
  kind: 'single' | 'blend'
  greenWonPerKg: number
  beanCost1kg: number
  beanCost200g: number
  opex1kg: number
  opex200g: number
  suggested1kg: number
  suggested200g: number
  sale1kg: number
  sale200g: number
  sale1kgIsAuto: boolean
  sale200gIsAuto: boolean
  marginAmount1kg: number
  marginAmount200g: number
  marginRate1kg: number | null
  marginRate200g: number | null
}

const safeDiv = (num: number, den: number): number => (den === 0 ? 0 : num / den)

/** 엑셀 ROUND(value/unit,0)*unit */
export const roundSalePrice1kg = (value: number): number => Math.round(value / 1000) * 1000
export const roundSalePrice200g = (value: number): number => Math.round(value / 500) * 500

export function computeOperatingTotals(op: BeanMarginOperatingInputs): BeanMarginOperatingTotals {
  const packaging1kg = op.bag1kg + op.label1kg + op.sticker1kg
  const packaging200g = op.bag200g + op.label200g + op.sticker200g
  const labor1kg = (op.fillMinutes1kg / 60) * op.hourlyWage
  const labor200g = (op.fillMinutes200g / 60) * op.hourlyWage
  const shipping1kg = safeDiv(op.shippingPerOrder, op.packsPerOrder1kg)
  const shipping200g =
    op.shippingOverride200g != null
      ? op.shippingOverride200g
      : safeDiv(op.shippingPerOrder, op.packsPerOrder200g)
  const fixed1kg = safeDiv(op.monthlyFixed, op.monthlySalesKg)
  const fixed200g = op.monthlySalesKg === 0 ? 0 : (op.monthlyFixed / op.monthlySalesKg) * 0.2
  const total1kg = packaging1kg + labor1kg + op.reserve1kg + shipping1kg + fixed1kg
  const total200g = packaging200g + labor200g + op.reserve200g + shipping200g + fixed200g
  return {
    packaging1kg,
    packaging200g,
    labor1kg,
    labor200g,
    shipping1kg,
    shipping200g,
    fixed1kg,
    fixed200g,
    total1kg,
    total200g,
  }
}

export function computeBlendGreenPrice(
  recipe: BeanMarginBlendRecipe,
  greenByProductId: ReadonlyMap<string, number>,
): number | null {
  const sumRatio = recipe.components.reduce((s, c) => s + Math.max(0, c.ratio), 0)
  if (sumRatio <= 0) {
    return null
  }
  let weighted = 0
  for (const c of recipe.components) {
    const g = greenByProductId.get(c.productId)
    if (g == null || !Number.isFinite(g)) {
      return null
    }
    weighted += c.ratio * g
  }
  return weighted / sumRatio
}

export function buildGreenPriceMap(state: BeanMarginCalcState): Map<string, number> {
  const singles = new Map<string, number>()
  for (const p of state.products) {
    if (p.kind === 'single') {
      singles.set(p.id, p.greenWonPerKg)
    }
  }
  for (const p of state.products) {
    if (p.kind !== 'blend' || !p.blendRecipeId) {
      continue
    }
    const recipe = state.blends.find((b) => b.id === p.blendRecipeId)
    if (!recipe) {
      continue
    }
    const price = computeBlendGreenPrice(recipe, singles)
    if (price != null) {
      singles.set(p.id, price)
    }
  }
  return singles
}

export function computeBeanMarginRows(state: BeanMarginCalcState): {
  settings: BeanMarginSettings & { greenMultiplier: number }
  operating: BeanMarginOperatingTotals
  rows: BeanMarginProductRow[]
  avgMarginRate1kg: number | null
  avgMarginRate200g: number | null
} {
  const { settings, operating, products } = state
  const loss = settings.roastLossRate
  const denom = 1 - loss
  const greenMultiplier = denom > 0 ? 1 / denom : 0
  const opex = computeOperatingTotals(operating)
  const greenMap = buildGreenPriceMap(state)
  const target = settings.targetMarginRate
  const priceDenom = 1 - target

  const rows: BeanMarginProductRow[] = products.map((p) => {
    const green = greenMap.get(p.id) ?? (p.kind === 'single' ? p.greenWonPerKg : 0)
    const beanCost1kg = green * greenMultiplier
    const beanCost200g = green * 0.2 * greenMultiplier
    const opex1kg = opex.total1kg
    const opex200g = opex.total200g
    const suggested1kg = priceDenom > 0 ? (beanCost1kg + opex1kg) / priceDenom : 0
    const suggested200g = priceDenom > 0 ? (beanCost200g + opex200g) / priceDenom : 0
    const autoSale1kg = roundSalePrice1kg(suggested1kg)
    const autoSale200g = roundSalePrice200g(suggested200g)
    const sale1kg = p.salePrice1kg ?? autoSale1kg
    const sale200g = p.salePrice200g ?? autoSale200g
    const marginAmount1kg = sale1kg - beanCost1kg - opex1kg
    const marginAmount200g = sale200g - beanCost200g - opex200g
    const marginRate1kg = sale1kg === 0 ? null : marginAmount1kg / sale1kg
    const marginRate200g = sale200g === 0 ? null : marginAmount200g / sale200g
    return {
      productId: p.id,
      name: p.name,
      kind: p.kind,
      greenWonPerKg: green,
      beanCost1kg,
      beanCost200g,
      opex1kg,
      opex200g,
      suggested1kg,
      suggested200g,
      sale1kg,
      sale200g,
      sale1kgIsAuto: p.salePrice1kg == null,
      sale200gIsAuto: p.salePrice200g == null,
      marginAmount1kg,
      marginAmount200g,
      marginRate1kg,
      marginRate200g,
    }
  })

  const rates1kg = rows.map((r) => r.marginRate1kg).filter((v): v is number => v != null)
  const rates200g = rows.map((r) => r.marginRate200g).filter((v): v is number => v != null)
  const avg = (vals: number[]) => (vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0) / vals.length)

  return {
    settings: { ...settings, greenMultiplier },
    operating: opex,
    rows,
    avgMarginRate1kg: avg(rates1kg),
    avgMarginRate200g: avg(rates200g),
  }
}

export function normalizeBeanMarginState(raw: unknown): BeanMarginCalcState {
  const base = DEFAULT_BEAN_MARGIN_STATE
  if (!raw || typeof raw !== 'object') {
    return base
  }
  const src = raw as Partial<BeanMarginCalcState>
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback
  const settings = {
    roastLossRate: num(src.settings?.roastLossRate, base.settings.roastLossRate),
    targetMarginRate: num(src.settings?.targetMarginRate, base.settings.targetMarginRate),
  }
  const opSrc: Partial<BeanMarginOperatingInputs> = src.operating ?? {}
  const operating: BeanMarginOperatingInputs = {
    bag1kg: num(opSrc.bag1kg, base.operating.bag1kg),
    bag200g: num(opSrc.bag200g, base.operating.bag200g),
    label1kg: num(opSrc.label1kg, base.operating.label1kg),
    label200g: num(opSrc.label200g, base.operating.label200g),
    sticker1kg: num(opSrc.sticker1kg, base.operating.sticker1kg),
    sticker200g: num(opSrc.sticker200g, base.operating.sticker200g),
    fillMinutes1kg: num(opSrc.fillMinutes1kg, base.operating.fillMinutes1kg),
    fillMinutes200g: num(opSrc.fillMinutes200g, base.operating.fillMinutes200g),
    hourlyWage: num(opSrc.hourlyWage, base.operating.hourlyWage),
    reserve1kg: num(opSrc.reserve1kg, base.operating.reserve1kg),
    reserve200g: num(opSrc.reserve200g, base.operating.reserve200g),
    shippingPerOrder: num(opSrc.shippingPerOrder, base.operating.shippingPerOrder),
    packsPerOrder1kg: num(opSrc.packsPerOrder1kg, base.operating.packsPerOrder1kg),
    packsPerOrder200g: num(opSrc.packsPerOrder200g, base.operating.packsPerOrder200g),
    monthlyFixed: num(opSrc.monthlyFixed, base.operating.monthlyFixed),
    monthlySalesKg: num(opSrc.monthlySalesKg, base.operating.monthlySalesKg),
    shippingOverride200g:
      opSrc.shippingOverride200g == null
        ? null
        : num(opSrc.shippingOverride200g, base.operating.shippingOverride200g ?? 0),
  }
  const products: BeanMarginProduct[] =
    Array.isArray(src.products) && src.products.length > 0
      ? src.products.map((p, i) => {
          const fallback = base.products[i] ?? base.products[0]
          const row = p as Partial<BeanMarginProduct>
          const kind: BeanMarginProduct['kind'] = row.kind === 'blend' ? 'blend' : 'single'
          return {
            id: typeof row.id === 'string' ? row.id : fallback.id,
            name: typeof row.name === 'string' ? row.name : fallback.name,
            kind,
            blendRecipeId:
              row.blendRecipeId === 'dark' || row.blendRecipeId === 'light' ? row.blendRecipeId : fallback.blendRecipeId,
            greenWonPerKg: num(row.greenWonPerKg, fallback.greenWonPerKg),
            salePrice1kg: row.salePrice1kg == null ? null : num(row.salePrice1kg, 0),
            salePrice200g: row.salePrice200g == null ? null : num(row.salePrice200g, 0),
          }
        })
      : base.products
  const blends: BeanMarginBlendRecipe[] =
    Array.isArray(src.blends) && src.blends.length > 0
      ? src.blends.map((b, i) => {
          const fallback = base.blends[i] ?? base.blends[0]
          const recipe = b as Partial<BeanMarginBlendRecipe>
          const components = Array.isArray(recipe.components)
            ? recipe.components.map((c, j) => {
                const fb = fallback.components[j] ?? fallback.components[0]
                const comp = c as Partial<BeanMarginBlendComponent>
                return {
                  productId: typeof comp.productId === 'string' ? comp.productId : fb.productId,
                  label: typeof comp.label === 'string' ? comp.label : fb.label,
                  ratio: num(comp.ratio, fb.ratio),
                }
              })
            : fallback.components
          return {
            id: recipe.id === 'dark' || recipe.id === 'light' ? recipe.id : fallback.id,
            title: typeof recipe.title === 'string' ? recipe.title : fallback.title,
            components,
          }
        })
      : base.blends
  return { settings, operating, blends, products }
}
