/**
 * 원두(생두) 이름 정규화·매핑 **단일 import** 를 위한 barrel.
 * 새 코드는 `@/` 대신 `beanNamePublic` 에서 꺼 쓰는 것을 권장합니다.
 */
export { GREEN_BEAN_ORDER_INVENTORY_ALIASES } from './greenBeanOrderInventoryAliases'
export {
  getEffectiveGreenBeanOrderAliases,
  normalizeBeanNameAliases,
  readCustomBeanNameAliases,
  writeCustomBeanNameAliases,
  BEAN_NAME_ALIASES_STORAGE_KEY,
  BEAN_NAME_ALIASES_UPDATED_EVENT,
  type BeanNameAliasEntry,
} from './beanNameAliasStore'
export {
  normCompact,
  coreFromName,
  findByExactName,
  findLongestSubstringRow,
  resolveAliasedTarget,
  resolveExternalLabelToInventoryRow,
  type ResolveExternalLabelVia,
} from './beanNameResolve'
export {
  mapStatementItemToInventoryLabel,
  formatBeanRowLabel,
  stripParensForMatch,
  type MapStatementItemToInventoryOptions,
} from './beanSalesStatementMapping'
