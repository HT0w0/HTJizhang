/**
 * 删除前的确认文案。
 *
 * 单独拎出来的原因：这是用户「动自己的数据之前」读到的最后一段话。
 * 写错了会让用户不敢删、或者删完发现数据没了而以为软件坏了。
 * 文案有分支（有没有小类、有没有账单、有没有备注），抽成纯函数才测得了每一条分支。
 */
import { formatYuan } from './money'
import { formatLocalDateForDisplay } from './localDate'

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

export interface TransactionDeleteWarningInput {
  readonly categoryName: string
  /** 金额，单位「分」。显示时换算成元。 */
  readonly amountFen: number
  /** 本地日期 YYYY-MM-DD。 */
  readonly occurredOn: string
  /** 备注。可以是空串。 */
  readonly note: string
}

/**
 * 删除一笔账的确认框正文。
 *
 * 与删分类不同，这里是**真删、删完找不回来**（用户 2026-10-04 拍板：不做回收站）。
 * 所以正文分两段：
 * 1. 先说清删的是哪一笔 —— 列表里行挨着行，用户很容易点错行。
 *    分类 + 金额 + 日期 + 备注拼起来，足够他认出是哪一笔。
 * 2. 再明确写「无法恢复」。这一句是用户点名要求写上的，
 *    措辞不要改动，除非他改口。
 */
export function buildTransactionDeleteWarning({
  categoryName,
  amountFen,
  occurredOn,
  note
}: TransactionDeleteWarningInput): string {
  const firstLine = `${categoryName}　${formatYuan(amountFen)} 元`
  // 没有备注就不留占位符：多一个全角空格看不出来，但拼出来是「2026年10月4日　」这种
  // 带尾巴的字符串，测试和人眼都不好分辨。
  const secondLine = `${formatLocalDateForDisplay(occurredOn)}${note === '' ? '' : `　${note}`}`

  return `${firstLine}\n${secondLine}\n\n删除后将无法恢复数据，请确认删除`
}
