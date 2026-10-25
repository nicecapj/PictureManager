// 사진 Diff & 동기화 관리자 - 프론트엔드
const $ = (s) => document.querySelector(s);
const api = async (url, body) => {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
};
const thumb = (f, s = 320) => `/api/thumb?size=${s}&path=${encodeURIComponent(f.abs)}`;
const full = (f) => `/api/image?path=${encodeURIComponent(f.abs)}`;
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB');
const fmtDate = (t) => (t ? new Date(t).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '-');
const fmtDur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const isVid = (f) => f.kind === 'video';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let data = { files: [], groups: [] };
let filter = 'all', query = '', shown = 0;
const PAGE = 60;
let visibleGroups = [];

function toast(msg, ms = 3500) {
  const t = $('#toast'); t.innerHTML = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms);
}

// ---------- 저장 ----------
['dirA', 'dirB', 'dirC'].forEach((id) => {
  const el = $('#' + id); el.value = localStorage.getItem(id) || '';
  el.addEventListener('change', () => localStorage.setItem(id, el.value));
});
$('#threshold').oninput = (e) => ($('#thrVal').textContent = e.target.value);

// ---------- 폴더 브라우저 ----------
let brTarget = null, brCur = '';
async function brLoad(p) {
  try {
    const r = await api('/api/ls?path=' + encodeURIComponent(p || ''));
    brCur = r.path; $('#brPath').value = r.path;
    $('#brUp').dataset.p = r.parent ?? '';
    $('#brList').innerHTML = r.dirs.map((d) => `<li data-p="${esc(d.path)}">📁 ${esc(d.name)}</li>`).join('') || '<li style="color:var(--mute)">(하위 폴더 없음)</li>';
  } catch (e) { toast('⚠ ' + e.message); }
}
document.querySelectorAll('[data-browse]').forEach((b) => (b.onclick = () => {
  brTarget = b.dataset.browse; $('#browser').classList.remove('hidden'); brLoad($('#' + brTarget).value);
}));
$('#brList').onclick = (e) => { const li = e.target.closest('li[data-p]'); if (li) brLoad(li.dataset.p); };
$('#brUp').onclick = () => brLoad($('#brUp').dataset.p);
$('#brGo').onclick = () => brLoad($('#brPath').value);
$('#brPath').onkeydown = (e) => e.key === 'Enter' && brLoad($('#brPath').value);
$('#brCancel').onclick = () => $('#browser').classList.add('hidden');
$('#brOk').onclick = () => {
  if (!brCur) return toast('폴더를 선택하세요');
  const el = $('#' + brTarget); el.value = brCur; el.dispatchEvent(new Event('change'));
  $('#browser').classList.add('hidden');
};
$('#brMk').onclick = async () => {
  if (!brCur) return;
  const n = prompt('새 폴더 이름'); if (!n) return;
  const p = brCur.replace(/[\\/]$/, '') + '\\' + n;
  try { await api('/api/mkdir', { path: p }); brLoad(p); } catch (e) { toast('⚠ ' + e.message); }
};

api('/api/info').then((i) => { if (!i.ffmpeg) toast('⚠ ffmpeg 를 찾을 수 없어 동영상은 파일 바이트가 같은지만 비교합니다', 8000); }).catch(() => {});

// ---------- 스캔 & 진행 ----------
const STAT_LABEL = { copied: '복사', moved: '이동', skipped: '중복건너뜀', renamed: '이름변경', pending: '삭제예정', dupDeleted: '중복삭제', trashed: '휴지통', deleted: '삭제' };
function fmtEta(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`; }
async function poll(onDone, title) {
  $('#progress').classList.remove('hidden');
  if (title) { $('#jobTitle').textContent = title; $('#jobOverlay').classList.remove('hidden'); }
  const tick = async () => {
    let s;
    try { s = await api('/api/status'); } catch { return setTimeout(tick, 800); }
    const pct = s.total ? (s.done / s.total) * 100 : (s.running ? 0 : 100);
    $('#progBar').style.width = pct + '%';
    $('#progText').textContent = `${s.phase} ${s.total ? `${s.done}/${s.total}` : ''}`;
    // 오버레이
    $('#jobPct').textContent = Math.floor(pct) + '%';
    $('#ringFg').style.strokeDashoffset = 326.7 * (1 - pct / 100);
    $('#jobBar').style.width = pct + '%';
    $('#jobCount').textContent = `${s.phase} · ${s.done} / ${s.total}`;
    const el = s.startedAt ? Date.now() - s.startedAt : 0;
    $('#jobEta').textContent = s.running && s.done > 0 && s.total ? `남은 시간 약 ${fmtEta((el / s.done) * (s.total - s.done))}` : el ? `경과 ${fmtEta(el)}` : '';
    $('#jobCur').textContent = s.running ? s.current || '' : '완료';
    $('#jobStats').innerHTML = s.stats ? Object.entries(STAT_LABEL).filter(([k]) => s.stats[k]).map(([k, v]) => `<span>${v} <b>${s.stats[k]}</b></span>`).join('') +
      (s.stats.errors?.length ? `<span style="color:var(--danger)">오류 ${s.stats.errors.length}</span>` : '') : '';
    if (s.running) return setTimeout(tick, 300);
    setTimeout(() => { $('#progress').classList.add('hidden'); $('#jobOverlay').classList.add('hidden'); }, 900);
    onDone(s);
  };
  tick();
}

$('#btnScan').onclick = async () => {
  const a = $('#dirA').value.trim(), b = $('#dirB').value.trim();
  if (!a && !b) return toast('폴더 A 또는 B를 지정하세요');
  try {
    await api('/api/scan', { a, b, threshold: $('#threshold').value });
    $('#btnScan').disabled = true;
    poll(async (s) => {
      $('#btnScan').disabled = false;
      if (s.phase === 'error') return toast('⚠ ' + s.message);
      data = await api('/api/result');
      toast('✅ 스캔 완료 · ' + s.message);
      render();
    }, '🔍 사진·동영상 스캔 · 분석 중…');
  } catch (e) { toast('⚠ ' + e.message); }
};

// ---------- 분류 ----------
function groupMatches(g, f) {
  const files = g.fileIds.map((id) => data.files[id]);
  const roots = new Set(files.map((x) => x.root));
  switch (f) {
    case 'exact': return g.type === 'exact';
    case 'similar': return g.type === 'similar';
    case 'conflict': return g.nameConflict;
    case 'onlyA': return roots.size === 1 && roots.has('A');
    case 'onlyB': return roots.size === 1 && roots.has('B');
    case 'unique': return g.type === 'unique';
    case 'photo': return files[0].kind !== 'video';
    case 'video': return files[0].kind === 'video';
    default: return true;
  }
}
function updateCounts() {
  for (const k of ['all', 'exact', 'similar', 'conflict', 'onlyA', 'onlyB', 'unique', 'photo', 'video'])
    $('#cnt-' + k).textContent = data.groups.filter((g) => groupMatches(g, k)).length;
  const keep = data.files.filter((f) => f.keep).length;
  $('#selStat').innerHTML = `유지 <b style="color:var(--c)">${keep}</b> / 전체 ${data.files.length}`;
  $('#btnSync').disabled = !data.files.length;
}

function render() {
  $('#empty').classList.toggle('hidden', data.files.length > 0);
  const q = query.toLowerCase();
  visibleGroups = data.groups.filter((g) => groupMatches(g, filter) &&
    (!q || g.fileIds.some((id) => data.files[id].rel.toLowerCase().includes(q))));
  $('#groups').innerHTML = ''; shown = 0;
  renderMore(); updateCounts();
}
function renderMore() {
  const frag = document.createDocumentFragment();
  for (const g of visibleGroups.slice(shown, shown + PAGE)) frag.appendChild(groupEl(g));
  shown += PAGE;
  $('#groups').appendChild(frag);
  $('#more').classList.toggle('hidden', shown >= visibleGroups.length);
}
$('#btnMore').onclick = renderMore;
$('#search').oninput = (e) => { query = e.target.value; render(); };
$('#tabs').onclick = (e) => {
  const t = e.target.closest('.tab'); if (!t) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
  t.classList.add('active'); filter = t.dataset.filter; render();
};

function bestId(g) {
  return g.fileIds.map((id) => data.files[id]).filter((f) => !f.error).sort((a, b) =>
    (b.width * b.height - a.width * a.height) || (b.size - a.size) || (b.mtime - a.mtime))[0]?.id;
}

const LABEL = { exact: '🟰 완전 동일', similar: '≈ 유사', unique: '고유' };
// 같은 쪽(A 또는 B) 안에서 픽셀 내용이 같은 파일들은 카드 1장으로 합침
function stacksOf(files, bid) {
  const m = new Map();
  for (const f of files) { const k = f.root + '|' + f.chash; if (!m.has(k)) m.set(k, []); m.get(k).push(f); }
  return [...m.values()].map((list) => {
    const rep = list.find((f) => f.id === bid) || list.find((f) => f.keep) || list[0];
    return { rep, others: list.filter((f) => f !== rep) };
  });
}
function groupEl(g) {
  const el = document.createElement('div');
  el.className = 'group'; el.dataset.gid = g.id;
  const files = g.fileIds.map((id) => data.files[id]);
  const bid = bestId(g);
  const multi = files.length > 1;
  const col = (root) => {
    const st = stacksOf(files.filter((f) => f.root === root), bid);
    if (!st.length) return '';
    const n = files.filter((f) => f.root === root).length;
    return `<div class="col"><div class="col-h ${root}">${root} 폴더 <em>${n}개${n > st.length ? ` · 중복 ${n - st.length}` : ''}</em></div>
      <div class="cards">${st.map((s) => cardHtml(s.rep, multi && s.rep.id === bid, s.others)).join('')}</div></div>`;
  };
  el.innerHTML = `
    <div class="g-head">
      <span class="badge ${g.type}">${LABEL[g.type]}</span>
      ${g.nameConflict ? '<span class="badge conflict">⚠ 이름 같음·내용 다름</span>' : ''}
      <span>${files.length}개 파일${g.type === 'similar' ? ` · ${g.subgroups.length}종 ${files[0].kind === 'video' ? '영상' : '이미지'}` : ''}</span>
      <span class="sp"></span>
      ${multi ? '<button class="btn ghost sm" data-act="diff">⇆ Diff 비교</button>' : ''}
    </div>
    <div class="cols">${col('A')}${col('B')}</div>`;
  return el;
}
function cardHtml(f, isBest, others = []) {
  const dupTip = others.map((o) => o.rel).join('\n');
  return `<div class="card ${f.keep ? 'keep' : ''}" data-fid="${f.id}" title="${esc(f.abs)}">
    <img class="thumb" loading="lazy" src="${thumb(f)}" alt="${esc(f.name)}">
    <span class="chk">${f.keep ? '✓' : ''}</span>
    <span class="root ${f.root}">${f.root}</span>
    ${isBest ? '<span class="best">★ 추천</span>' : ''}
    ${isVid(f) ? `<span class="vid">▶ ${fmtDur(f.duration)}</span>` : ''}
    ${others.length ? `<span class="dup" title="같은 폴더 안의 동일 파일:\n${esc(dupTip)}">동일 ×${others.length + 1}</span>` : ''}
    <button class="btn ghost sm zoom" data-act="view">🔍</button>
    <div class="info">
      <div class="name">${esc(f.name)}</div>
      <div class="rel">${esc(f.rel)}</div>
      ${others.length ? `<div class="rel dupl">+ ${others.map((o) => esc(o.rel)).join(', ')}</div>` : ''}
      ${f.error ? `<div class="err">읽기 실패</div>` : `<div class="sub">${f.width ? `${f.width}×${f.height} · ` : ''}${isVid(f) && f.vcodec ? `${f.vcodec} · ` : ''}${fmtSize(f.size)} · ${fmtDate(f.mtime)}</div>`}
    </div></div>`;
}
function setKeep(id, v) {
  const f = data.files[id]; if (f.error) return;
  f.keep = v;
  document.querySelectorAll(`.card[data-fid="${id}"]`).forEach((c) => {
    c.classList.toggle('keep', v); c.querySelector('.chk').textContent = v ? '✓' : '';
  });
  updateCounts();
}
$('#groups').onclick = (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const card = e.target.closest('.card');
  const gid = +e.target.closest('.group')?.dataset.gid;
  if (act === 'diff') return openDiff(data.groups[gid]);
  if (act === 'view') return openViewer(+card.dataset.fid);
  if (card) setKeep(+card.dataset.fid, !data.files[+card.dataset.fid].keep);
};
$('#groups').ondblclick = (e) => { const c = e.target.closest('.card'); if (c) openViewer(+c.dataset.fid); };

$('#btnRecommend').onclick = () => {
  for (const g of visibleGroups) {
    const b = bestId(g);
    g.fileIds.forEach((id) => (data.files[id].keep = g.type === 'unique' ? !data.files[id].error : id === b));
  }
  render(); toast('✨ 그룹마다 해상도·용량·최신순으로 1개 선택');
};
$('#btnKeepAll').onclick = () => {
  visibleGroups.forEach((g) => g.fileIds.forEach((id) => { if (!data.files[id].error) data.files[id].keep = true; }));
  render();
};

// ---------- Diff ----------
let diffPair = [];
function openDiff(g) {
  const files = g.fileIds.map((id) => data.files[id]);
  // 서로 다른 이미지(유사 그룹) 또는 A vs B 를 우선 비교
  const a = files.find((f) => f.root === 'A') || files[0];
  const b = files.find((f) => f !== a && f.chash !== a.chash) || files.find((f) => f !== a && f.root !== a.root) || files.find((f) => f !== a);
  diffPair = [a, b, files];
  $('#diff').classList.remove('hidden');
  renderDiff();
}
function paneSel(which, cur, files) {
  return `<select data-which="${which}">${files.map((f) => `<option value="${f.id}" ${f.id === cur.id ? 'selected' : ''}>[${f.root}] ${esc(f.rel)}</option>`).join('')}</select>`;
}
function renderDiff() {
  const [a, b, files] = diffPair;
  const mode = document.querySelector('input[name=dm]:checked').value;
  const body = $('#diffBody');
  const keepBtn = (f) => `<button class="btn sm ${f.keep ? 'primary' : 'ghost'}" data-keep="${f.id}">${f.keep ? '✓ 유지' : '☐ 유지'}</button>`;
  if (mode === 'side') {
    const media = (f) => (isVid(f) ? `<video src="${full(f)}" poster="${thumb(f, 1600)}" controls preload="metadata"></video>` : `<img src="${thumb(f, 1600)}">`);
    body.innerHTML = [a, b].map((f, i) => `<div class="pane"><div class="cap">${paneSel(i, f, files)}<span class="sp"></span>${keepBtn(f)}</div>${media(f)}</div>`).join('');
  } else {
    body.innerHTML = `<div class="overlay ${mode === 'diff' ? 'diffmode' : ''}">
      <img src="${thumb(a, 1600)}"><img class="top" src="${thumb(b, 1600)}">
      ${mode === 'slider' ? '<div class="handle"></div><input type="range" min="0" max="100" value="50">' : ''}</div>`;
    const r = body.querySelector('input[type=range]');
    if (r) r.oninput = () => { body.querySelector('.top').style.clipPath = `inset(0 0 0 ${r.value}%)`; body.querySelector('.handle').style.left = r.value + '%'; };
  }
  const row = (k, fa, fb) => `<tr><th>${k}</th><td class="${fa !== fb ? 'neq' : ''}">${fa}</td><td class="${fa !== fb ? 'neq' : ''}">${fb}</td></tr>`;
  $('#diffMeta').innerHTML =
    row('폴더', `[${a.root}] ${esc(a.rel)}`, `[${b.root}] ${esc(b.rel)}`) +
    row('해상도', `${a.width}×${a.height}`, `${b.width}×${b.height}`) +
    row('용량', fmtSize(a.size), fmtSize(b.size)) +
    row('수정일', fmtDate(a.mtime), fmtDate(b.mtime)) +
    row('생성일', fmtDate(a.ctime), fmtDate(b.ctime)) +
    (isVid(a) || isVid(b) ?
      row('길이', fmtDur(a.duration), fmtDur(b.duration)) +
      row('코덱', `${a.vcodec || '-'}${a.acodec ? ' / ' + a.acodec : ''}`, `${b.vcodec || '-'}${b.acodec ? ' / ' + b.acodec : ''}`) +
      row('FPS', a.fps || '-', b.fps || '-') +
      row('비트레이트', a.bitrate ? Math.round(a.bitrate / 1000) + ' kbps' : '-', b.bitrate ? Math.round(b.bitrate / 1000) + ' kbps' : '-') : '') +
    row(isVid(a) ? '스트림 내용' : '픽셀 내용', a.chash === b.chash ? '동일' : '다름', a.chash === b.chash ? '동일' : '다름');
}
$('#diffMode').onchange = renderDiff;
$('#diffBody').onchange = (e) => {
  const s = e.target.closest('select[data-which]'); if (!s) return;
  diffPair[+s.dataset.which] = data.files[+s.value]; renderDiff();
};
$('#diffBody').onclick = (e) => {
  const k = e.target.closest('[data-keep]'); if (!k) return;
  setKeep(+k.dataset.keep, !data.files[+k.dataset.keep].keep); renderDiff();
};
$('#diffClose').onclick = () => { $('#diffBody').innerHTML = ''; $('#diff').classList.add('hidden'); };

// ---------- 뷰어 ----------
let vList = [], vIdx = 0, vZoom = 1, vPan = [0, 0];
function openViewer(fid) {
  vList = visibleGroups.flatMap((g) => g.fileIds);
  vIdx = Math.max(0, vList.indexOf(fid));
  $('#viewer').classList.remove('hidden'); showV();
}
function showV() {
  const f = data.files[vList[vIdx]];
  vZoom = 1; vPan = [0, 0]; applyZ();
  const vid = isVid(f);
  $('#vImg').classList.toggle('hidden', vid); $('#vVid').classList.toggle('hidden', !vid);
  if (vid) { $('#vImg').removeAttribute('src'); $('#vVid').poster = thumb(f, 1600); $('#vVid').src = full(f); }
  else { $('#vVid').pause(); $('#vVid').removeAttribute('src'); $('#vVid').load(); $('#vImg').src = full(f); }
  $('#vInfo').innerHTML = `<b>[${f.root}]</b> ${esc(f.rel)} · ${f.width}×${f.height}${vid ? ` · ${fmtDur(f.duration)}` : ''} · ${fmtSize(f.size)} · ${fmtDate(f.mtime)} <span style="color:var(--mute)">(${vIdx + 1}/${vList.length})</span>`;
  $('#vKeep').textContent = f.keep ? '✓ 유지' : '☐ 유지';
  $('#vKeep').classList.toggle('keep-on', !!f.keep);
}
const applyZ = () => ($('#vImg').style.transform = `translate(${vPan[0]}px,${vPan[1]}px) scale(${vZoom})`);
const vIsVid = () => isVid(data.files[vList[vIdx]]); // 동영상은 확대/이동 대신 기본 재생 컨트롤 사용
const vMove = (d) => { if (!vList.length) return; vIdx = (vIdx + d + vList.length) % vList.length; showV(); };
$('#vPrev').onclick = () => vMove(-1);
$('#vNext').onclick = () => vMove(1);
$('#vClose').onclick = () => { $('#vVid').pause(); $('#viewer').classList.add('hidden'); };
$('#vKeep').onclick = () => { const id = vList[vIdx]; setKeep(id, !data.files[id].keep); showV(); };
$('#vOpen').onclick = () => api('/api/open', { path: data.files[vList[vIdx]].abs });
$('#vStage').onwheel = (e) => { if (vIsVid()) return; e.preventDefault(); vZoom = Math.min(10, Math.max(0.2, vZoom * (e.deltaY < 0 ? 1.15 : 0.87))); applyZ(); };
$('#vStage').onmousedown = (e) => {
  if (vIsVid()) return;
  const s = [e.clientX - vPan[0], e.clientY - vPan[1]];
  const mv = (m) => { vPan = [m.clientX - s[0], m.clientY - s[1]]; applyZ(); };
  window.addEventListener('mousemove', mv);
  window.addEventListener('mouseup', () => window.removeEventListener('mousemove', mv), { once: true });
};
document.addEventListener('keydown', (e) => {
  if (!$('#viewer').classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') vMove(-1);
    else if (e.key === 'ArrowRight') vMove(1);
    else if (e.key === 'Escape') $('#vClose').click();
    else if (e.key === ' ') { e.preventDefault(); $('#vKeep').click(); }
  } else if (e.key === 'Escape') { $('#diffClose').click(); $('#browser').classList.add('hidden'); }
});

// ---------- 동기화 ----------
const syncModeUI = () => {
  const mv = document.querySelector('input[name=mode]:checked').value === 'move';
  $('#unchecked').disabled = mv;
  $('#uncheckedHint').classList.toggle('hidden', !mv);
};
$('#mode').onchange = syncModeUI;
$('#btnSync').onclick = async () => {
  const target = $('#dirC').value.trim();
  if (!target) return toast('동기화 대상 폴더 C를 지정하세요');
  const mode = document.querySelector('input[name=mode]:checked').value;
  const unchecked = $('#unchecked').value;
  const keep = data.files.filter((f) => f.keep).length;
  const msg = `${keep}개 파일을 C로 ${mode === 'move' ? '이동' : '복사'}합니다.` +
    (mode === 'move' ? `\n중복/체크 안 된 ${data.files.length - keep}개는 C/삭제예정 으로 이동하고,\n같은 내용이 여러 개면 1개만 남기고 삭제합니다.` :
    (unchecked === 'trash' ? `\n체크 안 된 ${data.files.length - keep}개는 C/_휴지통으로 이동합니다.` : '') +
    (unchecked === 'delete' ? `\n⚠ 체크 안 된 ${data.files.length - keep}개는 영구 삭제됩니다!` : '')) + '\n계속할까요?';
  if (!confirm(msg)) return;
  const keepMap = Object.fromEntries(data.files.map((f) => [f.id, !!f.keep]));
  try {
    await api('/api/sync', { target, mode, unchecked, keepMap });
    poll((s) => {
      if (s.phase === 'error') return toast('⚠ ' + s.message);
      const l = JSON.parse(s.message);
      toast(`✅ 동기화 완료 — 복사 ${l.copied} · 이동 ${l.moved} · 중복건너뜀 ${l.skipped} · 이름변경 ${l.renamed}` +
        (mode === 'move' ? ` · 삭제예정 ${l.pending} · 중복삭제 ${l.dupDeleted}` : ` · 휴지통 ${l.trashed} · 삭제 ${l.deleted}`) +
        (l.errors.length ? `<br>⚠ 오류 ${l.errors.length}건` : ''), 8000);
      if (mode === 'move' || unchecked !== 'leave') setTimeout(() => { toast('원본이 변경되어 다시 스캔합니다…'); $('#btnScan').click(); }, 1500);
    }, mode === 'move' ? '🚚 C로 이동 중…' : '📋 C로 복사 중…');
  } catch (e) { toast('⚠ ' + e.message); }
};
