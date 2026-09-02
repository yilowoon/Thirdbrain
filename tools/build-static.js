#!/usr/bin/env node
/**
 * ThirdBrain 정적 배포본 빌드.
 * 서버 없이 도는 형태로 묶는다. 어떤 정적 호스팅에도 그대로 올릴 수 있다.
 *
 *   node tools/build-static.js                 dist/ 로 빌드
 *   node tools/build-static.js --out <경로>    다른 곳으로 빌드
 *
 * 데이터 다섯 파일을 graph.json 하나로 합치므로, 배포본은 API 없이
 * graph.json 만 읽고 동작한다(읽기 전용). 입력 폼은 브라우저에서 대조한 뒤
 * 제안 파일을 내려받아 data/inbox 로 넘기는 방식으로 바뀐다.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');

const DEFAULT_OUT = path.join(ROOT, 'dist');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : null;
}
const OUT = path.resolve(arg('out') || DEFAULT_OUT);

const rd = (n) => JSON.parse(fs.readFileSync(path.join(DATA, n), 'utf8'));

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

function build() {
  if (!fs.existsSync(path.dirname(OUT))) {
    console.error('대상 폴더의 상위 경로가 없습니다:', path.dirname(OUT));
    console.error('--out 으로 경로를 직접 지정하세요.');
    process.exit(1);
  }

  // 이전 배포본 정리 (대상 폴더만)
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });

  copyDir(PUBLIC, OUT);

  const graph = {
    _built: new Date().toISOString(),
    _mode: 'static',
    taxonomy: rd('taxonomy.json'),
    diagnoses: rd('diagnoses.json').diagnoses,
    pledges: rd('pledges.json').pledges,
    links: rd('links.json').links,
    signals: rd('signals.json').signals,
    org: fs.existsSync(path.join(DATA, 'org.json')) ? rd('org.json') : null,
    meta: {
      diagnoses: rd('diagnoses.json')._meta,
      pledges: rd('pledges.json')._meta,
      links: rd('links.json')._meta,
      signals: rd('signals.json')._meta,
    },
  };
  fs.writeFileSync(path.join(OUT, 'graph.json'), JSON.stringify(graph), 'utf8');

  const size = (p) => (fs.statSync(p).size / 1024).toFixed(0) + 'KB';
  console.log('정적 배포본 빌드 완료');
  console.log('  대상 :', OUT);
  console.log('  진단 :', graph.diagnoses.length, '· 공약', graph.pledges.length,
    '· 연결', graph.links.length, '· 신호', graph.signals.length);
  console.log('  조직 :', graph.org ? `${graph.org._meta.counts.divisions}과 / ${graph.org._meta.counts.teams}팀` : '없음');
  console.log('  graph.json', size(path.join(OUT, 'graph.json')));
  console.log('');
  console.log('로컬 확인:  npx serve ' + path.relative(process.cwd(), OUT));
}

build();
