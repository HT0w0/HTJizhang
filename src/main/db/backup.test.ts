import { test, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { initDatabaseIn, disposeDatabaseIn } from './index'
import { defaultDatabasePath } from './connection'
import { createTransaction } from './transactions'
import { MIGRATIONS } from './migrations'
import {
  assertNotLiveLedger,
  csvText,
  exportDatabaseTo,
  inspectBackupFile,
  restoreFromBackup
} from './backup'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ht-backup-'))
}

function idOf(db: DatabaseSync, key: string): number {
  return (db.prepare('SELECT id FROM categories WHERE builtin_key = ?').get(key) as { id: number })
    .id
}

function countOf(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
}

/** 建一个装了 n 笔账的账本，返回目录和连接。 */
function ledgerWith(n: number, dir = tempDir()): { dir: string; db: DatabaseSync } {
  const db = initDatabaseIn(dir)
  for (let i = 0; i < n; i += 1) {
    createTransaction(db, {
      kind: i % 2 === 0 ? 'expense' : 'income',
      amountFen: 100 * (i + 1),
      categoryId: idOf(db, i % 2 === 0 ? 'expense/餐饮/午餐' : 'income/工资薪酬/月薪'),
      occurredOn: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`,
      note: `第 ${i + 1} 笔`,
      paymentMethod: 'wechat'
    })
  }
  return { dir, db }
}

// ---------------------------------------------------------------------------
// 导出备份文件
// ---------------------------------------------------------------------------

test('导出的备份能被当成一个独立账本打开，笔数一模一样', () => {
  const { dir, db } = ledgerWith(3)
  const dest = join(dir, '备份.db')

  exportDatabaseTo(db, dest)

  const copy = new DatabaseSync(dest)
  expect(countOf(copy)).toBe(3)
  expect((copy.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }).n).toBe(96)
  copy.close()
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('目标文件已经存在时能覆盖（用户在保存框里已经点过「替换」了，这里再报错就是白问一次）', () => {
  const { dir, db } = ledgerWith(2)
  const dest = join(dir, '备份.db')
  writeFileSync(dest, '我不是数据库，我是占位的')

  exportDatabaseTo(db, dest)

  const copy = new DatabaseSync(dest)
  expect(countOf(copy)).toBe(2)
  copy.close()
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('导出不改动原账本（备份是只读地「拷一份出来」）', () => {
  const { dir, db } = ledgerWith(3)
  exportDatabaseTo(db, join(dir, '备份.db'))
  expect(countOf(db)).toBe(3)
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 导出 CSV
// ---------------------------------------------------------------------------

test('CSV 里写的是分类的名字，不是 id（用户拿着表看不懂 17 是什么）', () => {
  const { dir, db } = ledgerWith(2)
  const text = csvText(db, null)
  expect(text).toContain('餐饮')
  expect(text).toContain('午餐')
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('CSV 按日期从旧到新排（导出来就是为了看的，乱序的表没法看）', () => {
  const { dir, db } = ledgerWith(3)
  const text = csvText(db, null)
  const dates = text
    .split('\r\n')
    .slice(1)
    .filter((l) => l !== '')
    .map((l) => l.split(',')[0])
  expect(dates).toEqual([...dates].sort())
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('指定月份时只导出那个月', () => {
  const dir = tempDir()
  const db = initDatabaseIn(dir)
  createTransaction(db, {
    kind: 'expense',
    amountFen: 100,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-09-15',
    note: '九月的',
    paymentMethod: 'cash'
  })
  createTransaction(db, {
    kind: 'expense',
    amountFen: 200,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-15',
    note: '十月的',
    paymentMethod: 'cash'
  })

  const text = csvText(db, '2026-09')
  expect(text).toContain('九月的')
  expect(text).not.toContain('十月的')
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('一句话都不写备注的账单，在 CSV 里就是空着的，不会写上 null 或 undefined', () => {
  const dir = tempDir()
  const db = initDatabaseIn(dir)
  createTransaction(db, {
    kind: 'expense',
    amountFen: 100,
    categoryId: idOf(db, 'expense/餐饮/午餐'),
    occurredOn: '2026-10-15',
    note: '',
    paymentMethod: 'cash'
  })
  const text = csvText(db, null)
  expect(text).not.toContain('null')
  expect(text).not.toContain('undefined')
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 检查用户选的文件到底是不是一份备份
// ---------------------------------------------------------------------------

test('认出「这压根不是数据库文件」，并说人话', () => {
  const dir = tempDir()
  const fake = join(dir, '照片.jpg')
  writeFileSync(fake, '这不是数据库，只是一段文字')
  expect(() => inspectBackupFile(fake)).toThrow(/不是 HT记账的备份文件/)
  rmSync(dir, { recursive: true, force: true })
})

test('认出「是数据库，但不是我们的账本」（缺表）', () => {
  const dir = tempDir()
  const other = join(dir, '别的.db')
  const otherDb = new DatabaseSync(other)
  otherDb.exec('CREATE TABLE foo (id INTEGER PRIMARY KEY)')
  otherDb.close()

  expect(() => inspectBackupFile(other)).toThrow(/不是 HT记账的备份文件/)
  rmSync(dir, { recursive: true, force: true })
})

test('认出「来自更新版本的备份」并拒绝（当前版本读不懂将来的结构）', () => {
  const { dir, db } = ledgerWith(1)
  const dest = join(dir, '来自未来.db')
  exportDatabaseTo(db, dest)

  const future = new DatabaseSync(dest)
  future.exec(`PRAGMA user_version = ${MIGRATIONS[MIGRATIONS.length - 1].version + 1}`)
  future.close()

  expect(() => inspectBackupFile(dest)).toThrow(/更新版本/)
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('检查结果里有笔数和日期范围，用户靠它判断选没选错文件', () => {
  const { dir, db } = ledgerWith(3)
  const dest = join(dir, '备份.db')
  exportDatabaseTo(db, dest)

  const info = inspectBackupFile(dest)
  expect(info.transactions).toBe(3)
  expect(info.categories).toBe(96)
  expect(info.firstDate).toBe('2026-10-01')
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

test('检查是只读的：看完之后备份文件一个字节都没变', () => {
  const { dir, db } = ledgerWith(2)
  const dest = join(dir, '备份.db')
  exportDatabaseTo(db, dest)
  const before = readFileSync(dest)

  inspectBackupFile(dest)

  expect(readFileSync(dest).equals(before)).toBe(true)
  disposeDatabaseIn(db)
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 恢复：用备份替换当前账本
// ---------------------------------------------------------------------------

test('恢复之后，账本里就是备份里的内容', () => {
  const source = ledgerWith(5)
  const dest = join(source.dir, '备份.db')
  exportDatabaseTo(source.db, dest)
  disposeDatabaseIn(source.db)

  const target = ledgerWith(2, tempDir())
  const next = restoreFromBackup({
    userDataDir: target.dir,
    backupPath: dest,
    currentDb: target.db,
    autoBackupName: 'HT记账-导入前自动备份-2026-10-04-153012.db'
  })

  expect(countOf(next)).toBe(5)
  disposeDatabaseIn(next)
  rmSync(source.dir, { recursive: true, force: true })
  rmSync(target.dir, { recursive: true, force: true })
})

test('替换前自动把当前账本另存了一份（选错文件时的后悔药）', () => {
  const source = ledgerWith(5)
  const dest = join(source.dir, '备份.db')
  exportDatabaseTo(source.db, dest)
  disposeDatabaseIn(source.db)

  const target = ledgerWith(2, tempDir())
  const name = 'HT记账-导入前自动备份-2026-10-04-153012.db'
  const next = restoreFromBackup({
    userDataDir: target.dir,
    backupPath: dest,
    currentDb: target.db,
    autoBackupName: name
  })

  const saved = join(target.dir, name)
  expect(existsSync(saved)).toBe(true)
  const savedDb = new DatabaseSync(saved)
  expect(countOf(savedDb)).toBe(2) // 是**替换前**那 2 笔，不是备份里的 5 笔
  savedDb.close()
  disposeDatabaseIn(next)
  rmSync(source.dir, { recursive: true, force: true })
  rmSync(target.dir, { recursive: true, force: true })
})

test('恢复后能正常记账（不是换了个只能读的死库）', () => {
  const source = ledgerWith(1)
  const dest = join(source.dir, '备份.db')
  exportDatabaseTo(source.db, dest)
  disposeDatabaseIn(source.db)

  const target = ledgerWith(1, tempDir())
  const next = restoreFromBackup({
    userDataDir: target.dir,
    backupPath: dest,
    currentDb: target.db,
    autoBackupName: '自动备份.db'
  })

  createTransaction(next, {
    kind: 'expense',
    amountFen: 999,
    categoryId: idOf(next, 'expense/餐饮/晚餐'),
    occurredOn: '2026-10-20',
    note: '恢复之后记的',
    paymentMethod: 'cash'
  })
  expect(countOf(next)).toBe(2)
  disposeDatabaseIn(next)
  rmSync(source.dir, { recursive: true, force: true })
  rmSync(target.dir, { recursive: true, force: true })
})

// 这里**原本有一条**「恢复时会清掉残留的 -wal」的检查，已删除。
//
// 为什么删：那个状态在测试里造不出来。干净关闭时 SQLite 自己会把 -wal 收掉，
// 所以「关掉连接再看还有没有 -wal」永远为假 —— 实测把 backup.ts 里清 -wal 那行
// 删掉，它照样绿（典型空转检查）。而人为往 -wal 里写垃圾又会让**正在使用中的连接**
// 出问题（VACUUM INTO 读的就是那个文件），测出来的是别的东西。
//
// 真正要防的场景是「外部进程咬着 -wal，导致 close() 删不掉它」——
// 那是操作系统层面的事，脚本模拟不了。所以那两行 rmSync 是**防御性的、
// 没有自动化测试覆盖**，靠这段说明和代码注释保证，见 docs/开发记录.md。

test('用户选中的就是当前正在用的那个文件时，拒绝并说清楚', () => {
  const target = ledgerWith(2, tempDir())
  expect(() =>
    restoreFromBackup({
      userDataDir: target.dir,
      backupPath: defaultDatabasePath(target.dir),
      currentDb: target.db,
      autoBackupName: '自动备份.db'
    })
  ).toThrow(/正在使用/)
  disposeDatabaseIn(target.db)
  rmSync(target.dir, { recursive: true, force: true })
})

test('选中的文件根本不是备份时，账本原封不动（失败要停在动数据之前）', () => {
  const target = ledgerWith(2, tempDir())
  const fake = join(target.dir, '随便一个文件.db')
  writeFileSync(fake, '不是数据库')

  expect(() =>
    restoreFromBackup({
      userDataDir: target.dir,
      backupPath: fake,
      currentDb: target.db,
      autoBackupName: '自动备份.db'
    })
  ).toThrow()

  // 关键：连接没被关掉、数据还在。用户挑错文件不该有任何代价。
  expect(countOf(target.db)).toBe(2)
  disposeDatabaseIn(target.db)
  rmSync(target.dir, { recursive: true, force: true })
})

test('备份来自更新版本时，账本也原封不动', () => {
  const source = ledgerWith(1)
  const dest = join(source.dir, '备份.db')
  exportDatabaseTo(source.db, dest)
  disposeDatabaseIn(source.db)

  const future = new DatabaseSync(dest)
  future.exec(`PRAGMA user_version = ${MIGRATIONS[MIGRATIONS.length - 1].version + 1}`)
  future.close()

  const target = ledgerWith(2, tempDir())
  expect(() =>
    restoreFromBackup({
      userDataDir: target.dir,
      backupPath: dest,
      currentDb: target.db,
      autoBackupName: '自动备份.db'
    })
  ).toThrow(/更新版本/)
  expect(countOf(target.db)).toBe(2)

  disposeDatabaseIn(target.db)
  rmSync(source.dir, { recursive: true, force: true })
  rmSync(target.dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 「长得像备份」的文件
//
// 独立复核（2026-10-04）在这里抓到一个真问题。造一个库：表名对得上、
// `user_version` 是 0（任何别的软件导出的库都可能长这样），但结构不是我们的。
// 旧实现里它**过得去体检**（有 transactions / categories，count 和 occurred_on
// 也查得动），于是恢复流程会先把账本文件换掉，之后 initDatabaseIn 迁移时才撞上
// 「table categories already exists」而失败 —— 此时账本文件已经是那个外来库了，
// **关掉软件就再也打不开**，只能手工去数据目录里把后悔药改名顶替回来。
// 用户不懂电脑，这一步等于不会。产品设计文档 §3.5 明确承诺「选错文件不会有事」。
// ---------------------------------------------------------------------------

/**
 * 造一个「表名对得上、但结构完全不是我们的」库。
 *
 * 它是这一组里**最难认**的一种：表名齐、`user_version` 是 0（别的软件导出的库
 * 都长这样）、`count(*)` 和 `min/max(occurred_on)` 也查得动。只有真的拿它
 * 「打开 → 迁移」一遍才会现形（migrate 会 CREATE TABLE categories，撞上「已存在」）。
 */
function foreignButPlausibleDb(path: string): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, occurred_on TEXT)')
  db.exec('CREATE TABLE categories (id INTEGER PRIMARY KEY, label TEXT)')
  db.close()
}

/** 连 occurred_on 都没有的外来库：它连体检都过不去。 */
function foreignDbWithWrongColumns(path: string): void {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount TEXT)')
  db.exec('CREATE TABLE categories (id INTEGER PRIMARY KEY, label TEXT)')
  db.close()
}

test('有两张表但列对不上的文件，体检就说人话（不能漏出英文的 no such column）', () => {
  const dir = tempDir()
  const foreign = join(dir, '外来.db')
  foreignDbWithWrongColumns(foreign)

  expect(() => inspectBackupFile(foreign)).toThrow(/不是 HT记账的备份文件/)
  rmSync(dir, { recursive: true, force: true })
})

test('长得像备份、其实装不起来的文件：选中的那一刻就被拒绝，账本一个字节都不能动', () => {
  const target = ledgerWith(2, tempDir())
  const foreignDir = tempDir()
  const foreign = join(foreignDir, '外来.db')
  foreignButPlausibleDb(foreign)

  // 前提先钉住：这类文件在**体检这一步**（也就是用户选完文件的当下）就被拒。
  // 旧实现是「体检放行、等用户点了『替换』才失败」—— 那样用户会先读到一遍
  // 「备份里有 0 笔 / 当前有 2 笔」并按下确认，然后才知道这个文件根本用不了，
  // 等于让他为一个不可能发生的替换白确认一次。这条断言钉住的就是「拦在选文件那一步」。
  expect(() => inspectBackupFile(foreign)).toThrow(/不是 HT记账的备份文件/)

  expect(() =>
    restoreFromBackup({
      userDataDir: target.dir,
      backupPath: foreign,
      currentDb: target.db,
      autoBackupName: '自动备份.db'
    })
  ).toThrow(/不是 HT记账的备份文件/)

  // 连接还开着、数据还在 —— 失败必须停在动数据之前。
  expect(countOf(target.db)).toBe(2)
  disposeDatabaseIn(target.db)

  // 而且重开之后账本能正常用。旧实现恰恰死在下一步：关掉软件就再也打不开。
  const reopened = initDatabaseIn(target.dir)
  expect(countOf(reopened)).toBe(2)
  disposeDatabaseIn(reopened)

  rmSync(target.dir, { recursive: true, force: true })
  rmSync(foreignDir, { recursive: true, force: true })
})

test('体检没过时，数据目录里不留任何残渣（下次恢复不能被上一次的临时文件影响）', () => {
  const target = ledgerWith(2, tempDir())
  const foreignDir = tempDir()
  const foreign = join(foreignDir, '外来.db')
  foreignButPlausibleDb(foreign)

  expect(() =>
    restoreFromBackup({
      userDataDir: target.dir,
      backupPath: foreign,
      currentDb: target.db,
      autoBackupName: '自动备份.db'
    })
  ).toThrow()

  disposeDatabaseIn(target.db)
  // 只剩账本自己。既不该留临时文件，也不该白写一份后悔药。
  expect(readdirSync(target.dir)).toEqual([defaultDatabasePath(target.dir).split(/[\\/]/).pop()])

  rmSync(target.dir, { recursive: true, force: true })
  rmSync(foreignDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 导出时不许往「正在使用的账本」上写
//
// exportDatabaseTo 的第一步是 rmSync(destPath)。而「另存为」对话框的**默认目录
// 就是数据目录**（见 src/main/ipc-register.ts），用户只要把文件名打成
// ht-jizhang.db 就会指向账本自己。
// Windows 上 rmSync 打开中的文件会失败，没有损害；macOS/Linux 上会真的把它
// unlink 掉 —— 之后写入落到已删除的 inode，重启后最近记的账全部消失。
// ---------------------------------------------------------------------------

test('导出目标就是正在使用的账本文件时，拒绝并说清楚', () => {
  const target = ledgerWith(2, tempDir())

  expect(() => assertNotLiveLedger(defaultDatabasePath(target.dir), target.dir)).toThrow(
    /正在使用/
  )
  // 换个名字（同一目录）不受影响 —— 拦的是文件本身，不是目录。
  expect(() => assertNotLiveLedger(join(target.dir, '备份.db'), target.dir)).not.toThrow()

  // 拦住之后账本还完好。
  expect(countOf(target.db)).toBe(2)
  disposeDatabaseIn(target.db)
  rmSync(target.dir, { recursive: true, force: true })
})
