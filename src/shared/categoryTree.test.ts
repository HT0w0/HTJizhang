import { test, expect } from 'vitest'
import type { Category } from './types'
import {
  buildTree,
  nextSortOrder,
  findCategory,
  collectSubtreeIds,
  normalizeName,
  validateCategoryName
} from './categoryTree'

function cat(over: Partial<Category> & { id: number }): Category {
  return {
    kind: 'expense',
    parentId: null,
    name: `分类${over.id}`,
    icon: '❓',
    sortOrder: 0,
    isArchived: false,
    isBuiltin: false,
    ...over
  }
}

test('buildTree：把扁平行拼成两级树，大类按 sortOrder 排', () => {
  const rows = [
    cat({ id: 1, name: '餐饮', sortOrder: 1 }),
    cat({ id: 2, name: '交通', sortOrder: 0 }),
    cat({ id: 3, name: '早餐', parentId: 1, sortOrder: 0 }),
    cat({ id: 4, name: '午餐', parentId: 1, sortOrder: 1 })
  ]
  const tree = buildTree(rows)
  expect(tree.map((n) => n.name)).toEqual(['交通', '餐饮'])
  expect(tree[1].children.map((n) => n.name)).toEqual(['早餐', '午餐'])
  expect(tree[0].children).toEqual([])
})

test('buildTree：输入顺序打乱也能排对（不依赖调用方先排好）', () => {
  const rows = [
    cat({ id: 4, name: '午餐', parentId: 1, sortOrder: 1 }),
    cat({ id: 2, name: '交通', sortOrder: 0 }),
    cat({ id: 3, name: '早餐', parentId: 1, sortOrder: 0 }),
    cat({ id: 1, name: '餐饮', sortOrder: 1 })
  ]
  expect(buildTree(rows).map((n) => n.name)).toEqual(['交通', '餐饮'])
})

test('buildTree：sortOrder 相同时按 id 排，结果稳定可复现', () => {
  const rows = [cat({ id: 9, name: 'B', sortOrder: 0 }), cat({ id: 3, name: 'A', sortOrder: 0 })]
  expect(buildTree(rows).map((n) => n.name)).toEqual(['A', 'B'])
})

test('buildTree：小类的父级不在输入里时，这个小类被丢弃而不是崩掉', () => {
  const rows = [cat({ id: 1, name: '餐饮' }), cat({ id: 5, name: '孤儿', parentId: 999 })]
  const tree = buildTree(rows)
  expect(tree).toHaveLength(1)
  expect(tree[0].children).toEqual([])
})

test('buildTree：空输入返回空数组', () => {
  expect(buildTree([])).toEqual([])
})

test('nextSortOrder：空列表返回 0，非空返回最大值 +1', () => {
  expect(nextSortOrder([])).toBe(0)
  expect(nextSortOrder([cat({ id: 1, sortOrder: 0 })])).toBe(1)
  expect(nextSortOrder([cat({ id: 1, sortOrder: 5 }), cat({ id: 2, sortOrder: 2 })])).toBe(6)
})

test('findCategory：能找到大类和它的小类', () => {
  const tree = buildTree([cat({ id: 1, name: '餐饮' }), cat({ id: 3, name: '早餐', parentId: 1 })])
  expect(findCategory(tree, 1)?.name).toBe('餐饮')
  expect(findCategory(tree, 3)?.name).toBe('早餐')
  expect(findCategory(tree, 404)).toBeUndefined()
})

test('collectSubtreeIds：大类返回自己 + 全部小类；小类只返回自己', () => {
  const tree = buildTree([
    cat({ id: 1, name: '餐饮' }),
    cat({ id: 3, name: '早餐', parentId: 1 }),
    cat({ id: 4, name: '午餐', parentId: 1 }),
    cat({ id: 2, name: '交通' })
  ])
  expect(collectSubtreeIds(tree, 1).sort()).toEqual([1, 3, 4])
  expect(collectSubtreeIds(tree, 3)).toEqual([3])
  expect(collectSubtreeIds(tree, 404)).toEqual([])
})

test('normalizeName：去掉首尾空格，并把连续空格压成一个', () => {
  expect(normalizeName('  早餐 ')).toBe('早餐')
  expect(normalizeName('早    餐')).toBe('早 餐')
  expect(normalizeName('早餐\t\n')).toBe('早餐')
})

test('validateCategoryName：正常名字通过', () => {
  expect(validateCategoryName('早餐', [])).toBeNull()
})

test('validateCategoryName：纯空格被拒绝', () => {
  expect(validateCategoryName('   ', [])).toContain('不能为空')
})

test('validateCategoryName：超过 12 个字被拒绝（界面放不下）', () => {
  expect(validateCategoryName('一二三四五六七八九十十一十二十三', [])).toContain('12')
})

test('validateCategoryName：正好 12 个字通过', () => {
  expect(validateCategoryName('一二三四五六七八九十十一', [])).toBeNull()
})

test('validateCategoryName：同层重名被拒绝，提示里带上重名的那个名字', () => {
  const siblings = [cat({ id: 1, name: '早餐' })]
  const message = validateCategoryName('早餐', siblings)
  expect(message).toContain('早餐')
  expect(message).toContain('已存在')
})

test('validateCategoryName：重名判断忽略首尾空格（输入「 早餐 」也算重名）', () => {
  const siblings = [cat({ id: 1, name: '早餐' })]
  expect(validateCategoryName('  早餐  ', siblings)).toContain('已存在')
})

test('validateCategoryName：改名成自己原来的名字不算重名（传了 excludeId）', () => {
  const siblings = [cat({ id: 1, name: '早餐' })]
  expect(validateCategoryName('早餐', siblings, 1)).toBeNull()
})

test('validateCategoryName：已归档的同名分类不算冲突（用户删了就该能同名重建）', () => {
  const siblings = [cat({ id: 1, name: '早餐', isArchived: true })]
  expect(validateCategoryName('早餐', siblings)).toBeNull()
})

test('validateCategoryName：表情符号与中英文混排都通过', () => {
  expect(validateCategoryName('买菜🥬', [])).toBeNull()
  expect(validateCategoryName('KTV', [])).toBeNull()
})
