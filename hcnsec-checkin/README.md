# api.hcnsec.cn 自动签到 · Egern

**已发布仓库：https://github.com/VincentCJ/checkin**（与 freeapi 签到脚本同一仓库）

站点：`https://api.hcnsec.cn`（新疆幻城网安公益大模型网关，New API 系）

脚本 raw 地址（用 jsDelivr 那条，国内更快）：

- 抓登录态 `https://cdn.jsdelivr.net/gh/VincentCJ/checkin@main/hcnsec-checkin/hcnsec-auth-capture.js`
- 每日签到 `https://cdn.jsdelivr.net/gh/VincentCJ/checkin@main/hcnsec-checkin/hcnsec-checkin.js`

---

## ⚠️ 先说清楚：这个站的签到有 Cloudflare 人机验证

**已按站点源码逐行核实**（`router/api-router.go`、`middleware/turnstile-check.go`、
`controller/checkin.go`、`web/src/features/profile/api.ts`）：

```
GET  /api/user/checkin?month=YYYY-MM    → 签到状态（不需要人机验证）
POST /api/user/checkin?turnstile=TOKEN  → 真正签到
        ↑ 该路由挂了 middleware.TurnstileCheck()
          没有 token       → {"success":false,"message":"Turnstile token 为空"}
          token 验证不通过 → {"success":false,"message":"Turnstile 校验失败，请刷新重试！"}
```

三个关键事实：

1. **每次签到都要一个全新的 token**。本站用的这个 fork（`lza6/new-api-Max` 系）连
   「会话里验证过一次就放行」的短路逻辑都没有，token 只能由 Cloudflare 的 JS
   **在真实浏览器里**签发（`challenges.cloudflare.com/turnstile/v0/siteverify` 用
   `secret + response + remoteip` 校验）。
2. token 约 5 分钟有效、一次一用 —— 不能提前囤，也不能复用。
3. 所以**任何纯 HTTP 客户端（Egern 脚本 / curl / 青龙）都过不了这一关**，
   这与脚本写得好不好无关。

## 那脚本还能干什么

它把能自动化的部分做到位，把不能自动化的部分变成**一次点击**：

| 场景 | 行为 |
|---|---|
| 今天已签到 | 直接通知「今日已签到 ✅」，**不去打签到接口**（不触发人机验证） |
| 有可用 token（`?turnstile=` 拼上） | 全自动签到，通知「签到成功 🎉 +本次收益」 |
| 站点要求人机验证且没有 token | 通知「**需要手动签到（人机验证）**」，通知**可点击**，点一下直接打开站点 |
| 站点哪天关掉 `turnstile_check` | **自动恢复全自动**，不用改任何配置 |
| 你有办法提供 token | 环境变量 `HCN_TURNSTILE` 填进去即可 |

也就是说：**每天点一下通知 → 点一下「签到」**，两下搞定；
剩下的（查状态、算收益、登录态维护、失效提醒）全自动。

> 参考：社区里给这个站做的方案（`TyrEamon/Keepalive` 的 iamhc）也放弃了纯 HTTP，
> 改为「被拦截时起一个 stealth 浏览器去过验证」。

## 部署

1. Egern → 配置 → 编辑当前配置，把 `egern-配置片段.yaml` 的内容**合并**进去
   （`mitm` 和 `scriptings` 都是合并列表，别整段覆盖）。
2. 保存并重载配置。
3. 用手机浏览器打开一次 `https://api.hcnsec.cn` 并登录（Egern 保持开启），
   抓取脚本会自动存下登录态并弹通知。
4. 之后每天 11:00 跑一次：能自动就自动，要验证就给你一条可点通知。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HCN_TURNSTILE` | 空 | 手填一个 Turnstile token（约 5 分钟有效），一般不用填 |
| `HCN_MANUAL_URL` | `https://api.hcnsec.cn/profile` | 通知里「去签到」打开的地址 |
| `NOTIFY_ALWAYS` | `1` | `"0"` = 只在真的领到时通知 |
| `NOTIFY_ON_FAIL` | `1` | `"0"` = 失败/待人工都不通知 |
| `NOTIFY_VERBOSE` | `0` | `"1"` = 带上签到前额度明细 |
| `HCN_DRY_RUN` | `0` | `"1"` = 只读状态不真的签到 |
| `HCN_COOKIE` / `HCN_ACCESS_TOKEN` / `HCN_USER_ID` | 空 | 手填凭据（一般不用，抓取脚本会存） |

抓取脚本侧：`NOTIFY_ON_CAPTURE`（`"0"` 抓到时静默）、`NOTIFY_ANY`（`"1"` 每次运行都通知，排错用）、
`NOTIFY_CHECKIN`（`"0"` 关掉「浏览器里签到完成」的提示）。

## 抓取脚本额外做的事

- 抄请求头里的认证信息（Cookie / Authorization / X-Auth-Session / New-Api-User）
- 收响应侧 `Set-Cookie` 与会话刷新（`new_api_refresh` 轮换也能跟上）
- 顺手记下浏览器签到请求里的 `?turnstile=` token（存 `hcnsec_turnstile`，供秒级窗口复用）
- **你在浏览器里点了签到时**，它会把结果推给你（「今日签到已完成 ✅ +本次收益」）

## 自测

```sh
cd <repo>/hcnsec-checkin
python3 tests/mock-server.py 8899 &     # 模拟站点（默认带人机验证）
node tests/harness.mjs                  # 13 组用例
MOCK_TURNSTILE=0 node tests/harness.mjs # 对照：站点关闭人机验证时能全自动
```

（`node tests/harness.mjs` 会先调用模拟站点的 `/__reset` 清状态，两种模式可连着跑。）
