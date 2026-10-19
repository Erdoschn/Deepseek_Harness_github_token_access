# gh-latch（中文说明）

**给你的 GitHub token 装一把插销。**

`gh-latch` 是一个命令行工具，站在「凭据」和「GitHub API」之间。你给它一个 token，再用一个文件写清楚：它可以碰哪些仓库、能不能写。此后每一个动作都要先过这把插销。

它存在的理由很直接：把 token 交给一个脚本、一条 CI、或者一个 AI agent，等于把 token 能做的事全部交出去。`gh-latch` 让这份授权变成显式的、可检查的、很窄的。

```console
$ ghl policy show
permissions: read, write
repos.allow: acme/*

$ ghl commit evil/repo --branch x -m "..." --file a.md
ghl: policy denied "commit.create":
  - repository "evil/repo" is not covered by repos.allow
```

零依赖，Node 20+ 即可运行。

## 三板斧

1. **给 token**：任一来源即可，先找到先用 —— `GHL_TOKEN`、`GITHUB_TOKEN`、`GH_TOKEN`，或 `~/.dsh/secrets/github-token`、`~/.config/ghl/token`、`~/.gh-latch/token`。token 不会被打印、不会进入审计日志、不会被缓存。
2. **写策略**：`ghl init --repo owner/name --write`，生成 `ghl.config.json`。
3. **先问再做**：`ghl policy show` 看能做什么，`ghl policy check commit.create owner/name` 单独问一次。

## 策略模型

- `permissions`：`read` / `write`。**没有 `admin`** —— 本工具根本不做管理类操作，所以这一级在解析阶段就被拒绝。
- `repos.allow` / `repos.deny`：`owner/name`、`owner/*`、`*/name`、`*/*`，`deny` 永远优先。
- `denyOperations`：按操作名逐条否决，或 `"*"` 一键全关（只做演练时很有用）。
- `allowRepoCreate`、`rawApi`：两个默认关闭、需要显式打开的门。

退出码可以直接给脚本用：`0` 成功，`1` 出错，`2` 被策略拒绝，`64` 用法错误。

完整参考见 [`docs/policy.md`](docs/policy.md)。

## 安全性质

- 默认拒绝：没有 `ghl.config.json` 时，任何 GitHub 操作都不放行。
- token 不出现在输出、审计日志和错误信息里。
- `--dry-run` 只做读操作，把计划打印出来。
- 每一次尝试（包括被拒绝的）都可以追加到 `~/.gh-latch/audit.jsonl`。
- 提交走 Git Data API，多文件改动原子落盘，ref 更新从不使用 `force`。

## 开发

```console
npm test        # node --test test/
npm run check   # 语法检查
```

没有依赖、没有构建、没有转译。贡献指南见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

MIT 许可。
