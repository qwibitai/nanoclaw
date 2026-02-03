# X (Twitter) 功能

让 AI 助手通过浏览器自动化帮你操作 X：发推、点赞、回复、转发、引用转发。

## 工作原理

1. 你先用系统 Chrome 登录一次 X，保存浏览器认证状态
2. 当你请求发推时，主机使用 Playwright 控制独立的 Chrome 实例发推
3. 发布完成后会在 WhatsApp 中通知你

## 设置步骤

### 1. 登录 X 账号

```bash
npm run setup:x
```

这会打开一个独立的 Chrome 窗口让你登录 X：

1. 输入你的用户名/邮箱
2. 输入密码
3. 完成二次验证（如果有）
4. 确认看到 X 首页
5. 回到终端按 Enter

认证状态会保存到 `data/x-auth.json` 和 `data/x-browser-profile/`。

### 2. 重启服务

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## 使用方法

### 发推文

```
@媳妇 帮我发一条推文：今天天气真好 #weather
```

### 点赞

```
@媳妇 帮我点赞这条推文：https://x.com/elonmusk/status/1234567890
```

### 回复

```
@媳妇 帮我回复这条推文 https://x.com/user/status/123，内容是：说得好！
```

### 转发

```
@媳妇 帮我转发这条推文：https://x.com/user/status/123
```

### 引用转发

```
@媳妇 引用转发这条推文 https://x.com/user/status/123，加上评论：这个观点很有意思
```

AI 会：
1. 启动独立的 Chrome 实例
2. 导航到目标页面
3. 执行相应操作
4. 确认成功后告诉你

## 注意事项

### 独立浏览器配置

发推功能使用独立的浏览器配置目录 (`data/x-browser-profile/`)，与你日常使用的 Chrome 完全隔离。

**优点**：
- 不需要关闭你的 Chrome 浏览器
- 不会影响你的日常浏览
- 登录状态持久保存，只需登录一次

### 安全

- `data/x-auth.json` 和 `data/x-browser-profile/` 包含你的 X 登录凭证
- 不要分享这些文件
- 不要把它们提交到 Git（已在 .gitignore 中）

### 使用限制

- 不要频繁发推文，X 有速率限制
- 异常操作可能触发账号安全验证
- 建议每天不超过 10 条自动推文
- 推文内容最多 280 字符

### 认证过期

如果发推失败，可能是认证过期了：

```bash
npm run setup:x
```

重新登录即可。

## 故障排除

### 发推失败

1. 检查认证文件是否存在：
   ```bash
   ls -la data/x-auth.json
   ls -la data/x-browser-profile/
   ```

2. 查看服务日志：
   ```bash
   tail -50 /tmp/nanoclaw.log | grep -i "x_post\|x_like\|x_reply\|x_retweet\|x_quote\|browser"
   ```

3. 重新设置认证：
   ```bash
   npm run setup:x
   ```

### Chrome 路径问题

如果你的 Chrome 不在默认位置，需要修改 `src/x-browser.ts` 中的 `CHROME_PATH`。

当前配置：
```typescript
const CHROME_PATH = '/Applications/MyApp/Google Chrome.app/Contents/MacOS/Google Chrome';
```

### 浏览器启动失败

如果遇到浏览器启动问题，尝试清理锁文件：

```bash
rm -f data/x-browser-profile/SingletonLock
rm -f data/x-browser-profile/SingletonSocket
rm -f data/x-browser-profile/SingletonCookie
```

## 定时发推

你可以设置定时任务自动发推：

```
@媳妇 设置一个定时任务：每天早上 9 点发一条推文，内容是今天的日期和一句励志名言
```
