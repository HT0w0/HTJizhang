/**
 * 分类树的纯计算。
 *
 * 这里刻意不碰数据库、不碰 electron —— 全是「进去一批数据、出来一批数据」的函数，
 * 因此可以用极低的成本覆盖大量边界情况（孤儿节点、排序号相同、重名、超长名……）。
 * 数据库那层只负责取数存数，判断逻辑全在这里（CLAUDE.md §5.15）。
 */
import type { Category, CategoryNode } from './types'

/** 分类名最大长度。按视觉宽度算，12 个汉字在界面上已经很长了。 */
export const MAX_CATEGORY_NAME_LENGTH = 12

function bySortThenId(a: Category, b: Category): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
  return a.id - b.id
}

/**
 * 把数据库取出的扁平行拼成两级树。
 *
 * 不假设调用方已经把数据排好序 —— 排序在内部完成，
 * 免得「换一个查询语句就顺序全乱」这类问题。
 * 父级不在输入里的子类会被丢弃：宁可少显示一条，也不能让界面崩掉。
 */
export function buildTree(rows: readonly Category[]): CategoryNode[] {
  const majors = rows.filter((r) => r.parentId === null).sort(bySortThenId)

  const childrenByParent = new Map<number, Category[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const list = childrenByParent.get(row.parentId)
    if (list) {
      list.push(row)
    } else {
      childrenByParent.set(row.parentId, [row])
    }
  }

  return majors.map((major) => ({
    ...major,
    children: (childrenByParent.get(major.id) ?? [])
      .slice()
      .sort(bySortThenId)
      .map((child) => ({ ...child, children: [] as readonly CategoryNode[] }))
  }))
}

/** 新分类追加到末尾时该用的排序号。 */
export function nextSortOrder(siblings: readonly Category[]): number {
  if (siblings.length === 0) return 0
  return Math.max(...siblings.map((s) => s.sortOrder)) + 1
}

/** 在树里按 id 找分类，大类和二级小类都能找到。 */
export function findCategory(nodes: readonly CategoryNode[], id: number): CategoryNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node
    const hit = node.children.find((c) => c.id === id)
    if (hit) return hit
  }
  return undefined
}

/**
 * 收集某分类及其全部下级小类的 id。
 * 归档一级大类时要用它，把整棵子树一起归档，避免留下悬空的小类。
 */
export function collectSubtreeIds(nodes: readonly CategoryNode[], id: number): number[] {
  const node = findCategory(nodes, id)
  if (!node) return []
  return [node.id, ...node.children.map((c) => c.id)]
}

/**
 * 清洗用户输入的分类名：去掉首尾空白，把中间连续空白压成一个空格。
 * 中文输入法下很容易多打空格，不清洗的话「早餐」和「早餐 」会变成两条不同的分类。
 */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ')
}

/**
 * 校验分类名。通过返回 null，不通过返回一句可以直接显示给用户的中文。
 *
 * siblings 传同层的现有分类（同一大类下的小类，或同一收支类型下的大类）；
 * excludeId 用于改名场景 —— 改成自己原来的名字不该算重名。
 * 已归档的同名分类不算冲突：用户把它删了，就应该能再建一个同名的。
 */
export function validateCategoryName(
  raw: string,
  siblings: readonly Category[],
  excludeId?: number
): string | null {
  const name = normalizeName(raw)

  if (name === '') {
    return '分类名不能为空'
  }
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    return `分类名最多 ${MAX_CATEGORY_NAME_LENGTH} 个字，现在有 ${name.length} 个`
  }

  const clash = siblings.some(
    (s) => !s.isArchived && s.id !== excludeId && normalizeName(s.name) === name
  )
  if (clash) {
    return `已存在名为「${name}」的分类`
  }

  return null
}
