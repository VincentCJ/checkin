# api.hcnsec.cn 自动签到 · Egern

站点：`https://api.hcnsec.cn`（新疆幻城网安公益大模型网关，New API 系）
结构、用法与之前的 **freeapi.site** 那套一致：**抓登录态 + 每日定时签到**，不手填 token。

## 文件

| 文件 | 作用 | 托管地址（Egern 用这个） |
|---|---|---|
| `hcnsec-auth-capture.js` | 抓登录态：请求头 Cookie/用户ID + 响应体令牌/Set-Cookie | `https://raw.githubusercontent.com/VincentCJ/checkin/main/hcnsec-checkin/hcnsec-auth-capture.js` |
| `hcnsec-checkin.js` | 每日定时签到 + 推送结果 | `https://raw.githubusercontent.com/VincentCJ/checkin/main/hcnsec-checkin/hcnsec-checkin.js` |
| `egern-配置片段.yaml` | 直接并入 Egern 配置的片段（含 A/B 两种抓取写法） | — |
| `tests/mock-server.py`、`tests/harness.mjs` | 离线自测（模拟站点 + 假 ctx 跑全部逻辑） | — |

## 部署

1. Egern → 配置 → 编辑当前配置：
   - `mitm.hostnames.includes` 加入 `api.hcnsec.cn`（建议连 `api.iamhc.cn` 一起）
   - `scriptings` 并入 `egern-配置片段.yaml` 里的条目（**合并列表，别覆盖**）
2. 保存并重载配置。
3. 用手机 Safari 打开一次 `https://api.hcnsec.cn` 并登录 / 进控制台 —— 抓取脚本会自动存下登录态（会弹一条「认证信息已抓取」通知）。
4. 之后每天 08:20 自动签到并推送结果。

## 关于「请求头和响应体能不能合成一个脚本」

- **一个脚本文件**：能，而且现在就是这么做的 —— `hcnsec-auth-capture.js` 同时兼容两种钩子。
- **一条配置**：也能。Egern 官方文档写明 `ctx.request` 在 response 脚本中同样可用，
  所以**只加一条 `http_response`（`body_required: true`）**就能同时读到请求头与响应体（方案 A）。
- 保底：万一某版本 response 里读不到 `ctx.request`，脚本不会报错，只是这次只抓到响应侧；
  把 `NOTIFY_ANY=1` 打开即可在通知里看到「模式：响应+请求头 / 仅响应」，此时换成方案 B（双条）。

## 环境变量

签到脚本：`NOTIFY_ALWAYS`（"0"=只报真领到）、`NOTIFY_ON_FAIL`、`NOTIFY_VERBOSE`、`HCN_DRY_RUN`、
手填凭据 `HCN_COOKIE` / `HCN_ACCESS_TOKEN` / `HCN_USER_ID`、自定义域名 `HCN_API_BASE`。

抓取脚本：`NOTIFY_ON_CAPTURE`（"0"=抓到时静默）、`NOTIFY_ANY`（"1"=每次运行都通知，排错用）。

## 自测

```sh
cd /var/minis/workspace/hcnsec-checkin
python3 tests/mock-server.py 8899 &   # 模拟站点
node tests/harness.mjs                # 11 组用例，覆盖抓取 / 签到 / 失败分支
```
