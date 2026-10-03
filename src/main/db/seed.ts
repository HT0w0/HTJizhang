/**
 * 内置分类种子数据。
 *
 * 清单来源：docs/产品设计文档.md 第五节「内置分类表」。
 * 支出 11 大类 / 61 小类，收入 5 大类 / 19 小类，合计 16 + 80 = 96 条。
 *
 * builtin_key 是「恢复内置分类」的锚点：用户在设置里删掉（归档）某个内置分类后，
 * 能靠这个固定编号找回它原本的名字、图标和位置。
 * 因此 **builtin_key 一经发布就不可更改** —— 改分类名、改图标、调顺序都不能动它。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { CategoryKind } from '@shared/types'

export interface BuiltinChild {
  readonly name: string
  readonly icon: string
}

export interface BuiltinCategorySeed {
  readonly kind: CategoryKind
  readonly name: string
  readonly icon: string
  readonly children: readonly BuiltinChild[]
}

export const BUILTIN_CATEGORIES: readonly BuiltinCategorySeed[] = [
  {
    kind: 'expense',
    name: '餐饮',
    icon: '🍜',
    children: [
      { name: '早餐', icon: '🥐' },
      { name: '午餐', icon: '🍚' },
      { name: '晚餐', icon: '🍲' },
      { name: '夜宵', icon: '🍢' },
      { name: '饮料零食', icon: '🥤' },
      { name: '咖啡奶茶', icon: '☕' },
      { name: '外卖', icon: '🛵' },
      { name: '聚餐请客', icon: '🍻' },
      { name: '买菜食材', icon: '🥬' }
    ]
  },
  {
    kind: 'expense',
    name: '交通',
    icon: '🚌',
    children: [
      { name: '公交地铁', icon: '🚇' },
      { name: '打车网约车', icon: '🚕' },
      { name: '共享单车', icon: '🚲' },
      { name: '火车高铁', icon: '🚄' },
      { name: '飞机', icon: '✈️' },
      { name: '自驾加油', icon: '⛽' },
      { name: '停车费', icon: '🅿️' },
      { name: '过路费', icon: '🛣️' }
    ]
  },
  {
    kind: 'expense',
    name: '购物',
    icon: '🛍️',
    children: [
      { name: '服饰鞋包', icon: '👕' },
      { name: '数码电子', icon: '💻' },
      { name: '美妆护肤', icon: '💄' },
      { name: '日用百货', icon: '🧴' },
      { name: '家居家装', icon: '🛋️' },
      { name: '母婴用品', icon: '🍼' },
      { name: '图书文具', icon: '📚' }
    ]
  },
  {
    kind: 'expense',
    name: '居住',
    icon: '🏠',
    children: [
      { name: '房租', icon: '🔑' },
      { name: '房贷', icon: '🏦' },
      { name: '物业费', icon: '🏢' },
      { name: '水电燃气', icon: '💡' },
      { name: '维修保洁', icon: '🔧' }
    ]
  },
  {
    kind: 'expense',
    name: '通讯',
    icon: '📞',
    children: [
      { name: '手机话费', icon: '📱' },
      { name: '宽带网络', icon: '🌐' },
      { name: '流量充值', icon: '📶' },
      { name: '快递邮寄', icon: '📦' }
    ]
  },
  {
    kind: 'expense',
    name: '娱乐',
    icon: '🎮',
    children: [
      { name: '电影演出', icon: '🎬' },
      { name: '旅游度假', icon: '🏖️' },
      { name: '运动健身', icon: '🏃' },
      { name: '游戏充值', icon: '🕹️' },
      { name: '会员订阅', icon: '🎫' },
      { name: '酒吧KTV', icon: '🎤' }
    ]
  },
  {
    kind: 'expense',
    name: '医疗健康',
    icon: '💊',
    children: [
      { name: '门诊挂号', icon: '🏥' },
      { name: '药品', icon: '💊' },
      { name: '住院手术', icon: '🛏️' },
      { name: '体检', icon: '🩺' },
      { name: '牙科眼科', icon: '🦷' },
      { name: '保健品', icon: '🧬' }
    ]
  },
  {
    kind: 'expense',
    name: '学习教育',
    icon: '📚',
    children: [
      { name: '学费', icon: '🎓' },
      { name: '培训课程', icon: '📖' },
      { name: '考试报名', icon: '📝' },
      { name: '书籍资料', icon: '📗' },
      { name: '学习工具', icon: '✏️' }
    ]
  },
  {
    kind: 'expense',
    name: '人情往来',
    icon: '🎁',
    children: [
      { name: '红包礼金', icon: '🧧' },
      { name: '送礼', icon: '🎀' },
      { name: '孝敬长辈', icon: '👴' },
      { name: '慈善捐赠', icon: '🤝' }
    ]
  },
  {
    kind: 'expense',
    name: '金融保险',
    icon: '🏦',
    children: [
      { name: '保险费', icon: '🛡️' },
      { name: '利息支出', icon: '📉' },
      { name: '手续费', icon: '🧾' },
      { name: '投资亏损', icon: '📊' }
    ]
  },
  {
    kind: 'expense',
    name: '其他支出',
    icon: '📦',
    children: [
      { name: '罚款', icon: '🚨' },
      { name: '意外损失', icon: '💥' },
      { name: '未分类', icon: '❓' }
    ]
  },
  {
    kind: 'income',
    name: '工资薪酬',
    icon: '💰',
    children: [
      { name: '月薪', icon: '💵' },
      { name: '加班费', icon: '⏰' },
      { name: '奖金', icon: '🏆' },
      { name: '年终奖', icon: '🎊' }
    ]
  },
  {
    kind: 'income',
    name: '经营副业',
    icon: '💼',
    children: [
      { name: '兼职', icon: '🧑‍💻' },
      { name: '副业', icon: '🛠️' },
      { name: '稿费', icon: '✍️' },
      { name: '提成', icon: '📈' }
    ]
  },
  {
    kind: 'income',
    name: '投资理财',
    icon: '📈',
    children: [
      { name: '利息', icon: '🏛️' },
      { name: '分红', icon: '🍰' },
      { name: '基金股票收益', icon: '📊' },
      { name: '房租收入', icon: '🏘️' }
    ]
  },
  {
    kind: 'income',
    name: '人情收入',
    icon: '🧧',
    children: [
      { name: '红包', icon: '🎁' },
      { name: '礼金', icon: '💌' },
      { name: '报销', icon: '🧾' },
      { name: '中奖', icon: '🎉' }
    ]
  },
  {
    kind: 'income',
    name: '其他收入',
    icon: '📥',
    children: [
      { name: '退款', icon: '↩️' },
      { name: '意外所得', icon: '🍀' },
      { name: '未分类', icon: '❓' }
    ]
  }
]

function nowIso(): string {
  return new Date().toISOString()
}

function builtinKeyOf(kind: CategoryKind, major: string, child?: string): string {
  return child === undefined ? `${kind}/${major}` : `${kind}/${major}/${child}`
}

/**
 * 把内置分类写进数据库。返回本次新插入的行数。
 *
 * 幂等：程序每次启动都会调用它，已存在的（按 builtin_key 认）一律跳过。
 * 关键点 —— **跳过而不是覆盖**：用户改过的名字、图标必须原样保留，
 * 用户归档掉的分类也不能被强行恢复，否则会出现「删了又自己长回来」。
 *
 * 排序号每次都重新查一遍当前最大值再加一，而不是写死 0..N：
 * 用户可能在内置分类播种之前就自己建过大类。
 */
export function seedBuiltinCategories(db: DatabaseSync): number {
  const findByKey = db.prepare('SELECT id FROM categories WHERE builtin_key = ?')
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

  const timestamp = nowIso()
  let inserted = 0

  for (const major of BUILTIN_CATEGORIES) {
    const majorKey = builtinKeyOf(major.kind, major.name)
    const existingMajor = findByKey.get(majorKey) as { id: number } | undefined

    let majorId: number
    if (existingMajor) {
      majorId = existingMajor.id
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
      const childKey = builtinKeyOf(major.kind, major.name, child.name)
      if (findByKey.get(childKey)) continue

      const order = (maxChildSort.get(majorId) as { m: number }).m + 1
      insert.run(major.kind, majorId, child.name, child.icon, order, childKey, timestamp, timestamp)
      inserted += 1
    }
  }

  return inserted
}
