#!/bin/sh
# api.hcnsec.cn 每日自动签到 —— 用 Minis 内置浏览器跑（能过 Cloudflare Turnstile）
#
# 用法： sh /var/minis/workspace/hcnsec-checkin/browser/checkin.sh
#
# 流程：
#   1. 在内置浏览器里打开站点（用你已登录的会话）
#   2. 注入浏览器端签到脚本（生成 Turnstile token → 换 access_token → 签到）
#   3. 整理成一条 iOS 通知 + 打印 JSON 结果（供聊天里汇报）
#
# 注意：网页会话只存在于 Minis 进程内；Minis 完全退出后，需要先手动打开一次站点重新登录。

SCRIPT_DIR=/var/minis/workspace/hcnsec-checkin/browser
JS="$SCRIPT_DIR/hcnsec-browser-checkin.js"
URL_PROFILE="https://api.hcnsec.cn/profile"

# 1) 定位到站点（复用已登录的标签页）
minis-browser-use navigate --url "$URL_PROFILE" >/dev/null 2>&1
sleep 2
minis-browser-use wait_for_dom_stable --timeout 8000 >/dev/null 2>&1

# 2) 执行签到脚本，原始输出落盘
minis-browser-use execute_js --script "$(cat "$JS")" > /tmp/hcn_raw.json 2>&1

# 3) 解析 → 文案 → 通知
python3 "$SCRIPT_DIR/report.py" /tmp/hcn_raw.json > /tmp/hcn_notify.json 2>/tmp/hcn_err.txt
if [ ! -s /tmp/hcn_notify.json ]; then
  printf '{"title":"api.hcnsec.cn 签到脚本异常","body":"解析失败：%s","interactive":false}\n' \
    "$(head -c 120 /tmp/hcn_err.txt | tr '\n' ' ')" > /tmp/hcn_notify.json
fi

TITLE=$(python3 -c "import json;print(json.load(open('/tmp/hcn_notify.json'))['title'])")
BODY=$(python3 -c "import json;print(json.load(open('/tmp/hcn_notify.json'))['body'])")

apple-notification schedule --title "$TITLE" --body "$BODY" --after 1 >/dev/null 2>&1

cat /tmp/hcn_notify.json
exit 0
