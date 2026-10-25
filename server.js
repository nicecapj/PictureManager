// 사진 Diff & 동기화 관리자 - 서버
const express = require('express');
const sharp = require('sharp');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');

sharp.cache(false);
const PORT = process.env.PORT || 3000;
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const THUMB_DIR = path.join(__dirname, '.cache', 'thumbs');
fs.mkdirSync(THUMB_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 상태 ----------------
let state = {
  job: { running: false, phase: 'idle', done: 0, total: 0, message: '' },
  files: [],      // {id, root, rel, abs, name, size, mtime, width, height, chash, dhash, error}
  groups: [],     // {id, type: exact|similar|unique, fileIds, nameConflict}
  roots: {},
};

// ---------------- 유틸 ----------------
async function walk(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('.') || e.name === '_휴지통' || e.name === '삭제예정') continue;
      await walk(p, out);
    } else if (e.isFile() && IMG_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
  return out;
}

async function walkAll(dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkAll(p, out); else out.push(p);
  }
  return out;
}

async function pool(items, n, fn, onProgress) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
      onProgress && onProgress();
    }
  });
  await Promise.all(workers);
}

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

async function analyze(abs) {
  const buf = await fsp.readFile(abs);
  const base = () => sharp(buf, { failOn: 'none' }).rotate();
  // 픽셀 내용 해시 (EXIF/메타데이터/파일정보 무시)
  const { data, info } = await base().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const chash = crypto.createHash('sha1').update(`${info.width}x${info.height}`).update(data).digest('hex');
  // dHash 64bit (유사 이미지 판정)
  const g = await base().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g[y * 9 + x] > g[y * 9 + x + 1] ? '1' : '0';
  let dhash = '';
  for (let i = 0; i < 64; i += 4) dhash += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return { chash, dhash, width: info.width, height: info.height };
}

function score(f) { return [(f.width || 0) * (f.height || 0), f.size, f.mtime]; }
function best(files) {
  return files.slice().sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < 3; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    return 0;
  })[0];
}

// ---------------- 스캔 ----------------
async function runScan(roots, threshold) {
  const job = state.job;
  Object.assign(job, { running: true, phase: '파일 검색 중', done: 0, total: 0, message: '' });
  state.roots = roots;
  try {
    const files = [];
    for (const [key, dir] of Object.entries(roots)) {
      if (!dir) continue;
      const list = await walk(dir);
      for (const abs of list) {
        const st = await fsp.stat(abs);
        files.push({
          id: files.length, root: key, rootDir: dir, abs,
          rel: path.relative(dir, abs), name: path.basename(abs),
          size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs,
        });
      }
    }
    Object.assign(job, { phase: '이미지 분석 중', total: files.length, startedAt: Date.now(), stats: null });
    await pool(files, Math.max(2, os.cpus().length - 1), async (f) => {
      job.current = `[${f.root}] ${f.rel}`;
      try { Object.assign(f, await analyze(f.abs)); }
      catch (e) { f.error = String(e.message || e); f.chash = 'err:' + f.abs; f.dhash = null; }
    }, () => job.done++);

    job.phase = '그룹 분류 중';
    // 1) 내용 해시로 묶기
    const byHash = new Map();
    for (const f of files) {
      if (!byHash.has(f.chash)) byHash.set(f.chash, []);
      byHash.get(f.chash).push(f);
    }
    const hashGroups = [...byHash.values()];
    // 2) dHash로 유사 클러스터 (Union-Find)
    const parent = hashGroups.map((_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (let i = 0; i < hashGroups.length; i++) {
      const a = hashGroups[i][0].dhash; if (!a) continue;
      for (let j = i + 1; j < hashGroups.length; j++) {
        const b = hashGroups[j][0].dhash; if (!b) continue;
        if (hamming(a, b) <= threshold) parent[find(i)] = find(j);
      }
    }
    const clusters = new Map();
    hashGroups.forEach((g, i) => {
      const r = find(i);
      if (!clusters.has(r)) clusters.set(r, []);
      clusters.get(r).push(g);
    });
    const groups = [];
    for (const cl of clusters.values()) {
      const all = cl.flat();
      const type = cl.length > 1 ? 'similar' : all.length > 1 ? 'exact' : 'unique';
      const keepId = best(all).id;
      // 기본 선택: 대표 1개만 유지 (고유 파일은 유지)
      for (const f of all) f.keep = type === 'unique' ? !f.error : f.id === keepId;
      groups.push({ id: groups.length, type, fileIds: all.map((f) => f.id), subgroups: cl.map((g) => g.map((f) => f.id)) });
      for (const f of all) f.groupId = groups.length - 1;
    }
    // 3) 이름 같지만 내용 다른 것 표시
    const byName = new Map();
    for (const f of files) {
      const k = f.name.toLowerCase();
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(f.chash);
    }
    for (const g of groups) {
      g.nameConflict = g.fileIds.some((id) => byName.get(files[id].name.toLowerCase()).size > 1);
    }
    const order = { exact: 0, similar: 1, unique: 2 };
    groups.sort((a, b) => order[a.type] - order[b.type] || b.fileIds.length - a.fileIds.length);
    groups.forEach((g, i) => { g.id = i; g.fileIds.forEach((id) => (files[id].groupId = i)); });

    state.files = files; state.groups = groups;
    Object.assign(job, { running: false, phase: 'done', message: `${files.length}개 파일, ${groups.length}개 그룹` });
  } catch (e) {
    Object.assign(job, { running: false, phase: 'error', message: String(e.message || e) });
  }
}

// ---------------- 동기화 ----------------
async function uniqueDest(dest, chash, used) {
  const ext = path.extname(dest), stem = dest.slice(0, -ext.length);
  let cand = dest, n = 1;
  while (true) {
    const key = cand.toLowerCase();
    if (used.has(key)) {
      if (used.get(key) === chash) return null; // 같은 내용 이미 배치됨
    } else if (fs.existsSync(cand)) {
      try { const a = await analyze(cand); if (a.chash === chash) { used.set(key, chash); return null; } } catch {}
    } else { used.set(key, chash); return cand; }
    cand = `${stem} (${n++})${ext}`;
  }
}

async function moveFile(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try { await fsp.rename(src, dst); }
  catch { await fsp.copyFile(src, dst); await fsp.unlink(src); }
}

async function runSync({ target, mode, unchecked, keepMap }) {
  const job = state.job;
  for (const [id, v] of Object.entries(keepMap || {})) if (state.files[id]) state.files[id].keep = !!v;
  const keep = state.files.filter((f) => f.keep && !f.error);
  const drop = state.files.filter((f) => !f.keep && !f.error);
  const isMove = mode === 'move';
  Object.assign(job, { running: true, phase: '동기화 중', done: 0, total: keep.length + (isMove || unchecked !== 'leave' ? drop.length : 0), message: '' });
  const log = { copied: 0, moved: 0, skipped: 0, renamed: 0, deleted: 0, trashed: 0, pending: 0, dupDeleted: 0, errors: [] };
  job.stats = log; job.current = ''; job.startedAt = Date.now();
  const used = new Map();
  // 이동 모드: 중복 파일은 C/삭제예정 으로 (같은 내용은 1개만 남기고 삭제)
  const pendingDir = path.join(target, '삭제예정');
  const pendingHashes = new Set();
  const pendingUsed = new Map();
  async function toPending(f) {
    if (pendingHashes.has(f.chash)) { await fsp.unlink(f.abs); log.dupDeleted++; return; }
    pendingHashes.add(f.chash);
    const dest = await uniqueDest(path.join(pendingDir, f.root, f.rel), f.chash, pendingUsed);
    if (!dest) { await fsp.unlink(f.abs); log.dupDeleted++; return; } // 이미 삭제예정에 동일 파일 존재
    await moveFile(f.abs, dest); log.pending++;
  }
  try {
    await fsp.mkdir(target, { recursive: true });
    if (isMove && fs.existsSync(pendingDir)) { // 이전 삭제예정 파일 해시 등록
      for (const p of await walkAll(pendingDir)) { try { pendingHashes.add((await analyze(p)).chash); } catch {} }
    }
    for (const f of keep) {
      job.current = `[${f.root}] ${f.rel}`;
      try {
        const dest = await uniqueDest(path.join(target, f.rel), f.chash, used);
        if (!dest) { log.skipped++; if (isMove) await toPending(f); }
        else {
          if (dest !== path.join(target, f.rel)) log.renamed++;
          if (mode === 'move') { await moveFile(f.abs, dest); log.moved++; }
          else { await fsp.mkdir(path.dirname(dest), { recursive: true }); await fsp.copyFile(f.abs, dest); const st = await fsp.stat(f.abs); await fsp.utimes(dest, st.atime, st.mtime); log.copied++; }
        }
      } catch (e) { log.errors.push(`${f.abs}: ${e.message}`); }
      job.done++;
    }
    if (isMove) {
      for (const f of drop) {
        job.current = `[${f.root}] ${f.rel}`;
        try { await toPending(f); } catch (e) { log.errors.push(`${f.abs}: ${e.message}`); }
        job.done++;
      }
    } else if (unchecked !== 'leave') {
      for (const f of drop) {
        job.current = `[${f.root}] ${f.rel}`;
        try {
          if (unchecked === 'trash') { await moveFile(f.abs, path.join(target, '_휴지통', f.root, f.rel)); log.trashed++; }
          else if (unchecked === 'delete') { await fsp.unlink(f.abs); log.deleted++; }
        } catch (e) { log.errors.push(`${f.abs}: ${e.message}`); }
        job.done++;
      }
    }
    Object.assign(job, { running: false, phase: 'synced', message: JSON.stringify(log) });
  } catch (e) {
    Object.assign(job, { running: false, phase: 'error', message: String(e.message || e) });
  }
}

// ---------------- API ----------------
const known = (p) => state.files.find((f) => f.abs === p);

app.get('/api/ls', async (req, res) => {
  let dir = req.query.path;
  if (!dir) {
    if (process.platform === 'win32') {
      const drives = [];
      for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (fs.existsSync(`${c}:\\`)) drives.push({ name: `${c}:`, path: `${c}:\\` });
      return res.json({ path: '', parent: null, dirs: drives });
    }
    dir = '/';
  }
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const dirs = ents.filter((e) => e.isDirectory() && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
    res.json({ path: dir, parent, dirs });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/mkdir', async (req, res) => {
  try { await fsp.mkdir(req.body.path, { recursive: true }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/scan', (req, res) => {
  if (state.job.running) return res.status(409).json({ error: '작업 진행 중' });
  const { a, b, threshold = 6 } = req.body;
  for (const d of [a, b]) if (d && !fs.existsSync(d)) return res.status(400).json({ error: `폴더 없음: ${d}` });
  runScan({ A: a, B: b }, Number(threshold));
  res.json({ ok: true });
});

app.get('/api/status', (req, res) => res.json(state.job));

app.get('/api/result', (req, res) => {
  res.json({
    roots: state.roots,
    groups: state.groups,
    files: state.files.map(({ abs, rootDir, ...f }) => ({ ...f, abs })),
  });
});

app.post('/api/sync', (req, res) => {
  if (state.job.running) return res.status(409).json({ error: '작업 진행 중' });
  if (!req.body.target) return res.status(400).json({ error: '대상 폴더를 지정하세요' });
  const t = path.resolve(req.body.target);
  for (const r of Object.values(state.roots)) if (r && path.resolve(r) === t) return res.status(400).json({ error: '대상 폴더는 원본 폴더와 달라야 합니다' });
  runSync(req.body);
  res.json({ ok: true });
});

app.get('/api/thumb', async (req, res) => {
  const f = known(req.query.path);
  if (!f) return res.sendStatus(404);
  const size = Math.min(Number(req.query.size) || 320, 1600);
  const key = crypto.createHash('md5').update(`${f.abs}|${f.mtime}|${size}`).digest('hex');
  const cache = path.join(THUMB_DIR, key + '.webp');
  try {
    if (!fs.existsSync(cache)) {
      await sharp(f.abs, { failOn: 'none' }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(cache);
    }
    res.set('Cache-Control', 'max-age=86400').sendFile(cache);
  } catch { res.sendStatus(415); }
});

app.get('/api/image', async (req, res) => {
  const f = known(req.query.path);
  if (!f) return res.sendStatus(404);
  const ext = path.extname(f.abs).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'].includes(ext)) return res.sendFile(f.abs);
  try { // 브라우저 미지원 포맷은 변환
    const buf = await sharp(f.abs, { failOn: 'none' }).rotate().jpeg({ quality: 92 }).toBuffer();
    res.type('jpeg').send(buf);
  } catch { res.sendStatus(415); }
});

app.get('/api/meta', async (req, res) => {
  const f = known(req.query.path);
  if (!f) return res.sendStatus(404);
  try {
    const m = await sharp(f.abs).metadata();
    res.json({ format: m.format, width: m.width, height: m.height, space: m.space, density: m.density, orientation: m.orientation, hasExif: !!m.exif });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/open', (req, res) => { // 탐색기에서 위치 열기
  const f = known(req.body.path);
  if (!f) return res.sendStatus(404);
  if (process.platform === 'win32') require('child_process').spawn('explorer.exe', ['/select,', f.abs], { detached: true });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`\n  📷 Picture Manager 실행 중 →  http://localhost:${PORT}\n`));
