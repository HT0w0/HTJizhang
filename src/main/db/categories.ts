/**
 * 分类仓储：所有分类的读写都走这里。
 *
 * 约定：
 * - 面向用户能看懂的失败一律抛 Error，message 是可以直接显示的中文；
 *   界面层不需要再把英文错误翻译一遍。
 * - 多步写入一律包在 withTransaction 里，失败整体回滚。
 * - 删除用归档，不做物理删除（CLAUDE.md §5.11）。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { Category, CategoryKind, CategoryNode, CreateCategoryInput } from '@shared/types'
import {
  buildTree,
  nextSortOrder,
  normalizeName,
  validateCategoryName
} from '@shared/categoryTree'
import { BUILTIN_CATEGORIES } from './seed'
import { withTransaction } from './transaction'

interface CategoryRow {
  id: number
  kind: string
  parent_id: number | null
  name: string
  icon: string
  sort_order: number
  is_archived: number
  builtin_key: string | null
}

const COLUMNS = 'id, kind, parent_id, name, icon, sort_order, is_archived, builtin_key'

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    kind: row.kind as CategoryKind,
    parentId: row.parent_id,
    name: row.name,
    icon: row.icon,
    sortOrder: row.sort_order,
    isArchived: row.is_archived === 1,
    isBuiltin: row.builtin_key !== null
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

export function listAll(db: DatabaseSync): Category[] {
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM categories WHERE is_archived = 0 ORDER BY parent_id, sort_order, id`
    )
    .all() as unknown as CategoryRow[]
  return rows.map(toCategory)
}

export function listTree(db: DatabaseSync): CategoryNode[] {
  return buildTree(listAll(db))
}

/**
 * 「已删除的分类」列表：只列出能整体恢复的条目。
 *
 * 判定规则 —— 一个小类的上级如果也被归档了，它就不单独占一行，
 * 跟着上级一起恢复即可：
 * - 删掉整个「餐饮」→ 只出「餐饮」一行（它的 9 个小类挂在 children 里，供界面显示数量）
 * - 只删掉「飞机」→ 出「飞机」一行（它的上级「交通」没被删）
 *
 * 注意「交通」本身没被删，绝不会出现在这个列表里 ——
 * 把没删的东西列在删除区会让用户以为误删了。
 *
 * 这里不能用 buildTree：它把所有 parentId 非空的节点当成子节点，
 * 会把「上级还在、自己单独被删」的小类整个丢掉。
 */
export function listArchivedTree(db: DatabaseSync): CategoryNode[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS} FROM categories WHERE is_archived = 1 ORDER BY sort_order, id`)
    .all() as unknown as CategoryRow[]

  const archivedIds = new Set(rows.map((r) => r.id))
  const roots: CategoryNode[] = []
  const childrenOf = new Map<number, CategoryNode[]>()

  for (const row of rows) {
    const node: CategoryNode = { ...toCategory(row), children: [] }

    if (row.parent_id !== null && archivedIds.has(row.parent_id)) {
      const list = childrenOf.get(row.parent_id)
      if (list) {
        list.push(node)
      } else {
        childrenOf.set(row.parent_id, [node])
      }
      continue
    }

    roots.push(node)
  }

  return roots.map((root) => ({ ...root, children: childrenOf.get(root.id) ?? [] }))
}

export function usageCounts(db: DatabaseSync): Record<number, number> {
  const rows = db
    .prepare('SELECT category_id, COUNT(*) AS n FROM transactions GROUP BY category_id')
    .all() as unknown as Array<{ category_id: number; n: number }>

  const result: Record<number, number> = {}
  for (const row of rows) {
    result[row.category_id] = row.n
  }
  return result
}

function getRow(db: DatabaseSync, id: number): CategoryRow | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM categories WHERE id = ?`).get(id) as unknown as
    | CategoryRow
    | undefined
}

function requireRow(db: DatabaseSync, id: number): CategoryRow {
  const row = getRow(db, id)
  if (!row) throw new Error('这个分类不存在，可能已经被删除了')
  return row
}

/** 取同一层的兄弟分类（大类的兄弟 = 同收支类型的其他大类）。 */
function siblingsOf(db: DatabaseSync, kind: CategoryKind, parentId: number | null): Category[] {
  const rows = (
    parentId === null
      ? db
          .prepare(`SELECT ${COLUMNS} FROM categories WHERE kind = ? AND parent_id IS NULL`)
          .all(kind)
      : db.prepare(`SELECT ${COLUMNS} FROM categories WHERE parent_id = ?`).all(parentId)
  ) as unknown as CategoryRow[]
  return rows.map(toCategory)
}

export function createCategory(db: DatabaseSync, input: CreateCategoryInput): Category {
  return withTransaction(db, () => {
    if (input.parentId !== null) {
      const parent = requireRow(db, input.parentId)
      if (parent.parent_id !== null) {
        throw new Error('本软件只支持两级分类，不能在二级小类下面再建分类')
      }
      if (parent.kind !== input.kind) {
        throw new Error('新分类的收支类型必须和它所属的大类一致')
      }
    }

    const siblings = siblingsOf(db, input.kind, input.parentId)
    const problem = validateCategoryName(input.name, siblings)
    if (problem) throw new Error(problem)

    const timestamp = nowIso()
    const result = db
      .prepare(
        `INSERT INTO categories
           (kind, parent_id, name, icon, sort_order, is_archived, builtin_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`
      )
      .run(
        input.kind,
        input.parentId,
        normalizeName(input.name),
        input.icon,
        nextSortOrder(siblings),
        timestamp,
        timestamp
      )

    return toCategory(requireRow(db, Number(result.lastInsertRowid)))
  })
}

export function renameCategory(db: DatabaseSync, id: number, name: string): void {
  withTransaction(db, () => {
    const row = requireRow(db, id)
    const siblings = siblingsOf(db, row.kind as CategoryKind, row.parent_id)
    const problem = validateCategoryName(name, siblings, id)
    if (problem) throw new Error(problem)

    db.prepare('UPDATE categories SET name = ?, updated_at = ? WHERE id = ?').run(
      normalizeName(name),
      nowIso(),
      id
    )
  })
}

export function setCategoryIcon(db: DatabaseSync, id: number, icon: string): void {
  withTransaction(db, () => {
    requireRow(db, id)
    db.prepare('UPDATE categories SET icon = ?, updated_at = ? WHERE id = ?').run(icon, nowIso(), id)
  })
}

/**
 * 按给定顺序重写同一层分类的排序号。
 *
 * 要求 orderedIds 与该层现有的（未归档）分类集合完全一致 ——
 * 界面每次都传完整列表，所以这个约束不会造成麻烦，却能拦住
 * 「漏传几个 id」导致的排序号错乱。
 */
export function reorderSiblings(
  db: DatabaseSync,
  kind: CategoryKind,
  parentId: number | null,
  orderedIds: readonly number[]
): void {
  withTransaction(db, () => {
    if (parentId !== null) {
      const parent = requireRow(db, parentId)
      if (parent.parent_id !== null) {
        throw new Error('只能对一级大类排序，二级小类没有下级')
      }
    }

    const current = siblingsOf(db, kind, parentId).filter((c) => !c.isArchived)
    const currentIds = new Set(current.map((c) => c.id))

    if (new Set(orderedIds).size !== orderedIds.length) {
      throw new Error('排序请求里有重复的分类')
    }
    if (orderedIds.length !== currentIds.size || !orderedIds.every((id) => currentIds.has(id))) {
      throw new Error('排序请求和当前的分类列表对不上，请刷新后重试')
    }

    const update = db.prepare('UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?')
    const timestamp = nowIso()
    orderedIds.forEach((id, index) => {
      update.run(index, timestamp, id)
    })
  })
}

/** 归档。一级大类会连同其下所有小类一起归档，不留悬空的小类。 */
export function archiveCategory(db: DatabaseSync, id: number): void {
  withTransaction(db, () => {
    const row = requireRow(db, id)
    const timestamp = nowIso()

    if (row.parent_id === null) {
      db.prepare('UPDATE categories SET is_archived = 1, updated_at = ? WHERE parent_id = ?').run(
        timestamp,
        id
      )
    }
    db.prepare('UPDATE categories SET is_archived = 1, updated_at = ? WHERE id = ?').run(timestamp, id)
  })
}

/** 从归档中恢复。一级大类会连同其下所有小类一起恢复。 */
export function restoreCategory(db: DatabaseSync, id: number): void {
  withTransaction(db, () => {
    const row = requireRow(db, id)
    const timestamp = nowIso()

    if (row.parent_id === null) {
      db.prepare('UPDATE categories SET is_archived = 0, updated_at = ? WHERE parent_id = ?').run(
        timestamp,
        id
      )
    }
    db.prepare('UPDATE categories SET is_archived = 0, updated_at = ? WHERE id = ?').run(timestamp, id)
  })
}

/**
 * 把缺失的内置分类补回来。
 *
 * 三种情况分开处理：
 * - 内置分类还在、没归档 → 什么都不做（用户改过的名字必须保住）
 * - 内置分类还在、被归档了 → 取消归档（连带它下面的小类）
 * - 内置分类整行没了 → 按 builtin_key 重新插入，挂回正确的大类
 *
 * 返回「重新插入的行数」。取消归档不计入，因为它没有新增行。
 */
export function restoreBuiltins(db: DatabaseSync): number {
  return withTransaction(db, () => {
    const findByKey = db.prepare('SELECT id, is_archived FROM categories WHERE builtin_key = ?')
    const insert = db.prepare(
      `INSERT INTO categories
         (kind, parent_id, name, icon, sort_order, is_archived, builtin_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    const maxMajorSort = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE kind = ? AND parent_id IS NULL'
    )
    const maxChildSort = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories WHERE parent_id = ?'
    )
    const unarchive = db.prepare('UPDATE categories SET is_archived = 0, updated_at = ? WHERE id = ?')

    const timestamp = nowIso()
    let inserted = 0

    for (const major of BUILTIN_CATEGORIES) {
      const majorKey = `${major.kind}/${major.name}`
      const existingMajor = findByKey.get(majorKey) as { id: number; is_archived: number } | undefined

      let majorId: number
      if (existingMajor) {
        majorId = existingMajor.id
        if (existingMajor.is_archived === 1) {
          // 大类被归档时它的小类也一并被归档了，这里整棵恢复
          db.prepare('UPDATE categories SET is_archived = 0, updated_at = ? WHERE parent_id = ?').run(
            timestamp,
            majorId
          )
          unarchive.run(timestamp, majorId)
        }
      } else {
        const order = (maxMajorSort.get(major.kind) as { m: number }).m + 1
        const result = insert.run(
          major.kind,
          null,
          major.name,
          major.icon,
          order,
          majorKey,
          timestamp,
          timestamp
        )
        majorId = Number(result.lastInsertRowid)
        inserted += 1
      }

      for (const child of major.children) {
        const childKey = `${major.kind}/${major.name}/${child.name}`
        const existingChild = findByKey.get(childKey) as { id: number; is_archived: number } | undefined

        if (existingChild) {
          if (existingChild.is_archived === 1) unarchive.run(timestamp, existingChild.id)
          continue
        }

        const order = (maxChildSort.get(majorId) as { m: number }).m + 1
        insert.run(major.kind, majorId, child.name, child.icon, order, childKey, timestamp, timestamp)
        inserted += 1
      }
    }

    return inserted
  })
}
