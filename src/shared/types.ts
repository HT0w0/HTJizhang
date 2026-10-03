/**
 * 界面与主进程之间的接口契约。
 *
 * 主进程通过 src/preload/index.ts 实现这个接口，渲染进程通过 window.ht 调用。
 * 两边共用同一份类型定义，任何一边改了签名，另一边立刻会显示类型错误（CLAUDE.md §5.3）。
 *
 * 第 1 阶段只有版本号占位；第 2 阶段起在这里声明数据库相关的方法。
 *
 * 硬性要求：本文件不得依赖任何一方的运行环境专有类型（例如 Node 的 NodeJS 命名空间），
 * 因为渲染进程的类型检查配置里没有引入 Node 的类型声明。
 */
export interface HtApi {
  /** 当前运行的系统：'win32' | 'darwin' | 'linux'，类型上放宽为 string 以保持本文件不依赖 Node */
  readonly platform: string
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
}
