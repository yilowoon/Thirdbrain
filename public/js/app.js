/* ThirdBrain — 세종시 12대 섹터 진단·공약 네트워크
 *
 * 바깥 고리에 진단(문제, ●), 안쪽 고리에 공약(해법, ■)을 놓고
 * "어느 공약이 어느 진단을 해소하는가"를 선으로 잇는다.
 * 공약이 하나도 닿지 않은 진단은 붉게 남는다 — 그것이 공약 공백 지점이다.
 * 모든 노드는 섹터 → 대영역 → 시 라는 수렴축을 따라 하나의 핵심점으로 모인다.
 */
'use strict';

const SEV_W = { low: 1, mid: 3, high: 7, critical: 14 };
const STATUS_ORDER = ['good', 'warning', 'serious', 'critical'];

const state = {
  raw: null,
  nodes: [], links: [],
  byId: new Map(),
  sim: null,
  focus: null,
  view: 'all',              // all | gap | conflict
  hiddenStatus: new Set(),
  hiddenLinkTypes: new Set(),
  hiddenKinds: new Set(),
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

/* ─────────────────────────────────────────────────────────────
   1. 모델
   ───────────────────────────────────────────────────────────── */

function kpiRatio(k) {
  const t = +k.target, c = +k.current;
  if (!Number.isFinite(t) || !Number.isFinite(c) || t === 0) return 0;
  return k.dir === 'down' ? (c === 0 ? 1 : t / c) : c / t;
}

/** 신호 부하 — 심각도 가중 × 건수의 로그. 한 건의 대규모 청원이 전체를 압도하지 않게 한다. */
function signalLoad(signals) {
  return signals.reduce(
    (sum, s) => sum + (SEV_W[s.severity] || 1) * (1 + Math.log10(1 + (s.count || 1))), 0);
}

/** 진단 상태 = 공약 대응 여부 × 시민 신호.
 *  공약이 하나도 겨냥하지 않은 진단이 곧 '미대응'이고, 화면에서 붉게 남는다.
 *  공약이 있는데도 위기·고심각 신호가 쌓인 지점은 '현장 압력'으로 따로 표시한다 —
 *  대응을 했는데도 현장이 풀리지 않는 곳이라 성격이 다르기 때문이다. */
function diagnosisStatus(coverage, signals) {
  if (coverage === 0) return 'critical';

  const nCrit = signals.filter((s) => s.severity === 'critical').length;
  const nHigh = signals.filter((s) => s.severity === 'high').length;
  if (nCrit >= 1 || nHigh >= 2) return 'serious';

  return coverage === 1 ? 'warning' : 'good';
}

/** 하위 노드 상태를 비중 가중 평균해 상위(섹터·영역) 상태를 낸다. */
function rollUpStatus(children) {
  const withStatus = children.filter((c) => c.status);
  if (!withStatus.length) return 'good';
  const wSum = withStatus.reduce((a, c) => a + (c.weight || 5), 0);
  const score = withStatus.reduce(
    (a, c) => a + STATUS_ORDER.indexOf(c.status) * (c.weight || 5), 0) / wSum;
  const nCrit = withStatus.filter((c) => c.status === 'critical').length;
  let i = Math.round(score);
  if (nCrit >= 3) i = Math.max(i, 3);
  else if (nCrit >= 1) i = Math.max(i, 2);
  return STATUS_ORDER[Math.min(3, i)];
}

const RADII = { domain: 165, sector: 330, pledge: 470, diagnosis: 660 };
const rad = (deg) => (deg - 90) * Math.PI / 180;

/** 같은 섹터에 속한 노드를 섹터 방위각 주변 부채꼴에 고르게 앉힌다. */
function seatAngle(baseAngle, seat, total, maxSpread) {
  if (total <= 1) return baseAngle;
  const spread = Math.min(maxSpread, 5 + total * 2.6);
  return baseAngle + (seat - (total - 1) / 2) * (spread / (total - 1));
}

function buildModel(raw) {
  const { taxonomy, diagnoses, pledges, links, signals } = raw;

  const sigByDiag = new Map();
  for (const s of signals) {
    for (const t of s.targets || []) {
      if (!sigByDiag.has(t)) sigByDiag.set(t, []);
      sigByDiag.get(t).push(s);
    }
  }

  // 공약 → 진단 (resolves) 을 양방향 색인해 둔다
  const pledgesByDiag = new Map();
  const crossDeg = new Map();
  for (const p of pledges) {
    for (const d of p.resolves || []) {
      if (!pledgesByDiag.has(d)) pledgesByDiag.set(d, []);
      pledgesByDiag.get(d).push(p.id);
    }
  }
  for (const l of links) {
    crossDeg.set(l.source, (crossDeg.get(l.source) || 0) + 1);
    crossDeg.set(l.target, (crossDeg.get(l.target) || 0) + 1);
  }

  const domainById = new Map(taxonomy.domains.map((d) => [d.id, d]));
  const sectorById = new Map(taxonomy.sectors.map((s) => [s.id, s]));

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
      tx: Math.cos(rad(d.angle)) * RADII.domain,
      ty: Math.sin(rad(d.angle)) * RADII.domain,
    });
  }

  for (const s of taxonomy.sectors) {
    nodes.push({
      id: s.id, level: 'sector', no: s.no, label: s.label, color: s.color,
      domain: s.domain, angle: s.angle,
      tx: Math.cos(rad(s.angle)) * RADII.sector,
      ty: Math.sin(rad(s.angle)) * RADII.sector,
    });
  }

  // ── 공약 (안쪽 고리)
  const plSeat = new Map();
  const plTotal = new Map();
  for (const p of pledges) plTotal.set(p.sector, (plTotal.get(p.sector) || 0) + 1);

  for (const p of pledges) {
    const sec = sectorById.get(p.sector);
    if (!sec) continue;
    const seat = plSeat.get(p.sector) || 0;
    plSeat.set(p.sector, seat + 1);
    const a = seatAngle(sec.angle, seat, plTotal.get(p.sector), 22);
    const tx = Math.cos(rad(a)) * RADII.pledge;
    const ty = Math.sin(rad(a)) * RADII.pledge;
    const deg = crossDeg.get(p.id) || 0;
    nodes.push({
      ...p,
      level: 'pledge', kind: 'pledge',
      color: sec.color, domain: sec.domain, sectorLabel: sec.label,
      crossDeg: deg,
      resolveCount: (p.resolves || []).length,
      signals: [],
      status: null,                       // 실행 데이터가 없으므로 상태를 단정하지 않는다
      r: Math.max(8, Math.min(24,
        7 + 1.3 * Math.sqrt(p.weight || 5) + 1.7 * Math.sqrt((p.resolves || []).length) + 0.9 * Math.sqrt(deg))),
      tx, ty, x: tx + (Math.random() - 0.5) * 30, y: ty + (Math.random() - 0.5) * 30,
    });
  }

  // ── 진단 (바깥 고리)
  const dgSeat = new Map();
  const dgTotal = new Map();
  for (const d of diagnoses) dgTotal.set(d.sector, (dgTotal.get(d.sector) || 0) + 1);

  for (const d of diagnoses) {
    const sec = sectorById.get(d.sector);
    if (!sec) continue;
    const seat = dgSeat.get(d.sector) || 0;
    dgSeat.set(d.sector, seat + 1);
    const a = seatAngle(sec.angle, seat, dgTotal.get(d.sector), 26);
    const tx = Math.cos(rad(a)) * RADII.diagnosis;
    const ty = Math.sin(rad(a)) * RADII.diagnosis;

    const sigs = sigByDiag.get(d.id) || [];
    const load = signalLoad(sigs);
    const cover = pledgesByDiag.get(d.id) || [];
    nodes.push({
      ...d,
      level: 'diagnosis', kind: 'diagnosis',
      color: sec.color, domain: sec.domain, sectorLabel: sec.label,
      signals: sigs, signalLoad: load,
      coveredBy: cover, coverage: cover.length,
      status: diagnosisStatus(cover.length, sigs),
      r: Math.max(7, Math.min(24,
        6 + 1.1 * Math.sqrt(d.weight || 5) + 5.2 * Math.log10(1 + load) + 1.0 * Math.sqrt(cover.length))),
      tx, ty, x: tx + (Math.random() - 0.5) * 30, y: ty + (Math.random() - 0.5) * 30,
    });
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // ── 상향 집계
  for (const s of nodes.filter((n) => n.level === 'sector')) {
    const diags = nodes.filter((n) => n.level === 'diagnosis' && n.sector === s.id);
    const pls = nodes.filter((n) => n.level === 'pledge' && n.sector === s.id);
    s.diagnoses = diags;
    s.pledges = pls;
    s.status = rollUpStatus(diags);
    s.signalLoad = diags.reduce((a, k) => a + k.signalLoad, 0);
    s.signals = [...new Set(diags.flatMap((k) => k.signals))];
    s.uncovered = diags.filter((k) => k.coverage === 0).length;
    s.coverage = diags.length ? 1 - s.uncovered / diags.length : 0;
    s.r = Math.max(14, Math.min(30,
      13 + 1.5 * Math.sqrt(diags.length + pls.length) + 3.0 * Math.log10(1 + s.signalLoad)));
  }
  for (const d of nodes.filter((n) => n.level === 'domain')) {
    const kids = nodes.filter((n) => n.level === 'sector' && n.domain === d.id);
    d.children = kids;
    d.status = rollUpStatus(kids.map((k) => ({ status: k.status, weight: k.diagnoses.length })));
    d.signalLoad = kids.reduce((a, k) => a + k.signalLoad, 0);
    d.diagCount = kids.reduce((a, k) => a + k.diagnoses.length, 0);
    d.pledgeCount = kids.reduce((a, k) => a + k.pledges.length, 0);
    d.uncovered = kids.reduce((a, k) => a + k.uncovered, 0);
    d.r = Math.max(20, Math.min(34, 19 + 3.4 * Math.log10(1 + d.signalLoad)));
  }
  const city = byId.get(taxonomy.city.id);
  city.children = nodes.filter((n) => n.level === 'domain');
  city.status = rollUpStatus(city.children.map((k) => ({ status: k.status, weight: k.diagCount })));
  city.diagCount = city.children.reduce((a, k) => a + k.diagCount, 0);
  city.pledgeCount = city.children.reduce((a, k) => a + k.pledgeCount, 0);
  city.uncovered = city.children.reduce((a, k) => a + k.uncovered, 0);

  // ── 링크
  const gLinks = [];
  for (const n of nodes) {
    if (n.level === 'diagnosis' || n.level === 'pledge')
      gLinks.push({ source: n.id, target: n.sector, type: 'converge', weight: 1 });
    else if (n.level === 'sector') gLinks.push({ source: n.id, target: n.domain, type: 'converge', weight: 1 });
    else if (n.level === 'domain') gLinks.push({ source: n.id, target: city.id, type: 'converge', weight: 1 });
  }
  for (const p of pledges) {
    for (const d of p.resolves || []) {
      if (byId.has(d)) gLinks.push({ source: p.id, target: d, type: 'resolves', weight: 0.8 });
    }
  }
  for (const l of links) {
    if (byId.has(l.source) && byId.has(l.target)) gLinks.push({ ...l });
  }

  return { nodes, links: gLinks, byId, sectorById, domainById };
}

/* ─────────────────────────────────────────────────────────────
   2. 시각 규칙
   ───────────────────────────────────────────────────────────── */

const statusMeta = () => Object.fromEntries(state.raw.taxonomy.status.map((s) => [s.id, s]));

function nodeFill(n) {
  const st = statusMeta();
  if (n.status === 'critical') return st.critical.color;
  if (n.status === 'serious') return st.serious.color;
  return n.color;
}

const isAlerting = (n) => n.status === 'critical' || n.status === 'serious';

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
    .scaleExtent([0.2, 4])
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
  const strong = (n) =>
    n.level === 'domain' ? 0.55 : n.level === 'sector' ? 0.42 : 0.11;

  state.sim = d3.forceSimulation(state.nodes)
    .force('link', d3.forceLink(state.links).id((d) => d.id)
      .distance((l) => {
        if (l.type === 'converge') {
          const lv = l.source.level || '';
          return lv === 'diagnosis' ? 330 : lv === 'pledge' ? 145 : lv === 'sector' ? 165 : 175;
        }
        return l.type === 'resolves' ? 175 : 190;
      })
      .strength((l) => {
        if (l.type === 'converge') return l.source.level === 'sector' ? 0.6 : 0.16;
        return l.type === 'resolves' ? 0.05 : 0.035 * (l.weight || 0.5);
      }))
    .force('charge', d3.forceManyBody().strength((n) =>
      n.level === 'diagnosis' ? -190
        : n.level === 'pledge' ? -260
        : n.level === 'sector' ? -900 : -1600).distanceMax(700))
    .force('collide', d3.forceCollide().radius((n) => n.r + 6).iterations(2))
    .force('x', d3.forceX((n) => (n.tx ?? 0)).strength(strong))
    .force('y', d3.forceY((n) => (n.ty ?? 0)).strength(strong))
    .alpha(1).alphaDecay(0.017);
}

function render() {
  const st = statusMeta();

  const linkSel = gLink.selectAll('line')
    .data(state.links, (l) => `${l.source.id ?? l.source}|${l.target.id ?? l.target}|${l.type}`);
  linkSel.exit().remove();
  linkSel.enter().append('line')
    .attr('class', (l) => `link link-${l.type}`)
    .attr('stroke-width', (l) => {
      if (l.type === 'converge') {
        const lv = l.source.level || '';
        return lv === 'domain' ? 2.4 : lv === 'sector' ? 1.6 : 0.8;
      }
      return l.type === 'resolves' ? 1.4 : 1 + 2 * (l.weight || 0.5);
    })
    .attr('stroke-opacity', (l) => (l.type === 'converge' ? 0.45 : l.type === 'resolves' ? 0.5 : 0.8));

  const nodeSel = gNode.selectAll('g.node').data(state.nodes, (n) => n.id);
  nodeSel.exit().remove();

  const enter = nodeSel.enter().append('g')
    .attr('class', (n) => `node node-${n.level}`)
    .call(d3.drag()
      .on('start', (ev, n) => {
        if (!ev.active) state.sim.alphaTarget(0.2).restart();
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

  enter.append('circle').attr('class', 'pulse');
  enter.append('circle').attr('class', 'shape-circle node-shape');
  enter.append('rect').attr('class', 'shape-rect node-shape');
  enter.append('text').attr('class', 'status-glyph');
  enter.append('text').attr('class', 'node-label');

  const all = enter.merge(nodeSel);
  const isPledge = (n) => n.level === 'pledge';

  all.select('circle.pulse')
    .attr('r', (n) => n.r + 2)
    .style('display', (n) => (n.status === 'critical' ? null : 'none'));

  all.select('circle.shape-circle')
    .style('display', (n) => (isPledge(n) ? 'none' : null))
    .attr('r', (n) => n.r)
    .attr('fill', nodeFill)
    .attr('stroke', (n) => (isAlerting(n) ? st[n.status].color : 'var(--page)'))
    .attr('stroke-width', (n) => (isAlerting(n) ? 2 : 1.5));

  // 공약은 사각형 — 색을 못 보는 상황에서도 진단과 구분된다
  all.select('rect.shape-rect')
    .style('display', (n) => (isPledge(n) ? null : 'none'))
    .attr('width', (n) => n.r * 1.75).attr('height', (n) => n.r * 1.75)
    .attr('x', (n) => -n.r * 0.875).attr('y', (n) => -n.r * 0.875)
    .attr('rx', 4)
    .attr('fill', nodeFill)
    .attr('stroke', 'var(--page)').attr('stroke-width', 1.5);

  all.select('text.status-glyph')
    .attr('y', 0.5)
    .attr('fill', (n) => (n.status === 'warning' ? '#241c00' : '#2a0808'))
    .style('display', (n) =>
      (n.status && n.status !== 'good' && !isPledge(n)) ? null : 'none')
    .style('font-size', (n) => Math.min(11, Math.max(7, n.r * 0.7)) + 'px')
    .text((n) => (n.status ? st[n.status].icon : ''));

  all.select('text.node-label')
    .attr('class', (n) =>
      'node-label' + (n.level === 'city' ? ' node-label-xl'
        : n.level === 'domain' ? ' node-label-lg'
        : n.level === 'sector' ? ' node-label-md' : ''))
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

function applyVisibility() {
  const q = state.query.trim().toLowerCase();

  const matchesQuery = (n) => {
    if (!q) return true;
    return [n.label, n.detail, n.sectorLabel]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  };

  const isLeaf = (n) => n.level === 'diagnosis' || n.level === 'pledge';

  const inView = (n) => {
    if (!isLeaf(n)) return true;
    if (state.hiddenKinds.has(n.kind)) return false;
    if (state.view === 'gap') return n.level === 'diagnosis' && n.coverage === 0;
    if (state.view === 'conflict') {
      return state.links.some((l) =>
        l.type === 'conflict' && (l.source.id === n.id || l.target.id === n.id));
    }
    return true;
  };

  const passStatus = (n) => !n.status || !state.hiddenStatus.has(n.status);

  const visible = new Set();
  for (const n of state.nodes) {
    const ok = isLeaf(n) ? (inView(n) && passStatus(n) && matchesQuery(n)) : true;
    if (ok) visible.add(n.id);
  }

  let near = null;
  if (state.focus) {
    near = new Set([state.focus]);
    for (const l of state.links) {
      if (state.hiddenLinkTypes.has(l.type)) continue;
      if (l.source.id === state.focus) near.add(l.target.id);
      if (l.target.id === state.focus) near.add(l.source.id);
    }
    let cur = state.byId.get(state.focus);
    while (cur) {
      const up = isLeaf(cur) ? cur.sector
        : cur.level === 'sector' ? cur.domain
        : cur.level === 'domain' ? state.raw.taxonomy.city.id : null;
      if (!up) break;
      near.add(up);
      cur = state.byId.get(up);
    }
  }

  gNode.selectAll('g.node')
    .classed('dim', (n) => !visible.has(n.id) || (near && !near.has(n.id)));

  gLink.selectAll('line').classed('dim', (l) => {
    if (state.hiddenLinkTypes.has(l.type)) return true;
    if (!visible.has(l.source.id) || !visible.has(l.target.id)) return true;
    if (state.view === 'conflict' && l.type === 'converge') return true;
    if (near) return !(near.has(l.source.id) && near.has(l.target.id));
    return false;
  });
}

function applyLabelVisibility() {
  const k = state.transform.k;
  gNode.selectAll('text.node-label').style('display', (n) => {
    if (n.level === 'city' || n.level === 'domain') return null;
    if (n.level === 'sector') return k >= 0.5 ? null : 'none';
    if (state.focus === n.id) return null;
    if (k >= 1.6) return null;
    if (k >= 1.05 && n.r >= 13) return null;
    return n.status === 'critical' && n.r >= 13 ? null : 'none';
  });
}

/* ─────────────────────────────────────────────────────────────
   4. 툴팁 · 초점
   ───────────────────────────────────────────────────────────── */

function showTooltip(ev, n) {
  const st = statusMeta();
  const out = [`<div class="tt-title">${esc(n.label)}</div>`];

  const meta = n.level === 'diagnosis' ? `${n.sectorLabel} · 진단 ${n.no}`
    : n.level === 'pledge' ? `${n.sectorLabel} · 공약${n.round ? ` · ${n.round}차 발표` : ''}`
    : n.level === 'sector' ? `${n.diagnoses.length}개 진단 · ${n.pledges.length}개 공약`
    : n.level === 'domain' ? `${n.children.length}개 섹터 · 진단 ${n.diagCount} · 공약 ${n.pledgeCount}`
    : `12개 섹터 · 진단 ${n.diagCount} · 공약 ${n.pledgeCount}`;
  out.push(`<div class="tt-meta">${esc(meta)}</div>`);

  if (n.detail) out.push(`<div class="tt-detail">${esc(n.detail)}</div>`);

  if (n.status) {
    out.push(`<div class="tt-row"><span>상태</span><b style="color:${st[n.status].color}">${st[n.status].icon} ${st[n.status].label}</b></div>`);
  }
  if (n.level === 'diagnosis') {
    out.push(`<div class="tt-row"><span>연결된 공약</span><b>${n.coverage}건</b></div>`);
    if (n.signals.length) out.push(`<div class="tt-row"><span>시민 신호</span><b>${n.signals.length}건</b></div>`);
  }
  if (n.level === 'pledge') {
    out.push(`<div class="tt-row"><span>해소 대상 진단</span><b>${n.resolveCount}건</b></div>`);
    if (n.crossDeg) out.push(`<div class="tt-row"><span>공약 간 연결</span><b>${n.crossDeg}건</b></div>`);
  }
  if (n.level === 'sector' || n.level === 'domain' || n.level === 'city') {
    out.push(`<div class="tt-row"><span>미대응 진단</span><b style="color:${n.uncovered ? st.critical.color : st.good.color}">${n.uncovered}건</b></div>`);
  }

  tooltipEl.innerHTML = out.join('');
  tooltipEl.hidden = false;
  moveTooltip(ev);
}

function moveTooltip(ev) {
  const wrap = $('.canvas-wrap').getBoundingClientRect();
  const x = ev.clientX - wrap.left, y = ev.clientY - wrap.top;
  const w = tooltipEl.offsetWidth, h = tooltipEl.offsetHeight;
  tooltipEl.style.left = Math.max(8, Math.min(x + 16, wrap.width - w - 8)) + 'px';
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
  const st = statusMeta();
  const diag = state.nodes.filter((n) => n.level === 'diagnosis');
  const pled = state.nodes.filter((n) => n.level === 'pledge');
  const uncovered = diag.filter((d) => d.coverage === 0).length;
  const pressure = diag.filter((d) => d.status === 'serious').length;
  const cover = ((1 - uncovered / diag.length) * 100).toFixed(0);
  const cross = state.links.filter((l) => !['converge', 'resolves'].includes(l.type)).length;

  const items = [
    ['진단 항목', fmt(diag.length), '개'],
    ['공약 과제', fmt(pled.length), '개'],
    ['대응 커버리지', cover, '%'],
    ['미대응 진단', `<span style="color:${uncovered ? st.critical.color : st.good.color}">${uncovered}</span>`, '개'],
    ['현장 압력 지점', `<span style="color:${st.serious.color}">${pressure}</span>`, '개'],
    ['시민 신호', fmt(state.raw.signals.length), '건'],

  ];
  $('#stat-row').innerHTML = items.map(([k, v, u]) =>
    `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">${v}<small>${u}</small></div></div>`).join('');
}

function renderSectorList() {
  const st = statusMeta();
  const sectors = state.nodes.filter((n) => n.level === 'sector')
    .slice().sort((a, b) => a.no - b.no);
  $('#sector-list').innerHTML = sectors.map((s) => {
    const un = s.uncovered;
    const flag = un
      ? `<span style="color:${st.critical.color}">■ ${un}</span>`
      : `<span style="color:${st.good.color}">● 0</span>`;
    return `<button class="sector-row" data-id="${s.id}">
      <span class="sector-bar" style="background:${s.color}"></span>
      <span>
        <span class="sector-name">${s.no}. ${esc(s.label)}</span>
        <span class="sector-sub">진단 ${s.diagnoses.length} · 공약 ${s.pledges.length}</span>
      </span>
      <span class="sector-metric">
        <span class="sector-count">${(s.coverage * 100).toFixed(0)}%</span>
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
  $('#filter-kind').innerHTML = state.raw.taxonomy.nodeKinds.map((k) =>
    `<button class="chip is-on" data-kind="${k.id}">
       <span class="chip-shape chip-${k.id}"></span>${esc(k.label)}
     </button>`).join('');
  $$('#filter-kind .chip').forEach((el) =>
    el.addEventListener('click', () => {
      const id = el.dataset.kind;
      state.hiddenKinds.has(id) ? state.hiddenKinds.delete(id) : state.hiddenKinds.add(id);
      el.classList.toggle('is-on', !state.hiddenKinds.has(id));
      applyVisibility();
    }));

  $('#filter-status').innerHTML = state.raw.taxonomy.status.map((s) =>
    `<button class="chip is-on" data-status="${s.id}" title="${esc(s.desc || '')}">
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
    ['resolves', '해소', '#8fa8bd', 'solid'],
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
    <div class="legend-group">
      <h4>노드 종류 (모양)</h4>
      <div class="legend-cols">
        <div class="legend-item"><span class="legend-swatch legend-circle"></span>진단(문제)</div>
        <div class="legend-item"><span class="legend-swatch legend-square"></span>공약(해법)</div>
      </div>
    </div>
    <div class="legend-cols">
      <div class="legend-group">
        <h4>정책 영역</h4>
        ${tx.domains.map((d) =>
          `<div class="legend-item"><span class="legend-swatch" style="background:${d.color}"></span>${esc(d.label)}</div>`).join('')}
      </div>
      <div class="legend-group">
        <h4>진단 상태</h4>
        ${tx.status.map((s) =>
          `<div class="legend-item"><span class="legend-swatch" style="background:${s.color}"></span>${s.icon} ${esc(s.label)}</div>`).join('')}
      </div>
    </div>
    <div class="legend-group">
      <h4>관계</h4>
      <div class="legend-cols">
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px solid #8fa8bd"></span>해소</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px solid #5a9c86"></span>시너지</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dashed #6f8bb5"></span>선후의존</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dotted #c76a52"></span>상충</div>
      </div>
    </div>
    <p class="legend-note">크기 = 비중 + 연결 수 + 시민 신호량. 공약이 닿지 않은 진단은 붉게 남는다.</p>`;
}

function renderDetail(n) {
  if (!n) return;
  const st = statusMeta();
  const box = $('#detail-body');
  $('#detail-empty').hidden = true;
  box.hidden = false;

  const kindTag = n.level === 'diagnosis' ? '진단' : n.level === 'pledge' ? '공약' : null;
  const sub = n.level === 'diagnosis' ? `${n.sectorLabel} · ${n.no}번 진단`
    : n.level === 'pledge' ? `${n.sectorLabel}${n.round ? ` · ${n.round}차 브리핑` : ''}`
    : n.level === 'sector' ? `진단 ${n.diagnoses.length} · 공약 ${n.pledges.length} · 미대응 ${n.uncovered}`
    : n.level === 'domain' ? `${n.children.length}개 섹터 · 진단 ${n.diagCount} · 공약 ${n.pledgeCount}`
    : `12개 섹터가 수렴하는 최상위 지점`;

  const parts = [];
  parts.push(`<div class="d-head">
      <span class="d-dot ${n.level === 'pledge' ? 'is-square' : ''}" style="background:${nodeFill(n)}"></span>
      <span class="d-title">${esc(n.label)}${kindTag ? `<span class="d-kind">${kindTag}</span>` : ''}</span>
    </div>
    <div class="d-sub">${esc(sub)}</div>`);

  if (n.detail) parts.push(`<p class="d-detail">${esc(n.detail)}</p>`);

  if (n.status) {
    parts.push(`<div class="d-status" style="background:${st[n.status].color}22;color:${st[n.status].color};border:1px solid ${st[n.status].color}55">
      ${st[n.status].icon} ${st[n.status].label}</div>`);
  }

  // ── 진단: 대응 현황
  if (n.level === 'diagnosis') {
    const covered = n.coveredBy.map((id) => state.byId.get(id)).filter(Boolean);
    parts.push(`<div class="d-section"><h3>대응 공약 ${covered.length}</h3>${
      covered.length
        ? covered.map((p) => `<button class="lnk-item" data-goto="${p.id}">
            <span class="lnk-top"><span class="lnk-tag" style="color:#8fa8bd">${p.round ? p.round + '차' : '공약'}</span>
              <span>${esc(p.label)}</span></span>
            ${p.detail ? `<span class="lnk-note">${esc(p.detail)}</span>` : ''}
          </button>`).join('')
        : `<p class="empty-note gap-note">이 진단을 겨냥한 공약이 아직 없습니다 — <b>공약 공백 지점</b>입니다.</p>`
    }</div>`);
  }

  // ── 공약: 해소 대상 진단
  if (n.level === 'pledge') {
    const targets = (n.resolves || []).map((id) => state.byId.get(id)).filter(Boolean);
    parts.push(`<div class="d-section"><h3>해소 대상 진단 ${targets.length}</h3>${
      targets.map((d) => `<button class="lnk-item" data-goto="${d.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(d)}"></span>
          <span>${esc(d.label)}</span></span>
        <span class="lnk-note">${esc(d.sectorLabel)} · ${st[d.status].icon} ${st[d.status].label}${d.detail ? ' · ' + esc(d.detail) : ''}</span>
      </button>`).join('')
    }</div>`);

    if (n.kpi?.length) {
      parts.push(`<div class="d-section"><h3>목표 지표</h3>${n.kpi.map((k) => {
        const ratio = kpiRatio(k);
        return `<div class="kpi">
          <div class="kpi-top"><span>${esc(k.name)}</span>
            <span class="kpi-val">${fmt(k.current)}<span style="color:var(--ink-3)"> → ${fmt(k.target)}${esc(k.unit || '')}</span></span></div>
          <div class="bar" style="margin-top:5px"><div class="bar-fill" style="width:${Math.min(100, ratio * 100).toFixed(0)}%;background:${n.color}"></div></div>
          <div class="bar-cap"><span>현재</span><span>목표 대비 ${(ratio * 100).toFixed(0)}%</span></div>
        </div>`;
      }).join('')}</div>`);
    }
  }

  // ── 횡단 관계 (공약 ↔ 공약)
  const rel = state.links.filter((l) => ['synergy', 'dependency', 'conflict'].includes(l.type) &&
    (l.source.id === n.id || l.target.id === n.id));
  if (rel.length) {
    const tc = { synergy: '#5a9c86', dependency: '#6f8bb5', conflict: '#c76a52' };
    const tl = { synergy: '시너지', dependency: '선후의존', conflict: '상충' };
    parts.push(`<div class="d-section"><h3>공약 간 연결 ${rel.length}</h3>${rel
      .sort((a, b) => (b.weight || 0) - (a.weight || 0))
      .map((l) => {
        const other = l.source.id === n.id ? l.target : l.source;
        return `<button class="lnk-item" data-goto="${other.id}">
          <span class="lnk-top"><span class="lnk-tag" style="color:${tc[l.type]}">${tl[l.type]}</span>
            <span>${esc(other.label)}</span></span>
          ${l.note ? `<span class="lnk-note">${esc(l.note)}</span>` : ''}
        </button>`;
      }).join('')}</div>`);
  }

  // ── 시민 신호
  if (n.signals?.length) {
    const sc = { low: 'var(--ink-3)', mid: st.warning.color, high: st.serious.color, critical: st.critical.color };
    const sl = { low: '낮음', mid: '보통', high: '높음', critical: '위기' };
    parts.push(`<div class="d-section"><h3>연결된 시민 신호 ${n.signals.length}</h3>${n.signals
      .slice().sort((a, b) => (SEV_W[b.severity] || 0) - (SEV_W[a.severity] || 0))
      .map((s) => `<div class="sig-item">
        <div class="sig-top"><span class="sev-dot" style="background:${sc[s.severity]}"></span>
          <span>${esc(s.title)}</span></div>
        <div class="sig-meta">${esc(s.date)} · ${esc(s.channel)} · ${esc(s.type)} · 심각도 ${sl[s.severity]} · ${fmt(s.count)}건</div>
        ${s.summary ? `<div class="sig-sum">${esc(s.summary)}</div>` : ''}
      </div>`).join('')}</div>`);
  } else if (n.level === 'diagnosis') {
    parts.push(`<div class="d-section"><h3>연결된 시민 신호</h3>
      <p class="empty-note">접수된 신호가 없습니다.</p></div>`);
  }

  // ── 섹터 상세
  if (n.level === 'sector') {
    const un = n.diagnoses.filter((d) => d.coverage === 0);
    if (un.length) {
      parts.push(`<div class="d-section"><h3 class="h3-alert">공약 공백 ${un.length}</h3>${un
        .map((d) => `<button class="lnk-item is-gap" data-goto="${d.id}">
          <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(d)}"></span>
            <span>${d.no}. ${esc(d.label)}</span></span>
          ${d.detail ? `<span class="lnk-note">${esc(d.detail)}</span>` : ''}
        </button>`).join('')}</div>`);
    }
    parts.push(`<div class="d-section"><h3>공약 ${n.pledges.length}</h3>${n.pledges
      .map((p) => `<button class="lnk-item" data-goto="${p.id}">
        <span class="lnk-top"><span class="sev-dot is-square" style="background:${p.color}"></span>
          <span>${esc(p.label)}</span></span>
        <span class="lnk-note">${p.round ? p.round + '차 브리핑 · ' : ''}진단 ${p.resolveCount}건 해소</span>
      </button>`).join('')}</div>`);
    parts.push(`<div class="d-section"><h3>진단 전체 ${n.diagnoses.length}</h3>${n.diagnoses
      .map((d) => `<button class="lnk-item" data-goto="${d.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(d)}"></span>
          <span>${d.no}. ${esc(d.label)}</span></span>
        <span class="lnk-note">${st[d.status].icon} ${st[d.status].label} · 대응 공약 ${d.coverage}건</span>
      </button>`).join('')}</div>`);
  }

  if (n.level === 'domain' || n.level === 'city') {
    parts.push(`<div class="d-section"><h3>하위 ${n.level === 'city' ? '영역' : '섹터'} ${n.children.length}</h3>${n.children
      .map((c) => `<button class="lnk-item" data-goto="${c.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(c)}"></span>
          <span>${esc(c.label)}</span></span>
        <span class="lnk-note">${st[c.status].icon} ${st[c.status].label} · 미대응 ${c.uncovered}건</span>
      </button>`).join('')}</div>`);
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
  const pad = 80;
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
    const tag = document.activeElement.tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
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
    state.hiddenStatus.clear(); state.hiddenLinkTypes.clear(); state.hiddenKinds.clear();
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
   7. 시민 신호 입력
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
    chosen.clear();
    form.reset();
    $('#dlg-err').hidden = true;
    $('#target-results').hidden = true;
    const cur = state.byId.get(state.focus);
    if (cur?.level === 'diagnosis') chosen.set(cur.id, cur);
    drawChips();
    dlg.showModal();
  });

  const searchBox = $('#target-search');
  searchBox.addEventListener('input', () => {
    const q = searchBox.value.trim().toLowerCase();
    const box = $('#target-results');
    if (!q) { box.hidden = true; return; }
    const hits = state.nodes.filter((n) => n.level === 'diagnosis' &&
      [n.label, n.detail, n.sectorLabel].filter(Boolean)
        .some((v) => v.toLowerCase().includes(q))).slice(0, 20);
    box.innerHTML = hits.length
      ? hits.map((d) => `<button type="button" class="target-opt" data-add="${d.id}">
          ${esc(d.label)}<small>${esc(d.sectorLabel)}</small></button>`).join('')
      : '<div class="target-none">일치하는 진단이 없습니다.</div>';
    box.hidden = false;
    $$('[data-add]', box).forEach((b) => b.addEventListener('click', () => {
      const d = state.byId.get(b.dataset.add);
      chosen.set(d.id, d); drawChips();
      searchBox.value = ''; box.hidden = true;
    }));
  });

  form.addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    if (chosen.size === 0) {
      $('#dlg-err').textContent = '연결할 진단을 1개 이상 선택해 주세요.';
      $('#dlg-err').hidden = false;
      return;
    }
    const fd = new FormData(form);
    try {
      const res = await fetch('/api/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: fd.get('title'), type: fd.get('type'), channel: fd.get('channel'),
          severity: fd.get('severity'), count: fd.get('count'), summary: fd.get('summary'),
          targets: [...chosen.keys()],
        }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '저장에 실패했습니다.');
      const first = [...chosen.keys()][0];
      dlg.close();
      await reload();
      setFocus(first);
    } catch (err) {
      $('#dlg-err').textContent = err.message;
      $('#dlg-err').hidden = false;
    }
  });
}

/* ─────────────────────────────────────────────────────────────
   8. 부팅
   ───────────────────────────────────────────────────────────── */

async function reload() {
  const prev = new Map(state.nodes.map((n) => [n.id, { x: n.x, y: n.y, vx: n.vx, vy: n.vy }]));
  state.raw = await (await fetch('/api/graph')).json();
  Object.assign(state, buildModel(state.raw));
  for (const n of state.nodes) {
    const p = prev.get(n.id);
    if (p) Object.assign(n, p);
  }
  simulate();
  render();
  renderStats();
  renderSectorList();
  state.sim.alpha(0.3).restart();
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
  setTimeout(() => fitToScreen(700), 1600);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;color:#ffb4b4">불러오기 실패: ${esc(err.message)}</div>`);
});
