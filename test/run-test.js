// 샘플 데이터 생성 + 자동 테스트 (node test/run-test.js)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'sample_data');
const A = path.join(ROOT, 'A'), B = path.join(ROOT, 'B'), C = path.join(ROOT, 'C');
const BASE = `http://localhost:${process.env.PORT || 3000}`;

const svg = (h1, h2, shape) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},80%,55%)"/><stop offset="1" stop-color="hsl(${h2},80%,35%)"/></linearGradient></defs>
  <rect width="800" height="600" fill="url(#g)"/>${shape}</svg>`);
// 시드별로 구조가 확연히 다른 이미지 (유사도 오판 방지)
const img = (i) => {
  let s = i * 9301 + 49297; const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  let shapes = '';
  for (let k = 0; k < 6; k++) {
    shapes += `<rect x="${rnd() * 700}" y="${rnd() * 500}" width="${60 + rnd() * 300}" height="${60 + rnd() * 300}" fill="${rnd() > .5 ? 'white' : 'black'}" opacity=".6"/>`;
    shapes += `<circle cx="${rnd() * 800}" cy="${rnd() * 600}" r="${30 + rnd() * 120}" fill="hsl(${rnd() * 360},90%,60%)"/>`;
  }
  return sharp(svg(i * 37 % 360, (i * 37 + 160) % 360, shapes));
};

async function put(p, pipeline, mtime) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  await pipeline.toFile(p);
  if (mtime) fs.utimesSync(p, mtime, mtime);
}

async function makeSamples() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  const old = new Date('2020-05-01'), recent = new Date('2025-08-15');
  // 1) 완전히 같은 파일 (같은 이름)
  await put(`${A}/2023/여행/beach.png`, img(1).png());
  fs.mkdirSync(`${B}/backup/여행`, { recursive: true });
  fs.copyFileSync(`${A}/2023/여행/beach.png`, `${B}/backup/여행/beach.png`);
  // 2) 같은 이름, 픽셀 동일하지만 압축/메타데이터/날짜가 다름
  await put(`${A}/2023/family.png`, img(2).png({ compressionLevel: 9 }), old);
  await put(`${B}/family.png`, img(2).png({ compressionLevel: 1 }).withMetadata({ exif: { IFD0: { Copyright: 'B-copy' } } }), recent);
  // 3) 이름이 다른데 내용 동일
  await put(`${A}/2024/IMG_0001.png`, img(3).png());
  await put(`${B}/phone/renamed_copy.png`, img(3).png({ compressionLevel: 2 }));
  // 4) 같은 이름, 완전히 다른 사진 (이름 충돌)
  await put(`${A}/2024/photo.jpg`, img(4).jpeg({ quality: 90 }));
  await put(`${B}/2024/photo.jpg`, img(9).jpeg({ quality: 90 }));
  // 5) 유사 이미지 (리사이즈 + 재압축)
  await put(`${A}/2024/sunset.jpg`, img(5).jpeg({ quality: 95 }));
  await put(`${B}/small/sunset_small.jpg`, img(5).resize(400).jpeg({ quality: 60 }));
  // 6) A에만 / B에만
  await put(`${A}/only_in_A.jpg`, img(6).jpeg());
  await put(`${B}/deep/sub/folder/only_in_B.webp`, img(7).webp());
  // 7) 깨진 파일
  fs.writeFileSync(`${B}/broken.jpg`, 'not an image');
}

const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (u) => fetch(BASE + u).then((r) => r.json());
async function wait() { for (;;) { const s = await get('/api/status'); if (!s.running) return s; await new Promise((r) => setTimeout(r, 300)); } }
function assert(c, m) { console.log(`${c ? '  ✅' : '  ❌'} ${m}`); if (!c) process.exitCode = 1; }

function listFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    e.isDirectory() ? listFiles(p, out) : out.push(path.relative(C, p).replace(/\\/g, '/'));
  }
  return out;
}

(async () => {
  console.log('▶ 샘플 데이터 생성:', ROOT);
  await makeSamples();
  if (process.argv.includes('--samples-only')) return;

  console.log('▶ 스캔');
  await post('/api/scan', { a: A, b: B, threshold: 6 });
  const s = await wait();
  console.log('  ', s.message);
  const r = await get('/api/result');
  const F = (rel, root) => r.files.find((f) => f.root === root && f.rel.replace(/\\/g, '/') === rel);
  const G = (f) => r.groups[f.groupId];

  assert(r.files.length === 13, `파일 13개 검색 (하위폴더 포함): ${r.files.length}`);
  assert(G(F('2023/여행/beach.png', 'A')) === G(F('backup/여행/beach.png', 'B')) && G(F('2023/여행/beach.png', 'A')).type === 'exact', '동일 파일 → 완전 동일');
  assert(G(F('2023/family.png', 'A')).id === G(F('family.png', 'B')).id && G(F('family.png', 'B')).type === 'exact', '날짜/메타데이터만 다름 → 완전 동일');
  assert(G(F('2024/IMG_0001.png', 'A')).id === G(F('phone/renamed_copy.png', 'B')).id, '이름 다르고 내용 같음 → 같은 그룹');
  assert(G(F('2024/photo.jpg', 'A')).id !== G(F('2024/photo.jpg', 'B')).id && G(F('2024/photo.jpg', 'A')).nameConflict, '같은 이름 다른 사진 → 별도 그룹 + 이름충돌 표시');
  const sg = G(F('2024/sunset.jpg', 'A'));
  assert(sg.id === G(F('small/sunset_small.jpg', 'B')).id && sg.type === 'similar', '리사이즈/재압축 → 유사 그룹');
  assert(F('2024/sunset.jpg', 'A').keep && !F('small/sunset_small.jpg', 'B').keep, '유사 그룹 추천 = 고해상도');
  assert(!!F('broken.jpg', 'B').error, '깨진 파일 오류 처리');

  console.log('▶ 동기화 (복사, 미체크→_휴지통 제외 테스트는 leave)');
  // 이름 충돌 두 파일 모두 유지
  const keepMap = Object.fromEntries(r.files.map((f) => [f.id, f.keep]));
  keepMap[F('2024/photo.jpg', 'B').id] = true;
  keepMap[F('2024/photo.jpg', 'A').id] = true;
  await post('/api/sync', { target: C, mode: 'copy', unchecked: 'leave', keepMap });
  const s2 = await wait();
  console.log('  ', s2.message);
  const out = listFiles(C).sort();
  console.log('   C 결과:', out);
  assert(out.filter((x) => x.endsWith('beach.png')).length === 1, 'beach.png 1개만 존재');
  assert(out.filter((x) => /family\.png$/.test(x)).length === 1, 'family.png 1개만 존재');
  assert(out.includes('2024/photo.jpg') && out.includes('2024/photo (1).jpg'), '이름 충돌 → photo (1).jpg 로 저장');
  assert(out.includes('deep/sub/folder/only_in_B.webp') && out.includes('2023/여행/beach.png'), '하위폴더 구조 유지');
  assert(out.length === 8, `총 8개 (중복 제거): ${out.length}`);

  console.log('▶ 재동기화 (이미 있는 동일 파일 건너뜀)');
  await post('/api/sync', { target: C, mode: 'copy', unchecked: 'leave', keepMap });
  const l = JSON.parse((await wait()).message);
  assert(l.copied === 0 && listFiles(C).length === 8, `중복 복사 없음 (skipped ${l.skipped})`);

  console.log('▶ 이동 모드 테스트 (삭제예정 폴더 + 중복 1개만 남김)');
  const C2 = path.join(ROOT, 'C_move');
  fs.mkdirSync(`${A}/dup`, { recursive: true });
  fs.copyFileSync(`${A}/2023/여행/beach.png`, `${A}/dup/beach_copy.png`); // beach 3개
  await post('/api/scan', { a: A, b: B, threshold: 6 });
  await wait();
  const r2 = await get('/api/result');
  await post('/api/sync', { target: C2, mode: 'move', unchecked: 'leave', keepMap: Object.fromEntries(r2.files.map((f) => [f.id, f.keep])) });
  const l2 = JSON.parse((await wait()).message);
  console.log('  ', JSON.stringify(l2));
  const walk2 = (d, o = []) => { if (fs.existsSync(d)) for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk2(p, o) : o.push(path.relative(C2, p).replace(/\\/g, '/')); } return o; };
  const out2 = walk2(C2).sort();
  console.log('   C_move 결과:', out2);
  const pend = out2.filter((x) => x.startsWith('삭제예정/'));
  assert(out2.filter((x) => !x.startsWith('삭제예정/')).length === 8, '유지 파일 8개 이동 (중복 그룹은 1개씩)');
  assert(pend.length === 4 && l2.pending === 4, `삭제예정 4개: ${pend.length}`);
  assert(pend.filter((x) => /beach/.test(x)).length === 1 && l2.dupDeleted === 1, '삭제예정 안의 동일 beach는 1개만 남기고 1개 삭제');
  const leftA = walk2(A).length, leftOrig = [...listFilesAbs(A), ...listFilesAbs(B)];
  assert(leftOrig.length === 1 && leftOrig[0].endsWith('broken.jpg'), `원본에 깨진 파일만 남음: ${leftOrig.length}`);
  console.log(process.exitCode ? '\n❌ 일부 테스트 실패' : '\n🎉 모든 테스트 통과');
})();

function listFilesAbs(d, o = []) {
  if (fs.existsSync(d)) for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? listFilesAbs(p, o) : o.push(p); }
  return o;
}
