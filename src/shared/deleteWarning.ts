/**
 * 删除分类时的确认文案。
 *
 * 单独拎出来的原因：这是用户「动自己的数据之前」读到的最后一段话。
 * 写错了会让用户不敢删、或者删完发现历史账单还在而以为软件坏了。
 * 文案有分支（有没有小类、有没有账单），抽成纯函数才测得了每一条分支。
 */

export interface DeleteWarningInput {
  readonly name: string
  /** 这个分类下面还有几个小类。一级大类才有；二级小类恒为 0。 */
  readonly childCount: number
  /** 这个分类（含其下小类）名下共有多少笔账单。 */
  readonly usage: number
}

/**
 * 生成确认框正文。
 *
 * 三条信息按重要性排序：
 * 1. 会连带删掉什么（小类）
 * 2. 已有的账单会怎样 —— **用户最担心的是这个，任何情况下都不能省略**
 * 3. 删错了怎么找回来
 */
export function buildDeleteWarning({ name, childCount, usage }: DeleteWarningInput): string {
  const head =
    childCount > 0
      ? `「${name}」下面还有 ${childCount} 个小类，将一起删除。`
      : `「${name}」将被删除。`

  // 无论有没有账单都要提一句，让用户明确知道当前状态 ——
  // 完全不提账单，会让人以为删分类会连带着把账也删掉。
  const middle =
    usage > 0
      ? `它名下已经有 ${usage} 笔账单。这些账单不会消失，仍会照常显示和统计，只是这个分类不再出现在记账时的选择列表里。`
      : '这个分类还没有记过账，所以不会有账单受影响。'

  const tail = '删错了可以在下方的「已删除的分类」里恢复。'

  return `${head}\n\n${middle}\n\n${tail}`
}
