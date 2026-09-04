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
   램프는 '연결 얽힘도'를 말한다. 얽힘이 적으면 무채색 그레이로 물러나고,
   얽힐수록 채도가 자라 골드에 가까워진다. 명도가 단조 증가하므로
   색을 못 봐도 밝기만으로 순서가 읽힌다.
   연결(점등)되면 블루로 바뀌고, 위험만 실버로 남는다.
   실버는 램프 전 단계와 색각이상 ΔE 15.5 이상 떨어져 있다. */
const TONE = ['#605f5c', '#776e5c', '#8e7d5b', '#a68d58', '#be9c52', '#d7ac49', '#f0bb3b'];
const CONNECT = '#43acfb';
const CONNECT_HI = '#76c7ff';
const ALARM = '#c4cbd4';   // 실버 — 경보 전용

/** 노드가 화면에 내거는 값. 라벨의 "값:이름" 에서 앞자리가 된다. */
function nodeValue(n) {
  if (n.level === 'pledge') return n.resolveCount || 0;
  if (n.level === 'org') return (n.teams || []).length;
  if (n.level === 'team') return n.deg || 1;
  return Math.round(n.risk ?? 0);
}

/** 특정 섹터의 솔루션(공약)을 따로 강조한다. taxonomy.highlight 로 설정한다. */
function highlightOf(n) {
  const h = state.raw && state.raw.taxonomy && state.raw.taxonomy.highlight;
  if (!h) return null;
  return (n.level === h.level && n.sector === h.sector) ? h : null;
}

/** 얽힘도 → 램프 단계. applyPriority() 에서 계산해 둔 tone 을 그대로 쓴다. */
function toneFor(n) {
  return TONE[Math.max(0, Math.min(TONE.length - 1, n.tone ?? 2))];
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
  layout: 'split',   // split = 좌 진단 / 우 공약, sector = 섹터별 묶음
  query: '',
  zoom: null,
  transform: d3.zoomIdentity,
  seqOn: false, seqIdx: 0, seqPairs: null, seqTimer: null, shownLinks: null, beam: null, emph: [],
  labelBand: null,
  uiOpen: false, uiTimers: [],
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

/* ── 좌우 고리 배치 ───────────────────────────────────────────
   로고 그대로다. 왼쪽 고리에 진단, 오른쪽 고리에 공약을 두르고,
   두 고리가 겹치는 렌즈 안에 시(市)와 12섹터가 앉는다.
   행정조직은 전체를 감싸는 바깥 고리에 둘러 좌우 대칭을 지킨다.
   같은 t 는 좌우가 같은 높이이므로, 같은 섹터의 진단과 공약이 마주 본다. */
const SPLIT = {
  // 두 원이 크게 겹치므로 고리 한 바퀴를 다 쓰면 40%가 렌즈 안으로 파고든다.
  // 노드는 바깥쪽 호(|t| ≤ 100°)에만 앉히고, 배경 원은 완전한 형태로 남긴다.
  // 그러면 서로 마주 보는 두 개의 C 자 — 로고 그대로가 된다.
  edge: 100,
  rows: [26, 9, -9, -26],
  orgR: 792,       // 조직을 두르는 바깥 고리
  teamR: 872,
  lensSquash: 0.62,
};

/** 12섹터를 고리 한 바퀴에 나눈다. t = -90 이 맨 위, 시계방향. */
function splitBands(sectors) {
  const ordered = sectors.slice().sort((a, b) => a.no - b.no);
  const span = (SPLIT.edge * 2) / ordered.length;
  const map = new Map();
  ordered.forEach((s, k) => {
    const t0 = -SPLIT.edge + k * span;
    map.set(s.id, { idx: k, n: ordered.length, t0: t0 + span * 0.06, t1: t0 + span * 0.94 });
  });
  return map;
}

/** 고리 위 한 자리. side -1 왼쪽(진단) / +1 오른쪽(공약) */
function bandPoint(band, i, total, side) {
  const t = band.t0 + ((i + 0.5) / Math.max(1, total)) * (band.t1 - band.t0);
  return ringPoint(side, t, SPLIT.rows[i % SPLIT.rows.length]);
}

/** 바깥 고리(조직) 한 자리 — 화면 중심 기준 원 */
function outerPoint(band, i, total, radius) {
  const t = band.t0 + ((i + 0.5) / Math.max(1, total)) * (band.t1 - band.t0);
  const a = deg(t);
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

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

/* ── 우선순위 · 도시발전 영향력 ──────────────────────────────
   점의 크기는 '연결이 많은가'가 아니라 '지금 중요한가'를 말해야 한다.
     진단 : 잔여위험(지금 급한가) + 구조적 심각도(구조를 흔드는가)
            + 파급(다른 섹터의 문제까지 물고 있는가)
     공약 : 걷어내는 위험 총량(풀면 얼마나 내려가는가)
            + 선행성(이게 막히면 뒤가 다 막히는가)
   크기는 세제곱 곡선으로 매핑해 상위 소수만 눈에 띄게 커진다.        */

function applyPriority(nodes, links, byId) {
  // 파급 — 다른 섹터로 뻗은 연관·해소 연결 수
  const reach = new Map();
  for (const l of links) {
    if (l.type === 'converge') continue;
    const a = byId.get(l.source), b = byId.get(l.target);
    if (!a || !b || a.sector === b.sector) continue;
    reach.set(a.id, (reach.get(a.id) || 0) + 1);
    reach.set(b.id, (reach.get(b.id) || 0) + 1);
  }
  // 선행성 — 이 공약이 선행조건이 되는 횟수
  const leads = new Map();
  for (const l of links) {
    if (l.type !== 'dependency') continue;
    leads.set(l.target, (leads.get(l.target) || 0) + 1);
  }

  /* 진단을 먼저 매긴다. 공약의 크기가 이 값을 물려받기 때문이다.
     진단 = 지금 남아 있는 위험 + 구조를 흔드는 정도 + 섹터를 넘는 파급.
     잔여위험 자체가 4축 평가(구조성·체감도·악화성·권한결여)에
     시민 신호(민원·보도·현장·시의회)를 얹고 대응만큼 깎은 값이다. */
  for (const n of nodes) {
    if (n.level !== 'diagnosis') continue;
    const spread = Math.min(1, (reach.get(n.id) || 0) / 5);
    n.priority = 0.55 * n.risk + 0.30 * (n.severity || 50) + 15 * spread;
  }

  /* 공약은 '가장 위협적인 문제를 겨냥했는가' 를 먼저 본다.
     예전에는 겨냥한 진단들의 심각도 '합' 만 봤다. 그러면 작은 문제 여럿을
     건드리는 공약이, 가장 큰 문제 하나를 정면으로 겨냥한 공약보다 커졌다.
     큰 점에 걸린 답이 작은 점으로 나와 누르기조차 어려웠던 이유다. */
  for (const n of nodes) {
    if (n.level !== 'pledge') continue;
    const hosts = (n.resolves || []).map((id) => byId.get(id)).filter(Boolean);
    const worst = hosts.reduce((m, d) => Math.max(m, d.priority || 0), 0);
    const relieved = hosts.reduce((a, d) => a + (d.severity || 0), 0);
    const lead = Math.min(1, (leads.get(n.id) || 0) / 3);
    n.priority = Math.min(100, 0.46 * worst + 0.10 * relieved + 14 * lead + 1.4 * (n.weight || 5));
  }

  for (const n of nodes) {
    if (n.level === 'sector') n.priority = 0.6 * n.risk + 4 * n.atRisk;
    else if (n.level !== 'diagnosis' && n.level !== 'pledge') n.priority = null;
  }

  /* ── 얽힘도(entanglement) → 색 단계 ─────────────────────────
     수렴축은 구조라 빼고, 실제 의미관계(해소·시너지·의존·상충·연관)만 센다.
     섹터를 넘어가는 연결은 얽힘이 더 깊다고 보고 0.5 를 더 얹는다.
     정책층(진단·공약) 안에서 백분위를 내 램프 7단계에 태우고,
     구조층(섹터·영역·시·과·팀)은 자기 위상에 맞는 단계를 고정으로 준다. */
  const relDeg = new Map();
  for (const l of links) {
    if (l.type === 'converge') continue;
    relDeg.set(l.source, (relDeg.get(l.source) || 0) + 1);
    relDeg.set(l.target, (relDeg.get(l.target) || 0) + 1);
  }
  for (const n of nodes) {
    n.entangle = (relDeg.get(n.id) || 0) + 0.5 * (reach.get(n.id) || 0);
  }

  const policy = nodes.filter((n) => n.level === 'diagnosis' || n.level === 'pledge');
  const sortedE = policy.slice().sort((a, b) => a.entangle - b.entangle);
  const eRank = new Map(sortedE.map((n, i) => [n.id, policy.length > 1 ? i / (policy.length - 1) : 0]));
  for (const n of policy) {
    n.entanglePct = eRank.get(n.id);
    // 얽힘이 아예 없는 노드는 최하단으로 확실히 내린다
    n.tone = n.entangle === 0 ? 0 : Math.round(n.entanglePct * 6);
  }
  for (const n of nodes) {
    if (n.level === 'team') n.tone = 0;
    else if (n.level === 'org') n.tone = 1;
    else if (n.level === 'sector') {
      const kids = [...n.diagnoses, ...n.pledges];
      n.tone = kids.length
        ? Math.round(kids.reduce((a, k) => a + (k.tone ?? 0), 0) / kids.length)
        : 2;
    }
  }
  for (const n of nodes) {
    if (n.level === 'domain') {
      const kids = n.children || [];
      n.tone = Math.min(6, (kids.length
        ? Math.round(kids.reduce((a, k) => a + (k.tone ?? 2), 0) / kids.length) : 3) + 1);
    } else if (n.level === 'city') n.tone = 6;
  }

  // 계층 안에서 순위백분위를 내고, 세제곱으로 눌러 상위만 크게
  /* [최소, 최대, 곡선]. 곡선이 클수록 상위만 두드러진다.
     진단은 2.6 으로 눌러 가장 위협적인 몇 개만 크게 남기고,
     공약은 1.7 로 완만히 둔다 — 답 쪽 점이 눌리지 않을 만큼은 되어야 한다. */
  const SIZE = {
    diagnosis: [6.5, 26, 2.6], pledge: [9, 25, 1.7], sector: [13, 26, 2.6],
  };
  for (const level of Object.keys(SIZE)) {
    const group = nodes.filter((n) => n.level === level && Number.isFinite(n.priority));
    if (!group.length) continue;
    const sorted = group.slice().sort((a, b) => a.priority - b.priority);
    const rank = new Map(sorted.map((n, i) => [n.id, group.length > 1 ? i / (group.length - 1) : 1]));
    const [lo, hi, curve] = SIZE[level];
    for (const n of group) {
      const pct = rank.get(n.id);
      n.rankPct = pct;
      n.r = lo + (hi - lo) * Math.pow(pct, curve);
      n.r0 = null;            // 강조로 부풀렸던 값이 있으면 버린다
      n.labelBoost = 1;
    }
  }
  // 강조 대상은 우선순위와 무관하게 가장 크게 — 시(市) 다음 크기다
  const hl = state.raw && state.raw.taxonomy && state.raw.taxonomy.highlight;
  if (hl) {
    for (const n of nodes) {
      if (n.level === hl.level && n.sector === hl.sector) n.r = hl.radius || 30;
    }
  }

  for (const n of nodes) {
    // 시(市)는 모든 축이 모이는 최종 수렴점이라 확실히 크게 둔다
    if (n.level === 'city') n.r = 40;
    else if (n.level === 'domain') n.r = 23;
    else if (n.level === 'org') n.r = 7.5;
    else if (n.level === 'team') n.r = 4.6;
  }
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
  const bands = splitBands(taxonomy.sectors);
  // 분리 배치에서 각 섹터가 몇 번째 항목을 앉혔는지 센다
  const seat = { diagnosis: new Map(), pledge: new Map(), org: new Map(), team: new Map() };
  const nextSeat = (kind, sid) => {
    const n = seat[kind].get(sid) || 0;
    seat[kind].set(sid, n + 1);
    return n;
  };
  const countBy = (arr, key) => arr.reduce((m, x) => m.set(x[key], (m.get(x[key]) || 0) + 1), new Map());
  const dgCount = countBy(diagnoses, 'sector');
  const plCount = countBy(pledges, 'sector');

  /** 분리 배치 좌표 — 해당 섹터의 고리 구간에 앉힌다 */
  const splitPoint = (sid, kind, side, total) => {
    const b = bands.get(sid);
    if (!b) return { x: 0, y: 0 };
    return bandPoint(b, nextSeat(kind, sid), total || 1, side);
  };

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
    tx: 0, ty: 0, sx: 0, sy: 0, fx: 0, fy: 0,
  });

  // ── 섹터 (피질과 백질 사이)
  for (const s of taxonomy.sectors) {
    const sp = spans.get(s.id);
    const p = ringPoint(sp.side, (sp.a0 + sp.a1) / 2, 0);
    const b = bands.get(s.id);
    // 분리 배치에서 섹터는 렌즈 안 세로 열에 선다. 가운데는 시(市) 자리로 비운다
    const half = b.n / 2;
    const up = b.idx < half;
    const j = up ? (half - 1 - b.idx) : (b.idx - half);
    const step = (RING.lensY * SPLIT.lensSquash - 70) / half;
    const sy = (up ? -1 : 1) * (70 + j * step + step / 2);
    const sx = (b.idx % 2 ? 1 : -1) * 34;
    nodes.push({
      id: s.id, level: 'sector', no: s.no, label: s.label, color: s.color,
      domain: s.domain, side: sp.side, span: sp, band: b,
      tx: p.x, ty: p.y, sx, sy, x: p.x, y: p.y,
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
      const sPt = splitPoint(sid, 'pledge', 1, plCount.get(sid));
      const degree = crossDeg.get(p.id) || 0;
      nodes.push({
        ...p,
        level: 'pledge', kind: 'pledge',
        color: sec.color, domain: sec.domain, sectorLabel: sec.label, side: sp.side,
        crossDeg: degree, resolveCount: (p.resolves || []).length,
        signals: [], status: null,
        r: 10,   // applyPriority() 가 우선순위 기준으로 다시 정한다
        tx: pt.x, ty: pt.y, sx: sPt.x, sy: sPt.y, x: pt.x, y: pt.y,
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
      const sPt = splitPoint(sid, 'diagnosis', -1, dgCount.get(sid));

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
        r: 10,   // applyPriority() 가 우선순위 기준으로 다시 정한다
        tx: pt.x, ty: pt.y, sx: sPt.x, sy: sPt.y, x: pt.x, y: pt.y,
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
    const teamSeatOf = new Map();
    const teamTotal = new Map();
    {
      const seen = new Set();
      for (const [sid, list] of bySec) for (const d of list) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        teamTotal.set(sid, (teamTotal.get(sid) || 0) + d.teams.length);
      }
    }
    for (const [sid, list] of bySec) {
      const sp = spans.get(sid);
      if (!sp) continue;
      list.forEach((d, i) => {
        const a = sp.a0 + ((i + 0.5) / list.length) * (sp.a1 - sp.a0);
        const pt = ringPoint(sp.side, a, RING.outer + 92 + 24 * (i % 2));
        const ob = bands.get(sid);
        const oPt = ob ? outerPoint(ob, i, list.length, SPLIT.orgR) : { x: 0, y: 0 };
        const orgNodeId = `${d.id}@${sid}`;
        nodes.push({
          ...d,
          id: orgNodeId, orgId: d.id,
          level: 'org', kind: 'org',
          label: d.name, sector: sid, sectorLabel: sectorById.get(sid).label,
          domain: sectorById.get(sid).domain, side: sp.side,
          status: null, signals: [],
          r: Math.max(7, Math.min(14, 6.5 + 1.1 * Math.sqrt(d.teams.length))),
          tx: pt.x, ty: pt.y, sx: oPt.x, sy: oPt.y, x: pt.x, y: pt.y,
        });

        // 팀은 과가 처음 등장한 섹터에만 매단다 (같은 팀이 중복되지 않게)
        if (teamSeen.has(d.id)) return;
        teamSeen.add(d.id);
        const span = (sp.a1 - sp.a0) / Math.max(1, list.length);
        d.teams.forEach((t, k) => {
          const ta = a + (k - (d.teams.length - 1) / 2) * (span * 0.62 / Math.max(1, d.teams.length));
          const tp = ringPoint(sp.side, ta, RING.outer + 168 + 20 * (k % 2));
          const tSeat = teamSeatOf.get(sid) || 0;
          teamSeatOf.set(sid, tSeat + 1);
          const tSp = ob ? outerPoint(ob, tSeat, teamTotal.get(sid) || 1, SPLIT.teamR) : { x: 0, y: 0 };
          nodes.push({
            id: t.id, level: 'team', kind: 'team',
            label: t.name, parentOrg: orgNodeId, division: d.name, bureauName: d.bureauName,
            sector: sid, sectorLabel: sectorById.get(sid).label,
            domain: sectorById.get(sid).domain, side: sp.side,
            duty: d.duty, status: null, signals: [],
            r: 5.2,
            tx: tp.x, ty: tp.y, sx: tSp.x, sy: tSp.y, x: tp.x, y: tp.y,
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
    s.r = 16;   // applyPriority() 가 우선순위 기준으로 다시 정한다
  }

  // 영역 노드는 소속 섹터의 무게중심을 중심 쪽으로 당겨 배치한다(뇌량 부근)
  for (const d of nodes.filter((n) => n.level === 'domain' || false)) { /* noop */ }
  taxonomy.domains.forEach((dom, i) => {
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
      tx: cx * 0.30, ty: cy * 0.34,
      // 분리 배치에서는 섹터 세로축 옆에 번갈아 세운다
      sx: (i % 2 ? 1 : -1) * 108,
      sy: kids.reduce((a, k) => a + (k.sy ?? 0), 0) / kids.length,
      x: cx * 0.30, y: cy * 0.34,
    });
  });
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

  const degree = new Map();
  for (const l of gLinks) {
    degree.set(l.source, (degree.get(l.source) || 0) + 1);
    degree.set(l.target, (degree.get(l.target) || 0) + 1);
  }
  for (const n of nodes) n.deg = degree.get(n.id) || 0;

  applyPriority(nodes, gLinks, byId2);
  return { nodes, links: gLinks, byId: byId2, sectorById };
}

/* ═════════════════════════════════════════════════════════════
   3. 시각 규칙
   ═════════════════════════════════════════════════════════════ */

const statusMeta = () => Object.fromEntries(state.raw.taxonomy.status.map((s) => [s.id, s]));

/** 지금 보고 있는 화면이 어느 빌드인지 로고 밑에 적는다.
 *  배포본이 갱신됐는지 새로고침만으로 확인할 수 있게 하기 위한 것이다. */
function stampBuild(raw) {
  const el = document.getElementById('build-tag');
  if (!el || !raw || !raw.version) return;
  el.textContent = ' · build ' + raw.version.commit;
  el.title = '서버 기동 ' + raw.version.startedAt;
}

function nodeFill(n) {
  const h = highlightOf(n);
  if (h) return h.color;
  if (n.status === 'critical') return ALARM;
  return toneFor(n);
}
const isAlerting = (n) => n.status === 'critical' || n.status === 'serious';

/* 노드의 치수를 한자리에 모은다. 그려 넣을 때도, 선택으로 한 점만
   부풀릴 때도 같은 함수를 쓴다 — 두 곳에 흩어 두면 반드시 어긋난다. */

// 상태는 색보다 '채움 밀도'가 먼저 말한다 — 색을 못 봐도 읽힌다
const FILL = { good: 0.20, warning: 0.36, serious: 0.54, critical: 0.72 };
const isPledge = (n) => n.level === 'pledge';
const isHub = (n) => n.level === 'domain' || n.level === 'city';

/** 라벨 크기는 점 크기를 따르되, 강조된 점은 labelBoost 만큼 더 키운다. */
function labelSize(n) {
  const base = n.level === 'city' ? 13.5 : n.level === 'domain' ? 12.5
    : n.level === 'sector' ? 11
    : Math.max(7.5, Math.min(10, 5.6 + n.r * 0.17));
  return base * (n.labelBoost || 1);
}

function sizeMarks(sel) {
  sel.select('circle.hit').attr('r', (n) => n.r + 4);
  sel.select('circle.halo').attr('r', (n) => n.r + 4);
  sel.select('circle.pulse')
    .attr('r', (n) => n.r + 3)
    .style('display', (n) => (n.status === 'critical' && n.level === 'diagnosis' ? null : 'none'));

  // 강조 노드는 점등되면 블루로 물들지 않고 제 색으로 꽉 찬다
  sel
    .classed('is-highlight', (n) => !!highlightOf(n))
    .style('--hl', (n) => (highlightOf(n) || {}).color || null);
  sel.select('circle.hl-fill')
    .attr('r', (n) => n.r * 0.9)
    .attr('fill', (n) => (highlightOf(n) || {}).color || 'none');

  sel.select('circle.ring-outer')
    .style('display', (n) => (n.status === 'critical' || isHub(n) ? null : 'none'))
    .attr('r', (n) => (isHub(n) ? n.r * 1.34 : n.r + 4.5))
    .attr('fill', 'none')
    .attr('stroke', nodeFill)
    .attr('stroke-width', (n) => (isHub(n) ? 1.3 : 0.9))
    .attr('stroke-opacity', (n) => (isHub(n) ? 0.62 : 0.55));

  sel.select('circle.mark-ring')
    .attr('r', (n) => n.r)
    .attr('fill', 'none')
    .attr('stroke', nodeFill)
    .attr('stroke-dasharray', (n) => (n.level === 'team' ? '2 2' : null))
    .attr('stroke-width', (n) =>
      n.level === 'city' ? 2.4 : n.level === 'domain' ? 2 : n.level === 'sector' ? 1.7
        : n.level === 'team' ? 1 : 1.5);

  sel.select('circle.ring-inner')
    .style('display', (n) => (isPledge(n) || isHub(n) ? null : 'none'))
    .attr('r', (n) => (isHub(n) ? n.r * 0.60 : n.r * 0.55))
    .attr('fill', 'none')
    .attr('stroke', nodeFill)
    .attr('stroke-width', (n) => (isHub(n) ? 1.5 : 1.3))
    .attr('stroke-opacity', (n) => (isHub(n) ? 0.85 : 0.9));

  sel.select('circle.mark-core')
    .style('display', (n) => (isPledge(n) || n.level === 'domain' || n.level === 'team' ? 'none' : null))
    .attr('r', (n) => {
      if (n.level === 'city') return n.r * 0.26;
      if (n.level === 'org') return n.r * 0.30;
      if (n.level === 'sector') return n.r * (0.26 + 0.34 * (FILL[n.status] ?? 0.3));
      return n.r * (FILL[n.status] ?? 0.25);
    })
    .attr('fill', nodeFill)
    .attr('fill-opacity', (n) => (n.status === 'critical' ? 0.88 : 0.74));

  // 작은 점에도 라벨을 붙인다. 앞자리는 그 노드가 내건 값이다.
  sel.select('text.node-label')
    .attr('class', (n) =>
      'node-label' + (n.level === 'city' ? ' node-label-xl'
        : n.level === 'domain' ? ' node-label-lg'
        : n.level === 'sector' ? ' node-label-md'
        : ' node-label-sm'))
    .attr('text-anchor', 'middle')
    .attr('y', (n) => n.r + 11)
    .style('font-size', (n) => labelSize(n) + 'px')
    .text((n) => `${nodeValue(n)}:${n.label}`);

}

function renderNodes(enter, nodeSel) {
  const all = enter.merge(nodeSel);

  /* 모양은 모두 원이다. 대신 링 개수로 계층을 말한다.
       팀     점선 링 하나
       과     링 하나 + 작은 점
       진단   링 하나 + 채움(채움 밀도 = 상태)
       공약   이중 링
       영역·시 삼중 동심원  */
  sizeMarks(all);
  return all;
}

/* ═════════════════════════════════════════════════════════════
   4. 캔버스
   ═════════════════════════════════════════════════════════════ */

const svg = d3.select('#graph');
let gRoot, gDefs, gBrain, gLink, gLinkMark, gSeq, gNode, gSeqTop, tooltipEl;

function initCanvas() {
  svg.selectAll('*').remove();
  gRoot = svg.append('g').attr('class', 'root');
  gDefs = gRoot.append('defs');
  gBrain = gRoot.append('g').attr('class', 'brain').attr('aria-hidden', 'true');
  gLink = gRoot.append('g').attr('class', 'links');
  gLinkMark = gRoot.append('g').attr('class', 'link-marks');
  gSeq = gRoot.append('g').attr('class', 'seq').attr('aria-hidden', 'true');
  gNode = gRoot.append('g').attr('class', 'nodes');
  gSeqTop = gRoot.append('g').attr('class', 'seq seq-top').attr('aria-hidden', 'true');
  tooltipEl = $('#tooltip');

  drawBackdrop();

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

/** 현재 배치에 맞는 배경을 그린다. */
function drawBackdrop() {
  gBrain.selectAll('*').remove();
  if (state.layout === 'split') drawSplitBackdrop();
  else drawRings();
}

/** 좌우 고리 배치의 배경 — 로고와 같은 두 고리, 그리고 조직을 감싸는 바깥 고리 */
function drawSplitBackdrop() {
  const { R, cx, lensY } = RING;

  const defs = gBrain.append('defs');
  const grad = defs.append('radialGradient').attr('id', 'lensGlow2');
  grad.append('stop').attr('offset', '0%').attr('stop-color', 'rgba(255,255,255,0.075)');
  grad.append('stop').attr('offset', '65%').attr('stop-color', 'rgba(255,255,255,0.02)');
  grad.append('stop').attr('offset', '100%').attr('stop-color', 'rgba(255,255,255,0)');

  gBrain.append('path').attr('class', 'lens-fill')
    .attr('d', `M0,${-lensY} A${R} ${R} 0 0 1 0,${lensY} A${R} ${R} 0 0 1 0,${-lensY} Z`);
  gBrain.append('ellipse').attr('class', 'lens-glow')
    .attr('cx', 0).attr('cy', 0).attr('rx', R - cx + 30).attr('ry', lensY * 0.8)
    .attr('fill', 'url(#lensGlow2)');

  for (const side of [-1, 1]) {
    gBrain.append('circle').attr('class', 'orbit orbit-main')
      .attr('cx', side * cx).attr('cy', 0).attr('r', R);
    for (const off of [SPLIT.rows[0], SPLIT.rows[2]]) {
      gBrain.append('circle').attr('class', 'orbit orbit-faint')
        .attr('cx', side * cx).attr('cy', 0).attr('r', R + off);
    }
  }

  if (state.showOrg) {
    for (const r of [SPLIT.orgR, SPLIT.teamR]) {
      gBrain.append('circle').attr('class', 'orbit orbit-faint')
        .attr('cx', 0).attr('cy', 0).attr('r', r);
    }
  }

  gBrain.append('path').attr('class', 'lens-edge')
    .attr('d', `M0,${-lensY} A${R} ${R} 0 0 1 0,${lensY} A${R} ${R} 0 0 1 0,${-lensY} Z`);

  gBrain.append('text').attr('class', 'side-label')
    .attr('x', -(cx + R) - 34).attr('y', 0).attr('text-anchor', 'middle')
    .attr('transform', `rotate(-90 ${-(cx + R) - 34} 0)`)
    .text('진단 — 문제');
  gBrain.append('text').attr('class', 'side-label')
    .attr('x', cx + R + 34).attr('y', 0).attr('text-anchor', 'middle')
    .attr('transform', `rotate(90 ${cx + R + 34} 0)`)
    .text('공약 — 해법');
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

/** 현재 배치 모드의 목표 좌표 */
function targetOf(n) {
  return state.layout === 'split'
    ? { x: n.sx ?? n.tx ?? 0, y: n.sy ?? n.ty ?? 0 }
    : { x: n.tx ?? 0, y: n.ty ?? 0 };
}

/** 위치력의 세기 — 배치를 유지해야 하므로 계층별로 강하게 준다. */
const pullStrength = (n) =>
    n.level === 'city' ? 1 : n.level === 'domain' ? 0.6
      : n.level === 'sector' ? 0.55 : (n.level === 'org' || n.level === 'team') ? 0.55 : 0.34;

/** 배치를 바꾼다. 두 가지를 함께 해야 실제로 옮겨진다.
 *  ① d3 의 forceX/forceY 는 접근자를 초기화 때만 읽으므로 힘을 새로 넣는다.
 *  ② 노드를 새 목표 근처로 바로 옮긴다 — 400개가 화면을 가로질러 날아가는 데
 *     수백 프레임이 걸려 전환이 느리게 느껴지기 때문이다. 이후 국소 정렬만 시킨다. */
function retarget(snap = true) {
  state.seqPairs = null;
  if (!state.sim) return;
  if (snap) {
    for (const n of state.nodes) {
      if (n.fx != null) continue;               // 고정 노드(시)는 그대로
      const t = targetOf(n);
      n.x = t.x + (Math.random() - 0.5) * 12;
      n.y = t.y + (Math.random() - 0.5) * 12;
      n.vx = 0; n.vy = 0;
    }
  }
  state.sim.force('x', d3.forceX((n) => targetOf(n).x).strength(pullStrength));
  state.sim.force('y', d3.forceY((n) => targetOf(n).y).strength(pullStrength));
  state.sim.alpha(0.5).restart();
}

function simulate() {
  const pull = pullStrength;

  state.sim = d3.forceSimulation(state.nodes)
    .force('link', d3.forceLink(state.links).id((d) => d.id)
      .distance((l) => (l.type === 'converge' ? 130 : l.type === 'resolves' ? 150 : 170))
      .strength((l) => (l.type === 'converge' ? 0.05 : 0.02)))
    .force('charge', d3.forceManyBody().strength(-90).distanceMax(240))
    .force('collide', d3.forceCollide().radius((n) => n.r + 5).iterations(3))
    .force('x', d3.forceX((n) => targetOf(n).x).strength(pull))
    .force('y', d3.forceY((n) => targetOf(n).y).strength(pull))
    .alpha(1).alphaDecay(0.028);
}

function render() {
  const st = statusMeta();

  // 연결선은 단순 직선이 아니라 양끝 굵기가 다른 테이퍼 도형이다.
  // 연결이 많고 큰 노드 쪽이 두껍고, 작은 노드 쪽으로 갈수록 얇아진다.
  const linkKey = (l) => `${l.source.id ?? l.source}|${l.target.id ?? l.target}|${l.type}`;

  // 선에는 그라데이션을 쓰지 않는다. 색은 은빛 하나이므로 CSS 가 정한다.
  gDefs.selectAll('linearGradient.lg').remove();

  const linkSel = gLink.selectAll('path.link').data(state.links, linkKey);
  linkSel.exit().remove();
  linkSel.enter().append('path')
    .attr('class', (l) => `link link-${l.type}`)
    .merge(linkSel)
    .attr('fill', 'none')
    .attr('stroke-width', linkWidth);   // 색·점선·선끝은 CSS 에서 한 벌로 정한다

  // 채움 도형만으로는 관계 유형이 구분되지 않는다. 파선·점선 중심선을 덧그린다.
  const marked = state.links.filter((l) => l.type === 'dependency' || l.type === 'conflict');
  const markSel = gLinkMark.selectAll('line').data(marked, linkKey);
  markSel.exit().remove();
  markSel.enter().append('line')
    .attr('class', (l) => `link-mark mark-${l.type}`);

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
  enter.append('circle').attr('class', 'hl-fill');   // 강조 노드가 점등되면 꽉 찬다
  enter.append('circle').attr('class', 'ring-outer');            // 바깥 링 (위험 경보 · 영역/시)
  enter.append('circle').attr('class', 'mark-ring node-shape');  // 본 링
  enter.append('circle').attr('class', 'ring-inner node-shape'); // 안쪽 링 (공약 · 영역/시)
  enter.append('circle').attr('class', 'mark-core');             // 채움 = 상태
  enter.append('text').attr('class', 'node-label');

  const all = renderNodes(enter, nodeSel);

  state.labelBand = null;   // 라벨을 새로 지었으니 캐시는 버린다

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
/** 그려지는 선만 고른다. 숨은 선의 좌표·색은 다시 드러날 때 맞춰도 늦지 않다. */
const drawnOnly = () => {
  const set = state.shownLinks;
  return set ? (l) => set.has(l) : () => true;
};

function refreshLinks() {
  const keep = drawnOnly();
  gLink.selectAll('path.link').filter(keep).attr('d', linePath);
  gLinkMark.selectAll('line').filter(keep)
    .attr('x1', (l) => l.source.x).attr('y1', (l) => l.source.y)
    .attr('x2', (l) => l.target.x).attr('y2', (l) => l.target.y);
}

/** 선은 관계가 있다는 사실만 알리면 된다. 굵기에 의미를 싣지 않고
 *  육안으로 보이는 최소 두께의 실선으로 긋는다. */
/* non-scaling-stroke 를 걸었으므로 이 값이 곧 화면 픽셀이다.
   굵기에 의미를 싣지 않되, 육안으로 보이는 최소선은 넘긴다. */
/* 지금의 1/5. 화면 픽셀 단위이므로 이 값은 1픽셀의 5분의 1쯤 되는 실오라기다.
   그만큼 옅어지는 것을 진하기를 끌어올려 메운다 — 폭이 0.2px 면 같은 색이라도
   화면에 남는 양이 5분의 1이기 때문이다. */
const LINE_W = {
  converge: 0.16, affinity: 0.16, resolves: 0.18,
  synergy: 0.18, dependency: 0.18, conflict: 0.2,
};
const linkWidth = (l) => LINE_W[l.type] ?? 0.8;

function linePath(l) {
  return `M${l.source.x.toFixed(1)},${l.source.y.toFixed(1)}`
    + `L${l.target.x.toFixed(1)},${l.target.y.toFixed(1)}`;
}

/* 선의 색은 은빛 하나다. 유형은 색이 아니라 진하기와 점선 간격으로 갈린다.
   — 모두 CSS 에 있다. 여기서 매번 다시 칠할 것이 없다. */

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

  // 선택 전에는 선을 아예 그리지 않는다. 점만 남은 화면에서 노드를 누르는
  // 순간 그 노드의 망만 드러나게 하기 위해서다.
  const linkHidden = (l) => {
    if (!hop) return true;
    if (state.hiddenLinkTypes.has(l.type)) return true;
    if (!visible.has(l.source.id) || !visible.has(l.target.id)) return true;
    return !(hop.has(l.source.id) && hop.has(l.target.id));
  };
  // 좌표와 색을 실제로 그려지는 선에만 쓴다. 662개를 전부 건드리면
  // 그 662개의 그라데이션이 모두 무효화되어 한 프레임이 통째로 밀린다.
  state.shownLinks = new Set();
  for (const l of state.links) if (!linkHidden(l)) state.shownLinks.add(l);

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

}

/* 라벨의 보임·숨김은 배율의 몇 개 문턱에서만 갈린다. 줌 전환은 매 프레임
   배율을 바꾸지만, 문턱을 넘지 않았다면 410개 텍스트에 다시 쓸 이유가 없다.
   그 한 줄이 화면 전개 구간의 프레임을 통째로 잡아먹고 있었다. */
const LABEL_BREAKS = [0.3, 0.34, 0.4, 0.55];

function applyLabelVisibility(force) {
  const k = state.transform.k;
  const band = LABEL_BREAKS.reduce((c, b) => c + (k >= b ? 1 : 0), 0)
    + '|' + (state.showOrg ? 1 : 0) + '|' + (state.focus || '');
  if (!force && band === state.labelBand) return;
  state.labelBand = band;
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
   5-b. 대기 시퀀스 — 문제에서 해법으로
   ─────────────────────────────────────────────────────────────
   아무것도 고르지 않은 화면에서 스스로 도는 루프다.
   왼쪽 고리의 진단(문제)이 깜빡이고, 그 진단을 겨냥한 공약으로
   점선이 그라데이션을 끌고 건너가면, 오른쪽 공약이 크게 깜빡인다.
   한 박에 한 쌍씩, 끝나면 다음 쌍으로 넘어가 끝없이 돈다.
   ═════════════════════════════════════════════════════════════ */

/* 박자 배속 — 1 이 원래 속도. 깜빡임·라벨·파문·머무는 시간이 이 값만큼 늘어난다.
   CSS 의 깜빡임 길이도 --seq-t 로 같은 값을 받는다.
   travel(선을 건너가는 시간)만 예외로 원래 속도를 지킨다 — 그 속도는 그대로가 좋다.
   한 박이 약 3.5초에서 약 7.5초가 된다. */
const SEQ_T = 2.3;
const ms = (v) => Math.round(v * SEQ_T);
/* blinkA(진단 깜빡임)와 travel(선 이동)은 배속 바깥에 둔 고정값이다.
   lead 는 선이 출발하는 시점이라 깜빡임 길이와 따로 잡는다. */
const SEQ = { travel: 1500, blinkA: 1500, lead: ms(405), hold: 2600, gap: 1100 };
const BLINK_B = Math.round(620 * 3 * SEQ_T);   // CSS 의 seq-blink-b × 3 회
const SEQ_GRAY = '#6f6d69';   // --ink-3. 속성 보간에는 var() 가 아니라 실제 값이 필요하다

/** 진단 → 그 진단을 겨냥한 공약. '가장 직접적인' 순으로 세운다.
 *  겨냥하는 공약이 적은 진단일수록 그 한 줄이 직접적이고,
 *  같은 조건이면 잔여위험이 큰 진단을 앞에 둔다. */
function buildSeqPairs() {
  const byDiag = new Map();
  for (const l of state.links) {
    if (l.type !== 'resolves') continue;
    const p = l.source.id ? l.source : state.byId.get(l.source);   // resolves 는 공약 → 진단
    const d = l.target.id ? l.target : state.byId.get(l.target);
    if (!p || !d) continue;
    if (!byDiag.has(d.id)) byDiag.set(d.id, { d, ps: [] });
    byDiag.get(d.id).ps.push(p);
  }
  const pairs = [];
  for (const { d, ps } of byDiag.values()) {
    ps.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    pairs.push({ d, p: ps[0], direct: ps.length, risk: d.residual ?? d.severity ?? 0 });
  }
  pairs.sort((a, b) => a.direct - b.direct || b.risk - a.risk);
  return pairs;
}

/* ── 선택한 점과 반대쪽 짝을 잇는 한 줄 ──────────────────
   나머지 선이 은빛 실오라기로 물러난 자리에서, 이 한 줄만 점화색으로 남는다.
   진단을 고르면 그 문제를 가장 곧게 겨냥한 공약이, 공약을 고르면 그 공약이
   가장 곧게 겨냥한 진단이 깜빡인다. */

/** 반대쪽에서 가장 강하게 맞물린 짝. 진단 ↔ 공약만 본다. */
function strongestCounterpart(n) {
  if (!n || (n.level !== 'diagnosis' && n.level !== 'pledge')) return null;
  const out = [];
  for (const l of state.links) {
    if (l.type !== 'resolves') continue;
    const pl = l.source, dg = l.target;           // resolves 는 공약 → 진단
    if (!pl || !dg || !pl.id || !dg.id) continue;
    if (n.level === 'diagnosis' && dg.id === n.id) out.push(pl);
    if (n.level === 'pledge' && pl.id === n.id) out.push(dg);
  }
  if (!out.length) return null;
  // 겨냥하는 상대가 적을수록 그 한 줄이 직접적이다. 같으면 우선순위가 높은 쪽.
  const span = (x) => (x.level === 'pledge' ? (x.resolveCount || 1) : (x.coverage || 1));
  out.sort((a, b) => span(a) - span(b) || (b.priority || 0) - (a.priority || 0));
  return out[0];
}

/* 고른 점과 그 짝은 한동안 크게 둔다. 원래 크기는 r0 에 넣어 두었다가
   초점이 풀리면 그대로 되돌린다. 라벨도 함께 커진다. */
const EMPH = { self: [1.35, 1.75], mate: [1.9, 1.9] };   // [점 배율, 라벨 배율]

function emphasize(n, [rk, lk]) {
  if (!n) return;
  if (n.r0 == null) n.r0 = n.r;
  n.r = n.r0 * rk;
  n.labelBoost = lk;
  sizeMarks(seqNode(n));
  (state.emph = state.emph || []).push(n);
}

function unemphasize() {
  for (const n of state.emph || []) {
    if (n.r0 != null) { n.r = n.r0; n.r0 = null; }
    n.labelBoost = 1;
    sizeMarks(seqNode(n));
  }
  state.emph = [];
}

function clearBeam() {
  unemphasize();
  if (gSeq) gSeq.selectAll('.beam, .beam-glow').interrupt().remove();
  if (gDefs) gDefs.select('#beam-grad').remove();
  if (gNode) gNode.selectAll('g.node.beam-b').classed('beam-b', false).style('--beam', null);
  state.beam = null;
}

/** a(고른 점) → b(짝) 를 잇는 점화색 그라데이션 한 줄. */
function drawBeam(a, b) {
  clearBeam();
  if (!a || !b || a.x == null || b.x == null) return;

  const base = CONNECT;      // 점화색은 블루 하나다. 오렌지는 강조한 공약 자신에게만 쓴다
  const tip = CONNECT_HI;

  const grad = gDefs.append('linearGradient')
    .attr('id', 'beam-grad').attr('gradientUnits', 'userSpaceOnUse')
    .attr('x1', a.x).attr('y1', a.y).attr('x2', b.x).attr('y2', b.y);
  grad.append('stop').attr('offset', '0%').attr('stop-color', base).attr('stop-opacity', 0.30);
  grad.append('stop').attr('offset', '45%').attr('stop-color', base).attr('stop-opacity', 0.85);
  grad.append('stop').attr('offset', '100%').attr('stop-color', tip).attr('stop-opacity', 1);

  // 고른 문제와 그 답을 둘 다 키운다. 답 쪽이 더 크다 — 눌러야 할 점이므로.
  emphasize(a, EMPH.self);
  emphasize(b, EMPH.mate);

  const d = `M${a.x},${a.y}L${b.x},${b.y}`;
  gSeq.append('path').attr('class', 'beam-glow').attr('d', d).attr('stroke', 'url(#beam-grad)');
  gSeq.append('path').attr('class', 'beam').attr('d', d).attr('stroke', 'url(#beam-grad)')
    .attr('opacity', 0).transition().duration(360).attr('opacity', 1);

  seqNode(b).classed('beam-b', true).style('--beam', tip);
  state.beam = { a: a.id, b: b.id };
}

function seqStop() {
  clearBeam();
  state.seqOn = false;
  clearTimeout(state.seqTimer);
  for (const g of [gSeq, gSeqTop]) {
    if (g) { g.interrupt(); g.selectAll('*').interrupt().remove(); }
  }
  gNode.selectAll('g.node.seq-a, g.node.seq-b').classed('seq-a', false).classed('seq-b', false);
}

function seqStart() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  seqStop();
  if (!state.seqPairs || !state.seqPairs.length) state.seqPairs = buildSeqPairs();
  if (!state.seqPairs.length) return;
  // 들어올 때마다 다른 쌍에서 시작한다 — 늘 같은 장면으로 열리지 않도록
  if (state.seqIdx === 0) state.seqIdx = Math.floor(Math.random() * state.seqPairs.length);
  document.documentElement.style.setProperty('--seq-t', SEQ_T);
  document.documentElement.style.setProperty('--seq-a', SEQ.blinkA + 'ms');
  state.seqOn = true;
  state.seqTimer = setTimeout(seqBeat, ms(400));
}

const seqNode = (n) => gNode.selectAll('g.node').filter((d) => d.id === n.id);

/** 깜빡이는 점의 이름을 위에 크게 띄웠다가, 깜빡임이 잦아드는 박자에 맞춰
 *  아래로 내리며 그레이로 지운다. 글자 크기는 배율과 무관하게 일정하다. */
function seqLabel(n, delay, color) {
  const k = state.transform.k || 1;
  const up = 22 / k;                     // 화면 기준 22px 만큼 위
  const down = n.r + 11 + 15 / k;        // 제자리 라벨보다 한 칸 아래
  gSeqTop.append('text')          // 노드 위 레이어 — 어떤 원에도 가리지 않는다
    .attr('class', 'seq-label')
    .attr('x', n.x)
    .attr('y', n.y - n.r - up)
    .attr('text-anchor', 'middle')
    .style('font-size', (21 / k).toFixed(2) + 'px')
    .attr('fill', color)
    .attr('opacity', 0)
    .text(`${nodeValue(n)}:${n.label}`)
    .transition('in').delay(delay).duration(ms(260)).attr('opacity', 1)
    .transition('out').delay(ms(480)).duration(ms(1000)).ease(d3.easeCubicInOut)
      .attr('y', n.y + down)
      .style('font-size', (10.5 / k).toFixed(2) + 'px')
      .attr('fill', SEQ_GRAY)
      .attr('opacity', 0)
      .remove();
}

/** 한 점에서 파문이 번졌다 사라진다. */
function seqPing(n, color, grow, delay, dur) {
  gSeq.append('circle')
    .attr('class', 'seq-ping')
    .attr('cx', n.x).attr('cy', n.y).attr('r', n.r * 0.9)
    .attr('stroke', color)
    .attr('opacity', 0.85)
    .transition().delay(delay).duration(dur).ease(d3.easeCubicOut)
    .attr('r', n.r * grow).attr('opacity', 0)
    .remove();
}

function seqBeat() {
  if (!state.seqOn) return;

  const pair = state.seqPairs[state.seqIdx++ % state.seqPairs.length];
  const a = pair.d, b = pair.p;
  if (a.x == null || b.x == null) { state.seqTimer = setTimeout(seqBeat, 300); return; }

  gSeq.selectAll('*').interrupt().remove();
  gSeqTop.selectAll('*').interrupt().remove();

  const hl = highlightOf(b);
  const endTone = hl ? hl.color : TONE[6];

  // ① 문제가 깜빡인다
  seqNode(a).classed('seq-a', true);
  seqPing(a, ALARM, 2.4, 0, 780);
  seqPing(a, ALARM, 2.0, 380, 740);
  seqLabel(a, 0, ALARM);

  // ② 점선이 그라데이션을 끌고 해법으로 건너간다
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;
  const band = Math.max(70, L * 0.4);

  const grad = gDefs.select('#seq-grad').empty()
    ? gDefs.append('linearGradient').attr('id', 'seq-grad').attr('gradientUnits', 'userSpaceOnUse')
    : gDefs.select('#seq-grad');
  grad.selectAll('stop').remove();
  grad.append('stop').attr('offset', '0%').attr('stop-color', ALARM).attr('stop-opacity', 0);
  grad.append('stop').attr('offset', '45%').attr('stop-color', ALARM).attr('stop-opacity', 0.95);
  grad.append('stop').attr('offset', '75%').attr('stop-color', endTone).attr('stop-opacity', 0.95);
  grad.append('stop').attr('offset', '100%').attr('stop-color', endTone).attr('stop-opacity', 0);

  // 밴드의 앞머리가 a 를 떠나 b 를 지날 때까지 미끄러진다
  const slide = (t) => {
    const head = -band + t * (L + band);
    grad.attr('x1', a.x + ux * head).attr('y1', a.y + uy * head)
        .attr('x2', a.x + ux * (head + band)).attr('y2', a.y + uy * (head + band));
  };
  slide(0);

  const d = `M${a.x},${a.y}L${b.x},${b.y}`;
  const glow = gSeq.append('path')          // 점선 밑에 깔리는 옅은 번짐
    .attr('class', 'seq-line glow')
    .attr('d', d).attr('stroke', 'url(#seq-grad)').attr('opacity', 0);
  const line = gSeq.append('path')
    .attr('class', 'seq-line')
    .attr('d', d).attr('stroke', 'url(#seq-grad)').attr('opacity', 0);

  const lead = SEQ.lead;
  glow.transition('in').delay(lead).duration(ms(240)).attr('opacity', 0.18);
  line.transition('in').delay(lead).duration(ms(240)).attr('opacity', 1);
  line.transition('band').delay(lead).duration(SEQ.travel).ease(d3.easeCubicInOut)
    .tween('band', () => slide);

  // ③ 해법이 크게 깜빡인다
  const bAt = SEQ.blinkA * 0.45 + SEQ.travel * 0.82;
  state.seqTimer = setTimeout(() => {
    if (!state.seqOn) return;
    seqNode(b).classed('seq-b', true);
    seqPing(b, endTone, 3.1, 0, ms(900));
    seqPing(b, endTone, 2.6, ms(340), ms(860));
    seqPing(b, endTone, 2.2, ms(680), ms(820));
    seqLabel(b, 0, endTone);

    line.transition('out').delay(SEQ.hold).duration(ms(420)).attr('opacity', 0).remove();
    glow.transition('out').delay(SEQ.hold).duration(ms(420)).attr('opacity', 0).remove();

    state.seqTimer = setTimeout(() => {
      seqNode(a).classed('seq-a', false);
      seqNode(b).classed('seq-b', false);
      state.seqTimer = setTimeout(seqBeat, SEQ.gap);
    }, Math.max(SEQ.hold + ms(420), BLINK_B));
  }, bAt);
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
  if (Number.isFinite(n.entangle) && (n.level === 'diagnosis' || n.level === 'pledge')) {
    out.push(`<div class="tt-row"><span>연결 얽힘도</span><b>${n.entangle.toFixed(1)}<span style="color:var(--ink-3)"> · 상위 ${(100 - (n.entanglePct ?? 0) * 100).toFixed(0)}%</span></b></div>`);
  }
  if (Number.isFinite(n.priority)) {
    out.push(`<div class="tt-row"><span>우선순위</span><b>${n.priority.toFixed(0)}<span style="color:var(--ink-3)"> · 상위 ${(100 - n.rankPct * 100).toFixed(0)}%</span></b></div>`);
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
  seqStop();                 // 고른 게 있으면 대기 시퀀스는 물러난다
  state.focus = id;
  applyVisibility();         // 점화 — 이 프레임은 이것만 한다
  applyLabelVisibility();
  $$('.sector-row').forEach((el) => el.classList.toggle('is-on', el.dataset.id === id));

  const n = state.byId.get(id);
  drawBeam(n, strongestCounterpart(n));       // 반대쪽 짝으로 가는 한 줄만 점화색으로

  if (state.uiOpen) renderDetail(n);
  else revealChrome(() => renderDetail(n));   // 오른쪽 바가 열리는 차례에 그린다
}

function clearFocus() {
  state.focus = null;
  seqStart();
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

  // 선은 전부 은빛 점선이다. 유형은 진하기로만 갈린다.
  const lt = [
    ['resolves', '해소', 'rgba(196,203,212,.75)', 'dotted'],
    ['synergy', '시너지', 'rgba(196,203,212,.6)', 'dotted'],
    ['dependency', '선후의존', 'rgba(196,203,212,.6)', 'dashed'],
    ['conflict', '상충', 'rgba(196,203,212,.6)', 'dotted'],
    ['converge', '수렴축', 'rgba(196,203,212,.32)', 'dotted'],
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
  const ramp = TONE;
  $('#legend-body').innerHTML = `
    <div class="legend-group">
      <h4>노드 — 링 개수가 계층이다</h4>
      <div class="legend-item"><span class="lg-mark lg-diag"></span>진단 · 링 + 채움</div>
      <div class="legend-item"><span class="lg-mark lg-pledge"></span>공약 · 이중 링</div>
      <div class="legend-item"><span class="lg-mark lg-hub"></span>영역 · 시 · 삼중 동심원</div>
      <div class="legend-item"><span class="lg-mark lg-org"></span>과 · 팀</div>
    </div>
    <div class="legend-group">
      <h4>연결 얽힘도</h4>
      <div class="legend-ramp">${ramp.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
      <div class="legend-ramp-cap"><span>그레이 · 얽힘 적음</span><span>골드 · 많음</span></div>
    </div>
    <div class="legend-group">
      <h4>상태 · 연결</h4>
      <div class="legend-item"><span class="legend-swatch" style="background:${tx.status.find((s) => s.id === 'critical').color}"></span>위험 · 실버 (링이 가득 참)</div>
      <div class="legend-item"><span class="legend-swatch" style="background:#43acfb"></span>연결됨 — 클릭 시 점등</div>
      ${tx.highlight ? `<div class="legend-item"><span class="legend-swatch" style="background:${tx.highlight.color}"></span>${esc(tx.highlight.label)} — 강조</div>` : ''}
    </div>
    <div class="legend-group">
      <h4>관계</h4>
      <div class="legend-cols">
        <div class="legend-item"><span class="legend-stroke" style="border-top:1px solid rgba(255,255,255,.45)"></span>연결 있음</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dashed rgba(255,255,255,.4)"></span>선후의존</div>
        <div class="legend-item"><span class="legend-stroke" style="border-top:2px dotted ${tx.status.find((s) => s.id === 'critical').color}"></span>상충</div>
      </div>
      <p class="legend-note" style="margin-top:5px">선은 관계가 있다는 사실만 알린다. 굵기에 의미를 싣지 않는다.</p>
    </div>
    <p class="legend-note"><b>크기 = 우선순위</b>(잔여위험·구조심각도·파급), <b>색 = 연결 얽힘도</b>.
      둘은 서로 다른 것을 말한다 — 작지만 골드인 점은 덜 급하지만 많이 얽힌 지점이다.</p>`;
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
        <dt>우선순위 지수</dt><dd>${n.priority.toFixed(0)} <span style="color:var(--ink-3)">(상위 ${(100 - n.rankPct * 100).toFixed(0)}%)</span></dd>
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

/** 지금 배치를 화면에 꽉 채우는 변환. 캔버스가 아직 없으면 null. */
function fitTransform() {
  const rect = svg.node().getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) return null;
  const pad = 70;
  let x0, x1, y0, y1;
  if (state.layout === 'split') {
    const ext = state.showOrg ? SPLIT.teamR + 40 : RING.cx + RING.R + 60;
    [x0, x1] = [-ext - pad, ext + pad];
    [y0, y1] = [-ext - pad, ext + pad];
  } else {
    const edge = RING.outer + (state.showOrg ? 210 : 40);
    const ext = RING.cx + RING.R + edge;
    [x0, x1] = [-ext - pad, ext + pad];
    [y0, y1] = [-(RING.R + edge) - pad, RING.R + edge + pad];
  }
  const k = Math.min(rect.width / (x1 - x0), rect.height / (y1 - y0), 1.6);
  if (!Number.isFinite(k) || k <= 0) return null;
  return d3.zoomIdentity
    .translate(rect.width / 2, rect.height / 2)
    .scale(k)
    .translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
}

function fitToScreen(ms = 600) {
  const t = fitTransform();
  if (t) svg.transition().duration(ms).call(state.zoom.transform, t);
}

/** 첫 화면 — 한 점에서 시작해 망이 화면을 채울 때까지 열린다.
 *  축소 한계(0.2)보다 훨씬 작은 배율에서 출발하므로 그동안만 한계를 풀어 둔다. */
function introReveal() {
  const t = fitTransform();
  if (!t) { setTimeout(introReveal, 120); return; }   // 캔버스가 아직 안 잡혔다

  const rect = svg.node().getBoundingClientRect();
  const cx = (rect.width / 2 - t.x) / t.k;            // 화면 한가운데에 오는 월드 좌표
  const cy = (rect.height / 2 - t.y) / t.k;
  const k0 = t.k * 0.014;

  state.intro = true;
  state.zoom.scaleExtent([Math.min(k0, 0.2), 4]);

  const t0 = d3.zoomIdentity
    .translate(rect.width / 2, rect.height / 2)
    .scale(k0)
    .translate(-cx, -cy);

  svg.interrupt();
  svg.call(state.zoom.transform, t0);
  gRoot.attr('opacity', 0);

  const slow = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  gRoot.transition().duration(slow ? 0 : 1100).attr('opacity', 1);
  svg.transition()
    .duration(slow ? 0 : 2300)
    .ease(d3.easeCubicOut)
    .call(state.zoom.transform, t)
    .on('end interrupt', () => {
      state.zoom.scaleExtent([0.2, 4]);
      state.intro = false;
      gRoot.attr('opacity', 1);
      if (!state.focus) seqStart();
    });
}

/* 열림의 순서와 간격. 망이 점화를 끝내고 자리를 잡은 뒤에야 첫 단계가 온다.
   한 프레임에 몰면 점화 계산과 패널 레이아웃이 부딪쳐 끊긴다. */
/* 단계마다 시작 시각을 따로 준다. 오른쪽 뒤에 여유가 큰 것은
   상세 내용을 그 자리에서 짓기 때문이다 — 다음 단계와 겹치면 또 끊긴다. */
const UI_STEPS = [
  { cls: 'ui-top',   at: 1150 },                            // 점화가 끝난 뒤
  { cls: 'ui-left',  at: 1700, mount: true, refit: 320 },   // 폭이 바뀐 만큼 다시 앉힌다
  { cls: 'ui-right', at: 2260, mount: true, refit: 320 },
  { cls: 'ui-aux',   at: 3060, refit: 420 },   // 모두 자리 잡은 뒤 마지막으로 한 번 더
];

function bareUI() {
  for (const t of state.uiTimers || []) clearTimeout(t);
  state.uiTimers = [];
  state.uiOpen = false;
  for (const { cls } of UI_STEPS) document.body.classList.remove(cls, cls + '-mount');
  document.body.classList.add('intro');
}

/** 좌표 점을 누르면 상단 → 왼쪽 → 오른쪽 → 캔버스 덧것 순으로 하나씩 열린다.
 *  onRight 는 오른쪽 바가 열리는 차례에 실행된다 — 상세 그리기를 그때로 미뤄
 *  점화와 같은 프레임에서 겹치지 않게 한다. */
function revealChrome(onRight) {
  if (state.uiOpen) { if (onRight) onRight(); return; }
  state.uiOpen = true;
  state.uiTimers = [];
  document.body.classList.remove('intro');

  for (const { cls, at, mount, refit } of UI_STEPS) {
    state.uiTimers.push(setTimeout(() => requestAnimationFrame(() => {
      // ① 자리를 만든다 — display 와 폭. 배치가 한 번 일어난다.
      if (mount) document.body.classList.add(cls + '-mount');
      if (refit) fitToScreen(refit);
      // ② 다음 프레임에 움직인다 — 투명도와 위치는 합성으로 끝난다.
      requestAnimationFrame(() => document.body.classList.add(cls));
    }), at));
  }
  // 상세 내용은 오른쪽 바가 열리기 시작한 뒤에 짓는다. 이게 한 프레임에서
  // 가장 무거운 일이라, 바가 움직이기 시작하는 순간과 겹치면 그 움직임이 끊긴다.
  if (onRight) {
    const right = UI_STEPS.find((u) => u.cls === 'ui-right');
    state.uiTimers.push(setTimeout(onRight, right.at + 300));
  }
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

  $$('.seg-btn[data-view]').forEach((btn) => btn.addEventListener('click', () => {
    $$('.seg-btn[data-view]').forEach((b) => b.classList.toggle('is-on', b === btn));
    state.view = btn.dataset.view;
    applyVisibility();
  }));

  $$('.seg-btn[data-layout]').forEach((btn) => btn.addEventListener('click', () => {
    if (state.layout === btn.dataset.layout) return;
    $$('.seg-btn[data-layout]').forEach((b) => b.classList.toggle('is-on', b === btn));
    state.layout = btn.dataset.layout;
    clearFocus();
    drawBackdrop();
    retarget();                              // 힘을 새로 걸고 새 자리로 옮긴다
    refreshLinks();
    applyLabelVisibility();
    setTimeout(() => fitToScreen(600), 350);
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
    $$('.seg-btn[data-view]').forEach((b) => b.classList.toggle('is-on', b.dataset.view === 'all'));
    state.hiddenStatus.clear(); state.hiddenLinkTypes.clear(); state.hiddenKinds.clear();
    state.showOrg = false;
    $$('.chip').forEach((c) => c.classList.add('is-on'));
    $('#toggle-org').classList.remove('is-on');
    applyVisibility();
    applyLabelVisibility();
    bareUI();
    setTimeout(introReveal, 700);
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

  window.addEventListener('resize', () => { if (!state.intro) fitToScreen(0); });
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
      if (state.readOnly) {
        alert('정적 배포본에서는 신호를 저장할 수 없습니다. 로컬에서 서버를 띄우고 입력해 주세요.');
        return;
      }
      const res = await fetch('api/signals', {
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
    if (state.readOnly) {
      analysis = autolinkLocal(body);
      renderAnalysis(analysis);
      $('#analyze-hint').textContent = `확신도 ${analysis.confidence} · 브라우저에서 계산`;
      return;
    }
    try {
      const res = await fetch('api/proposals/analyze', {
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
    if (state.readOnly) {
      const id = downloadProposal(body, analysis);
      dlg.close();
      alert(`제안을 파일로 내려받았습니다 — ${id}.json

`
        + `ThirdBrain 프로젝트의 data/inbox/ 에 넣고 터미널에서:
`
        + `  node tools/link-proposal.js --show ${id}`);
      return;
    }
    try {
      const res = await fetch('api/proposals', {
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

/** 정적 배포에서는 서버에 쓸 수 없다. 입력은 파일로 내려받아
 *  data/inbox 에 넣고 Claude Code 가 처리하게 한다. */
function markReadOnly() {
  document.body.classList.add('is-readonly');
  const badge = document.createElement('span');
  badge.className = 'ro-badge';
  badge.textContent = '읽기 전용';
  badge.title = '정적 배포본입니다. 입력한 내용은 파일로 내려받아 Claude Code 로 반영합니다.';
  $('.topbar-tools').prepend(badge);
}

/** 서버의 tools/autolink.js 와 같은 방식(문자 바이그램 Dice)을 브라우저에서 재현한다. */
function autolinkLocal(proposal) {
  const text = [proposal.title, proposal.need, proposal.goal, (proposal.keywords || []).join(' ')]
    .filter(Boolean).join(' ');
  const q = textGrams(text);
  const sc = (parts) => diceSim(q, textGrams(parts.filter(Boolean).join(' ')));

  const diag = state.raw.diagnoses
    .map((d) => ({ id: d.id, label: d.label, sector: d.sector, score: +sc([d.label, d.detail]).toFixed(4) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const pl = state.raw.pledges
    .map((p) => ({ id: p.id, label: p.label, sector: p.sector, score: +sc([p.label, p.detail]).toFixed(4) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  const secScore = new Map();
  for (const d of diag.slice(0, 12)) secScore.set(d.sector, (secScore.get(d.sector) || 0) + d.score);
  for (const s of state.raw.taxonomy.sectors) {
    const v = sc([s.label]);
    if (v > 0) secScore.set(s.id, (secScore.get(s.id) || 0) + v * 1.5);
  }
  const sectors = [...secScore.entries()].map(([id, v]) => ({ id, score: +v.toFixed(4) }))
    .sort((a, b) => b.score - a.score);

  const top = diag.length ? diag[0].score : 0;
  const STRONG = Math.max(0.09, top * 0.45);
  const WEAK = Math.max(0.045, top * 0.18);
  const resolves = diag.filter((d) => d.score >= STRONG).slice(0, 6);
  return {
    sector: sectors[0] && sectors[0].score >= 0.05 ? sectors[0].id : null,
    sectorRanking: sectors.slice(0, 5),
    resolves,
    candidates: diag.filter((d) => d.score >= WEAK && d.score < STRONG).slice(0, 10),
    relatedPledges: pl.filter((p) => p.score >= Math.max(0.05, top * 0.2)).slice(0, 6),
    confidence: resolves.length >= 2 ? 'high' : resolves.length >= 1 ? 'medium' : 'low',
    needsReview: resolves.length === 0,
    method: '문자 바이그램 Dice 유사도 (브라우저 계산)',
  };
}

/** 제안을 파일로 내려받는다 — data/inbox 에 넣고 link-proposal.js 로 반영한다. */
function downloadProposal(payload, analysis) {
  const id = 'PR-' + new Date().toISOString().slice(0, 10).replace(/-/g, '')
    + '-' + Math.random().toString(16).slice(2, 8);
  const body = {
    proposal: { id, createdAt: new Date().toISOString(), ...payload, analysis, status: 'pending' },
    instruction: '이 정책 제안을 12대 섹터·97개 진단과 대조해 소관 섹터와 해소 대상 진단을 판정하고 반영하라.',
    howto: `data/inbox/ 에 이 파일을 넣고  node tools/link-proposal.js --show ${id}`,
  };
  const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = id + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return id;
}

/* ═════════════════════════════════════════════════════════════
   10. 부팅
   ═════════════════════════════════════════════════════════════ */

async function reload() {
  const prev = new Map(state.nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
  state.raw = await loadGraph();
  stampBuild(state.raw);
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

/** 서버가 있으면 API 를, 없으면(정적 배포) 같은 폴더의 graph.json 을 읽는다. */
async function loadGraph() {
  try {
    const res = await fetch('api/graph', { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      state.readOnly = !!data.readOnly;   // 서버가 쓰기를 잠근 배포본일 수 있다
      return data;
    }
  } catch { /* 정적 배포 — 아래로 넘어간다 */ }
  const res = await fetch('graph.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('graph.json 을 불러오지 못했습니다.');
  state.readOnly = true;
  return res.json();
}

async function boot() {
  state.raw = await loadGraph();
  stampBuild(state.raw);
  Object.assign(state, buildModel(state.raw));

  for (const n of state.nodes) {
    const t = targetOf(n);
    n.x = t.x; n.y = t.y;
  }
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
  if (state.readOnly) markReadOnly();

  setTimeout(introReveal, 420);
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('afterbegin',
    `<div style="padding:16px;color:#ffb4b4">불러오기 실패: ${esc(err.message)}</div>`);
});
