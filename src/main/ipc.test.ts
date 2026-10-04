import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from './db/migrations'
import { seedBuiltinCategories } from './db/seed'
import { initDatabaseIn } from './db'
import { inspectBackupFile } from './db/backup'
import {
  backupHandlers,
  categoryHandlers,
  statsHandlers,
  transactionHandlers,
  type BackupContext
} from './ipc'
import {
  BACKUP_CHANNELS,
  CATEGORY_CHANNELS,
  STATS_CHANNELS,
  TRANSACTION_CHANNELS
} from '@shared/ipcChannels'


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

test('list 走通，返回 ok:true 且带 16 个大类', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  const result = await h.list()
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toHaveLength(16)
  db.close()
})

test('失败时返回 ok:false 和干净的中文，不带 Electron 那串英文前缀', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  const result = await h.create({ kind: 'expense', parentId: null, name: '餐饮', icon: '🍜' })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('已存在')
    expect(result.message).not.toContain('Error invoking remote method')
    expect(result.message).not.toContain('Error:')
  }
  db.close()
})

test('数据库层的英文错误不会原样甩给用户（磁盘满/文件被锁时就会走到这里）', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  db.close() // 关掉连接，让后续调用抛出 SQLite 的英文错误 "database is not open"

  const result = await h.list()
  expect(result.ok).toBe(false)
  if (result.ok) return

  // 用户看不懂英文，消息里必须至少有一段中文说明
  expect(result.message).toMatch(/[一-鿿]/)
  // 但不能把英文原文丢掉——出了问题时这句话是唯一的排查线索
  expect(result.message).toContain('database is not open')
  expect(result.message).not.toMatch(/^database is not open$/)
})

test('底层抛出的非 Error 对象也被兜住，不会把空字符串或 undefined 当消息传出去', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  db.close()
  const result = await h.list()
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(typeof result.message).toBe('string')
    expect(result.message.length).toBeGreaterThan(0)
    expect(result.message).not.toBe('undefined')
    expect(result.message).not.toBe('null')
  }
})

test('create → rename → setIcon → archive → listArchived → restore 一整条链路走通', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)

  const created = await h.create({ kind: 'expense', parentId: null, name: '宠物', icon: '🐱' })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  const id = created.value.id

  expect((await h.rename(id, '毛孩子')).ok).toBe(true)
  expect((await h.setIcon(id, '🐶')).ok).toBe(true)
  expect((await h.archive(id)).ok).toBe(true)

  const archived = await h.listArchived()
  expect(archived.ok).toBe(true)
  if (archived.ok) {
    expect(archived.value.map((n) => n.name)).toContain('毛孩子')
    expect(archived.value.find((n) => n.name === '毛孩子')!.icon).toBe('🐶')
  }

  expect((await h.restore(id)).ok).toBe(true)
  const tree = await h.list()
  if (tree.ok) expect(tree.value.map((n) => n.name)).toContain('毛孩子')

  db.close()
})

test('reorder 走通，顺序真的变了', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  const before = await h.list()
  if (!before.ok) throw new Error('前置失败')
  const ids = before.value.filter((n) => n.kind === 'expense').map((n) => n.id)
  const reversed = [...ids].reverse()

  expect((await h.reorder('expense', null, reversed)).ok).toBe(true)
  const after = await h.list()
  if (after.ok) {
    expect(
      after.value
        .filter((n) => n.kind === 'expense')
        .map((n) => n.id)
    ).toEqual(reversed)
  }
  db.close()
})

test('restoreBuiltins 走通', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  expect((await h.archive(idOf(db, 'expense/餐饮'))).ok).toBe(true)
  const restored = await h.restoreBuiltins()
  expect(restored.ok).toBe(true)
  const tree = await h.list()
  if (tree.ok) expect(tree.value.map((n) => n.name)).toContain('餐饮')
  db.close()
})

test('usage 在没有账单时返回空对象', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  const result = await h.usage()
  expect(result).toEqual({ ok: true, value: {} })
  db.close()
})

test('每个处理器在出错时都返回 ok:false，没有一个会把异常漏出去', async () => {
  const db = fresh()
  const h = categoryHandlers(() => db)
  db.close()

  const calls: Array<Promise<{ ok: boolean }>> = [
    h.list(),
    h.listArchived(),
    h.usage(),
    h.create({ kind: 'expense', parentId: null, name: 'x', icon: '❓' }),
    h.rename(1, 'y'),
    h.setIcon(1, '❓'),
    h.reorder('expense', null, []),
    h.archive(1),
    h.restore(1),
    h.restoreBuiltins()
  ]

  for (const call of calls) {
    const result = await call
    expect(result.ok).toBe(false)
  }
})

// ---------- 账单 ----------

test('记账走通，返回 ok:true 且带 id', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.create({
    kind: 'expense',
    amountFen: 2850,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '午饭',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.id).toBeGreaterThan(0)
    expect(result.value.amountFen).toBe(2850)
  }
  db.close()
})

test('金额为 0 时返回干净中文，不带 Electron 英文前缀', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.create({
    kind: 'expense',
    amountFen: 0,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('金额')
    expect(result.message).not.toContain('Error')
  }
  db.close()
})

test('没选分类时提示是中文的「请先选择一个分类」', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.create({
    kind: 'expense',
    amountFen: 100,
    categoryId: 0,
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toContain('请先选择一个分类')
  db.close()
})

test('today 返回合法的本地日期串', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.today()
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  db.close()
})

test('recentCategoryIds 初始为空数组，记一笔后就有内容了', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  expect(await h.recentCategoryIds()).toEqual({ ok: true, value: [] })

  await h.create({
    kind: 'expense',
    amountFen: 100,
    categoryId: idOf(db, 'expense/餐饮/早餐'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'cash'
  })
  const after = await h.recentCategoryIds()
  expect(after.ok).toBe(true)
  if (after.ok) expect(after.value).toEqual([idOf(db, 'expense/餐饮/早餐')])
  db.close()
})

test('数据库关掉后，账单处理器也返回 ok:false 而不是把异常漏出去', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  db.close()
  const result = await h.recentCategoryIds()
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
})

// ---------------------------------------------------------------------------
// 第 4 阶段：账单列表 / 编辑 / 删除 的通道与处理器
// ---------------------------------------------------------------------------

test('账单处理器暴露了 list / update / remove / months', () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  expect(typeof h.list).toBe('function')
  expect(typeof h.update).toBe('function')
  expect(typeof h.remove).toBe('function')
  expect(typeof h.months).toBe('function')
  db.close()
})

test('list 成功时返回 ok:true', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.list({ month: '2026-10', kind: 'all', keyword: '' })
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toEqual([])
  db.close()
})

test('list 失败时返回 ok:false，消息是中文且不带 Electron 的英文前缀', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.list({ month: '瞎写的', kind: 'all', keyword: '' })
  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toMatch(/[一-鿿]/)
    expect(result.message).not.toContain('Error invoking remote method')
  }
  db.close()
})

test('remove 删不存在的账单时返回中文错误，而不是把异常漏出去', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.remove(999999)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toContain('这笔账不存在')
  db.close()
})

test('update 改不存在的账单时返回中文错误', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.update({
    id: 999999,
    kind: 'expense',
    amountFen: 100,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '',
    paymentMethod: 'wechat'
  })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toContain('这笔账不存在')
  db.close()
})

test('months 成功时返回数组', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  const result = await h.months()
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toEqual([])
  db.close()
})

test('数据库关掉后，list / update / remove / months 也是 ok:false 而不是漏异常', async () => {
  const db = fresh()
  const h = transactionHandlers(() => db)
  db.close()

  for (const result of [
    await h.list({ month: '2026-10', kind: 'all', keyword: '' }),
    await h.update({
      id: 1,
      kind: 'expense',
      amountFen: 100,
      categoryId: 1,
      occurredOn: '2026-10-03',
      note: '',
      paymentMethod: 'wechat'
    }),
    await h.remove(1),
    await h.months()
  ]) {
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
  }
})

test('通道名和界面契约对得上（写错通道名不会报错，只会静默失效）', () => {
  expect(TRANSACTION_CHANNELS.list).toBe('transactions:list')
  expect(TRANSACTION_CHANNELS.update).toBe('transactions:update')
  expect(TRANSACTION_CHANNELS.remove).toBe('transactions:remove')
  expect(TRANSACTION_CHANNELS.months).toBe('transactions:months')
})

test('每个账单通道名都唯一（重复会让两个功能接到同一个处理器上）', () => {
  const names = Object.values(TRANSACTION_CHANNELS)
  expect(new Set(names).size).toBe(names.length)
})

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

test('统计页取数走通：这个月没记账时也给得出结果，不是报错', async () => {
  const db = fresh()
  const h = statsHandlers(() => db)

  const result = await h.overview('2026-10')
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.month).toBe('2026-10')
    expect(result.value.expenseFen).toBe(0)
    expect(result.value.incomeFen).toBe(0)
    expect(result.value.majors).toEqual([])
    // 趋势图即使一笔账都没有也要给满 12 个月 —— 否则横轴是空的，用户以为图坏了
    expect(result.value.trend).toHaveLength(12)
  }
  db.close()
})

test('统计的数字和刚记的账对得上（界面拿到的是同一批账算出来的）', async () => {
  const db = fresh()
  const t = transactionHandlers(() => db)
  await t.create({
    kind: 'expense',
    amountFen: 2850,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-03',
    note: '午饭',
    paymentMethod: 'wechat'
  })
  await t.create({
    kind: 'income',
    amountFen: 800000,
    categoryId: idOf(db, 'income/工资薪酬/月薪'),
    occurredOn: '2026-10-05',
    note: '',
    paymentMethod: 'bank'
  })

  const result = await statsHandlers(() => db).overview('2026-10')
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.expenseFen).toBe(2850)
    expect(result.value.incomeFen).toBe(800000)
    expect(result.value.netFen).toBe(797150)
    expect(result.value.count).toBe(2)
    expect(result.value.majors.map((m) => m.name)).toEqual(['餐饮'])
    expect(result.value.trend[11].expenseFen).toBe(2850)
  }
  db.close()
})

test('月份格式不对时给用户一句中文，而不是把 SQL 的错误甩出去', async () => {
  const db = fresh()
  const result = await statsHandlers(() => db).overview('2026-13')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
  db.close()
})

test('数据库关掉后取统计也是 ok:false 而不是漏异常', async () => {
  const db = fresh()
  const h = statsHandlers(() => db)
  db.close()

  const result = await h.overview('2026-10')
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toMatch(/[一-鿿]/)
})

test('统计通道名和界面契约对得上（写错通道名不会报错，只会静默失效）', () => {
  expect(STATS_CHANNELS.overview).toBe('stats:overview')
})

test('统计通道名唯一（重复会让两个功能接到同一个处理器上）', () => {
  const names = Object.values(STATS_CHANNELS)
  expect(new Set(names).size).toBe(names.length)
})

test('三个模块的通道名互不重名（跨模块重名会静默串线）', () => {
  const all = [
    ...Object.values(CATEGORY_CHANNELS),
    ...Object.values(TRANSACTION_CHANNELS),
    ...Object.values(STATS_CHANNELS)
  ]
  expect(new Set(all).size).toBe(all.length)
})

// ---------------------------------------------------------------------------
// 备份与恢复
// ---------------------------------------------------------------------------

/**
 * 造一个临时数据目录。
 *
 * 这一组测试**不能**用 :memory: 那个 fresh()：恢复要做的是换文件、重开连接，
 * 内存库没有文件可换，测出来的东西和用户实际遇到的两回事。
 */
function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ht-ipc-backup-'))
}

/** 主进程手里那份「当前连接」，形状与 ipc-register.ts 里的 DatabaseHolder 一致。 */
interface Holder {
  db: DatabaseSync
  userDataDir: string
}

/** 一份「除被测项外全部由测试说了算」的备份上下文。 */
function ctxFor(holder: Holder, over: Partial<BackupContext> = {}): BackupContext {
  return {
    getDb: () => holder.db,
    userDataDir: holder.userDataDir,
    // 和线上一样地**改写** holder.db，而不是另存一个变量 ——
    // 「恢复完每个功能都对着旧连接报错」正是要防的缺陷，另存变量就测不出来了。
    replaceDatabase: (next) => {
      holder.db = next
    },
    today: () => '2026-10-04',
    pickSavePath: async () => null,
    pickBackupPath: async () => null,
    openDataFolder: async () => {},
    ...over
  }
}

/** 往账本里塞一笔，省得每个用例都抄一遍 INSERT。 */
function addTx(db: DatabaseSync, occurredOn: string, amountFen: number, note: string): void {
  db.prepare(
    `INSERT INTO transactions
       (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
     VALUES ('expense', ?, ?, ?, ?, 'wechat', '2026-10-04T10:00:00', '2026-10-04T10:00:00')`
  ).run(amountFen, idOf(db, 'expense/餐饮/午餐'), occurredOn, note)
}

function countIn(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
}

test('导出时用户点了取消：返回 cancelled:true，并且一个文件都不该产生', async () => {
  const dir = tempDir()
  const holder: Holder = { db: initDatabaseIn(dir), userDataDir: dir }
  const before = readdirSync(dir).sort()

  const b = backupHandlers(ctxFor(holder, { pickSavePath: async () => null }))
  const result = await b.exportDatabase()

  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.value.cancelled).toBe(true)
    expect(result.value.path).toBe('')
  }
  // 取消之后目录里不该多出任何东西：多出半个文件，用户会以为自己备份成功了
  expect(readdirSync(dir).sort()).toEqual(before)

  holder.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('导出备份文件：写出来的确实是一份能读的账本，笔数对得上', async () => {
  const dir = tempDir()
  const holder: Holder = { db: initDatabaseIn(dir), userDataDir: dir }
  addTx(holder.db, '2026-10-01', 1500, '午饭')
  addTx(holder.db, '2026-10-02', 800, '早饭')

  const target = join(dir, "老王的'备份'.db")
  const b = backupHandlers(ctxFor(holder, { pickSavePath: async () => target }))
  const result = await b.exportDatabase()

  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value.cancelled).toBe(false)
  // 文件名里带单引号：路径是参数绑定传进 SQL 的，不该拼出语法错误
  expect(inspectBackupFile(target).transactions).toBe(2)

  holder.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('CSV 导出只含指定月份（筛错月份是当场看不出来的错）', async () => {
  const dir = tempDir()
  const holder: Holder = { db: initDatabaseIn(dir), userDataDir: dir }
  addTx(holder.db, '2026-09-05', 100, '九月的账')
  addTx(holder.db, '2026-10-06', 200, '十月的账')

  const target = join(dir, 'out.csv')
  const b = backupHandlers(ctxFor(holder, { pickSavePath: async () => target }))
  const result = await b.exportCsv('2026-09')

  expect(result.ok).toBe(true)
  const text = readFileSync(target, 'utf8')
  expect(text).toContain('九月的账')
  expect(text).not.toContain('十月的账')

  // month 传 null 表示全部：两笔都要在
  await b.exportCsv(null)
  const all = readFileSync(target, 'utf8')
  expect(all).toContain('九月的账')
  expect(all).toContain('十月的账')

  holder.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('选择备份文件时用户点了取消：返回 null，不是报错', async () => {
  const dir = tempDir()
  const holder: Holder = { db: initDatabaseIn(dir), userDataDir: dir }

  const b = backupHandlers(ctxFor(holder, { pickBackupPath: async () => null }))
  const result = await b.pickRestoreFile()

  // 「取消」是正常操作，弹一句红色报错只会让用户以为自己点错了
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.value).toBeNull()

  holder.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('用户选错文件：说清中文原因，且当前账本一个字节都没动', async () => {
  const dir = tempDir()
  const holder: Holder = { db: initDatabaseIn(dir), userDataDir: dir }
  addTx(holder.db, '2026-10-01', 1500, '午饭')
  expect(countIn(holder.db)).toBe(1)

  const wrong = join(dir, '风景照.jpg')
  writeFileSync(wrong, '这不是数据库，只是一段文字')

  const b = backupHandlers(ctxFor(holder, { pickBackupPath: async () => wrong }))
  const result = await b.pickRestoreFile()

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toContain('不是 HT记账的备份文件')
    expect(result.message).not.toContain('Error invoking remote method')
  }
  // 关键：挑错文件不该有任何代价，账本必须原封不动
  expect(countIn(holder.db)).toBe(1)

  holder.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('选对文件：预览给出两边各几笔和日期范围，用户才有依据判断选没选错', async () => {
  // 备份来自**另一个**账本目录：同一个目录里 initDatabaseIn 两次打开的是同一个
  // 账本文件，那就不叫「两份账」了，currentCount 会变成两边之和。
  const srcDir = tempDir()
  const dir = tempDir()
  const source: Holder = { db: initDatabaseIn(srcDir), userDataDir: srcDir }
  addTx(source.db, '2026-08-01', 100, '八月')
  addTx(source.db, '2026-09-09', 200, '九月')
  // 备份要放在**第三个**目录：放在 srcDir 里的话，下面清理 srcDir 会把它一起删掉
  const backupDir = tempDir()
  const backupPath = join(backupDir, 'HT记账-备份.db')
  await backupHandlers(
    ctxFor(source, { pickSavePath: async () => backupPath })
  ).exportDatabase()
  source.db.close()
  rmSync(srcDir, { recursive: true, force: true })

  const target: Holder = { db: initDatabaseIn(dir), userDataDir: dir }
  addTx(target.db, '2026-10-01', 300, '十月')

  const b = backupHandlers(ctxFor(target, { pickBackupPath: async () => backupPath }))
  const result = await b.pickRestoreFile()

  expect(result.ok).toBe(true)
  if (result.ok && result.value) {
    expect(result.value.backupCount).toBe(2)
    // 当前账本里有几笔也要给 —— 两个数字放一起才看得出选的是哪一份
    expect(result.value.currentCount).toBe(1)
    expect(result.value.firstDate).toBe('2026-08-01')
    expect(result.value.lastDate).toBe('2026-09-09')
    expect(result.value.fileName).toBe('HT记账-备份.db')
    // 替换前会自动另存一份，文件名要能显示给用户看
    expect(result.value.autoBackupFileName).toContain('导入前自动备份')
  }

  target.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('恢复之后主进程手里必须是**新**连接（守着旧连接的症状是「点了没反应」）', async () => {
  // 同上：备份必须来自另一个目录，否则两份账其实是同一份
  const srcDir = tempDir()
  const dir = tempDir()
  const source: Holder = { db: initDatabaseIn(srcDir), userDataDir: srcDir }
  addTx(source.db, '2026-08-01', 100, '八月')
  addTx(source.db, '2026-09-09', 200, '九月')
  // 备份要放在**第三个**目录：放在 srcDir 里的话，下面清理 srcDir 会把它一起删掉
  const backupDir = tempDir()
  const backupPath = join(backupDir, 'HT记账-备份.db')
  await backupHandlers(
    ctxFor(source, { pickSavePath: async () => backupPath })
  ).exportDatabase()
  source.db.close()
  rmSync(srcDir, { recursive: true, force: true })

  const target: Holder = { db: initDatabaseIn(dir), userDataDir: dir }
  addTx(target.db, '2026-10-01', 300, '十月')
  const oldDb = target.db

  // 恢复和分类走的是**同一个** holder，就是线上 ipc-register.ts 的样子
  const b = backupHandlers(ctxFor(target, { pickBackupPath: async () => backupPath }))
  const restored = await b.restore(backupPath)

  expect(restored.ok).toBe(true)
  if (restored.ok) expect(restored.value.count).toBe(2)
  // 用布尔比较而不是 expect(a).not.toBe(b)：vitest 在断言**失败**时要把两个对象
  // 打印出来做对比，而 print 一个已经关掉的 DatabaseSync 会抛「database is not open」，
  // 于是真正的原因（没换连接）被这条无关的错误盖掉，排查时会被带到沟里去。
  expect(target.db !== oldDb).toBe(true)

  // 旧连接必须已经被关掉，不然说明备份没真的换上去
  expect(() => oldDb.prepare('SELECT count(*) FROM transactions').get()).toThrow()

  // 新连接上读到的应该是备份里的数据
  expect(countIn(target.db)).toBe(2)

  // 恢复之前建好的处理器，此刻也必须能正常干活 —— 它每次现取 holder.db，
  // 拿到的就是新连接。抄在手里的话这里会失败（而界面上只看到「点了没反应」）。
  const t = transactionHandlers(() => target.db)
  const months = await t.months()
  expect(months.ok).toBe(true)
  if (months.ok) expect(months.value).toEqual(['2026-09', '2026-08'])

  target.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('打开数据文件夹失败时说中文，并把原文一起带上（那是唯一的排查线索）', async () => {
  const dir = tempDir()
  const holder: Holder = { db: initDatabaseIn(dir), userDataDir: dir }

  const b = backupHandlers(
    ctxFor(holder, {
      openDataFolder: async () => {
        throw new Error('EACCES: permission denied')
      }
    })
  )
  const result = await b.openDataFolder()

  expect(result.ok).toBe(false)
  if (!result.ok) {
    expect(result.message).toMatch(/[一-鿿]/)
    expect(result.message).toContain('EACCES: permission denied')
  }

  holder.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('备份通道名和界面契约对得上（写错通道名不会报错，只会静默失效）', () => {
  expect(BACKUP_CHANNELS.exportDatabase).toBe('backup:exportDatabase')
  expect(BACKUP_CHANNELS.exportCsv).toBe('backup:exportCsv')
  expect(BACKUP_CHANNELS.openDataFolder).toBe('backup:openDataFolder')
  expect(BACKUP_CHANNELS.pickRestoreFile).toBe('backup:pickRestoreFile')
  expect(BACKUP_CHANNELS.restore).toBe('backup:restore')
})

test('备份通道名唯一，且不与其它模块重名（跨模块重名会静默串线）', () => {
  const all = [
    ...Object.values(CATEGORY_CHANNELS),
    ...Object.values(TRANSACTION_CHANNELS),
    ...Object.values(STATS_CHANNELS),
    ...Object.values(BACKUP_CHANNELS)
  ]
  expect(new Set(all).size).toBe(all.length)
})
