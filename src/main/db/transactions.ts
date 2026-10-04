/**
 * 账单仓储。
 *
 * 校验分两层：本文件负责给出用户能看懂的中文提示，
 * 数据库的两个触发器负责兜底（只能挂二级小类、收支类型必须一致）——
 * 触发器抛的是英文（"账单必须挂在二级小类上…" 虽然也是中文，但
 * 一旦将来触发条件变了，底层错误不会自动变成用户能读的话），
 * 所以所有正常的失败路径都必须在到达数据库之前就拦下来。
 */
import type { DatabaseSync } from 'node:sqlite'
import type {
  CategoryKind,
  CreateTransactionInput,
  ListTransactionsInput,
  PaymentMethod,
  Transaction,
  TransactionListItem,
  UpdateTransactionInput
} from '@shared/types'
import { isValidLocalDate } from '@shared/localDate'
import { monthRange } from '@shared/month'
import { escapeLikePattern, normalizeKeyword } from '@shared/transactionList'
import { isPaymentMethod } from '@shared/paymentMethods'
import { withTransaction } from './transaction'

/** 备注长度上限。超了界面一屏显示不下，账单列表会被撑开。 */
export const MAX_NOTE_LENGTH = 200

interface TransactionRow {
  id: number
  kind: string
  amount_fen: number
  category_id: number
  occurred_on: string
  note: string
  payment_method: string
  created_at: string
  updated_at: string
}

const COLUMNS =
  'id, kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at'

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    kind: row.kind as CategoryKind,
    amountFen: row.amount_fen,
    categoryId: row.category_id,
    occurredOn: row.occurred_on,
    note: row.note,
    paymentMethod: row.payment_method as PaymentMethod,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * 备注清洗：去掉首尾空白，把换行与连续空白压成一个空格。
 *
 * 压换行是因为账单列表里一笔账只占一行，存了换行会把行高撑开。
 */
function normalizeNote(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/**
 * 校验分类 id：必须存在、必须是二级小类、必须没被归档、收支类型必须一致。
 *
 * 这四条数据库的触发器都会再查一遍，但那里抛出的是底层错误，
 * 所以必须在进库之前用中文拦下来。四条分开判，是为了让提示各不相同——
 * 「请选到更具体的小类」和「所选的分类已被删除」对用户来说是完全不同的两件事。
 */
function validateCategory(db: DatabaseSync, categoryId: number, kind: CategoryKind): void {
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    throw new Error('请先选择一个分类')
  }

  const row = db
    .prepare('SELECT parent_id, kind, is_archived FROM categories WHERE id = ?')
    .get(categoryId) as { parent_id: number | null; kind: string; is_archived: number } | undefined

  if (!row) throw new Error('所选的分类不存在，可能已经被删除了')
  if (row.is_archived === 1) throw new Error('所选的分类已被删除，请重新选一个')
  if (row.parent_id === null) throw new Error('请选到更具体的小类，不能只选大类')
  if (row.kind !== kind) {
    throw new Error(kind === 'expense' ? '支出不能记在收入分类下' : '收入不能记在支出分类下')
  }
}

/**
 * 新建和编辑共用的字段校验。所有失败都抛中文。
 *
 * 返回值是**洗好的备注** —— 校验的最后一步就是洗备注，顺手返回省得调用方再洗一遍；
 * 两处各洗一次的话，早晚会出现「新建洗了、编辑忘了」这种只有一边干净的情况。
 */
function validateFields(
  db: DatabaseSync,
  fields: {
    readonly amountFen: number
    readonly categoryId: number
    readonly kind: CategoryKind
    readonly occurredOn: string
    readonly paymentMethod: PaymentMethod
    readonly note: string
  }
): string {
  // ---- 金额 ----
  if (!Number.isInteger(fields.amountFen)) {
    throw new Error('金额必须是整数分（内部错误：收到了小数）')
  }
  if (fields.amountFen <= 0) {
    throw new Error('金额必须大于 0')
  }

  // ---- 分类 ----
  validateCategory(db, fields.categoryId, fields.kind)

  // ---- 日期 ----
  if (!isValidLocalDate(fields.occurredOn)) {
    throw new Error(`日期格式不对，应该是 2026-10-03 这样（收到「${fields.occurredOn}」）`)
  }

  // ---- 支付方式 ----
  if (!isPaymentMethod(fields.paymentMethod)) {
    throw new Error('支付方式不对，请重新选一个')
  }

  // ---- 备注 ----
  const note = normalizeNote(fields.note)
  if (note.length > MAX_NOTE_LENGTH) {
    throw new Error(`备注最多 ${MAX_NOTE_LENGTH} 个字，现在有 ${note.length} 个`)
  }
  return note
}

export function createTransaction(db: DatabaseSync, input: CreateTransactionInput): Transaction {
  return withTransaction(db, () => {
    const note = validateFields(db, input)

    const timestamp = nowIso()
    const result = db
      .prepare(
        `INSERT INTO transactions
           (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.kind,
        input.amountFen,
        input.categoryId,
        input.occurredOn,
        note,
        input.paymentMethod,
        timestamp,
        timestamp
      )

    const created = getTransaction(db, Number(result.lastInsertRowid))
    if (!created) throw new Error('记账失败，请重试')
    return created
  })
}

export function getTransaction(db: DatabaseSync, id: number): Transaction | undefined {
  const row = db.prepare(`SELECT ${COLUMNS} FROM transactions WHERE id = ?`).get(id) as unknown as
    | TransactionRow
    | undefined
  return row ? toTransaction(row) : undefined
}

/** 「最近用过」默认取多少个。20 个足够覆盖日常，也不会让 SQL 变重。 */
export const DEFAULT_RECENT_LIMIT = 20

/**
 * 最近用过的分类 id，最近的在最前。
 *
 * 一个分类记过多次时只出现一次，按**最后一次**记的时间算 ——
 * 这样才符合直觉：上周常记、这周没记的分类会自然往后排。
 *
 * created_at 是 ISO 8601 串，字典序与时间序一致，所以 MAX / ORDER BY 直接可用。
 */
export function recentCategoryIds(db: DatabaseSync, limit = DEFAULT_RECENT_LIMIT): number[] {
  const rows = db
    .prepare(
      `SELECT category_id
         FROM transactions
        GROUP BY category_id
        ORDER BY MAX(created_at) DESC
        LIMIT ?`
    )
    .all(limit) as unknown as Array<{ category_id: number }>
  return rows.map((r) => r.category_id)
}

// ---------------------------------------------------------------------------
// 账单列表：查 / 改 / 删 / 有账的月份
// ---------------------------------------------------------------------------

/**
 * 列表查询要带的列：账单本身 + 小类名 + 大类名 + 大类图标。
 *
 * 带表别名（t. / c. / p.）是必需的 —— 这个查询 JOIN 了两次 categories，
 * 不带别名的 id / name / kind 会有歧义。
 */
const LIST_COLUMNS = `t.id, t.kind, t.amount_fen, t.category_id, t.occurred_on,
      t.note, t.payment_method, t.created_at, t.updated_at,
      c.name AS category_name,
      p.name AS major_name,
      p.icon AS major_icon`

interface ListRow extends TransactionRow {
  category_name: string
  major_name: string
  major_icon: string
}

function toListItem(row: ListRow): TransactionListItem {
  return {
    ...toTransaction(row),
    categoryName: row.category_name,
    majorName: row.major_name,
    majorIcon: row.major_icon
  }
}

/**
 * 按月查账单，可加收支筛选和关键词搜索。
 *
 * 三个条件之间是「并且」：
 * - month：日期落在 [当月 1 日, 当月最后一天] 之间。用字符串比较就够了 ——
 *   'YYYY-MM-DD' 的字典序就是时间序，不需要任何日期函数转换。
 * - kind：'all' 时不加这条。
 * - keyword：同时匹配备注、小类名、大类名。搜索词里的 % 和 _ **必须转义**，
 *   并在 SQL 里声明 ESCAPE '\'，否则用户搜「50%」会把全部账单都搜出来。
 *
 * ⚠️ 不过滤 is_archived：归档的分类不该出现在记账选择器里，
 * 但它名下的历史账单必须照常显示，否则用户一归档分类，账单就凭空消失了（§5.11）。
 *
 * ⚠️ SQL 用字符串拼接而参数用 ? 绑定：拼进去的**只有固定片段**，
 * 用户输入全部走 ? 绑定，不存在注入问题；条件个数不固定，只能这样拼。
 */
export function listTransactions(
  db: DatabaseSync,
  input: ListTransactionsInput
): TransactionListItem[] {
  const { start, end } = monthRange(input.month)

  let sql = `SELECT ${LIST_COLUMNS}
               FROM transactions t
               JOIN categories c ON c.id = t.category_id
               JOIN categories p ON p.id = c.parent_id
              WHERE t.occurred_on >= ? AND t.occurred_on <= ?`
  const params: string[] = [start, end]

  if (input.kind !== 'all') {
    sql += ' AND t.kind = ?'
    params.push(input.kind)
  }

  const keyword = normalizeKeyword(input.keyword)
  if (keyword !== '') {
    const like = `%${escapeLikePattern(keyword)}%`
    sql += ` AND (t.note LIKE ? ESCAPE '\\'
                OR c.name LIKE ? ESCAPE '\\'
                OR p.name LIKE ? ESCAPE '\\')`
    params.push(like, like, like)
  }

  sql += ' ORDER BY t.occurred_on DESC, t.id DESC'

  const rows = db.prepare(sql).all(...params) as unknown as ListRow[]
  return rows.map(toListItem)
}

/** 改一笔账。走与新建完全相同的校验；任何一步失败都整笔回滚、原样不动。 */
export function updateTransaction(db: DatabaseSync, input: UpdateTransactionInput): Transaction {
  return withTransaction(db, () => {
    if (getTransaction(db, input.id) === undefined) {
      throw new Error('这笔账不存在，可能已经被删除了')
    }

    const note = validateFields(db, input)

    db.prepare(
      `UPDATE transactions
          SET kind = ?, amount_fen = ?, category_id = ?, occurred_on = ?,
              note = ?, payment_method = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      input.kind,
      input.amountFen,
      input.categoryId,
      input.occurredOn,
      note,
      input.paymentMethod,
      nowIso(),
      input.id
    )

    const updated = getTransaction(db, input.id)
    if (!updated) throw new Error('修改失败，请重试')
    return updated
  })
}

/**
 * 删一笔账。
 *
 * 删不存在的账单要**报错**而不是静默成功 —— 静默成功会让用户以为删掉了，
 * 界面上那一行也确实消失（因为列表会刷新），但他删的可能是刚被别人删掉的那笔，
 * 或者界面上残留的过期 id，这时一句「已删除」就是假话。
 */
export function deleteTransaction(db: DatabaseSync, id: number): void {
  withTransaction(db, () => {
    if (getTransaction(db, id) === undefined) {
      throw new Error('这笔账不存在，可能已经被删除了')
    }
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id)
  })
}

/** 有账单的月份，从新到旧。用来在翻月时告诉用户「哪几个月是有内容的」。 */
export function monthsWithData(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(occurred_on, 1, 7) AS month
         FROM transactions
        ORDER BY month DESC`
    )
    .all() as unknown as Array<{ month: string }>
  return rows.map((r) => r.month)
}
