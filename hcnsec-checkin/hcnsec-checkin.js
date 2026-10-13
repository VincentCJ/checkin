/**
 * api.hcnsec.cn 每日自动签到脚本 —— Egern（schedule / cron）
 *
 * 配合 hcnsec-auth-capture.js 使用：抓取脚本负责把浏览器真实使用的认证头抄下来，
 * 这个脚本负责每天定时回放它们去签到，并推送结果。
 *
 * 流程：
 *   1. 读取认证信息（优先环境变量，其次抓取脚本存的快照）
 *   2. GET  /api/status        —— 拿站点配置（签到开关、额度单位、货币符号）
 *   3. GET  /api/user/self     —— 签到前额度
 *   4. POST /api/user/checkin  —— 签到（若该站只认 GET 会自动回退）
 *   5. GET  /api/user/self     —— 签到后额度，算出本次收益
 *   6. 推送通知（成功 / 重复签到 / 登录态失效）
 *
 * 环境变量（全部可选）：
 *   HCN_COOKIE         手填 Cookie（留空则用抓取脚本存的）
 *   HCN_ACCESS_TOKEN   手填系统访问令牌 sk-xxx（留空则用抓取脚本存的）
 *   HCN_USER_ID        手填用户 ID（留空则用抓取脚本存的）
 *   HCN_API_BASE       默认 https://api.hcnsec.cn
 *   NOTIFY_ALWAYS      "0" = 只在真的签到成功时通知（默认 "1"，每天都有结果推送）
 *   NOTIFY_ON_FAIL     "0" = 失败时也不通知（默认 "1"）
 *   NOTIFY_VERBOSE     "1" = 通知里带上额度明细（默认 "0"）
 *   HCN_DRY_RUN        "1" = 只读额度不真的签到（排错用）
 */

const DEFAULT_BASE = 'https://api.hcnsec.cn';
const SNAP_KEY = 'hcnsec_auth_snapshot';
const LOG_KEY = 'hcnsec_last_run';

let ctx = null;

/* ---------------- 小工具 ---------------- */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loadSnapshot() {
  try {
    const raw = ctx.storage.get(SNAP_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

// 把「额度」换算成站点显示的单位，例如 ¥1.23
function fmtQuota(quota, unit, symbol) {
  if (typeof quota !== 'number' || !isFinite(quota)) return null;
  const u = unit && unit > 0 ? unit : 500000;
  const v = quota / u;
  const s = symbol || '¥';
  // 小于 0.01 时多给两位
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

function normalizeMsg(m) {
  return String(m || '').trim();
}

const ALREADY_RE = /(已经签到|已签到|重复签到|今日已|明天再来|already|checked[\s-]?in|repeat)/i;
const EXPIRED_RE = /(unauthorized|invalid access token|token.*(invalid|expired)|未登录|登录已过期|授权失败)/i;

/* ---------------- HTTP ---------------- */

async function api(path, opts, headers, base) {
  const o = Object.assign({ headers: Object.assign({}, headers), timeout: 15000 }, opts || {});
  const url = base.replace(/\/+$/, '') + path;
  let resp;
  if (ctx.http && ctx.http.get) {
    const fn = (o.method || 'GET').toLowerCase();
    resp = await ctx.http[fn === 'delete' ? 'delete' : fn](url, o);
  } else {
    resp = await fetch(url, o); // 本地测试兜底
  }
  let text = '';
  try { text = await resp.text(); } catch (e) { text = ''; }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: resp.status, text, json };
}

/* ---------------- 主流程 ---------------- */

export default async function (ctx_) {
  ctx = ctx_;
  const env = ctx.env || {};
  const base = (env.HCN_API_BASE || DEFAULT_BASE).trim();
  const NOTIFY_ALWAYS = env.NOTIFY_ALWAYS !== '0';
  const NOTIFY_ON_FAIL = env.NOTIFY_ON_FAIL !== '0';
  const VERBOSE = env.NOTIFY_VERBOSE === '1';
  const DRY_RUN = env.HCN_DRY_RUN === '1';

  const snap = loadSnapshot();
  const cookie = (env.HCN_COOKIE || snap.cookie || '').trim();
  const token = (env.HCN_ACCESS_TOKEN || snap.accessToken || '').trim();
  const userId = String(env.HCN_USER_ID || snap.newApiUser || '').trim();

  // quiet=true 时只记录不推送（比如 NOTIFY_ALWAYS=0 时的「今日已签到」）
  const done = (title, body, ok, quiet) => {
    ctx.storage.set(LOG_KEY, JSON.stringify({ at: Date.now(), ok: !!ok, title, body }));
    if (quiet) return;
    if (ok ? true : NOTIFY_ON_FAIL) ctx.notify({ title, body, sound: !!ok });
  };

  if (!cookie && !token) {
    done(
      'api.hcnsec.cn 签到未执行',
      '❌ 没有可用的登录态。\n解决办法：打开一次站点（控制台页面）并确保 Egern 开着，让抓取脚本先工作；\n或在脚本环境变量里填 HCN_ACCESS_TOKEN / HCN_COOKIE。',
      false
    );
    return;
  }

  // 回放认证头（抓什么回放什么）
  const headers = {
    accept: 'application/json, text/plain, */*',
    'user-agent':
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  };
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = /^Bearer\s/i.test(token) ? token : `Bearer ${token}`;
  if (snap.xApiKey) headers['x-api-key'] = snap.xApiKey;
  if (userId) headers['new-api-user'] = userId;
  if (snap.xAuthSession) headers['x-auth-session'] = snap.xAuthSession;

  /* 1) 站点配置（无需认证） */
  let unit = 500000, symbol = '¥', checkinEnabled = true, siteName = '';
  try {
    const st = await api('/api/status', {}, {}, base);
    const d = (st.json && st.json.data) || {};
    if (d.quota_per_unit) unit = Number(d.quota_per_unit) || unit;
    if (d.quota_display_type === 'CNY') symbol = '¥';
    else if (d.quota_display_type === 'USD') symbol = '$';
    else if (d.custom_currency_symbol) symbol = String(d.custom_currency_symbol);
    if (d.checkin_enabled === false) checkinEnabled = false;
    if (d.system_name) siteName = String(d.system_name);
  } catch (e) { /* 状态接口失败不影响签到 */ }

  if (!checkinEnabled) {
    done('api.hcnsec.cn 签到未执行', '站点当前关闭了签到功能（checkin_enabled = false）。', false);
    return;
  }

  /* 2) 签到前额度 */
  let before = null, username = '';
  const selfBefore = await api('/api/user/self', {}, headers, base);
  if (selfBefore.json && selfBefore.json.success !== false) {
    const d = selfBefore.json.data || {};
    before = typeof d.quota === 'number' ? d.quota : null;
    username = d.display_name || d.username || '';
    if (!userId && d.id) headers['new-api-user'] = String(d.id);
  } else if (selfBefore.status === 401 || EXPIRED_RE.test(normalizeMsg(selfBefore.json && selfBefore.json.message) + selfBefore.text)) {
    done(
      'api.hcnsec.cn 签到失败：登录态失效',
      '⚠️ 抓到的 Cookie/令牌已失效。\n请用手机浏览器打开 https://api.hcnsec.cn 重新登录一次（Egern 保持开启即可自动补抓），明天就会恢复正常。',
      false
    );
    return;
  }

  if (DRY_RUN) {
    done('api.hcnsec.cn 签到（试运行）', `认证信息可用 ✅\n用户：${username || '(未知)'}\n当前额度：${fmtQuota(before, unit, symbol) || '未知'}`, false);
    return;
  }

  /* 3) 签到 */
  let r = await api('/api/user/checkin', { method: 'POST' }, headers, base);
  // 个别版本只认 GET / 或路径不同，做一次兜底
  if (r.status === 404 || r.status === 405) {
    const alt = await api('/api/user/checkin', {}, headers, base);
    if (alt.status && alt.status !== 404 && alt.status !== 405) r = alt;
  }

  /* 4) 签到后额度 */
  let after = null;
  try {
    const selfAfter = await api('/api/user/self', {}, headers, base);
    if (selfAfter.json && selfAfter.json.success !== false) {
      const d = selfAfter.json.data || {};
      after = typeof d.quota === 'number' ? d.quota : null;
      if (!username) username = d.display_name || d.username || '';
    }
  } catch (e) { /* 读不到不影响结论 */ }

  /* 5) 判定结果 */
  const bodyJson = r.json || {};
  let msg = normalizeMsg(bodyJson.message || bodyJson.error || '');
  if (!msg && r.status >= 400) msg = normalizeMsg((r.text || '').slice(0, 120));
  const data = bodyJson.data || bodyJson || {};
  const apiReward = pick(data, ['quota', 'checkin_quota', 'reward', 'amount', 'added_quota', 'delta_quota']);
  const reward = (before != null && after != null && after !== before)
    ? after - before
    : (typeof apiReward === 'number' ? apiReward : null);

  const okHttp = r.status >= 200 && r.status < 300;
  const okFlag = bodyJson.success !== false;
  const already = ALREADY_RE.test(msg);
  const expired = r.status === 401 || (EXPIRED_RE.test(msg || '') && !okHttp);

  const lines = [];
  lines.push(`账号：${username || '(未知)'}`);
  if (reward != null && reward !== 0) lines.push(`本次收益：+${fmtQuota(reward, unit, symbol) || reward}（${reward} 额度）`);
  else if (already) lines.push('本次收益：今天已经领过了');
  if (after != null) lines.push(`当前额度：${fmtQuota(after, unit, symbol) || after}`);
  if (VERBOSE && before != null) lines.push(`签到前额度：${fmtQuota(before, unit, symbol) || before}`);
  lines.push(`时间：${stamp()}`);
  if (msg && !already) lines.push(`服务端：${msg.slice(0, 80)}`);

  if (okHttp && okFlag) {
    if (already) {
      done('api.hcnsec.cn 今日已签到 ✅', lines.join('\n'), true, !NOTIFY_ALWAYS);
    } else if (reward === 0) {
      done('api.hcnsec.cn 签到已提交（额度未变化）', lines.join('\n') + '\n（可能今天已经领过，或站点延迟入账）', false);
    } else {
      done('api.hcnsec.cn 签到成功 🎉', lines.join('\n'), true);
    }
  } else if (expired) {
    done(
      'api.hcnsec.cn 签到失败：登录态失效',
      `⚠️ 请用手机浏览器打开 ${base} 重新登录一次\n${lines.join('\n')}`,
      false
    );
  } else {
    done('api.hcnsec.cn 签到失败', `❌ HTTP ${r.status}\n${lines.join('\n')}\n${(r.text || '').slice(0, 160)}`, false);
  }
}
