/**
 * api.hcnsec.cn 每日自动签到 —— 浏览器版（在 Minis 内置浏览器里执行）
 *
 * 为什么需要它：该站 POST /api/user/checkin 挂了 Cloudflare Turnstile，
 * 纯 HTTP 客户端过不了；而内置浏览器是真实 WebKit，Cloudflare 会**免点击自动**签发 token。
 *
 * 执行位置：必须在 https://api.hcnsec.cn 页面上下文里运行（同源，cookie 自动带上）。
 * 执行方式：top-level return（execute_js 的脚本体就是一个 async 函数）。
 *
 * 流程：
 *   1. GET  /api/status                     确认签到开关 / 人机验证开关
 *   2. POST /api/user/auth/refresh          用 HttpOnly 的 new_api_refresh 换 access_token
 *   3. GET  /api/user/checkin?month=        今天是否已签到（免得白发一次请求）
 *   4. 渲染一个 Turnstile widget，等它自动出 token（通常 1~5 秒，无需点击）
 *   5. POST /api/user/checkin?turnstile=... 带着 Bearer + New-Api-User 签到
 */

const SITEKEY_FALLBACK = '0x4AAAAAAFIovBqwE9xMkrm_';
const out = { step: 'start', ok: false, notes: [] };
const log = (s) => out.notes.push(s);

try {
  /* ---------- 1) 站点配置 ---------- */
  const st = await fetch('/api/status', { credentials: 'include' }).then((r) => r.json()).catch(() => null);
  const cfg = (st && st.data) || {};
  out.site = { name: cfg.system_name, checkin: cfg.checkin_enabled, turnstile: !!cfg.turnstile_check, unit: cfg.quota_per_unit };
  if (cfg.checkin_enabled === false) { out.step = 'done'; out.msg = '站点已关闭签到'; return out; }
  const sitekey = cfg.turnstile_site_key || SITEKEY_FALLBACK;

  /* ---------- 2) 换 access_token ---------- */
  const rr = await fetch('/api/user/auth/refresh', { method: 'POST', credentials: 'include' });
  const rb = await rr.json().catch(() => null);
  const rd = (rb && rb.data) || {};
  const at = rd.access_token;
  const uid = rd.user && rd.user.id;
  const uname = rd.user && rd.user.username;
  if (!at) { out.step = 'refresh'; out.msg = '登录态失效，需要重新登录站点'; out.resp = rb; return out; }
  out.user = { name: uname, id: uid };
  log('已换取 access_token');
  const H = { accept: 'application/json', authorization: 'Bearer ' + at, 'new-api-user': String(uid) };

  /* ---------- 3) 今天签没签 ---------- */
  const now = new Date();
  const month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const sq = await fetch('/api/user/checkin?month=' + month, { headers: H, credentials: 'include' })
    .then((r) => r.json()).catch(() => null);
  const stats = (sq && sq.data && sq.data.stats) || {};
  out.stats = { today: stats.checked_in_today, total: stats.total_checkins, totalQuota: stats.total_quota };
  const self = await fetch('/api/user/self', { headers: H, credentials: 'include' }).then((r) => r.json()).catch(() => null);
  out.balance = self && self.data && self.data.quota;

  if (stats.checked_in_today === true) { out.step = 'done'; out.ok = true; out.msg = '今日已签到'; return out; }

  /* ---------- 4) 生成 Turnstile token（免点击） ---------- */
  if (!window.turnstile) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true; s.defer = true; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    }).catch(() => {});
  }
  if (!window.turnstile) { out.step = 'turnstile'; out.msg = 'Turnstile 脚本加载失败'; return out; }

  const token = await new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = '__hcn_ts';
    el.style.cssText = 'position:fixed;bottom:8px;left:8px;z-index:99999;background:#fff;padding:6px';
    document.body.appendChild(el);
    const t0 = Date.now();
    const iv = setInterval(() => {
      const inp = el.querySelector('input[name="cf-turnstile-response"]');
      const v = inp && inp.value;
      if (v && v.length > 20) { clearInterval(iv); el.remove(); resolve(v); }
      else if (Date.now() - t0 > 25000) { clearInterval(iv); el.remove(); resolve(null); }
    }, 250);
    try { window.turnstile.render(el, { sitekey: sitekey, callback: function () {} }); }
    catch (e) { el.remove(); clearInterval(iv); resolve(null); }
  });
  if (!token) { out.step = 'turnstile'; out.msg = 'Turnstile 未在 25 秒内签发 token（可能需要人工）'; return out; }
  log('Turnstile token 已免点击签发，长度 ' + token.length);

  /* ---------- 5) 签到 ---------- */
  const cr = await fetch('/api/user/checkin?turnstile=' + encodeURIComponent(token), {
    method: 'POST', headers: H, credentials: 'include'
  });
  let cb = null; try { cb = await cr.json(); } catch (e) { cb = await cr.text(); }
  out.http = cr.status;
  out.resp = cb;
  out.step = 'done';
  const okFlag = cb && cb.success !== false;
  out.ok = !!okFlag;
  out.msg = (cb && cb.message) || (okFlag ? '签到成功' : '签到失败');
  out.awarded = cb && cb.data && cb.data.quota_awarded;
  if (out.awarded == null && okFlag) {
    const after = await fetch('/api/user/self', { headers: H, credentials: 'include' }).then((r) => r.json()).catch(() => null);
    const q = after && after.data && after.data.quota;
    if (typeof q === 'number' && typeof out.balance === 'number') out.awarded = q - out.balance;
    out.balanceAfter = q;
  }
  return out;
} catch (e) {
  out.step = 'error';
  out.msg = String((e && e.message) || e);
  return out;
}