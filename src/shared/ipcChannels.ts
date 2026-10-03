/**
 * IPC 通道名。
 *
 * 必须放在 shared 里由主进程和预加载脚本共用同一份 ——
 * 通道名写错**不会报任何错**，只会静默失效（界面点了没反应），
 * 是最难排查的一类问题。共用常量能让拼写错误在类型检查阶段就暴露。
 */
export const CATEGORY_CHANNELS = {
  list: 'categories:list',
  listArchived: 'categories:listArchived',
  usage: 'categories:usage',
  create: 'categories:create',
  rename: 'categories:rename',
  setIcon: 'categories:setIcon',
  reorder: 'categories:reorder',
  archive: 'categories:archive',
  restore: 'categories:restore',
  restoreBuiltins: 'categories:restoreBuiltins'
} as const

export const TRANSACTION_CHANNELS = {
  create: 'transactions:create',
  recentCategoryIds: 'transactions:recentCategoryIds',
  today: 'transactions:today'
} as const
