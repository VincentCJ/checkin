# freeapi.site（露娜 AI API Gateway）自动签到 · Egern

结构与 `hcnsec-checkin/` 完全一致：**抓 token + 每日定时签到**，token 过期自动用
`refresh_token` 续期，不需要手抄。

## 脚本

| 文件 | 作用 | 注册类型 |
|---|---|---|
| `freeapi-token-capture.js` | 抓 `access_token` / `refresh_token` | `http_request` + `http_response`（同一个文件注册两次） |
| `freeapi-checkin.js` | 每日签到，token 过期自动续期 | `schedule` |

真实接口（从前端 bundle 提取）：

```
GET  /api/v1/user/checkin  → { enabled, checked_in_today, today_amount, ... }
POST /api/v1/user/checkin  → { amount, checked_in_today, total_amount, ... }
```

Token 来源优先级：环境变量 `FREEAPI_TOKEN` → Egern 存储 `freeapi_access_token`（抓取脚本写入）。

## 配置

见 `egern-配置片段.yaml`，要点：

- `mitm.hostnames.includes` 加入 `freeapi.site`
- `http_request` 抓请求头里的 `Authorization: Bearer xxx`（最可靠，不需要 body）
- `http_response` 抓 `/auth/login`、`/auth/refresh` 响应体里的成对 token（`body_required: true`）
- `schedule` 每天 08:30 签到

## 存储键

`freeapi_access_token`、`freeapi_refresh_token`、`freeapi_expires_at`、
`freeapi_token_saved_at`、`freeapi_token_source` —— 签到脚本直接读这些键。
