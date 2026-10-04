/**
 * 备份、导出与恢复。
 *
 * 本文件不引入 electron（CLAUDE.md §5.3 的惯例）：路径一律由调用方传进来，
 * 测试可以拿临时目录跑，走的是和线上完全同一条代码路径。
 * 弹保存框、开文件夹那些「得让用户看见」的事在 src/main/ipc-register.ts 里做。
 */
import { copyFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DatabaseSync as Sqlite } from 'node:sqlite'
import { buildTransactionsCsv } from '@shared/csv'
import type { CsvTransactionRow } from '@shared/csv'
import { defaultDatabasePath, closeDatabase } from './connection'
import { initDatabaseIn } from './index'
import { MIGRATIONS } from './migrations'

/** 当前程序认识的最高结构版本。比它新的备份，这个版本读不懂。 */
const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * 整库导出成一个备份文件。
 *
 * ⚠️ 用 `VACUUM INTO` 而**不是**复制文件（CLAUDE.md §5.9）。数据库开了 WAL 模式，
 * 最近提交的内容可能还在 `-wal` 里没并进主文件 —— 直接复制 `.db` 会备份出
 * 一份「少了最近几笔账」的副本，而用户要到恢复的那天才发现，中间可能已经过了半年。
 * `VACUUM INTO` 是数据库自己导出的：带全部已提交数据、且是一致快照。
 *
 * 目标文件已存在时必须先删掉：`VACUUM INTO` 遇到已存在的文件会直接报错。
 * 走到这里之前，保存对话框已经问过用户「要替换吗」了 —— 在这儿再拦一次，
 * 等于让用户白回答一遍。
 */
export function exportDatabaseTo(db: DatabaseSync, destPath: string): void {
  rmSync(destPath, { force: true })
  // 路径用参数绑定传，不拼进 SQL 字符串：用户的文件名里可能有单引号
  // （比如「老王的'备份'.db」），拼字符串会拼出一条语法错误的 SQL。
  db.prepare('VACUUM INTO ?').run(destPath)
}

/**
 * 按可选的月份导出 CSV 文本。
 *
 * month 为 null 表示全部。日期从旧到新排 —— 导出来就是为了看，
 * 乱序的表没有可读性。
 *
 * 排序用 occurred_on, id 两个键：同一天记的多笔账按记账顺序排，
 * 且排序是**稳定**的，不会因为两次导出而换位置。
 */
export function csvText(db: DatabaseSync, month: string | null): string {
  const where = month === null ? '' : "WHERE substr(t.occurred_on, 1, 7) = ?"
  const sql = `
    SELECT t.occurred_on AS occurredOn,
           t.kind         AS kind,
           t.amount_fen   AS amountFen,
           t.note         AS note,
           t.payment_method AS paymentMethod,
           COALESCE(parent.name, minor.name) AS majorName,
           minor.name     AS minorName
      FROM transactions t
      JOIN categories minor  ON minor.id = t.category_id
      LEFT JOIN categories parent ON parent.id = minor.parent_id
      ${where}
     ORDER BY t.occurred_on ASC, t.id ASC`

  const rows = (
    month === null ? db.prepare(sql).all() : db.prepare(sql).all(month)
  ) as unknown as CsvTransactionRow[]

  return buildTransactionsCsv(rows)
}

export interface BackupInfo {
  /** 备份里有几笔账。 */
  readonly transactions: number
  /** 备份里有几个分类（含归档的）。 */
  readonly categories: number
  /** 最早一笔的日期 'YYYY-MM-DD'；一笔账都没有时是空串。 */
  readonly firstDate: string
  /** 最后一笔的日期。 */
  readonly lastDate: string
}

/**
 * 检查用户选中的文件到底是不是一份能用的备份。
 *
 * 用户在文件对话框里可以做任何事：选一张图片、选一个别的软件的数据库、
 * 选一个刚建了一半的文件。**这些都不该让程序崩掉或让账本受损**，
 * 所以每个环节都用中文说清楚哪里不对。
 *
 * 全程只读：`readOnly: true` 打开，看完就关，一个字节都不改。
 */
export function inspectBackupFile(path: string): BackupInfo {
  let probe: Sqlite
  try {
    probe = new Sqlite(path, { readOnly: true })
  } catch {
    throw new Error('这个文件不是 HT记账的备份文件，请选择导出时生成的 .db 文件。')
  }

  try {
    // SQLite 是「用到才读」的：打开一个 jpg 不会报错，直到真的去查表。
    // 所以这里必须实打实地查一次。
    let version: number
    let tables: { name: string }[]
    try {
      version = (probe.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
      tables = probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as unknown as { name: string }[]
    } catch {
      throw new Error('这个文件不是 HT记账的备份文件，请选择导出时生成的 .db 文件。')
    }

    const names = new Set(tables.map((t) => t.name))
    if (!names.has('transactions') || !names.has('categories')) {
      throw new Error('这个文件不是 HT记账的备份文件，请选择导出时生成的 .db 文件。')
    }

    if (version > LATEST_VERSION) {
      throw new Error(
        '这份备份来自更新版本的 HT记账，当前版本打不开它。请先把软件升级到最新版，再恢复。'
      )
    }

    const transactions = (
      probe.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }
    ).n
    const categories = (probe.prepare('SELECT count(*) AS n FROM categories').get() as { n: number })
      .n
    const range = probe
      .prepare('SELECT min(occurred_on) AS first, max(occurred_on) AS last FROM transactions')
      .get() as { first: string | null; last: string | null }

    return {
      transactions,
      categories,
      firstDate: range.first ?? '',
      lastDate: range.last ?? ''
    }
  } finally {
    probe.close()
  }
}

export interface RestoreInput {
  /** 数据目录（app.getPath('userData')）。 */
  readonly userDataDir: string
  /** 用户选中的备份文件。 */
  readonly backupPath: string
  /** 当前打开的连接。恢复过程中会被关掉。 */
  readonly currentDb: DatabaseSync
  /** 替换前自动另存的那一份的文件名（只是名字，不含目录）。 */
  readonly autoBackupName: string
}

/**
 * 用备份替换当前账本，返回**新的**数据库连接。
 *
 * ⚠️ 调用方必须把手里那个连接换成这个返回值 —— 它是一个全新的连接对象，
 * 旧的已经关了。忘了换的话，界面会一直读到「已经关闭的数据库」。
 *
 * 顺序刻意排成「先做完所有可能失败的检查，再动数据」：
 *
 *   1. 检查备份文件（不是备份 / 版本太新 → 在这里就抛错，账本一个字节没动）
 *   2. 把当前账本 `VACUUM INTO` 另存一份（后悔药）
 *   3. 关连接
 *   4. 复制到临时文件，再改名顶替（见下）
 *   5. 重开、迁移、播种
 *
 * 第 4 步为什么绕一圈：直接往主文件上覆盖，万一复制到一半失败（磁盘满、被占用），
 * 用户手上就只剩一个残缺的数据库了。**改名是原子的**：要么还是旧的完整文件，
 * 要么已经是新的完整文件，不存在「一半」。
 *
 * 还有一件必须做的事：删掉旧的 `-wal` / `-shm`。WAL 模式下它们是数据库的一部分，
 * 只换主文件、把它们留在原地，SQLite 会以为「主文件被换了、但 WAL 里还有没落盘的事务」，
 * 结果是新旧数据混在一起 —— 这种错乱**没有任何报错**，只是账目悄悄变得不对。
 */
export function restoreFromBackup({
  userDataDir,
  backupPath,
  currentDb,
  autoBackupName
}: RestoreInput): DatabaseSync {
  const dbPath = defaultDatabasePath(userDataDir)

  // 先做检查。这一步失败时，连接还开着、数据还没动 —— 用户挑错文件不该有任何代价。
  const info = inspectBackupFile(backupPath)

  if (normalize(backupPath) === normalize(dbPath)) {
    throw new Error('这就是当前正在使用的账本文件，不需要恢复。请选择之前导出的备份文件。')
  }

  // 后悔药：把当前账本完整导出到旁边。这一步失败就不往下走了 ——
  // 没有后悔药的替换，不如不做。
  exportDatabaseTo(currentDb, join(userDataDir, autoBackupName))

  closeDatabase(currentDb)

  // 旧的 WAL/SHM 必须清掉，理由见函数说明。
  //
  // ⚠️ 这两行是**防御性的，没有自动化测试覆盖**。平时干净关闭时 SQLite 自己就会
  // 把 -wal 收掉，所以正常路径下这里本来就没东西可删 —— 我试过写一条检查，
  // 结果证明是空转的（删掉这两行它照样通过）。真正要防的是「外部进程咬着 -wal
  // 导致 close() 删不掉」，那需要网盘/杀软的配合，脚本造不出来。
  // 留着是因为代价为零（文件不存在时 rmSync 什么都不做），而漏了的后果是
  // 新旧数据混在一起且**不报任何错**。
  rmSync(`${dbPath}-wal`, { force: true })
  rmSync(`${dbPath}-shm`, { force: true })

  const staging = `${dbPath}.restoring`
  rmSync(staging, { force: true })
  copyFileSync(backupPath, staging)
  renameSync(staging, dbPath)

  // 重开。initDatabaseIn 会顺便迁移到最新结构（所以旧版本的备份也能恢复）
  // 并补齐内置分类。
  const next = initDatabaseIn(userDataDir)

  // 兜底：万一备份里连一个分类都没有，账本就废了。恢复到这一步已经成功，
  // 不再回滚（原账本在后悔药里），但要让调用方知道这次恢复没得到可用的账本。
  const categories = (
    next.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }
  ).n
  if (categories === 0) {
    throw new Error(
      `备份文件已经换进来了，但它里面没有任何分类（只有 ${info.transactions} 笔账）。` +
        `原账本已另存为「${autoBackupName}」，可以在数据文件夹里找回来。`
    )
  }

  return next
}

/** 只是为了比较两个路径是不是同一个文件；Windows 上大小写不敏感。 */
function normalize(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase()
}

/**
 * 把 CSV 直接写成文件。UTF-8 编码 —— 内容开头已经带了 BOM（见 shared/csv.ts），
 * Excel 才认得出这是中文。
 */
export function writeCsvFile(db: DatabaseSync, month: string | null, destPath: string): void {
  writeFileSync(destPath, csvText(db, month), 'utf8')
}
