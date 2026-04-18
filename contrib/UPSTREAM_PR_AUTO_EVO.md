# 提交 auto-evo 到 upstream（一步一步）

你在本机**不要做**的事情：把 Token 发给任何人；在聊天里贴 Token。

## 1. GitHub 上操作（网页）

1. 打开 https://github.com/qwibitai/nanoclaw  
2. 点 **Fork**，得到 `https://github.com/<你的用户名>/nanoclaw`  
3. 不要改 fork 的默认分支名即可  

## 2. 本机终端：把「上游」和「你的 fork」配好

在**已有 clone** 的 nano claw 目录里（本仓库已包含 `skill/auto-evo` 分支与提交时）：

```bash
cd /path/to/nanoclaw

# 若 origin 还是 qwibitai，改名为 upstream
git remote rename origin upstream 2>/dev/null || true

# 加上你的 fork（把 YOUR_USER 换成你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_USER/nanoclaw.git
```

若你 clone 的就是自己的 fork，则：

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

确保一眼能看懂：

```bash
git remote -v
# origin    -> 你的 fork
# upstream  -> qwibitai/nanoclaw
```

## 3. 登录 GitHub CLI（一次即可）

```bash
gh auth login
```

选 GitHub.com、HTTPS、`Login with a web browser`（推荐，不必手打 Token）。

## 4. 推送分支到你的 fork

本仓库应已包含分支 `skill/auto-evo`。推送：

```bash
git fetch upstream
git checkout skill/auto-evo
git push -u origin skill/auto-evo
```

若提示分支不存在，先 `git branch -a` 看是否叫别的名字。

## 5. 向 qwibitai/nanoclaw 开 PR

```bash
gh pr create --repo qwibitai/nanoclaw \
  --base main \
  --head YOUR_USER:skill/auto-evo \
  --title "feat(skill): add auto-evo (session-injected group strategy memory)" \
  --body-file pr-body.md
```

把仓库里的 `pr-body.md` 作为正文（已写好）。

或在浏览器打开 GitHub：**Compare** `qwibitai/nanoclaw#main` ← `YOUR_USER/nanoclaw#skill/auto-evo`，创建 Pull Request。

## 6. Token 曾泄露过？

到 GitHub → Settings → Developer settings → **Revoke** 旧 Token，再只用 `gh auth login`。
