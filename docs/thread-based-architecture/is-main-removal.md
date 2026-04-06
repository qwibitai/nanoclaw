# is_main カラム完全削除の計画

## 現状

`registered_groups` テーブルには `is_main` (INTEGER) と `group_type` (TEXT) の2カラムが共存している。
`group_type` は feat/group-type で追加された新しい権限管理の主カラムであり、`is_main` はレガシー。

### 現在の依存箇所

| 箇所 | 用途 | 状態 |
|------|------|------|
| `src/db.ts` `parseGroupType()` | `group_type = NULL` の行を `is_main` で救済 | NULL 限定のフォールバックとして残存 |
| `src/db.ts` `setRegisteredGroup()` | `is_main` カラムへの書き込み | 新規登録・更新のたびに同期 |
| DB スキーマ | `is_main INTEGER DEFAULT 0` カラム | 残存 |

---

## 削除手順

### Step 1: DB マイグレーション追加（`src/db.ts`）

既存のマイグレーションパターン（try-catch）に従い追加する。

```ts
// NULL な group_type を is_main から救済してからカラムを削除
try {
  database.exec(`
    UPDATE registered_groups
    SET group_type = 'main'
    WHERE is_main = 1 AND group_type IS NULL
  `);
  database.exec(
    `ALTER TABLE registered_groups DROP COLUMN is_main`,
  );
} catch {
  /* カラムはすでに削除済み */
}
```

> **注意:** SQLite 3.35.0 (2021-03-12) 以降が必要。
> `better-sqlite3` がバンドルするバージョンを事前に確認すること。
> 確認コマンド:
> ```bash
> node -e "const db = require('better-sqlite3')(':memory:'); console.log(db.prepare('SELECT sqlite_version()').pluck().get())"
> ```

### Step 2: `parseGroupType()` の簡素化（`src/db.ts`）

```ts
function parseGroupType(groupType: string | null): GroupType {
  if (groupType == null) return 'chat'; // is_main フォールバック不要
  if (VALID_GROUP_TYPES.has(groupType)) return groupType as GroupType;
  logger.warn({ groupType }, 'Invalid group_type in DB; falling back to "chat".');
  return 'chat';
}
```

呼び出し側も `parseGroupType(row.group_type)` に変更（`row.is_main` 参照を削除）。

### Step 3: `setRegisteredGroup()` の簡素化（`src/db.ts`）

INSERT OR REPLACE 文から `is_main` カラムを削除:

```sql
INSERT OR REPLACE INTO registered_groups
  (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, group_type)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```

`run()` の引数からも `is_main` 相当の値を削除する。

### Step 4: 型定義の整理（`src/types.ts`）

`RegisteredGroup` に `isMain` が残っていないか確認し、あれば削除する。

---

## リスク

- **クローンして自己ホストしているユーザーへの影響:** 実行環境の DB で `group_type = NULL` かつ `is_main = 1` な行があると、Step 1 のマイグレーションで `'main'` に昇格してから DROP されるため、データは保全される。
- **SQLite バージョン制約:** 3.35.0 未満では `DROP COLUMN` が使えない。その場合はテーブル再作成方式（CREATE new → INSERT SELECT → DROP old → RENAME）が必要。

---

## 実施判断

- 自分のサーバーのみで使っている場合: いつでも実施可
- パブリックリポジトリとして公開中の場合: クローン使用者への影響が軽微であることを確認してから実施
