import { test, expect } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { migrate } from './migrations'
import { seedBuiltinCategories } from './seed'
import {
  listTree,
  listArchivedTree,
  usageCounts,
  createCategory,
  renameCategory,
  setCategoryIcon,
  reorderSiblings,
  archiveCategory,
  restoreCategory,
  restoreBuiltins
} from './categories'

function fresh(seed = true): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  if (seed) seedBuiltinCategories(db)
  return db
}

function idOf(db: DatabaseSync, builtinKey: string): number {
  const row = db.prepare('SELECT id FROM categories WHERE builtin_key = ?').get(builtinKey) as
    | { id: number }
    | undefined
  if (!row) throw new Error(`测试数据缺失：${builtinKey}`)
  return row.id
}

function countRows(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM categories').get() as { n: number }).n
}

// ---------- 读取 ----------

test('listTree 返回 11 个支出大类，餐饮下有 9 个小类，顺序与种子一致', () => {
  const db = fresh()
  const tree = listTree(db)
  const expense = tree.filter((n) => n.kind === 'expense')
  expect(expense).toHaveLength(11)
  const restaurant = expense.find((n) => n.name === '餐饮')!
  expect(restaurant.children.map((c) => c.name)).toEqual([
    '早餐',
    '午餐',
    '晚餐',
    '夜宵',
    '饮料零食',
    '咖啡奶茶',
    '外卖',
    '聚餐请客',
    '买菜食材'
  ])
  db.close()
})

test('listTree 不返回已归档的分类', () => {
  const db = fresh()
  archiveCategory(db, idOf(db, 'expense/餐饮'))
  const tree = listTree(db)
  expect(tree.find((n) => n.name === '餐饮')).toBeUndefined()
  expect(tree.filter((n) => n.kind === 'expense')).toHaveLength(10)
  db.close()
})

test('isBuiltin 正确反映分类来源（内置 true / 自建 false）', () => {
  const db = fresh()
  const tree = listTree(db)
  expect(tree.find((n) => n.name === '餐饮')!.isBuiltin).toBe(true)
  expect(tree.find((n) => n.name === '餐饮')!.children[0].isBuiltin).toBe(true)

  const custom = createCategory(db, { kind: 'expense', parentId: null, name: '宠物', icon: '🐱' })
  expect(custom.isBuiltin).toBe(false)
  const customChild = createCategory(db, {
    kind: 'expense',
    parentId: custom.id,
    name: '猫粮',
    icon: '🐟'
  })
  expect(customChild.isBuiltin).toBe(false)
  db.close()
})

test('usageCounts 在没有账单时全为空对象', () => {
  const db = fresh()
  expect(usageCounts(db)).toEqual({})
  db.close()
})

test('usageCounts 正确统计每个分类下的账单笔数', () => {
  const db = fresh()
  const breakfast = idOf(db, 'expense/餐饮/早餐')
  const lunch = idOf(db, 'expense/餐饮/午餐')
  const insert = db.prepare(
    `INSERT INTO transactions (kind, amount_fen, category_id, occurred_on, note, payment_method, created_at, updated_at)
     VALUES ('expense', ?, ?, '2026-10-03', '', 'wechat', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z')`
  )
  insert.run(1200, breakfast)
  insert.run(800, breakfast)
  insert.run(3000, lunch)

  expect(usageCounts(db)).toEqual({ [breakfast]: 2, [lunch]: 1 })
  db.close()
})

// ---------- 新建 ----------

test('新建一级大类，自动排在同类的最后', () => {
  const db = fresh()
  const created = createCategory(db, { kind: 'expense', parentId: null, name: '宠物', icon: '🐱' })
  expect(created.parentId).toBeNull()
  expect(created.isBuiltin).toBe(false)
  const expense = listTree(db).filter((n) => n.kind === 'expense')
  expect(expense).toHaveLength(12)
  expect(expense[expense.length - 1].name).toBe('宠物')
  db.close()
})

test('新建二级小类，挂到指定大类下并排在最后', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  createCategory(db, { kind: 'expense', parentId: restaurant, name: '下午茶', icon: '🍰' })
  const node = listTree(db).find((n) => n.name === '餐饮')!
  expect(node.children[node.children.length - 1].name).toBe('下午茶')
  db.close()
})

test('新建时名字首尾空格被自动去掉', () => {
  const db = fresh()
  const created = createCategory(db, { kind: 'expense', parentId: null, name: '  宠物  ', icon: '🐱' })
  expect(created.name).toBe('宠物')
  db.close()
})

test('同层重名被拒绝，并给出中文提示', () => {
  const db = fresh()
  let message = ''
  try {
    createCategory(db, { kind: 'expense', parentId: null, name: '餐饮', icon: '🍜' })
  } catch (e) {
    message = (e as Error).message
  }
  expect(message).toContain('餐饮')
  expect(message).toContain('已存在')
  db.close()
})

test('不同大类下可以有同名小类（买菜 与 外卖 各自有一个「其他」是合理的）', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  const transport = idOf(db, 'expense/交通')
  createCategory(db, { kind: 'expense', parentId: restaurant, name: '其他', icon: '❓' })
  expect(() =>
    createCategory(db, { kind: 'expense', parentId: transport, name: '其他', icon: '❓' })
  ).not.toThrow()
  db.close()
})

test('往二级小类下面再建分类会被拒绝（本软件只有两级）', () => {
  const db = fresh()
  const breakfast = idOf(db, 'expense/餐饮/早餐')
  expect(() =>
    createCategory(db, { kind: 'expense', parentId: breakfast, name: '三级', icon: '❓' })
  ).toThrow()
  db.close()
})

test('把小类挂到 kind 不一致的大类下会被拒绝（支出小类不能挂到收入大类）', () => {
  const db = fresh()
  const salary = idOf(db, 'income/工资薪酬')
  expect(() =>
    createCategory(db, { kind: 'expense', parentId: salary, name: '乱挂', icon: '❓' })
  ).toThrow()
  db.close()
})

test('挂到不存在的父级会被拒绝', () => {
  const db = fresh()
  expect(() =>
    createCategory(db, { kind: 'expense', parentId: 999999, name: '孤儿', icon: '❓' })
  ).toThrow()
  db.close()
})

// ---------- 改名与图标 ----------

test('改名成功，并保留原本的 id 与排序位置', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  renameCategory(db, restaurant, '吃饭')
  const tree = listTree(db)
  const idx = tree.findIndex((n) => n.name === '吃饭')
  expect(idx).toBe(0) // 餐饮本来就是第一个
  expect(tree[idx].id).toBe(restaurant)
  db.close()
})

test('改名会去掉首尾空格', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  renameCategory(db, restaurant, '  吃饭  ')
  expect(listTree(db)[0].name).toBe('吃饭')
  db.close()
})

test('改成和自己一样的名字不算重名', () => {
  const db = fresh()
  expect(() => renameCategory(db, idOf(db, 'expense/餐饮'), '餐饮')).not.toThrow()
  db.close()
})

test('改成同级已有的名字被拒绝', () => {
  const db = fresh()
  expect(() => renameCategory(db, idOf(db, 'expense/餐饮'), '交通')).toThrow(/已存在/)
  db.close()
})

test('改图标成功', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  setCategoryIcon(db, restaurant, '🍽️')
  expect(listTree(db).find((n) => n.id === restaurant)!.icon).toBe('🍽️')
  db.close()
})

test('改名/改图标对不存在的分类会抛错，不会静默什么也不做', () => {
  const db = fresh()
  expect(() => renameCategory(db, 999999, 'x')).toThrow()
  expect(() => setCategoryIcon(db, 999999, 'x')).toThrow()
  db.close()
})

// ---------- 排序 ----------

test('reorderSiblings 按给定顺序重写排序号', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  const before = listTree(db).find((n) => n.id === restaurant)!.children
  const reversed = before.map((c) => c.id).reverse()

  reorderSiblings(db, 'expense', restaurant, reversed)

  const after = listTree(db).find((n) => n.id === restaurant)!.children
  expect(after.map((c) => c.id)).toEqual(reversed)
  expect(after.map((c) => c.name)).toEqual(before.map((c) => c.name).reverse())
  db.close()
})

test('reorderSiblings 能重排一级大类', () => {
  const db = fresh()
  const ids = listTree(db)
    .filter((n) => n.kind === 'expense')
    .map((n) => n.id)
  const reversed = [...ids].reverse()
  reorderSiblings(db, 'expense', null, reversed)
  expect(
    listTree(db)
      .filter((n) => n.kind === 'expense')
      .map((n) => n.id)
  ).toEqual(reversed)
  db.close()
})

test('reorderSiblings 传的 id 集合与现有同级不一致时被拒绝（防止漏传导致排序错乱）', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  const ids = listTree(db)
    .find((n) => n.id === restaurant)!
    .children.map((c) => c.id)
  expect(() => reorderSiblings(db, 'expense', restaurant, ids.slice(0, 3))).toThrow()
  expect(() => reorderSiblings(db, 'expense', restaurant, [...ids, 999999])).toThrow()
  db.close()
})

test('reorderSiblings 传重复 id 会被拒绝', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  const ids = listTree(db)
    .find((n) => n.id === restaurant)!
    .children.map((c) => c.id)
  expect(() => reorderSiblings(db, 'expense', restaurant, [ids[0], ids[0], ...ids.slice(2)])).toThrow()
  db.close()
})

test('reorderSiblings 拒绝把大类排到二级小类的层级上', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  const majorIds = listTree(db)
    .filter((n) => n.kind === 'expense')
    .map((n) => n.id)
  expect(() => reorderSiblings(db, 'expense', restaurant, majorIds)).toThrow()
  db.close()
})

test('reorderSiblings 对不存在的父级会抛错', () => {
  const db = fresh()
  expect(() => reorderSiblings(db, 'expense', 999999, [])).toThrow()
  db.close()
})

test('reorderSiblings 失败时不留下半截排序号', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  const before = listTree(db)
    .find((n) => n.id === restaurant)!
    .children.map((c) => c.sortOrder)
  expect(() => reorderSiblings(db, 'expense', restaurant, [])).toThrow()
  const after = listTree(db)
    .find((n) => n.id === restaurant)!
    .children.map((c) => c.sortOrder)
  expect(after).toEqual(before)
  db.close()
})

// ---------- 归档与恢复 ----------

test('归档一级大类时，其下所有小类一并归档', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  archiveCategory(db, restaurant)
  const remaining = db
    .prepare('SELECT count(*) AS n FROM categories WHERE is_archived = 0 AND (id = ? OR parent_id = ?)')
    .get(restaurant, restaurant) as { n: number }
  expect(remaining.n).toBe(0)
  db.close()
})

test('归档二级小类只影响它自己，大类还在', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  archiveCategory(db, idOf(db, 'expense/餐饮/早餐'))
  const node = listTree(db).find((n) => n.id === restaurant)!
  expect(node.children.map((c) => c.name)).not.toContain('早餐')
  expect(node.children).toHaveLength(8)
  db.close()
})

test('listArchivedTree 只列「能整体恢复」的条目：整棵归档的大类出一条，单独删的小类也出一条', () => {
  const db = fresh()
  archiveCategory(db, idOf(db, 'expense/餐饮')) // 整棵
  archiveCategory(db, idOf(db, 'expense/交通/飞机')) // 只一个小类

  const archived = listArchivedTree(db)
  // 注意：交通本身没被删，不该出现在「已删除」列表里
  expect(archived.map((n) => n.name).sort()).toEqual(['飞机', '餐饮'])

  // 整棵归档的大类带着它的小类，方便界面显示「含 9 个小类」
  const restaurant = archived.find((n) => n.name === '餐饮')!
  expect(restaurant.children.map((c) => c.name)).toHaveLength(9)

  // 单独删的小类没有下级
  const plane = archived.find((n) => n.name === '飞机')!
  expect(plane.children).toEqual([])
  db.close()
})

test('恢复归档的大类时，其下小类一并回来，且仍是归档前的顺序', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  const before = listTree(db)
    .find((n) => n.id === restaurant)!
    .children.map((c) => c.name)
  archiveCategory(db, restaurant)
  restoreCategory(db, restaurant)
  const after = listTree(db)
    .find((n) => n.id === restaurant)!
    .children.map((c) => c.name)
  expect(after).toEqual(before)
  db.close()
})

test('恢复自定义分类也能用（不只是内置的）', () => {
  const db = fresh()
  const custom = createCategory(db, { kind: 'expense', parentId: null, name: '宠物', icon: '🐱' })
  archiveCategory(db, custom.id)
  expect(listTree(db).find((n) => n.id === custom.id)).toBeUndefined()
  restoreCategory(db, custom.id)
  expect(listTree(db).find((n) => n.id === custom.id)?.name).toBe('宠物')
  db.close()
})

test('恢复不存在的分类会抛错', () => {
  const db = fresh()
  expect(() => restoreCategory(db, 999999)).toThrow()
  db.close()
})

test('归档后可以重建同名分类（归档的不占名字）', () => {
  const db = fresh()
  archiveCategory(db, idOf(db, 'expense/餐饮'))
  expect(() =>
    createCategory(db, { kind: 'expense', parentId: null, name: '餐饮', icon: '🍜' })
  ).not.toThrow()
  db.close()
})

// ---------- 恢复内置分类 ----------

test('restoreBuiltins：全都没删时什么也不做，返回 0', () => {
  const db = fresh()
  expect(restoreBuiltins(db)).toBe(0)
  db.close()
})

test('restoreBuiltins：补回被归档的内置分类，并且不重复插入', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  archiveCategory(db, restaurant)
  const restored = restoreBuiltins(db)
  expect(restored).toBe(0) // 是「取消归档」，不是「新插入」
  const node = listTree(db).find((n) => n.name === '餐饮')
  expect(node).toBeDefined()
  expect(node!.id).toBe(restaurant)
  expect(node!.children).toHaveLength(9)
  db.close()
})

test('restoreBuiltins：把被物理删除的内置分类重新插入，并挂回正确的大类', () => {
  const db = fresh()
  // 模拟「整行没了」的极端情况（正常操作不会发生，但恢复功能必须兜得住）
  const breakfast = idOf(db, 'expense/餐饮/早餐')
  db.exec(`DELETE FROM categories WHERE id = ${breakfast}`)
  const restored = restoreBuiltins(db)
  expect(restored).toBe(1)
  const node = listTree(db).find((n) => n.name === '餐饮')!
  expect(node.children.map((c) => c.name)).toContain('早餐')
  db.close()
})

test('restoreBuiltins：用户改过名字的内置分类不会被改回默认名', () => {
  const db = fresh()
  renameCategory(db, idOf(db, 'expense/餐饮'), '吃饭')
  restoreBuiltins(db)
  expect(listTree(db).find((n) => n.name === '吃饭')).toBeDefined()
  expect(listTree(db).find((n) => n.name === '餐饮')).toBeUndefined()
  db.close()
})

test('restoreBuiltins：用户在自定义分类上改的名字不受影响', () => {
  const db = fresh()
  const custom = createCategory(db, { kind: 'expense', parentId: null, name: '宠物', icon: '🐱' })
  restoreBuiltins(db)
  expect(listTree(db).find((n) => n.id === custom.id)?.name).toBe('宠物')
  db.close()
})

test('restoreBuiltins：跑完之后总数回到 96（16 大类 + 80 小类）', () => {
  const db = fresh()
  archiveCategory(db, idOf(db, 'expense/餐饮'))
  archiveCategory(db, idOf(db, 'income/工资薪酬'))
  restoreBuiltins(db)
  const n = (db.prepare('SELECT count(*) AS n FROM categories WHERE is_archived = 0').get() as {
    n: number
  }).n
  expect(n).toBe(96)
  db.close()
})

test('restoreBuiltins：连大类带小类一起被物理删除时，整棵都补回来', () => {
  const db = fresh()
  const restaurant = idOf(db, 'expense/餐饮')
  db.exec(`DELETE FROM categories WHERE parent_id = ${restaurant}`)
  db.exec(`DELETE FROM categories WHERE id = ${restaurant}`)
  const restored = restoreBuiltins(db)
  expect(restored).toBe(10) // 1 个大类 + 9 个小类
  const node = listTree(db).find((n) => n.name === '餐饮')!
  expect(node.children).toHaveLength(9)
  db.close()
})

// ---------- 事务性 ----------

test('新建失败是原子的：不留半个分类', () => {
  const db = fresh()
  const before = countRows(db)
  expect(() =>
    createCategory(db, { kind: 'expense', parentId: null, name: '餐饮', icon: '🍜' })
  ).toThrow()
  expect(countRows(db)).toBe(before)
  db.close()
})

test('归档失败是原子的：不会只归档了一半子树', () => {
  const db = fresh()
  expect(() => archiveCategory(db, 999999)).toThrow()
  const archived = (db.prepare('SELECT count(*) AS n FROM categories WHERE is_archived = 1').get() as {
    n: number
  }).n
  expect(archived).toBe(0)
  db.close()
})
