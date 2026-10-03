import { test, expect } from 'vitest'
import type { CategoryNode } from './types'
import { sortByRecency } from './recentCategories'

function node(
  id: number,
  name: string,
  sortOrder: number,
  children: CategoryNode[] = []
): CategoryNode {
  return {
    id,
    kind: 'expense',
    parentId: null,
    name,
    icon: '❓',
    sortOrder,
    isArchived: false,
    isBuiltin: false,
    children
  }
}

function leaf(id: number, name: string, sortOrder: number, parentId: number): CategoryNode {
  return { ...node(id, name, sortOrder), parentId }
}

const TREE: CategoryNode[] = [
  node(1, '餐饮', 0, [leaf(11, '早餐', 0, 1), leaf(12, '午餐', 1, 1), leaf(13, '晚餐', 2, 1)]),
  node(2, '交通', 1, [leaf(21, '公交地铁', 0, 2), leaf(22, '打车', 1, 2)]),
  node(3, '购物', 2, [leaf(31, '服饰', 0, 3)]),
  node(4, '居住', 3, [leaf(41, '房租', 0, 4)])
]

test('没给最近记录时，原样返回（顺序不动）', () => {
  const result = sortByRecency(TREE, [])
  expect(result.map((n) => n.name)).toEqual(['餐饮', '交通', '购物', '居住'])
})

test('最近用过的小类，它所属的大类排到最前', () => {
  const result = sortByRecency(TREE, [31]) // 最近用过「服饰」（购物大类下）
  expect(result[0].name).toBe('购物')
})

test('该大类内部，最近用过的小类也排到最前', () => {
  const result = sortByRecency(TREE, [13]) // 最近用过「晚餐」
  const restaurant = result.find((n) => n.name === '餐饮')!
  expect(restaurant.children.map((c) => c.name)).toEqual(['晚餐', '早餐', '午餐'])
})

test('没用过的分类保持原来的顺序（不能因为置顶把别的顺序打乱）', () => {
  const result = sortByRecency(TREE, [31])
  expect(result.map((n) => n.name)).toEqual(['购物', '餐饮', '交通', '居住'])
})

test('多个最近用过时，最近的在最前', () => {
  const result = sortByRecency(TREE, [41, 31]) // 41 比 31 更近
  expect(result.slice(0, 2).map((n) => n.name)).toEqual(['居住', '购物'])
})

test('同一个大类下多个最近用过，按最近程度排', () => {
  const result = sortByRecency(TREE, [12, 13, 11]) // 最近的是 12
  const restaurant = result.find((n) => n.name === '餐饮')!
  expect(restaurant.children.map((c) => c.name)).toEqual(['午餐', '晚餐', '早餐'])
})

test('最近列表里有已经不存在的 id 时忽略它，不崩', () => {
  const result = sortByRecency(TREE, [9999, 31])
  expect(result[0].name).toBe('购物')
  expect(result).toHaveLength(4)
})

test('最近列表里有大类自己的 id 时，大类也置顶', () => {
  const result = sortByRecency(TREE, [4])
  expect(result[0].name).toBe('居住')
})

test('原树不会被改动（纯函数不能有副作用）', () => {
  const before = JSON.stringify(TREE)
  sortByRecency(TREE, [31, 13])
  expect(JSON.stringify(TREE)).toBe(before)
})

test('置顶后每个大类的名字和小类数量都不变（只换顺序不丢东西）', () => {
  const result = sortByRecency(TREE, [31, 13, 22])
  expect(result).toHaveLength(4)
  expect(result.reduce((n, m) => n + m.children.length, 0)).toBe(7)
})

test('空树返回空数组', () => {
  expect(sortByRecency([], [1, 2])).toEqual([])
})

test('同一个 id 在最近列表里重复出现时，按第一次（最近的那次）算', () => {
  const result = sortByRecency(TREE, [31, 41, 31])
  expect(result.slice(0, 2).map((n) => n.name)).toEqual(['购物', '居住'])
})

test('返回的是一份新数组，不是原来那个（避免调用方误改）', () => {
  const result = sortByRecency(TREE, [])
  expect(result).not.toBe(TREE)
  expect(result[0].children).not.toBe(TREE[0].children)
})
