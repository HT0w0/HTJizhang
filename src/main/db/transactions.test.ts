import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations'
import { seedBuiltinCategories } from './seed'
import {
  createTransaction,
  getTransaction,
  recentCategoryIds,
  DEFAULT_RECENT_LIMIT,
  listTransactions,
  updateTransaction,
  deleteTransaction,
  monthsWithData
} from './transactions'

function fresh(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  seedBuiltinCategories(db)
  return db
}

function idOf(db: DatabaseSync, key: string): number {
  return (db.prepare('SELECT id FROM categories WHERE builtin_key = ?').get(key) as { id: number }).id
}

function valid(db: DatabaseSync) {
  return {
    kind: 'expense' as const,
    amountFen: 2850,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '公司楼下快餐',
    paymentMethod: 'wechat' as const
  }
}

test('记一笔支出，字段都原样存下来', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))

  expect(created.id).toBeGreaterThan(0)
  expect(created.kind).toBe('expense')
  expect(created.amountFen).toBe(2850)
  expect(created.note).toBe('公司楼下快餐')
  expect(created.paymentMethod).toBe('wechat')
  expect(created.occurredOn).toBe('2026-10-03')
  expect(created.categoryId).toBe(idOf(db, 'expense/餐饮/午餐'))
  db.close()
})

test('记一笔收入', () => {
  const db = fresh()
  const created = createTransaction(db, {
    ...valid(db),
    kind: 'income',
    categoryId: idOf(db, 'income/工资薪酬/月薪'),
    amountFen: 1500000,
    note: ''
  })
  expect(created.kind).toBe('income')
  expect(created.amountFen).toBe(1500000)
  db.close()
})

test('金额以「分」存，12.34 元存成 1234（不是 12.34）', () => {
  const db = fresh()
  createTransaction(db, { ...valid(db), amountFen: 1234 })
  const raw = db.prepare('SELECT amount_fen FROM transactions').get() as { amount_fen: number }
  expect(raw.amount_fen).toBe(1234)
  expect(Number.isInteger(raw.amount_fen)).toBe(true)
  db.close()
})

test('金额必须是正整数：0 和负数被拒绝', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), amountFen: 0 })).toThrow()
  expect(() => createTransaction(db, { ...valid(db), amountFen: -100 })).toThrow()
  db.close()
})

test('金额必须是整数分，小数被拒绝（防止有人传 12.34 进来）', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), amountFen: 12.34 })).toThrow()
  db.close()
})

test('没选分类会被拒绝，并给中文提示', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, { ...valid(db), categoryId: 0 })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('分类')
  db.close()
})

test('挂到一级大类上被拒绝，且提示是「选到更具体的小类」', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, { ...valid(db), categoryId: idOf(db, 'expense/餐饮') })
  } catch (e) {
    message = (e as Error).message
  }
  // 注意：不能只断言「会抛错」——数据库的触发器也会抛错，
  // 那我们就分不清是仓储层拦下的还是数据库拦下的，也就无法确认
  // 用户看到的是不是这句中文。所以必须断言具体措辞。
  expect(message).toContain('更具体的小类')
  db.close()
})

test('收支类型与分类不一致被拒绝，且提示说清是哪边错', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, {
      ...valid(db),
      kind: 'expense',
      categoryId: idOf(db, 'income/工资薪酬/月薪')
    })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('支出不能记在收入分类下')
  db.close()
})

test('日期不合法被拒绝，提示里说清格式要求', () => {
  const db = fresh()
  let message = ''
  try {
    createTransaction(db, { ...valid(db), occurredOn: '2026/10/03' })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('日期')
  db.close()
})

test('支付方式不合法被拒绝', () => {
  const db = fresh()
  expect(() =>
    createTransaction(db, { ...valid(db), paymentMethod: 'bitcoin' as never })
  ).toThrow()
  db.close()
})

test('备注超长被拒绝（防止一屏塞不下）', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), note: '啊'.repeat(201) })).toThrow()
  db.close()
})

test('备注恰好 200 字通过', () => {
  const db = fresh()
  expect(() => createTransaction(db, { ...valid(db), note: '啊'.repeat(200) })).not.toThrow()
  db.close()
})

test('备注首尾空格被去掉', () => {
  const db = fresh()
  const created = createTransaction(db, { ...valid(db), note: '  午饭  ' })
  expect(created.note).toBe('午饭')
  db.close()
})

test('备注可以不填', () => {
  const db = fresh()
  const created = createTransaction(db, { ...valid(db), note: '' })
  expect(created.note).toBe('')
  db.close()
})

test('备注里的换行被压成空格（账单列表每行只占一行）', () => {
  const db = fresh()
  const created = createTransaction(db, { ...valid(db), note: '第一行\n第二行' })
  expect(created.note).toBe('第一行 第二行')
  db.close()
})

test('归档掉的分类不能再用来记账', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  db.exec(`UPDATE categories SET is_archived = 1 WHERE id = ${lunch}`)
  let message = ''
  try {
    createTransaction(db, { ...valid(db), categoryId: lunch })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('分类')
  db.close()
})

test('写入失败时不留半条记录（事务整体回滚）', () => {
  const db = fresh()
  const before = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  expect(() => createTransaction(db, { ...valid(db), occurredOn: '乱写' })).toThrow()
  const after = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  expect(after).toBe(before)
  db.close()
})

test('created_at / updated_at 会写上，且是合法的 ISO 时间串', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  const raw = db
    .prepare('SELECT created_at, updated_at FROM transactions WHERE id = ?')
    .get(created.id) as { created_at: string; updated_at: string }
  expect(raw.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(raw.updated_at).toBe(raw.created_at)
  db.close()
})

test('occurred_on 存的是本地日期串，不带时间部分', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  const raw = db
    .prepare('SELECT occurred_on FROM transactions WHERE id = ?')
    .get(created.id) as { occurred_on: string }
  expect(raw.occurred_on).toBe('2026-10-03')
  expect(raw.occurred_on).not.toContain('T')
  db.close()
})

test('getTransaction 能读回来', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  expect(getTransaction(db, created.id)).toEqual(created)
  db.close()
})

test('getTransaction 对不存在的 id 返回 undefined', () => {
  const db = fresh()
  expect(getTransaction(db, 999999)).toBeUndefined()
  db.close()
})

test('连记两笔互不影响（保存后能接着记下一笔）', () => {
  const db = fresh()
  const a = createTransaction(db, valid(db))
  const b = createTransaction(db, { ...valid(db), amountFen: 3600, note: '咖啡' })
  expect(a.id).not.toBe(b.id)
  const n = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  expect(n).toBe(2)
  db.close()
})

// ---------- 最近用过的分类 ----------

function insertRaw(
  db: DatabaseSync,
  categoryId: number,
  createdAt: string
): void {
  db.prepare(
    `INSERT INTO transactions (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
     VALUES ('expense', 100, ?, '2026-10-03', '', 'wechat', ?, ?)`
  ).run(categoryId, createdAt, createdAt)
}

test('recentCategoryIds：没记过账时返回空数组', () => {
  const db = fresh()
  expect(recentCategoryIds(db)).toEqual([])
  db.close()
})

test('recentCategoryIds：按最近使用的先后返回，最近的在最前', () => {
  const db = fresh()
  const breakfast = idOf(db, 'expense/餐饮/早餐')
  const lunch = idOf(db, 'expense/餐饮/午餐')
  const taxi = idOf(db, 'expense/交通/打车网约车')

  insertRaw(db, breakfast, '2026-10-03T01:00:00.000Z')
  insertRaw(db, lunch, '2026-10-03T02:00:00.000Z')
  insertRaw(db, taxi, '2026-10-03T03:00:00.000Z')

  expect(recentCategoryIds(db)).toEqual([taxi, lunch, breakfast])
  db.close()
})

test('recentCategoryIds：同一个分类记多次只出现一次，按最后一次算', () => {
  const db = fresh()
  const breakfast = idOf(db, 'expense/餐饮/早餐')
  const lunch = idOf(db, 'expense/餐饮/午餐')

  insertRaw(db, lunch, '2026-10-03T01:00:00.000Z')
  insertRaw(db, breakfast, '2026-10-03T02:00:00.000Z')
  insertRaw(db, lunch, '2026-10-03T03:00:00.000Z') // 午餐最后一次比早餐晚

  expect(recentCategoryIds(db)).toEqual([lunch, breakfast])
  db.close()
})

test('recentCategoryIds：尊重 limit', () => {
  const db = fresh()
  insertRaw(db, idOf(db, 'expense/餐饮/早餐'), '2026-10-03T01:00:00.000Z')
  insertRaw(db, idOf(db, 'expense/餐饮/午餐'), '2026-10-03T02:00:00.000Z')
  insertRaw(db, idOf(db, 'expense/餐饮/晚餐'), '2026-10-03T03:00:00.000Z')
  expect(recentCategoryIds(db, 2)).toHaveLength(2)
  expect(recentCategoryIds(db, 2)).toEqual([
    idOf(db, 'expense/餐饮/晚餐'),
    idOf(db, 'expense/餐饮/午餐')
  ])
  db.close()
})

test('recentCategoryIds：默认 limit 是正整数', () => {
  expect(Number.isInteger(DEFAULT_RECENT_LIMIT)).toBe(true)
  expect(DEFAULT_RECENT_LIMIT).toBeGreaterThan(0)
})

test('新记的一笔会立刻变成「最近用过」的第一个（保存后重新打开记账页就能看到它置顶）', () => {
  const db = fresh()
  const first = createTransaction(db, valid(db))
  expect(recentCategoryIds(db)[0]).toBe(first.categoryId)
  db.close()
})

// ---------------------------------------------------------------------------
// 第 4 阶段：列表查询 / 编辑 / 删除 / 有账的月份
// ---------------------------------------------------------------------------

/** 往某个分类下记一小笔，省得每行都写一长串。 */
function spend(
  db: DatabaseSync,
  occurredOn: string,
  note: string,
  key = 'expense/餐饮/午餐',
  amountFen = 1000
): number {
  return createTransaction(db, {
    kind: 'expense',
    amountFen,
    categoryId: idOf(db, key),
    occurredOn,
    note,
    paymentMethod: 'wechat'
  }).id
}

function earn(db: DatabaseSync, occurredOn: string, note: string, amountFen = 500000): number {
  return createTransaction(db, {
    kind: 'income',
    amountFen,
    categoryId: idOf(db, 'income/工资薪酬/月薪'),
    occurredOn,
    note,
    paymentMethod: 'bank'
  }).id
}

test('listTransactions 只返回指定月份的账', () => {
  const db = fresh()
  spend(db, '2026-10-03', '十月')
  spend(db, '2026-09-30', '九月')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows.map((r) => r.note)).toEqual(['十月'])
  db.close()
})

test('listTransactions 带出小类名、大类名和大类图标', () => {
  const db = fresh()
  spend(db, '2026-10-03', '')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows[0].categoryName).toBe('午餐')
  expect(rows[0].majorName).toBe('餐饮')
  expect(rows[0].majorIcon).toBe('🍜')
  db.close()
})

test('listTransactions 按日期从新到旧，同一天内后记的在前', () => {
  const db = fresh()
  const first = spend(db, '2026-10-03', '先记')
  const second = spend(db, '2026-10-03', '后记')
  spend(db, '2026-10-05', '最新')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows.map((r) => r.note)).toEqual(['最新', '后记', '先记'])
  expect(rows[1].id).toBe(second)
  expect(rows[2].id).toBe(first)
  db.close()
})

test('listTransactions 能按收支筛选', () => {
  const db = fresh()
  spend(db, '2026-10-03', '花')
  earn(db, '2026-10-03', '赚')

  expect(
    listTransactions(db, { month: '2026-10', kind: 'expense', keyword: '' }).map((r) => r.note)
  ).toEqual(['花'])
  expect(
    listTransactions(db, { month: '2026-10', kind: 'income', keyword: '' }).map((r) => r.note)
  ).toEqual(['赚'])
  expect(listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })).toHaveLength(2)
  db.close()
})

test('listTransactions 搜备注', () => {
  const db = fresh()
  spend(db, '2026-10-03', '麦当劳')
  spend(db, '2026-10-03', '食堂')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '麦当劳' })
  expect(rows.map((r) => r.note)).toEqual(['麦当劳'])
  db.close()
})

test('listTransactions 搜小类名（没写备注也能按分类找到）', () => {
  const db = fresh()
  spend(db, '2026-10-03', '', 'expense/交通/打车网约车', 3000)

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '打车' })
  expect(rows).toHaveLength(1)
  expect(rows[0].categoryName).toBe('打车网约车')
  db.close()
})

test('listTransactions 搜大类名（能搜出一整个大类下的账）', () => {
  const db = fresh()
  spend(db, '2026-10-03', '', 'expense/餐饮/午餐')
  spend(db, '2026-10-04', '', 'expense/餐饮/晚餐')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '餐饮' })
  expect(rows).toHaveLength(2)
  db.close()
})

test('listTransactions 的关键词里带 % 时不当通配符（否则搜「%」会返回全部）', () => {
  const db = fresh()
  spend(db, '2026-10-03', '双十一 50% 折扣')
  spend(db, '2026-10-03', '食堂')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '%' })
  expect(rows.map((r) => r.note)).toEqual(['双十一 50% 折扣'])
  db.close()
})

test('listTransactions 的关键词里带 _ 时不当通配符', () => {
  const db = fresh()
  spend(db, '2026-10-03', 'a_b')
  spend(db, '2026-10-03', 'axb')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: 'a_b' })
  expect(rows.map((r) => r.note)).toEqual(['a_b'])
  db.close()
})

test('listTransactions 的关键词里带反斜杠时按字面找', () => {
  const db = fresh()
  spend(db, '2026-10-03', 'C:\\Users')
  spend(db, '2026-10-03', 'D:/Users')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: 'C:\\Users' })
  expect(rows).toHaveLength(1)
  db.close()
})

test('listTransactions 空月份返回空数组，不抛错', () => {
  const db = fresh()
  expect(listTransactions(db, { month: '2020-01', kind: 'all', keyword: '' })).toEqual([])
  db.close()
})

test('listTransactions 月份格式不对时抛中文错', () => {
  const db = fresh()
  expect(() => listTransactions(db, { month: '2026-13', kind: 'all', keyword: '' })).toThrow(/月份/)
  expect(() => listTransactions(db, { month: '瞎写的', kind: 'all', keyword: '' })).toThrow(/月份/)
  db.close()
})

test('listTransactions 也能查到已归档分类下的历史账单（归档不能让旧账消失）', () => {
  const db = fresh()
  spend(db, '2026-10-03', '归档前记的')
  db.prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(
    idOf(db, 'expense/餐饮/午餐')
  )

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows).toHaveLength(1)
  expect(rows[0].categoryName).toBe('午餐')
  db.close()
})

test('listTransactions 跨月边界：1 号和最后一天都算本月，上月最后一天不算', () => {
  const db = fresh()
  spend(db, '2026-09-30', '上月最后一天')
  spend(db, '2026-10-01', '本月第一天')
  spend(db, '2026-10-31', '本月最后一天')
  spend(db, '2026-11-01', '下月第一天')

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows.map((r) => r.note)).toEqual(['本月最后一天', '本月第一天'])
  db.close()
})

test('listTransactions 闰年 2 月 29 号能被查到', () => {
  const db = fresh()
  spend(db, '2024-02-29', '闰日')

  const rows = listTransactions(db, { month: '2024-02', kind: 'all', keyword: '' })
  expect(rows.map((r) => r.note)).toEqual(['闰日'])
  db.close()
})

test('updateTransaction 改金额、日期、备注、支付方式', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))

  const updated = updateTransaction(db, {
    id: created.id,
    kind: 'expense',
    amountFen: 2500,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-05',
    note: '新备注',
    paymentMethod: 'cash'
  })

  expect(updated.id).toBe(created.id)
  expect(updated.amountFen).toBe(2500)
  expect(updated.occurredOn).toBe('2026-10-05')
  expect(updated.note).toBe('新备注')
  expect(updated.paymentMethod).toBe('cash')
  db.close()
})

test('updateTransaction 改分类', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))

  const updated = updateTransaction(db, {
    id: created.id,
    kind: 'expense',
    amountFen: created.amountFen,
    categoryId: idOf(db, 'expense/餐饮/晚餐'),
    occurredOn: created.occurredOn,
    note: created.note,
    paymentMethod: created.paymentMethod
  })
  expect(updated.categoryId).toBe(idOf(db, 'expense/餐饮/晚餐'))
  db.close()
})

test('updateTransaction 备注也会被洗（换行压成空格）', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  const updated = updateTransaction(db, {
    ...valid(db),
    id: created.id,
    note: '  公司楼下\n快餐  '
  })
  expect(updated.note).toBe('公司楼下 快餐')
  db.close()
})

test('updateTransaction 把支出改成收入、且换成收入分类时成功', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))

  const updated = updateTransaction(db, {
    id: created.id,
    kind: 'income',
    amountFen: 1500000,
    categoryId: idOf(db, 'income/工资薪酬/月薪'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'bank'
  })
  expect(updated.kind).toBe('income')
  expect(updated.categoryId).toBe(idOf(db, 'income/工资薪酬/月薪'))
  db.close()
})

test('updateTransaction 把支出改成收入、却没换分类时必须报中文错', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))

  expect(() =>
    updateTransaction(db, {
      ...valid(db),
      id: created.id,
      kind: 'income',
      amountFen: 1000,
      categoryId: idOf(db, 'expense/餐饮/午餐')
    })
  ).toThrow('收入不能记在支出分类下')

  // 失败后数据库里的那一笔必须原样不动
  const after = getTransaction(db, created.id)
  expect(after?.kind).toBe('expense')
  expect(after?.amountFen).toBe(2850)
  db.close()
})

test('updateTransaction 金额为 0 时报错，且不动原来的数据', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))

  expect(() =>
    updateTransaction(db, { ...valid(db), id: created.id, amountFen: 0 })
  ).toThrow('金额必须大于 0')
  expect(getTransaction(db, created.id)?.amountFen).toBe(2850)
  db.close()
})

test('updateTransaction 金额是小数时报错（金额只能以「分」为整数存）', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  expect(() =>
    updateTransaction(db, { ...valid(db), id: created.id, amountFen: 12.5 })
  ).toThrow(/整数/)
  db.close()
})

test('updateTransaction 日期格式不对时报中文错', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  expect(() =>
    updateTransaction(db, { ...valid(db), id: created.id, occurredOn: '2026/10/03' })
  ).toThrow(/日期/)
  db.close()
})

test('updateTransaction 日历上不存在的日期也拒绝（2026-02-30）', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  expect(() =>
    updateTransaction(db, { ...valid(db), id: created.id, occurredOn: '2026-02-30' })
  ).toThrow(/日期/)
  db.close()
})

test('updateTransaction 支付方式非法时报中文错', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  expect(() =>
    updateTransaction(db, {
      ...valid(db),
      id: created.id,
      paymentMethod: '微信' as never
    })
  ).toThrow(/支付方式/)
  db.close()
})

test('updateTransaction 备注超长时报中文错，并说清现在有几个字', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  expect(() =>
    updateTransaction(db, { ...valid(db), id: created.id, note: '字'.repeat(201) })
  ).toThrow(/备注最多 200 个字，现在有 201 个/)
  db.close()
})

test('updateTransaction 改不存在的账单时报中文错', () => {
  const db = fresh()
  expect(() => updateTransaction(db, { ...valid(db), id: 999999 })).toThrow('这笔账不存在')
  db.close()
})

test('updateTransaction 不动别的账单', () => {
  const db = fresh()
  const keep = createTransaction(db, { ...valid(db), note: '别动我', amountFen: 111 })
  const target = createTransaction(db, { ...valid(db), note: '改我', amountFen: 222 })

  updateTransaction(db, { ...valid(db), id: target.id, note: '改好了', amountFen: 999 })

  expect(getTransaction(db, keep.id)?.amountFen).toBe(111)
  expect(getTransaction(db, keep.id)?.note).toBe('别动我')
  db.close()
})

test('updateTransaction 会更新 updated_at，但不动 created_at', () => {
  const db = fresh()
  const created = createTransaction(db, valid(db))
  const updated = updateTransaction(db, { ...valid(db), id: created.id, note: '改过了' })
  expect(updated.createdAt).toBe(created.createdAt)
  expect(updated.updatedAt >= created.updatedAt).toBe(true)
  db.close()
})

test('deleteTransaction 删掉指定的那一笔，别的留着', () => {
  const db = fresh()
  const keep = spend(db, '2026-10-03', '留')
  const drop = spend(db, '2026-10-03', '删')

  deleteTransaction(db, drop)

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows.map((r) => r.id)).toEqual([keep])
  db.close()
})

test('deleteTransaction 删不存在的账单时报中文错', () => {
  const db = fresh()
  expect(() => deleteTransaction(db, 999999)).toThrow('这笔账不存在')
  db.close()
})

test('deleteTransaction 删两次，第二次报同样的中文错（不能静默成功）', () => {
  const db = fresh()
  const id = spend(db, '2026-10-03', '')
  deleteTransaction(db, id)
  expect(() => deleteTransaction(db, id)).toThrow('这笔账不存在')
  db.close()
})

test('monthsWithData 列出有账的月份，从新到旧，且不重复', () => {
  const db = fresh()
  spend(db, '2026-10-03', '')
  spend(db, '2026-08-15', '')
  spend(db, '2026-10-20', '')
  earn(db, '2025-12-31', '')

  expect(monthsWithData(db)).toEqual(['2026-10', '2026-08', '2025-12'])
  db.close()
})

test('monthsWithData 一笔账都没有时返回空数组', () => {
  const db = fresh()
  expect(monthsWithData(db)).toEqual([])
  db.close()
})

test('monthsWithData 删光之后，那个月就不在列表里了', () => {
  const db = fresh()
  const id = spend(db, '2026-10-03', '')
  spend(db, '2026-11-03', '')
  deleteTransaction(db, id)
  expect(monthsWithData(db)).toEqual(['2026-11'])
  db.close()
})

// ---------- 归档分类下的老账单还能不能改 ----------
// 用户 2026-10-04 拍板：能改，分类保持原样。
//
// 为什么必须改：归档一个分类时它名下的历史账单**照常显示在列表里**（§5.11），
// 用户点开想改个备注，保存却报「所选的分类已被删除」——想改个错字都不行，
// 而且弹窗里看不到原来是什么分类。列表和编辑对归档的态度自相矛盾。

test('分类归档后，原来挂在它下面的那笔账，只改金额和备注仍然存得进去', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  const id = spend(db, '2026-10-03', '公司楼下快餐')
  db.prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(lunch)

  const updated = updateTransaction(db, {
    id,
    kind: 'expense',
    amountFen: 3250,
    categoryId: lunch, // 还是那个已归档的分类
    occurredOn: '2026-10-03',
    note: '涨价了',
    paymentMethod: 'alipay'
  })

  expect(updated.amountFen).toBe(3250)
  expect(updated.note).toBe('涨价了')
  expect(updated.categoryId).toBe(lunch)
  db.close()
})

test('归档分类下的账，改的时候仍然可以换成别的分类', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  const id = spend(db, '2026-10-03', '公司楼下快餐')
  db.prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(lunch)

  const moved = updateTransaction(db, {
    id,
    kind: 'expense',
    amountFen: 1000,
    categoryId: idOf(db, 'expense/餐饮/晚餐'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'wechat'
  })

  expect(moved.categoryId).toBe(idOf(db, 'expense/餐饮/晚餐'))
  db.close()
})

test('不能把别的账改成挂到一个归档分类下（放行的只是「原样保留」）', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  const other = spend(db, '2026-10-03', '别的账', 'expense/餐饮/晚餐')
  db.prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(lunch)

  let message = ''
  try {
    updateTransaction(db, {
      id: other,
      kind: 'expense',
      amountFen: 1000,
      categoryId: lunch, // 原来挂的不是它
      occurredOn: '2026-10-03',
      note: '',
      paymentMethod: 'wechat'
    })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('分类')
  db.close()
})

test('归档分类下的账，不能改成收支类型和该分类不符（放行不等于连类型都不管了）', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  const id = spend(db, '2026-10-03', '公司楼下快餐')
  db.prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(lunch)

  let message = ''
  try {
    updateTransaction(db, {
      id,
      kind: 'income', // 午餐是支出分类
      amountFen: 1000,
      categoryId: lunch,
      occurredOn: '2026-10-03',
      note: '',
      paymentMethod: 'wechat'
    })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('收入不能记在支出分类下')
  db.close()
})

test('新建一笔账仍然不能挂到归档分类上（编辑的放行只针对「保持原样」）', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  db.prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(lunch)

  let message = ''
  try {
    createTransaction(db, { ...valid(db), categoryId: lunch })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('分类')
  db.close()
})

test('列表里带出这笔记在哪个已归档的分类下（界面要显示「午餐（已删除）」）', () => {
  const db = fresh()
  const lunch = idOf(db, 'expense/餐饮/午餐')
  spend(db, '2026-10-03', '公司楼下快餐')
  db.prepare('UPDATE categories SET is_archived = 1 WHERE id = ?').run(lunch)

  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows).toHaveLength(1)
  expect(rows[0].categoryName).toBe('午餐')
  expect(rows[0].categoryArchived).toBe(true)
  db.close()
})

test('没归档的分类，列表里标着「没归档」', () => {
  const db = fresh()
  spend(db, '2026-10-03', '公司楼下快餐')
  const rows = listTransactions(db, { month: '2026-10', kind: 'all', keyword: '' })
  expect(rows[0].categoryArchived).toBe(false)
  db.close()
})
