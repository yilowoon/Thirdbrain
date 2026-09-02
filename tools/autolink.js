/**
 * 신규 정책의 텍스트를 기존 진단·공약과 대조해 연결 후보를 뽑는다.
 * 한국어 형태소 분석기 없이도 동작하도록 문자 바이그램 유사도(Dice)를 쓴다.
 * 자동 연결이 확신에 못 미치면 needsReview 로 표시해 사람이(또는 Claude Code가) 판단하게 한다.
 */
'use strict';

const STOP = new Set(['정책', '사업', '추진', '지원', '조성', '강화', '확대', '구축', '운영', '개선', '관리', '세종']);

function bigrams(text) {
  const clean = String(text || '')
    .replace(/[^\uAC00-\uD7A3a-zA-Z0-9]+/g, ' ')
    .trim()
    .toLowerCase();
  const set = new Set();
  for (const word of clean.split(/\s+/)) {
    if (!word || STOP.has(word)) continue;
    if (word.length === 1) { set.add(word); continue; }
    for (let i = 0; i < word.length - 1; i++) set.add(word.slice(i, i + 2));
  }
  return set;
}

/** Dice 계수 — 0~1 */
function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return (2 * hit) / (a.size + b.size);
}

/**
 * @param {{title:string, need:string, goal:string, keywords:string[]}} proposal
 * @param {{diagnoses:Array, pledges:Array, sectors:Array}} corpus
 */
function autolink(proposal, corpus) {
  const text = [proposal.title, proposal.need, proposal.goal, (proposal.keywords || []).join(' ')]
    .filter(Boolean).join(' ');
  const q = bigrams(text);

  const score = (parts) => dice(q, bigrams(parts.filter(Boolean).join(' ')));

  const diagHits = corpus.diagnoses
    .map((d) => ({ id: d.id, label: d.label, sector: d.sector, score: +score([d.label, d.detail]).toFixed(4) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const pledgeHits = corpus.pledges
    .map((p) => ({ id: p.id, label: p.label, sector: p.sector, score: +score([p.label, p.detail]).toFixed(4) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  // 섹터 추론 — 상위 진단이 속한 섹터에 점수를 몰아준다
  const sectorScore = new Map();
  for (const d of diagHits.slice(0, 12)) {
    sectorScore.set(d.sector, (sectorScore.get(d.sector) || 0) + d.score);
  }
  for (const s of corpus.sectors) {
    const direct = score([s.label]);
    if (direct > 0) sectorScore.set(s.id, (sectorScore.get(s.id) || 0) + direct * 1.5);
  }
  const sectors = [...sectorScore.entries()]
    .map(([id, v]) => ({ id, score: +v.toFixed(4) }))
    .sort((a, b) => b.score - a.score);

  // 절대 임계값만 쓰면 표현이 다른 정책은 전부 놓치고, 표현이 겹치는 정책은 과하게 붙는다.
  // 최고 점수 대비 상대 기준을 함께 두어 사례마다 눈금이 맞게 한다.
  const top = diagHits.length ? diagHits[0].score : 0;
  const STRONG = Math.max(0.09, top * 0.45);
  const WEAK = Math.max(0.045, top * 0.18);

  const resolves = diagHits.filter((d) => d.score >= STRONG).slice(0, 6);
  const candidates = diagHits.filter((d) => d.score >= WEAK && d.score < STRONG).slice(0, 10);
  const related = pledgeHits.filter((p) => p.score >= Math.max(0.05, top * 0.2)).slice(0, 6);

  const topSector = sectors[0] && sectors[0].score >= 0.05 ? sectors[0].id : null;

  return {
    sector: topSector,
    sectorRanking: sectors.slice(0, 5),
    resolves,
    candidates,
    relatedPledges: related,
    confidence: resolves.length >= 2 && topSector ? 'high'
      : resolves.length >= 1 && topSector ? 'medium' : 'low',
    needsReview: !(resolves.length >= 1 && topSector),
    method: '문자 바이그램 Dice 유사도. 형태소 분석기를 쓰지 않으므로 어림값이다.',
    thresholds: { strong: +STRONG.toFixed(4), weak: +WEAK.toFixed(4), top: +top.toFixed(4) },
  };
}

module.exports = { autolink, bigrams, dice };
