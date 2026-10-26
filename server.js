// 사진 Diff & 동기화 관리자 - 서버
const express = require('express');
const sharp = require('sharp');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile, spawnSync } = require('child_process');

sharp.cache(false);
const PORT = process.env.PORT || 3000;
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.avif', '.heic', '.heif']);
const VID_EXT = new Set(['.mp4', '.m4v', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.3gp', '.mts', '.m2ts', '.flv', '.mpg', '.mpeg']);
const isVideo = (p) => VID_EXT.has(path.extname(p).toLowerCase());
const VID_FRAMES = [0.1, 0.3, 0.5, 0.7, 0.9]; // 유사도 비교용 프레임 위치 (길이 비율)
const CACHE_DIR = path.join(__dirname, '.cache');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');
const META_CACHE_FILE = path.join(CACHE_DIR, 'analysis.json');
fs.mkdirSync(THUMB_DIR, { recursive: true });

// 파일 분석 캐시 (경로|크기|수정시간 → 분석 결과) : 재스캔·동기화 시 반복 디코딩/ffmpeg 호출 방지
const analysisCache = new Map();
try {
  if (fs.existsSync(META_CACHE_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(META_CACHE_FILE, 'utf8')))) analysisCache.set(k, v);
  }
} catch {}
const cacheKey = (abs, size, mtime) => `${path.resolve(abs).toLowerCase()}|${size}|${Math.floor(mtime)}`;
function saveAnalysisCache() {
  try {
    if (analysisCache.size > 20000) {
      const drop = analysisCache.size - 15000;
      let i = 0;
      for (const k of analysisCache.keys()) { if (i++ >= drop) break; analysisCache.delete(k); }
    }
    fs.writeFileSync(META_CACHE_FILE, JSON.stringify(Object.fromEntries(analysisCache)));
  } catch {}
}

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 상태 ----------------
let state = {
  job: { running: false, phase: 'idle', done: 0, total: 0, message: '', cancelled: false },
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
    } else if (e.isFile() && (IMG_EXT.has(path.extname(e.name).toLowerCase()) || isVideo(e.name))) out.push(p);
  }
  return out;
}

async function walkAll(dir, out = []) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walkAll(p, out); else out.push(p);
  }
  return out;
}

async function pool(items, n, fn, onProgress) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length && !state.job.cancelled) {
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

// dHash 64bit (유사 이미지 판정)
async function dHash(input) {
  const g = await sharp(input, { failOn: 'none' }).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += g[y * 9 + x] > g[y * 9 + x + 1] ? '1' : '0';
  let dhash = '';
  for (let i = 0; i < 64; i += 4) dhash += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return dhash;
}

async function imageChash(buf) {
  // 픽셀 내용 해시 (EXIF/메타데이터/파일정보 무시)
  const { data, info } = await sharp(buf, { failOn: 'none' }).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const chash = crypto.createHash('sha1').update(`${info.width}x${info.height}`).update(data).digest('hex');
  return { chash, width: info.width, height: info.height };
}

async function analyzeImage(abs) {
  const buf = await fsp.readFile(abs);
  const { chash, width, height } = await imageChash(buf);
  return { chash, dhash: await dHash(buf), width, height };
}

// 대용량 파일 전체를 메모리에 올리지 않고 앞·중간·뒤 64KB 샘플 + 파일 크기로 빠른 해시 생성
async function fastFileHash(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const st = await fh.stat();
    const h = crypto.createHash('sha1').update(`size:${st.size}|`);
    const chunk = 65536;
    const buf = Buffer.allocUnsafe(Math.min(chunk, Math.max(1, st.size)));
    const offsets = st.size <= chunk * 3
      ? [0, chunk, chunk * 2].filter((o) => o < st.size)
      : [0, Math.floor((st.size - chunk) / 2), Math.max(0, st.size - chunk)];
    for (const off of offsets) {
      const len = Math.min(buf.length, st.size - off);
      if (len <= 0) continue;
      const { bytesRead } = await fh.read(buf, 0, len, off);
      h.update(buf.subarray(0, bytesRead));
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
}

// ---------------- 동영상 (ffmpeg) ----------------
// FFMPEG_PATH/FFPROBE_PATH 환경변수 → PATH → ffmpeg-static/ffprobe-static 패키지 순으로 찾음
function findTool(name, envKey, pkg) {
  if (process.env[envKey]) return process.env[envKey];
  if (!spawnSync(name, ['-version'], { stdio: 'ignore' }).error) return name;
  try { const m = require(pkg); return typeof m === 'string' ? m : m.path; } catch { return null; }
}
const FFMPEG = findTool('ffmpeg', 'FFMPEG_PATH', 'ffmpeg-static');
const FFPROBE = findTool('ffprobe', 'FFPROBE_PATH', 'ffprobe-static');

// 동시 실행 ffmpeg/ffprobe 프로세스 수 제한 및 타임아웃/강제종료 관리 (무한 대기 및 디스크 병목 방지)
const MAX_FF = Math.min(4, Math.max(2, Math.floor(os.cpus().length / 2)));
let activeFfCount = 0;
const ffQueue = [];
const activeProcs = new Set();

function withFfLimit(fn) {
  return new Promise((resolve, reject) => {
    const next = () => {
      activeFfCount++;
      fn().then(resolve, reject).finally(() => {
        activeFfCount--;
        if (ffQueue.length) ffQueue.shift()();
      });
    };
    if (activeFfCount < MAX_FF) next();
    else ffQueue.push(next);
  });
}

function killActiveProcs() {
  for (const p of activeProcs) {
    try { p.kill('SIGKILL'); } catch {}
  }
  activeProcs.clear();
}

function run(bin, args, timeoutMs = 30000) {
  const fullArgs = bin === FFMPEG && args[0] !== '-nostdin' ? ['-nostdin', ...args] : args;
  return withFfLimit(() => new Promise((resolve, reject) => {
    if (state.job.cancelled) return reject(new Error('작업 취소됨'));
    const child = execFile(bin, fullArgs, {
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      activeProcs.delete(child);
      if (err) {
        const msg = err.killed ? `시간 초과 (${Math.round(timeoutMs / 1000)}초)` : String(stderr || err.message).trim().split('\n').pop();
        reject(new Error(msg || '실행 실패'));
      } else resolve(stdout);
    });
    activeProcs.add(child);
    try { child.stdin?.end(); } catch {}
  }));
}

async function probe(abs) {
  const j = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], 15000));
  const v = j.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new Error('영상 스트림 없음');
  const rot = Math.abs(Number(v.tags?.rotate || v.side_data_list?.find((d) => d.rotation != null)?.rotation || 0)) % 180;
  const [n, d] = String(v.avg_frame_rate || '0/1').split('/').map(Number);
  return {
    width: rot === 90 ? v.height : v.width, height: rot === 90 ? v.width : v.height,
    duration: Number(j.format?.duration || v.duration) || 0,
    vcodec: v.codec_name, fps: d ? Math.round((n / d) * 100) / 100 : 0,
    acodec: j.streams.find((s) => s.codec_type === 'audio')?.codec_name || null,
    bitrate: Number(j.format?.bit_rate) || 0, format: j.format?.format_name,
    created: j.format?.tags?.creation_time || v.tags?.creation_time || null,
  };
}

// 스트림 내용 해시: 컨테이너(mp4/mkv/mov)·메타데이터가 달라도 영상/음성 데이터가 같으면 동일
// 대용량 영상 전체를 끝까지 읽느라 멈추지 않도록 앞부분 15초 스트림 패킷을 해시
async function videoHash(abs) {
  if (!FFMPEG) return 'file:' + await fastFileHash(abs);
  try {
    const out = await run(FFMPEG, [
      '-v', 'error', '-i', abs, '-t', '15',
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-',
    ], 20000);
    if (out && out.length) return 'vid:' + crypto.createHash('sha1').update(out).digest('hex');
  } catch {}
  return 'file:' + await fastFileHash(abs);
}

// 지정 위치의 프레임을 PNG로 추출 (회전 자동 적용, EOF 탐색 실패 시 0초 프레임으로 폴백)
async function frameAt(abs, t, w) {
  try {
    const out = await run(FFMPEG, ['-v', 'error', '-ss', String(t), '-i', abs, '-frames:v', '1', '-an',
      '-vf', `scale='min(${w},iw)':-2`, '-f', 'image2pipe', '-c:v', 'png', '-'], 15000);
    if (out && out.length) return out;
  } catch {}
  if (Number(t) > 0) {
    try {
      const out = await run(FFMPEG, ['-v', 'error', '-i', abs, '-frames:v', '1', '-an',
        '-vf', `scale='min(${w},iw)':-2`, '-f', 'image2pipe', '-c:v', 'png', '-'], 15000);
      if (out && out.length) return out;
    } catch {}
  }
  return Buffer.alloc(0);
}

function thumbCachePath(abs, mtime, size = 320) {
  const key = crypto.createHash('md5').update(`${abs}|${mtime}|${size}`).digest('hex');
  return path.join(THUMB_DIR, key + '.webp');
}

async function analyzeVideo(abs, mtime) {
  if (!FFMPEG || !FFPROBE) return { chash: await videoHash(abs), dhash: null, width: 0, height: 0, duration: 0, noFfmpeg: true };
  const [meta, chash] = await Promise.all([probe(abs), videoHash(abs)]);
  // 여러 위치의 프레임 dHash를 이어 붙여 영상 지문으로 사용
  let dhash = '';
  for (let idx = 0; idx < VID_FRAMES.length; idx++) {
    const r = VID_FRAMES[idx];
    const w = idx === 0 ? 320 : 160;
    const png = await frameAt(abs, ((meta.duration || 0) * r).toFixed(3), w);
    dhash += png.length ? await dHash(png) : '0'.repeat(16);
    // 첫 프레임(10%) 추출 시 기본 썸네일(320px)도 미리 캐싱해 UI 렌더링 시 재추출 방지
    if (idx === 0 && png.length && mtime) {
      const tc = thumbCachePath(abs, mtime, 320);
      if (!fs.existsSync(tc)) {
        sharp(png, { failOn: 'none' }).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(tc).catch(() => {});
      }
    }
  }
  return { chash, dhash, ...meta };
}

async function analyzeWithCache(f) {
  const key = cacheKey(f.abs, f.size, f.mtime);
  const cached = analysisCache.get(key);
  if (cached && cached.chash && cached.dhash !== undefined && (!isVideo(f.abs) || !FFMPEG || !cached.noFfmpeg)) {
    return cached;
  }
  const res = isVideo(f.abs) ? await analyzeVideo(f.abs, f.mtime) : await analyzeImage(f.abs);
  analysisCache.set(key, res);
  return res;
}

async function contentHash(abs) {
  const knownFile = state.files.find((f) => f.abs === abs && f.chash && !f.error);
  if (knownFile) return knownFile.chash;
  const st = await fsp.stat(abs);
  const key = cacheKey(abs, st.size, st.mtimeMs);
  const cached = analysisCache.get(key);
  if (cached && cached.chash && (!isVideo(abs) || !FFMPEG || !cached.noFfmpeg)) return cached.chash;
  if (isVideo(abs)) {
    const chash = await videoHash(abs);
    analysisCache.set(key, { ...(cached || {}), chash });
    return chash;
  }
  const buf = await fsp.readFile(abs);
  const { chash, width, height } = await imageChash(buf);
  analysisCache.set(key, { ...(cached || {}), chash, width, height });
  return chash;
}

// 같은 종류끼리만 비교. 동영상은 프레임당 평균 거리 + 길이가 비슷해야 유사
function similar(a, b, threshold) {
  if (!a.dhash || !b.dhash || a.kind !== b.kind || a.dhash.length !== b.dhash.length) return false;
  if (a.kind === 'video') {
    if (Math.abs(a.duration - b.duration) > Math.max(1, 0.02 * Math.max(a.duration, b.duration))) return false;
    return hamming(a.dhash, b.dhash) / VID_FRAMES.length <= threshold;
  }
  return hamming(a.dhash, b.dhash) <= threshold;
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
  Object.assign(job, { running: true, cancelled: false, phase: '파일 검색 중', done: 0, total: 0, message: '', current: '' });
  state.roots = roots;
  try {
    const files = [];
    for (const [key, dir] of Object.entries(roots)) {
      if (!dir) continue;
      const list = await walk(dir);
      for (const abs of list) {
        if (job.cancelled) throw new Error('작업이 취소되었습니다');
        let st;
        try { st = await fsp.stat(abs); } catch { continue; }
        files.push({
          id: files.length, root: key, rootDir: dir, abs,
          rel: path.relative(dir, abs), name: path.basename(abs),
          size: st.size, mtime: st.mtimeMs, ctime: st.birthtimeMs, kind: isVideo(abs) ? 'video' : 'image',
        });
      }
    }
    Object.assign(job, { phase: '사진·동영상 분석 중', total: files.length, startedAt: Date.now(), stats: null });
    const concurrency = Math.min(8, Math.max(2, os.cpus().length - 1));
    await pool(files, concurrency, async (f) => {
      job.current = `[${f.root}] ${f.rel}`;
      try { Object.assign(f, await analyzeWithCache(f)); }
      catch (e) { f.error = String(e.message || e); f.chash = 'err:' + f.abs; f.dhash = null; }
    }, () => job.done++);

    if (job.cancelled) throw new Error('작업이 취소되었습니다');
    saveAnalysisCache();

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
      const a = hashGroups[i][0]; if (!a.dhash) continue;
      for (let j = i + 1; j < hashGroups.length; j++) {
        if (similar(a, hashGroups[j][0], threshold)) parent[find(i)] = find(j);
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
async function recordDestCache(dest, f) {
  try {
    const st = await fsp.stat(dest);
    analysisCache.set(cacheKey(dest, st.size, st.mtimeMs), {
      chash: f.chash, dhash: f.dhash, width: f.width, height: f.height,
      duration: f.duration, vcodec: f.vcodec, fps: f.fps, acodec: f.acodec,
      bitrate: f.bitrate, format: f.format, created: f.created,
    });
  } catch {}
}

async function uniqueDest(dest, chash, used) {
  const ext = path.extname(dest), stem = dest.slice(0, -ext.length);
  let cand = dest, n = 1;
  while (true) {
    const key = cand.toLowerCase();
    if (used.has(key)) {
      if (used.get(key) === chash) return null; // 같은 내용 이미 배치됨
    } else if (fs.existsSync(cand)) {
      try {
        const existingHash = await contentHash(cand);
        used.set(key, existingHash);
        if (existingHash === chash) return null;
      } catch {
        used.set(key, 'err:' + key);
      }
    } else { used.set(key, chash); return cand; }
    cand = `${stem} (${n++})${ext}`;
  }
}

async function moveFile(src, dst) {
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try { await fsp.rename(src, dst); }
  catch {
    const st = await fsp.stat(src);
    await fsp.copyFile(src, dst);
    await fsp.utimes(dst, st.atime, st.mtime).catch(() => {});
    await fsp.unlink(src);
  }
}

async function runSync({ target, mode, unchecked, keepMap }) {
  const job = state.job;
  for (const [id, v] of Object.entries(keepMap || {})) if (state.files[id]) state.files[id].keep = !!v;
  const keep = state.files.filter((f) => f.keep && !f.error);
  const drop = state.files.filter((f) => !f.keep && !f.error);
  const isMove = mode === 'move';
  Object.assign(job, {
    running: true, cancelled: false, phase: '동기화 중',
    done: 0, total: keep.length + (isMove || unchecked !== 'leave' ? drop.length : 0), message: '',
  });
  const log = { copied: 0, moved: 0, skipped: 0, renamed: 0, deleted: 0, trashed: 0, pending: 0, dupDeleted: 0, errors: [] };
  job.stats = log; job.current = ''; job.startedAt = Date.now();
  const used = new Map();
  // 이동 모드: 중복 파일은 C/삭제예정 으로 (같은 내용은 1개만 남기고 삭제)
  const pendingDir = path.join(target, '삭제예정');
  const pendingHashes = new Set();
  const pendingUsed = new Map();
  async function toPending(f) {
    if (!fs.existsSync(f.abs)) return;
    if (pendingHashes.has(f.chash)) { await fsp.unlink(f.abs); log.dupDeleted++; return; }
    pendingHashes.add(f.chash);
    const dest = await uniqueDest(path.join(pendingDir, f.root, f.rel), f.chash, pendingUsed);
    if (!dest) { await fsp.unlink(f.abs); log.dupDeleted++; return; } // 이미 삭제예정에 동일 파일 존재
    await moveFile(f.abs, dest);
    await recordDestCache(dest, f);
    log.pending++;
  }
  try {
    await fsp.mkdir(target, { recursive: true });
    if (isMove && fs.existsSync(pendingDir)) { // 이전 삭제예정 파일 해시 등록
      job.current = '기존 삭제예정 폴더 확인 중…';
      for (const p of await walkAll(pendingDir)) {
        if (job.cancelled) throw new Error('작업이 취소되었습니다');
        try { pendingHashes.add(await contentHash(p)); } catch {}
      }
    }
    for (const f of keep) {
      if (job.cancelled) throw new Error('작업이 취소되었습니다');
      job.current = `[${f.root}] ${f.rel}`;
      try {
        if (!fs.existsSync(f.abs)) { log.skipped++; job.done++; continue; }
        const dest = await uniqueDest(path.join(target, f.rel), f.chash, used);
        if (!dest) { log.skipped++; if (isMove) await toPending(f); }
        else {
          if (dest !== path.join(target, f.rel)) log.renamed++;
          if (mode === 'move') {
            await moveFile(f.abs, dest);
            await recordDestCache(dest, f);
            log.moved++;
          } else {
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.copyFile(f.abs, dest);
            const st = await fsp.stat(f.abs);
            await fsp.utimes(dest, st.atime, st.mtime).catch(() => {});
            await recordDestCache(dest, f);
            log.copied++;
          }
        }
      } catch (e) { log.errors.push(`${f.abs}: ${e.message}`); }
      job.done++;
    }
    if (isMove) {
      for (const f of drop) {
        if (job.cancelled) throw new Error('작업이 취소되었습니다');
        job.current = `[${f.root}] ${f.rel}`;
        try { await toPending(f); } catch (e) { log.errors.push(`${f.abs}: ${e.message}`); }
        job.done++;
      }
    } else if (unchecked !== 'leave') {
      for (const f of drop) {
        if (job.cancelled) throw new Error('작업이 취소되었습니다');
        job.current = `[${f.root}] ${f.rel}`;
        try {
          if (!fs.existsSync(f.abs)) { job.done++; continue; }
          if (unchecked === 'trash') {
            const trashDest = path.join(target, '_휴지통', f.root, f.rel);
            await moveFile(f.abs, trashDest);
            await recordDestCache(trashDest, f);
            log.trashed++;
          } else if (unchecked === 'delete') {
            await fsp.unlink(f.abs);
            log.deleted++;
          }
        } catch (e) { log.errors.push(`${f.abs}: ${e.message}`); }
        job.done++;
      }
    }
    saveAnalysisCache();
    Object.assign(job, { running: false, phase: 'synced', message: JSON.stringify(log) });
  } catch (e) {
    saveAnalysisCache();
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

app.post('/api/cancel', (req, res) => {
  if (state.job.running) {
    state.job.cancelled = true;
    killActiveProcs();
  }
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
  for (const r of Object.values(state.roots)) {
    if (!r) continue;
    const rp = path.resolve(r);
    if (rp.toLowerCase() === t.toLowerCase()) return res.status(400).json({ error: '대상 폴더는 원본 폴더와 달라야 합니다' });
  }
  runSync(req.body);
  res.json({ ok: true });
});

app.get('/api/thumb', async (req, res) => {
  const f = known(req.query.path);
  if (!f) return res.sendStatus(404);
  const size = Math.min(Number(req.query.size) || 320, 1600);
  const cache = thumbCachePath(f.abs, f.mtime, size);
  try {
    if (!fs.existsSync(cache)) {
      // 동영상은 10% 지점 프레임을 썸네일로
      const src = f.kind === 'video' ? await frameAt(f.abs, ((f.duration || 0) * 0.1).toFixed(3), size) : f.abs;
      if (f.kind === 'video' && (!src || !src.length)) return res.sendStatus(415);
      await sharp(src, { failOn: 'none' }).rotate().resize(size, size, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toFile(cache);
    }
    res.set('Cache-Control', 'max-age=86400').sendFile(cache);
  } catch { res.sendStatus(415); }
});

app.get('/api/image', async (req, res) => {
  const f = known(req.query.path);
  if (!f) return res.sendStatus(404);
  const ext = path.extname(f.abs).toLowerCase();
  if (f.kind === 'video' || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'].includes(ext)) return res.sendFile(f.abs); // 동영상은 Range 스트리밍
  try { // 브라우저 미지원 포맷은 변환
    const buf = await sharp(f.abs, { failOn: 'none' }).rotate().jpeg({ quality: 92 }).toBuffer();
    res.type('jpeg').send(buf);
  } catch { res.sendStatus(415); }
});

app.get('/api/meta', async (req, res) => {
  const f = known(req.query.path);
  if (!f) return res.sendStatus(404);
  try {
    if (f.kind === 'video') return res.json(await probe(f.abs));
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

app.get('/api/info', (req, res) => res.json({ ffmpeg: !!(FFMPEG && FFPROBE) }));

app.listen(PORT, () => console.log(`\n  📷 Picture Manager 실행 중 →  http://localhost:${PORT}\n` +
  (FFMPEG && FFPROBE ? '' : '  ⚠ ffmpeg/ffprobe 를 찾을 수 없어 동영상은 파일 바이트 비교만 합니다 (FFMPEG_PATH 지정 또는 PATH 추가)\n')));
