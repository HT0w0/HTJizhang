/**
 * 「最近用过的分类」置顶。
 *
 * 为什么需要：用户每天记的就是那几类（午餐、晚餐、买菜），
 * 但二级小类一共 61 个，每次都从头找很烦。
 *
 * 规则（要简单到用户能预期）：
 * - 你最近用过的小类，它所属的大类排到最前面；
 * - 在该大类内部，最近用过的小类也排到前面；
 * - 没用过的分类**保持原来的顺序** —— 置顶不能把别的顺序搞乱，
 *   否则用户会觉得「它的顺序自己会变」，反而不敢依赖。
 *
 * 纯函数，不碰数据库（CLAUDE.md §5.15）。
 */
import type { CategoryNode } from './types'

/**
 * 按「最近用过」重排分类树。
 *
 * recentIds 是最近用过的小类 id，**最近的在最前**。
 * 列表里出现树中不存在的 id 会被忽略（那个分类可能已经被删了）。
 *
 * 返回一份全新的树，不会改动传进来的数据。
 */
export function sortByRecency(
  nodes: readonly CategoryNode[],
  recentIds: readonly number[]
): CategoryNode[] {
  if (recentIds.length === 0) return nodes.map((n) => ({ ...n, children: [...n.children] }))

  // id → 名次（0 是最最近）。同一个 id 重复出现时取最靠前的那次。
  const rank = new Map<number, number>()
  recentIds.forEach((id, index) => {
    if (!rank.has(id)) rank.set(id, index)
  })

  /** 一组分类里最靠前的名次；都没用过返回 Infinity。 */
  function bestRank(items: readonly { id: number }[]): number {
    let best = Number.POSITIVE_INFINITY
    for (const item of items) {
      const r = rank.get(item.id)
      if (r !== undefined && r < best) best = r
    }
    return best
  }

  /**
   * 把用过的挑到前面，用过的内部按名次排；没用过的保持原有相对顺序。
   *
   * 必须分两段拼而不是直接 sort：直接 sort 时「都没用过」的比较结果全是相等，
   * 排序稳定性虽然能保住顺序，但一旦有名次混合就会乱。分开处理更直白。
   */
  function promoteUsed<T extends { id: number }>(items: readonly T[]): T[] {
    const used = items.filter((i) => rank.has(i.id))
    const rest = items.filter((i) => !rank.has(i.id))
    used.sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number))
    return [...used, ...rest]
  }

  const rearranged = nodes.map((major) => ({
    ...major,
    children: promoteUsed(major.children)
  }))

  // 大类的名次 = 它自己或它任一子类的最好名次
  const scored = rearranged.map((major, originalIndex) => ({
    major,
    originalIndex,
    rank: Math.min(bestRank([major]), bestRank(major.children))
  }))

  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank
    // 名次相同（都没用过，或都用了同一档）时保持原顺序
    return a.originalIndex - b.originalIndex
  })

  return scored.map((s) => s.major)
}
