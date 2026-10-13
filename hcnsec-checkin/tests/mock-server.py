#!/usr/bin/env python3
"""模拟 api.hcnsec.cn 的本机服务，用于离线验证签到脚本逻辑。

模拟行为（按 New API 系通行的响应格式）：
  GET  /api/status         -> 站点配置（无需认证）
  GET  /api/user/self      -> 需认证；返回 quota
  POST /api/user/checkin   -> 需认证；首次返回 data.quota 奖励，重复返回 message 已签到
  GET  /api/user/checkin   -> 同上（GET 兜底场景）
认证：Cookie 里要有 session=<值>，请求头要有 New-Api-User: <id>
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"quota": 1_000_000, "checked_in": False, "hits": []}

VALID_SESSION = "abc123session"
VALID_UID = "42"

STATUS = {
    "data": {
        "system_name": "新疆幻城网安公益大模型安全网关",
        "checkin_enabled": True,
        "quota_per_unit": 500000,
        "quota_display_type": "CNY",
        "custom_currency_symbol": "¤",
        "version": "mock",
        "HeaderNavModules": "{}",
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
        token = self.headers.get("Authorization", "") or ""
        STATE["hits"].append({
            "method": self.command, "path": self.path,
            "cookie": cookie, "uid": uid, "auth": token[:20],
            "ua": (self.headers.get("User-Agent") or "")[:30],
            "x-auth-session": self.headers.get("X-Auth-Session") or "",
        })
        if f"session={VALID_SESSION}" in cookie and uid == VALID_UID:
            return True
        if token.strip() == "Bearer sk-mocktoken" and uid == VALID_UID:
            return True
        return False

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/status":
            return self.send(200, STATUS)
        if path == "/api/user/self":
            if not self.authed():
                return self.send(*unauthorized())
            return self.send(200, {"success": True, "message": "", "data": {
                "id": int(VALID_UID), "username": "opc", "display_name": "幻城用户",
                "quota": STATE["quota"], "used_quota": 12345,
                "checkin_date": "2026-10-13" if STATE["checked_in"] else ""}})
        if path == "/api/user/checkin":
            if not self.authed():
                return self.send(*unauthorized())
            if STATE["checked_in"]:
                return self.send(200, {"success": True, "message": "今日已签到，请明天再来", "data": {}})
            STATE["checked_in"] = True
            reward = 5000
            STATE["quota"] += reward
            return self.send(200, {"success": True, "message": "",
                                   "data": {"quota": reward, "checkin_date": "2026-10-13"}})
        return self.send(404, {"error": {"message": f"Invalid URL (GET {path})"}})

    def do_POST(self):
        path = self.path.split("?")[0]
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            self.rfile.read(n)
        if path == "/api/user/checkin":
            if not self.authed():
                return self.send(*unauthorized())
            if STATE["checked_in"]:
                return self.send(200, {"success": True, "message": "今日已签到，请明天再来", "data": {}})
            STATE["checked_in"] = True
            reward = 5000
            STATE["quota"] += reward
            return self.send(200, {"success": True, "message": "",
                                   "data": {"quota": reward, "checkin_date": "2026-10-13"}})
        return self.send(404, {"error": {"message": f"Invalid URL (POST {path})"}})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    print(f"mock listening on {port}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
