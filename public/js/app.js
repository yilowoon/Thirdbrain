/* ThirdBrain — 세종시 12대 섹터 진단·공약 네트워크
 *
 * 맞물린 두 개의 원환. 겹치는 자리에 생기는 렌즈가 수렴점(세종시)이다.
 *   바깥 궤도 = 진단 97 (○ 링)   문제는 바깥에 드러난다
 *   안쪽 궤도 = 공약 54 (◇ 마름모) 해법은 안에서 잇는다
 *   왼쪽 원환 = 공간·환경·농업 + 경제·산업·기술
 *   오른쪽 원환 = 시민의 삶 + 도시위상·문화·안전
 *
 * 상태는 색이 아니라 '채움 밀도'가 먼저 말한다 — 링이 차오를수록 위험하다.
 * 노드를 선택하면 연결된 노드가 홉 거리 순으로 차례차례 점등된다.
 */
'use strict';

const SEV_W = { low: 1, mid: 3, high: 7, critical: 14 };
const STATUS_ORDER = ['good', 'warning', 'serious', 'critical'];
const REL_TYPES = new Set(['resolves', 'synergy', 'dependency', 'conflict', 'affinity']);

/** 대응 공약 수에 따른 위험 감쇄. 공약 하나가 위험을 다 없애지는 못한다. */
const DAMP = [0, 0.18, 0.30, 0.38];

/* ── 색 체계 ────────────────────────────────────────────
   기본은 골드 시퀀셜 램프. 노드의 값이 클수록 밝고 진해진다.
   연결(점등)되면 블루로 바뀌고, 위험만 크림슨으로 남는다.
   위험색은 골드 램프 전 단계와 색각이상 ΔE 8.9 이상 떨어져 있다 —
   순수 적색은 골드와 적록색각이상에서 구분이 되지 않아 쓸 수 없었다. */
const GOLD = ['#5c4a28', '#755d31', '#8f7139', '#aa8641', '#c59b49', '#e2b151', '#ffc75a'];
const CONNECT = '#43acfb';
const CONNECT_HI = '#76c7ff';
const ALARM = '#e13b86';

/** 노드가 화면에 내거는 값. 라벨의 "값:이름" 에서 앞자리가 된다. */
function nodeValue(n) {
  if (n.level === 'pledge') return n.resolveCount || 0;
  if (n.level === 'org') return (n.teams || []).length;
  if (n.level === 'team') return n.deg || 1;
  return Math.round(n.risk ?? 0);
}

/** 값 → 골드 램프 단계. 공약·조직은 자체 척도라 별도로 정규화한다. */
function goldFor(n) {
  const v = nodeValue(n);
  const t = n.level === 'pledge' ? Math.min(1, v / 5)
    : n.level === 'org' ? Math.min(1, v / 4)
    : n.level === 'team' ? 0.2
    : Math.min(1, Math.max(0, (v - 35) / 45));
  // 하한을 2단계로 두어 화면의 기조가 골드로 읽히게 한다 (0~1 단계는 배경에 묻힌다)
  return GOLD[Math.max(2, Math.min(GOLD.length - 1, 2 + Math.round(t * 4)))];
}

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
  showOrg: true,
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
   1. 기하 — 맞물린 두 개의 원환
   두 원이 겹치며 중앙에 렌즈(vesica)를 만든다. 그 렌즈가 수렴점이다.
   노드 좌표와 배경 도형이 같은 상수를 쓰므로 정확히 맞물린다.
   ═════════════════════════════════════════════════════════════ */

const RING = {
  R: 430,        // 원환 반지름
  cx: 258,       // 중심 간 거리의 절반 (R×0.6) — 겹침의 깊이를 정한다
  outer: 46,     // 진단이 앉는 바깥 궤도
  inner: -60,    // 공약이 앉는 안쪽 궤도
  // 섹터가 차지하는 호. 교점은 ±126.9° 이므로 그 안쪽으로만 앉혀
  // 겹침부(렌즈)를 비워 둔다. t 가 커질수록 화면 아래로 내려간다.
  from: -121,
  to: 121,
};
/** 두 원의 교점 y좌표 — 렌즈의 위·아래 꼭짓점 */
RING.lensY = Math.sqrt(RING.R ** 2 - RING.cx ** 2);

const deg = (d) => (d * Math.PI) / 180;

/** side: -1 왼쪽 원환 / +1 오른쪽 원환.
 *  t: 각 원환의 바깥쪽(렌즈 반대편) 0° 기준 각도. off: 반지름 오프셋(+ 는 바깥).
 *  왼쪽 원환은 180° 를 기준으로 뒤집어, 두 원이 서로를 향해 열리게 한다. */
function ringPoint(side, t, off = 0) {
  const r = RING.R + off;
  const a = deg(side > 0 ? t : 180 - t);
  return { x: side * RING.cx + r * Math.cos(a), y: r * Math.sin(a) };
}

/** 오른쪽 원환에 D3·D4, 왼쪽에 D1·D2 — 영역 하나가 정확히 섹터 3개다 */
const RING_PLAN = {
  '-1': ['S01', 'S08', 'S09', 'S02', 'S10', 'S11'],
  '1':  ['S05', 'S06', 'S07', 'S03', 'S04', 'S12'],
};

/** 섹터별 호 구간 */
function sectorSpans() {
  const map = new Map();
  for (const side of [-1, 1]) {
    const list = RING_PLAN[String(side)];
    const w = (RING.to - RING.from) / list.length;
    list.forEach((id, k) => {
      map.set(id, {
        side,
        a0: RING.from + k * w + w * 0.08,
        a1: RING.from + (k + 1) * w - w * 0.08,
      });
    });
  }
  return map;
}

/** 한국어를 형태소 분석 없이 다루기 위한 문자 바이그램 집합 */
function textGrams(text) {
  const clean = String(text || '').replace(/[^가-힣a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
  const set = new Set();
  for (const w of clean.split(/\s+/)) {
    if (w.length < 2) continue;
    for (let i = 0; i < w.length - 1; i++) set.add(w.slice(i, i + 2));
  }
  return set;
}
const diceSim = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return (2 * hit) / (a.size + b.size);
};

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
    const p = ringPoint(sp.side, (sp.a0 + sp.a1) / 2, 0);
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
      const a = sp.a0 + ((j + 0.5) / list.length) * (sp.a1 - sp.a0);
      const off = RING.inner - 16 * ((j % 3) / 2);
      const pt = ringPoint(sp.side, a, off);
      const degree = crossDeg.get(p.id) || 0;
      nodes.push({
        ...p,
        level: 'pledge', kind: 'pledge',
        color: sec.color, domain: sec.domain, sectorLabel: sec.label, side: sp.side,
        crossDeg: degree, resolveCount: (p.resolves || []).length,
        signals: [], status: null,
        r: Math.max(8, Math.min(23,
          7 + 1.3 * Math.sqrt(p.weight || 5) + 1.7 * Math.sqrt((p.resolves || []).length) + 0.9 * Math.sqrt(degree))),
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
      const a = sp.a0 + ((i + 0.5) / list.length) * (sp.a1 - sp.a0);
      const off = RING.outer + 20 * ((i % 3) / 2);
      const pt = ringPoint(sp.side, a, off);

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

  // ── 행정조직 — 과(바깥 궤도) → 팀(가장 바깥 궤도)
  const org = raw.org;
  if (org) {
    const divs = org.bureaus.flatMap((b) => b.divisions.map((d) => ({ ...d, bureauName: b.name })));
    const bySec = new Map();
    for (const d of divs) for (const sid of d.sectors) {
      if (!bySec.has(sid)) bySec.set(sid, []);
      bySec.get(sid).push(d);
    }
    const teamSeen = new Set();
    for (const [sid, list] of bySec) {
      const sp = spans.get(sid);
      if (!sp) continue;
      list.forEach((d, i) => {
        const a = sp.a0 + ((i + 0.5) / list.length) * (sp.a1 - sp.a0);
        const pt = ringPoint(sp.side, a, RING.outer + 92 + 24 * (i % 2));
        const orgNodeId = `${d.id}@${sid}`;
        nodes.push({
          ...d,
          id: orgNodeId, orgId: d.id,
          level: 'org', kind: 'org',
          label: d.name, sector: sid, sectorLabel: sectorById.get(sid).label,
          domain: sectorById.get(sid).domain, side: sp.side,
          status: null, signals: [],
          r: Math.max(7, Math.min(14, 6.5 + 1.1 * Math.sqrt(d.teams.length))),
          tx: pt.x, ty: pt.y, x: pt.x, y: pt.y,
        });

        // 팀은 과가 처음 등장한 섹터에만 매단다 (같은 팀이 중복되지 않게)
        if (teamSeen.has(d.id)) return;
        teamSeen.add(d.id);
        const span = (sp.a1 - sp.a0) / Math.max(1, list.length);
        d.teams.forEach((t, k) => {
          const ta = a + (k - (d.teams.length - 1) / 2) * (span * 0.62 / Math.max(1, d.teams.length));
          const tp = ringPoint(sp.side, ta, RING.outer + 168 + 20 * (k % 2));
          nodes.push({
            id: t.id, level: 'team', kind: 'team',
            label: t.name, parentOrg: orgNodeId, division: d.name, bureauName: d.bureauName,
            sector: sid, sectorLabel: sectorById.get(sid).label,
            domain: sectorById.get(sid).domain, side: sp.side,
            duty: d.duty, status: null, signals: [],
            r: 5.2,
            tx: tp.x, ty: tp.y, x: tp.x, y: tp.y,
          });
        });
      });
    }
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
      tx: cx * 0.30, ty: cy * 0.34, x: cx * 0.30, y: cy * 0.34,
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
    if (n.level === 'team')
      gLinks.push({ source: n.id, target: n.parentOrg, type: 'converge', weight: 1 });
    else if (n.level === 'diagnosis' || n.level === 'pledge' || n.level === 'org')
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

  // ── 진단 간 연관(affinity) — 서로 다른 섹터에 흩어져 있지만 같은 문제를 공유하는 쌍.
  //    문자 바이그램 유사도로 뽑아 각 진단마다 상위 2개까지만 잇는다.
  const diagNodes = nodes.filter((n) => n.level === 'diagnosis');
  const grams = new Map();
  for (const d of diagNodes) grams.set(d.id, textGrams(`${d.label} ${d.detail || ''}`));
  const seenPair = new Set();
  for (const a of diagNodes) {
    const ga = grams.get(a.id);
    const near = [];
    for (const b of diagNodes) {
      if (a.id === b.id || a.sector === b.sector) continue;
      const sim = diceSim(ga, grams.get(b.id));
      if (sim >= 0.20) near.push({ id: b.id, sim });
    }
    near.sort((x, y) => y.sim - x.sim);
    for (const n of near.slice(0, 2)) {
      const key = [a.id, n.id].sort().join('|');
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      gLinks.push({ source: a.id, target: n.id, type: 'affinity', weight: n.sim, note: '같은 문제를 공유하는 진단' });
    }
  }

  // 각 노드에 걸린 연결 수 — 선 굵기와 노드 위상의 근거가 된다
  const degree = new Map();
  for (const l of gLinks) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  for (const n of nodes) n.deg = degree.get(n.id) || 0;

  return { nodes, links: gLinks, byId: byId2, sectorById };
}

/* ═════════════════════════════════════════════════════════════
   3. 시각 규칙
   ═════════════════════════════════════════════════════════════ */

const statusMeta = () => Object.fromEntries(state.raw.taxonomy.status.map((s) => [s.id, s]));

function nodeFill(n) {
  if (n.status === 'critical') return ALARM;
  return goldFor(n);
}
const isAlerting = (n) => n.status === 'critical' || n.status === 'serious';

/* ═════════════════════════════════════════════════════════════
   4. 캔버스
   ═════════════════════════════════════════════════════════════ */

const svg = d3.select('#graph');
let gRoot, gDefs, gBrain, gLink, gLinkMark, gNode, tooltipEl;

function initCanvas() {
  svg.selectAll('*').remove();
  gRoot = svg.append('g').attr('class', 'root');
  gDefs = gRoot.append('defs');
  gBrain = gRoot.append('g').attr('class', 'brain').attr('aria-hidden', 'true');
  gLink = gRoot.append('g').attr('class', 'links');
  gLinkMark = gRoot.append('g').attr('class', 'link-marks');
  gNode = gRoot.append('g').attr('class', 'nodes');
  tooltipEl = $('#tooltip');

  drawRings();

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

/** 배경 도형. 노드 좌표와 같은 RING 상수를 쓰므로 궤도와 정확히 맞물린다.
 *  두 원이 겹쳐 만드는 렌즈가 수렴점이고, 그 안에 세종시 노드가 앉는다. */
function drawRings() {
  const { R, cx, outer, inner, lensY } = RING;

  const defs = gBrain.append('defs');
  const grad = defs.append('radialGradient').attr('id', 'lensGlow');
  grad.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(255,255,255,0.075)');
  grad.append('stop').attr('offset', '60%').attr('stop-color', 'rgba(255,255,255,0.022)');
  grad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(255,255,255,0)');

  // 렌즈 — 두 원의 교집합
  gBrain.append('path').attr('class', 'lens-fill')
    .attr('d', `M0,${-lensY} A${R} ${R} 0 0 1 0,${lensY} A${R} ${R} 0 0 1 0,${-lensY} Z`);
  gBrain.append('ellipse').attr('class', 'lens-glow')
    .attr('cx', 0).attr('cy', 0).attr('rx', R - cx + 40).attr('ry', lensY * 0.82)
    .attr('fill', 'url(#lensGlow)');

  for (const side of [-1, 1]) {
    const c = side * cx;
    // 궤도 보조선 — 안쪽(공약)·중심(섹터)·바깥(진단)
    gBrain.append('circle').attr('class', 'orbit orbit-faint')
      .attr('cx', c).attr('cy', 0).attr('r', R + inner);
    gBrain.append('circle').attr('class', 'orbit orbit-main')
      .attr('cx', c).attr('cy', 0).attr('r', R);
    gBrain.append('circle').attr('class', 'orbit orbit-faint')
      .attr('cx', c).attr('cy', 0).attr('r', R + outer);
  }

  // 렌즈 윤곽을 한 번 더 그어 맞물림을 또렷하게
  gBrain.append('path').attr('class', 'lens-edge')
    .attr('d', `M0,${-lensY} A${R} ${R} 0 0 1 0,${lensY} A${R} ${R} 0 0 1 0,${-lensY} Z`);

  // 수렴 눈금 — 렌즈에서 바깥으로 뻗는 아주 옅은 방사선
  for (let i = 0; i < 4; i++) {
    const a = deg(-58 + i * 39);
    gBrain.append('line').attr('class', 'lens-tick')
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', Math.cos(a) * (R - cx + 30)).attr('y2', Math.sin(a) * lensY * 0.9);
  }
}

function simulate() {
  // 뇌 형상을 유지해야 하므로 위치력을 강하게 두고, 링크는 국소 장력만 준다.
  const pull = (n) =>
    n.level === 'city' ? 1 : n.level === 'domain' ? 0.6
      : n.level === 'sector' ? 0.55 : (n.level === 'org' || n.level === 'team') ? 0.55 : 0.34;

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

  // 연결선은 단순 직선이 아니라 양끝 굵기가 다른 테이퍼 도형이다.
  // 연결이 많고 큰 노드 쪽이 두껍고, 작은 노드 쪽으로 갈수록 얇아진다.
  const linkKey = (l) => `${l.source.id ?? l.source}|${l.target.id ?? l.target}|${l.type}`;

  const gradSel = gDefs.selectAll('linearGradient.lg').data(state.links, linkKey);
  gradSel.exit().remove();
  const gradEnter = gradSel.enter().append('linearGradient')
    .attr('class', 'lg')
    .attr('id', (l, i) => `lg${linkKey(l).replace(/[^A-Za-z0-9]/g, '_')}`)
    .attr('gradientUnits', 'userSpaceOnUse');
  gradEnter.append('stop').attr('class', 'g0').attr('offset', '0%');
  gradEnter.append('stop').attr('class', 'g1').attr('offset', '100%');

  const linkSel = gLink.selectAll('path.link').data(state.links, linkKey);
  linkSel.exit().remove();
  linkSel.enter().append('path')
    .attr('class', (l) => `link link-${l.type}`)
    .merge(linkSel)
    .attr('fill', (l) => `url(#lg${linkKey(l).replace(/[^A-Za-z0-9]/g, '_')})`)
    .attr('stroke', 'none');

  // 채움 도형만으로는 관계 유형이 구분되지 않는다. 파선·점선 중심선을 덧그린다.
  const marked = state.links.filter((l) => l.type === 'dependency' || l.type === 'conflict');
  const markSel = gLinkMark.selectAll('line').data(marked, linkKey);
  markSel.exit().remove();
  markSel.enter().append('line')
    .attr('class', (l) => `link-mark mark-${l.type}`);

  updateLinkPaint();

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

  // fill:none 인 링은 테두리에서만 이벤트가 잡힌다. 안쪽까지 잡히도록 투명 히트 영역을 깐다.
  enter.append('circle').attr('class', 'hit');
  enter.append('circle').attr('class', 'halo');
  enter.append('circle').attr('class', 'pulse');
  enter.append('circle').attr('class', 'mark-outer');     // 위험 노드의 이중 링
  enter.append('circle').attr('class', 'mark-ring node-shape');
  enter.append('circle').attr('class', 'mark-core');      // 채움 밀도 = 상태
  enter.append('rect').attr('class', 'mark-diamond node-shape');
  enter.append('text').attr('class', 'node-label');

  const all = enter.merge(nodeSel);
  const isPledge = (n) => n.level === 'pledge';
  // 상태는 색보다 '채움 밀도'가 먼저 말한다 — 색을 못 봐도 읽힌다
  const FILL = { good: 0.20, warning: 0.36, serious: 0.54, critical: 0.72 };

  all.select('circle.hit').attr('r', (n) => n.r + 4);  // 충돌반경(r+5)보다 작게 — 이웃의 hover 를 뺏지 않는다
  all.select('circle.halo').attr('r', (n) => n.r + 4);
  all.select('circle.pulse')
    .attr('r', (n) => n.r + 3)
    .style('display', (n) => (n.status === 'critical' && n.level === 'diagnosis' ? null : 'none'));

  all.select('circle.mark-outer')
    .attr('r', (n) => n.r + 4.5)
    .attr('fill', 'none')
    .attr('stroke', (n) => nodeFill(n))
    .attr('stroke-width', 0.9)
    .attr('stroke-opacity', 0.55)
    .style('display', (n) =>
      (n.status === 'critical' || n.level === 'domain' || n.level === 'city') ? null : 'none');

  all.select('circle.mark-ring')
    .style('display', (n) => (isPledge(n) ? 'none' : null))
    .attr('stroke-dasharray', (n) => (n.level === 'team' ? '2 2' : null))
    .attr('r', (n) => n.r)
    .attr('fill', 'none')
    .attr('stroke', nodeFill)
    .attr('stroke-width', (n) =>
      n.level === 'city' ? 2 : n.level === 'domain' ? 1.9 : n.level === 'sector' ? 1.7
        : n.level === 'team' ? 1 : 1.5);

  all.select('circle.mark-core')
    .style('display', (n) => (isPledge(n) ? 'none' : null))
    .attr('r', (n) => {
      if (n.level === 'city') return n.r * 0.30;
      if (n.level === 'domain') return n.r * 0.34;
      if (n.level === 'sector') return n.r * (0.26 + 0.34 * (FILL[n.status] ?? 0.3));
      if (n.level === 'team') return n.r * 0.34;
      return n.r * (FILL[n.status] ?? 0.25);
    })
    .attr('fill', nodeFill)
    .attr('fill-opacity', (n) => (n.status === 'critical' ? 0.88 : 0.74));

  // 공약은 마름모 — 색을 못 봐도 진단과 구분된다
  all.select('rect.mark-diamond')
    .style('display', (n) => (isPledge(n) ? null : 'none'))
    .attr('width', (n) => n.r * 1.42).attr('height', (n) => n.r * 1.42)
    .attr('x', (n) => -n.r * 0.71).attr('y', (n) => -n.r * 0.71)
    .attr('rx', 2.5)
    .attr('transform', 'rotate(45)')
    .attr('fill', (n) => n.color)
    .attr('fill-opacity', 0.16)
    .attr('stroke', (n) => n.color)
    .attr('stroke-width', 1.5);

  // 작은 점에도 라벨을 붙인다. 앞자리는 그 노드가 내건 값이다.
  all.select('text.node-label')
    .attr('class', (n) =>
      'node-label' + (n.level === 'city' ? ' node-label-xl'
        : n.level === 'domain' ? ' node-label-lg'
        : n.level === 'sector' ? ' node-label-md'
        : ' node-label-sm'))
    .attr('text-anchor', 'middle')
    .attr('y', (n) => n.r + 11)
    .style('font-size', (n) =>
      (n.level === 'city' ? 13.5 : n.level === 'domain' ? 12.5 : n.level === 'sector' ? 11
        : Math.max(7.5, Math.min(10, 5.6 + n.r * 0.17))) + 'px')
    .text((n) => `${nodeValue(n)}:${n.label}`);

  state.sim.on('tick', () => {
    // 선이 숨겨진 상태(선택 전)에서는 선 계산을 통째로 건너뛴다 — 노드가 400개를
    // 넘어가면 이 차이가 크다. 선택 시점에 refreshLinks() 로 한 번에 맞춘다.
    if (state.focus) refreshLinks();
    all.attr('transform', (n) => `translate(${n.x},${n.y})`);
  });

  applyVisibility();
  applyLabelVisibility();
}

/** 선의 기하와 그라데이션 좌표를 현재 노드 위치에 맞춘다. */
function refreshLinks() {
  gLink.selectAll('path.link').attr('d', taperPath);
  gLinkMark.selectAll('line')
    .attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
    .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
  gDefs.selectAll('linearGradient.lg')
    .attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
    .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
}

/** 노드 쪽 선 반폭. 연결이 많고 큰 노드일수록 두껍다. */
function endWidth(n) {
  return Math.max(0.35, Math.min(7, 0.105 * (n.r || 8) + 0.66 * Math.sqrt(n.deg || 1)));
}

/** 양끝 굵기가 다른 테이퍼 사각형. 굵은 쪽에서 얇은 쪽으로 자연스럽게 좁아진다. */
function taperPath(l) {
  const a = l.source, b = l.target;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const k = l.type === 'converge' ? 0.30 : l.type === 'resolves' ? 0.72 : 1;
  const wa = endWidth(a) * k, wb = endWidth(b) * k;
  return `M${(a.x + nx * wa).toFixed(1)},${(a.y + ny * wa).toFixed(1)}`
    + `L${(b.x + nx * wb).toFixed(1)},${(b.y + ny * wb).toFixed(1)}`
    + `L${(b.x - nx * wb).toFixed(1)},${(b.y - ny * wb).toFixed(1)}`
    + `L${(a.x - nx * wa).toFixed(1)},${(a.y - ny * wa).toFixed(1)}Z`;
}

/** 선의 색은 양끝 노드의 색을 잇는다 — 연결되면 양끝이 함께 블루로 물든다. */
function updateLinkPaint() {
  const lit = (n) => state.focus && state.actHops && state.actHops.has(n.id);
  const endColor = (n) => (lit(n) ? CONNECT : nodeFill(n));
  const alpha = (l) => {
    if (l.type === 'converge') return 0.26;
    if (l.type === 'resolves') return 0.62;
    return 0.8;
  };
  gDefs.selectAll('linearGradient.lg').each(function (l) {
    const g = d3.select(this);
    g.select('stop.g0').attr('stop-color', endColor(l.source)).attr('stop-opacity', alpha(l));
    g.select('stop.g1').attr('stop-color', endColor(l.target)).attr('stop-opacity', alpha(l));
  });
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
  const isLeaf = (n) => ['diagnosis', 'pledge', 'org', 'team'].includes(n.level);

  const matchesQuery = (n) => !q ||
    [n.label, n.detail, n.sectorLabel].filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));

  const inView = (n) => {
    if (n.level === 'org' || n.level === 'team') return state.showOrg;
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
  state.actHops = hop;
  if (hop) refreshLinks();

  // 애니메이션 재시작을 위해 클래스를 먼저 걷어낸다
  gNode.selectAll('g.node').classed('act', false);
  gLink.selectAll('path.link').classed('act', false);
  if (gNode.node()) gNode.node().getBoundingClientRect();

  gNode.selectAll('g.node')
    .classed('hidden-layer', (n) => (n.level === 'org' || n.level === 'team') && !state.showOrg)
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

  // 선택 전에는 선을 아예 그리지 않는다. 점만 남은 화면에서 노드를 누르는
  // 순간 그 노드의 망만 드러나게 하기 위해서다.
  const linkHidden = (l) => {
    if (!hop) return true;
    if (state.hiddenLinkTypes.has(l.type)) return true;
    if (!visible.has(l.source.id) || !visible.has(l.target.id)) return true;
    return !(hop.has(l.source.id) && hop.has(l.target.id));
  };
  gLink.selectAll('path.link').classed('hidden-layer', linkHidden).classed('dim', false);
  gLinkMark.selectAll('line').classed('hidden-layer', linkHidden);

  gLink.selectAll('path.link')
    .classed('act', (l) => {
      if (!hop || state.hiddenLinkTypes.has(l.type)) return false;
      const a = hop.get(l.source.id), b = hop.get(l.target.id);
      return a !== undefined && b !== undefined && Math.abs(a - b) === 1;
    })
    .each(function (l) {
      if (!this.classList.contains('act')) {
        this.style.removeProperty('--hop-delay');
        return;
      }
      const near = Math.min(hop.get(l.source.id), hop.get(l.target.id));
      this.style.setProperty('--hop-delay', (near * 0.105).toFixed(3) + 's');
    });

  updateLinkPaint();
}

function applyLabelVisibility() {
  const k = state.transform.k;
  // 작은 점에도 값을 붙여 보여준다. 너무 축소했을 때만 하위 라벨을 접는다.
  gNode.selectAll('text.node-label').style('display', (n) => {
    if (n.level === 'team') return state.showOrg && k >= 0.55 ? null : 'none';
    if (n.level === 'org') return state.showOrg && k >= 0.40 ? null : 'none';
    if (n.level === 'city' || n.level === 'domain') return null;
    if (n.level === 'sector') return k >= 0.3 ? null : 'none';
    if (state.focus === n.id) return null;
    return k >= 0.34 ? null : 'none';
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
    ['resolves', '해소', '#7e93a8', 'solid'],
    ['synergy', '시너지', '#4e8f79', 'solid'],
    ['dependency', '선후의존', '#5f7fae', 'dashed'],
    ['conflict', '상충', '#b8603f', 'dotted'],
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
  const ramp = ['#5c4a28', '#755d31', '#8f7139', '#aa8641', '#c59b49', '#e2b151', '#ffc75a'];
  $('#legend-body').innerHTML = `
    <div class="legend-group">
      <h4>노드 (모양)</h4>
      <div class="legend-cols">
        <div class="legend-item"><span class="legend-swatch legend-circle"></span>진단</div>
        <div class="legend-item"><span class="legend-swatch legend-diamond"></span>공약</div>
      </div>
      <div class="legend-item" style="margin-top:3px"><span class="legend-swatch legend-org"></span>행정조직(과)</div>
    </div>
    <div class="legend-group">
      <h4>값 — 클수록 밝은 골드</h4>
      <div class="legend-ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
      <div class="legend-ramp-cap"><span>낮음</span><span>높음</span></div>
    </div>
    <div class="legend-group">
      <h4>상태 · 연결</h4>
      <div class="legend-item"><span class="legend-swatch" style="background:${tx.status.find((s) => s.id === 'critical').color}"></span>위험 (링이 가득 참)</div>
      <div class="legend-item"><span class="legend-swatch" style="background:#43acfb"></span>연결됨 — 클릭 시 점등</div>
    </div>
    <div class="legend-group">
      <h4>관계</h4>
      <div class="legend-cols">
        <div class="legend-item"><span class="legend-taper"></span>굵기 = 연결량</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dashed rgba(255,255,255,.4)"></span>선후의존</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dotted ${tx.status.find((s) => s.id === 'critical').color}"></span>상충</div>
      </div>
    </div>
    <p class="legend-note">링이 <b>차오를수록</b> 위험이 크다. 선은 큰 노드 쪽이 두껍고 작은 노드 쪽으로 갈수록 얇아진다.</p>`;
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

  const kindTag = n.level === 'diagnosis' ? '진단' : n.level === 'pledge' ? '공약'
    : n.level === 'org' ? '과' : n.level === 'team' ? '팀' : null;
  const sub = n.level === 'diagnosis' ? `${n.sectorLabel} · ${n.no}번 진단`
    : n.level === 'pledge' ? `${n.sectorLabel}${n.round ? ` · ${n.round}차 브리핑` : ''}`
    : n.level === 'team' ? `${n.bureauName} · ${n.division}`
    : n.level === 'org' ? `${n.bureauName} · ${n.sectorLabel}`
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
    const tc = { synergy: '#4e8f79', dependency: '#5f7fae', conflict: '#b8603f' };
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
    const orgs = state.nodes.filter((o) => o.level === 'org' && o.sector === n.id);
    if (orgs.length) {
      const byBureau = new Map();
      for (const o of orgs) {
        if (!byBureau.has(o.bureauName)) byBureau.set(o.bureauName, []);
        byBureau.get(o.bureauName).push(o);
      }
      parts.push(`<div class="d-section"><h3>소관 행정조직 ${orgs.length}과</h3>${
        [...byBureau].map(([b, list]) => `<div class="org-bureau">
          <div class="org-b-name">${esc(b)}</div>
          ${list.map((o) => `<button class="lnk-item" data-goto="${o.id}">
            <span class="lnk-top"><span class="sev-dot is-square" style="background:none;border:1.2px solid var(--ink-2)"></span>
              <span>${esc(o.name)}</span></span>
            <span class="lnk-note">${esc(o.duty)}</span>
            <span class="org-teams">${o.teams.map((t) => `<i>${esc(t.name)}</i>`).join('')}</span>
          </button>`).join('')}
        </div>`).join('')}</div>`);
    }
    parts.push(`<div class="d-section"><h3>진단 전체 ${n.diagnoses.length}</h3>${n.diagnoses
      .slice().sort((a, b) => b.risk - a.risk)
      .map((d) => `<button class="lnk-item" data-goto="${d.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(d)}"></span>
          <span>${d.no}. ${esc(d.label)}</span></span>
        <span class="lnk-note">${st[d.status].icon} 잔여위험 ${d.risk.toFixed(0)} · 공약 ${d.coverage}건</span>
      </button>`).join('')}</div>`);
  }

  if (n.level === 'team') {
    parts.push(`<div class="d-section"><h3>소속</h3>
      <dl class="kv"><dt>국</dt><dd>${esc(n.bureauName)}</dd><dt>과</dt><dd>${esc(n.division)}</dd>
      <dt>섹터</dt><dd>${esc(n.sectorLabel)}</dd></dl></div>`);
    parts.push(`<div class="d-section"><h3>과 담당업무</h3><p class="d-detail" style="margin-left:0">${esc(n.duty)}</p>
      <p class="empty-note">팀 이름은 공식 조직도에 없어 담당업무에서 도출한 것이다.</p></div>`);
  }

  if (n.level === 'org') {
    parts.push(`<div class="d-section"><h3>담당 업무</h3><p class="d-detail" style="margin-left:0">${esc(n.duty)}</p></div>`);
    parts.push(`<div class="d-section"><h3>팀 ${n.teams.length}</h3>
      <div class="tags">${n.teams.map((t) => `<span class="tag">${esc(t.name)}</span>`).join('')}</div>
      <p class="empty-note" style="margin-top:8px">팀 이름은 공식 조직도에 공개돼 있지 않아 담당업무에서 도출한 것이다. 확인·교체가 필요하다.</p></div>`);
    const secs = (n.sectors || []).map((sid) => state.byId.get(sid)).filter(Boolean);
    parts.push(`<div class="d-section"><h3>연결된 섹터 ${secs.length}</h3>${secs
      .map((c) => `<button class="lnk-item" data-goto="${c.id}">
        <span class="lnk-top"><span class="sev-dot" style="background:${nodeFill(c)}"></span>
          <span>${esc(c.label)}</span></span>
        <span class="lnk-note">잔여위험 ${c.risk.toFixed(0)} · 위험 ${c.atRisk} · 미대응 ${c.uncovered}</span>
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
  const pad = 70;
  // 조직 레이어를 켜면 바깥 궤도가 넓어지므로 그만큼 범위를 넓힌다
  const edge = RING.outer + (state.showOrg ? 210 : 26);
  const ext = RING.cx + RING.R + edge;
  const [x0, x1] = [-ext - pad, ext + pad];
  const [y0, y1] = [-(RING.R + edge) - pad, RING.R + edge + pad];
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

  $('#brand-home').addEventListener('click', () => goHome());

  $('#toggle-org').addEventListener('click', (e) => {
    state.showOrg = !state.showOrg;
    e.currentTarget.classList.toggle('is-on', state.showOrg);
    applyVisibility();
    applyLabelVisibility();
  });

  $('#btn-reset').addEventListener('click', () => goHome());
  function goHome() {
    clearFocus();
    state.query = ''; $('#search').value = '';
    state.view = 'all';
    $$('.seg-btn').forEach((b) => b.classList.toggle('is-on', b.dataset.view === 'all'));
    state.hiddenStatus.clear(); state.hiddenLinkTypes.clear(); state.hiddenKinds.clear();
    state.showOrg = false;
    $$('.chip').forEach((c) => c.classList.add('is-on'));
    $('#toggle-org').classList.remove('is-on');
    applyVisibility();
    applyLabelVisibility();
    fitToScreen();
  }

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
   9-b. 신규 정책 입력 — 니즈 저장 → 자동 대조 → 망 편입
   ═════════════════════════════════════════════════════════════ */

function bindPolicyDialog() {
  const dlg = $('#dlg-policy');
  const form = $('#form-policy');
  let analysis = null;

  const payload = () => {
    const fd = new FormData(form);
    return {
      title: fd.get('title'), need: fd.get('need'), goal: fd.get('goal'),
      proposer: fd.get('proposer'),
      keywords: String(fd.get('keywords') || '').split(/[,\s]+/).filter(Boolean),
    };
  };

  const err = (msg) => {
    $('#policy-err').textContent = msg;
    $('#policy-err').hidden = !msg;
  };

  $('#btn-policy').addEventListener('click', () => {
    form.reset();
    analysis = null;
    $('#analyze-out').hidden = true;
    $('#analyze-hint').textContent = '입력 후 눌러 연결 지점을 확인하세요.';
    err('');
    dlg.showModal();
  });

  $('#btn-analyze').addEventListener('click', async () => {
    const body = payload();
    if (!body.title) return err('정책명을 입력해 주세요.');
    err('');
    $('#analyze-hint').textContent = '대조 중…';
    try {
      const res = await fetch('/api/proposals/analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '대조에 실패했습니다.');
      analysis = out.analysis;
      renderAnalysis(analysis);
      $('#analyze-hint').textContent = `확신도 ${analysis.confidence}`;
    } catch (e) { err(e.message); $('#analyze-hint').textContent = ''; }
  });

  function renderAnalysis(a) {
    const box = $('#analyze-out');
    const tx = state.raw.taxonomy;
    const secOpts = tx.sectors.map((s) =>
      `<option value="${s.id}"${s.id === a.sector ? ' selected' : ''}>${s.no}. ${esc(s.label)}</option>`).join('');
    const item = (x, checked) => `
      <label class="an-item">
        <input type="checkbox" value="${x.id}"${checked ? ' checked' : ''} />
        <span>${esc(x.label)}<span class="sub">${x.id}</span></span>
        <span class="sc">${(x.score * 100).toFixed(0)}%</span>
      </label>`;
    box.innerHTML = `
      <div class="an-head">
        진단 <b>${a.resolves.length}건</b>이 강하게 일치했습니다.
        ${a.needsReview ? '자동 판정이 확실하지 않아 <b>검토가 필요</b>합니다.' : ''}
      </div>
      <div class="an-sector"><span class="hint">소관 섹터</span><select id="an-sector">${secOpts}</select></div>
      <div class="an-group"><h4>자동 연결 — 해소 대상 진단</h4>
        ${a.resolves.length ? a.resolves.map((x) => item(x, true)).join('') : '<div class="an-none">강한 일치가 없습니다. 아래 후보에서 고르거나 Claude Code 로 넘기세요.</div>'}
      </div>
      ${a.candidates.length ? `<div class="an-group"><h4>검토 후보 — 필요하면 체크</h4>
        ${a.candidates.map((x) => item(x, false)).join('')}</div>` : ''}
      ${a.relatedPledges.length ? `<div class="an-group"><h4>유사한 기존 공약</h4>
        ${a.relatedPledges.map((x) => `<div class="an-item"><span>${esc(x.label)}<span class="sub">${x.id}</span></span><span class="sc">${(x.score * 100).toFixed(0)}%</span></div>`).join('')}</div>` : ''}`;
    box.hidden = false;
  }

  const chosen = () => $$('#analyze-out input[type=checkbox]:checked').map((el) => el.value);

  async function submit(defer) {
    const body = payload();
    if (!body.title) return err('정책명을 입력해 주세요.');
    if (!analysis) return err('먼저 "망과 대조하기"를 눌러 주세요.');
    const sel = $('#an-sector');
    body.sector = sel ? sel.value : analysis.sector;
    body.resolves = chosen();
    body.deferToClaude = defer;
    if (!defer && !body.resolves.length) return err('연결할 진단을 1개 이상 선택하거나, Claude Code 로 넘기세요.');
    err('');
    try {
      const res = await fetch('/api/proposals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || '저장에 실패했습니다.');
      dlg.close();
      if (out.handedOff) {
        alert(`저장했습니다. 자동 편입은 보류하고 Claude Code 로 넘겼습니다.

${out.inbox}

터미널에서:
  node tools/link-proposal.js --show ${out.proposal.id}`);
        return;
      }
      await reload();
      setFocus(out.pledge.id);
    } catch (e) { err(e.message); }
  }

  $('#btn-defer').addEventListener('click', () => submit(true));
  form.addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    submit(false);
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
  bindPolicyDialog();

  setTimeout(() => fitToScreen(700), 700);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;color:#ffb4b4">불러오기 실패: ${esc(err.message)}</div>`);
});
