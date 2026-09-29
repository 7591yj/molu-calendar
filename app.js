import {
  TIME_ZONE, CATEGORIES, STATUSES, MAX_BYTES, dateKey, addDays, shiftMonth, monthDays, displayDays,
  span, overlaps, clockLabel, timeLabel, rangeLabel, parseBundle, mergeEvents, compareEvents, featuredEvents, bannerEvents, bannerIndex, remainingLabel, demoBundle,
} from './calendar.js';
import { momoTopicsFor, momoReply } from './momotalk.js';

const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'molu.calendar.v1';
const BOOKMARK_KEY = 'molu.bookmarks.v1';
const loadIds = key => { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); } };
const today = () => dateKey();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const BANNERS = ['images.jpg', 'i1mages.jpg', '1231123.jpg'].map(name => `./resource/event_banner_img/${name}`);
const bannerFor = event => BANNERS[bannerIndex(event.id, BANNERS.length)];
const PREFS_KEY = 'molu.prefs.v1';
let prefs = { view: 'month', filter: 'all', bannerAuto: true, momoSound: true };
try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }; } catch { /* 저장 실패해도 기본값 유지 */ }
if (prefs.view !== 'month' && prefs.view !== 'list') prefs.view = 'month';
if (!['all', 'bookmarks', ...Object.keys(CATEGORIES)].includes(prefs.filter)) prefs.filter = 'all';
prefs.bannerAuto = prefs.bannerAuto !== false;
prefs.momoSound = prefs.momoSound !== false;
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } };
const SCREEN_KEY = 'molu.screen.v1';
const saveScreen = () => { try { localStorage.setItem(SCREEN_KEY, JSON.stringify({ screen: activeScreen, room: activeRoom, tab: setTab })); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } };
const state = { events: demoBundle().events, demo: true, month: today().slice(0, 7), selected: today(), filter: prefs.filter, view: prefs.view, featureId: null, featurePaused: reducedMotion.matches, bookmarks: loadIds(BOOKMARK_KEY), detailId: null, featureRot: 0 };
let startupMessage = '';
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) {
    state.events = parseBundle(saved).events;
    state.demo = false;
  }
} catch {
  startupMessage = '저장 데이터를 읽을 수 없어 샘플을 표시합니다. 기존 저장 데이터는 변경하지 않았습니다.';
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function eventColor(element, event) {
  element.style.setProperty('--event-color', CATEGORIES[event.category].color);
  return element;
}
function filteredEvents() {
  return state.events.filter(event => state.filter === 'all' || (state.filter === 'bookmarks' ? state.bookmarks.has(event.id) : event.category === state.filter));
}
function sorted(events) {
  return [...events].sort(compareEvents);
}
function selectDay(day) {
  state.selected = day;
  renderCalendar();
  renderBriefing();
}
function onEventClick(event) {
  $('#event-title').textContent = event.title;
  $('#event-banner').src = bannerFor(event);
  $('#event-range').textContent = rangeLabel(event);
  $('#event-start-clock').textContent = event.all_day ? '종일' : clockLabel(event.start);
  $('#event-start-date').textContent = span(event).first;
  $('#event-end-clock').textContent = event.all_day ? '종일' : event.end ? clockLabel(event.end) : '미정';
  $('#event-end-date').textContent = event.all_day ? span(event).last : event.end ? dateKey(event.end) : '종료 시각 미등록';
  $('#event-description').textContent = event.description || '등록된 설명이 없습니다.';
  $('#event-id').textContent = event.id;
  state.detailId = event.id;
  $('#bookmark-button').setAttribute('aria-pressed', String(state.bookmarks.has(event.id)));
  const category = eventColor(node('span', 'tag category', CATEGORIES[event.category].label), event);
  const chips = [category, node('span', 'tag', STATUSES[event.status])];
  const chip = countdownChip(event);
  if (chip) chips.push(chip);
  $('#event-tags').replaceChildren(...chips);
  const link = $('#event-source');
  link.hidden = !event.source_url;
  if (event.source_url) {
    link.href = event.source_url;
    link.textContent = '원문 보기 ↗';
  } else link.removeAttribute('href');
  $('#event-dialog').showModal();
}
// 카운트다운 칩: 모든 일정 표시 지점(다이얼로그·브리핑·목록)에서 공유. '종료'는 칩 대신 시간 그리드가 말한다.
function countdownChip(event) {
  const remaining = remainingLabel(event);
  if (!remaining || remaining === '종료') return null;
  const chip = node('span', 'tag countdown', remaining);
  chip.dataset.countdownFor = event.id;
  return chip;
}
function refreshCountdowns() {
  document.querySelectorAll('[data-countdown-for]').forEach(chip => {
    const event = state.events.find(candidate => candidate.id === chip.dataset.countdownFor);
    const remaining = event ? remainingLabel(event) : null;
    if (!remaining || remaining === '종료') chip.remove();
    else chip.textContent = remaining;
  });
}
function toggleSaved(set, key) {
  const id = state.detailId;
  if (!id) return;
  set.has(id) ? set.delete(id) : set.add(id);
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* 저장 실패해도 세션 내 동작 유지 */ }
  renderFilters();
  renderCalendar();
  renderBriefing();
}
$('#bookmark-button').addEventListener('click', () => {
  toggleSaved(state.bookmarks, BOOKMARK_KEY);
  $('#bookmark-button').setAttribute('aria-pressed', String(state.bookmarks.has(state.detailId)));
});
$('#banner-next').addEventListener('click', () => {
  state.featureRot += 1;
  renderFeatured();
});
let activeScreen = 'calendar';
function showScreen(name) {
  activeScreen = name;
  $('#home-screen').hidden = name !== 'home';
  $('#app-settings').hidden = name !== 'settings';
  $('#app-momo-list').hidden = name !== 'momo-list';
  $('#app-momotalk').hidden = name !== 'momotalk';
  $('#dock').hidden = name !== 'home';
  $('#home-indicator').hidden = name === 'home';
  document.querySelector('.workspace').inert = name !== 'calendar';
  $('#home-screen').inert = name !== 'home';
  const targets = { home: '#home-title', calendar: '#month-heading', settings: '#app-settings-title', momotalk: '#momo-profile-open', 'momo-list': '#momo-list-title' };
  $(targets[name])?.focus({ preventScroll: true });
  if (name === 'settings') { $('#app-settings').dataset.pane = 'side'; renderSetDetail(); }
  saveScreen();
}
function goHome() {
  state.filter = 'all';
  state.view = 'month';
  state.month = today().slice(0, 7);
  state.selected = today();
  render();
  showScreen('home');
}
$('#home-indicator').addEventListener('click', goHome);
$('#dock').addEventListener('click', event => {
  const button = event.target.closest('[data-app]');
  if (!button) return;
  // ponytail: 앱 추가는 dock에 버튼 1개 + app-screen 섹션 1개 + targets 1줄이면 끝.
  if (button.dataset.app === 'calendar') render();
  showScreen(button.dataset.app);
});
document.querySelectorAll('[data-go-home]').forEach(button => button.addEventListener('click', goHome));
let setTab = 'general';
const SET_TITLES = { general: '일반', character: '캐릭터', data: '데이터', about: '정보' };
function setRow(label, sub) {
  const row = node('div', 'set-row');
  const grow = node('span', 'grow', label);
  if (sub) grow.append(node('span', 'set-sub', sub));
  row.append(grow);
  return row;
}
function setToggle(label, sub, on, onFlip) {
  const row = setRow(label, sub);
  const sw = node('button', 'set-switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-checked', String(on));
  sw.setAttribute('aria-label', label);
  sw.addEventListener('click', () => { on = !on; sw.setAttribute('aria-checked', String(on)); onFlip(on); });
  row.append(sw);
  return row;
}
function setCheck(label, active, onPick) {
  const row = node('button', 'set-row');
  row.type = 'button';
  row.append(node('span', 'grow', label));
  if (active) row.append(node('span', 'set-check', '✓'));
  row.addEventListener('click', onPick);
  return row;
}
function setAction(label, danger, onGo) {
  const row = node('button', `set-row${danger ? ' set-danger' : ''}`, label);
  row.type = 'button';
  row.addEventListener('click', onGo);
  return row;
}
function setInfo(label, value) {
  const row = setRow(label);
  row.append(node('span', 'set-value', value));
  return row;
}
function setView(view) { state.view = view; prefs.view = view; savePrefs(); render(); renderSetDetail(); }
function setFilter(filter) { state.filter = filter; prefs.filter = filter; savePrefs(); render(); renderSetDetail(); }
function renderSetDetail() {
  $('#set-detail-title').textContent = SET_TITLES[setTab];
  const body = $('#set-body');
  if (setTab === 'general') {
    const viewGroup = node('div', 'set-group');
    const viewRow = setRow('보기 방식');
    const seg = node('div', 'set-seg');
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', '보기 방식');
    [['month', '월간'], ['list', '목록']].forEach(([value, label]) => {
      const button = node('button', '', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.view === value));
      button.addEventListener('click', () => setView(value));
      seg.append(button);
    });
    viewRow.append(seg);
    viewGroup.append(viewRow);
    const filterGroup = node('div', 'set-group');
    [['all', '전체'], ...Object.entries(CATEGORIES).map(([key, category]) => [key, category.label]), ['bookmarks', '북마크']].forEach(([value, label]) => filterGroup.append(setCheck(label, state.filter === value, () => setFilter(value))));
    const bannerGroup = node('div', 'set-group');
    bannerGroup.append(setToggle('배너 자동 넘김', '6초마다 추천 일정을 넘깁니다', prefs.bannerAuto, on => { prefs.bannerAuto = on; savePrefs(); }));
    const momoGroup = node('div', 'set-group');
    momoGroup.append(setToggle('모모톡 알림음', '학생의 메시지가 도착하면 알림음을 재생합니다', prefs.momoSound, on => { prefs.momoSound = on; savePrefs(); }));
    body.replaceChildren(viewGroup, filterGroup, bannerGroup, momoGroup, node('p', 'set-note', '분류와 보기 방식은 캘린더 상단에서도 바꿀 수 있습니다.'));
  } else if (setTab === 'character') {
    const group = node('div', 'set-group');
    group.append(setInfo('3D 캐릭터', '모델 파일 없음'));
    body.replaceChildren(group, node('p', 'set-note', 'GawrGura 모델 파일을 준비하면 샬레에 캐릭터가 등장합니다.'));
  } else if (setTab === 'data') {
    const importGroup = node('div', 'set-group');
    importGroup.append(setAction('JSON 가져오기…', false, () => openImport()));
    const bytes = new TextEncoder().encode(JSON.stringify({ schema_version: 1, events: state.events })).length;
    const storageGroup = node('div', 'set-group');
    storageGroup.append(setInfo('저장된 일정', `${state.events.length}건`), setInfo('저장 크기', `${(bytes / 1024).toFixed(1)} KB / 1 MB`));
    const dangerGroup = node('div', 'set-group');
    dangerGroup.append(setAction('저장 데이터 초기화', true, () => {
      if (!confirm('브라우저에 저장된 일정·북마크·대화를 모두 지울까요?')) return;
      Object.keys(localStorage).filter(key => key.startsWith('molu.')).forEach(key => localStorage.removeItem(key));
      location.reload();
    }));
    body.replaceChildren(importGroup, storageGroup, dangerGroup);
  } else {
    const group = node('div', 'set-group');
    group.append(setInfo('버전', 'MOLU 0.1.0'), setInfo('데이터 형식', 'schema v1'));
    body.replaceChildren(group, node('p', 'set-note', '블루 아카이브 비공식 팬메이드 캘린더입니다. NEXON / NEXON Games와 무관합니다.'));
  }
}
document.querySelectorAll('.set-nav').forEach(button => button.addEventListener('click', () => {
  setTab = button.dataset.set;
  document.querySelectorAll('.set-nav').forEach(other => other.setAttribute('aria-current', String(other === button)));
  $('#app-settings').dataset.pane = 'detail';
  renderSetDetail();
  saveScreen();
}));
document.querySelector('[data-set-back]').addEventListener('click', () => { $('#app-settings').dataset.pane = 'side'; });
function updateDockDate() {
  const now = new Date();
  $('#dock-weekday').textContent = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()];
  $('#dock-day').textContent = String(now.getDate());
}
const MOMO_KEY = 'molu.momotalk.v1';
const MOMO_UNREAD_KEY = 'molu.momotalk.unread.v1';
const momoTime = () => { const now = new Date(); return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; };
// Arona is the Schale OS, not an enrolled student, so she is the one built-in contact.
const CONTACTS = {
  Arona: { id: 'Arona', img: 'Arona.webp', name: '아로나', short: '아로나', school: '샬레', year: '', club: '', status: '선생님을 기다리고 있어요!' },
};
const ARONA_GREETING = '선생님! 샬레 관제탑의 아로나예요. 일정이 궁금하면 "오늘 일정 알려줘"라고 말해보세요!';
let STUDENT_LIST = [];
let studentQuery = '';
let momoTab = 'all';
let momoPane = 'friends';
let momoFriendId = 'Arona';
const FAV_KEY = 'molu.momo.fav.v1';
const momoFav = loadIds(FAV_KEY);
const saveFav = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...momoFav])); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } };
const normalize = value => value.toLowerCase().replaceAll(' ', '');
const studentSearch = student => normalize([student.name, student.short, student.school, student.club, student.status].filter(Boolean).join(' '));
const momoClean = list => list.filter(message => message && typeof message.text === 'string').slice(-60);
let momoRooms;
try {
  const stored = JSON.parse(localStorage.getItem(MOMO_KEY) ?? 'null');
  if (Array.isArray(stored)) momoRooms = { Arona: momoClean(stored) };
  else if (stored && typeof stored === 'object') momoRooms = Object.fromEntries(Object.entries(stored).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, momoClean(value)]));
  else momoRooms = null;
} catch { momoRooms = null; }
momoRooms ??= {};
momoRooms.Arona ??= [{ me: false, text: ARONA_GREETING, time: momoTime() }];
let momoUnread = {};
try {
  const storedUnread = JSON.parse(localStorage.getItem(MOMO_UNREAD_KEY) ?? '{}');
  if (storedUnread && typeof storedUnread === 'object') momoUnread = storedUnread;
} catch { momoUnread = {}; }
let activeRoom = 'Arona';
// MomoTalk 알림음 (bluearchive.wiki SE, tools/vendor_momotalk.py)
const momoAudio = new Audio('./resource/momotalk/ui/SE_MomoTalk_01.wav');
momoAudio.volume = .5;
function momoChime() {
  if (!prefs.momoSound) return;
  momoAudio.currentTime = 0;
  momoAudio.play().catch(() => { /* 재생이 막혀도 대화는 계속된다 */ });
}
function persistMomo() { try { localStorage.setItem(MOMO_KEY, JSON.stringify(Object.fromEntries(Object.entries(momoRooms).map(([key, value]) => [key, value.slice(-60)])))); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } }
function persistUnread() { try { localStorage.setItem(MOMO_UNREAD_KEY, JSON.stringify(momoUnread)); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } }
function momoStudent(id) { return CONTACTS[id] ?? CONTACTS.Arona; }
function fillAvatar(container, student) {
  if (student.img) {
    const img = node('img');
    img.src = `./resource/momotalk/${student.img}`;
    img.alt = '';
    container.replaceChildren(img);
  } else container.replaceChildren(document.createTextNode(student.short.slice(0, 1)));
}
function momoAvatar(student) {
  const avatar = node('span', 'momo-avatar');
  fillAvatar(avatar, student);
  return avatar;
}
fetch('./resource/momotalk/students.json').then(response => response.json()).then(list => {
  STUDENT_LIST = list;
  for (const student of list) CONTACTS[student.id] = student;
  renderStudentList();
  renderMomoList();
  if (activeScreen === 'momotalk') renderMomo();
}).catch(() => { /* 로컬 DB 없으면 아로나만 남는다 */ });
function momoRow(me, text, time, student, typing = false, compact = false) {
  const row = node('div', `momo-row${me ? ' me' : ''}${compact ? ' compact' : ''}`);
  const bubble = typing ? node('div', 'momo-bubble momo-typing') : node('div', 'momo-bubble', text);
  if (typing) bubble.append(node('i'), node('i'), node('i'));
  const timeEl = node('span', 'momo-time', time);
  if (me) row.append(bubble, timeEl);
  else {
    const line = node('div', 'momo-line');
    line.append(bubble, timeEl);
    const body = node('div', 'momo-body');
    body.append(node('div', 'momo-name', student.short), line);
    row.append(momoAvatar(student), body);
  }
  return row;
}
function renderMomo() {
  const student = momoStudent(activeRoom);
  fillAvatar($('#momo-peer-avatar'), student);
  $('#app-momotalk-title').textContent = student.short;
  $('#momo-peer-sub').textContent = student.status || '온라인';
  $('#momo-peer-org').textContent = [student.school, student.club].filter(Boolean).join(' · ');
  const box = $('#momo-messages');
  const messages = momoRooms[activeRoom] ?? [];
  box.replaceChildren(...messages.map((message, i) => {
    const prev = messages[i - 1];
    return momoRow(message.me, message.text, message.time, student, false, !message.me && !!prev && !prev.me);
  }));
  box.scrollTop = box.scrollHeight;
  box.setAttribute('aria-label', `${student.short}와의 대화`);
  $('#momo-profile').hidden = true;
  renderMomoReplies();
}
function momoEvents(day, label) {
  const hits = sorted(state.events).filter(event => overlaps(event, day, addDays(day, 1)));
  if (!hits.length) return `${label} 일정은 비어 있어요. 푹 쉬어도 되는 날이네요!`;
  const lines = hits.slice(0, 4).map(event => `· ${event.title} (${timeLabel(event, day)})`);
  return `${label} 일정은 ${hits.length}건이에요!\n${lines.join('\n')}${hits.length > 4 ? `\n외 ${hits.length - 4}건` : ''}`;
}
function renderMomoList() {
  const box = $('#momo-chats');
  const ids = Object.keys(momoRooms).filter(id => (momoRooms[id] ?? []).length && (momoTab === 'all' || momoUnread[id]));
  if (!ids.length) {
    box.replaceChildren(node('p', 'chat-empty', momoTab === 'unread' ? '읽지 않은 대화가 없어요.' : '아직 대화가 없어요.\n왼쪽 친구 탭에서 학생을 골라 대화를 시작해 보세요.'));
    syncMomoTabs();
    syncMomoPane();
    return;
  }
  box.replaceChildren(...ids.map(id => {
    const student = momoStudent(id);
    const messages = momoRooms[id];
    const last = messages[messages.length - 1];
    const row = node('button', 'chat-row');
    row.type = 'button';
    // 인게임처럼 NEW 표시는 아바타 좌상단 뱃지, 행 오른쪽은 학교 칩 (시각 없음).
    const avatar = momoAvatar(student);
    if (momoUnread[id]) avatar.append(node('span', 'chat-unread', momoUnread[id] > 99 ? '99+' : String(momoUnread[id])));
    const meta = node('span', 'chat-meta');
    meta.append(node('span', 'chat-name', student.short), node('span', 'chat-preview', last.text));
    row.append(avatar, meta);
    row.setAttribute('aria-label', `${student.short}와의 대화${momoUnread[id] ? `, 읽지 않은 메시지 ${momoUnread[id]}건` : ''}`);
    row.addEventListener('click', () => openRoom(id));
    return row;
  }));
  syncMomoTabs();
  syncMomoPane();
}
function syncMomoTabs() {
  const all = $('#momo-tab-all'), unread = $('#momo-tab-unread');
  if (!all || !unread) return;
  all.onclick = () => setMomoTab('all');
  unread.onclick = () => setMomoTab('unread');
  all.setAttribute('aria-selected', String(momoTab === 'all'));
  unread.setAttribute('aria-selected', String(momoTab === 'unread'));
  const total = Object.values(momoUnread).reduce((sum, n) => sum + (n || 0), 0);
  const badge = $('#momo-tab-unread-count');
  badge.hidden = !total;
  badge.textContent = total > 99 ? '99+' : String(total);
}
function setMomoTab(tab) {
  momoTab = tab;
  renderMomoList();
  $(tab === 'all' ? '#momo-tab-all' : '#momo-tab-unread')?.focus({ preventScroll: true });
}
function renderStudentList() {
  const box = $('#momo-students');
  const query = studentQuery;
  const hits = query ? STUDENT_LIST.filter(student => studentSearch(student).includes(query)) : STUDENT_LIST;
  const rows = [];
  const rowFor = student => {
    const row = node('div', `chat-row${student.id === momoFriendId ? ' selected' : ''}`);
    const main = node('button', 'chat-row-main');
    main.type = 'button';
    const meta = node('span', 'chat-meta');
    meta.append(node('span', 'chat-name', student.short));
    meta.append(node('span', 'chat-status', student.status || [student.year, student.club].filter(Boolean).join(' · ')));
    main.append(momoAvatar(student), meta);
    main.setAttribute('aria-label', `${student.name} · ${student.school || '기타'}`);
    main.addEventListener('click', () => {
      // 좁은 화면에선 탭 즉시 대화, 넓은 화면에선 우측 미리보기 선택 (인게임 동작).
      if (matchMedia('(max-width:960px)').matches) { openRoom(student.id); return; }
      momoFriendId = student.id;
      renderStudentList();
    });
    const starred = momoFav.has(student.id);
    const fav = node('button', 'chat-fav', '★');
    fav.type = 'button';
    fav.setAttribute('aria-pressed', String(starred));
    fav.setAttribute('aria-label', `${student.short} 즐겨찾기 ${starred ? '해제' : '추가'}`);
    fav.addEventListener('click', () => {
      if (momoFav.has(student.id)) momoFav.delete(student.id); else momoFav.add(student.id);
      saveFav();
      renderStudentList();
    });
    row.append(main, fav);
    return row;
  };
  if (!query) {
    const favs = hits.filter(student => momoFav.has(student.id));
    if (favs.length) {
      rows.push(node('p', 'chat-group', '즐겨찾기'));
      for (const student of favs) rows.push(rowFor(student));
    }
  }
  let school = null;
  for (const student of hits) {
    if (!query && (student.school || '기타') !== school) {
      school = student.school || '기타';
      rows.push(node('p', 'chat-group', school));
    }
    rows.push(rowFor(student));
  }
  if (query && !hits.length) rows.push(node('p', 'chat-empty', `"${query}"와 맞는 학생이 없어요.`));
  box.replaceChildren(...rows);
  renderFriendPreview();
}
function renderFriendPreview() {
  const pane = $('#momo-friend-preview');
  if (!pane) return;
  const student = CONTACTS[momoFriendId] ?? CONTACTS.Arona;
  const avatar = momoAvatar(student);
  avatar.classList.add('big');
  const chat = node('button', 'momo-friend-chat', '대화 시작');
  chat.type = 'button';
  chat.addEventListener('click', () => openRoom(student.id));
  pane.replaceChildren(
    avatar,
    node('h3', '', student.name),
    node('p', 'momo-profile-status', student.status ?? ''),
    node('span', 'momo-birthday-pill', student.birthday ? `🎂 ${student.birthday}` : '생일 비공개'),
    chat,
  );
}
function momoFactRows(student) {
  const facts = [
    ['소속', [student.school, student.year, student.club].filter(Boolean).join(' ')],
    ['생일', student.birthday], ['나이', student.age], ['키', student.height], ['취미', student.hobby],
    ['성우', student.voice], ['일러스트', student.illust],
  ].filter(([, value]) => value);
  return facts.flatMap(([label, value]) => [node('dt', '', label), node('dd', '', value)]);
}
function setMomoPane(pane) {
  momoPane = pane;
  syncMomoPane();
}
function syncMomoPane() {
  const chat = $('#momo-pane-chat'), friends = $('#momo-pane-friends');
  if (!chat || !friends) return;
  document.querySelectorAll('[data-mpane]').forEach(button => {
    button.onclick = () => setMomoPane(button.dataset.mpane);
    button.setAttribute('aria-pressed', String(button.dataset.mpane === momoPane));
  });
  chat.hidden = momoPane !== 'chat';
  friends.hidden = momoPane !== 'friends';
  const total = Object.values(momoUnread).reduce((sum, n) => sum + (n || 0), 0);
  const badge = $('#momo-side-unread');
  if (badge) {
    badge.hidden = !total;
    badge.textContent = total > 99 ? '99+' : String(total);
  }
  if (momoPane === 'friends') renderStudentList();
}
function openProfile() {
  const student = momoStudent(activeRoom);
  fillAvatar($('#momo-profile-avatar'), student);
  $('#momo-profile-name').textContent = student.name;
  $('#momo-profile-status').textContent = student.status;
  $('#momo-profile-facts').replaceChildren(...momoFactRows(student));
  const intro = $('#momo-profile-intro');
  intro.textContent = student.intro ?? '';
  intro.hidden = !student.intro;
  $('#momo-profile').hidden = false;
  $('#momo-profile-close').focus();
}
$('#momo-profile-open').addEventListener('click', openProfile);
$('#momo-profile-close').addEventListener('click', () => { $('#momo-profile').hidden = true; $('#momo-profile-open').focus(); });
function openRoom(id) {
  activeRoom = id;
  momoFriendId = id;
  momoRooms[id] ??= [];
  momoUnread[id] = 0;
  persistUnread();
  syncTopic(id);
  renderMomo();
  renderMomoList();
  showScreen('momotalk');
}
function postMomo(roomId, me, text) {
  momoRooms[roomId].push({ me, text, time: momoTime() });
  persistMomo();
}
// 선생님 메시지 수가 곧 대화 진행도다. 별도 상태 없이 새로고침을 견딘다.
function pendingTopic(roomId) {
  const topics = momoTopicsFor(roomId);
  return topics[(momoRooms[roomId] ?? []).filter(message => message.me).length % topics.length];
}
function askTopic(roomId) {
  const topic = pendingTopic(roomId);
  if (topic) postMomo(roomId, false, topic.ask);
}
function syncTopic(roomId) {
  const messages = momoRooms[roomId];
  const last = messages[messages.length - 1];
  if (!last || last.me || last.text !== pendingTopic(roomId)?.ask) askTopic(roomId);
}
function resolveReply(reply) {
  if (reply === '@today') return momoEvents(today(), '오늘');
  if (reply === '@tomorrow') return momoEvents(addDays(today(), 1), '내일');
  return reply;
}
function renderMomoReplies() {
  const box = $('#momo-replies');
  const messages = momoRooms[activeRoom] ?? [];
  const topic = pendingTopic(activeRoom);
  // 선택지는 학생이 말을 마친 뒤에만 노출한다 (선생님 답변 직후에는 숨김).
  const last = messages[messages.length - 1];
  if (!topic || !last || last.me || last.text !== topic.ask) { box.hidden = true; return; }
  const options = topic.options.map(option => {
    const button = node('button', 'momo-reply-option', option.text);
    button.type = 'button';
    button.addEventListener('click', () => answerTopic(option));
    return button;
  });
  box.replaceChildren(...options);
  box.hidden = false;
  box.scrollIntoView({ block: 'nearest' });
}
// 인게임처럼 학생 메시지는 타이핑 표시 뒤에 한 개씩 도착한다.
function momoSay(roomId, student, text, done) {
  if (!text) { done?.(); return; }
  const messages = momoRooms[roomId] ?? [];
  const last = messages[messages.length - 1];
  const typing = momoRow(false, '', momoTime(), student, true, !!last && !last.me);
  const box = $('#momo-messages');
  box.append(typing);
  box.scrollTop = box.scrollHeight;
  setTimeout(() => {
    typing.remove();
    postMomo(roomId, false, text);
    momoChime();
    if (activeScreen === 'momotalk' && activeRoom === roomId) renderMomo();
    else { momoUnread[roomId] = (momoUnread[roomId] ?? 0) + 1; persistUnread(); }
    renderMomoList();
    done?.();
  }, 900);
}
function answerTopic(option) {
  const roomId = activeRoom;
  const student = momoStudent(roomId);
  postMomo(roomId, true, option.text);
  renderMomo();
  renderMomoList();
  momoSay(roomId, student, resolveReply(option.reply), () => momoSay(roomId, student, pendingTopic(roomId)?.ask));
}
// 자유 입력: 검색 뇌(momotalk.js)가 가장 비슷한 사전 응답을 찾고, 학생 답변 뒤 다음 질문을 투척한다.
$('#momo-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#momo-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const roomId = activeRoom;
  const student = momoStudent(roomId);
  postMomo(roomId, true, text);
  renderMomo();
  renderMomoList();
  momoSay(roomId, student, resolveReply(momoReply(text, student)), () => momoSay(roomId, student, pendingTopic(roomId)?.ask));
});
document.querySelector('[data-momo-back]').addEventListener('click', () => showScreen('momo-list'));
$('#momo-search').addEventListener('input', event => {
  studentQuery = normalize(event.target.value.trim());
  renderStudentList();
});
renderMomo();
renderMomoList();

function makeEventCard(event) {
  const button = eventColor(node('button', 'day-event-card'), event);
  button.type = 'button';
  const body = node('span', 'event-card-body');
  const meta = node('span', 'event-card-meta', CATEGORIES[event.category].label);
  meta.append(node('span', 'event-card-status', STATUSES[event.status]));
  const chip = countdownChip(event);
  if (chip) meta.append(chip);
  const time = node('span', 'briefing-time');
  time.append(node('span', 'time-cross', '+'), node('span', '', timeLabel(event, state.selected)));
  body.append(meta, node('span', 'event-card-title', event.title), time);
  body.append(node('span', 'event-card-subtitle', rangeLabel(event)));
  button.append(node('span', 'event-line'), body);
  button.addEventListener('click', () => onEventClick(event));
  return button;
}
function renderFilters() {
  const buttons = [['all', { label: '전체' }], ...Object.entries(CATEGORIES), ['bookmarks', { label: '북마크', color: '#c5a35d' }]].map(([key, category]) => {
    const button = node('button', 'filter-chip');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.filter === key));
    if (category.color) button.style.setProperty('--event-color', category.color);
    button.append(node('span', 'dot'), document.createTextNode(category.label));
    button.addEventListener('click', () => {
      state.filter = key;
      render();
      [...$('#filters').children].find(element => element.textContent === category.label)?.focus();
    });
    return button;
  });
  $('#filters').replaceChildren(...buttons);
}
function renderCalendar() {
  const [year, month] = state.month.split('-');
  $('#month-heading').replaceChildren(document.createTextNode(`${year}. `), node('span', '', month));
  $('#prev-month').disabled = state.month <= '1900-01';
  $('#next-month').disabled = state.month >= '2199-12';
  const events = sorted(filteredEvents());
  // ponytail: scan at most 1,000 events across 42 cells; add a date index only if this cap grows.
  const entries = events.map(event => ({ event, ...span(event) }));
  const fragment = document.createDocumentFragment();
  for (const day of displayDays(state.month)) {
    const isOutside = !day.startsWith(state.month);
    const cell = node('div', `day${isOutside ? ' outside' : ''}${day === state.selected ? ' selected' : ''}${day === today() ? ' today' : ''}`);
    const dayButton = node('button', 'day-number', String(Number(day.slice(8))));
    dayButton.type = 'button';
    dayButton.dataset.date = day;
    dayButton.setAttribute('aria-label', `${day} 일정 보기`);
    dayButton.setAttribute('aria-pressed', String(day === state.selected));
    if (day === today()) dayButton.setAttribute('aria-current', 'date');
    dayButton.addEventListener('click', () => {
      selectDay(day);
      $(`[data-date="${day}"]`)?.focus();
    });
    cell.append(dayButton);
    if (day === today()) cell.append(node('span', 'today-label', 'TODAY'));
    const matches = entries.filter(entry => entry.first <= day && entry.last >= day);
    matches.slice(0, 3).forEach(({ event }) => {
      const label = event.status === 'cancelled' ? `[취소] ${event.title}` : event.status === 'postponed' ? `[연기] ${event.title}` : event.title;
      const button = eventColor(node('button', `day-event ${event.status}`), event);
      const clock = node('span', 'event-clock');
      const [from, to] = timeLabel(event, day).split('–');
      clock.append(node('span', '', from));
      if (to) clock.append(node('span', 'time-end', `–${to}`));
      button.append(clock, node('span', 'event-name', label));
      button.type = 'button';
      button.title = `${event.title} · ${rangeLabel(event)} · ${STATUSES[event.status]}`;
      button.setAttribute('aria-label', `${day} ${button.title}`);
      button.addEventListener('click', () => onEventClick(event));
      cell.append(button);
    });
    if (matches.length > 3) {
      const more = node('button', 'more-events', `+${matches.length - 3}개 더 보기`);
      more.addEventListener('click', () => {
        selectDay(day);
        $('.briefing').scrollIntoView({ block: 'nearest', behavior: 'auto' });
        $('#day-events button')?.focus();
      });
      cell.append(more);
    }
    fragment.append(cell);
  }
  $('#calendar-grid').replaceChildren(fragment);
  const monthEvents = events.filter(event => overlaps(event, `${state.month}-01`, `${shiftMonth(state.month, 1)}-01`));
  renderAgenda(monthEvents);
}
function renderAgenda(events) {
  const list = $('#agenda');
  list.replaceChildren();
  if (!events.length) {
    list.append(node('p', 'empty-list', '이 달에는 표시할 일정이 없어요.\n다른 분류를 선택하거나 JSON을 가져와 주세요.'));
    return;
  }
  events.forEach(event => {
    const row = eventColor(node('button', 'agenda-row'), event);
    const body = node('span', 'event-card-body');
    const meta = node('span', 'event-card-meta', `${CATEGORIES[event.category].label} · ${STATUSES[event.status]}`);
    const chip = countdownChip(event);
    if (chip) meta.append(chip);
    body.append(meta, node('span', 'event-card-title', event.title), node('span', 'range', rangeLabel(event)));
    row.append(node('span', 'agenda-date', span(event).first.slice(5).replace('-', '.')), node('span', 'event-line'), body, node('span', '', '↗'));
    row.addEventListener('click', () => onEventClick(event));
    list.append(row);
  });
}
function renderBriefing() {
  const day = state.selected;
  $('#selected-date').textContent = day.slice(5).replace('-', '.');
  $('#selected-weekday').textContent = new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`)).toUpperCase();
  const events = sorted(filteredEvents()).filter(event => overlaps(event, day, addDays(day, 1)));
  const container = $('#day-events');
  container.replaceChildren();
  if (events.length) container.append(...events.map(makeEventCard));
  else {
    const empty = node('div', 'empty-day');
    empty.append(node('span', 'empty-orbit'), node('strong', '', '잠깐, 쉬어 가도 괜찮아요.'), node('p', '', state.filter === 'all' ? '이 날짜에는 등록된 일정이 없어요.' : '선택한 분류의 일정이 없어요.'));
    container.append(empty);
  }
}
function renderFeatured(events = bannerEvents(state.events)) {
  const index = events.length ? state.featureRot % events.length : 0;
  const event = events[index];
  const image = $('#memo-banner');
  image.hidden = !event;
  $('#banner-next').hidden = !event;
  if (event) {
    const rotated = state.featureShown && state.featureShown !== event.id;
    image.src = bannerFor(event);
    image.alt = event.title;
    state.featureShown = event.id;
    if (rotated && !reducedMotion.matches) {
      image.getAnimations().forEach(animation => animation.cancel());
      image.animate([
        { opacity: 0, transform: 'translateX(18px) scale(.985)' },
        { opacity: 1, transform: 'none' },
      ], { duration: 340, easing: 'cubic-bezier(.22,1,.36,1)' });
    }
  }
}
function renderMetrics() {
  renderFeatured();
}
setInterval(() => {
  if (!prefs.bannerAuto || document.hidden || document.querySelector('dialog[open]') || $('#memo-banner').matches(':hover')) return;
  state.featureRot += 1;
  renderFeatured();
}, 6000);
function render() {
  renderFilters();
  renderCalendar();
  renderBriefing();
  renderMetrics();
  updateDockDate();
  $('#calendar-view').hidden = state.view !== 'month';
  $('#agenda').hidden = state.view !== 'list';
  $('#month-view').setAttribute('aria-pressed', String(state.view === 'month'));
  $('#list-view').setAttribute('aria-pressed', String(state.view === 'list'));
}
function changeMonth(step) {
  const next = shiftMonth(state.month, step);
  if (next < '1900-01' || next > '2199-12') return;
  state.month = next;
  state.selected = state.month === today().slice(0, 7) ? today() : `${state.month}-01`;
  render();
}
$('#prev-month').addEventListener('click', () => changeMonth(-1));
$('#next-month').addEventListener('click', () => changeMonth(1));
$('#today-button').addEventListener('click', () => {
  state.month = today().slice(0, 7);
  state.selected = today();
  render();
});
for (const view of ['month', 'list']) $(`#${view}-view`).addEventListener('click', () => { state.view = view; render(); });
$('#calendar-grid').addEventListener('keydown', event => {
  if (!event.target.matches('.day-number')) return;
  const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
  if (move === undefined) return;
  event.preventDefault();
  const day = addDays(event.target.dataset.date, move);
  if (day < '1900-01-01' || day > '2199-12-31') return;
  state.selected = day;
  state.month = day.slice(0, 7);
  render();
  $(`[data-date="${day}"]`)?.focus();
});

const importDialog = $('#import-dialog');
function clearError() {
  $('#import-error').hidden = true;
  $('#json-input').removeAttribute('aria-invalid');
}
function importError(error) {
  $('#import-error').textContent = error.message;
  $('#import-error').hidden = false;
  $('#json-input').setAttribute('aria-invalid', 'true');
}
function openImport() {
  clearError();
  importDialog.showModal();
  $('#json-input').focus();
}
document.querySelectorAll('[data-import]').forEach(button => button.addEventListener('click', openImport));
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('#fill-example').addEventListener('click', () => {
  $('#json-input').value = JSON.stringify(demoBundle(), null, 2);
  clearError();
});
$('#json-input').addEventListener('input', clearError);
async function readFile(file) {
  if (!file) return;
  clearError();
  if (file.size > MAX_BYTES) return importError(new Error('JSON 파일은 1MB 이하여야 합니다.'));
  try { $('#json-input').value = await file.text(); }
  catch { importError(new Error('파일을 읽지 못했습니다. 다시 선택해 주세요.')); }
}
$('#file-input').addEventListener('change', event => { readFile(event.target.files[0]); event.target.value = ''; });
const drop = $('#file-drop');
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('dragging'); });
for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragging'); });
drop.addEventListener('drop', event => {
  if (event.dataTransfer.files.length !== 1) return importError(new Error('JSON 파일을 하나만 선택해 주세요.'));
  readFile(event.dataTransfer.files[0]);
});
function persist(events) {
  const text = JSON.stringify({ schema_version: 1, events });
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('전체 저장 데이터가 1MB를 초과합니다. 설명을 줄이거나 기존 일정을 정리해 주세요.');
  try { localStorage.setItem(STORAGE_KEY, text); }
  catch { throw new Error('브라우저 저장에 실패했습니다. 저장 권한이나 용량을 확인해 주세요. 기존 일정은 변경하지 않았습니다.'); }
}
$('#import-form').addEventListener('submit', event => {
  event.preventDefault();
  clearError();
  try {
    const incoming = parseBundle($('#json-input').value).events;
    if (!incoming.length) throw new Error('events 배열에 추가할 일정이 없습니다.');
    const existing = state.demo ? [] : state.events;
    const updates = incoming.filter(event => existing.some(old => old.id === event.id)).length;
    const merged = mergeEvents(existing, incoming);
    persist(merged); // Commit browser storage before changing the visible calendar.
    state.events = merged;
    state.demo = false;
    state.filter = 'all';
    state.selected = span(sorted(incoming)[0]).first;
    state.month = state.selected.slice(0, 7);
    render();
    importDialog.close();
  } catch (error) { importError(error); }
});
window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY) location.reload();
});
document.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !event.isPrimary || reducedMotion.matches) return;
  trailStart(event);
  const effects = document.querySelectorAll('.touch-effect');
  if (effects.length >= 8) effects[0].remove();
  const root = event.target.closest('dialog[open]') ?? document.body;
  let layer = root.querySelector(':scope > .touch-layer');
  if (!layer) {
    layer = node('div', 'touch-layer');
    layer.setAttribute('aria-hidden', 'true');
    root.append(layer);
  }
  const effect = node('span', 'touch-effect');
  effect.style.left = `${event.clientX}px`;
  effect.style.top = `${event.clientY}px`;
  effect.append(...Array.from({ length: 4 }, () => node('i', 'touch-spark')));
  layer.append(effect);
  const animation = effect.animate([
    { transform: 'translate(-50%, -50%) scale(.2) rotate(-12deg)', opacity: 1 },
    { transform: 'translate(-50%, -50%) scale(.85) rotate(0deg)', opacity: .9, offset: .35 },
    { transform: 'translate(-50%, -50%) scale(1.3) rotate(10deg)', opacity: 0 },
  ], { duration: 460, easing: 'cubic-bezier(.16,.65,.28,1)' });
  const cleanup = () => {
    effect.remove();
    if (!layer.childElementCount) layer.remove();
  };
  animation.finished.then(cleanup, cleanup);
}, { passive: true });

// 블루아카이브 인게임식 터치 이펙트: canvas 리본 궤적 + 반짝이 파티클 (additive glow).
// ponytail: 게임식 장식이라 reduced-motion에선 시작 자체를 안 함.
let trailCanvas = null;
let trailCtx = null;
let trailDown = false;
let trailHead = null;
let trailSpawn = null;
let trailPoints = []; // {x, y, t} 꼬리부터
let trailStars = []; // {x, y, vx, vy, life, maxLife, size, rot, spin, phase}
let trailRaf = 0;
let trailLast = 0;
const TRAIL_WINDOW = 450; // 궤적 잔상 시간(ms)
const TRAIL_MAX_POINTS = 30;
const TRAIL_MAX_STARS = 140;
function trailEnsure() {
  if (trailCanvas) return;
  trailCanvas = document.createElement('canvas');
  trailCanvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:2147483646;pointer-events:none';
  trailCanvas.setAttribute('aria-hidden', 'true');
  document.body.append(trailCanvas);
  trailCtx = trailCanvas.getContext('2d');
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    trailCanvas.width = Math.round(innerWidth * dpr);
    trailCanvas.height = Math.round(innerHeight * dpr);
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  size();
  window.addEventListener('resize', size);
}
function trailStar(x, y, burst = false) {
  if (trailStars.length >= TRAIL_MAX_STARS) return;
  const angle = Math.random() * Math.PI * 2;
  const speed = (burst ? 2 : 1) * (0.3 + Math.random() * 1.2);
  trailStars.push({
    x: x + (Math.random() - .5) * 6,
    y: y + (Math.random() - .5) * 6,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed - .3,
    life: 0,
    maxLife: 350 + Math.random() * 350,
    size: burst ? 5 + Math.random() * 8 : 3 + Math.random() * 6,
    rot: Math.random() * Math.PI,
    spin: (Math.random() - .5) * .2,
    phase: Math.random() * Math.PI * 2,
  });
}
function trailStart(event) {
  trailEnsure();
  trailPoints = [{ x: event.clientX, y: event.clientY, t: performance.now() }];
  trailStars = [];
  trailHead = { x: event.clientX, y: event.clientY };
  trailSpawn = { ...trailHead };
  trailDown = true;
  for (let i = 0; i < 5; i++) trailStar(event.clientX, event.clientY, true);
  trailKick();
}
function trailMove(event) {
  if (!trailDown) return;
  const x = event.clientX, y = event.clientY;
  trailPoints.push({ x, y, t: performance.now() });
  if (trailPoints.length > TRAIL_MAX_POINTS) trailPoints.shift();
  trailHead = { x, y };
  const dx = x - trailSpawn.x, dy = y - trailSpawn.y;
  if (dx * dx + dy * dy > 36) {
    trailSpawn = { x, y };
    trailStar(x, y);
    if (Math.random() < .5) trailStar(x, y);
  }
  trailKick();
}
function trailEnd() {
  trailDown = false;
}
function trailKick() {
  if (!trailRaf) {
    trailLast = performance.now();
    trailRaf = requestAnimationFrame(trailTick);
  }
}
// 이음새 없는 단일 패스 3겹으로 꼬리 페이드: 마디 겹침이 additive에서 밝은 점으로 찍히는 것을 방지. 중간점 2차곡선으로 스무딩.
function trailRibbon(ctx, points, headFade, style, baseWidth) {
  const layers = [
    { frac: 1.0, alpha: 0.22, width: 0.55 },
    { frac: 0.65, alpha: 0.45, width: 0.8 },
    { frac: 0.35, alpha: 1.0, width: 1.0 },
  ];
  for (const { frac, alpha, width } of layers) {
    const pts = points.slice(-Math.max(2, Math.floor(points.length * frac)));
    if (pts.length < 2) continue;
    ctx.strokeStyle = style(alpha * headFade);
    ctx.lineWidth = baseWidth * width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
}
function trailTick(now) {
  trailRaf = 0;
  const dt = Math.min(now - trailLast, 50);
  trailLast = now;
  const step = dt / 16.7;
  while (trailPoints.length && now - trailPoints[0].t > TRAIL_WINDOW) trailPoints.shift();
  trailStars = trailStars.filter(star => {
    star.life += dt;
    if (star.life >= star.maxLife) return false;
    star.x += star.vx * step;
    star.y += star.vy * step;
    star.vx *= .96;
    star.vy *= .96;
    star.rot += star.spin * step;
    return true;
  });
  const ctx = trailCtx;
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 멈추면 전체가 함께 페이드: 머리점 나이로 전체 스케일
  const headFade = trailPoints.length ? 1 - Math.min(1, (now - trailPoints[trailPoints.length - 1].t) / TRAIL_WINDOW) : 0;
  if (headFade > 0) {
    trailRibbon(ctx, trailPoints, headFade, a => `rgba(33,199,240,${.35 * a})`, 9);
    trailRibbon(ctx, trailPoints, headFade, a => `rgba(234,251,255,${.95 * a})`, 2.5);
  }
  for (const star of trailStars) {
    const k = 1 - star.life / star.maxLife;
    const twinkle = .5 + .5 * Math.sin(star.life * .02 + star.phase);
    const r = star.size * (0.4 + 0.6 * k);
    ctx.save();
    ctx.translate(star.x, star.y);
    ctx.rotate(star.rot);
    ctx.globalAlpha = k * twinkle;
    ctx.strokeStyle = '#bff0ff';
    ctx.lineWidth = Math.max(1, r * .2);
    ctx.beginPath();
    ctx.moveTo(-r, 0); ctx.lineTo(r, 0);
    ctx.moveTo(0, -r); ctx.lineTo(0, r);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(.8, r * .22), 0, 7);
    ctx.fill();
    ctx.restore();
  }
  if (trailDown && trailHead) {
    const glow = ctx.createRadialGradient(trailHead.x, trailHead.y, 0, trailHead.x, trailHead.y, 26);
    glow.addColorStop(0, 'rgba(255,255,255,.9)');
    glow.addColorStop(.35, 'rgba(120,225,250,.55)');
    glow.addColorStop(1, 'rgba(74,216,250,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(trailHead.x, trailHead.y, 26, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (trailDown || trailStars.length || trailPoints.length) trailRaf = requestAnimationFrame(trailTick);
  else ctx.clearRect(0, 0, innerWidth, innerHeight);
}
document.addEventListener('pointermove', event => {
  if (!event.isPrimary || reducedMotion.matches) return;
  trailMove(event);
}, { passive: true });
document.addEventListener('pointerup', () => trailEnd());
document.addEventListener('pointercancel', () => trailEnd());
window.addEventListener('blur', () => trailEnd());

let lastDay = today();
const liveClock = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' });
function updateClock() {
  const now = new Date();
  const currentDay = dateKey(now);
  $('#kst-clock').textContent = liveClock.format(now);
  $('#kst-clock').dateTime = now.toISOString();
  refreshCountdowns();   // 열려 있는 모든 카운트다운 칩을 매초 갱신
  if (currentDay !== lastDay) { lastDay = currentDay; render(); }
}
render();
updateClock();
// 새로고침해도 있던 화면 유지: 저장된 화면이 캘린더가 아니면 복원한다.
try {
  const savedScreen = JSON.parse(localStorage.getItem(SCREEN_KEY) ?? 'null');
  const screens = ['calendar', 'home', 'settings', 'momo-list', 'momotalk'];
  if (savedScreen && screens.includes(savedScreen.screen) && savedScreen.screen !== 'calendar') {
    if (savedScreen.screen === 'momotalk' && typeof savedScreen.room === 'string' && savedScreen.room) {
      activeRoom = savedScreen.room;
      momoRooms[activeRoom] ??= [];
      renderMomo();
      renderMomoList();
    }
    if (savedScreen.screen === 'settings' && Object.hasOwn(SET_TITLES, savedScreen.tab)) {
      setTab = savedScreen.tab;
      document.querySelectorAll('.set-nav').forEach(other => other.setAttribute('aria-current', String(other.dataset.set === setTab)));
    }
    showScreen(savedScreen.screen);
    if (savedScreen.screen === 'settings') $('#app-settings').dataset.pane = 'detail';
  }
} catch { /* 저장 실패해도 캘린더 기본값 유지 */ }
setInterval(updateClock, 1000);
setInterval(renderMetrics, 60_000);

