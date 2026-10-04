/**
 * 界面与主进程之间的接口契约。
 *
 * 主进程通过 src/preload/index.ts 实现这个接口，渲染进程通过 window.ht 调用。
 * 两边共用同一份类型定义，任何一边改了签名，另一边立刻会显示类型错误（CLAUDE.md §5.3）。
 *
 * 硬性要求：本文件不得依赖任何一方的运行环境专有类型（例如 Node 的 NodeJS 命名空间），
 * 因为渲染进程的类型检查配置里没有引入 Node 的类型声明。
 */

import type { PaymentMethod } from './paymentMethods'

// 再导出一次，让「主进程 / 界面」只需要认 @shared/types 一个入口，
// 不用去记 PaymentMethod 实际住在哪个文件里。
export type { PaymentMethod } from './paymentMethods'

/** 一笔账是支出还是收入。分类和账单都带这个字段。 */
export type CategoryKind = 'expense' | 'income'

/** 一笔账。 */
export interface Transaction {
  readonly id: number
  readonly kind: CategoryKind
  /** 金额，单位「分」。界面上的 12.34 元在这里是 1234（CLAUDE.md §5.1）。 */
  readonly amountFen: number
  /** 必须指向二级小类（§5.12） */
  readonly categoryId: number
  /** 本地日期串 'YYYY-MM-DD'，不是时间戳（§5.2） */
  readonly occurredOn: string
  readonly note: string
  readonly paymentMethod: PaymentMethod
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * 账单列表里的一行：账单本身 + 它的分类信息。
 *
 * 为什么要把分类名一起带出来：列表每行都要显示「午餐」和它所属的「餐饮」，
 * 如果只给 categoryId，界面就得自己拿分类树去查 —— 61 个小类逐个 find 一遍，
 * 而且分类改名后列表里的旧行会跟着变，反而绕。数据库一次 JOIN 出来最省事。
 */
export interface TransactionListItem extends Transaction {
  /** 二级小类名，如「午餐」 */
  readonly categoryName: string
  /** 所属一级大类名，如「餐饮」 */
  readonly majorName: string
  /** 所属一级大类图标 */
  readonly majorIcon: string
}

export interface CreateTransactionInput {
  readonly kind: CategoryKind
  readonly amountFen: number
  readonly categoryId: number
  readonly occurredOn: string
  readonly note: string
  readonly paymentMethod: PaymentMethod
}

/** 一条分类。parentId 为 null 表示一级大类，非 null 表示二级小类。 */
export interface Category {
  readonly id: number
  readonly kind: CategoryKind
  readonly parentId: number | null
  readonly name: string
  readonly icon: string
  readonly sortOrder: number
  readonly isArchived: boolean
  readonly isBuiltin: boolean
}

/**
 * 界面用来渲染的分类树节点。
 * 本项目只有两级，所以 children 里各项的 children 恒为空数组。
 */
export interface CategoryNode extends Category {
  readonly children: readonly CategoryNode[]
}

export interface CreateCategoryInput {
  readonly kind: CategoryKind
  readonly parentId: number | null
  readonly name: string
  readonly icon: string
}

/**
 * IPC 的统一返回形状。
 *
 * 为什么不直接抛异常：Electron 的 ipcMain.handle 抛出后，渲染进程收到的错误信息
 * 会被包成 "Error invoking remote method 'categories:create': Error: 分类重名"，
 * 这串英文没法直接给用户看。包一层之后，渲染进程能拿到干干净净的中文原话。
 */
export type IpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string }

export interface CategoriesApi {
  /** 未归档的分类树（大类 + 其下小类） */
  list(): Promise<CategoryNode[]>
  /** 已归档分类树的「根」——归档大类时只返回大类一行，恢复时整棵一起回来 */
  listArchived(): Promise<CategoryNode[]>
  /** 每个分类名下有多少笔账单：{ 分类id: 笔数 } */
  usage(): Promise<Record<number, number>>
  create(input: CreateCategoryInput): Promise<Category>
  rename(id: number, name: string): Promise<void>
  setIcon(id: number, icon: string): Promise<void>
  reorder(kind: CategoryKind, parentId: number | null, orderedIds: readonly number[]): Promise<void>
  /** 归档。若是一级大类，其下所有小类一并归档。 */
  archive(id: number): Promise<void>
  /** 从归档中恢复。若是一级大类，其下所有小类一并恢复。 */
  restore(id: number): Promise<void>
  /** 把缺失的内置分类补回来（改名过的不动、没删的不动）。返回补回的条数。 */
  restoreBuiltins(): Promise<number>
}

export interface TransactionsApi {
  create(input: CreateTransactionInput): Promise<Transaction>
  /** 最近用过的分类 id，最近的在最前。用于把常用分类置顶。 */
  recentCategoryIds(): Promise<number[]>
  /** 今天的本地日期串。由主进程给，避免界面自己算时用错时区（§5.2）。 */
  today(): Promise<string>
}

export interface HtApi {
  /** 当前运行的系统：'win32' | 'darwin' | 'linux'，类型上放宽为 string 以保持本文件不依赖 Node */
  readonly platform: string
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
  readonly categories: CategoriesApi
  readonly transactions: TransactionsApi
}
