---
name: issue-creator
description: Create a local issue document in internal_docs/issues/. Use when user reports a bug, requests a feature, or wants to document a technical investigation. Triggers on "issue作成", "issue書いて", "issueにして", "issue-creator", or when investigation results should be formalized.
---

# Issue Creator

`internal_docs/issues/` に issue ドキュメントを作成するスキル。

**このスキルのスコープは issue の作成まで。コードの実装は行わない。**

## フロー

### Phase 1: 調査

1. ユーザーの指示に基づき、コードベース調査・Web 検索等を実施
2. 問題の現状、原因、影響範囲を特定
3. 調査結果をユーザーに報告し、「この内容で issue を作成して良いか」を確認する

**調査段階でコードは書かない。**

### Phase 2: Issue ドキュメント作成

ユーザーが肯定した場合のみ、以下の手順で issue を作成する。

#### 1. 番号の採番

```bash
ls internal_docs/issues/*.md internal_docs/issues/done/*.md 2>/dev/null
```

既存の最大番号 + 1 を採番する（done/ 内も含めて重複しないようにする）。ゼロパディングで2桁（例: `09`）。

#### 2. ファイル作成

`internal_docs/issues/{番号}-{slug}.md` に以下のフォーマットで作成:

```markdown
# {タイトル}

## 概要

{1-3文で問題・目的を要約}

## 現状の実装

{関連するコードの現状を、ファイルパスとコード抜粋付きで説明}

## 実装方針

{具体的な変更内容をコード例付きで記述。セクション分けして段階的に説明}

## エッジケース

{考慮すべき境界条件、互換性、副作用}

## 関連ファイル

- `path/to/file.ts` — 変更内容の概要
```

#### 3. フォーマットルール

- 言語: 日本語
- コード例は実際のコードベースに基づいた具体的なものにする
- 「現状の実装」では grep/read で確認した実際のコードを引用する
- 「実装方針」は実装者がそのまま作業できる粒度で書く
- slug は英語のケバブケース（例: `streaming-response`, `model-selection`）

### Phase 3: セルフチェックと完了報告

1. 作成した issue の内容をセルフチェック（フォーマット、具体性、漏れがないか）
2. 問題なければ issue のパスとサマリーをユーザーに報告する
