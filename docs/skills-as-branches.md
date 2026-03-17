# ブランチとしてのスキル (Skills as Branches)

## 概要

NanoClaw のスキルは、アップストリームのリポジトリ上の git ブランチとして配布されます。スキルを適用することは `git merge` であり、コアを更新することも `git merge` です。すべてが標準的な git 操作です。

これは、以前の `skills-engine/` システム（3ウェイファイルマージ、`.nanoclaw/` ステート、マニフェストファイル、リプレイ、バックアップ/リストア）を、単純な git 操作とコンフリクト解消のための Claude に置き換えるものです。

## 仕組み

### リポジトリ構造

アップストリームのリポジトリ (`qwibitai/nanoclaw`) は以下を維持します：

- `main` — NanoClaw コア（スキルコードなし）
- `skill/discord` — main + Discord 連携
- `skill/telegram` — main + Telegram 連携
- `skill/slack` — main + Slack 連携
- `skill/gmail` — main + Gmail 連携
- など

各スキルブランチには、そのスキルのためのすべてのコード変更が含まれています：新規ファイル、修正されたソースファイル、更新された `package.json` の依存関係、`.env.example` の追加項目など、すべてです。マニフェストも構造化された操作も、個別の `add/` や `modify/` ディレクトリもありません。

### スキルの発見とインストール

スキルは 2 つのカテゴリに分けられます：

**運用スキル (Operational skills)** (`main` にあり、常に利用可能)：
- `/setup`, `/debug`, `/update-nanoclaw`, `/customize`, `/update-skills`
- これらは指示のみの SKILL.md ファイルであり、コードの変更はなく、ワークフローのみを定義します。
- `main` の `.claude/skills/` にあり、すべてのユーザーがすぐに利用できます。

**機能スキル (Feature skills)** (マーケットプレイスにあり、オンデマンドでインストール)：
- `/add-discord`, `/add-telegram`, `/add-slack`, `/add-gmail` など。
- 各スキルには、セットアップ手順が記載された SKILL.md と、コードが含まれる対応する `skill/*` ブランチがあります。
- マーケットプレイスリポジトリ (`qwibitai/nanoclaw-skills`) にあります。

ユーザーがマーケットプレイスを直接操作することはありません。運用スキルの `/setup` と `/customize` がプラグインのインストールを透過的に処理します：

```bash
# Claude がバックグラウンドでこれを実行します — ユーザーには見えません
claude plugin install nanoclaw-skills@nanoclaw-skills --scope project
```

スキルは `claude plugin install` の後にホットロードされ、再起動は不要です。つまり、`/setup` でマーケットプレイスプラグインをインストールし、同じセッション内ですぐに機能スキルを実行できます。

### 選択的なスキルのインストール

`/setup` はユーザーに使用したいチャネルを尋ね、関連するスキルのみを提案します：

1. 「どのメッセージングチャネルを使用しますか？」 → Discord, Telegram, Slack, WhatsApp
2. ユーザーが Telegram を選択 → Claude がプラグインをインストールし、`/add-telegram` を実行
3. Telegram のセットアップ後：「Telegram 用の Agent Swarm サポートを追加しますか？」 → `/add-telegram-swarm` を提案
4. 「コミュニティスキルを有効にしますか？」 → コミュニティマーケットプレイスプラグインをインストール

依存関係のあるスキル（例：`telegram-swarm` は `telegram` に依存）は、親スキルがインストールされた後にのみ提案されます。`/customize` もセットアップ後の追加について同様のパターンに従います。

### マーケットプレイスの設定

NanoClaw の `.claude/settings.json` は公式マーケットプレイスを登録します：

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

マーケットプレイスリポジトリは Claude Code のプラグイン構造を使用します：

```
qwibitai/nanoclaw-skills/
  .claude-plugin/
    marketplace.json              # プラグインカタログ
  plugins/
    nanoclaw-skills/              # 公式スキルをすべてバンドルした単一プラグイン
      .claude-plugin/
        plugin.json               # プラグインマニフェスト
      skills/
        add-discord/
          SKILL.md                # セットアップ手順。ステップ1は「ブランチをマージする」
        add-telegram/
          SKILL.md
        add-slack/
          SKILL.md
        ...
```

複数のスキルが 1 つのプラグインにバンドルされています。`nanoclaw-skills` をインストールすると、すべての機能スキルが一度に利用可能になります。個々のスキルを個別にインストールする必要はありません。

各 SKILL.md は、ステップ 1 として対応するスキルブランチをマージするように Claude に指示し、その後、対話型のセットアップ（環境変数、ボット作成など）を進めます。

### スキルの適用

ユーザーが `/add-discord` を実行します（マーケットプレイス経由で発見）。Claude は SKILL.md に従います：

1. `git fetch upstream skill/discord`
2. `git merge upstream/skill/discord`
3. 対話型セットアップ（ボット作成、トークン取得、環境変数の設定など）

または手動で：

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
```

### 複数のスキルの適用

```bash
git merge upstream/skill/discord
git merge upstream/skill/telegram
```

git が合成を処理します。両方のスキルが同じ行を修正した場合、それは本物のコンフリクトとなり、Claude がそれを解決します。

### コアの更新

```bash
git fetch upstream main
git merge upstream/main
```

スキルブランチは main とマージフォワード（常に最新の状態に保つ）されているため（CI セクション参照）、ユーザーがマージしたスキルの変更とアップストリームの変更は適切な共通の祖先を持ちます。

### スキルの更新確認

以前にスキルブランチをマージしたユーザーは、更新を確認できます。各 `upstream/skill/*` ブランチについて、そのブランチにユーザーの HEAD にないコミットがあるかどうかを確認します：

```bash
git fetch upstream
for branch in $(git branch -r | grep 'upstream/skill/'); do
  # ユーザーが過去にこのスキルをマージしたか確認
  merge_base=$(git merge-base HEAD "$branch" 2>/dev/null) || continue
  # スキルブランチにユーザーが持っている以上の新しいコミットがあるか確認
  if ! git merge-base --is-ancestor "$branch" HEAD 2>/dev/null; then
    echo "$branch にアップデートがあります"
  fi
done
```

これにステート（状態保存）は不要です。git の履歴を使用して、以前にどのスキルがマージされたか、そして新しいコミットがあるかどうかを判断します。

このロジックは 2 つの方法で利用できます：
- `/update-nanoclaw` に組み込まれている — main をマージした後、オプションでスキルの更新を確認
- スタンドアロンの `/update-skills` — スキルの更新を個別に確認してマージ

### コンフリクト解消

マージのどのステップでも、コンフリクトが発生する可能性があります。Claude はそれらを解決します — コンフリクトしたファイルを読み、両側の意図を理解し、正しい結果を生成します。これが、ブランチアプローチを大規模に実行可能にしている理由です。以前は人間の判断が必要だったコンフリクト解消が、今では自動化されています。

### スキルの依存関係

一部のスキルは他のスキルに依存しています。例えば、`skill/telegram-swarm` は `skill/telegram` を必要とします。依存するスキルブランチは、`main` からではなく、親スキルのブランチから分岐します。

これは、`skill/telegram-swarm` には telegram のすべての変更と、それ自体の追加分が含まれていることを意味します。ユーザーが `skill/telegram-swarm` をマージすると、両方の変更が取り込まれます。telegram を個別にマージする必要はありません。

依存関係は git の履歴に暗黙的に含まれています — `git merge-base --is-ancestor` が、あるスキルブランチが別のスキルブランチの祖先であるかどうかを判断します。個別の依存関係ファイルは不要です。

### スキルのアンインストール

```bash
# マージコミットを探す
git log --merges --oneline | grep discord

# それをリバート（取り消し）する
git revert -m 1 <merge-commit>
```

これにより、スキルの変更を元に戻す新しいコミットが作成されます。Claude がフロー全体を処理できます。

ユーザーがマージ後にスキルのコードを修正していた場合（その上に独自の変更を加えている場合）、リバートでコンフリクトが発生する可能性がありますが、Claude が解決します。

後でユーザーがスキルを再適用したい場合は、まずリバートをリバートする必要があります（git はリバートされた変更を「適用済みで取り消された」ものとして扱うため）。Claude はこれも処理します。

## CI: スキルブランチを最新に保つ

GitHub Action が `main` へのプッシュごとに実行されます：

1. すべての `skill/*` ブランチをリストアップ
2. 各スキルブランチについて、`main` をそこにマージ（リベースではなくマージフォワード）
3. マージ後の結果でビルドとテストを実行
4. テストに合格した場合は、更新されたスキルブランチをプッシュ
5. スキルが失敗した場合（コンフリクト、ビルドエラー、テスト失敗）、手動解決のために GitHub Issue を作成

**なぜリベースではなくマージフォワードなのか：**
- 強制プッシュ（force-push）が不要 — すでにスキルをマージしたユーザーの履歴を保護
- ユーザーはスキルブランチを再マージすることで、スキルの更新（バグ修正、改善）を取り込むことが可能
- マージグラフ全体で git が適切な共通の祖先を持つことができる

**なぜこれがスケーリングするのか：** 数百のスキルがあり、main へのコミットが 1 日数回あっても、CI のコストはわずかです。Haiku は高速で安価です。1〜2 年前には不可能だったアプローチが、Claude が大規模にコンフリクトを解決できるようになったことで、実用的になりました。

## インストールフロー

### 新規ユーザー（推奨）

1. GitHub で `qwibitai/nanoclaw` をフォークする（Fork ボタンをクリック）
2. フォークをクローンする：
   ```bash
   git clone https://github.com/<you>/nanoclaw.git
   cd nanoclaw
   ```
3. Claude Code を実行する：
   ```bash
   claude
   ```
4. `/setup` を実行する — Claude が依存関係、認証、コンテナのセットアップ、サービス設定を処理し、存在しない場合は `upstream` リモートを追加します

フォークが推奨される理由は、ユーザーが自身のカスタマイズをプッシュするためのリモートを確保できるからです。クローンのみでも試すことはできますが、リモートへのバックアップはできません。

### クローンから移行する既存ユーザー

以前に `git clone https://github.com/qwibitai/nanoclaw.git` を実行し、ローカルにカスタマイズがあるユーザー：

1. GitHub で `qwibitai/nanoclaw` をフォークする
2. リモートを再設定する：
   ```bash
   git remote rename origin upstream
   git remote add origin https://github.com/<you>/nanoclaw.git
   git push --force origin main
   ```
   フォークしたばかりの main はアップストリームの最新状態ですが、ユーザーは自身の（遅れている可能性のある）バージョンを保持したいため、`--force` が必要です。フォークした直後なので、失うものはありません。
3. この時点から、`origin` = 自身のフォーク、`upstream` = qwibitai/nanoclaw となります。

### 旧スキルエンジンから移行する既存ユーザー

以前に `skills-engine/` システムを介してスキルを適用していたユーザーは、ツリーにスキルコードがありますが、スキルブランチにリンクするマージコミットがありません。git はこれらの変更がスキルからのものであることを知らないため、スキルブランチをそのままマージするとコンフリクトしたり重複したりします。

**今後の新しいスキルについて：** 通常通りスキルブランチをマージしてください。問題ありません。

**既存の旧エンジン・スキルについて**、2 つの移行パスがあります：

**オプション A：スキルごとの再適用（自身のフォークを維持）**
1. 各旧エンジン・スキルについて：古い変更を特定してリバートし、スキルブランチを新しくマージする
2. Claude がリバートすべき箇所の特定と、コンフリクトの解決を支援します
3. 独自の修正（スキル以外の変更）は保持されます

**オプション B：クリーンスタート（最も確実）**
1. アップストリームから新しくフォークを作成する
2. 必要なスキルブランチをマージする
3. 独自の（スキル以外の）変更を手動で再適用する
4. Claude が古いフォークと新しいフォークの差分（diff）をとり、独自の変更を特定するのを支援します

いずれの場合も：
- `.nanoclaw/` ディレクトリを削除します（不要になります）
- `skills-engine/` のコードは、すべてのスキルが移行された後にアップストリームから削除されます
- `/update-skills` はブランチマージを介して適用されたスキルのみを追跡します。旧エンジンのスキルは更新チェックに表示されません。

## ユーザーワークフロー

### 独自の変更

ユーザーは自身の main ブランチで直接独自の変更を加えます。これは標準的なフォークのワークフローであり、彼らの `main` ブランチそのものがカスタマイズされたバージョンとなります。

```bash
# 変更を加える
vim src/config.ts
git commit -am "トリガーワードを @Bob に変更"
git push origin main
```

独自の変更、スキル、およびコアの更新は、すべて main ブランチで共存します。git はマージ履歴を通じて共通の祖先を追跡できるため、各マージステップで 3 ウェイマージを処理します。

### スキルの適用

Claude Code で `/add-discord` を実行するか（マーケットプレイスプラグイン経由で発見）、手動で行います：

```bash
git fetch upstream skill/discord
git merge upstream/skill/discord
# セットアップ手順に従って設定を行う
git push origin main
```

ユーザーがスキルブランチをマージする際にアップストリームの main より遅れている場合、マージによってコアの変更も取り込まれる可能性があります（スキルブランチが main とマージフォワードされているため）。これは通常問題ありません — すべての互換性のあるバージョンを取得できます。

### コアの更新

```bash
git fetch upstream main
git merge upstream/main
git push origin main
```

これは、既存の `/update-nanoclaw` スキルのマージパスと同じです。

### スキルの更新

`/update-skills` を実行するか、コアの更新後に `/update-nanoclaw` にチェックさせます。以前にマージされたスキルブランチに新しいコミットがある場合、Claude は更新のマージを提案します。

### アップストリームへの貢献

アップストリームに PR を送信したいユーザー：

```bash
git fetch upstream main
git checkout -b my-fix upstream/main
# 変更を加える
git push origin my-fix
# my-fix から qwibitai/nanoclaw:main への PR を作成
```

標準的なフォーク貢献ワークフローです。独自の変更は main に残り、PR には含まれません。

## スキルの提供

### 貢献者（コントリビューター）のフロー

1. `qwibitai/nanoclaw` をフォークする
2. `main` からブランチを作成する
3. コードの変更を加える（新しいチャネルファイル、修正された統合ポイント、更新された package.json、.env.example の追加など）
4. `main` への PR を開く

貢献者は通常の PR を開くだけです — スキルブランチやマーケットプレイスリポジトリについて知る必要はありません。コードを変更して送信するだけです。

### 維持者（メンテナー）のフロー

スキルの PR がレビューされ承認されたとき：

1. PR のコミットから `skill/<name>` ブランチを作成する：
   ```bash
   git fetch origin pull/<PR_NUMBER>/head:skill/<name>
   git push origin skill/<name>
   ```
2. 貢献者の PR ブランチに強制プッシュし、すべてのコード変更を削除して、貢献者を `CONTRIBUTORS.md` に追加する単一のコミットに置き換える
3. スリム化された PR を `main` にマージする（貢献者の追加のみ）
4. スキルの SKILL.md をマーケットプレイスリポジトリ (`qwibitai/nanoclaw-skills`) に追加する

これにより：
- 貢献者はマージのクレジットを得られます（PR がマージされるため）
- メンテナーによって自動的に `CONTRIBUTORS.md` に追加されます
- 貢献者の成果からスキルブランチが作成されます
- `main` はクリーンに保たれます（スキルコードなし）
- 貢献者がすべきことはただ 1 つ、コード変更を含む PR を開くことだけです

**注：** フォークからの GitHub PR はデフォルトで「メンテナーからの編集を許可する」にチェックが入っているため、メンテナーは貢献者の PR ブランチにプッシュできます。

### スキルの SKILL.md

貢献者はオプションで SKILL.md を提供できます（PR 内または別途）。これはマーケットプレイスリポジトリに配置され、以下を含みます：

1. フロントマター (名前、説明、トリガー)
2. ステップ 1：スキルブランチをマージする
3. ステップ 2〜N：対話型セットアップ（ボット作成、トークン取得、環境変数の設定、検証）

貢献者が SKILL.md を提供しない場合、メンテナーが PR に基づいて作成します。

## コミュニティマーケットプレイス

誰でも、スキルブランチを持つ独自のフォークと独自のマーケットプレイスリポジトリを維持できます。これにより、アップストリームのリポジトリへの書き込み権限を必要とせずに、コミュニティ主導のスキルエコシステムが可能になります。

### 仕組み

コミュニティ貢献者は：

1. NanoClaw のフォークを維持する (例: `alice/nanoclaw`)
2. フォーク上にカスタムスキルを含む `skill/*` ブランチを作成する
3. `.claude-plugin/marketplace.json` とプラグイン構造を持つマーケットプレイスリポジトリ (例: `alice/nanoclaw-skills`) を作成する

### コミュニティマーケットプレイスの追加

コミュニティ貢献者が信頼されている場合、NanoClaw の `.claude/settings.json` に自身のマーケットプレイスを追加するための PR を開くことができます：

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    },
    "alice-nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "alice/nanoclaw-skills"
      }
    }
  }
}
```

マージされると、すべての NanoClaw ユーザーが公式のものと並んでコミュニティマーケットプレイスを自動的に発見できるようになります。

### コミュニティスキルのインストール

`/setup` と `/customize` は、ユーザーにコミュニティスキルを有効にするかどうか尋ねます。有効にする場合、Claude は `claude plugin install` を介してコミュニティマーケットプレイスプラグインをインストールします：

```bash
claude plugin install alice-skills@alice-nanoclaw-skills --scope project
```

コミュニティスキルはホットロードされ、すぐに利用可能です。再起動は不要です。依存するスキルは、前提条件が満たされた後にのみ提案されます（例：コミュニティの Telegram アドオンは、Telegram がインストールされた後にのみ提案される）。

ユーザーは `/plugin` を介して手動でコミュニティプラグインを閲覧・インストールすることもできます。

### このシステムの特性

- **ゲートキーピング不要。** 誰でも許可なくフォーク上にスキルを作成できます。自動発見されるマーケットプレイスのリストに掲載されるためにのみ承認が必要です。
- **複数のマーケットプレイスの共存。** ユーザーは `/plugin` で、すべての信頼されたマーケットプレイスからのスキルを見ることができます。
- **コミュニティスキルも同じマージパターンを使用。** SKILL.md は単に別のリモートを指し示します：
  ```bash
  git remote add alice https://github.com/alice/nanoclaw.git
  git fetch alice skill/my-cool-feature
  git merge alice/skill/my-cool-feature
  ```
- **手動でマーケットプレイスを追加することも可能。** `settings.json` に記載されていなくても、ユーザーは `/plugin marketplace add alice/nanoclaw-skills` を実行して、任意のソースからスキルを発見できます。
- **CI はフォークごと。** 各コミュニティメンテナーは独自の CI を実行して、スキルブランチをマージフォワード状態に保ちます。アップストリームのリポジトリと同じ GitHub Action を使用できます。

## フレーバー (Flavors)

フレーバーとは、特定のユースケースに合わせて調整された、スキル、独自の変更、および設定を組み合わせた NanoClaw の厳選されたフォークです（例：「営業用 NanoClaw」、「最小構成 NanoClaw」、「開発者用 NanoClaw」）。

### フレーバーの作成

1. `qwibitai/nanoclaw` をフォークする
2. 必要なスキルをマージする
3. 独自の変更を加える（トリガーワード、プロンプト、連携など）
4. あなたのフォークの `main` ブランチそのものがフレーバーとなります

### フレーバーのインストール

`/setup` の間、設定が行われる前にユーザーにフレーバーの選択肢が提示されます。セットアップスキルはリポジトリ内の `flavors.yaml`（アップストリームに同梱され、常に最新）を読み込み、オプションを提示します：

質問: 「フレーバーで開始しますか、それともデフォルトの NanoClaw で開始しますか？」
- デフォルトの NanoClaw
- 営業用 NanoClaw — Gmail + Slack + CRM (alice が維持)
- 最小構成 NanoClaw — Telegram のみ、軽量 (bob が維持)

フレーバーが選択された場合：

```bash
git remote add <flavor-name> https://github.com/alice/nanoclaw.git
git fetch <flavor-name> main
git merge <flavor-name>/main
```

その後、セットアップが通常通り続行されます（依存関係、認証、コンテナ、サービス）。

**この選択は、新規フォークでのみ提示されます** — ユーザーの main がアップストリームの main と一致しているか近く、ローカルコミットがない場合です。`/setup` が大幅なローカル変更を検出した場合（既存のインストールでセットアップを再実行する場合）、フレーバーの選択をスキップして直接設定に進みます。

インストール後、ユーザーのフォークには 3 つのリモートがあります：
- `origin` — 自身のフォーク（カスタマイズをここにプッシュ）
- `upstream` — `qwibitai/nanoclaw`（コアの更新）
- `<flavor-name>` — フレーバーのフォーク（フレーバーの更新）

### フレーバーの更新

```bash
git fetch <flavor-name> main
git merge <flavor-name>/main
```

フレーバーの維持者は自身のフォークを最新に保ちます（アップストリームのマージ、スキルの更新）。ユーザーは、コアの更新を取得するのと同じ方法でフレーバーの更新を取得します。

### フレーバーレジストリ

`flavors.yaml` はアップストリームのリポジトリにあります：

```yaml
flavors:
  - name: 営業用 NanoClaw
    repo: alice/nanoclaw
    description: Gmail + Slack + CRM 連携、日次のパイプライン要約
    maintainer: alice

  - name: 最小構成 NanoClaw
    repo: bob/nanoclaw
    description: Telegram のみ、コンテナのオーバーヘッドなし
    maintainer: bob
```

誰でもフレーバーを追加するための PR を送ることができます。このファイルはクローンされたリポジトリの一部であるため、`/setup` 実行時にローカルで利用可能です。

### 発見しやすさ

- **セットアップ中** — 初期セットアップフローの一部としてフレーバーの選択が提案されます。
- **`/browse-flavors` スキル** — いつでも `flavors.yaml` を読み込み、オプションを提示します。
- **GitHub トピックス** — フレーバーのフォークは検索性を高めるために `nanoclaw-flavor` タグを付けることができます。
- **Discord / ウェブサイト** — コミュニティによる厳選リスト。

## 移行

旧スキルエンジンからブランチへの移行は完了しました。すべての機能スキルは現在 `skill/*` ブランチにあり、スキルエンジンは削除されました。

### スキルブランチ

| ブランチ | ベース | 説明 |
|--------|------|-------------|
| `skill/whatsapp` | `main` | WhatsApp チャネル |
| `skill/telegram` | `main` | Telegram チャネル |
| `skill/slack` | `main` | Slack チャネル |
| `skill/discord` | `main` | Discord チャネル |
| `skill/gmail` | `main` | Gmail チャネル |
| `skill/voice-transcription` | `skill/whatsapp` | OpenAI Whisper 音声文字起こし |
| `skill/image-vision` | `skill/whatsapp` | 画像添付ファイルの処理 |
| `skill/pdf-reader` | `skill/whatsapp` | PDF 添付ファイルの読み込み |
| `skill/local-whisper` | `skill/voice-transcription` | ローカルの whisper.cpp による文字起こし |
| `skill/ollama-tool` | `main` | ローカルモデル用の Ollama MCP サーバー |
| `skill/apple-container` | `main` | Apple Container ランタイム |
| `skill/reactions` | `main` | WhatsApp の絵文字リアクション |

### 削除されたもの

- `skills-engine/` ディレクトリ (エンジン全体)
- `scripts/apply-skill.ts`, `scripts/uninstall-skill.ts`, `scripts/rebase.ts`
- `scripts/fix-skill-drift.ts`, `scripts/validate-all-skills.ts`
- `.github/workflows/skill-drift.yml`, `.github/workflows/skill-pr.yml`
- スキルディレクトリ内のすべての `add/`, `modify/`, `tests/`, および `manifest.yaml`
- `.nanoclaw/` ステートディレクトリ

運用スキル (`setup`, `debug`, `update-nanoclaw`, `customize`, `update-skills`) は `main` ブランチの `.claude/skills/` に残っています。

## 変更内容

### README クイックスタート

以前：
```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
claude
```

以後：
```
1. GitHub で qwibitai/nanoclaw をフォークする
2. git clone https://github.com/<you>/nanoclaw.git
3. cd nanoclaw
4. claude
5. /setup
```

### セットアップスキル (`/setup`)

セットアップフローの更新：

- `upstream` リモートが存在するか確認し、ない場合は追加： `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- `origin` が（qwibitai ではなく）ユーザーのフォークを指しているか確認。qwibitai を指している場合は、フォークへの移行を案内します。
- **マーケットプレイスプラグインのインストール：** `claude plugin install nanoclaw-skills@nanoclaw-skills --scope project` — すべての機能スキルが利用可能になります（ホットロード、再起動不要）
- **追加するチャネルの質問：** チャネルのオプション（Discord, Telegram, Slack, WhatsApp, Gmail）を提示し、選択されたチャネルに対応する `/add-*` スキルを実行
- **依存スキルの提案：** チャネルのセットアップ後、関連するアドオンを提案（例：Telegram の後に Agent Swarm、WhatsApp の後に音声文字起こし）
- **オプションでコミュニティマーケットプレイスを有効化：** ユーザーにコミュニティスキルが必要か尋ね、必要ならそれらのマーケットプレイスプラグインもインストール

### `.claude/settings.json`

公式マーケットプレイスが自動登録されるようにするためのマーケットプレイス設定：

```json
{
  "extraKnownMarketplaces": {
    "nanoclaw-skills": {
      "source": {
        "source": "github",
        "repo": "qwibitai/nanoclaw-skills"
      }
    }
  }
}
```

### main ブランチのスキルディレクトリ

`main` ブランチの `.claude/skills/` ディレクトリには、運用スキル（setup, debug, update-nanoclaw, customize, update-skills）のみを保持します。機能スキル（add-discord, add-telegram など）はマーケットプレイスリポジトリに配置され、`/setup` または `/customize` の間に `claude plugin install` を介してインストールされます。

### スキルエンジンの削除

以下を削除できます：

- `skills-engine/` — ディレクトリ全体 (apply, merge, replay, state, backup など)
- `scripts/apply-skill.ts`
- `scripts/uninstall-skill.ts`
- `scripts/fix-skill-drift.ts`
- `scripts/validate-all-skills.ts`
- `.nanoclaw/` — ステートディレクトリ
- すべてのスキルディレクトリから `add/` および `modify/` サブディレクトリを削除
- main の `.claude/skills/` から機能スキルの SKILL.md ファイルを削除（これらはマーケットプレイスに移動しました）

運用スキル (`setup`, `debug`, `update-nanoclaw`, `customize`, `update-skills`) は `main` ブランチの `.claude/skills/` に残ります。

### 新しいインフラストラクチャ

- **マーケットプレイスリポジトリ** (`qwibitai/nanoclaw-skills`) — すべての機能スキルの SKILL.md ファイルをバンドルした単一の Claude Code プラグイン
- **CI GitHub Action** — `main` へのプッシュごとに `main` をすべての `skill/*` ブランチにマージフォワード。コンフリクト解消には Claude (Haiku) を使用。
- **`/update-skills` スキル** — git の履歴を使用して、スキルブランチの更新を確認し適用します。
- **`CONTRIBUTORS.md`** — スキルの貢献者を追跡します。

### 更新スキル (`/update-nanoclaw`)

更新スキルは、ブランチベースのアプローチによりシンプルになります。旧スキルエンジンでは、コアの更新をマージした後に、適用済みのすべてのスキルを「再実行（replay）」する必要がありましたが、そのステップ全体が不要になります。スキルの変更はすでにユーザーの git 履歴に含まれているため、`git merge upstream/main` を実行するだけで機能します。

**変わらない点：**
- 実行前チェック（クリーンな作業ツリー、upstream リモート）
- バックアップブランチ + タグ
- プレビュー (git log, git diff, ファイルの分類)
- マージ/チェリーピック/リベースのオプション
- コンフリクトのプレビュー (ドライランマージ)
- コンフリクト解消
- ビルド + テストによる検証
- ロールバック手順

**削除される点：**
- スキルの再実行（リプレイ）ステップ（コア更新後にスキルを再適用するために旧エンジンで必要だったもの）
- 構造化された操作の再実行（npm 依存関係、環境変数 — これらは現在 git の履歴の一部です）

**追加される点：**
- 最後に「スキルの更新を確認しますか？」というオプションステップを追加。これは `/update-skills` のロジックを実行します。
- これにより、以前にマージされたスキルブランチに新しいコミット（単なる main からのマージフォワードではなく、スキル自体のバグ修正や改善）があるかどうかを確認します。

**なぜコアの更新後にスキルの再マージが不要なのか：**
ユーザーがスキルブランチをマージした時点で、それらの変更は彼らの git 履歴の一部となります。後で `upstream/main` をマージするとき、git は通常の 3 ウェイマージを実行します — ユーザーのツリーにあるスキルの変更はそのまま保持され、コアの変更のみが取り込まれます。CI によるマージフォワードは、スキルブランチが常に最新の main と互換性を保つようにするためのもので、これはスキルを新しく適用するユーザー向けです。すでにスキルをマージ済みの既存ユーザーは、何もする必要はありません。

ユーザーがスキルブランチを再マージする必要があるのは、スキル自体が更新された場合（単に main とマージフォワードされただけでなく）のみです。`/update-skills` チェックがこれを検出します。

## Discord アナウンス

### 既存ユーザー向け

> **スキルが git ブランチになりました**
>
> NanoClaw でのスキルの仕組みを簡素化しました。独自のスキルエンジンを使用する代わりに、スキルはマージして取り込む git ブランチになりました。
>
> **あなたへの影響：**
> - スキルの適用： `git fetch upstream skill/discord && git merge upstream/skill/discord`
> - コアの更新： `git fetch upstream main && git merge upstream/main`
> - スキルの更新確認： `/update-skills`
> - `.nanoclaw/` ステートディレクトリやスキルエンジンは不要になりました
>
> **今後はクローンではなくフォークすることを推奨します。** これにより、自身のカスタマイズをプッシュするためのリモートを確保できます。
>
> **現在、ローカルに変更を加えたクローンをお持ちの場合**、フォークへの移行手順：
> 1. GitHub で `qwibitai/nanoclaw` をフォークする
> 2. 以下を実行：
>    ```
>    git remote rename origin upstream
>    git remote add origin https://github.com/<you>/nanoclaw.git
>    git push --force origin main
>    ```
>    たとえ大幅に遅れていても機能します — 現在の状態をプッシュするだけです。
>
> **以前に古いシステムでスキルを適用していた場合**、コードの変更はすでに作業ツリーに含まれているため、やり直す必要はありません。`.nanoclaw/` ディレクトリは削除して構いません。今後のスキルとアップデートはブランチベースのアプローチを使用します。
>
> **スキルの発見：** スキルは Claude Code のプラグインマーケットプレイスから利用可能になりました。Claude Code で `/plugin` を実行して、利用可能なスキルを閲覧・インストールしてください。

### スキル貢献者向け

> **スキルの提供について**
>
> スキルを提供するには：
> 1. `qwibitai/nanoclaw` をフォークする
> 2. `main` からブランチを作成し、コードの変更を加える
> 3. 通常の PR を開く
>
> これだけです。あなたの PR から `skill/<name>` ブランチを作成し、`CONTRIBUTORS.md` にあなたを追加し、マーケットプレイスに SKILL.md を追加します。CI が Claude を使用してコンフリクトを解決しながら、スキルブランチを `main` と常にマージフォワード状態に保ちます。
>
> **独自のスキルマーケットプレイスを運営したいですか？** あなたのフォークでスキルブランチを維持し、マーケットプレイスリポジトリを作成してください。NanoClaw の自動発見リストに追加するための PR を送るか、ユーザーが手動で `/plugin marketplace add` を実行して追加することができます。
