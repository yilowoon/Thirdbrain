/**
 * ThirdBrain — 세종시 12대 섹터 진단·공약 네트워크
 * 의존성 없는 Node 내장 HTTP 서버. `node server.js` 만으로 실행된다.
 */
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 4173;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const readJson = (name) => fsp.readFile(path.join(DATA, name), 'utf8').then(JSON.parse);
const writeJson = (name, obj) =>
  fsp.writeFile(path.join(DATA, name), JSON.stringify(obj, null, 2) + '\n', 'utf8');

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

const sendJson = (res, status, obj) =>
  send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8' });

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** 정적 파일 서빙. public/ 밖으로 나가는 경로는 거부한다. */
async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const target = path.join(PUBLIC, decodeURIComponent(rel));
  if (!target.startsWith(PUBLIC)) return send(res, 403, 'Forbidden');
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) return send(res, 404, 'Not found');
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

async function getGraph() {
  const [taxonomy, diagnoses, pledges, links, signals] = await Promise.all([
    readJson('taxonomy.json'),
    readJson('diagnoses.json'),
    readJson('pledges.json'),
    readJson('links.json'),
    readJson('signals.json'),
  ]);
  return {
    taxonomy,
    diagnoses: diagnoses.diagnoses,
    pledges: pledges.pledges,
    links: links.links,
    signals: signals.signals,
    meta: {
      diagnoses: diagnoses._meta,
      pledges: pledges._meta,
      links: links._meta,
      signals: signals._meta,
    },
  };
}

const idsOf = (arr) => new Set(arr.map((x) => x.id));
const clamp01 = (v, fallback) => {
  const n = +v;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
};

const routes = {
  'GET /api/graph': async (req, res) => sendJson(res, 200, await getGraph()),

  /** 시민 신호를 진단 항목에 연결한다. */
  'POST /api/signals': async (req, res) => {
    const body = await readBody(req);
    const targets = Array.isArray(body.targets) ? body.targets.filter(Boolean) : [];
    if (!body.title || targets.length === 0) {
      return sendJson(res, 400, { error: 'title 과 targets(진단 1개 이상)는 필수입니다.' });
    }
    const diagIds = idsOf((await readJson('diagnoses.json')).diagnoses);
    const unknown = targets.filter((t) => !diagIds.has(t));
    if (unknown.length) {
      return sendJson(res, 400, { error: `존재하지 않는 진단 ID: ${unknown.join(', ')}` });
    }
    const file = await readJson('signals.json');
    const signal = {
      id: 'G' + randomUUID().slice(0, 8),
      date: body.date || new Date().toISOString().slice(0, 10),
      title: String(body.title).slice(0, 200),
      channel: body.channel || '시민신문고',
      type: body.type || '민원',
      severity: ['low', 'mid', 'high', 'critical'].includes(body.severity) ? body.severity : 'mid',
      count: Number.isFinite(+body.count) ? Math.max(1, Math.trunc(+body.count)) : 1,
      targets,
      summary: String(body.summary || '').slice(0, 500),
    };
    file.signals.push(signal);
    await writeJson('signals.json', file);
    sendJson(res, 201, { signal });
  },

  /** 새 공약을 추가하고, 해소할 진단에 연결한다. */
  'POST /api/pledges': async (req, res) => {
    const body = await readBody(req);
    if (!body.label || !body.sector) {
      return sendJson(res, 400, { error: 'label 과 sector 는 필수입니다.' });
    }
    const taxonomy = await readJson('taxonomy.json');
    if (!taxonomy.sectors.some((s) => s.id === body.sector)) {
      return sendJson(res, 400, { error: `존재하지 않는 섹터: ${body.sector}` });
    }
    const diagIds = idsOf((await readJson('diagnoses.json')).diagnoses);
    const resolves = (Array.isArray(body.resolves) ? body.resolves : []).filter((r) => diagIds.has(r));

    const file = await readJson('pledges.json');
    const seq = file.pledges.filter((p) => p.sector === body.sector).length + 1;
    const pledge = {
      id: `PL-${body.sector}-${String(seq).padStart(2, '0')}-${randomUUID().slice(0, 4)}`,
      sector: body.sector,
      round: Number.isFinite(+body.round) ? +body.round : null,
      label: String(body.label).slice(0, 160),
      detail: String(body.detail || '').slice(0, 600),
      resolves,
      weight: Math.min(10, Math.max(1, Math.round(+body.weight || 5))),
      kpi: Array.isArray(body.kpi) ? body.kpi.slice(0, 6) : [],
      isNew: true,
    };
    file.pledges.push(pledge);
    await writeJson('pledges.json', file);

    const incoming = Array.isArray(body.links) ? body.links : [];
    if (incoming.length) {
      const linkFile = await readJson('links.json');
      const pledgeIds = idsOf(file.pledges);
      for (const l of incoming) {
        if (!pledgeIds.has(l.target) || l.target === pledge.id) continue;
        linkFile.links.push({
          source: pledge.id,
          target: l.target,
          type: ['synergy', 'dependency', 'conflict'].includes(l.type) ? l.type : 'synergy',
          weight: clamp01(l.weight, 0.6),
          note: String(l.note || '').slice(0, 200),
        });
      }
      await writeJson('links.json', linkFile);
    }
    sendJson(res, 201, { pledge });
  },

  /** 새 진단(현안)을 추가한다. */
  'POST /api/diagnoses': async (req, res) => {
    const body = await readBody(req);
    if (!body.label || !body.sector) {
      return sendJson(res, 400, { error: 'label 과 sector 는 필수입니다.' });
    }
    const taxonomy = await readJson('taxonomy.json');
    if (!taxonomy.sectors.some((s) => s.id === body.sector)) {
      return sendJson(res, 400, { error: `존재하지 않는 섹터: ${body.sector}` });
    }
    const file = await readJson('diagnoses.json');
    const no = Math.max(0, ...file.diagnoses.filter((d) => d.sector === body.sector).map((d) => d.no)) + 1;
    const diagnosis = {
      id: `${body.sector}-${String(no).padStart(2, '0')}`,
      sector: body.sector,
      no,
      label: String(body.label).slice(0, 160),
      detail: String(body.detail || '').slice(0, 400),
      weight: Math.min(10, Math.max(1, Math.round(+body.weight || 5))),
      isNew: true,
    };
    file.diagnoses.push(diagnosis);
    file._meta.count = file.diagnoses.length;
    await writeJson('diagnoses.json', file);
    sendJson(res, 201, { diagnosis });
  },

  /** 공약 간 횡단 관계를 추가한다. */
  'POST /api/links': async (req, res) => {
    const body = await readBody(req);
    const file = await readJson('links.json');
    const pledgeIds = idsOf((await readJson('pledges.json')).pledges);
    if (!pledgeIds.has(body.source) || !pledgeIds.has(body.target) || body.source === body.target) {
      return sendJson(res, 400, { error: 'source/target 공약 ID가 올바르지 않습니다.' });
    }
    const link = {
      source: body.source,
      target: body.target,
      type: ['synergy', 'dependency', 'conflict'].includes(body.type) ? body.type : 'synergy',
      weight: clamp01(body.weight, 0.6),
      note: String(body.note || '').slice(0, 200),
    };
    file.links.push(link);
    await writeJson('links.json', file);
    sendJson(res, 201, { link });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) return await routes[key](req, res);
    if (req.method === 'GET') return await serveStatic(req, res, url.pathname);
    send(res, 405, 'Method not allowed');
  } catch (err) {
    console.error('[error]', key, err.message);
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`ThirdBrain → http://localhost:${PORT}`);
});
