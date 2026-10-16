#!/usr/bin/env python3
"""模拟 us-3.nianhuaapi.com 的本机服务，用于离线验证签到脚本逻辑。

严格照抄站点源码的行为（middleware/turnstile-check.go + controller/checkin.go）：
  GET  /api/status                 → 站点配置（含 turnstile_check / checkin_enabled）
  GET  /api/user/self              → 需认证；返回 quota
  GET  /api/user/checkin?month=    → 需认证；返回 stats.checked_in_today 等
  POST /api/user/checkin[?turnstile=TOKEN]
        · turnstile_check 开启且没带 token → {"success":false,"message":"Turnstile token 为空"}
        · token 不等于 VALID_TOKEN      → {"success":false,"message":"Turnstile 校验失败，请刷新重试！"}
        · 今天已签                       → {"success":false,"message":"今日已签到，请明天再来"}
        · 否则                           → {"success":true,"message":"签到成功",
                                            "data":{"quota_awarded":N,"checkin_date":"..."}}
认证：Cookie 里要有 session=<值>，请求头要有 New-Api-User: <id>
环境变量 MOCK_TURNSTILE=0 可关闭人机验证（模拟站点哪天关掉了 turnstile）。
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VALID_SESSION = "abc123session"
VALID_UID = "42"
VALID_TOKEN = "0.mock-turnstile-token"

TURNSTILE = os.environ.get("MOCK_TURNSTILE", "1") != "0"

STATE = {"quota": 1_000_000, "checked_in": False, "hits": []}

STATUS = {
    "data": {
        "system_name": "年华 API 中转站",
        "checkin_enabled": True,
        "turnstile_check": TURNSTILE,
        "turnstile_site_key": "0x4AAAAAAFIovBqwE9xMkrm_",
        "quota_per_unit": 500000,
        "quota_display_type": "USD",
        "custom_currency_symbol": "$",
    },
    "success": True,
}


def unauthorized():
    return 401, {"code": "AUTH_UNAUTHORIZED",
                 "message": "Unauthorized, invalid access token",
                 "success": False}


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def send(self, code, obj):
        payload = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def authed(self):
        cookie = self.headers.get("Cookie", "") or ""
        uid = self.headers.get("New-Api-User", "") or ""
        auth = self.headers.get("Authorization", "") or ""
        STATE["hits"].append({"method": self.command, "path": self.path,
                              "cookie": cookie[:40], "uid": uid, "auth": auth[:24]})
        if f"session={VALID_SESSION}" in cookie and uid == VALID_UID:
            return True
        if auth.strip() == "Bearer sk-mocktoken" and uid == VALID_UID:
            return True
        return False

    def do_GET(self):
        path, _, query = self.path.partition("?")
        if path == "/__reset":  # 测试用：重置站点状态
            STATE["quota"] = 1_000_000
            STATE["checked_in"] = False
            STATE["hits"] = []
            return self.send(200, {"ok": True, "turnstile": TURNSTILE})
        if path == "/__hits":  # 测试用：查看请求轨迹
            return self.send(200, {"hits": STATE["hits"]})
        if path == "/api/status":
            return self.send(200, STATUS)
        if path == "/api/user/self":
            if not self.authed():
                return self.send(*unauthorized())
            return self.send(200, {"success": True, "message": "", "data": {
                "id": int(VALID_UID), "username": "opc", "display_name": "幻城用户",
                "quota": STATE["quota"], "used_quota": 12345}})
        if path == "/api/user/checkin":
            if not self.authed():
                return self.send(*unauthorized())
            return self.send(200, {"success": True, "message": "", "data": {
                "enabled": True, "min_quota": 1000, "max_quota": 10000,
                "stats": {"total_quota": 12345, "total_checkins": 3, "checkin_count": 3,
                          "checked_in_today": STATE["checked_in"], "records": []}}})
        return self.send(404, {"error": {"message": f"Invalid URL (GET {path})"}})

    def do_POST(self):
        path, _, query = self.path.partition("?")
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        if path == "/api/user/checkin":
            if not self.authed():
                return self.send(*unauthorized())
            if TURNSTILE:
                tok = ""
                for kv in query.split("&"):
                    if kv.startswith("turnstile="):
                        tok = kv.split("=", 1)[1]
                if not tok:
                    return self.send(200, {"success": False, "message": "Turnstile token 为空"})
                if tok != VALID_TOKEN:
                    return self.send(200, {"success": False, "message": "Turnstile 校验失败，请刷新重试！"})
            if STATE["checked_in"]:
                return self.send(200, {"success": False, "message": "今日已签到，请明天再来"})
            STATE["checked_in"] = True
            reward = 5000
            STATE["quota"] += reward
            return self.send(200, {"success": True, "message": "签到成功",
                                   "data": {"quota_awarded": reward, "checkin_date": "2026-10-13"}})
        return self.send(404, {"error": {"message": f"Invalid URL (POST {path})"}})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f"mock listening on {port} (turnstile={TURNSTILE})", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
