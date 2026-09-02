/* ThirdBrain — 세종시 12대 섹터 진단·공약 네트워크
 *
 * 배치는 뇌(top view) 형태다.
 *   피질(바깥)  = 진단 97 — 문제는 표면에 드러난다
 *   백질(안쪽)  = 공약 54 — 해법은 안에서 연결한다
 *   좌반구 = 물적 기반(산업·기술·공간·환경·농업·안전)
 *   우반구 = 사람과 위상(행정수도·문화·국제화·교육·복지·보건)
 *   중심   = 세종시. 모든 축이 여기로 수렴한다.
 *
 * 노드를 선택하면 연결된 노드가 홉 거리 순으로 차례차례 점등된다(신경 발화).
 */
'use strict';

const SEV_W = { low: 1, mid: 3, high: 7, critical: 14 };
const STATUS_ORDER = ['good', 'warning', 'serious', 'critical'];
const REL_TYPES = new Set(['resolves', 'synergy', 'dependency', 'conflict']);

/** 대응 공약 수에 따른 위험 감쇄. 공약 하나가 위험을 다 없애지는 못한다. */
const DAMP = [0, 0.18, 0.30, 0.38];

const state = {
  raw: null,
  nodes: [], links: [],
  byId: new Map(),
  sim: null,
  focus: null,
  view: 'all',
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

/* ═════════════════════════════════════════════════════════════
   1. 뇌 형상 — 노드 배치와 외곽선이 같은 함수를 쓴다
   ═════════════════════════════════════════════════════════════ */

const BRAIN = { A: 470, B: 560, GAP: 30 };

/** s = -1(전두) … +1(후두) 에서의 반구 반폭. 뒤로 갈수록 좁아진다(후두엽). */
const halfWidth = (s) =>
  BRAIN.A * Math.sqrt(Math.max(0, 1 - s * s)) * (1 - 0.13 * s);

/** side: -1 좌반구 / +1 우반구, s: 앞뒤, d: 0=정중선 … 1=피질 경계 */
function brainPoint(side, s, d) {
  const w = Math.max(BRAIN.GAP + 8, halfWidth(s));
  return { x: side * (BRAIN.GAP + d * (w - BRAIN.GAP)), y: s * BRAIN.B };
}

const HEMISPHERE = {
  '-1': ['S02', 'S10', 'S01', 'S08', 'S09', 'S12'],
  '1':  ['S03', 'S04', 'S11', 'S05', 'S06', 'S07'],
};
const S_MIN = -0.84, S_MAX = 0.84;

/** 섹터별 앞뒤 구간을 계산해 둔다. */
function sectorSpans() {
  const map = new Map();
  for (const side of [-1, 1]) {
    const list = HEMISPHERE[String(side)];
    const w = (S_MAX - S_MIN) / list.length;
    list.forEach((id, k) => {
      map.set(id, { side, s0: S_MIN + k * w + w * 0.06, s1: S_MIN + (k + 1) * w - w * 0.06 });
    });
  }
  return map;
}

/* ═════════════════════════════════════════════════════════════
   2. 모델 — 정밀 진단(4축 평가) → 잔여위험 → 상태
   ═════════════════════════════════════════════════════════════ */

function kpiRatio(k) {
  const t = +k.target, c = +k.current;
  if (!Number.isFinite(t) || !Number.isFinite(c) || t === 0) return 0;
  return k.dir === 'down' ? (c === 0 ? 1 : t / c) : c / t;
}

/** 심각도 가중 × 건수의 로그. 한 건의 대규모 청원이 전체를 압도하지 않게 한다. */
function signalLoad(signals) {
  return signals.reduce(
    (sum, s) => sum + (SEV_W[s.severity] || 1) * (1 + Math.log10(1 + (s.count || 1))), 0);
}

/** 잔여위험 = 구조적 심각도 × (1 − 대응 감쇄) + 현장 신호 가산.
 *  "얼마나 심각한가"가 아니라 "대응을 감안하고도 얼마나 남아 있는가"를 본다. */
function residualRisk(severity, coverage, load) {
  const damp = DAMP[Math.min(DAMP.length - 1, coverage)];
  return Math.min(100, (severity || 50) * (1 - damp) + Math.min(12, load * 0.6));
}

const riskStatus = (r) =>
  r >= 72 ? 'critical' : r >= 58 ? 'serious' : r >= 44 ? 'warning' : 'good';

function rollUpStatus(children) {
  const ws = children.filter((c) => c.status);
  if (!ws.length) return 'good';
  const wSum = ws.reduce((a, c) => a + (c.weight || 5), 0);
  const score = ws.reduce(
    (a, c) => a + STATUS_ORDER.indexOf(c.status) * (c.weight || 5), 0) / wSum;
  const nCrit = ws.filter((c) => c.status === 'critical').length;
  let i = Math.round(score);
  if (nCrit >= 3) i = Math.max(i, 3);
  else if (nCrit >= 1) i = Math.max(i, 2);
  return STATUS_ORDER[Math.min(3, i)];
}

function buildModel(raw) {
  const { taxonomy, diagnoses, pledges, links, signals } = raw;
  const spans = sectorSpans();

  const sigByDiag = new Map();
  for (const s of signals) {
    for (const t of s.targets || []) {
      if (!sigByDiag.has(t)) sigByDiag.set(t, []);
      sigByDiag.get(t).push(s);
    }
  }

  const pledgesByDiag = new Map();
  for (const p of pledges) {
    for (const d of p.resolves || []) {
      if (!pledgesByDiag.has(d)) pledgesByDiag.set(d, []);
      pledgesByDiag.get(d).push(p.id);
    }
  }
  const crossDeg = new Map();
  for (const l of links) {
    crossDeg.set(l.source, (crossDeg.get(l.source) || 0) + 1);
    crossDeg.set(l.target, (crossDeg.get(l.target) || 0) + 1);
  }

  const sectorById = new Map(taxonomy.sectors.map((s) => [s.id, s]));
  const nodes = [];

  nodes.push({
    id: taxonomy.city.id, level: 'city', label: taxonomy.city.label,
    sublabel: taxonomy.city.sublabel, color: '#ffffff', r: 28,
    tx: 0, ty: 0, fx: 0, fy: 0,
  });

  // ── 섹터 (피질과 백질 사이)
  for (const s of taxonomy.sectors) {
    const sp = spans.get(s.id);
    const p = brainPoint(sp.side, (sp.s0 + sp.s1) / 2, 0.62);
    nodes.push({
      id: s.id, level: 'sector', no: s.no, label: s.label, color: s.color,
      domain: s.domain, side: sp.side, span: sp,
      tx: p.x, ty: p.y, x: p.x, y: p.y,
    });
  }

  // ── 공약 (백질 — 안쪽)
  const plBySector = new Map();
  for (const p of pledges) {
    if (!plBySector.has(p.sector)) plBySector.set(p.sector, []);
    plBySector.get(p.sector).push(p);
  }
  for (const [sid, list] of plBySector) {
    const sp = spans.get(sid);
    const sec = sectorById.get(sid);
    if (!sp || !sec) continue;
    list.forEach((p, j) => {
      const s = sp.s0 + ((j + 0.5) / list.length) * (sp.s1 - sp.s0);
      const d = 0.30 + 0.17 * (j % 3) / 2;
      const pt = brainPoint(sp.side, s, d);
      const deg = crossDeg.get(p.id) || 0;
      nodes.push({
        ...p,
        level: 'pledge', kind: 'pledge',
        color: sec.color, domain: sec.domain, sectorLabel: sec.label, side: sp.side,
        crossDeg: deg, resolveCount: (p.resolves || []).length,
        signals: [], status: null,
        r: Math.max(8, Math.min(23,
          7 + 1.3 * Math.sqrt(p.weight || 5) + 1.7 * Math.sqrt((p.resolves || []).length) + 0.9 * Math.sqrt(deg))),
        tx: pt.x, ty: pt.y, x: pt.x, y: pt.y,
      });
    });
  }

  // ── 진단 (피질 — 바깥 표면)
  const dgBySector = new Map();
  for (const d of diagnoses) {
    if (!dgBySector.has(d.sector)) dgBySector.set(d.sector, []);
    dgBySector.get(d.sector).push(d);
  }
  for (const [sid, list] of dgBySector) {
    const sp = spans.get(sid);
    const sec = sectorById.get(sid);
    if (!sp || !sec) continue;
    list.forEach((d, i) => {
      const s = sp.s0 + ((i + 0.5) / list.length) * (sp.s1 - sp.s0);
      const depth = 0.78 + 0.15 * ((i % 3) / 2);
      const pt = brainPoint(sp.side, s, depth);

      const sigs = sigByDiag.get(d.id) || [];
      const load = signalLoad(sigs);
      const cover = pledgesByDiag.get(d.id) || [];
      const risk = residualRisk(d.severity, cover.length, load);
      nodes.push({
        ...d,
        level: 'diagnosis', kind: 'diagnosis',
        color: sec.color, domain: sec.domain, sectorLabel: sec.label, side: sp.side,
        signals: sigs, signalLoad: load,
        coveredBy: cover, coverage: cover.length,
        risk, status: riskStatus(risk),
        r: Math.max(7, Math.min(25,
          6 + 0.10 * risk + 3.0 * Math.log10(1 + load) + 0.8 * Math.sqrt(cover.length))),
        tx: pt.x, ty: pt.y, x: pt.x, y: pt.y,
      });
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
    s.risk = diags.length ? diags.reduce((a, k) => a + k.risk, 0) / diags.length : 0;
    s.severity = diags.length ? diags.reduce((a, k) => a + (k.severity || 0), 0) / diags.length : 0;
    s.signalLoad = diags.reduce((a, k) => a + k.signalLoad, 0);
    s.signals = [...new Set(diags.flatMap((k) => k.signals))];
    s.uncovered = diags.filter((k) => k.coverage === 0).length;
    s.atRisk = diags.filter((k) => k.status === 'critical').length;
    s.coverage = diags.length ? 1 - s.uncovered / diags.length : 0;
    s.r = Math.max(14, Math.min(28, 12 + 0.13 * s.risk));
  }

  // 영역 노드는 소속 섹터의 무게중심을 중심 쪽으로 당겨 배치한다(뇌량 부근)
  for (const d of nodes.filter((n) => n.level === 'domain' || false)) { /* noop */ }
  for (const dom of taxonomy.domains) {
    const kids = nodes.filter((n) => n.level === 'sector' && n.domain === dom.id);
    const cx = kids.reduce((a, k) => a + k.tx, 0) / kids.length;
    const cy = kids.reduce((a, k) => a + k.ty, 0) / kids.length;
    nodes.push({
      id: dom.id, level: 'domain', label: dom.label, sublabel: dom.en, color: dom.color,
      children: kids,
      status: rollUpStatus(kids.map((k) => ({ status: k.status, weight: k.diagnoses.length }))),
      risk: kids.reduce((a, k) => a + k.risk, 0) / kids.length,
      diagCount: kids.reduce((a, k) => a + k.diagnoses.length, 0),
      pledgeCount: kids.reduce((a, k) => a + k.pledges.length, 0),
      uncovered: kids.reduce((a, k) => a + k.uncovered, 0),
      atRisk: kids.reduce((a, k) => a + k.atRisk, 0),
      signalLoad: kids.reduce((a, k) => a + k.signalLoad, 0),
      r: 21,
      tx: cx * 0.36, ty: cy * 0.42, x: cx * 0.36, y: cy * 0.42,
    });
  }
  const byId2 = new Map(nodes.map((n) => [n.id, n]));
  for (const s of nodes.filter((n) => n.level === 'sector')) s.domainNode = byId2.get(s.domain);

  const city = byId2.get(taxonomy.city.id);
  city.children = nodes.filter((n) => n.level === 'domain');
  city.status = rollUpStatus(city.children.map((k) => ({ status: k.status, weight: k.diagCount })));
  city.risk = city.children.reduce((a, k) => a + k.risk, 0) / city.children.length;
  city.diagCount = city.children.reduce((a, k) => a + k.diagCount, 0);
  city.pledgeCount = city.children.reduce((a, k) => a + k.pledgeCount, 0);
  city.uncovered = city.children.reduce((a, k) => a + k.uncovered, 0);
  city.atRisk = city.children.reduce((a, k) => a + k.atRisk, 0);

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
      if (byId2.has(d)) gLinks.push({ source: p.id, target: d, type: 'resolves', weight: 0.8 });
    }
  }
  for (const l of links) {
    if (byId2.has(l.source) && byId2.has(l.target)) gLinks.push({ ...l });
  }

  return { nodes, links: gLinks, byId: byId2, sectorById };
}

/* ═════════════════════════════════════════════════════════════
   3. 시각 규칙
   ═════════════════════════════════════════════════════════════ */

const statusMeta = () => Object.fromEntries(state.raw.taxonomy.status.map((s) => [s.id, s]));

function nodeFill(n) {
  const st = statusMeta();
  if (n.status === 'critical') return st.critical.color;
  if (n.status === 'serious') return st.serious.color;
  return n.color;
}
const isAlerting = (n) => n.status === 'critical' || n.status === 'serious';

/* ═════════════════════════════════════════════════════════════
   4. 캔버스
   ═════════════════════════════════════════════════════════════ */

const svg = d3.select('#graph');
let gRoot, gBrain, gLink, gNode, tooltipEl;

function initCanvas() {
  svg.selectAll('*').remove();
  gRoot = svg.append('g').attr('class', 'root');
  gBrain = gRoot.append('g').attr('class', 'brain').attr('aria-hidden', 'true');
  gLink = gRoot.append('g').attr('class', 'links');
  gNode = gRoot.append('g').attr('class', 'nodes');
  tooltipEl = $('#tooltip');

  drawBrain();

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

/** 노드 배치와 같은 halfWidth() 를 쓰므로 외곽선과 피질 노드가 정확히 맞물린다. */
function drawBrain() {
  const line = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('');

  for (const side of [-1, 1]) {
    const outer = [];
    for (let i = 0; i <= 90; i++) {
      const s = -0.995 + (i / 90) * 1.99;
      outer.push(brainPoint(side, s, 1));
    }
    const d = line(outer) +
      `L${(side * BRAIN.GAP).toFixed(1)},${(0.995 * BRAIN.B).toFixed(1)}` +
      `L${(side * BRAIN.GAP).toFixed(1)},${(-0.995 * BRAIN.B).toFixed(1)}Z`;
    gBrain.append('path').attr('class', 'brain-lobe').attr('d', d);

    // 뇌구(sulci) — 피질 결을 암시하는 곡선
    for (const [depth, from, to, phase] of [
      [0.32, -0.72, 0.62, 0.4], [0.48, -0.80, 0.74, 1.9],
      [0.63, -0.84, 0.80, 3.1], [0.78, -0.86, 0.84, 4.6],
    ]) {
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const s = from + (i / 60) * (to - from);
        pts.push(brainPoint(side, s, depth + 0.035 * Math.sin(s * 7 + phase)));
      }
      gBrain.append('path').attr('class', 'brain-sulcus').attr('d', line(pts));
    }
  }

  // 소뇌 — 뒤쪽 두 덩이
  for (const side of [-1, 1]) {
    gBrain.append('ellipse').attr('class', 'brain-cerebellum')
      .attr('cx', side * 118).attr('cy', BRAIN.B * 1.02)
      .attr('rx', 104).attr('ry', 52)
      .attr('transform', `rotate(${side * 10} ${side * 118} ${BRAIN.B * 1.02})`);
  }
  // 뇌간
  gBrain.append('path').attr('class', 'brain-stem')
    .attr('d', `M-26,${BRAIN.B * 0.98} L26,${BRAIN.B * 0.98} L17,${BRAIN.B * 1.30} L-17,${BRAIN.B * 1.30} Z`);

  // 정중열
  gBrain.append('line').attr('class', 'brain-midline')
    .attr('x1', 0).attr('y1', -BRAIN.B * 0.99).attr('x2', 0).attr('y2', BRAIN.B * 0.99);

  gBrain.append('text').attr('class', 'brain-hemi-label')
    .attr('x', -BRAIN.A * 0.72).attr('y', -BRAIN.B * 0.93)
    .attr('text-anchor', 'middle').text('좌반구 · 물적 기반');
  gBrain.append('text').attr('class', 'brain-hemi-label')
    .attr('x', BRAIN.A * 0.72).attr('y', -BRAIN.B * 0.93)
    .attr('text-anchor', 'middle').text('우반구 · 사람과 위상');
}

function simulate() {
  // 뇌 형상을 유지해야 하므로 위치력을 강하게 두고, 링크는 국소 장력만 준다.
  const pull = (n) =>
    n.level === 'city' ? 1 : n.level === 'domain' ? 0.6 : n.level === 'sector' ? 0.55 : 0.34;

  state.sim = d3.forceSimulation(state.nodes)
    .force('link', d3.forceLink(state.links).id((d) => d.id)
      .distance((l) => (l.type === 'converge' ? 130 : l.type === 'resolves' ? 150 : 170))
      .strength((l) => (l.type === 'converge' ? 0.05 : 0.02)))
    .force('charge', d3.forceManyBody().strength(-90).distanceMax(240))
    .force('collide', d3.forceCollide().radius((n) => n.r + 5).iterations(3))
    .force('x', d3.forceX((n) => n.tx ?? 0).strength(pull))
    .force('y', d3.forceY((n) => n.ty ?? 0).strength(pull))
    .alpha(1).alphaDecay(0.028);
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
        return lv === 'domain' ? 2.2 : lv === 'sector' ? 1.5 : 0.7;
      }
      return l.type === 'resolves' ? 1.3 : 1 + 1.8 * (l.weight || 0.5);
    })
    .attr('stroke-opacity', (l) => (l.type === 'converge' ? 0.32 : l.type === 'resolves' ? 0.45 : 0.7));

  const nodeSel = gNode.selectAll('g.node').data(state.nodes, (n) => n.id);
  nodeSel.exit().remove();

  const enter = nodeSel.enter().append('g')
    .attr('class', (n) => `node node-${n.level}`)
    .call(d3.drag()
      .on('start', (ev, n) => {
        if (!ev.active) state.sim.alphaTarget(0.15).restart();
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

  enter.append('circle').attr('class', 'halo');
  enter.append('circle').attr('class', 'pulse');
  enter.append('circle').attr('class', 'shape-circle node-shape');
  enter.append('rect').attr('class', 'shape-rect node-shape');
  enter.append('text').attr('class', 'status-glyph');
  enter.append('text').attr('class', 'node-label');

  const all = enter.merge(nodeSel);
  const isPledge = (n) => n.level === 'pledge';

  all.select('circle.halo').attr('r', (n) => n.r + 3);
  all.select('circle.pulse')
    .attr('r', (n) => n.r + 2)
    .style('display', (n) => (n.status === 'critical' && n.level === 'diagnosis' ? null : 'none'));

  all.select('circle.shape-circle')
    .style('display', (n) => (isPledge(n) ? 'none' : null))
    .attr('r', (n) => n.r)
    .attr('fill', nodeFill)
    .attr('stroke', (n) => (isAlerting(n) ? st[n.status].color : 'var(--page)'))
    .attr('stroke-width', (n) => (isAlerting(n) ? 2 : 1.5));

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
    .style('display', (n) => (n.status && n.status !== 'good' && !isPledge(n) ? null : 'none'))
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

/* ═════════════════════════════════════════════════════════════
   5. 가시성 · 점등(신경 발화)
   ═════════════════════════════════════════════════════════════ */

/** 선택 노드에서 의미 관계(해소·시너지·의존·상충)만 따라 홉 거리를 잰다.
 *  수렴축은 제외한다 — 포함하면 몇 홉 만에 전체가 켜져 초점이 사라진다. */
function activationMap(startId, maxHop = 4) {
  const adj = new Map();
  const push = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const l of state.links) {
    if (!REL_TYPES.has(l.type) || state.hiddenLinkTypes.has(l.type)) continue;
    push(l.source.id, l.target.id);
    push(l.target.id, l.source.id);
  }
  // 수렴축은 '내려가는' 방향으로만 넣는다. 섹터·영역·시 같은 중심점을 누르면
  // 그 아래 전체가 발화하고, 진단·공약을 누를 때는 위로 역류하지 않는다.
  for (const l of state.links) {
    if (l.type !== 'converge' || state.hiddenLinkTypes.has('converge')) continue;
    push(l.target.id, l.source.id);   // 부모 → 자식
  }
  const hop = new Map([[startId, 0]]);
  let frontier = [startId];
  for (let h = 1; h <= maxHop && frontier.length; h++) {
    const next = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) || []) {
        if (hop.has(nb)) continue;
        hop.set(nb, h);
        next.push(nb);
      }
    }
    frontier = next;
  }
  // 수렴축(섹터→영역→시)은 항상 1홉으로 함께 켠다
  let cur = state.byId.get(startId);
  let h = 1;
  while (cur) {
    const up = (cur.level === 'diagnosis' || cur.level === 'pledge') ? cur.sector
      : cur.level === 'sector' ? cur.domain
      : cur.level === 'domain' ? state.raw.taxonomy.city.id : null;
    if (!up) break;
    if (!hop.has(up)) hop.set(up, h);
    cur = state.byId.get(up);
    h++;
  }
  return hop;
}

/** 홉이 멀수록 약하게 켜진다 — 가까운 관계가 먼저, 더 밝게 보이도록. */
const strengthAt = (hop) => Math.max(0.28, 1 - hop * 0.20);

function applyVisibility() {
  const q = state.query.trim().toLowerCase();
  const isLeaf = (n) => n.level === 'diagnosis' || n.level === 'pledge';

  const matchesQuery = (n) => !q ||
    [n.label, n.detail, n.sectorLabel].filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));

  const inView = (n) => {
    if (!isLeaf(n)) return true;
    if (state.hiddenKinds.has(n.kind)) return false;
    if (state.view === 'gap') return n.level === 'diagnosis' && n.coverage === 0;
    if (state.view === 'risk') return n.level === 'diagnosis' && n.status === 'critical';
    if (state.view === 'conflict') {
      return state.links.some((l) =>
        l.type === 'conflict' && (l.source.id === n.id || l.target.id === n.id));
    }
    return true;
  };
  const passStatus = (n) => !n.status || !state.hiddenStatus.has(n.status);

  const visible = new Set();
  for (const n of state.nodes) {
    if (!isLeaf(n) || (inView(n) && passStatus(n) && matchesQuery(n))) visible.add(n.id);
  }

  const hop = state.focus ? activationMap(state.focus) : null;

  // 애니메이션 재시작을 위해 클래스를 먼저 걷어낸다
  gNode.selectAll('g.node').classed('act', false);
  gLink.selectAll('line').classed('act', false);
  if (gNode.node()) gNode.node().getBoundingClientRect();

  gNode.selectAll('g.node')
    .classed('dim', (n) => !visible.has(n.id) || (hop && !hop.has(n.id)))
    .classed('act', (n) => !!hop && hop.has(n.id) && visible.has(n.id))
    .classed('act-self', (n) => n.id === state.focus)
    .style('--hop-delay', (n) => (hop && hop.has(n.id) ? (hop.get(n.id) * 0.105).toFixed(3) + 's' : null))
    .style('--halo-peak', (n) => {
      if (!hop || !hop.has(n.id)) return null;
      return (strengthAt(hop.get(n.id)) * 0.95).toFixed(3);
    })
    .style('--halo-hold', (n) => {
      if (!hop || !hop.has(n.id)) return null;
      return (strengthAt(hop.get(n.id)) * 0.42).toFixed(3);
    });

  gLink.selectAll('line')
    .classed('dim', (l) => {
      if (state.hiddenLinkTypes.has(l.type)) return true;
      if (!visible.has(l.source.id) || !visible.has(l.target.id)) return true;
      if ((state.view === 'conflict' || state.view === 'risk') && l.type === 'converge') return true;
      if (hop) return !(hop.has(l.source.id) && hop.has(l.target.id));
      return false;
    })
    .classed('act', (l) => {
      if (!hop || state.hiddenLinkTypes.has(l.type)) return false;
      const a = hop.get(l.source.id), b = hop.get(l.target.id);
      return a !== undefined && b !== undefined && Math.abs(a - b) === 1;
    })
    .each(function (l) {
      if (!this.classList.contains('act')) {
        this.style.removeProperty('--len');
        this.style.removeProperty('--hop-delay');
        return;
      }
      const len = Math.hypot(l.target.x - l.source.x, l.target.y - l.source.y) || 1;
      const near = Math.min(hop.get(l.source.id), hop.get(l.target.id));
      this.style.setProperty('--len', len.toFixed(1));
      this.style.setProperty('--hop-delay', (near * 0.105).toFixed(3) + 's');
    });
}

function applyLabelVisibility() {
  const k = state.transform.k;
  gNode.selectAll('text.node-label').style('display', (n) => {
    if (n.level === 'city' || n.level === 'domain') return null;
    if (n.level === 'sector') return k >= 0.45 ? null : 'none';
    if (state.focus === n.id) return null;
    if (k >= 1.5) return null;
    if (k >= 1.0 && n.r >= 14) return null;
    return n.status === 'critical' && n.r >= 15 ? null : 'none';
  });
}

/* ═════════════════════════════════════════════════════════════
   6. 툴팁 · 초점
   ═════════════════════════════════════════════════════════════ */

function riskBar(v, color) {
  return `<div class="mini-bar"><div style="width:${Math.min(100, v).toFixed(0)}%;background:${color}"></div></div>`;
}

function showTooltip(ev, n) {
  const st = statusMeta();
  const out = [`<div class="tt-title">${esc(n.label)}</div>`];
  const meta = n.level === 'diagnosis' ? `${n.sectorLabel} · 진단 ${n.no}`
    : n.level === 'pledge' ? `${n.sectorLabel} · 공약${n.round ? ` · ${n.round}차` : ''}`
    : n.level === 'sector' ? `진단 ${n.diagnoses.length} · 공약 ${n.pledges.length}`
    : n.level === 'domain' ? `${n.children.length}개 섹터 · 진단 ${n.diagCount}`
    : `12개 섹터 · 진단 ${n.diagCount} · 공약 ${n.pledgeCount}`;
  out.push(`<div class="tt-meta">${esc(meta)}</div>`);
  if (n.detail) out.push(`<div class="tt-detail">${esc(n.detail)}</div>`);

  if (n.status) {
    out.push(`<div class="tt-row"><span>상태</span><b style="color:${st[n.status].color}">${st[n.status].icon} ${st[n.status].label}</b></div>`);
  }
  if (Number.isFinite(n.risk)) {
    out.push(`<div class="tt-row"><span>잔여위험</span><b>${n.risk.toFixed(0)}<span style="color:var(--ink-3)">/100</span></b></div>`);
  }
  if (n.level === 'diagnosis') {
    out.push(`<div class="tt-row"><span>구조적 심각도</span><b>${n.severity}</b></div>`);
    out.push(`<div class="tt-row"><span>대응 공약</span><b style="color:${n.coverage ? 'inherit' : st.critical.color}">${n.coverage}건</b></div>`);
    if (n.signals.length) out.push(`<div class="tt-row"><span>시민 신호</span><b>${n.signals.length}건</b></div>`);
    if (n.evidence) out.push(`<div class="tt-evi">◆ ${esc(n.evidence.fact)}</div>`);
  }
  if (n.level === 'pledge') {
    out.push(`<div class="tt-row"><span>해소 대상 진단</span><b>${n.resolveCount}건</b></div>`);
    if (n.crossDeg) out.push(`<div class="tt-row"><span>공약 간 연결</span><b>${n.crossDeg}건</b></div>`);
  }
  if (['sector', 'domain', 'city'].includes(n.level)) {
    out.push(`<div class="tt-row"><span>위험 진단</span><b style="color:${st.critical.color}">${n.atRisk}건</b></div>`);
    out.push(`<div class="tt-row"><span>미대응 진단</span><b>${n.uncovered}건</b></div>`);
  }
  out.push(`<div class="tt-hint">클릭 → 연결된 노드 점등</div>`);

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
  applyLabelVisibility();
  renderDetail(state.byId.get(id));
  $$('.sector-row').forEach((el) => el.classList.toggle('is-on', el.dataset.id === id));
}

function clearFocus() {
  state.focus = null;
  applyVisibility();
  applyLabelVisibility();
  $('#detail-empty').hidden = false;
  $('#detail-body').hidden = true;
  $$('.sector-row').forEach((el) => el.classList.remove('is-on'));
}

/* ═════════════════════════════════════════════════════════════
   7. 패널
   ═════════════════════════════════════════════════════════════ */

function renderStats() {
  const st = statusMeta();
  const diag = state.nodes.filter((n) => n.level === 'diagnosis');
  const pled = state.nodes.filter((n) => n.level === 'pledge');
  const uncovered = diag.filter((d) => d.coverage === 0).length;
  const crit = diag.filter((d) => d.status === 'critical').length;
  const ser = diag.filter((d) => d.status === 'serious').length;
  const avgRisk = diag.reduce((a, d) => a + d.risk, 0) / diag.length;
  const avgSev = diag.reduce((a, d) => a + (d.severity || 0), 0) / diag.length;

  const items = [
    ['진단 / 공약', `${diag.length}<span style="color:var(--ink-3);font-size:14px"> / ${pled.length}</span>`, ''],
    ['평균 구조 심각도', avgSev.toFixed(0), '/100'],
    ['평균 잔여위험', `<span style="color:${st.serious.color}">${avgRisk.toFixed(0)}</span>`, '/100'],
    ['위험 / 경계', `<span style="color:${st.critical.color}">${crit}</span> / <span style="color:${st.serious.color}">${ser}</span>`, '개'],
    ['미대응 진단', `<span style="color:${uncovered ? st.critical.color : st.good.color}">${uncovered}</span>`, '개'],
    ['시민 신호', fmt(state.raw.signals.length), '건'],
  ];
  $('#stat-row').innerHTML = items.map(([k, v, u]) =>
    `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v">${v}<small>${u}</small></div></div>`).join('');
}

function renderSectorList() {
  const st = statusMeta();
  const sectors = state.nodes.filter((n) => n.level === 'sector')
    .slice().sort((a, b) => b.risk - a.risk);
  $('#sector-list').innerHTML = sectors.map((s) => `
    <button class="sector-row" data-id="${s.id}">
      <span class="sector-bar" style="background:${s.color}"></span>
      <span>
        <span class="sector-name">${s.no}. ${esc(s.label)}</span>
        <span class="sector-sub">위험 ${s.atRisk} · 미대응 ${s.uncovered} · 진단 ${s.diagnoses.length}</span>
        ${riskBar(s.risk, st[s.status].color)}
      </span>
      <span class="sector-metric">
        <span class="sector-count" style="color:${st[s.status].color}">${s.risk.toFixed(0)}</span>
        <span class="sector-flag">잔여위험</span>
      </span>
    </button>`).join('');

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
      <h4>노드 (모양)</h4>
      <div class="legend-cols">
        <div class="legend-item"><span class="legend-swatch legend-circle"></span>진단 · 피질</div>
        <div class="legend-item"><span class="legend-swatch legend-square"></span>공약 · 백질</div>
      </div>
    </div>
    <div class="legend-cols">
      <div class="legend-group">
        <h4>정책 영역</h4>
        ${tx.domains.map((d) =>
          `<div class="legend-item"><span class="legend-swatch" style="background:${d.color}"></span>${esc(d.label)}</div>`).join('')}
      </div>
      <div class="legend-group">
        <h4>잔여위험</h4>
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
    <p class="legend-note">잔여위험 = 구조 심각도 × (1 − 대응감쇄) + 현장 신호. 노드를 누르면 연결이 홉 순서로 점등된다.</p>`;
}

const AXIS_LABEL = {
  structural: '구조성', felt: '체감도', trajectory: '악화성', autonomyGap: '권한 결여',
};
const AXIS_DESC = {
  structural: '단년도 정책으로 해소되지 않는 구조적 결손인가',
  felt: '시민 생활에 직접·즉시 닿는가',
  trajectory: '방치하면 스스로 악화되고 번지는가',
  autonomyGap: '해법이 시 권한 밖(중앙·국회)에 있는가',
};

function renderDetail(n) {
  if (!n) return;
  const st = statusMeta();
  const box = $('#detail-body');
  $('#detail-empty').hidden = true;
  box.hidden = false;

  const kindTag = n.level === 'diagnosis' ? '진단' : n.level === 'pledge' ? '공약' : null;
  const sub = n.level === 'diagnosis' ? `${n.sectorLabel} · ${n.no}번 진단`
    : n.level === 'pledge' ? `${n.sectorLabel}${n.round ? ` · ${n.round}차 브리핑` : ''}`
    : n.level === 'sector' ? `진단 ${n.diagnoses.length} · 공약 ${n.pledges.length} · 위험 ${n.atRisk}`
    : n.level === 'domain' ? `${n.children.length}개 섹터 · 진단 ${n.diagCount} · 위험 ${n.atRisk}`
    : `12개 섹터가 수렴하는 최상위 지점`;

  const parts = [`<div class="d-head">
      <span class="d-dot ${n.level === 'pledge' ? 'is-square' : ''}" style="background:${nodeFill(n)}"></span>
      <span class="d-title">${esc(n.label)}${kindTag ? `<span class="d-kind">${kindTag}</span>` : ''}</span>
    </div>
    <div class="d-sub">${esc(sub)}</div>`];

  if (n.detail) parts.push(`<p class="d-detail">${esc(n.detail)}</p>`);

  if (n.status) {
    parts.push(`<div class="d-status" style="background:${st[n.status].color}22;color:${st[n.status].color};border:1px solid ${st[n.status].color}55">
      ${st[n.status].icon} ${st[n.status].label}${Number.isFinite(n.risk) ? ` · 잔여위험 ${n.risk.toFixed(0)}` : ''}</div>`);
  }

  // ── 정밀 진단 (4축)
  if (n.level === 'diagnosis' && n.assess) {
    parts.push(`<div class="d-section"><h3>정밀 진단</h3>
      <div class="assess">
        ${Object.entries(n.assess).map(([k, v]) => `
          <div class="assess-row" title="${esc(AXIS_DESC[k])}">
            <span class="assess-k">${AXIS_LABEL[k]}</span>
            <span class="assess-dots">${[1, 2, 3, 4, 5].map((i) =>
              `<i class="${i <= v ? 'on' : ''}"></i>`).join('')}</span>
            <span class="assess-v">${v}</span>
          </div>`).join('')}
      </div>
      <dl class="kv" style="margin-top:10px">
        <dt>구조적 심각도</dt><dd>${n.severity} / 100</dd>
        <dt>대응 감쇄</dt><dd>−${Math.round(DAMP[Math.min(3, n.coverage)] * 100)}% (공약 ${n.coverage}건)</dd>
        <dt>현장 신호 가산</dt><dd>+${Math.min(12, n.signalLoad * 0.6).toFixed(0)}</dd>
        <dt><b>잔여위험</b></dt><dd><b style="color:${st[n.status].color}">${n.risk.toFixed(0)} / 100</b></dd>
      </dl>
    </div>`);

    if (n.evidence) {
      parts.push(`<div class="d-section"><h3>공개 지표 근거</h3>
        <div class="evidence"><p>${esc(n.evidence.fact)}</p><cite>${esc(n.evidence.src)}</cite></div></div>`);
    }
  }

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

  if (n.level === 'pledge') {
    const targets = (n.resolves || []).map((id) => state.byId.get(id)).filter(Boolean);
    const relieved = targets.reduce((a, d) => a + (d.severity || 0) * DAMP[Math.min(3, d.coverage)], 0);
    parts.push(`<div class="d-section"><h3>해소 대상 진단 ${targets.length}</h3>
      ${targets.length ? `<p class="lead-note">이 공약이 걷어내는 위험 총량 <b>${relieved.toFixed(0)}</b>점</p>` : ''}
      ${targets.map((d) => `<button class="lnk-item" data-goto="${d.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(d)}"></span>
          <span>${esc(d.label)}</span></span>
        <span class="lnk-note">${esc(d.sectorLabel)} · ${st[d.status].icon} ${st[d.status].label} · 심각도 ${d.severity}</span>
      </button>`).join('')}</div>`);

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

  if (n.level === 'sector') {
    const risky = n.diagnoses.slice().sort((a, b) => b.risk - a.risk).filter((d) => d.status === 'critical');
    if (risky.length) {
      parts.push(`<div class="d-section"><h3 class="h3-alert">위험 진단 ${risky.length}</h3>${risky
        .map((d) => `<button class="lnk-item is-gap" data-goto="${d.id}">
          <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(d)}"></span>
            <span>${d.no}. ${esc(d.label)}</span></span>
          <span class="lnk-note">잔여위험 ${d.risk.toFixed(0)} · 심각도 ${d.severity} · 공약 ${d.coverage}건</span>
        </button>`).join('')}</div>`);
    }
    parts.push(`<div class="d-section"><h3>공약 ${n.pledges.length}</h3>${n.pledges
      .map((p) => `<button class="lnk-item" data-goto="${p.id}">
        <span class="lnk-top"><span class="sev-dot is-square" style="background:${p.color}"></span>
          <span>${esc(p.label)}</span></span>
        <span class="lnk-note">${p.round ? p.round + '차 브리핑 · ' : ''}진단 ${p.resolveCount}건 해소</span>
      </button>`).join('')}</div>`);
    parts.push(`<div class="d-section"><h3>진단 전체 ${n.diagnoses.length}</h3>${n.diagnoses
      .slice().sort((a, b) => b.risk - a.risk)
      .map((d) => `<button class="lnk-item" data-goto="${d.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(d)}"></span>
          <span>${d.no}. ${esc(d.label)}</span></span>
        <span class="lnk-note">${st[d.status].icon} 잔여위험 ${d.risk.toFixed(0)} · 공약 ${d.coverage}건</span>
      </button>`).join('')}</div>`);
  }

  if (n.level === 'domain' || n.level === 'city') {
    parts.push(`<div class="d-section"><h3>하위 ${n.level === 'city' ? '영역' : '섹터'} ${n.children.length}</h3>${n.children
      .slice().sort((a, b) => b.risk - a.risk)
      .map((c) => `<button class="lnk-item" data-goto="${c.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(c)}"></span>
          <span>${esc(c.label)}</span></span>
        <span class="lnk-note">${st[c.status].icon} 잔여위험 ${c.risk.toFixed(0)} · 위험 ${c.atRisk} · 미대응 ${c.uncovered}</span>
      </button>`).join('')}</div>`);
  }

  box.innerHTML = parts.join('');
  $$('[data-goto]', box).forEach((el) =>
    el.addEventListener('click', () => setFocus(el.dataset.goto)));
}

/* ═════════════════════════════════════════════════════════════
   8. 컨트롤
   ═════════════════════════════════════════════════════════════ */

function fitToScreen(ms = 600) {
  const rect = svg.node().getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return;
  const pad = 90;
  const [x0, x1] = [-BRAIN.A - pad, BRAIN.A + pad];
  const [y0, y1] = [-BRAIN.B - pad, BRAIN.B * 1.36 + pad];
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

/* ═════════════════════════════════════════════════════════════
   9. 시민 신호 입력
   ═════════════════════════════════════════════════════════════ */

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

/* ═════════════════════════════════════════════════════════════
   10. 부팅
   ═════════════════════════════════════════════════════════════ */

async function reload() {
  const prev = new Map(state.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
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
  state.sim.alpha(0.25).restart();
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

  setTimeout(() => fitToScreen(700), 700);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;color:#ffb4b4">불러오기 실패: ${esc(err.message)}</div>`);
});
