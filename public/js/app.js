/* ThirdBrain — 세종시 정책 네트워크
 * 점(정책) · 선(관계) · 수렴축(정책→섹터→대영역→시)을 하나의 힘-지향 그래프로 그린다.
 * 크기 = 정책 비중 + 연결도 + 시민 신호량 / 색상 = 4대 영역 / 붉은색 = 상태(위기) 전용.
 */
'use strict';

const SEV_W = { low: 1, mid: 3, high: 7, critical: 14 };
const STATUS_ORDER = ['good', 'warning', 'serious', 'critical'];

const state = {
  raw: null,
  nodes: [], links: [],
  byId: new Map(),
  sim: null,
  focus: null,          // 선택된 노드 id
  view: 'all',          // all | alert | conflict
  hiddenStatus: new Set(),
  hiddenLinkTypes: new Set(),
  query: '',
  zoom: null,
  transform: d3.zoomIdentity,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => new Intl.NumberFormat('ko-KR').format(n);

/** 원자료 단위는 백만원. 100백만원 = 1억원, 1,000,000백만원 = 1조원. */
function won(millionWon) {
  const eok = millionWon / 100;
  if (eok >= 10000) return `${(eok / 10000).toFixed(2)}조원`;
  if (eok >= 100) return `${fmt(Math.round(eok))}억원`;
  return `${(Math.round(eok * 10) / 10).toFixed(1)}억원`;
}

/* ─────────────────────────────────────────────────────────────
   1. 모델 — 원자료를 그래프로 변환하고 상태·크기를 계산한다
   ───────────────────────────────────────────────────────────── */

/** KPI 달성비. dir==='down' 이면 낮을수록 좋은 지표. */
function kpiRatio(k) {
  const t = +k.target, c = +k.current;
  if (!Number.isFinite(t) || !Number.isFinite(c) || t === 0) return 1;
  return k.dir === 'down' ? (c === 0 ? 1 : t / c) : c / t;
}

/** 신호 부하 — 심각도 가중 × 건수의 로그. 한 건의 대규모 청원이 전체를 압도하지 않게 한다. */
function signalLoad(signals) {
  return signals.reduce((sum, s) => sum + (SEV_W[s.severity] || 1) * (1 + Math.log10(1 + (s.count || 1))), 0);
}

/** 정책 상태 = 진척 격차 × KPI 달성 × 시민 신호 의 합성.
 *  '위기(붉은색)'는 단일 지표가 아니라 복합 실패일 때만 부여한다 —
 *  경보가 흔해지면 색이 의미를 잃기 때문이다. (현 데이터 기준 59건 중 5건) */
function policyStatus(p, signals) {
  const gap = (p.planned ?? p.progress) - p.progress;
  let i = gap <= 0.05 ? 0 : gap <= 0.12 ? 1 : 2;      // 진척 격차만으로는 '미비'까지

  const ratios = (p.kpi || []).map(kpiRatio);
  const kpiBad = ratios.length > 0 && Math.min(...ratios) < 0.60;

  const nCrit = signals.filter((s) => s.severity === 'critical').length;
  const nHigh = signals.filter((s) => s.severity === 'high').length;

  if (nHigh >= 1) i = Math.max(i, 1);
  if (nHigh >= 2 || nCrit >= 1) i = Math.max(i, 2);

  const compound =
    nCrit >= 2 ||                          // 위기 신호가 둘 이상
    (nCrit >= 1 && nHigh >= 1) ||          // 위기 + 고심각 신호가 겹침
    (nCrit >= 1 && i >= 2 && kpiBad) ||    // 위기 신호 + 지연 + 지표 미달
    (i >= 2 && kpiBad && gap > 0.20);      // 신호는 없어도 지연·지표가 동시에 무너짐
  if (compound) i = 3;

  return STATUS_ORDER[i];
}

/** 하위 노드 상태를 비중 가중 평균해 상위(섹터·영역) 상태를 낸다. */
function rollUpStatus(children) {
  if (!children.length) return 'good';
  const wSum = children.reduce((a, c) => a + (c.weight || 5), 0);
  const score = children.reduce(
    (a, c) => a + STATUS_ORDER.indexOf(c.status) * (c.weight || 5), 0) / wSum;
  const hasCrit = children.filter((c) => c.status === 'critical').length;
  let i = Math.round(score);
  if (hasCrit >= 2) i = Math.max(i, 3);
  else if (hasCrit >= 1) i = Math.max(i, 2);
  return STATUS_ORDER[Math.min(3, i)];
}

function buildModel(raw) {
  const { taxonomy, policies, links, signals } = raw;

  const sigByPolicy = new Map();
  for (const s of signals) {
    for (const t of s.targets || []) {
      if (!sigByPolicy.has(t)) sigByPolicy.set(t, []);
      sigByPolicy.get(t).push(s);
    }
  }

  const crossDeg = new Map();
  for (const l of links) {
    crossDeg.set(l.source, (crossDeg.get(l.source) || 0) + 1);
    crossDeg.set(l.target, (crossDeg.get(l.target) || 0) + 1);
  }

  const domainById = new Map(taxonomy.domains.map((d) => [d.id, d]));
  const sectorById = new Map(taxonomy.sectors.map((s) => [s.id, s]));

  // ── 목표 좌표: 시(중심) → 4영역(사분면) → 12섹터(영역 웨지 내 3분할)
  const R_DOMAIN = 165, R_SECTOR = 315;
  const rad = (deg) => (deg - 90) * Math.PI / 180;

  const nodes = [];

  nodes.push({
    id: taxonomy.city.id, level: 'city', label: taxonomy.city.label,
    sublabel: taxonomy.city.sublabel, color: '#ffffff', r: 30,
    tx: 0, ty: 0, fx: 0, fy: 0,
  });

  for (const d of taxonomy.domains) {
    nodes.push({
      id: d.id, level: 'domain', label: d.label, sublabel: d.en, color: d.color,
      angle: d.angle,
      tx: Math.cos(rad(d.angle)) * R_DOMAIN,
      ty: Math.sin(rad(d.angle)) * R_DOMAIN,
    });
  }

  const perDomain = new Map();
  for (const s of taxonomy.sectors) {
    const arr = perDomain.get(s.domain) || [];
    arr.push(s);
    perDomain.set(s.domain, arr);
  }
  for (const [dId, list] of perDomain) {
    const base = domainById.get(dId).angle;
    const spread = 30;
    list.forEach((s, i) => {
      const a = base + (i - (list.length - 1) / 2) * spread;
      nodes.push({
        id: s.id, level: 'sector', label: s.label, color: s.color,
        domain: dId, scope: s.scope, orgs: s.orgs, depts: s.depts,
        angle: a,
        tx: Math.cos(rad(a)) * R_SECTOR,
        ty: Math.sin(rad(a)) * R_SECTOR,
      });
    });
  }

  // 섹터의 목표좌표를 찾아 소속 정책을 그 바깥쪽 고리에 배치한다.
  // (이 좌표가 없으면 모든 정책이 원점으로 끌려가 하나의 덩어리가 된다)
  const sectorNode = new Map(nodes.filter((n) => n.level === 'sector').map((n) => [n.id, n]));
  const seatCount = new Map();
  for (const p of policies) seatCount.set(p.sector, (seatCount.get(p.sector) || 0) + 1);
  const seatUsed = new Map();

  const R_POLICY = 455;
  for (const p of policies) {
    const sec = sectorById.get(p.sector);
    if (!sec) continue;
    const sNode = sectorNode.get(p.sector);
    const total = seatCount.get(p.sector) || 1;
    const seat = seatUsed.get(p.sector) || 0;
    seatUsed.set(p.sector, seat + 1);
    // 섹터 방위각 주변으로 부채꼴 배치 — 섹터마다 고유한 영역을 갖게 한다
    const spread = Math.min(26, 8 + total * 3);
    const a = sNode.angle + (seat - (total - 1) / 2) * (spread / Math.max(1, total - 1 || 1));
    const tx = Math.cos(rad(a)) * R_POLICY;
    const ty = Math.sin(rad(a)) * R_POLICY;

    const sigs = sigByPolicy.get(p.id) || [];
    const load = signalLoad(sigs);
    const deg = crossDeg.get(p.id) || 0;
    const r = Math.max(7, Math.min(26,
      6 + 1.2 * Math.sqrt(p.weight || 5) + 5.5 * Math.log10(1 + load) + 0.9 * Math.sqrt(deg)));
    nodes.push({
      ...p,
      level: 'policy',
      color: sec.color,
      domain: sec.domain,
      sectorLabel: sec.label,
      signals: sigs,
      signalLoad: load,
      crossDeg: deg,
      status: policyStatus(p, sigs),
      r, tx, ty,
      x: tx + (Math.random() - 0.5) * 40,
      y: ty + (Math.random() - 0.5) * 40,
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ── 상향 집계: 섹터 → 영역
  for (const s of nodes.filter((n) => n.level === 'sector')) {
    const kids = nodes.filter((n) => n.level === 'policy' && n.sector === s.id);
    s.children = kids;
    s.status = rollUpStatus(kids);
    s.signalLoad = kids.reduce((a, k) => a + k.signalLoad, 0);
    s.budget = kids.reduce((a, k) => a + (k.budget || 0), 0);
    s.progress = kids.length ? kids.reduce((a, k) => a + k.progress, 0) / kids.length : 0;
    s.planned = kids.length ? kids.reduce((a, k) => a + (k.planned ?? k.progress), 0) / kids.length : 0;
    s.signals = [...new Set(kids.flatMap((k) => k.signals))];
    s.r = Math.max(13, Math.min(30, 12 + 1.7 * Math.sqrt(kids.length) + 3.4 * Math.log10(1 + s.signalLoad)));
  }
  for (const d of nodes.filter((n) => n.level === 'domain')) {
    const kids = nodes.filter((n) => n.level === 'sector' && n.domain === d.id);
    d.children = kids;
    d.status = rollUpStatus(kids.map((k) => ({ status: k.status, weight: k.children.length })));
    d.signalLoad = kids.reduce((a, k) => a + k.signalLoad, 0);
    d.budget = kids.reduce((a, k) => a + k.budget, 0);
    d.progress = kids.length ? kids.reduce((a, k) => a + k.progress, 0) / kids.length : 0;
    d.policyCount = kids.reduce((a, k) => a + k.children.length, 0);
    d.r = Math.max(19, Math.min(34, 18 + 3.6 * Math.log10(1 + d.signalLoad)));
  }
  const city = byId.get(taxonomy.city.id);
  city.children = nodes.filter((n) => n.level === 'domain');
  city.status = rollUpStatus(city.children.map((k) => ({ status: k.status, weight: k.policyCount })));
  city.budget = city.children.reduce((a, k) => a + k.budget, 0);

  // ── 링크: 수렴축(구조) + 횡단관계
  const gLinks = [];
  for (const n of nodes) {
    if (n.level === 'policy') gLinks.push({ source: n.id, target: n.sector, type: 'converge', weight: 1 });
    else if (n.level === 'sector') gLinks.push({ source: n.id, target: n.domain, type: 'converge', weight: 1 });
    else if (n.level === 'domain') gLinks.push({ source: n.id, target: city.id, type: 'converge', weight: 1 });
  }
  for (const l of links) {
    if (byId.has(l.source) && byId.has(l.target)) gLinks.push({ ...l });
  }

  return { nodes, links: gLinks, byId, sectorById, domainById, sigByPolicy };
}

/* ─────────────────────────────────────────────────────────────
   2. 시각 규칙
   ───────────────────────────────────────────────────────────── */

const statusMeta = () =>
  Object.fromEntries(state.raw.taxonomy.status.map((s) => [s.id, s]));

/** 상태가 serious/critical 이면 색을 상태색으로 덮는다. 그 외에는 영역색 유지. */
function nodeFill(n) {
  const st = statusMeta();
  if (n.status === 'critical') return st.critical.color;
  if (n.status === 'serious') return st.serious.color;
  return n.color;
}

function isAlerting(n) {
  return n.status === 'critical' || n.status === 'serious';
}

/* ─────────────────────────────────────────────────────────────
   3. 렌더링
   ───────────────────────────────────────────────────────────── */

const svg = d3.select('#graph');
let gRoot, gLink, gNode, tooltipEl;

function initCanvas() {
  svg.selectAll('*').remove();
  gRoot = svg.append('g').attr('class', 'root');
  gLink = gRoot.append('g').attr('class', 'links');
  gNode = gRoot.append('g').attr('class', 'nodes');
  tooltipEl = $('#tooltip');

  state.zoom = d3.zoom()
    .scaleExtent([0.25, 4])
    .on('zoom', (ev) => {
      state.transform = ev.transform;
      gRoot.attr('transform', ev.transform);
      applyLabelVisibility();
    });

  svg.call(state.zoom)
     .on('dblclick.zoom', null)
     .on('click', (ev) => { if (ev.target.tagName === 'svg') clearFocus(); });
}

function simulate() {
  // 위치력이 섹터 소속을 잡아주고, 횡단 연결은 그 위에서 노드를 끌어당긴다.
  // 두 힘의 균형이 곧 "어느 정책이 다른 영역에 붙들려 있는가"를 눈에 보이게 만든다.
  const strong = (n) => (n.level === 'domain' ? 0.55 : n.level === 'sector' ? 0.40 : 0.10);

  state.sim = d3.forceSimulation(state.nodes)
    .force('link', d3.forceLink(state.links).id((d) => d.id)
      .distance((l) => {
        if (l.type !== 'converge') return 150;
        const lv = (l.source.level || '');
        return lv === 'policy' ? 120 : lv === 'sector' ? 130 : 150;
      })
      .strength((l) => (l.type === 'converge'
        ? (l.source.level === 'policy' ? 0.25 : 0.6)
        : 0.05 * (l.weight || 0.5))))
    .force('charge', d3.forceManyBody().strength((n) =>
      n.level === 'policy' ? -230 : n.level === 'sector' ? -800 : -1500).distanceMax(650))
    .force('collide', d3.forceCollide().radius((n) => n.r + 7).iterations(2))
    .force('x', d3.forceX((n) => (n.tx ?? 0)).strength(strong))
    .force('y', d3.forceY((n) => (n.ty ?? 0)).strength(strong))
    .alpha(1).alphaDecay(0.018);
}

function render() {
  const st = statusMeta();

  // ── 링크
  const linkSel = gLink.selectAll('line')
    .data(state.links, (l) => `${l.source.id ?? l.source}|${l.target.id ?? l.target}|${l.type}`);
  linkSel.exit().remove();
  linkSel.enter().append('line')
    .attr('class', (l) => `link link-${l.type}`)
    .attr('stroke-width', (l) => (l.type === 'converge' ? (l.source.level === 'policy' ? 0.9 : l.source.level === 'sector' ? 1.6 : 2.4) : 1 + 2 * (l.weight || 0.5)))
    .attr('stroke-opacity', (l) => (l.type === 'converge' ? 0.5 : 0.75));

  // ── 노드
  const nodeSel = gNode.selectAll('g.node').data(state.nodes, (n) => n.id);
  nodeSel.exit().remove();

  const enter = nodeSel.enter().append('g')
    .attr('class', (n) => `node node-${n.level}`)
    .call(d3.drag()
      .on('start', (ev, n) => {
        if (!ev.active) state.sim.alphaTarget(0.25).restart();
        n.fx = n.x; n.fy = n.y;
      })
      .on('drag', (ev, n) => { n.fx = ev.x; n.fy = ev.y; })
      .on('end', (ev, n) => {
        if (!ev.active) state.sim.alphaTarget(0);
        if (n.level !== 'city') { n.fx = null; n.fy = null; }
      }))
    .on('click', (ev, n) => { ev.stopPropagation(); setFocus(n.id); })
    .on('pointerenter', (ev, n) => showTooltip(ev, n))
    .on('pointermove', (ev) => moveTooltip(ev))
    .on('pointerleave', hideTooltip);

  // 위기 노드의 맥동 링 — 색만으로 의미를 싣지 않도록 글리프와 병행한다
  enter.append('circle').attr('class', 'pulse');
  enter.append('circle').attr('class', 'node-shape');
  enter.append('text').attr('class', 'status-glyph');
  enter.append('text').attr('class', 'node-label');

  const all = enter.merge(nodeSel);

  all.select('circle.pulse')
    .attr('r', (n) => n.r + 2)
    .style('display', (n) => (n.status === 'critical' ? null : 'none'));

  all.select('circle.node-shape')
    .attr('r', (n) => n.r)
    .attr('fill', nodeFill)
    .attr('fill-opacity', (n) => (n.level === 'policy' ? 0.92 : 1))
    .attr('stroke', (n) => (isAlerting(n) ? st[n.status].color : 'var(--page)'))
    .attr('stroke-width', (n) => (isAlerting(n) ? 2 : 1.5));

  all.select('text.status-glyph')
    .attr('y', 0.5)
    .attr('fill', (n) => (n.status === 'warning' ? '#241c00' : '#2a0808'))
    .style('display', (n) => (isAlerting(n) || n.status === 'warning' ? null : 'none'))
    .style('font-size', (n) => Math.min(11, Math.max(7, n.r * 0.7)) + 'px')
    .text((n) => (n.status ? st[n.status].icon : ''));

  all.select('text.node-label')
    .attr('class', (n) =>
      'node-label' + (n.level === 'city' ? ' node-label-xl'
        : n.level === 'domain' ? ' node-label-lg' : ''))
    .attr('text-anchor', 'middle')
    .attr('y', (n) => n.r + 12)
    .text((n) => n.label);

  state.sim.on('tick', () => {
    gLink.selectAll('line')
      .attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
      .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
    all.attr('transform', (n) => `translate(${n.x},${n.y})`);
  });

  applyVisibility();
  applyLabelVisibility();
}

/** 뷰 모드·필터·검색을 한 번에 반영한다. */
function applyVisibility() {
  const q = state.query.trim().toLowerCase();

  const matchesQuery = (n) => {
    if (!q) return true;
    return [n.label, n.dept, n.sectorLabel, ...(n.tags || [])]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  };

  const passStatus = (n) => !state.hiddenStatus.has(n.status);

  const inView = (n) => {
    if (state.view === 'alert') return n.level !== 'policy' ? true : isAlerting(n);
    if (state.view === 'conflict') {
      if (n.level !== 'policy') return true;
      return state.links.some((l) =>
        l.type === 'conflict' && (l.source.id === n.id || l.target.id === n.id));
    }
    return true;
  };

  const visible = new Set();
  for (const n of state.nodes) {
    const ok = n.level === 'policy' ? (inView(n) && passStatus(n) && matchesQuery(n)) : inView(n);
    if (ok) visible.add(n.id);
  }

  // 초점: 선택 노드 + 1홉 이웃 + 수렴 상위축
  let near = null;
  if (state.focus) {
    near = new Set([state.focus]);
    for (const l of state.links) {
      if (state.hiddenLinkTypes.has(l.type)) continue;
      if (l.source.id === state.focus) near.add(l.target.id);
      if (l.target.id === state.focus) near.add(l.source.id);
    }
    // 수렴축을 시까지 따라 올라간다
    let cur = state.byId.get(state.focus);
    while (cur) {
      const up = cur.level === 'policy' ? cur.sector
        : cur.level === 'sector' ? cur.domain
        : cur.level === 'domain' ? state.raw.taxonomy.city.id : null;
      if (!up) break;
      near.add(up);
      cur = state.byId.get(up);
    }
  }

  gNode.selectAll('g.node')
    .classed('dim', (n) => !visible.has(n.id) || (near && !near.has(n.id)))
    .classed('dim-mid', (n) => !!near && near.has(n.id) && n.id !== state.focus && false);

  gLink.selectAll('line').classed('dim', (l) => {
    if (state.hiddenLinkTypes.has(l.type)) return true;
    if (!visible.has(l.source.id) || !visible.has(l.target.id)) return true;
    if (state.view === 'conflict' && l.type === 'converge') return true;
    if (near) return !(near.has(l.source.id) && near.has(l.target.id));
    return false;
  });
}

/** 라벨 밀도 조절 — 확대할수록 하위 라벨이 드러난다. */
function applyLabelVisibility() {
  const k = state.transform.k;
  gNode.selectAll('text.node-label').style('display', (n) => {
    if (n.level !== 'policy') return null;
    if (state.focus === n.id) return null;
    if (k >= 1.7) return null;
    if (k >= 1.15 && n.r >= 12) return null;
    return isAlerting(n) && n.r >= 14 ? null : 'none';
  });
}

/* ─────────────────────────────────────────────────────────────
   4. 툴팁 · 초점
   ───────────────────────────────────────────────────────────── */

function showTooltip(ev, n) {
  const st = statusMeta();
  const lines = [];
  lines.push(`<div class="tt-title">${esc(n.label)}</div>`);
  lines.push(`<div class="tt-meta">${esc(
    n.level === 'policy' ? `${n.sectorLabel} · ${n.dept || '—'}`
      : n.level === 'sector' ? (n.orgs || []).join(', ')
      : n.level === 'domain' ? `${n.children?.length || 0}개 섹터 · ${n.policyCount || 0}개 정책`
      : '12개 섹터 전체 수렴점')}</div>`);
  if (n.status) {
    lines.push(`<div class="tt-row"><span>상태</span><b style="color:${st[n.status].color}">${st[n.status].icon} ${st[n.status].label}</b></div>`);
  }
  if (Number.isFinite(n.progress)) {
    lines.push(`<div class="tt-row"><span>진척률</span><b>${(n.progress * 100).toFixed(0)}% <span style="color:var(--ink-3)">/ 계획 ${(n.planned * 100).toFixed(0)}%</span></b></div>`);
  }
  if (n.budget) lines.push(`<div class="tt-row"><span>사업비</span><b>${won(n.budget)}</b></div>`);
  if (n.signals?.length) lines.push(`<div class="tt-row"><span>연결된 시민 신호</span><b>${n.signals.length}건</b></div>`);
  if (n.level === 'policy') lines.push(`<div class="tt-row"><span>횡단 연결</span><b>${n.crossDeg}개</b></div>`);

  tooltipEl.innerHTML = lines.join('');
  tooltipEl.hidden = false;
  moveTooltip(ev);
}

function moveTooltip(ev) {
  const wrap = $('.canvas-wrap').getBoundingClientRect();
  const x = ev.clientX - wrap.left, y = ev.clientY - wrap.top;
  const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
  tooltipEl.style.left = Math.min(x + 16, wrap.width - w - 8) + 'px';
  tooltipEl.style.top = Math.max(8, Math.min(y + 16, wrap.height - h - 8)) + 'px';
}

const hideTooltip = () => { tooltipEl.hidden = true; };

function setFocus(id) {
  state.focus = id;
  applyVisibility();
  renderDetail(state.byId.get(id));
  $$('.sector-row').forEach((el) => el.classList.toggle('is-on', el.dataset.id === id));
}

function clearFocus() {
  state.focus = null;
  applyVisibility();
  $('#detail-empty').hidden = false;
  $('#detail-body').hidden = true;
  $$('.sector-row').forEach((el) => el.classList.remove('is-on'));
}

/* ─────────────────────────────────────────────────────────────
   5. 패널
   ───────────────────────────────────────────────────────────── */

function renderStats() {
  const pol = state.nodes.filter((n) => n.level === 'policy');
  const cross = state.links.filter((l) => l.type !== 'converge');
  const crit = pol.filter((n) => n.status === 'critical').length;
  const ser = pol.filter((n) => n.status === 'serious').length;
  const avg = pol.reduce((a, p) => a + p.progress, 0) / pol.length;
  const gap = pol.reduce((a, p) => a + ((p.planned ?? p.progress) - p.progress), 0) / pol.length;

  const st = statusMeta();
  const items = [
    ['정책 노드', fmt(pol.length), ''],
    ['횡단 연결', fmt(cross.length), '개'],
    ['시민 신호', fmt(state.raw.signals.length), '건'],
    ['평균 진척률', (avg * 100).toFixed(1), '%'],
    ['계획 대비 격차', (gap * 100).toFixed(1), '%p'],
    ['경보 정책', `<span style="color:${st.critical.color}">${crit}</span> / <span style="color:${st.serious.color}">${ser}</span>`, '위기/미비'],
  ];
  $('#stat-row').innerHTML = items.map(([k, v, u]) =>
    `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">${v}<small>${u}</small></div></div>`).join('');
}

function renderSectorList() {
  const st = statusMeta();
  const sectors = state.nodes.filter((n) => n.level === 'sector');
  $('#sector-list').innerHTML = sectors.map((s) => {
    const crit = s.children.filter((c) => c.status === 'critical').length;
    const ser = s.children.filter((c) => c.status === 'serious').length;
    const flag = crit || ser
      ? `<span style="color:${crit ? st.critical.color : st.serious.color}">${st[crit ? 'critical' : 'serious'].icon} ${crit || ser}</span>`
      : `<span style="color:var(--ink-3)">—</span>`;
    return `<button class="sector-row" data-id="${s.id}">
      <span class="sector-bar" style="background:${s.color}"></span>
      <span>
        <span class="sector-name">${esc(s.label)}</span>
        <span class="sector-sub">${esc((s.orgs || []).join(' · '))}</span>
      </span>
      <span class="sector-metric">
        <span class="sector-count">${s.children.length}</span>
        <span class="sector-flag">${flag}</span>
      </span>
    </button>`;
  }).join('');

  $$('.sector-row').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      state.focus === id ? clearFocus() : setFocus(id);
    }));
}

function renderFilters() {
  const st = state.raw.taxonomy.status;
  $('#filter-status').innerHTML = st.map((s) =>
    `<button class="chip is-on" data-status="${s.id}">
       <span class="chip-dot" style="background:${s.color}"></span>${esc(s.label)}
     </button>`).join('');
  $$('#filter-status .chip').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.status;
      state.hiddenStatus.has(id) ? state.hiddenStatus.delete(id) : state.hiddenStatus.add(id);
      el.classList.toggle('is-on', !state.hiddenStatus.has(id));
      applyVisibility();
    }));

  const lt = [
    ['synergy', '시너지', '#5a9c86', 'solid'],
    ['dependency', '선후의존', '#6f8bb5', 'dashed'],
    ['conflict', '상충', '#c76a52', 'dotted'],
    ['converge', '수렴축', 'rgba(255,255,255,.35)', 'solid'],
  ];
  $('#filter-link').innerHTML = lt.map(([id, label, color, style]) =>
    `<button class="chip is-on" data-link="${id}">
       <span class="chip-line" style="border-top-color:${color};border-top-style:${style}"></span>${label}
     </button>`).join('');
  $$('#filter-link .chip').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.link;
      state.hiddenLinkTypes.has(id) ? state.hiddenLinkTypes.delete(id) : state.hiddenLinkTypes.add(id);
      el.classList.toggle('is-on', !state.hiddenLinkTypes.has(id));
      applyVisibility();
    }));
}

function renderLegend() {
  const tx = state.raw.taxonomy;
  $('#legend-body').innerHTML = `
    <div class="legend-cols">
      <div class="legend-group">
        <h4>정책 영역</h4>
        ${tx.domains.map((d) =>
          `<div class="legend-item"><span class="legend-swatch" style="background:${d.color}"></span>${esc(d.label)}</div>`).join('')}
      </div>
      <div class="legend-group">
        <h4>상태</h4>
        ${tx.status.map((s) =>
          `<div class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.icon} ${esc(s.label)}</div>`).join('')}
      </div>
    </div>
    <div class="legend-group">
      <h4>관계</h4>
      <div class="legend-cols">
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px solid #5a9c86"></span>시너지</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dashed #6f8bb5"></span>선후의존</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dotted #c76a52"></span>상충</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:1px solid rgba(255,255,255,.35)"></span>수렴축</div>
      </div>
    </div>
    <p class="legend-note">크기 = 비중 + 연결 수 + 시민 신호량. 위기는 색·기호·맥동으로 함께 표시.</p>`;
}

function renderDetail(n) {
  if (!n) return;
  const st = statusMeta();
  const box = $('#detail-body');
  $('#detail-empty').hidden = true;
  box.hidden = false;

  const sub = n.level === 'policy' ? `${n.sectorLabel} · ${n.dept || '—'}`
    : n.level === 'sector' ? `${(n.orgs || []).join(' · ')} · ${(n.depts || []).length}개 과`
    : n.level === 'domain' ? `${n.children.length}개 섹터 · ${n.policyCount}개 정책`
    : '12개 섹터가 수렴하는 최상위 지점';

  const parts = [];

  parts.push(`<div class="d-head">
      <span class="d-dot" style="background:${nodeFill(n)}"></span>
      <span class="d-title">${esc(n.label)}</span>
    </div>
    <div class="d-sub">${esc(sub)}</div>`);

  if (n.status) {
    parts.push(`<div class="d-status" style="background:${st[n.status].color}22;color:${st[n.status].color};border:1px solid ${st[n.status].color}55">
      ${st[n.status].icon} ${st[n.status].label}</div>`);
  }

  // 진척
  if (Number.isFinite(n.progress)) {
    const pct = n.progress * 100, plan = (n.planned ?? n.progress) * 100;
    const behind = plan - pct;
    parts.push(`<div class="d-section">
      <h3>추진 현황</h3>
      <div class="bar">
        <div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${nodeFill(n)}"></div>
        <div class="bar-tick" style="left:${plan.toFixed(1)}%" title="계획 진척률"></div>
      </div>
      <div class="bar-cap">
        <span>실적 ${pct.toFixed(0)}%</span>
        <span style="color:${behind > 10 ? st.critical.color : behind > 3 ? st.warning.color : 'var(--ink-3)'}">
          계획 ${plan.toFixed(0)}% · 격차 ${behind >= 0 ? '−' : '+'}${Math.abs(behind).toFixed(0)}%p</span>
      </div>
    </div>`);
  }

  // 기본 지표
  const kv = [];
  if (n.budget) kv.push(['사업비', won(n.budget)]);
  if (n.start) kv.push(['기간', `${n.start} ~ ${n.end || '계속'}`]);
  if (n.level === 'policy') {
    kv.push(['정책 비중', `${n.weight} / 10`]);
    kv.push(['횡단 연결', `${n.crossDeg}개`]);
    kv.push(['신호 부하', n.signalLoad.toFixed(1)]);
  }
  if (kv.length) {
    parts.push(`<div class="d-section"><h3>지표</h3>
      <dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>`);
  }

  // KPI
  if (n.kpi?.length) {
    parts.push(`<div class="d-section"><h3>핵심 성과지표</h3>${n.kpi.map((k) => {
      const ratio = kpiRatio(k);
      const c = ratio >= 0.9 ? st.good.color : ratio >= 0.75 ? st.warning.color
        : ratio >= 0.6 ? st.serious.color : st.critical.color;
      return `<div class="kpi">
        <div class="kpi-top"><span>${esc(k.name)}</span>
          <span class="kpi-val" style="color:${c}">${fmt(k.current)}<span style="color:var(--ink-3)"> / ${fmt(k.target)}${esc(k.unit || '')}</span></span></div>
        <div class="bar" style="margin-top:5px"><div class="bar-fill" style="width:${Math.min(100, ratio * 100).toFixed(0)}%;background:${c}"></div></div>
      </div>`;
    }).join('')}</div>`);
  }

  // 연결된 정책
  const rel = state.links.filter((l) => l.type !== 'converge' &&
    (l.source.id === n.id || l.target.id === n.id));
  if (rel.length) {
    const typeColor = { synergy: '#5a9c86', dependency: '#6f8bb5', conflict: '#c76a52' };
    const typeLabel = { synergy: '시너지', dependency: '선후의존', conflict: '상충' };
    parts.push(`<div class="d-section"><h3>연결된 정책 ${rel.length}</h3>${rel
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .map((l) => {
        const other = l.source.id === n.id ? l.target : l.source;
        return `<button class="lnk-item" data-goto="${other.id}">
          <span class="lnk-top">
            <span class="lnk-tag" style="color:${typeColor[l.type]}">${typeLabel[l.type]}</span>
            <span>${esc(other.label)}</span>
          </span>
          ${l.note ? `<span class="lnk-note">${esc(l.note)}</span>` : ''}
        </button>`;
      }).join('')}</div>`);
  }

  // 시민 신호
  if (n.signals?.length) {
    const sevColor = { low: 'var(--ink-3)', mid: st.warning.color, high: st.serious.color, critical: st.critical.color };
    const sevLabel = { low: '낮음', mid: '보통', high: '높음', critical: '위기' };
    parts.push(`<div class="d-section"><h3>연결된 시민 신호 ${n.signals.length}</h3>${n.signals
      .slice().sort((a, b) => (SEV_W[b.severity] || 0) - (SEV_W[a.severity] || 0))
      .map((s) => `<div class="sig-item">
        <div class="sig-top"><span class="sev-dot" style="background:${sevColor[s.severity]}"></span>
          <span>${esc(s.title)}</span></div>
        <div class="sig-meta">${esc(s.date)} · ${esc(s.channel)} · ${esc(s.type)} · 심각도 ${sevLabel[s.severity]} · ${fmt(s.count)}건</div>
        ${s.summary ? `<div class="sig-sum">${esc(s.summary)}</div>` : ''}
      </div>`).join('')}</div>`);
  } else if (n.level === 'policy') {
    parts.push(`<div class="d-section"><h3>연결된 시민 신호</h3>
      <p class="empty-note">접수된 신호가 없습니다.</p></div>`);
  }

  // 섹터: 소속 정책 목록
  if (n.level === 'sector') {
    parts.push(`<div class="d-section"><h3>소속 정책 ${n.children.length}</h3>${n.children
      .slice().sort((a, b) => STATUS_ORDER.indexOf(b.status) - STATUS_ORDER.indexOf(a.status))
      .map((c) => `<button class="lnk-item" data-goto="${c.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(c)}"></span>
          <span>${esc(c.label)}</span></span>
        <span class="lnk-note">${st[c.status].icon} ${st[c.status].label} · 진척 ${(c.progress * 100).toFixed(0)}% · ${esc(c.dept)}</span>
      </button>`).join('')}</div>`);
    parts.push(`<div class="d-section"><h3>소관 부서</h3>
      <div class="tags">${(n.depts || []).map((d) => `<span class="tag">${esc(d)}</span>`).join('')}</div></div>`);
  }

  if (n.level === 'domain' || n.level === 'city') {
    parts.push(`<div class="d-section"><h3>하위 ${n.level === 'city' ? '영역' : '섹터'} ${n.children.length}</h3>${n.children
      .map((c) => `<button class="lnk-item" data-goto="${c.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(c)}"></span>
          <span>${esc(c.label)}</span></span>
        <span class="lnk-note">${st[c.status].icon} ${st[c.status].label}</span>
      </button>`).join('')}</div>`);
  }

  if (n.tags?.length) {
    parts.push(`<div class="d-section"><h3>태그</h3>
      <div class="tags">${n.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div></div>`);
  }

  box.innerHTML = parts.join('');
  $$('[data-goto]', box).forEach((el) =>
    el.addEventListener('click', () => setFocus(el.dataset.goto)));
}

/* ─────────────────────────────────────────────────────────────
   6. 화면 맞춤 · 컨트롤
   ───────────────────────────────────────────────────────────── */

function fitToScreen(ms = 600) {
  const rect = svg.node().getBoundingClientRect();
  const xs = state.nodes.map((n) => n.x).filter(Number.isFinite);
  const ys = state.nodes.map((n) => n.y).filter(Number.isFinite);
  if (xs.length < 2 || rect.width < 10 || rect.height < 10) return;
  const pad = 70;
  const [x0, x1] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
  const [y0, y1] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
  const k = Math.min(rect.width / (x1 - x0), rect.height / (y1 - y0), 1.6);
  if (!Number.isFinite(k) || k <= 0) return;
  const t = d3.zoomIdentity
    .translate(rect.width / 2, rect.height / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
  svg.transition().duration(ms).call(state.zoom.transform, t);
}

function bindControls() {
  $('#search').addEventListener('input', (e) => {
    state.query = e.target.value;
    applyVisibility();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT'
      && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault(); $('#search').focus();
    }
    if (e.key === 'Escape' && !$('#dlg-signal').open) clearFocus();
  });

  $$('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
    $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b === btn));
    state.view = btn.dataset.view;
    applyVisibility();
  }));

  $('#btn-reset').addEventListener('click', () => {
    clearFocus();
    state.query = ''; $('#search').value = '';
    state.view = 'all';
    $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === 'all'));
    state.hiddenStatus.clear(); state.hiddenLinkTypes.clear();
    $$('.chip').forEach((c) => c.classList.add('is-on'));
    applyVisibility();
    fitToScreen();
  });

  $$('.zoom-ctl button').forEach((b) => b.addEventListener('click', () => {
    const mode = b.dataset.zoom;
    if (mode === 'fit') return fitToScreen();
    svg.transition().duration(220).call(state.zoom.scaleBy, mode === 'in' ? 1.4 : 1 / 1.4);
  }));

  const legend = $('#legend');
  $('#legend-toggle').addEventListener('click', () => {
    const open = legend.dataset.open !== 'false';
    legend.dataset.open = String(!open);
    $('#legend-toggle').setAttribute('aria-expanded', String(!open));
  });

  window.addEventListener('resize', () => fitToScreen(0));
}

/* ─────────────────────────────────────────────────────────────
   7. 신호 입력
   ───────────────────────────────────────────────────────────── */

function bindSignalDialog() {
  const dlg = $('#dlg-signal');
  const form = $('#form-signal');
  const chosen = new Map();

  const drawChips = () => {
    $('#target-chips').innerHTML = [...chosen.values()].map((p) =>
      `<span class="target-chip">${esc(p.label)}
        <button type="button" data-rm="${p.id}" aria-label="제거">×</button></span>`).join('');
    $$('#target-chips [data-rm]').forEach((b) =>
      b.addEventListener('click', () => { chosen.delete(b.dataset.rm); drawChips(); }));
  };

  $('#btn-add').addEventListener('click', () => {
    chosen.clear(); drawChips();
    form.reset();
    $('#dlg-err').hidden = true;
    $('#target-results').hidden = true;
    // 현재 선택된 정책이 있으면 기본 연결 대상으로 채워준다
    const cur = state.byId.get(state.focus);
    if (cur?.level === 'policy') { chosen.set(cur.id, cur); drawChips(); }
    dlg.showModal();
  });

  const searchBox = $('#target-search');
  searchBox.addEventListener('input', () => {
    const q = searchBox.value.trim().toLowerCase();
    const box = $('#target-results');
    if (!q) { box.hidden = true; return; }
    const hits = state.nodes.filter((n) => n.level === 'policy' &&
      [n.label, n.dept, n.sectorLabel].filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))).slice(0, 20);
    box.innerHTML = hits.length
      ? hits.map((p) => `<button type="button" class="target-opt" data-add="${p.id}">
          ${esc(p.label)}<small>${esc(p.sectorLabel)} · ${esc(p.dept || '')}</small></button>`).join('')
      : '<div style="padding:9px 10px;color:var(--ink-3);font-size:12px">일치하는 정책이 없습니다.</div>';
    box.hidden = false;
    $$('[data-add]', box).forEach((b) => b.addEventListener('click', () => {
      const p = state.byId.get(b.dataset.add);
      chosen.set(p.id, p); drawChips();
      searchBox.value = ''; box.hidden = true;
    }));
  });

  form.addEventListener('submit', async (e) => {
    const btn = e.submitter;
    if (btn && btn.value === 'cancel') return;          // 취소는 그대로 닫힘
    if (chosen.size === 0) {
      e.preventDefault();
      $('#dlg-err').textContent = '연결할 정책을 1개 이상 선택해 주세요.';
      $('#dlg-err').hidden = false;
      return;
    }
    e.preventDefault();
    const fd = new FormData(form);
    const payload = {
      title: fd.get('title'),
      type: fd.get('type'),
      channel: fd.get('channel'),
      severity: fd.get('severity'),
      count: fd.get('count'),
      summary: fd.get('summary'),
      targets: [...chosen.keys()],
    };
    try {
      const res = await fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '저장에 실패했습니다.');
      dlg.close();
      const firstTarget = payload.targets[0];
      await reload();
      setFocus(firstTarget);
    } catch (err) {
      $('#dlg-err').textContent = err.message;
      $('#dlg-err').hidden = false;
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   8. 부팅
   ───────────────────────────────────────────────────────────── */

/** 현재 좌표를 유지한 채 데이터만 다시 반영한다 (신호 추가 후 재계산용). */
async function reload() {
  const prev = new Map(state.nodes.map((n) => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));
  state.raw = await (await fetch('/api/graph')).json();
  const model = buildModel(state.raw);
  Object.assign(state, model);
  for (const n of state.nodes) {
    const p = prev.get(n.id);
    if (p) Object.assign(n, p);
  }
  simulate();
  render();
  renderStats();
  renderSectorList();
  state.sim.alpha(0.35).restart();
}

async function boot() {
  state.raw = await (await fetch('/api/graph')).json();
  Object.assign(state, buildModel(state.raw));

  initCanvas();
  simulate();
  render();
  renderStats();
  renderSectorList();
  renderFilters();
  renderLegend();
  bindControls();
  bindSignalDialog();

  state.sim.on('end', () => fitToScreen(500));
  setTimeout(() => fitToScreen(700), 1400);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;color:#ffb4b4">불러오기 실패: ${esc(err.message)}</div>`);
});
