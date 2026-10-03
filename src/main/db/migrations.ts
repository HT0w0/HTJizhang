/**
 * 数据库结构迁移。
 *
 * 用 SQLite 自带的 PRAGMA user_version 记录当前结构版本。
 * 每次改结构就追加一条新 Migration，绝不修改已发布的旧条目——
 * 用户机器上的库已经按旧条目建好了，改旧条目会让新旧版本结构不一致。
 *
 * 已实测：user_version 是事务性的。迁移中途失败时 ROLLBACK
 * 会把版本号和建的表一起退回，下次启动从干净状态重来。
 */
import type { DatabaseSync } from 'node:sqlite'

export interface Migration {
  readonly version: number
  readonly up: (db: DatabaseSync) => void
}

/**
 * v1：建表。
 *
 * categories.parent_id 为 NULL 表示一级大类，非 NULL 表示二级小类。
 * categories.builtin_key 是内置分类的固定编号，改名不会动它——
 * 「恢复内置分类」靠它认出「这条内置分类原本叫什么、本来该在哪」。
 * 用户自己建的分类此项为 NULL（SQLite 的 UNIQUE 允许多个 NULL）。
 *
 * transactions 的两个触发器强制「只能挂二级小类」和「收支类型必须一致」
 * （CLAUDE.md §5.12）。写在数据库层面比靠代码自觉可靠——
 * 将来任何新增的写入路径都绕不过去。
 */
const SCHEMA_V1 = `
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL CHECK (kind IN ('expense','income')),
  parent_id   INTEGER REFERENCES categories(id),
  name        TEXT    NOT NULL,
  icon        TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
  builtin_key TEXT    UNIQUE,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX idx_cat_parent ON categories(parent_id);
CREATE INDEX idx_cat_sort   ON categories(parent_id, sort_order);

CREATE TABLE transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT    NOT NULL CHECK (kind IN ('expense','income')),
  amount_fen     INTEGER NOT NULL CHECK (amount_fen > 0),
  category_id    INTEGER NOT NULL REFERENCES categories(id),
  occurred_on    TEXT    NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  payment_method TEXT    NOT NULL DEFAULT 'other',
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE INDEX idx_tx_date ON transactions(occurred_on);
CREATE INDEX idx_tx_cat  ON transactions(category_id);

CREATE TRIGGER trg_tx_insert_guard BEFORE INSERT ON transactions
BEGIN
  SELECT CASE
    WHEN (SELECT parent_id FROM categories WHERE id = NEW.category_id) IS NULL
      THEN RAISE(ABORT, '账单必须挂在二级小类上，不能直接挂一级大类')
  END;
  SELECT CASE
    WHEN (SELECT kind FROM categories WHERE id = NEW.category_id) <> NEW.kind
      THEN RAISE(ABORT, '账单的收支类型与所选分类不一致')
  END;
END;

CREATE TRIGGER trg_tx_update_guard BEFORE UPDATE ON transactions
BEGIN
  SELECT CASE
    WHEN (SELECT parent_id FROM categories WHERE id = NEW.category_id) IS NULL
      THEN RAISE(ABORT, '账单必须挂在二级小类上，不能直接挂一级大类')
  END;
  SELECT CASE
    WHEN (SELECT kind FROM categories WHERE id = NEW.category_id) <> NEW.kind
      THEN RAISE(ABORT, '账单的收支类型与所选分类不一致')
  END;
END;
`

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db: DatabaseSync): void => {
      db.exec(SCHEMA_V1)
    }
  }
]

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
  return row?.user_version ?? 0
}

function assertVersionsAscending(migrations: readonly Migration[]): void {
  for (let i = 1; i < migrations.length; i += 1) {
    if (migrations[i].version <= migrations[i - 1].version) {
      throw new Error(
        `迁移版本号必须严格递增：第 ${i} 条是 ${migrations[i].version}，` +
          `前一条是 ${migrations[i - 1].version}`
      )
    }
  }
}

/**
 * 把数据库结构推进到最新版本，返回本次实际执行的迁移条数。
 *
 * 每条迁移单独一个事务：成功则「建表 + 版本号」一起提交，
 * 失败则一起回滚，不会出现「表建了一半、版本号却已经前进」的坏状态。
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): number {
  assertVersionsAscending(migrations)

  let applied = 0

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 0) {
      throw new Error(`迁移版本号必须是非负整数，收到 ${String(migration.version)}`)
    }
    // 每条迁移都重新读一次版本号：上一条刚提交过，不能用循环外读的旧值
    if (migration.version <= readUserVersion(db)) continue

    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      // PRAGMA 不支持参数绑定，只能拼字符串；上面已校验过是整数
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
      applied += 1
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 连接已经不可用，回滚失败。原始错误更重要，继续往上抛。
      }
      throw error
    }
  }

  return applied
}
