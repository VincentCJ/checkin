# us-3.nianhuaapi.com（年华 API 中转站）自动签到 · Egern

站点：`https://us-3.nianhuaapi.com`（年华 API 中转站，New API 系）
版本：`1.0.0-rc.22-nianhua-bba9838-payguard-20261015`

## 这个站和 hcnsec 是同一套系统

`GET /api/status` 一读就清楚：

| 字段 | 值 |
|---|---|
| `checkin_enabled` | ✅ true |
| `turnstile_check` | ⚠️ **true** —— 签到接口要 Cloudflare Turnstile |
| `turnstile_site_key` | `0x4AAAAAAEwhg3PtOuQNLdRd` |
| `quota_per_unit` | 500000 |
| `quota_display_type` | USD（所以通知里按 **$** 显示） |
| `server_address` | `https://us-3.nianhuaapi.com` |

接口：

```
GET  /api/user/checkin?month=YYYY-MM   签到状态（不需要人机验证）
POST /api/user/checkin[?turnstile=...] 签到（挂了 Turnstile，每次都要全新 token）
POST /api/user/auth/refresh            用 new_api_refresh cookie 换 access_token
```

结论和 hcnsec 一样：**纯 HTTP 客户端过不了 Cloudflare 那关**，
所以脚本的策略是「能自动就自动，不能自动就给你一条可点通知」。

## 文件

| 文件 | 作用 |
|---|---|
| `nianhua-auth-capture.js` | 抓登录态（请求头 Cookie/用户ID + 响应体令牌/Set-Cookie） |
| `nianhua-checkin.js` | 每天 10:20 签到（cron `20 10 * * *`） |
| `egern-配置片段.yaml` | 直接并入 Egern 配置 |
| `tests/` | 离线自测：模拟站点 + 假 ctx，13 组用例 |

## 部署

1. Egern → 配置 → 编辑当前配置，**合并** `egern-配置片段.yaml` 的两部分
   （`mitm.hostnames.includes` 加域名；`scriptings` 加脚本，别覆盖原有条目）。
2. 保存并重载。
3. 用手机浏览器打开一次 `https://us-3.nianhuaapi.com` 并登录（Egern 保持开启），
   抓取脚本会自动存下登录态并弹通知。
4. 之后每天 **10:20** 自动跑一次。

## 通知长什么样

- 已签到 → `年华 API 今日已签到 ✅`（不打扰）
- 领到了 → `年华 API 签到成功 🎉` + 本次收益 + 当前额度
- 要人机验证 → `年华 API 需要手动签到（人机验证）`，**通知可点，点一下跳到站点**
- 登录态过期 → `年华 API 签到失败：登录态失效`，点通知去重新登录

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `NH_TURNSTILE` | 空 | 手填 Turnstile token（约 5 分钟有效） |
| `NH_MANUAL_URL` | `https://us-3.nianhuaapi.com/dashboard/overview` | 通知里打开的地址 |
| `NOTIFY_ALWAYS` | `1` | `"0"` = 只在真的领到时通知 |
| `NOTIFY_ON_FAIL` | `1` | `"0"` = 失败/待人工都不通知 |
| `NOTIFY_VERBOSE` | `0` | `"1"` = 带签到前额度 |
| `NH_DRY_RUN` | `0` | `"1"` = 只读状态不真的签到 |
| `NH_COOKIE` / `NH_ACCESS_TOKEN` / `NH_USER_ID` | 空 | 手填凭据（一般不用） |

## 自测

```sh
cd nianhua-checkin
python3 tests/mock-server.py 8901 &
MOCK_BASE=http://127.0.0.1:8901 node tests/harness.mjs                  # 站点开启人机验证
MOCK_BASE=http://127.0.0.1:8901 MOCK_TURNSTILE=0 node tests/harness.mjs # 对照：关闭时能全自动
```
