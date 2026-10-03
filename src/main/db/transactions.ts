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
  PaymentMethod,
  Transaction
} from '@shared/types'
import { isValidLocalDate } from '@shared/localDate'
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

export function createTransaction(db: DatabaseSync, input: CreateTransactionInput): Transaction {
  return withTransaction(db, () => {
    // ---- 金额 ----
    if (!Number.isInteger(input.amountFen)) {
      throw new Error('金额必须是整数分（内部错误：收到了小数）')
    }
    if (input.amountFen <= 0) {
      throw new Error('金额必须大于 0')
    }

    // ---- 分类 ----
    validateCategory(db, input.categoryId, input.kind)

    // ---- 日期 ----
    if (!isValidLocalDate(input.occurredOn)) {
      throw new Error(`日期格式不对，应该是 2026-10-03 这样（收到「${input.occurredOn}」）`)
    }

    // ---- 支付方式 ----
    if (!isPaymentMethod(input.paymentMethod)) {
      throw new Error('支付方式不对，请重新选一个')
    }

    // ---- 备注 ----
    const note = normalizeNote(input.note)
    if (note.length > MAX_NOTE_LENGTH) {
      throw new Error(`备注最多 ${MAX_NOTE_LENGTH} 个字，现在有 ${note.length} 个`)
    }

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
