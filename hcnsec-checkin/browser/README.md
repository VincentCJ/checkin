# api.hcnsec.cn 自动签到 —— 浏览器版（真正全自动）

**这条路能过 Cloudflare 人机验证，而且免点击。**

## 为什么 Egern 脚本做不到、这个能

| | Egern 脚本（纯 HTTP） | 浏览器版 |
|---|---|---|
| 生成 Turnstile token | ❌ 不可能（要跑 CF 的 JS） | ✅ 真实 WebKit 自动签发，**免点击** |
| 签到 | ❌ 每次都被拦 | ✅ 端到端跑通 |
| 依赖 | Egern 常开 | Minis 常开 + 内置浏览器有登录态 |

实测证据（2026-10-14）：在内置浏览器里渲染 Turnstile widget，**2 秒左右自动出 token**（773 字符），
带着它调 `/api/user/checkin?turnstile=...` 返回的是 `今日已签到`——
说明验证那关已经过了（没过的话会返回「Turnstile token 为空 / 校验失败」）。

## 文件

| 文件 | 作用 |
|---|---|
| `hcnsec-browser-checkin.js` | 在站点页面里执行：换 access_token → 生成 Turnstile token → 签到 |
| `checkin.sh` | 一条命令跑完：打开站点 → 注入脚本 → 出通知 |
| `report.py` | 把执行结果整理成通知文案 |

## 用法

```sh
sh /var/minis/workspace/hcnsec-checkin/browser/checkin.sh
```

手动跑和定时跑是同一条命令。

## 已注册的定时任务

每天 **08:20** 自动跑（`minis-scheduled`）：

```
id: 073E3577-E003-437C-9429-5ADBE755A1EA   （cron 8:20 每天）
sh /var/minis/workspace/hcnsec-checkin/browser/checkin.sh
```

管理：`minis-scheduled list` / `delete --id <id>` / `enable|disable --id <id>`

## ⚠️ 两个必须知道的限制

1. **网页登录态在 Minis 进程内**。Minis 如果被系统彻底杀掉，内置浏览器的会话可能丢失，
   这时会推一条「需要重新登录」，你在内置浏览器里打开 `https://api.hcnsec.cn` 登录一次即可
   （之后又能自动跑一段时间）。
2. **`minis-scheduled` 只在 Minis 存活时有效**。想要「App 被杀也照跑」，
   得用 Apple 快捷指令做自动化：每天 08:20 → 打开 URL
   `minis://open_terminal?init_command=...`（或直接打开站点手动点一下）。
   要的话我可以把快捷指令的步骤写出来。

## 和 Egern 脚本的关系

两者互补，都留着：
- **浏览器版**：主力，能真正自动签到（需要 Minis 运行）。
- **Egern 版**：兜底 + 状态播报，能查「今天签没签」、算收益、维护登录态，
  在站点关掉人机验证时也能独立完成签到。
