#!/usr/bin/env python3
"""把 minis-browser-use 的原始输出整理成一条通知文案。

用法：python3 report.py /tmp/hcn_raw.json
输出：{"title":..., "body":...}  的 JSON
"""
import json
import re
import sys
import datetime


def parse_raw(path):
    raw = open(path, encoding="utf-8", errors="replace").read()
    # minis-browser-use 在 JSON 信封后面还会跟一行 "  tab_id: 0"，先裁掉
    cut = raw.rfind("}")
    if cut > 0:
        raw = raw[: cut + 1]
    try:
        env = json.loads(raw)
        text = (env.get("data") or {}).get("text") or ""
    except Exception:
        m = re.search(r'"text"\s*:\s*"(.*)"', raw, re.S)
        text = json.loads('"' + m.group(1) + '"') if m else ""
    text = text.strip()
    # text 里可能还跟着 "  tab_id: 0" 之类的尾巴，只取最外层 { ... }
    if "{" in text and "}" in text:
        text = text[text.index("{"): text.rindex("}") + 1]
    if not text:
        return {"step": "parse-error", "ok": False, "msg": raw[:160]}
    try:
        return json.loads(text)
    except Exception:
        return {"step": "parse-error", "ok": False, "msg": text[:160]}


def main():
    d = parse_raw(sys.argv[1])
    unit = (d.get("site") or {}).get("unit") or 500000

    def money(q):
        try:
            return "¥%.2f" % (float(q) / unit)
        except Exception:
            return None

    name = (d.get("user") or {}).get("name") or "账号"
    step, msg, ok = d.get("step"), d.get("msg") or "", bool(d.get("ok"))
    aw = d.get("awarded")
    ts = datetime.datetime.now().strftime("%m-%d %H:%M")

    if step == "done" and ok and "已签到" in msg:
        st = d.get("stats") or {}
        title = "api.hcnsec.cn 今日已签到 ✅"
        body = "账号：%s" % name
        if st.get("total") is not None:
            body += "\n累计签到：%s 次" % st.get("total")
        bal = money(d.get("balance"))
        if bal:
            body += "\n当前额度：%s" % bal
    elif step == "done" and ok:
        title = "api.hcnsec.cn 签到成功 🎉"
        parts = ["账号：%s" % name]
        if aw is not None:
            parts.append("本次获得：%s（%s 额度）" % (money(aw) or aw, aw))
        bal = money(d.get("balanceAfter") or d.get("balance"))
        if bal:
            parts.append("当前额度：%s" % bal)
        body = "\n".join(parts)
    elif step == "done" and msg == "站点已关闭签到":
        title = "api.hcnsec.cn 签到未执行"
        body = "站点当前关闭了签到功能"
    elif step == "refresh":
        title = "api.hcnsec.cn 需要重新登录 ⚠️"
        body = "网页登录态已失效。请在 Minis 的内置浏览器里打开站点登录一次，之后就能继续自动签到。"
    elif step == "turnstile":
        title = "api.hcnsec.cn 签到未完成（人机验证）"
        body = "%s\n打开站点手动点一次「签到」即可。" % msg
    else:
        title = "api.hcnsec.cn 签到未完成 ⚠️"
        body = "%s\n%s" % (step, msg[:180])

    body += "\n时间：%s" % ts
    print(json.dumps({"title": title, "body": body}, ensure_ascii=False))


if __name__ == "__main__":
    main()
