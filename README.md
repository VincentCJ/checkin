# Egern 自动签到脚本合集

Egern 用的「登录态自动抓取 + 每日定时签到」脚本，不需要手抄 token。

## 收录

| 站点 | 目录 | 说明 |
|---|---|---|
| `api.hcnsec.cn`（新疆幻城网安公益大模型网关，New API 系） | [`hcnsec-checkin/`](hcnsec-checkin/) | 抓登录态 + 每日签到 + 推送额度收益 |
| `freeapi.site`（露娜 AI API Gateway） | [`freeapi-checkin/`](freeapi-checkin/) | 抓 access/refresh token + 每日签到，自动续期 |
| `us-3.nianhuaapi.com`（年华 API 中转站） | [`nianhua-checkin/`](nianhua-checkin/) | 每日 10:20 签到；需人机验证时推可点通知 |

## 通用用法

1. 把对应目录下 `egern-配置片段.yaml` 里的 `mitm` / `scriptings` 条目并入
   Egern 当前配置（**合并列表，别覆盖**，否则原有脚本会丢），并重载配置。
2. 用手机浏览器**正常打开一次该站点并登录**（Egern 保持开启），
   抓取脚本会自动把认证信息存进 Egern 的本地存储，并弹一条通知。
3. 之后每天到点自动签到，结果由 Egern 通知推送。

`script_url` 支持远程链接，直接用本仓库的 raw 地址即可，例如：

```
https://raw.githubusercontent.com/VincentCJ/checkin/main/hcnsec-checkin/hcnsec-checkin.js
https://cdn.jsdelivr.net/gh/VincentCJ/checkin@main/hcnsec-checkin/hcnsec-checkin.js
```

（jsDelivr 那条国内访问更快，可自行替换。）

## 目录约定

```
hcnsec-checkin/
  hcnsec-auth-capture.js    抓登录态（http_request / http_response 两用）
  hcnsec-checkin.js         每日签到（schedule）
  egern-配置片段.yaml        直接并入配置
  tests/                    离线自测：模拟站点 + 假 ctx
freeapi-checkin/
  freeapi-token-capture.js  抓 access_token / refresh_token
  freeapi-checkin.js        每日签到 + token 过期自动续期
  egern-配置片段.yaml
```

## 排错

- **抓不到登录态**：确认 Egern 开着、`mitm.hostnames.includes` 里有该域名，
  然后重新打开一次站点。抓取脚本的 `NOTIFY_ANY` 设 `"1"` 可以把每次运行情况都推给你。
- **签到报「登录态失效」**：Cookie/令牌过期，重新登录一次站点即可（一般能维持较久）。
- **想先不真的签到**：把签到脚本的 `HCN_DRY_RUN` 设为 `"1"`，只读额度。
