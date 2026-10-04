/**
 * 备份、导出与恢复。
 *
 * 本文件不引入 electron（CLAUDE.md §5.3 的惯例）：路径一律由调用方传进来，
 * 测试可以拿临时目录跑，走的是和线上完全同一条代码路径。
 * 弹保存框、开文件夹那些「得让用户看见」的事在 src/main/ipc-register.ts 里做。
 */
import { copyFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DatabaseSync as Sqlite } from 'node:sqlite'
import { buildTransactionsCsv } from '@shared/csv'
import type { CsvTransactionRow } from '@shared/csv'
import { defaultDatabasePath, closeDatabase } from './connection'
import { initDatabaseAt, initDatabaseIn, disposeDatabaseIn } from './index'
import { MIGRATIONS } from './migrations'

/** 当前程序认识的最高结构版本。比它新的备份，这个版本读不懂。 */
const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

/**
 * 用户选错了文件时统一的那句话。
 *
 * 抽成一个常量是因为它有**三个**使用点：体检打不开文件、体检查不动表、
 * 试装失败（见 assertBackupLoadable）。三处说的必须是同一件事 ——
 * 都是「这文件不是我们的备份」。
 */
const NOT_A_BACKUP = '这个文件不是 HT记账的备份文件，请选择导出时生成的 .db 文件。'

/**
 * 只在文件内部流转：标出「这条错误是我们自己抛的」，好让兜底的 catch 放行。
 *
 * 为什么需要：体检里那一串查询（count、min/max）要包在 try 里兜住
 * SQLite 的英文报错（外来库可能连列都没有）。但 try 里同时还有两条我们自己
 * 精心写好的中文提示 —— 不标一下就一起被兜掉了，用户看到的是
 * 「不是 HT记账的备份文件」，而他手上的明明是「更新版本的备份」。
 */
class BackupRejected extends Error {}

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
 * 最后那一步「试装」会往临时目录里复制一份 —— 那也不是原始文件，
 * 用户选中的那个文件始终一个字节都不动。
 */
export function inspectBackupFile(path: string): BackupInfo {
  let probe: Sqlite
  try {
    probe = new Sqlite(path, { readOnly: true })
  } catch {
    throw new Error(NOT_A_BACKUP)
  }

  try {
    // SQLite 是「用到才读」的：打开一个 jpg 不会报错，直到真的去查表。
    // 所以下面必须实打实地把要用到的每一列都查一次 —— **包括 select 里写到的列名**：
    // 别的软件导出的库常常也有 transactions / categories 两张表，但没有 occurred_on。
    //
    // 这一整块（含下面两次「我们自己抛的中文错误」）都包在同一个 try 里：
    // 中间任何一句 SQL 抛英文错，出来都得是同一句人话。
    try {
      const version = (probe.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version
      const tables = probe
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as unknown as { name: string }[]

      const names = new Set(tables.map((t) => t.name))
      if (!names.has('transactions') || !names.has('categories')) {
        throw new BackupRejected(NOT_A_BACKUP)
      }

      if (version > LATEST_VERSION) {
        throw new BackupRejected(
          '这份备份来自更新版本的 HT记账，当前版本打不开它。请先把软件升级到最新版，再恢复。'
        )
      }

      const transactions = (
        probe.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }
      ).n
      const categories = (
        probe.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }
      ).n
      const range = probe
        .prepare('SELECT min(occurred_on) AS first, max(occurred_on) AS last FROM transactions')
        .get() as { first: string | null; last: string | null }

      // 上面这些查得动，只说明「**像一个**备份」；能不能真的装起来是另一回事。
      // 「表名对得上、结构不是我们的」库正是在这一步现形的。
      //
      // 为什么必须在**这里**（选文件的当下）就拦住，而不是等用户点了「替换」：
      // 拦晚了的话，用户会先看到一遍「备份里有 N 笔 / 当前有 M 笔」并按下确认，
      // 然后才被告知这个文件根本用不了 —— 等于让他为一个不可能发生的替换
      // 白确认了一次。产品设计文档 §3.5 承诺的是「选错文件不会有事」，
      // 那就应该**在选中的那一刻**就说清楚。
      assertBackupLoadable(path)

      return {
        transactions,
        categories,
        firstDate: range.first ?? '',
        lastDate: range.last ?? ''
      }
    } catch (error) {
      if (error instanceof BackupRejected) throw error
      throw new Error(NOT_A_BACKUP)
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
 *   1. 体检：不是备份 / 版本太新 / 就是账本自己 / **装不起来** → 在这里就抛错，
 *      账本一个字节没动
 *   2. 把当前账本 `VACUUM INTO` 另存一份（后悔药）
 *   3. 关连接
 *   4. 复制到临时文件，再改名顶替（见下）
 *   5. 重开、迁移、播种
 *
 * 「装不起来」这一关（试装）是 2026-10-04 独立复核之后补的，别删。原来的顺序是
 * 「体检 → 换文件 → 打开」，体检只看表名，于是「有两张同名的表、结构却完全不是
 * 我们的」库会一路放行到第 4 步；等第 5 步迁移撞上「table categories already exists」
 * 时，账本文件**已经被换掉了**，用户下次启动软件直接打不开，只能手工去数据目录里
 * 把后悔药改名顶替回来。
 *
 * 它现在在 inspectBackupFile 里面（见 assertBackupLoadable），所以本函数第 1 步
 * 那一句调用就把它一起做了 —— 而且界面在**预览**阶段就调过一次同样的体检，
 * 用户根本走不到这儿。
 *
 * 第 5 步为什么绕一圈：直接往主文件上覆盖，万一复制到一半失败（磁盘满、被占用），
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

  if (samePath(backupPath, dbPath)) {
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

/**
 * 试装一遍：把备份复制到一个**一次性副本**上，真的「打开 → 迁移 → 播种」走通。
 *
 * 光靠前面那些查询不够。它们只查得出「压根不是备份」（缺表、不是数据库、
 * 版本太新）；而「有两张同名的表、结构却完全不是我们的」库 —— 别的软件导出的
 * 数据库、结构不同的旧库都可能长这样 —— 会**顺利放行**。
 *
 * 放行的后果很重：恢复的顺序是「先换文件、再打开」，等迁移撞上
 * 「table categories already exists」时，账本文件已经是那个外来库了，
 * 用户关掉软件就再也打不开。所以规则是 ——
 * **先在一份不重要的副本上把风险走完，确认走得通，再去碰真数据。**
 *
 * 由 inspectBackupFile 在最后调用（2026-10-04 独立复核之后从 restoreFromBackup
 * 挪过去的）：这样**选中文件的当下**就会拒绝，而不是等用户点完「替换」。
 *
 * 副本连它自己的 `-wal` / `-shm` 一起删掉。这里没有「删了会不会丢数据」的顾虑：
 * 那是一份用完就扔的拷贝，**真数据一个字节都还没动**。
 */
function assertBackupLoadable(backupPath: string): void {
  const scratch = mkdtempSync(join(tmpdir(), 'ht-restore-check-'))
  try {
    const copy = join(scratch, 'check.db')
    copyFileSync(backupPath, copy)
    // 迁移失败时 initDatabaseAt 自己会把连接关掉再往上抛，不会漏一个句柄。
    disposeDatabaseIn(initDatabaseAt(copy))
  } catch {
    throw new Error(NOT_A_BACKUP)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** 两个路径是不是指同一个文件。Windows 上大小写不敏感，一律转成小写斜杠比较。 */
export function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/**
 * 拦住「把当前正在使用的账本文件当作导出的目标」。
 *
 * 导出的第一步是 `rmSync(destPath)`。「另存为」对话框的**默认目录就是数据目录**
 * （见 src/main/ipc-register.ts），用户只要把文件名打成 `ht-jizhang.db`，
 * 目标就指到账本自己身上了。
 *
 * Windows 上删一个正被打开的文件会失败，没有损害；**macOS / Linux 上会真的把它
 * unlink 掉** —— 之后数据库继续往那个已经不存在名字的 inode 里写，重启之后
 * 最近记的账全部消失，而且**全程没有任何报错**。
 *
 * CSV 导出也要过这一关：那边虽然不 rmSync，但 writeFileSync 同样是把它整个覆盖掉。
 */
export function assertNotLiveLedger(path: string, userDataDir: string): void {
  if (samePath(path, defaultDatabasePath(userDataDir))) {
    throw new Error(
      '这是当前正在使用的账本文件，不能把它本身当作导出的目标。请换个文件名或换个文件夹。'
    )
  }
}

/**
 * 把 CSV 直接写成文件。UTF-8 编码 —— 内容开头已经带了 BOM（见 shared/csv.ts），
 * Excel 才认得出这是中文。
 */
export function writeCsvFile(db: DatabaseSync, month: string | null, destPath: string): void {
  writeFileSync(destPath, csvText(db, month), 'utf8')
}
