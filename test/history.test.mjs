import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  entriesOf,
  emptyHistory,
  isValidEntryFile,
  nextEntryFile,
  normalizeHistory,
  predecessorOf,
  upsertEntry,
} from '../lib/history.js'

/**
 * 历史快照的**纯逻辑**靶子。
 *
 * 这里锁三件最容易写错、又直接决定"能不能回到改之前"的事:
 *   1. **去重**:同一份内容被多个捕获点看到(agent 写前 / 扫描 / 保存 / 再扫描)
 *      只能留一条,否则历史被重复条目撑满、能回退的步数凭空少一半;
 *   2. **有界**:超上限从最旧裁,最新一条永远在;
 *   3. **`predecessorOf`**:靠 `version` 判"当前内容之前那一次",而不是位置。
 */

/** 造一条 entry(测试里只关心 hash/version/origin)。 */
const entry = (hash, version, origin = 'agent', at = 1) => ({ file: `n_a/${at}.md`, at, hash, size: 10, version, origin })

test('normalizeHistory:坏数据只丢坏条目,不抛', () => {
  assert.deepEqual(normalizeHistory(null), emptyHistory())
  assert.deepEqual(normalizeHistory('nonsense'), emptyHistory())
  assert.deepEqual(normalizeHistory({ notes: { n_a: null } }), emptyHistory())
  const mixed = normalizeHistory({
    notes: {
      n_a: {
        rel: 'notes/甲.md',
        version: 'v2',
        entries: [
          null,
          { file: '' },
          { file: 'n_a/1.md', at: 'x', hash: 7, size: null, version: 5, origin: '外星人' },
        ],
      },
    },
  })
  assert.deepEqual(Object.keys(mixed.notes), ['n_a'])
  assert.equal(mixed.notes.n_a.rel, 'notes/甲.md')
  assert.equal(mixed.notes.n_a.entries.length, 1, '前两条坏条目被丢掉')
  assert.deepEqual(mixed.notes.n_a.entries[0], {
    file: 'n_a/1.md',
    at: 0,
    hash: '',
    size: 0,
    version: '',
    origin: 'external',
  })
})

test('upsertEntry:同一份内容只留一条(去重靠 hash)', () => {
  let history = emptyHistory()
  const first = upsertEntry(history, 'n_a', { rel: 'notes/甲.md', version: 'v1', entry: entry('h1', 'v1') })
  assert.equal(first.added, true)
  history = first.history
  // agent 写前 → 扫描 → 保存 → 再扫描:内容没变(同一个 h1) → 一条都不该多
  const again = upsertEntry(history, 'n_a', { rel: 'notes/甲.md', version: 'v2', entry: entry('h1', 'v2', 'external', 2) })
  assert.equal(again.added, false, '同 hash 不追加')
  assert.equal(again.history.notes.n_a.entries.length, 1)
  assert.equal(again.history.notes.n_a.version, 'v2', '但"最后观察到的版本"要对齐')
  // 内容真的变了才追加
  const changed = upsertEntry(again.history, 'n_a', { rel: 'notes/甲.md', version: 'v3', entry: entry('h2', 'v3', 'external', 3) })
  assert.equal(changed.added, true)
  assert.deepEqual(changed.history.notes.n_a.entries.map((item) => item.hash), ['h1', 'h2'])
})

test('upsertEntry:超上限从最旧裁,最新一条永远在,并报出要删的文件', () => {
  let history = emptyHistory()
  for (let index = 1; index <= 5; index += 1) {
    history = upsertEntry(history, 'n_a', {
      rel: 'notes/甲.md',
      version: `v${index}`,
      entry: { file: `n_a/${index}.md`, at: index, hash: `h${index}`, size: 1, version: `v${index}`, origin: 'external' },
      maxEntries: 3,
    }).history
  }
  assert.deepEqual(history.notes.n_a.entries.map((item) => item.hash), ['h3', 'h4', 'h5'])
  const overflow = upsertEntry(history, 'n_a', {
    rel: 'notes/甲.md',
    version: 'v6',
    entry: { file: 'n_a/6.md', at: 6, hash: 'h6', size: 1, version: 'v6', origin: 'external' },
    maxEntries: 3,
  })
  assert.deepEqual(overflow.dropped, ['n_a/3.md'], '被裁掉的文件要报出来(调用方负责删)')
  assert.deepEqual(overflow.history.notes.n_a.entries.map((item) => item.hash), ['h4', 'h5', 'h6'])
})

test('entriesOf:从新到旧;predecessorOf:按 version 找"当前内容之前那一次"', () => {
  let history = emptyHistory()
  for (const [hash, version] of [['h1', 'v1'], ['h2', 'v2'], ['h3', 'v3']]) {
    history = upsertEntry(history, 'n_a', { rel: 'notes/甲.md', version, entry: entry(hash, version) }).history
  }
  assert.deepEqual(entriesOf(history, 'n_a').map((item) => item.hash), ['h3', 'h2', 'h1'])

  // 磁盘已经在 v3(扫描把当前状态补记了) → 要的是 v2 那一份,不是"倒数第二条"
  assert.equal(predecessorOf(history, 'n_a', 'v3').hash, 'h2')
  // agent 刚写完 v4、扫描还没补记 → 最新那条(v3)就是"改动之前"
  assert.equal(predecessorOf(history, 'n_a', 'v4').hash, 'h3')
  // 三条版本全等于当前 → 没有更早的状态
  assert.equal(predecessorOf(history, 'n_a', 'v1') === null, false, 'v1 那条自己也算"不是当前"的候选')
  assert.equal(predecessorOf(emptyHistory(), 'n_a', 'v1'), null)
  assert.equal(predecessorOf(history, 'n_unknown', 'v1'), null)
})

test('predecessorOf:跳过所有与当前版本相同的条目(不管它在哪个位置)', () => {
  let history = emptyHistory()
  // 造出"当前版本出现两次"的脏历史(同一内容 hash 不同版本时不会发生,但索引可能被手改)
  history = upsertEntry(history, 'n_a', { rel: '', version: 'v2', entry: entry('h1', 'v2') }).history
  history = upsertEntry(history, 'n_a', { rel: '', version: 'v1', entry: entry('h2', 'v1') }).history
  history = upsertEntry(history, 'n_a', { rel: '', version: 'v2', entry: entry('h3', 'v2') }).history
  assert.equal(predecessorOf(history, 'n_a', 'v2').hash, 'h2', '最新两条都是 v2,要跳到更早的那条')
})

test('isValidEntryFile:挡住目录穿越与乱名', () => {
  assert.equal(isValidEntryFile('n_a', 'n_a/1790123456789.md'), true)
  assert.equal(isValidEntryFile('n_a', 'n_a/1790123456789-2.md'), true)
  assert.equal(isValidEntryFile('n_a', 'n_b/1790123456789.md'), false, '不是这篇笔记的目录')
  assert.equal(isValidEntryFile('n_a', 'n_a/../../secret.md'), false)
  assert.equal(isValidEntryFile('n_a', '/etc/passwd'), false)
  assert.equal(isValidEntryFile('n_a', 'n_a/not-a-number.md'), false)
  assert.equal(isValidEntryFile('n_a', 'n_a\\1790123456789.md'), false, '反斜杠不认')
  assert.equal(isValidEntryFile('', 'n_a/1790123456789.md'), false)
})

test('nextEntryFile:撞名就加序号,同毫秒连写也不会互相覆盖', () => {
  assert.equal(nextEntryFile('n_a', 1000), 'n_a/1000.md')
  const taken = new Set(['n_a/1000.md'])
  assert.equal(nextEntryFile('n_a', 1000, taken), 'n_a/1000-2.md')
  taken.add('n_a/1000-2.md')
  assert.equal(nextEntryFile('n_a', 1000, taken), 'n_a/1000-3.md')
})
