// ==UserScript==
// @name         Lnfi 挂单地址持仓（地址后显示）
// @namespace    lnfi-tools
// @version      3.0
// @description  在 Lnfi 挂单列表的地址后面，显示该地址当前持有的代币数量（自动识别币种）
// @match        https://mainnet.lnfi.network/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      api.lnfi.network
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ══════════ 配置 ══════════
  const ORDER_MS  = 60000;     // 挂单刷新
  const HOLDER_MS = 300000;    // 持仓刷新（全量 33 页较慢，5 分钟）
  // 只在挂单列表页显示（hash 路由，@match 匹配不到 hash，需手动判断）
  const TARGET_HASHES = ['/trade/p2p/listing'];

  // RGB 资产 ID 映射（自动识别币种用）
  const ASSETS = {
    PPRGB: 'rgb:od~ZUtqX-5IcDmgM-jUc~aDK-795lX_u-OSEUL0w-z3iYvxY',
    CATO:  'rgb:8GXXGC2c-XXmxOV0-UUGTy2E-co_Z752-xZrOnFn-5nVNtlQ',
    SOON:  'rgb:rN_RCdnA-NXjVX1B-lnFNDm8-Y6qoKmL-6GBobvr-Bh3XXt0',
    MOULA: 'rgb:bJ2EV~tH-bfG78Yg-s5VrgHE-Ok4TILs-dZzdZaM-xOOtBqM',
    SUS:   'rgb:RgNz60r0-7vYYok6-AMWAqA5-afIFYle-Vz54aB7-IjaXxns',
    BURGER:'rgb:8GXXGC2c-XXmxOV0-UUGTy2E-co_Z752-xZrOnFn-5nVNtlQ',
  };
  const DEFAULT_TOKEN = 'PPRGB';

  // ══════════ 1. hex → npub ══════════
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function convertBits(data, from, to) {
    let acc = 0, bits = 0; const ret = [], maxv = (1 << to) - 1, maxAcc = (1 << (from + to - 1)) - 1;
    for (const v of data) { acc = ((acc << from) | v) & maxAcc; bits += from;
      while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); } }
    if (bits) ret.push((acc << (to - bits)) & maxv); return ret;
  }
  function polymod(values) {
    const GEN = [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3]; let chk = 1;
    for (const v of values) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i]; } return chk;
  }
  function hexToNpub(hex) {
    if (!hex || hex.length !== 64) return null;
    try {
      const expand = (h) => { const o = []; for (const c of h) o.push(c.charCodeAt(0) >> 5);
        o.push(0); for (const c of h) o.push(c.charCodeAt(0) & 31); return o; };
      const bytes = []; for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
      const data = convertBits(bytes, 8, 5);
      const pm = polymod(expand('npub').concat(data).concat([0,0,0,0,0,0])) ^ 1;
      const cs = []; for (let i = 0; i < 6; i++) cs.push((pm >> (5 * (5 - i))) & 31);
      return 'npub1' + data.concat(cs).map((d) => CHARSET[d]).join('');
    } catch (e) { return null; }
  }

  // ══════════ 2. API ══════════
  function api(path, payload) {
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: 'https://api.lnfi.network' + path,
        headers: { 'Content-Type': 'application/json;charset=UTF-8' },
        data: JSON.stringify(payload),
        onload: (r) => { try { resolve(JSON.parse(r.responseText)); } catch (e) { resolve(null); } },
        onerror: () => resolve(null), ontimeout: () => resolve(null),
      });
    });
  }

  // ══════════ 3. 只在目标页面运行（hash 路由判断）══════════
  function isTargetPage() {
    return TARGET_HASHES.some((h) => location.hash.includes(h));
  }

  // 离开目标页时清理注入的元素
  function cleanup() {
    document.querySelectorAll('.lnfi-hold').forEach((e) => e.remove());
    const bar = document.getElementById('lnfi-bar');
    if (bar) bar.remove();
  }

  // ══════════ 4. 自动识别当前页面的币种与方向 ══════════
  function detectContext() {
    let token = null, side = null;
    const checked = document.querySelector('input[type=radio]:checked');
    if (checked) {
      const label = ((checked.closest('label') || checked.parentElement || {}).textContent || '').trim();
      const m = label.match(/(Buy|Sell)\s+([A-Za-z0-9$]+)/i);
      if (m) { side = m[1].toUpperCase(); token = m[2].replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }
    }
    if (!token) token = DEFAULT_TOKEN;
    return { token, side: side === 'SELL' ? 'SELL' : 'BUY' };
  }

  // ══════════ 4. 缓存 ══════════
  const HOLDERS = new Map();       // token → Map(hex → balance)
  const LISTED  = new Map();       // token → Map(hex → 挂单剩余)
  const FETCHED = new Map();       // token → timestamp

  async function fetchHolders(token, force) {
    const assetId = ASSETS[token];
    if (!assetId) return;
    const key = 'H:' + token;
    if (!force && Date.now() - (FETCHED.get(key) || 0) < HOLDER_MS && HOLDERS.has(token)) return;
    const m = new Map();
    for (let p = 1; p <= 40; p++) {
      const d = await api('/assets/api/getHolders', { assetId, owner: '', page: p, count: 100 });
      const arr = (d && d.data && d.data.data) || [];
      if (!arr.length) break;
      for (const h of arr) if (h.owner) m.set(h.owner.toLowerCase(), h.balance || 0);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (m.size) { HOLDERS.set(token, m); FETCHED.set(key, Date.now()); }
  }

  async function fetchOrders(token, side, force) {
    const key = 'O:' + token + side;
    if (!force && Date.now() - (FETCHED.get(key) || 0) < ORDER_MS && LISTED.has(key)) return;
    const agg = new Map();
    for (let p = 1; p <= 30; p++) {
      const d = await api('/market/api/orderListing', { token, type: side, page: p, count: 100 });
      const list = (d && d.data && d.data.orderPOS) || [];
      for (const o of list) {
        const k = (o.owner || '').toLowerCase();
        agg.set(k, (agg.get(k) || 0) + ((o.volume || 0) - (o.deal_volume || 0)));
      }
      if (list.length < 100) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    LISTED.set(key, agg); FETCHED.set(key, Date.now());
  }

  // ══════════ 5. 样式 ══════════
  GM_addStyle(`
    .lnfi-hold{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:9px;
      font:11px/1.6 Menlo,Consolas,monospace;font-weight:700;white-space:nowrap;
      background:#1a2440;color:#8fb8ff;border:1px solid #2a3a66;vertical-align:middle}
    .lnfi-hold .lst{opacity:.55;font-weight:400;margin-left:3px}
    .lnfi-hold.big{background:#123a24;color:#7dfba8;border-color:#1f6b3e}
    .lnfi-hold.huge{background:#3a1220;color:#ff8fa8;border-color:#8a2340}
    .lnfi-hold.zero{background:#2a2a2a;color:#9aa4b2;border-color:#4a4a4a;opacity:.85}
    #lnfi-bar{position:fixed;left:12px;bottom:12px;z-index:999999;
      background:#0b1220ee;color:#dbe8fa;border:1px solid #26364f;border-radius:8px;
      padding:8px 12px;font:12px/1.6 Menlo,Consolas,monospace;backdrop-filter:blur(6px)}
    #lnfi-bar b{color:#8ef0a0} #lnfi-bar .muted{color:#7d8ba3}
  `);

  // ══════════ 6. 找页面上的 npub 元素（关键修正！）══════════
  // 实测结构： TD.ant-table-cell > DIV.trade-item-value > SPAN.ant-typography > (文本 + BUTTON)
  function findNpubNodes() {
    const out = [];
    const RE = /^(npub1[A-Za-z0-9]*\.\.\.([A-Za-z0-9]+))$/;

    // 主：Ant Design 的文本组件（有 Copy 按钮子元素，不能要求是叶子节点）
    document.querySelectorAll('span.ant-typography, .trade-item-value, td').forEach((el) => {
      if (el.querySelector('span.ant-typography, .trade-item-value')) return;  // 跳过父级
      const t = (el.textContent || '').trim();
      const m = t.match(RE);
      if (m) out.push({ el, txt: m[1], suffix: m[2] });
    });

    // 回退：遍历文本节点（其他版本/其他组件）
    if (!out.length) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || '').trim();
        const m = t.match(RE);
        if (m && n.parentElement) out.push({ el: n.parentElement, txt: m[1], suffix: m[2] });
      }
    }
    return out;
  }

  // ══════════ 7. 注入 ══════════
  let CURRENT = { token: DEFAULT_TOKEN, side: 'BUY' };

  function inject() {
    if (!isTargetPage()) { cleanup(); return 0; }   // 非挂单页：清理并退出
    const { token, side } = CURRENT;
    const holders = HOLDERS.get(token);
    const listed = LISTED.get('O:' + token + side);
    if (!holders && !listed) return 0;

    // npub 后缀 → hex 索引
    const bySuffix = new Map();
    const addAll = (map) => { if (!map) return; for (const k of map.keys()) {
      const n = hexToNpub(k); if (n) bySuffix.set(n.slice(-4), k); } };
    addAll(listed); addAll(holders);

    let done = 0;
    for (const { el, suffix } of findNpubNodes()) {
      const hex = bySuffix.get(suffix);
      if (!hex) continue;
      const balRaw = holders ? holders.get(hex) : undefined;
      const bal = (balRaw === undefined) ? 0 : balRaw;      // 持仓 0 也显示
      const lst = (listed && listed.get(hex)) || 0;

      const fp = suffix + '|' + Math.round(bal) + '|' + Math.round(lst);
      if (el.dataset.lnfiFp === fp) continue;
      // 移除旧的
      const old = el.parentNode && el.parentNode.querySelector(':scope > .lnfi-hold');
      if (old) old.remove();

      const badge = document.createElement('span');
      badge.className = 'lnfi-hold'
        + (bal === 0 ? ' zero' : bal >= 100000 ? ' huge' : bal >= 10000 ? ' big' : '');
      badge.innerHTML = `持仓 ${Math.round(bal).toLocaleString()}`;
      badge.title = `${token}\n该地址 Lnfi 记账持仓: ${Math.round(bal).toLocaleString()} 枚`
        + (bal === 0 ? '\n（余额为 0：币可能已转入 DEX Hub，或在闪电通道内）' : '');

      if (el.tagName === 'SPAN') el.insertAdjacentElement('afterend', badge);
      else el.appendChild(badge);
      el.dataset.lnfiFp = fp;
      done++;
    }
    return done;
  }

  // ══════════ 8. 汇总条 ══════════
  function renderBar() {
    if (!isTargetPage()) {                        // 非挂单页：不显示汇总条
      const b = document.getElementById('lnfi-bar');
      if (b) b.remove();
      return;
    }
    const { token, side } = CURRENT;
    const listed = LISTED.get('O:' + token + side) || new Map();
    const holders = HOLDERS.get(token) || new Map();
    let totL = 0, totB = 0, n = 0;
    for (const [hex, l] of listed) { totL += l; n++; const b = holders.get(hex); if (b) totB += b; }
    let el = document.getElementById('lnfi-bar');
    if (!el) { el = document.createElement('div'); el.id = 'lnfi-bar'; document.body.appendChild(el); }
    el.innerHTML = `📊 <b>${token}</b> ${side} 挂单剩余 <b>${Math.round(totL).toLocaleString()}</b> 枚
      <span class="muted">|</span> 挂单地址 ${n} 个（持仓合计 <b>${Math.round(totB).toLocaleString()}</b> 枚）
      <span class="muted">|</span> 全网持仓地址 ${holders.size}
      <span class="muted">|</span> ${new Date().toLocaleTimeString()}`;
  }

  // ══════════ 9. 主流程 ══════════
  let busy = false;
  async function refresh(forceAll) {
    if (!isTargetPage()) { cleanup(); return; }     // 非挂单页：清理 + 不拉数据
    if (busy) return; busy = true;
    try {
      CURRENT = detectContext();
      await fetchOrders(CURRENT.token, CURRENT.side, forceAll);
      await fetchHolders(CURRENT.token, forceAll || !HOLDERS.has(CURRENT.token));
      renderBar();
      const n = inject();
      console.log('[Lnfi] injected', n, CURRENT);
    } finally { busy = false; }
  }

  setTimeout(() => refresh(true), 1200);
  setInterval(() => refresh(false), ORDER_MS);

  // 页面重渲染补注入（仅目标页）
  let queued = false;
  const mo = new MutationObserver(() => {
    if (!isTargetPage() || queued) return;
    queued = true;
    setTimeout(() => { queued = false; inject(); }, 350);
  });
  setTimeout(() => mo.observe(document.body, { childList: true, subtree: true }), 1800);

  // hash 变化 / 切币 / 切买卖：重新拉数据；离开目标页则清理
  let lastHash = location.hash;
  let lastOn = isTargetPage();
  setInterval(() => {
    const on = isTargetPage();
    const ctx = detectContext();

    if (location.hash !== lastHash) {
      lastHash = location.hash;
      if (on) setTimeout(() => refresh(true), 800);   // 进入挂单页
      else { cleanup(); lastOn = false; }             // 离开 → 清理
      return;
    }
    // 切币 / 切买卖方向
    if (on && (ctx.token !== CURRENT.token || ctx.side !== CURRENT.side)) {
      setTimeout(() => refresh(true), 800);
    }
    lastOn = on;
  }, 900);
})();
