---
name: nineconnect-verify
description: NineConnect macOS App 构建后自测流程。构建 DMG 后自动执行完整验证，确保不让用户当测试员。触发词：nineconnect 自测、验证 nineconnect、测试 app、nineconnect-verify。
---

# NineConnect 构建后自测

每次构建 NineConnect DMG 后，**必须执行以下全部步骤**才能向用户汇报"已部署"。跳过任何一步 = 让用户当测试员 = 违反工作纪律。

## 触发条件

当以下任一操作完成时自动执行本流程：
- `swift build -c release` 编译 NineConnect
- `build-dmg.sh` 打包 DMG
- 部署 DMG 到服务器

## 项目路径

NineConnect 项目在 Nine 仓库内：`~/AI_Workspace/nine/apps/macos/NineConnect/`

## 自测流程

### Step 1: 验证构建产物

```bash
cd ~/AI_Workspace/nine/apps/macos/NineConnect
APP=".build/release/NineConnect.app"

# 版本号必须与 main.swift 一致
PLIST_VER=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$APP/Contents/Info.plist")
CODE_VER=$(grep 'let appVersion' Sources/main.swift | grep -oE '"[^"]+"' | tr -d '"')
SCRIPT_VER=$(grep 'APP_VERSION=' scripts/build-dmg.sh | head -1 | grep -oE '"[^"]+"' | tr -d '"')

echo "Info.plist: $PLIST_VER | main.swift: $CODE_VER | build-dmg.sh: $SCRIPT_VER"
[ "$PLIST_VER" = "$CODE_VER" ] && [ "$CODE_VER" = "$SCRIPT_VER" ] && echo "✅ 版本号一致" || echo "❌ 版本号不一致！"

# CFBundleIconFile 必须存在
/usr/libexec/PlistBuddy -c "Print CFBundleIconFile" "$APP/Contents/Info.plist"

# Resources 必须包含图标
ls "$APP/Contents/Resources/" | grep -E "AppIcon|MenuBar"
```

**不通过 → 修 build-dmg.sh，不继续。**

### Step 2: 从 DMG 模拟用户安装（最关键）

⚠️ **绝对不能只测 .build/ 里的 .app！** DMG 和 build 目录的 .app 可能不同。

```bash
# 挂载 DMG
hdiutil attach dist/NineConnect.dmg -nobrowse

# 模拟拖拽安装
cp -R /Volumes/NineConnect/NineConnect.app /tmp/NineConnect-test.app

# 验证 DMG 内 App 的 Resources
ls /Volumes/NineConnect/NineConnect.app/Contents/Resources/
/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" /Volumes/NineConnect/NineConnect.app/Contents/Info.plist

# 启动并确认 3 秒内没崩
open /tmp/NineConnect-test.app
sleep 3
pgrep -f "NineConnect-test" && echo "✅ 启动成功" || echo "❌ App 崩溃！停止部署！"
```

**不通过 → 不部署，先排查崩溃原因。**

### Step 3: 截图验证 UI

```bash
caffeinate -u -t 3 && sleep 1
/usr/sbin/screencapture -x /tmp/nineconnect-verify.png
```

用 **Read 工具**查看截图（不是自己画 SVG！），确认：
- [ ] 窗口标题 "NineConnect"
- [ ] Tab 标签正确（当前版本：通用、安全、日志）
- [ ] 菜单栏有 Nine 图标（不是文字 "9"）
- [ ] Dock 图标是 Nine logo（不是 macOS 默认）

**不通过 → 修代码重新构建。**

### Step 4: 清理测试环境

```bash
pkill -f "NineConnect-test" 2>/dev/null
rm -rf /tmp/NineConnect-test.app
hdiutil detach /Volumes/NineConnect 2>/dev/null
rm -f /tmp/nineconnect-verify.png
```

### Step 5: 部署（验证通过后才执行）

```bash
# 1. 复制到 git 追踪目录（防 git pull 覆盖）
cp dist/NineConnect.dmg ../../server/backend/data/installers/NineConnect.dmg

# 2. 上传服务器容器
scp dist/NineConnect.dmg root@10.117.5.134:/tmp/
ssh root@10.117.5.134 "docker cp /tmp/NineConnect.dmg nine-backend:/app/data/installers/NineConnect.dmg && rm /tmp/NineConnect.dmg"

# 3. 验证部署成功
ssh root@10.117.5.134 "docker exec nine-backend ls -la /app/data/installers/NineConnect.dmg"
```

### Step 6: 提交代码

部署后必须把 DMG 和代码改动一起提交 git，否则下次 git pull 会覆盖。

## 绝对禁止

| 禁止 | 原因 |
|------|------|
| 用 SVG/模拟图代替截图 | 被大杰抓过现行 |
| 只测 .build/ 不测 DMG | DMG 打包过程可能引入问题 |
| 只 docker cp 不提交 git | git pull 会覆盖 |
| 跳过公证 | Gatekeeper 拦截 |
| release 代码用 Bundle.module | fatalError 崩溃 |
| 版本号不同步 | 用户下载到旧版 |
| 自测没通过就告诉用户"已部署" | 违反工作纪律 |

## 已知坑速查

| 坑 | 症状 | 修法 |
|----|------|------|
| Bundle.module | 启动即崩 | release 只用 Bundle.main，图标由 build-dmg.sh 复制 |
| 缺 CFBundleIconFile | Finder 默认图标 | Info.plist 加 `CFBundleIconFile = AppIcon` |
| screencapture 全黑 | 截图几 KB | 先 `caffeinate -u -t 5` |
| DMG 被 git pull 覆盖 | 用户下载旧版 | 部署时同时提交 git |

## 签名配置

- 证书: `Developer ID Application: junjie tian (8NQL3H9DWP)`
- 公证 profile: `notarytool`（keychain 已存储）
- 公证: `xcrun notarytool submit xxx.dmg --keychain-profile "notarytool" --wait`
- 装订: `xcrun stapler staple xxx.dmg`
