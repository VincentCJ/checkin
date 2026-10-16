/**
 * us-3.nianhuaapi.com（年华 API 中转站）每日签到 —— Egern（schedule / cron）
 *
 * 站点情况（与 api.hcnsec.cn 同源系统，已核实）：
 *   GET  /api/status                → checkin_enabled / turnstile_check / quota_per_unit
 *   GET  /api/user/checkin?month=   → 今日是否已签到（不需要人机验证）
 *   POST /api/user/checkin          → 签到；该接口挂了 Cloudflare Turnstile，
 *                                     每次都要一个全新的 ?turnstile=<token>，
 *                                     token 只能由真实浏览器签发
 *
 * 所以策略：
 *   1. 先查状态：今天已签到 → 通知「今日已签到 ✅」，不再打签到接口
 *   2. 站点关了人机验证 / 你有 token → 全自动签到
 *   3. 需要人机验证且没 token → 推一条**可点通知**，点一下直接跳到站点签到页
 *
 * 环境变量：
 *   NH_COOKIE / NH_ACCESS_TOKEN / NH_USER_ID  手填凭据（一般留空，抓取脚本会自动存）
 *   NH_TURNSTILE     手填 Turnstile token（约 5 分钟有效，一般不用）
 *   NH_MANUAL_URL    通知里「去签到」打开的地址，默认 https://us-3.nianhuaapi.com/dashboard/overview
 *   NH_API_BASE      默认 https://us-3.nianhuaapi.com
 *   NOTIFY_ALWAYS    "0" = 只在真的领到时通知（默认 "1"）
 *   NOTIFY_ON_FAIL   "0" = 失败/待人工也不通知（默认 "1"）
 *   NOTIFY_VERBOSE   "1" = 带签到前额度明细
 *   NH_DRY_RUN       "1" = 只读状态不真的签到
 */

const DEFAULT_BASE = 'https://us-3.nianhuaapi.com';
const SNAP_KEY = 'nh_auth_snapshot';
const TS_KEY = 'nh_turnstile';
const LOG_KEY = 'nh_last_run';
const TS_MAX_AGE = 4 * 60 * 1000;

let ctx = null;

/* ---------------- 小工具 ---------------- */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function monthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function loadJSON(key) {
  try {
    const raw = ctx.storage.get(key);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

// 站点 quota_display_type 是 USD 时按美元显示
function fmtQuota(quota, unit, symbol) {
  if (typeof quota !== 'number' || !isFinite(quota)) return null;
  const u = unit && unit > 0 ? unit : 500000;
  const v = quota / u;
  const s = symbol || '$';
  const digits = Math.abs(v) < 0.01 && v !== 0 ? 4 : 2;
  return `${s}${v.toFixed(digits)}`;
}

function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((a, b) => (a == null ? a : a[b]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

const ALREADY_RE = /(已经签到|已签到|今日已|重复签到|明天再来|already)/i;
const EXPIRED_RE = /(unauthorized|invalid access token|token.*(invalid|expired)|未登录|登录已过期|授权失败|无权)/i;
const TURNSTILE_RE = /turnstile/i;

/* ---------------- HTTP ---------------- */

async function api(path, opts, headers, base) {
  const o = Object.assign({ headers: Object.assign({}, headers), timeout: 15000 }, opts || {});
  const url = base.replace(/\/+$/, '') + path;
  let resp;
  if (ctx.http && ctx.http.get) {
    const m = (o.method || 'GET').toLowerCase();
    resp = await ctx.http[m === 'delete' ? 'delete' : m](url, o);
  } else {
    resp = await fetch(url, o);
  }
  let text = '';
  try { text = await resp.text(); } catch (e) { text = ''; }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: resp.status, text, json, headers: resp.headers };
}

/* ---------------- 主流程 ---------------- */

export default async function (ctx_) {
  ctx = ctx_;
  const env = ctx.env || {};
  const base = (env.NH_API_BASE || DEFAULT_BASE).trim();
  const manualUrl = (env.NH_MANUAL_URL || `${base}/dashboard/overview`).trim();
  const NOTIFY_ALWAYS = env.NOTIFY_ALWAYS !== '0';
  const NOTIFY_ON_FAIL = env.NOTIFY_ON_FAIL !== '0';
  const VERBOSE = env.NOTIFY_VERBOSE === '1';
  const DRY_RUN = env.NH_DRY_RUN === '1';

  const snap = loadJSON(SNAP_KEY);
  const cookie = (env.NH_COOKIE || snap.cookie || '').trim();
  let token = (env.NH_ACCESS_TOKEN || snap.accessToken || '').trim();
  const userId = String(env.NH_USER_ID || snap.newApiUser || '').trim();

  const done = (title, body, ok, opts) => {
    const o = opts || {};
    ctx.storage.set(LOG_KEY, JSON.stringify({ at: Date.now(), ok: !!ok, title, body, needsHuman: !!o.needsHuman }));
    if (o.quiet) return;
    if (ok ? true : NOTIFY_ON_FAIL) {
      const n = { title, body, sound: !!ok };
      if (o.needsHuman) n.action = { type: 'openUrl', url: manualUrl };
      ctx.notify(n);
    }
  };

  if (!cookie && !token) {
    done(
      '年华 API 签到未执行',
      '❌ 没有可用的登录态。\n打开一次站点让抓取脚本先工作，或填 NH_COOKIE / NH_ACCESS_TOKEN。',
      false
    );
    return;
  }

  /* ---- 1) 站点状态 ---- */
  let unit = 500000, symbol = '$', checkinEnabled = true, turnstileCheck = false;
  try {
    const st = await api('/api/status', {}, {}, base);
    const d = (st.json && st.json.data) || {};
    if (d.quota_per_unit) unit = Number(d.quota_per_unit) || unit;
    if (d.quota_display_type === 'CNY') symbol = '¥';
    else if (d.quota_display_type === 'USD') symbol = '$';
    else if (d.custom_currency_symbol && d.quota_display_type !== 'CNY') symbol = String(d.custom_currency_symbol);
    if (d.checkin_enabled === false) checkinEnabled = false;
    if (d.turnstile_check === true) turnstileCheck = true;
  } catch (e) { /* 状态接口失败不影响签到 */ }

  if (!checkinEnabled) {
    done('年华 API 签到未执行', '站点当前关闭了签到功能（checkin_enabled = false）。', false);
    return;
  }

  /* ---- 2) 认证头 ---- */
  const headers = {
    accept: 'application/json, text/plain, */*',
    'user-agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  };
  if (cookie) headers.cookie = cookie;
  if (snap.xApiKey) headers['x-api-key'] = snap.xApiKey;
  if (userId) headers['new-api-user'] = userId;
  if (snap.xAuthSession) headers['x-auth-session'] = snap.xAuthSession;

  // 有 refresh 就先换 access_token（令牌轮换，写回快照）
  const refreshTok = snap.refreshToken || '';
  const rc = /new_api_refresh=([^;]+)/.exec(cookie);
  if (!token && (refreshTok || rc)) {
    try {
      const rh = { cookie: `new_api_refresh=${refreshTok || (rc ? rc[1] : '')}` };
      const rr = await api('/api/user/auth/refresh', { method: 'POST' }, rh, base);
      const rd = (rr.json && (rr.json.data || rr.json)) || {};
      const newTok = pick(rd, ['access_token', 'accessToken', 'token', 'session.access_token']);
      if (newTok) {
        token = newTok;
        snap.accessToken = newTok;
        const newRef = pick(rd, ['refresh_token', 'refreshToken']);
        if (newRef) snap.refreshToken = newRef;
        try {
          const sc = rr.headers && rr.headers.getAll ? rr.headers.getAll('set-cookie') : null;
          for (const c of [].concat(sc || [])) {
            const m = /new_api_refresh=([^;]+)/.exec(String(c));
            if (m) snap.refreshToken = m[1];
          }
        } catch (e) { /* 用旧的 */ }
        snap.savedAt = Date.now();
        ctx.storage.set(SNAP_KEY, JSON.stringify(snap));
      }
    } catch (e) { /* refresh 失败退回原凭据 */ }
  }
  if (token) headers.authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;

  /* ---- 3) 今天签没签 ---- */
  let already = false, before = null, username = '', stats = null;
  const stq = await api(`/api/user/checkin?month=${monthStr()}`, {}, headers, base);
  if (stq.json && stq.json.success !== false) {
    const d = stq.json.data || {};
    stats = d.stats || null;
    if (stats && stats.checked_in_today === true) already = true;
  } else {
    const msg = String((stq.json && stq.json.message) || stq.text || '');
    if (stq.status === 401 || EXPIRED_RE.test(msg)) {
      done('年华 API 签到失败：登录态失效',
        `⚠️ 打开 ${base} 重新登录一次即可恢复。`, false, { needsHuman: true });
      return;
    }
  }

  const selfBefore = await api('/api/user/self', {}, headers, base);
  if (selfBefore.json && selfBefore.json.success !== false) {
    const d = selfBefore.json.data || {};
    before = typeof d.quota === 'number' ? d.quota : null;
    username = d.display_name || d.username || '';
    if (!userId && d.id) headers['new-api-user'] = String(d.id);
  } else if (selfBefore.status === 401) {
    done('年华 API 签到失败：登录态失效',
      `⚠️ 打开 ${base} 重新登录一次即可恢复。`, false, { needsHuman: true });
    return;
  }

  const lines = [];
  lines.push(`账号：${username || '(未知)'}`);
  if (before != null) lines.push(`当前额度：${fmtQuota(before, unit, symbol) || before}`);
  if (stats && typeof stats.total_checkins === 'number') {
    lines.push(`累计签到：${stats.total_checkins} 次 / ${fmtQuota(stats.total_quota, unit, symbol) || stats.total_quota}`);
  }
  lines.push(`时间：${stamp()}`);

  if (DRY_RUN) {
    done('年华 API 签到（试运行）',
      `认证信息可用 ✅\n今日是否已签到：${already ? '是' : '否'}\n站点人机验证：${turnstileCheck ? '开启' : '关闭'}\n${lines.join('\n')}`,
      false);
    return;
  }

  if (already) {
    done('年华 API 今日已签到 ✅', lines.join('\n'), true, { quiet: !NOTIFY_ALWAYS });
    return;
  }

  /* ---- 4) 取 Turnstile token ---- */
  let tsToken = (env.NH_TURNSTILE || '').trim();
  if (!tsToken) {
    const t = loadJSON(TS_KEY);
    if (t.token && t.at && Date.now() - Number(t.at) < TS_MAX_AGE) tsToken = t.token;
  }

  const url = tsToken
    ? `/api/user/checkin?turnstile=${encodeURIComponent(tsToken)}`
    : '/api/user/checkin';
  const r = await api(url, { method: 'POST' }, headers, base);

  const bodyJson = r.json || {};
  let msg = String(bodyJson.message || bodyJson.error || '').trim();
  if (!msg && r.status >= 400) msg = String(r.text || '').slice(0, 120);

  const okHttp = r.status >= 200 && r.status < 300;
  const okFlag = bodyJson.success !== false;
  const data = bodyJson.data || {};
  const awarded = typeof data.quota_awarded === 'number' ? data.quota_awarded : null;
  const blockedByTs = !okFlag && TURNSTILE_RE.test(msg);
  const repeated = !okFlag && ALREADY_RE.test(msg);

  /* ---- 5) 结果 ---- */
  if (okHttp && okFlag) {
    const gain = awarded != null ? `+${fmtQuota(awarded, unit, symbol) || awarded}` : '已到账';
    const after = await api('/api/user/self', {}, headers, base);
    let afterQ = null;
    if (after.json && after.json.success !== false) {
      const d = after.json.data || {};
      afterQ = typeof d.quota === 'number' ? d.quota : null;
      if (!username) username = d.display_name || d.username || '';
    }
    const body = [
      `✅ 本次获得：${gain}${awarded != null && awarded !== 0 ? `（${awarded} 额度）` : ''}`,
      `账号：${username || '(未知)'}`,
      ...(afterQ != null ? [`当前额度：${fmtQuota(afterQ, unit, symbol) || afterQ}`] : []),
      ...(VERBOSE && before != null ? [`签到前额度：${fmtQuota(before, unit, symbol) || before}`] : []),
      `时间：${stamp()}`,
    ];
    done('年华 API 签到成功 🎉', body.join('\n'), true);
    return;
  }

  if (repeated) {
    done('年华 API 今日已签到 ✅', lines.join('\n'), true, { quiet: !NOTIFY_ALWAYS });
    return;
  }

  if (blockedByTs) {
    done(
      '年华 API 需要手动签到（人机验证）',
      [
        '⏳ 站点要求 Cloudflare 人机验证，脚本代替不了。',
        '点这条通知即可打开站点，点一下「签到」就好。',
        '',
        ...lines,
      ].join('\n'),
      false,
      { needsHuman: true }
    );
    return;
  }

  if (r.status === 401 || EXPIRED_RE.test(msg)) {
    done('年华 API 签到失败：登录态失效',
      `⚠️ 打开 ${base} 重新登录一次即可恢复。\n${lines.join('\n')}`, false, { needsHuman: true });
    return;
  }

  done('年华 API 签到失败', `❌ HTTP ${r.status}\n${msg || '(无返回内容)'}\n${lines.join('\n')}`, false);
}
