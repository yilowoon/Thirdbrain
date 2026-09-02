/**
 * ThirdBrain — 세종시 정책 네트워크 플랫폼
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

/** 세 데이터 파일을 한 번에 내려주는 부트스트랩 엔드포인트. */
async function getGraph() {
  const [taxonomy, policies, links, signals] = await Promise.all([
    readJson('taxonomy.json'),
    readJson('policies.json'),
    readJson('links.json'),
    readJson('signals.json'),
  ]);
  return {
    taxonomy,
    policies: policies.policies,
    links: links.links,
    signals: signals.signals,
    meta: { policies: policies._meta, links: links._meta, signals: signals._meta },
  };
}

const routes = {
  'GET /api/graph': async (req, res) => sendJson(res, 200, await getGraph()),

  'POST /api/signals': async (req, res) => {
    const body = await readBody(req);
    const targets = Array.isArray(body.targets) ? body.targets.filter(Boolean) : [];
    if (!body.title || targets.length === 0) {
      return sendJson(res, 400, { error: 'title 과 targets(1개 이상)는 필수입니다.' });
    }
    const file = await readJson('signals.json');
    const policyIds = new Set((await readJson('policies.json')).policies.map((p) => p.id));
    const unknown = targets.filter((t) => !policyIds.has(t));
    if (unknown.length) {
      return sendJson(res, 400, { error: `존재하지 않는 정책 ID: ${unknown.join(', ')}` });
    }
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

  'POST /api/policies': async (req, res) => {
    const body = await readBody(req);
    if (!body.label || !body.sector) {
      return sendJson(res, 400, { error: 'label 과 sector 는 필수입니다.' });
    }
    const taxonomy = await readJson('taxonomy.json');
    if (!taxonomy.sectors.some((s) => s.id === body.sector)) {
      return sendJson(res, 400, { error: `존재하지 않는 섹터: ${body.sector}` });
    }
    const file = await readJson('policies.json');
    const seq = file.policies.filter((p) => p.sector === body.sector).length + 1;
    const policy = {
      id: `P${body.sector.slice(1)}${String(seq).padStart(2, '0')}-${randomUUID().slice(0, 4)}`,
      sector: body.sector,
      label: String(body.label).slice(0, 120),
      dept: body.dept || '',
      budget: Number.isFinite(+body.budget) ? +body.budget : 0,
      start: body.start || new Date().toISOString().slice(0, 7),
      end: body.end || '',
      progress: clamp01(body.progress, 0),
      planned: clamp01(body.planned, 0),
      weight: Math.min(10, Math.max(1, Math.round(+body.weight || 5))),
      tags: Array.isArray(body.tags) ? body.tags.slice(0, 8) : [],
      kpi: Array.isArray(body.kpi) ? body.kpi.slice(0, 5) : [],
      isNew: true,
    };
    file.policies.push(policy);
    await writeJson('policies.json', file);

    // 함께 넘어온 연결선이 있으면 links.json 에도 반영한다.
    const incoming = Array.isArray(body.links) ? body.links : [];
    if (incoming.length) {
      const linkFile = await readJson('links.json');
      const ids = new Set(file.policies.map((p) => p.id));
      for (const l of incoming) {
        if (!ids.has(l.target) || l.target === policy.id) continue;
        linkFile.links.push({
          source: policy.id,
          target: l.target,
          type: ['synergy', 'dependency', 'conflict'].includes(l.type) ? l.type : 'synergy',
          weight: clamp01(l.weight, 0.6),
          note: String(l.note || '').slice(0, 200),
        });
      }
      await writeJson('links.json', linkFile);
    }
    sendJson(res, 201, { policy });
  },

  'POST /api/links': async (req, res) => {
    const body = await readBody(req);
    const file = await readJson('links.json');
    const ids = new Set((await readJson('policies.json')).policies.map((p) => p.id));
    if (!ids.has(body.source) || !ids.has(body.target) || body.source === body.target) {
      return sendJson(res, 400, { error: 'source/target 정책 ID가 올바르지 않습니다.' });
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

function clamp01(v, fallback) {
  const n = +v;
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

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
