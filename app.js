import {
  TIME_ZONE, CATEGORIES, STATUSES, MAX_BYTES, dateKey, addDays, shiftMonth, monthDays, displayDays,
  span, overlaps, clockLabel, timeLabel, rangeLabel, parseBundle, mergeEvents, compareEvents, featuredEvents, demoBundle,
} from './calendar.js';

const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'molu.calendar.v1';
const BOOKMARK_KEY = 'molu.bookmarks.v1';
const ALARM_KEY = 'molu.alarms.v1';
const loadIds = key => { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); } };
const today = () => dateKey();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const BANNERS = ['images.jpg', 'i1mages.jpg', '1231123.jpg'].map(name => `./resource/event_banner_img/${name}`);
const state = { events: demoBundle().events, demo: true, month: today().slice(0, 7), selected: today(), filter: 'all', view: 'month', featureId: null, featurePaused: reducedMotion.matches, bookmarks: loadIds(BOOKMARK_KEY), alarms: loadIds(ALARM_KEY), detailId: null, featureRot: 0 };
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
  $('#event-range').textContent = rangeLabel(event);
  $('#event-start-clock').textContent = event.all_day ? '종일' : clockLabel(event.start);
  $('#event-start-date').textContent = span(event).first;
  $('#event-end-clock').textContent = event.all_day ? '종일' : event.end ? clockLabel(event.end) : '미정';
  $('#event-end-date').textContent = event.all_day ? span(event).last : event.end ? dateKey(event.end) : '종료 시각 미등록';
  $('#event-description').textContent = event.description || '등록된 설명이 없습니다.';
  $('#event-id').textContent = event.id;
  state.detailId = event.id;
  $('#bookmark-button').setAttribute('aria-pressed', String(state.bookmarks.has(event.id)));
  $('#alarm-button').setAttribute('aria-pressed', String(state.alarms.has(event.id)));
  const category = eventColor(node('span', 'tag category', CATEGORIES[event.category].label), event);
  $('#event-tags').replaceChildren(category, node('span', 'tag', STATUSES[event.status]));
  const link = $('#event-source');
  link.hidden = !event.source_url;
  if (event.source_url) {
    link.href = event.source_url;
    link.textContent = '원문 보기 ↗';
  } else link.removeAttribute('href');
  $('#event-dialog').showModal();
}
function toggleSaved(set, key, message) {
  const id = state.detailId;
  if (!id) return;
  set.has(id) ? set.delete(id) : set.add(id);
  try { localStorage.setItem(key, JSON.stringify([...set])); } catch { /* 저장 실패해도 세션 내 동작 유지 */ }
  renderFilters();
  renderCalendar();
  renderBriefing();
}
$('#bookmark-button').addEventListener('click', () => {
  toggleSaved(state.bookmarks, BOOKMARK_KEY, state.bookmarks.has(state.detailId) ? '북마크에 담았습니다.' : '북마크에서 뺐습니다.');
  $('#bookmark-button').setAttribute('aria-pressed', String(state.bookmarks.has(state.detailId)));
});
$('#alarm-button').addEventListener('click', () => {
  toggleSaved(state.alarms, ALARM_KEY, state.alarms.has(state.detailId) ? '알람을 해제했습니다.' : '알람을 설정했습니다.');
  $('#alarm-button').setAttribute('aria-pressed', String(state.alarms.has(state.detailId)));
});
$('#banner-next').addEventListener('click', () => {
  state.featureRot += 1;
  renderFeatured();
});
$('#home-indicator').addEventListener('click', () => {
  state.filter = 'all';
  state.view = 'month';
  state.month = today().slice(0, 7);
  state.selected = today();
  render();
  document.querySelector('.content-layout').scrollTo({ top: 0, behavior: 'smooth' });
});

function makeEventCard(event) {
  const button = eventColor(node('button', 'day-event-card'), event);
  button.type = 'button';
  const body = node('span', 'event-card-body');
  const meta = node('span', 'event-card-meta', CATEGORIES[event.category].label);
  meta.append(node('span', 'event-card-status', STATUSES[event.status]));
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
    body.append(node('span', 'event-card-meta', `${CATEGORIES[event.category].label} · ${STATUSES[event.status]}`), node('span', 'event-card-title', event.title), node('span', 'range', rangeLabel(event)));
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
function renderFeatured(events = featuredEvents(state.events)) {
  const index = events.length ? state.featureRot % events.length : 0;
  const event = events[index];
  const image = $('#memo-banner');
  image.hidden = !event;
  $('#banner-next').hidden = !event;
  if (event) {
    const rotated = state.featureShown && state.featureShown !== event.id;
    image.src = BANNERS[index % BANNERS.length];
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
  if (document.hidden || document.querySelector('dialog[open]') || $('#memo-banner').matches(':hover')) return;
  state.featureRot += 1;
  renderFeatured();
}, 6000);
function render() {
  renderFilters();
  renderCalendar();
  renderBriefing();
  renderMetrics();
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

let lastDay = today();
const liveClock = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit' });
function updateClock() {
  const now = new Date();
  const currentDay = dateKey(now);
  $('#kst-clock').textContent = liveClock.format(now);
  $('#kst-clock').dateTime = now.toISOString();
  $('#kst-date').textContent = currentDay.replaceAll('-', '.');
  if (currentDay !== lastDay) { lastDay = currentDay; render(); }
}
render();
updateClock();
setInterval(updateClock, 1000);
setInterval(renderMetrics, 60_000);

