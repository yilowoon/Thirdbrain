#!/usr/bin/env node
/**
 * 신규 정책 제안을 망에 편입하는 CLI. 자동 연결이 확신에 못 미쳐
 * data/inbox 로 넘어온 건을 사람 또는 Claude Code 가 판정해 반영한다.
 *
 *   node tools/link-proposal.js                     대기 중인 제안 목록
 *   node tools/link-proposal.js --show <ID>         한 건의 전체 맥락 + 판정용 프롬프트
 *   node tools/link-proposal.js --apply <ID> --sector S07 --resolves S07-02,S07-03
 *   node tools/link-proposal.js --apply <ID> --auto  자동 분석 결과를 그대로 반영
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { autolink } = require('./autolink.js');

const DATA = path.join(__dirname, '..', 'data');
const INBOX = path.join(DATA, 'inbox');
const rd = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8'));
const wr = (n, o) => fs.writeFileSync(path.join(DATA, n), JSON.stringify(o, null, 2) + '\n', 'utf8');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes('--' + name);

function pending() {
  if (!fs.existsSync(INBOX)) return [];
  return fs.readdirSync(INBOX).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(INBOX, f), 'utf8')));
}

function list() {
  const items = pending();
  if (!items.length) return console.log('대기 중인 제안이 없습니다.');
  console.log(`대기 중인 제안 ${items.length}건\n`);
  for (const it of items) {
    const p = it.proposal;
    console.log(`  ${p.id}  ${p.title}`);
    console.log(`      추론 섹터 ${p.analysis.sector || '—'} · 확신도 ${p.analysis.confidence}`);
  }
  console.log('\n한 건 보기:  node tools/link-proposal.js --show <ID>');
}

function show(id) {
  const it = pending().find((x) => x.proposal.id === id);
  if (!it) return console.error('해당 ID의 대기 제안이 없습니다:', id);
  const p = it.proposal;
  const tx = rd('taxonomy.json');
  const dg = rd('diagnoses.json');
  const byId = new Map(dg.diagnoses.map((d) => [d.id, d]));

  console.log('─'.repeat(72));
  console.log('제안 ID :', p.id);
  console.log('제목    :', p.title);
  console.log('니즈    :', p.need || '—');
  console.log('목표    :', p.goal || '—');
  console.log('키워드  :', (p.keywords || []).join(', ') || '—');
  console.log('─'.repeat(72));
  console.log('\n[자동 분석] 확신도', p.analysis.confidence, '/ 방법:', p.analysis.method);
  console.log('\n섹터 후보:');
  for (const s of p.analysis.sectorRanking) {
    const sec = tx.sectors.find((x) => x.id === s.id);
    console.log(`  ${s.id}  ${String(s.score).padStart(7)}  ${sec ? sec.no + '. ' + sec.label : ''}`);
  }
  const row = (x) => {
    const d = byId.get(x.id);
    return `  ${x.id}  ${String(x.score).padStart(7)}  ${d ? d.label : ''}${d && d.detail ? ' — ' + d.detail : ''}`;
  };
  console.log('\n자동 연결(강한 일치):');
  console.log(p.analysis.resolves.length ? p.analysis.resolves.map(row).join('\n') : '  없음');
  console.log('\n검토 후보(약한 일치):');
  console.log(p.analysis.candidates.length ? p.analysis.candidates.map(row).join('\n') : '  없음');

  console.log('\n' + '─'.repeat(72));
  console.log('판정이 서면 아래를 실행하세요:');
  console.log(`  node tools/link-proposal.js --apply ${p.id} --sector <Sxx> --resolves <ID,ID>`);
  console.log('\n12대 섹터:');
  for (const s of tx.sectors) console.log(`  ${s.id}  ${s.no}. ${s.label}`);
}

function apply(id) {
  const file = path.join(INBOX, id + '.json');
  if (!fs.existsSync(file)) return console.error('대기 제안이 없습니다:', id);
  const it = JSON.parse(fs.readFileSync(file, 'utf8'));
  const p = it.proposal;

  const dg = rd('diagnoses.json');
  const pl = rd('pledges.json');
  const tx = rd('taxonomy.json');
  const diagIds = new Set(dg.diagnoses.map((d) => d.id));

  let sector = arg('sector');
  let resolves = (arg('resolves') || '').split(',').map((x) => x.trim()).filter(Boolean);

  if (has('auto')) {
    const a = autolink(p, { diagnoses: dg.diagnoses, pledges: pl.pledges, sectors: tx.sectors });
    sector = sector || a.sector;
    if (!resolves.length) resolves = a.resolves.map((r) => r.id);
  }

  if (!sector || !tx.sectors.some((s) => s.id === sector)) {
    return console.error('유효한 --sector 가 필요합니다. 예: --sector S07');
  }
  const bad = resolves.filter((r) => !diagIds.has(r));
  if (bad.length) return console.error('존재하지 않는 진단 ID:', bad.join(', '));
  if (!resolves.length) return console.error('--resolves 로 해소 대상 진단을 1개 이상 지정하세요.');

  const seq = pl.pledges.filter((x) => x.sector === sector).length + 1;
  const pledge = {
    id: `PL-${sector}-${String(seq).padStart(2, '0')}-${randomUUID().slice(0, 4)}`,
    sector,
    round: null,
    label: p.title,
    detail: p.need || p.goal || '',
    resolves,
    weight: 6,
    kpi: [],
    origin: { proposalId: p.id, autoLinked: false, decidedBy: has('auto') ? 'auto' : 'manual' },
  };
  pl.pledges.push(pledge);
  wr('pledges.json', pl);

  const store = rd('proposals.json');
  const rec = store.proposals.find((x) => x.id === p.id);
  if (rec) { rec.status = 'linked'; rec.sector = sector; rec.pledgeId = pledge.id; }
  wr('proposals.json', store);

  fs.unlinkSync(file);
  console.log('편입 완료');
  console.log('  공약 ID :', pledge.id);
  console.log('  섹터    :', sector);
  console.log('  해소 진단:', resolves.join(', '));
  console.log('\n브라우저를 새로고침하면 망에 반영됩니다.');
}

const applyId = arg('apply');
const showId = arg('show');
if (applyId) apply(applyId);
else if (showId) show(showId);
else list();
