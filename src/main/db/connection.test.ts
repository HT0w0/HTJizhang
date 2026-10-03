import { test, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, closeDatabase, defaultDatabasePath } from './connection'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ht-db-'))
}

test('默认数据库路径拼在 userData 目录下，且用 path.join', () => {
  const dir = join('C:', 'Users', 'x', 'AppData', 'Roaming', 'HTJizhang')
  expect(defaultDatabasePath(dir)).toBe(join(dir, 'ht-jizhang.db'))
})

test('打不开的路径（目录不存在）会抛错，让调用方能拦下来给中文提示', () => {
  const dir = tempDir()
  const missing = join(dir, '不存在的子目录', 'a.db')
  expect(() => openDatabase(missing)).toThrow()
  rmSync(dir, { recursive: true, force: true })
})

test('WAL 与 foreign_keys 都真的生效', () => {
  const dir = tempDir()
  const db = openDatabase(join(dir, 'a.db'))
  const wal = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
  expect(wal.journal_mode).toBe('wal')
  const fk = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
  expect(fk.foreign_keys).toBe(1)
  closeDatabase(db)
  rmSync(dir, { recursive: true, force: true })
})

test('父目录不存在时，先建目录再开库就能成功（首次启动的真实场景）', () => {
  const dir = tempDir()
  const nested = join(dir, 'HTJizhang')
  mkdirSync(nested, { recursive: true })
  const db = openDatabase(join(nested, 'a.db'))
  expect(db.isOpen).toBe(true)
  closeDatabase(db)
  rmSync(dir, { recursive: true, force: true })
})

test('closeDatabase 重复调用不抛错（node:sqlite 原生的 close 会抛）', () => {
  const dir = tempDir()
  const db = openDatabase(join(dir, 'a.db'))
  closeDatabase(db)
  expect(() => closeDatabase(db)).not.toThrow()
  expect(db.isOpen).toBe(false)
  rmSync(dir, { recursive: true, force: true })
})
