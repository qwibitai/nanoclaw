# Apple Container ネットワーク設定 (macOS 26)

Apple Container の vmnet ネットワークでは、コンテナがインターネットにアクセスするために手動での設定が必要です。これを行わない場合、コンテナはホストとは通信できますが、外部サービス（DNS, HTTPS, API）には到達できません。

## クイックセットアップ

以下の 2 つのコマンドを実行してください（`sudo` 権限が必要です）：

```bash
# 1. ホストがコンテナのトラフィックをルーティングできるように IP フォワーディングを有効にする
sudo sysctl -w net.inet.ip.forwarding=1

# 2. コンテナのトラフィックがインターネットインターフェースを介してマスカレードされるように NAT を有効にする
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -
```

> **注：** `en0` はアクティブなインターネットインターフェースに置き換えてください。確認コマンド： `route get 8.8.8.8 | grep interface`

## 設定の永続化

これらの設定は再起動するとリセットされます。永続化するには：

**IP フォワーディング** — `/etc/sysctl.conf` に追記：
```
net.inet.ip.forwarding=1
```

**NAT ルール** — `/etc/pf.conf` に追記（既存のルールの前に追加）：
```
nat on en0 from 192.168.64.0/24 to any -> (en0)
```

その後、リロードしてください： `sudo pfctl -f /etc/pf.conf`

## IPv6 DNS の問題

デフォルトでは、DNS リゾルバーは IPv4 (A) レコードよりも先に IPv6 (AAAA) レコードを返します。我々の NAT は IPv4 のみを処理するため、コンテナ内の Node.js アプリケーションは最初に IPv6 を試行して失敗します。

コンテナイメージとランナーは、以下の設定により IPv4 を優先するように構成されています：
```
NODE_OPTIONS=--dns-result-order=ipv4first
```

これは `Dockerfile` 内で設定されているほか、`container-runner.ts` で `-e` フラグを介して渡されます。

## 検証

```bash
# IP フォワーディングが有効であることを確認
sysctl net.inet.ip.forwarding
# 期待される結果: net.inet.ip.forwarding: 1

# コンテナのインターネットアクセスをテスト
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
# 期待される結果: 404

# ブリッジインターフェースを確認 (コンテナ実行中のみ存在します)
ifconfig bridge100
```

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|---------|-------|-----|
| `curl: (28) Connection timed out` | IP フォワーディングが無効 | `sudo sysctl -w net.inet.ip.forwarding=1` |
| HTTP は動作するが HTTPS がタイムアウトする | IPv6 DNS 解決の問題 | `NODE_OPTIONS=--dns-result-order=ipv4first` を追加 |
| `Could not resolve host` | DNS が転送されていない | bridge100 が存在するか確認し、pfctl の NAT ルールを検証 |
| 出力後にコンテナがハングする | agent-runner 内で `process.exit(0)` が不足 | コンテナイメージを再ビルド |

## 仕組み

```
コンテナ VM (192.168.64.x)
    │
    ├── eth0 → ゲートウェイ 192.168.64.1
    │
bridge100 (192.168.64.1) ← ホストブリッジ。コンテナ実行時に vmnet によって作成される
    │
    ├── IP フォワーディング (sysctl) が bridge100 → en0 へのパケットをルーティング
    │
    ├── NAT (pfctl) が 192.168.64.0/24 を en0 の IP にマスカレード
    │
en0 (あなたの WiFi/Ethernet) → インターネット
```

## 参考

- [apple/container#469](https://github.com/apple/container/issues/469) — No network from container on macOS 26
- [apple/container#656](https://github.com/apple/container/issues/656) — Cannot access internet URLs during building
