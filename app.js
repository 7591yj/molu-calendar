import {
  TIME_ZONE, CATEGORIES, STATUSES, MAX_BYTES, dateKey, addDays, shiftMonth, monthDays, displayDays,
  span, overlaps, clockLabel, timeLabel, rangeLabel, parseBundle, mergeEvents, compareEvents, featuredEvents, bannerEvents, remainingLabel, SERVERS, eventServers, LANGS, FALLBACK_LANG, countryLanguage, eventImage, eventImageCandidates, segments, timeFrac, assignLanes,
} from './calendar.js';
import { momoTopicsFor, momoReply, momoPromptPlan, momoCalendarQuery, momoSupportsAI, PROMPT_CHAR_BUDGET, MOMO_HISTORY_TURNS } from './momotalk.js';
import { localAISession as aiSession } from './local-ai-session.js';
import { errorWithCode } from './local-ai.js';
import { localAISettings } from './local-ai-settings.js';
import { ChatTranscript } from './chat-transcript.js';
import { filterMemories, memoryDraftFromMessage, selectExcerpts, selectMemories, MEMORY_LIMIT, MEMORY_CHAR_BUDGET } from './chat-memory.js';
import { EXCERPT_LIMITS, promptCharsFor } from './persona.js';
import { CHAT_DB_NAME } from './chat-store.js';
import { cropSettings, cropRegion, cropImageStyle, clampCropScale, clampCropCenter, moveCropCenter, resizeCrop, withCrop } from './banner-crop.js';

const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'molu.calendar.v1';
const BOOKMARK_KEY = 'molu.bookmarks.v1';
const loadIds = key => { try { return new Set(JSON.parse(localStorage.getItem(key) ?? '[]')); } catch { return new Set(); } };
const today = () => dateKey();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
// 메모·상세 배너 모두 설정한 언어를 따른다.
function showBanner(image, event) {
  const candidates = eventImageCandidates(event, prefs.lang);
  const file = candidates[0];
  const frame = bannerFrame(image);
  const memo = image.id === 'memo-banner';
  const interactive = Boolean(event && (memo || (prefs.devMode && file)));
  if (event) frame.dataset.eventId = event.id;
  else delete frame.dataset.eventId;
  frame.classList.toggle('dev', !memo && prefs.devMode && Boolean(file));
  frame.title = event && memo ? '클릭: 일정 상세 보기' : interactive ? '클릭: 원본에서 크롭 영역 편집' : '';
  frame.tabIndex = interactive ? 0 : -1;
  if (interactive) {
    frame.setAttribute('role', 'button');
    frame.setAttribute('aria-label', `${event.title} ${memo ? '상세 보기' : '배너 크롭 편집'}`);
  } else {
    frame.removeAttribute('role');
    frame.removeAttribute('aria-label');
  }
  image.alt = event?.title ?? '';
  if (image.dataset.bannerLang === prefs.lang && candidates.includes(image.dataset.cropFile) && !image.hidden) return;
  image.dataset.bannerLang = prefs.lang;
  const placeholder = message => {
    image.hidden = true;
    frame.dataset.placeholder = event ? `${event.title}\n${message}${memo ? '\n클릭하여 상세 내용 보기' : ''}` : '표시할 일정이 없습니다.\n다른 서버를 선택하거나 일정을 가져와 주세요.';
  };
  image.onload = null;
  image.onerror = null;
  if (!file) {
    image.removeAttribute('src');
    delete image.dataset.cropFile;
    placeholder('배너 이미지 준비 중');
    return;
  }
  image.onload = () => {
    image.hidden = false;
    delete frame.dataset.placeholder;
    applyBannerCrop(image, crops[image.dataset.cropFile]);
  };
  let index = 0;
  const loadNext = () => {
    const next = candidates[index++];
    if (!next) {
      image.onerror = null;
      placeholder('배너 이미지를 불러오지 못했습니다.');
      return;
    }
    image.dataset.cropFile = next;
    image.src = `./resource/event_banner_img/${next}`;
  };
  image.onerror = loadNext;
  placeholder('배너 이미지 불러오는 중');
  loadNext();
}
const PREFS_KEY = 'molu.prefs.v1';
// 언어 기본값: 브라우저 언어를 따르고, 모르는 언어면 일본어(폴백 언어)로 시작한다.
const BROWSER_LANGS = { ko: 'kr', ja: 'jp', zh: 'zh', en: 'en' };
let prefs = { view: 'month', filter: 'all', server: 'all', lang: BROWSER_LANGS[(navigator.language ?? '').slice(0, 2).toLowerCase()] ?? FALLBACK_LANG, bannerAuto: true, momoSound: true, devMode: false };
let languageChosen = false;
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
  languageChosen = Object.hasOwn(LANGS, saved?.lang);
  prefs = { ...prefs, ...saved };
} catch { /* 저장 실패해도 기본값 유지 */ }
if (prefs.view !== 'month' && prefs.view !== 'list') prefs.view = 'month';
if (!['all', 'bookmarks', ...Object.keys(CATEGORIES)].includes(prefs.filter)) prefs.filter = 'all';
if (!['all', ...Object.keys(SERVERS)].includes(prefs.server)) prefs.server = 'all';
if (!Object.hasOwn(LANGS, prefs.lang)) prefs.lang = FALLBACK_LANG;
prefs.bannerAuto = prefs.bannerAuto !== false;
prefs.momoSound = prefs.momoSound !== false;
prefs.devMode = prefs.devMode === true;
// 배너 크롭: 파일별 위치·영역 크기. 이전 object-position 문자열도 계속 읽는다.
const CROP_KEY = 'molu.banner-crop.v1';
let crops = {};
try { crops = JSON.parse(localStorage.getItem(CROP_KEY) ?? '{}'); } catch { /* 저장 실패해도 중앙 크롭 유지 */ }
if (typeof crops !== 'object' || crops === null || Array.isArray(crops)) crops = {};
function saveCrops(next) {
  try { localStorage.setItem(CROP_KEY, JSON.stringify(next)); }
  catch { return false; }
  const files = new Set([...Object.keys(crops), ...Object.keys(next)]);
  crops = next;
  files.forEach(syncCropLabels);
  return true;
}
function bannerFrame(image) {
  if (image.parentElement?.classList.contains('banner-frame')) return image.parentElement;
  const frame = document.createElement('span');
  frame.className = `banner-frame ${image.id === 'crop-preview' ? 'crop-preview-frame' : image.className}`;
  image.classList.add('banner-source');
  image.replaceWith(frame);
  frame.append(image);
  return frame;
}
function applyBannerCrop(image, settings) {
  bannerFrame(image);
  if (!image.naturalWidth) return;
  const { position, scale, center } = cropSettings(settings);
  Object.assign(image.style, cropImageStyle(cropRegion(image.naturalWidth, image.naturalHeight, position, scale, center)));
}
function cropLabel(settings) {
  const { position, scale, center } = cropSettings(settings);
  const coordinates = center ?? position;
  return `${center ? '중심 ' : ''}${coordinates[0].toFixed(1)}% ${coordinates[1].toFixed(1)}% · 영역 ${Math.round(scale * 100)}%`;
}
const syncCropLabels = file => {
  const selector = CSS.escape(file);
  document.querySelectorAll(`[data-crop-label="${selector}"]`).forEach(label => { label.textContent = cropLabel(crops[file]); });
  document.querySelectorAll(`img[data-crop-file="${selector}"]`).forEach(image => applyBannerCrop(image, crops[file]));
};
function attachCropEditor(image) {
  const frame = bannerFrame(image);
  image.draggable = false;
  image.addEventListener('load', () => applyBannerCrop(image, crops[image.dataset.cropFile]));
  const activate = () => {
    if (image.id === 'memo-banner') {
      const event = state.events.find(event => event.id === frame.dataset.eventId);
      if (event) onEventClick(event);
    } else if (prefs.devMode && !image.hidden && image.dataset.cropFile) openCropEditor(image.dataset.cropFile);
  };
  frame.addEventListener('click', activate);
  frame.addEventListener('keydown', event => {
    if ((image.id !== 'memo-banner' && !prefs.devMode) || !['Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    activate();
  });
}
attachCropEditor($('#event-banner'));
attachCropEditor($('#memo-banner'));

let cropDraft = null;
let cropDrag = null;
let cropViewZoom = 1; // Editing view only; never saved as part of the crop.
const cropDialog = $('#crop-dialog');
const cropOriginal = $('#crop-original');
const cropSelection = $('#crop-selection');
function cropViewFitFactor() {
  const viewport = cropOriginal.parentElement.parentElement;
  return Math.min((viewport.clientWidth - 16) / cropOriginal.naturalWidth, (viewport.clientHeight - 16) / cropOriginal.naturalHeight);
}
function updateCropEditor() {
  if (!cropDialog.open || !cropDraft || !cropOriginal.naturalWidth) return;
  const region = cropRegion(cropOriginal.naturalWidth, cropOriginal.naturalHeight, cropDraft.position, cropDraft.scale, cropDraft.center);
  // Convert legacy object-position to a source-relative center without changing the crop.
  cropDraft.center ??= [region.x + region.w / 2, region.y + region.h / 2];
  const fit = cropViewFitFactor() * cropViewZoom;
  // Fixed virtual workspace (-800..900%) keeps the source stationary while resizing.
  // CSS only: this large scroll area does not allocate a large bitmap.
  Object.assign(cropOriginal.parentElement.style, { width: `${cropOriginal.naturalWidth * 17 * fit}px`, height: `${cropOriginal.naturalHeight * 17 * fit}px` });
  Object.assign(cropOriginal.style, { left: `${800 / 17}%`, top: `${800 / 17}%`, width: `${100 / 17}%`, height: `${100 / 17}%` });
  Object.assign(cropSelection.style, { left: `${(region.x + 800) / 17}%`, top: `${(region.y + 800) / 17}%`, width: `${region.w / 17}%`, height: `${region.h / 17}%` });
  cropSelection.hidden = false;
  for (const name of ['scale', 'x', 'y']) {
    const value = name === 'scale' ? cropDraft.scale * 100 : cropDraft.center[name === 'x' ? 0 : 1];
    for (const suffix of ['', '-number']) {
      const input = $(`#crop-${name}${suffix}`);
      input.disabled = false;
      if (document.activeElement !== input) input.value = Math.round(value * 10) / 10;
    }
  }
  if (document.activeElement !== $('#crop-view-zoom')) $('#crop-view-zoom').value = Math.round(cropViewZoom * 100);
  applyBannerCrop($('#crop-preview'), cropDraft);
}
function setCropViewZoom(percent) {
  if (!cropDraft || !cropOriginal.naturalWidth || !Number.isFinite(percent)) return;
  const stage = cropOriginal.parentElement, viewport = stage.parentElement;
  const x = stage.offsetWidth <= viewport.clientWidth ? 0.5 : (viewport.scrollLeft + viewport.clientWidth / 2) / stage.offsetWidth;
  const y = stage.offsetHeight <= viewport.clientHeight ? 0.5 : (viewport.scrollTop + viewport.clientHeight / 2) / stage.offsetHeight;
  cropDrag = null;
  cropViewZoom = Math.min(4, Math.max(0.1, percent / 100));
  updateCropEditor();
  viewport.scrollLeft = x * stage.offsetWidth - viewport.clientWidth / 2;
  viewport.scrollTop = y * stage.offsetHeight - viewport.clientHeight / 2;
}
function fitCropView() {
  if (!cropDraft || !cropOriginal.naturalWidth) return;
  updateCropEditor();
  const region = cropRegion(cropOriginal.naturalWidth, cropOriginal.naturalHeight, cropDraft.position, cropDraft.scale, cropDraft.center);
  const stage = cropOriginal.parentElement, viewport = stage.parentElement;
  const fit = Math.min((viewport.clientWidth - 40) / (cropOriginal.naturalWidth * region.w / 100), (viewport.clientHeight - 40) / (cropOriginal.naturalHeight * region.h / 100));
  cropViewZoom = Math.min(4, Math.max(0.1, fit / cropViewFitFactor()));
  updateCropEditor();
  viewport.scrollLeft = (cropDraft.center[0] + 800) / 1700 * stage.offsetWidth - viewport.clientWidth / 2;
  viewport.scrollTop = (cropDraft.center[1] + 800) / 1700 * stage.offsetHeight - viewport.clientHeight / 2;
}
function openCropEditor(file) {
  if (!prefs.devMode || !file || cropDialog.open) return;
  cropDraft = { file, ...cropSettings(crops[file]) };
  cropDrag = null;
  cropViewZoom = 1;
  cropSelection.hidden = true;
  for (const name of ['scale', 'x', 'y']) for (const suffix of ['', '-number']) $(`#crop-${name}${suffix}`).disabled = true;
  $('#crop-save').disabled = true;
  $('#crop-error').hidden = true;
  $('#crop-filename').textContent = file;
  cropOriginal.onload = () => { if (cropDraft && cropDialog.open) { fitCropView(); $('#crop-save').disabled = false; } };
  cropOriginal.onerror = () => {
    $('#crop-error').textContent = '원본 이미지를 불러오지 못했습니다.';
    $('#crop-error').hidden = false;
  };
  cropOriginal.src = `./resource/event_banner_img/${file}`;
  bannerFrame($('#crop-preview'));
  $('#crop-preview').onload = updateCropEditor;
  $('#crop-preview').src = cropOriginal.src;
  cropDialog.showModal();
}
for (const name of ['scale', 'x', 'y']) for (const suffix of ['', '-number']) {
  const input = $(`#crop-${name}${suffix}`);
  const edit = () => {
    if (!cropDraft?.center) return;
    const value = input.valueAsNumber;
    if (Number.isFinite(value)) {
      if (name === 'scale') cropDraft.scale = clampCropScale(value / 100);
      else cropDraft.center[name === 'x' ? 0 : 1] = clampCropCenter(value);
      cropDrag = null;
      updateCropEditor();
    }
  };
  input.addEventListener('input', edit);
  input.addEventListener('change', () => {
    edit();
    if (!cropDraft?.center) return;
    const value = name === 'scale' ? cropDraft.scale * 100 : cropDraft.center[name === 'x' ? 0 : 1];
    input.value = Math.round(value * 10) / 10;
  });
}
$('#crop-view-zoom').addEventListener('input', event => setCropViewZoom(event.target.valueAsNumber));
$('#crop-view-zoom').addEventListener('change', () => { $('#crop-view-zoom').value = Math.round(cropViewZoom * 100); });
$('#crop-view-in').addEventListener('click', () => setCropViewZoom(cropViewZoom * 125));
$('#crop-view-out').addEventListener('click', () => setCropViewZoom(cropViewZoom * 80));
$('#crop-view-fit').addEventListener('click', fitCropView);
window.addEventListener('resize', () => { if (cropDialog.open) setCropViewZoom(cropViewZoom * 100); });
cropSelection.addEventListener('pointerdown', event => {
  if (!cropDraft || event.button !== 0) return;
  cropDrag = {
    x: event.clientX, y: event.clientY,
    settings: { position: [...cropDraft.position], center: [...cropDraft.center], scale: cropDraft.scale },
    box: cropOriginal.getBoundingClientRect(),
    handle: event.target.closest('[data-crop-handle]')?.dataset.cropHandle,
  };
  cropSelection.setPointerCapture(event.pointerId);
  event.preventDefault();
});
cropSelection.addEventListener('pointermove', event => {
  if (!cropDraft || !cropDrag) return;
  const dx = event.clientX - cropDrag.x, dy = event.clientY - cropDrag.y;
  if (cropDrag.handle) {
    Object.assign(cropDraft, resizeCrop(cropOriginal.naturalWidth, cropOriginal.naturalHeight, cropDrag.settings, dx, dy, cropDrag.box, cropDrag.handle));
  } else {
    cropDraft.center = moveCropCenter(cropDrag.settings.center, dx, dy, cropDrag.box);
  }
  updateCropEditor();
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) cropSelection.addEventListener(type, () => { cropDrag = null; });
$('#crop-reset').addEventListener('click', () => {
  if (!cropDraft) return;
  cropDraft.position = [50, 50];
  cropDraft.center = [50, 50];
  cropDraft.scale = 1;
  fitCropView();
});
$('#crop-cancel').addEventListener('click', () => cropDialog.close());
$('#crop-save').addEventListener('click', () => {
  if (!cropDraft) return;
  const next = withCrop(crops, cropDraft.file, cropDraft.position, cropDraft.scale, cropDraft.center);
  if (!saveCrops(next)) {
    $('#crop-error').textContent = '저장하지 못했습니다. 브라우저 저장 공간을 확인해 주세요.';
    $('#crop-error').hidden = false;
    return;
  }
  cropDialog.close();
});
cropDialog.addEventListener('close', () => { cropDraft = null; cropDrag = null; });
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } };
const SCREEN_KEY = 'molu.screen.v1';
const saveScreen = () => { try { localStorage.setItem(SCREEN_KEY, JSON.stringify({ screen: activeScreen, room: activeRoom, tab: setTab })); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } };
const state = { events: [], builtin: true, month: today().slice(0, 7), selected: today(), filter: prefs.filter, server: prefs.server, view: prefs.view, featureId: null, featurePaused: reducedMotion.matches, bookmarks: loadIds(BOOKMARK_KEY), detailId: null, featureRot: 0 };
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) {
    state.events = parseBundle(saved).events;
    state.builtin = false;
  }
} catch { /* 저장 데이터가 깨져도 내장 일정으로 시작한다 */ }
// 내장 일정: 블루 아카이브 실제 운영 일정을 tools/vendor_events.py로 벤더링한 파일.
// 저장된 사용자 일정이 있으면 덮어쓰지 않고, 가져오기 예시로만 남긴다.
let builtin = { schema_version: 1, events: [] };
fetch('./resource/events.json').then(response => response.text()).then(text => {
  builtin = { schema_version: 1, events: parseBundle(text).events };
  if (!state.builtin) return;
  state.events = builtin.events;
  render();
}).catch(() => { /* 내장 일정을 못 읽으면 빈 달력에서 가져오기로 채운다 */ });

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
function serverEvents() {
  return state.events.filter(event => state.server === 'all' || eventServers(event).includes(state.server));
}
function filteredEvents() {
  return serverEvents().filter(event => state.filter === 'all' || (state.filter === 'bookmarks' ? state.bookmarks.has(event.id) : event.category === state.filter));
}
const serverTag = event => eventServers(event).map(server => SERVERS[server].short).join('·');
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
  showBanner($('#event-banner'), event);
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
  const chips = [node('span', 'tag', serverTag(event)), category, node('span', 'tag', STATUSES[event.status])];
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
// iOS backlink: 크로스앱 진입 시 출처로 돌아가는 버튼. { screen, room, label } 또는 null.
let appReturn = null;
const APP_NAMES = { calendar: '캘린더', settings: '설정', momotalk: '모모톡', 'momo-list': '모모톡' };
function showScreen(name) {
  if (activeScreen === 'momotalk' && name !== 'momotalk') cancelMomoAI('화면 이동으로 로컬 AI 작업을 취소했습니다.');
  activeScreen = name;
  $('#home-screen').hidden = name !== 'home';
  $('#app-settings').hidden = name !== 'settings';
  $('#app-momo-list').hidden = name !== 'momo-list';
  $('#app-momotalk').hidden = name !== 'momotalk';
  $('#dock').hidden = name !== 'home';
  $('#home-indicator').hidden = name === 'home';
  document.querySelector('.workspace').style.visibility = (name !== 'calendar') ? 'hidden' : ''; document.querySelector('.workspace').inert = 
  $('#home-screen').inert = name !== 'home';
  const targets = { home: '#home-title', calendar: '#month-heading', settings: '#app-settings-title', momotalk: '#momo-profile-open', 'momo-list': '#momo-list-title' };
  playAppAnimation(name, 'fade', targets[name]);
  if (name === 'settings') { $('#app-settings').dataset.pane = 'side'; renderSetDetail(); }
  appReturn = null;
  renderBacklinks();
  saveScreen();
}
// 크로스앱 진입: 출처를 기억하고 backlink를 띄운다. room은 모모톡 대화방 복귀용.
function enterApp(name, { room = null } = {}) {
  const from = activeScreen;
  const cross = (from === 'momotalk' || from === 'momo-list') && (name === 'settings')
    || (from === 'settings' && (name === 'momotalk' || name === 'momo-list'));
  if (!cross) { showScreen(name); return; }
  if (from === 'momotalk' && name !== 'momotalk') cancelMomoAI('화면 이동으로 로컬 AI 작업을 취소했습니다.');
  appReturn = { screen: from, room: from === 'momotalk' ? (room ?? activeRoom) : null, label: APP_NAMES[from] ?? from };
  activeScreen = name;
  $('#home-screen').hidden = name !== 'home';
  $('#app-settings').hidden = name !== 'settings';
  $('#app-momo-list').hidden = name !== 'momo-list';
  $('#app-momotalk').hidden = name !== 'momotalk';
  $('#dock').hidden = name !== 'home';
  $('#home-indicator').hidden = name === 'home';
  document.querySelector('.workspace').style.visibility = (name !== 'calendar') ? 'hidden' : ''; document.querySelector('.workspace').inert = 
  $('#home-screen').inert = name !== 'home';
  if (name === 'settings') { $('#app-settings').dataset.pane = 'side'; renderSetDetail(); }
  renderBacklinks();
  saveScreen();
  playAppAnimation(name, 'push', { settings: '#app-settings-title', momotalk: '#momo-profile-open', 'momo-list': '#momo-list-title' }[name]);
}
function renderBacklinks() {
  document.querySelectorAll('[data-app-back]').forEach(button => {
    const show = Boolean(appReturn) && button.dataset.appBack === activeScreen;
    button.hidden = !show;
    if (show) button.querySelector('span').textContent = appReturn.label;
  });
}
function goBackApp() {
  if (!appReturn) return;
  const { screen, room } = appReturn;
  appReturn = null;
  if (screen === 'momotalk' && room) { void openRoom(room); }
  activeScreen = screen;
  $('#home-screen').hidden = screen !== 'home';
  $('#app-settings').hidden = screen !== 'settings';
  $('#app-momo-list').hidden = screen !== 'momo-list';
  $('#app-momotalk').hidden = screen !== 'momotalk';
  $('#dock').hidden = screen !== 'home';
  $('#home-indicator').hidden = screen === 'home';
  document.querySelector('.workspace').style.visibility = (screen !== 'calendar') ? 'hidden' : ''; document.querySelector('.workspace').inert = 
  $('#home-screen').inert = screen !== 'home';
  if (screen === 'settings') { $('#app-settings').dataset.pane = 'side'; renderSetDetail(); }
  renderBacklinks();
  saveScreen();
  playAppAnimation(screen, 'pop', { settings: '#app-settings-title', momotalk: '#momo-profile-open', 'momo-list': '#momo-list-title' }[screen]);
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
let setPath = [];  // 밀려 올라간 하위 페이지 스택. 마지막 항목이 지금 보이는 페이지다.
// 한 열일 때만 카테고리가 목록 위로 밀려 올라온다. 분할 레이아웃(사이드바 + 상세)에서는 선택일 뿐이라
// 상세 열 내용만 바뀐다. 아래 값은 styles.css의 분할 브레이크포인트와 같아야 한다.
const SET_SINGLE_COLUMN = matchMedia('(max-width:640px)');
const SET_TITLES = { general: '일반', ai: '로컬 AI', character: '캐릭터', data: '데이터', about: '정보', dev: '개발자' };
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}
function iosText(label, sub) {
  const text = node('span', 'ios-text', label);
  if (sub) text.append(node('span', 'ios-sub', sub));
  return text;
}
// iOS 목록 행: 값·체크 표시·셰브론·아이콘 타일을 조합한다. onSelect가 있으면 누를 수 있다.
function iosRow(label, { sub, value, icon: iconName, tint, danger, check, chevron, onSelect } = {}) {
  const row = onSelect ? node('button', 'ios-row') : node('div', 'ios-row');
  if (onSelect) row.type = 'button';
  if (onSelect && check !== undefined) row.setAttribute('aria-pressed', String(check));
  if (danger) row.classList.add('ios-row-danger');
  if (iconName) {
    const tile = node('span', 'ios-ico');
    tile.style.setProperty('--tic', tint);
    tile.append(icon(iconName));
    row.append(tile);
  }
  row.append(iosText(label, sub));
  if (value !== undefined) row.append(node('span', 'ios-value', value));
  const mark = check ? 'ios-check' : onSelect && chevron !== false ? 'ios-chevron' : null;
  if (mark) {
    const span = node('span', mark);
    span.append(icon(check ? 'i-check' : 'i-chevron'));
    row.append(span);
  }
  if (onSelect) row.addEventListener('click', onSelect);
  return row;
}
// iOS 스위치 행: 행 전체를 눌러 켜고 끈다.
function iosSwitch(label, sub, on, onFlip) {
  const row = node('button', 'ios-row');
  row.type = 'button';
  row.setAttribute('role', 'switch');
  row.setAttribute('aria-checked', String(on));
  row.append(iosText(label, sub), node('span', 'set-switch'));
  row.addEventListener('click', () => {
    on = !on;
    row.setAttribute('aria-checked', String(on));
    onFlip(on);
  });
  return row;
}
function iosSection(rows, { header, footer } = {}) {
  const section = node('div', 'ios-section');
  if (header) section.append(node('h4', 'ios-section-title', header));
  if (rows.length) {
    const card = node('div', 'ios-card');
    card.append(...rows);
    section.append(card);
  }
  if (footer) section.append(node('p', 'ios-section-footer', footer));
  return section;
}
// iOS처럼 고르는 화면: 현재 값에 체크를 두고, 고르면 이전 화면으로 돌아간다.
function pushChoice(title, options, current, onPick, footer) {
  setPath.push({ title, options, current, onPick, footer });
  renderSetDetail('push');
}
function popSetPage() {
  setPath.pop();
  renderSetDetail('pop');
}
// 자유 구성 화면: 개발자 도구처럼 체크 선택이 아닌 페이지를 밀어 올린다.
function pushPage(title, build) {
  setPath.push({ title, build });
  renderSetDetail('push');
}
function setView(view) { state.view = view; prefs.view = view; savePrefs(); render(); renderSetDetail(); }
function setFilter(filter) { state.filter = filter; prefs.filter = filter; savePrefs(); render(); renderSetDetail(); }
function setServer(server) { state.server = server; prefs.server = server; savePrefs(); state.featureRot = 0; render(); renderSetDetail(); }
function setLang(lang) { languageChosen = true; prefs.lang = lang; savePrefs(); render(); renderSetDetail(); }
function playSetAnimation(kind) {
  if (reducedMotion.matches) return;
  const body = $('#set-body');
  delete body.dataset.anim;
  void body.offsetWidth;   // 같은 전환을 연속으로 재생하려면 리플로우가 한 번 필요하다
  body.dataset.anim = kind;
  body.addEventListener('animationend', () => delete body.dataset.anim, { once: true });
}
// 앱 전환: 새 앱은 오른쪽에서(push), backlink 복귀는 왼쪽에서(pop), 허브 이동은 페이드.
const APP_SCREENS = { home: '#home-screen', calendar: null, settings: '#app-settings', momotalk: '#app-momotalk', 'momo-list': '#app-momo-list' };
function playAppAnimation(name, kind, focus) {
  const selector = APP_SCREENS[name];
  const screen = selector ? $(selector) : document.querySelector('.workspace');
  const applyFocus = () => { if (focus) $(focus)?.focus({ preventScroll: true }); };
  if (reducedMotion.matches || !screen) { applyFocus(); return; }
  delete screen.dataset.appear;
  void screen.offsetWidth;
  screen.dataset.appear = kind;
  screen.addEventListener('animationend', () => { delete screen.dataset.appear; applyFocus(); }, { once: true });
  // animation이 취소되면 포커스가 묶이지 않게 폴백.
  setTimeout(() => { if (screen.dataset.appear) { delete screen.dataset.appear; applyFocus(); } }, 500);
}
// 개발자 모드: 배너 이미지에 크롭 편집 동작을 붙이거나 뗀다.
function applyDevMode(on) {
  const frame = bannerFrame($('#event-banner'));
  frame.classList.toggle('dev', on);
  frame.tabIndex = on ? 0 : -1;
  frame.title = on ? '클릭: 원본에서 크롭 영역 편집' : '';
  if (on) {
    frame.setAttribute('role', 'button');
    frame.setAttribute('aria-label', '배너 크롭 편집');
  } else {
    frame.removeAttribute('role');
    frame.removeAttribute('aria-label');
  }
}
function setCategorySections() {
  const label = (options, value) => options.find(([key]) => key === value)?.[1] ?? value;
  const viewOptions = [['month', '월간'], ['list', '목록']];
  const serverOptions = [['all', '전체'], ...Object.entries(SERVERS).map(([key, server]) => [key, server.label])];
  const filterOptions = [['all', '전체'], ...Object.entries(CATEGORIES).map(([key, category]) => [key, category.label]), ['bookmarks', '북마크']];
  if (setTab === 'general') return [
    iosSection([
      iosRow('보기 방식', { value: label(viewOptions, state.view), onSelect: () => pushChoice('보기 방식', viewOptions, () => state.view, setView) }),
      iosRow('서버', { value: label(serverOptions, state.server), onSelect: () => pushChoice('서버', serverOptions, () => state.server, setServer, '일본은 선행 일정, 한국·글로벌은 후행 일정입니다.') }),
      iosRow('분류', { value: label(filterOptions, state.filter), onSelect: () => pushChoice('분류', filterOptions, () => state.filter, setFilter) }),
      iosRow('배너 언어', { value: LANGS[prefs.lang], onSelect: () => pushChoice('배너 언어', Object.entries(LANGS), () => prefs.lang, setLang, '해당 언어 이미지가 없으면 일본어 배너로 대체합니다.') }),
    ], { header: '표시' }),
    iosSection([
      iosSwitch('배너 자동 넘김', '6초마다 추천 일정을 넘깁니다', prefs.bannerAuto, on => { prefs.bannerAuto = on; savePrefs(); }),
      iosSwitch('모모톡 알림음', '메시지가 도착하면 알림음을 재생합니다', prefs.momoSound, on => { prefs.momoSound = on; savePrefs(); }),
    ], { header: '배너와 알림' }),
    iosSection([], { footer: '첫 접속 시 IP 국가로 배너 언어를 설정합니다. IP 조회에 실패하면 브라우저 언어를 사용하고, 이후에는 직접 고른 언어를 유지합니다.' }),
  ];
  if (setTab === 'ai') return [localAISettings({ row: iosRow, section: iosSection, element: node, toggle: iosSwitch, choose: pushChoice, page: pushPage, momo: momoAdmin })];
  if (setTab === 'character') return [
    iosSection([iosRow('3D 캐릭터', { value: '모델 파일 없음' })], { header: '샬레' }),
    iosSection([], { footer: 'GawrGura 모델 파일을 준비하면 샬레에 캐릭터가 등장합니다.' }),
  ];
  if (setTab === 'data') {
    const bytes = new TextEncoder().encode(JSON.stringify({ schema_version: 1, events: state.events })).length;
    return [
      iosSection([iosRow('JSON 가져오기', { value: 'schema v1', onSelect: () => openImport() })], { header: '일정 데이터' }),
      iosSection([
        iosRow('저장된 일정', { value: `${state.events.length}건` }),
        iosRow('저장 크기', { value: `${(bytes / 1024).toFixed(1)} KB / 1 MB` }),
      ], { header: '저장 공간', footer: '가져온 일정은 검증 후 이 브라우저에만 저장됩니다.' }),
      iosSection([iosRow('저장 데이터 초기화', {
        danger: true,
        chevron: false,
        onSelect: () => { void resetAppData(); },
      })], { footer: '일정·북마크·대화 기록과 AI 설정·측정 결과가 지워집니다. 되돌릴 수 없습니다. 다운로드한 AI 모델은 로컬 AI 페이지에서 별도로 삭제해 주세요.' }),
    ];
  }
  if (setTab === 'dev') return [
    iosSection(DEV_TOOLS.map(tool => iosRow(tool.title, { sub: tool.sub, onSelect: () => pushPage(tool.title, tool.build) })), {
      header: '도구',
      footer: '도구를 고르면 하위 페이지에서 실행합니다. 개발자 도구는 이 목록에 하나씩 추가합니다.',
    }),
  ];
  const devRows = [iosSwitch('개발자 모드', '개발자 도구 메뉴를 엽니다', prefs.devMode, on => {
    prefs.devMode = on;
    savePrefs();
    document.querySelector('[data-set="dev"]').hidden = !on;
    applyDevMode(on);
    if (!on && setTab === 'dev') setTab = 'about';
    renderSetDetail();
  })];
  if (prefs.devMode) devRows.push(iosRow('개발자 도구', { sub: '배너 크롭 등 개발자 모드 기능', onSelect: () => document.querySelector('[data-set="dev"]').click() }));
  return [
    iosSection([iosRow('버전', { value: 'MOLU 0.1.0' }), iosRow('데이터 형식', { value: 'schema v1' })], { header: '앱 정보' }),
    iosSection(devRows, { header: '개발자', footer: '블루 아카이브 비공식 팬메이드 캘린더입니다. NEXON / NEXON Games와 무관합니다.' }),
  ];
}
function renderSetDetail(animation) {
  const page = setPath.at(-1);
  const title = page ? page.title : SET_TITLES[setTab];
  $('#set-detail-title').textContent = title;
  $('#set-compact-title').textContent = title;
  // 뒤로가기 라벨: 루트는 목록('설정'), 하위 페이지는 바로 위 화면 제목.
  $('#set-back-label').textContent = !setPath.length ? '설정' : setPath.length > 1 ? setPath.at(-2).title : SET_TITLES[setTab];
  $('#app-settings').dataset.stack = setPath.length ? 'page' : 'root';
  const rows = !page
    ? setCategorySections()
    : page.build ? page.build()
    : [iosSection(page.options.map(([value, label]) => iosRow(label, {
        check: page.current() === value,
        chevron: false,
        onSelect: () => { page.onPick(value); popSetPage(); },
      })), { footer: page.footer })];
  $('#set-body').replaceChildren(...rows);
  if (animation !== 'pop') $('#set-scroll').scrollTop = 0;
  if (animation) playSetAnimation(animation);
  if (typeof renderBacklinks === 'function') renderBacklinks();
}
// 개발자 도구: 도구 하나를 추가하면 개발자 페이지 메뉴와 하위 페이지가 함께 생긴다.
const DEV_TOOLS = [
  { title: '배너 크롭', sub: '배너별 2:1 크롭 영역과 파일 목록', build: cropToolSections },
  { title: '모모톡 프롬프트', sub: '마지막 입력의 참고 자료·문자 예산 요약', build: momoTraceSections },
];
// 개발자용: 어떤 자료가 선택/제외됐는지 요약만 본다. 전체 대화 본문은 여기에도 남기지 않는다.
function momoTraceSections() {
  const trace = momoPromptTrace;
  if (!trace) return [iosSection([], { header: '모모톡 프롬프트', footer: '아직 로컬 AI로 모모톡 답변을 만들지 않았습니다. 모모톡 로컬 AI를 켜고 한 번 대화한 뒤 다시 열어 주세요.' })];
  const rows = [
    iosRow('방', { value: `${trace.roomId} · ${new Date(trace.at).toLocaleTimeString('ko-KR')}` }),
    iosRow('문자 예산', { value: `${trace.promptChars} / ${trace.budget}자${trace.fits ? '' : ' · 초과'}` }),
    iosRow('카드·예시', { value: `${trace.fixedChars}자` }),
    iosRow('최근 왕복', { value: `${trace.historyTurns}턴 · ${trace.historyChars}자 (제외 ${trace.droppedTurns}턴)` }),
    iosRow('참고 자료', { value: `기억 ${trace.memories.length} · 발췌 ${trace.excerpts.length} · ${trace.referenceChars}자` }),
    iosRow('Worker 확인', { value: trace.worker ? `프롬프트 ${trace.worker.promptChars}자 · 기억 ${trace.worker.memories} · 발췌 ${trace.worker.excerpts}` : '기록 없음' }),
  ];
  const entries = [
    ...trace.memories.map(memory => `기억 · ${memory.text}`),
    ...trace.excerpts.map(excerpt => `발췌 · ${excerpt.text}`),
  ].map(text => node('p', 'ios-section-footer', text));
  return [
    iosSection(rows, { header: '마지막 모델 입력', footer: '문자 수는 토큰 수가 아닙니다. 한국어 실측에서 1.25자/토큰을 가정한 보수적 예산입니다.' }),
    entries.length ? iosSection(entries, { header: '선택된 참고 자료' }) : iosSection([], { header: '선택된 참고 자료', footer: '선택된 기억·발췌가 없습니다.' }),
  ];
}
function cropToolSections() {
  return [
    iosSection([iosRow('배너 크롭 전체 초기화', {
      danger: true,
      chevron: false,
      onSelect: () => {
        if (!confirm('조정한 배너 크롭을 모두 중앙으로 되돌릴까요?')) return;
        if (!saveCrops({})) { alert('크롭 설정을 저장하지 못했습니다.'); return; }
        renderSetDetail();
      },
    })], { header: '초기화', footer: '이미지를 누르면 원본 위에서 2:1 크롭 영역을 설정할 수 있습니다. 저장한 위치는 이 브라우저의 상세 화면·추천 배너에 함께 적용됩니다.' }),
    cropLabRows(),
  ];
}
// 배너 크롭 작업 페이지: 일정에 쓰이는 배너 파일을 파일당 한 줄로 나열한다.
function cropLabRows() {
  const byFile = new Map();
  for (const event of state.events) for (const [lang, file] of Object.entries(event.images ?? {})) {
    if (!byFile.has(file)) byFile.set(file, { event, langs: new Set() });
    byFile.get(file).langs.add(lang);
  }
  const card = node('div', 'ios-card');
  for (const [file, { event, langs }] of byFile) {
    const row = node('div', 'crop-row');
    const img = node('img', 'crop-thumb');
    img.src = `./resource/event_banner_img/${file}`;
    img.alt = event.title;
    img.loading = 'lazy';
    img.dataset.cropFile = file;
    attachCropEditor(img);
    const frame = bannerFrame(img);
    frame.tabIndex = 0;
    frame.setAttribute('role', 'button');
    frame.setAttribute('aria-label', `${event.title} 배너 크롭 편집`);
    frame.title = '클릭: 원본에서 크롭 영역 편집';
    const body = node('span', 'grow');
    body.append(node('span', 'crop-title', event ? event.title : '폴백 배너'), node('span', 'crop-file', file));
    const meta = node('span', 'crop-meta');
    meta.append(node('span', 'crop-pos', cropLabel(crops[file])));
    meta.querySelector('.crop-pos').dataset.cropLabel = file;
    if (langs.size) meta.append(node('span', 'crop-langs', [...langs].join(' / ')));
    body.append(meta);
    const edit = node('button', 'crop-reset', '편집');
    edit.type = 'button';
    edit.addEventListener('click', () => openCropEditor(file));
    row.append(frame, body, edit);
    card.append(row);
  }
  const section = node('div', 'ios-section');
  section.append(node('h4', 'ios-section-title', '배너 파일'), card);
  return section;
}
document.querySelectorAll('.set-nav').forEach(button => button.addEventListener('click', () => {
  setTab = button.dataset.set;
  setPath = [];
  document.querySelectorAll('.set-nav').forEach(other => other.setAttribute('aria-current', String(other === button)));
  $('#app-settings').dataset.pane = 'detail';
  // 사이드바 선택은 분할 레이아웃에서 애니메이션을 쓰지 않는다. 한 열에서만 밀어 올린다.
  renderSetDetail(SET_SINGLE_COLUMN.matches ? 'push' : undefined);
  saveScreen();
}));
document.querySelector('[data-set-back]').addEventListener('click', () => {
  if (setPath.length) { popSetPage(); return; }
  $('#app-settings').dataset.pane = 'side';
});
document.querySelector('[data-set="dev"]').hidden = !prefs.devMode;
// 스크롤하면 내비게이션 바에 압축 제목과 구분선이 나타난다(iOS 대형 타이틀).
document.querySelectorAll('#app-settings .ios-scroll').forEach(pane => {
  pane.addEventListener('scroll', () => pane.classList.toggle('scrolled', pane.scrollTop > 0), { passive: true });
});
function updateDockDate() {
  const now = new Date();
  $('#dock-weekday').textContent = ['일', '월', '화', '수', '목', '금', '토'][now.getDay()];
  $('#dock-day').textContent = String(now.getDate());
}
const MOMO_KEY = 'molu.momotalk.v1';
const MOMO_UNREAD_KEY = 'molu.momotalk.unread.v1';
const momoTime = () => { const now = new Date(); return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`; };
// Schale assistants are built-in contacts, separate from the student profile database.
const MOMO_ASSISTANT_IDS = ['Arona', 'Prana'];
const MOMO_NARROW = matchMedia('(max-width:960px)');
const CONTACTS = {
  Arona: { id: 'Arona', img: 'Arona.webp', name: '아로나', short: '아로나', school: '샬레', year: '', club: '', status: '선생님을 기다리고 있어요!' },
  Prana: { id: 'Prana', img: 'Prana.webp', name: '프라나', short: '프라나', school: '샬레', year: '', club: '', status: '선생님을 지원하겠습니다.' },
};
const ARONA_GREETING = '선생님! 샬레 관제탑의 아로나예요. 일정이 궁금하면 "오늘 일정 알려줘"라고 말해보세요!';
const PRANA_GREETING = '선생님, 프라나입니다. 필요한 일이 있으면 말씀해 주세요.';
let STUDENT_LIST = Object.values(CONTACTS);
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
let momoUnread = {};
try {
  const storedUnread = JSON.parse(localStorage.getItem(MOMO_UNREAD_KEY) ?? '{}');
  if (storedUnread && typeof storedUnread === 'object') momoUnread = storedUnread;
} catch { momoUnread = {}; }
let activeRoom = 'Arona';
let momoAIJob = null;
let momoMode = aiSession.momoEnabled;
let momoScriptEpoch = 0;
const momoUsesAI = roomId => aiSession.momoEnabled && momoSupportsAI(roomId);
// MomoTalk 알림음 (bluearchive.wiki SE, tools/vendor_momotalk.py)
const momoAudio = new Audio('./resource/momotalk/ui/SE_MomoTalk_01.wav');
momoAudio.volume = .5;
function momoChime() {
  if (!prefs.momoSound) return;
  momoAudio.currentTime = 0;
  momoAudio.play().catch(() => { /* 재생이 막혀도 대화는 계속된다 */ });
}
function persistUnread() { try { localStorage.setItem(MOMO_UNREAD_KEY, JSON.stringify(momoUnread)); } catch { /* 저장 실패해도 세션 내 동작 유지 */ } }

// ── 대화 저장소: IndexedDB 원문 + 메모리 창. localStorage는 더 이상 대화를 자르지 않는다. ──
let momo = null;               // ChatTranscript; null until the store opens (or when it failed)
let momoError = null;          // { message, retry } banner between the header and the messages
let momoUnsaved = new Map();   // roomId -> view records the store refused; retried from the banner
let momoLoadToken = 0;         // invalidates room loads started before the last navigation
const momoTabId = crypto.randomUUID();
const momoChannel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('molu-momotalk') : null;
const momoClaims = new Map();  // roomId -> { tabId, until }: advisory, never a lock
const MOMO_CLAIM_MS = 90_000;
const momoMessages = roomId => momo?.cached(roomId)?.messages ?? [];
const momoLog = roomId => [...momoMessages(roomId), ...(momoUnsaved.get(roomId) ?? [])];
function setMomoError(message, retry) { momoError = message ? { message, retry } : null; }
let momoEpoch = 0;   // 이 값이 바뀌면 진행 중이던 생성 결과를 저장하지 않는다 (전체 삭제·가져오기·저장소 재연결)

// 첫 인사는 앱이 만든 메시지다. 사용자가 기록을 지운 뒤에도 새 대화는 다시 인사로 시작한다.
async function seedMomoGreetings() {
  if (!momo) return;
  await momo.seed([
    { roomId: 'Arona', speakerType: 'character', text: ARONA_GREETING, sourceKind: 'app' },
    { roomId: 'Prana', speakerType: 'character', text: PRANA_GREETING, sourceKind: 'app' },
  ]);
}
let momoLegacySeen;   // 이관 시점에 확인한 원본 snapshot (다른 탭 변경 감지용)
// 저장소를 열고 기존 localStorage 원문을 snapshot으로 이관한다. 원문 자체는 지우지 않는다.
async function openMomoStorage() {
  if (momo) { try { momo.close(); } catch { /* 이미 닫힌 연결 */ } momo = null; }
  let legacyRaw;
  try { legacyRaw = localStorage.getItem(MOMO_KEY) ?? undefined; } catch { legacyRaw = undefined; }
  momoLegacySeen = legacyRaw ?? null;
  let opened;
  try {
    opened = await ChatTranscript.open({ legacyRaw, onBlocked: () => setMomoError('다른 탭이 대화 저장소를 갱신하는 중입니다. 그 탭을 닫은 뒤 다시 시도해 주세요.', retryMomoStorage) });
    momo = opened;
    await seedMomoGreetings();
    await opened.refreshSummaries();
  } catch (error) {
    momo = null;
    try { opened?.close(); } catch { /* 열지 못한 연결 */ }
    setMomoError(`대화 저장소를 열지 못했습니다: ${error.message}`, retryMomoStorage);
    return false;
  }
  momoEpoch++;
  const report = opened.migrationReport;
  setMomoError(report?.rejected
    ? `기존 대화 ${report.imported}건을 옮겼고 ${report.rejected}건은 형식 문제로 옮기지 않았습니다. 원본은 브라우저에 그대로 남아 있습니다.`
    : null, null);
  return true;
}
// 다른 탭과 같은 방을 동시에 생성하지 않도록 알리는 신호. 잠금이 아니라 감지·거부다.
async function claimMomoRoom(roomId) {
  const claim = momoClaims.get(roomId);
  if (claim && claim.tabId !== momoTabId && claim.until > Date.now()) {
    setMomoError('다른 탭에서 같은 대화방의 답변을 만들고 있습니다. 그 작업이 끝난 뒤 다시 시도해 주세요.', null);
    renderMomo();
    return false;
  }
  const until = Date.now() + MOMO_CLAIM_MS;
  momoClaims.set(roomId, { tabId: momoTabId, until });
  momoChannel?.postMessage({ type: 'claim', roomId, tabId: momoTabId, until });
  return true;
}
function releaseMomoClaim(job) {
  const claim = momoClaims.get(job.roomId);
  if (claim?.tabId === momoTabId) momoClaims.delete(job.roomId);
  momoChannel?.postMessage({ type: 'release', roomId: job.roomId, tabId: momoTabId });
}
// 다른 탭의 변경을 반영한다. 같은 방을 보고 있으면 페이지도 다시 읽는다.
async function refreshMomoFromStore(roomId) {
  if (!momo) return;
  try {
    await momo.refreshSummaries();
    if (activeScreen === 'momotalk' && activeRoom === roomId) await momo.load(activeRoom);
  } catch { return; }
  if (activeScreen === 'momotalk') renderMomo();
  renderMomoList();
}
momoChannel?.addEventListener('message', event => {
  const data = event.data;
  if (!data || typeof data !== 'object' || data.tabId === momoTabId) return;
  if (data.type === 'claim' && typeof data.roomId === 'string' && Number.isFinite(data.until)) {
    momoClaims.set(data.roomId, { tabId: data.tabId, until: data.until });
    if (momoAIJob && !momoAIJob.cancelled && momoAIJob.roomId === data.roomId) {
      cancelMomoAI('다른 탭이 이 대화방의 답변을 만들고 있어 이 작업을 취소했습니다.');
      renderMomo();
    }
    return;
  }
  if (data.type === 'release') { momoClaims.delete(data.roomId); return; }
  if (data.type === 'deleted') {
    momoEpoch++;
    if (momoAIJob && !momoAIJob.cancelled && (data.roomId === null || momoAIJob.roomId === data.roomId)) {
      cancelMomoAI('다른 탭에서 대화 기록을 삭제해 이 작업을 취소했습니다.');
    }
    if (data.roomId === activeRoom) delete momoUnread[data.roomId];
  }
  if (data.type === 'appended' || data.type === 'deleted') void refreshMomoFromStore(data.roomId);
});
async function deleteMomoRoom(roomId) {
  if (!momo) return false;
  await momo.deleteRoom(roomId);
  momoEpoch++;
  momoUnsaved.delete(roomId);
  delete momoUnread[roomId];
  persistUnread();
  if (momoAIJob && momoAIJob.roomId === roomId) cancelMomoAI('대화 기록 삭제로 작업을 취소했습니다.');
  momoChannel?.postMessage({ type: 'deleted', roomId, tabId: momoTabId });
  return true;
}
async function deleteAllMomo() {
  if (momo) { await momo.deleteAll(); await seedMomoGreetings(); await momo.refreshSummaries(); }
  momoEpoch++;
  momoUnsaved = new Map();
  momoUnread = {};
  persistUnread();
  for (const key of [MOMO_KEY, MOMO_UNREAD_KEY]) { try { localStorage.removeItem(key); } catch { /* 저장 실패해도 삭제는 계속 */ } }
  momoChannel?.postMessage({ type: 'deleted', roomId: null, tabId: momoTabId });
}
// 전체 초기화: IndexedDB 삭제가 성공한 뒤에만 새로고침한다.
async function deleteMomoDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CHAT_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('대화 저장소를 삭제하지 못했습니다.'));
    request.onblocked = () => reject(new Error('다른 탭이 대화 저장소를 사용 중입니다. 모모톡 탭을 닫고 다시 시도해 주세요.'));
  });
}
async function resetAppData() {
  if (!confirm('브라우저에 저장된 일정·북마크·대화를 모두 지울까요?')) return;
  try {
    if (momo) { momo.close(); momo = null; }
    await deleteMomoDatabase();
    Object.keys(localStorage).filter(key => key.startsWith('molu.')).forEach(key => localStorage.removeItem(key));
  } catch (error) { alert(`삭제하지 못했습니다: ${error.message}`); return; }
  location.reload();
}
// 다른 탭/이전 버전이 원문을 바꾸면 자동 병합하지 않고 알린다.
addEventListener('storage', event => {
  if (event.key !== MOMO_KEY || event.newValue === momoLegacySeen) return;
  momoLegacySeen = event.newValue;
  setMomoError('다른 탭이나 이전 버전이 모모톡 원문을 바꿨습니다. 이미 이관한 기록과 자동으로 합치지 않습니다(원문은 브라우저에 남아 있습니다).', null);
  if (activeScreen === 'momotalk') renderMomo();
});
$('#momo-store-retry').addEventListener('click', () => { void retryMomoStorage(); });
$('#momo-store-export').addEventListener('click', () => { void downloadMomoBundle(); });
// 설정 화면은 이 객체만 받는다: 로컬 AI 모듈이 저장소 내부를 직접 알 필요가 없다.
const momoAdmin = {
  exportBundle: () => downloadMomoBundle(),
  async importBundle(raw) {
    if (!momo) throw new Error('대화 저장소를 사용할 수 없습니다.');
    if (!confirm('백업 파일의 기록을 가져올까요? 지금 있는 대화 기록은 백업 내용으로 대체됩니다.')) return false;
    momoEpoch++;
    const result = await momo.importBundle(raw, { replace: true });
    await seedMomoGreetings();
    await momo.refreshSummaries();
    if (activeScreen === 'momotalk') await momo.load(activeRoom);
    renderMomo();
    renderMomoList();
    return result;
  },
  async deleteAll() {
    await deleteAllMomo();
    if (momo) await momo.load(activeRoom);
    renderMomo();
    renderMomoList();
  },
};

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
  STUDENT_LIST = [CONTACTS.Arona, CONTACTS.Prana, ...list.filter(student => !MOMO_ASSISTANT_IDS.includes(student.id))];
  for (const student of STUDENT_LIST) CONTACTS[student.id] = student;
  renderStudentList();
  renderMomoList();
  if (activeScreen === 'momotalk') renderMomo();
}).catch(() => { /* 로컬 DB 없으면 샬레 도우미 연락처만 유지 */ });
function momoRow(me, text, time, student, typing = false, compact = false, unsaved = false) {
  const row = node('div', `momo-row${me ? ' me' : ''}${compact ? ' compact' : ''}${unsaved ? ' unsaved' : ''}`);
  const bubble = typing ? node('div', 'momo-bubble momo-typing') : node('div', 'momo-bubble', text);
  if (typing) bubble.append(node('i'), node('i'), node('i'));
  const timeEl = node('span', 'momo-time', unsaved ? '저장 안 됨' : time);
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
// 저장 실패는 숨기지 않는다: 화면에만 있는 메시지와 재시도·내보내기를 배너로 안내한다.
function renderMomoStoreStatus() {
  const bar = $('#momo-store-status');
  if (!bar) return;
  const unsaved = [...momoUnsaved.values()].reduce((sum, list) => sum + list.length, 0);
  bar.hidden = !momoError && !unsaved;
  if (bar.hidden) return;
  $('#momo-store-text').textContent = momoError?.message ?? `저장하지 못한 메시지 ${unsaved}건이 화면에만 있습니다.`;
  $('#momo-store-retry').hidden = !(momoError?.retry || unsaved);
  $('#momo-store-export').hidden = !momo;
}
function renderMomo() {
  const student = momoStudent(activeRoom);
  fillAvatar($('#momo-peer-avatar'), student);
  $('#app-momotalk-title').textContent = student.short;
  $('#momo-peer-sub').textContent = student.status || '온라인';
  $('#momo-peer-org').textContent = [student.school, student.club].filter(Boolean).join(' · ');
  renderMomoStoreStatus();
  const box = $('#momo-messages');
  const cache = momo?.cached(activeRoom) ?? null;
  const messages = momoLog(activeRoom);
  const rows = [];
  if (!cache) rows.push(node('p', 'chat-empty', momo ? '대화를 불러오는 중…' : momoError ? '대화 저장소를 사용할 수 없어 기록을 표시하지 못했습니다.' : '대화 기록을 준비하는 중…'));
  else if (!messages.length) rows.push(node('p', 'chat-empty', '아직 대화가 없어요. 먼저 인사를 건네 보세요.'));
  if (cache?.hasMore) {
    const more = node('button', 'momo-more', '이전 대화 불러오기');
    more.type = 'button';
    more.addEventListener('click', () => void loadOlderMomo(activeRoom));
    rows.push(more);
  }
  rows.push(...messages.map((message, i) => {
    const prev = messages[i - 1];
    const row = momoRow(message.me, message.text, message.time, student, false, !message.me && !!prev && !prev.me, message.status === 'unsaved');
    if (message.status !== 'unsaved') row.dataset.id = message.id;
    return row;
  }));
  box.replaceChildren(...rows);
  box.scrollTop = box.scrollHeight;
  box.setAttribute('aria-label', `${student.short}와의 대화`);
  $('#momo-profile').hidden = true;
  renderMomoReplies();
  if (momoAIJob?.row && momoAIJob.roomId === activeRoom && !momoAIJob.cancelled) box.append(momoAIJob.row);
  renderMomoAIControls();
}
// 이전 페이지를 붙일 때는 보던 위치를 유지한다.
async function loadOlderMomo(roomId) {
  if (!momo) return;
  const box = $('#momo-messages');
  const keep = box.scrollHeight - box.scrollTop;
  try { await momo.loadOlder(roomId); }
  catch (error) { alert(`이전 대화를 불러오지 못했습니다: ${error.message}`); return; }
  if (activeScreen === 'momotalk' && activeRoom === roomId) { renderMomo(); box.scrollTop = box.scrollHeight - keep; }
}
function momoEvents(day, label) {
  const scope = state.server === 'all' ? '' : ` ${SERVERS[state.server].short}`;
  const hits = sorted(serverEvents()).filter(event => overlaps(event, day, addDays(day, 1)));
  if (!hits.length) return `${label}${scope} 일정은 비어 있어요. 푹 쉬어도 되는 날이네요!`;
  const lines = hits.slice(0, 4).map(event => `· ${event.title} (${timeLabel(event, day)})`);
  return `${label}${scope} 일정은 ${hits.length}건이에요!\n${lines.join('\n')}${hits.length > 4 ? `\n외 ${hits.length - 4}건` : ''}`;
}
function renderMomoList() {
  const box = $('#momo-chats');
  const summaries = momo?.summaries() ?? [];
  const ids = summaries.map(summary => summary.roomId).filter(id => momoTab === 'all' || momoUnread[id]);
  if (!ids.length) {
    box.replaceChildren(node('p', 'chat-empty', momoTab === 'unread' ? '읽지 않은 대화가 없어요.' : '아직 대화가 없어요.\n왼쪽 친구 탭에서 학생을 골라 대화를 시작해 보세요.'));
    syncMomoTabs();
    syncMomoPane();
    return;
  }
  box.replaceChildren(...ids.map(id => {
    const student = momoStudent(id);
    const last = momoLog(id).at(-1) ?? momo.summary(id).last;
    const row = node('button', 'chat-row');
    row.type = 'button';
    // 인게임처럼 NEW 표시는 아바타 좌상단 뱃지, 행 오른쪽은 학교 칩 (시각 없음).
    const avatar = momoAvatar(student);
    if (momoUnread[id]) avatar.append(node('span', 'chat-unread', momoUnread[id] > 99 ? '99+' : String(momoUnread[id])));
    const meta = node('span', 'chat-meta');
    meta.append(node('span', 'chat-name', student.short), node('span', 'chat-preview', `${momoSupportsAI(id) ? '' : '읽기 전용 · '}${last.text}`));
    row.append(avatar, meta);
    row.setAttribute('aria-label', `${student.short}와의 대화${momoSupportsAI(id) ? '' : ', 읽기 전용'}${momoUnread[id] ? `, 읽지 않은 메시지 ${momoUnread[id]}건` : ''}`);
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
    const supported = momoSupportsAI(student.id);
    const row = node('div', `chat-row${student.id === momoFriendId ? ' selected' : ''}`);
    const main = node('button', 'chat-row-main');
    main.type = 'button';
    main.disabled = !supported && MOMO_NARROW.matches;
    const meta = node('span', 'chat-meta');
    meta.append(node('span', 'chat-name', student.short));
    meta.append(node('span', 'chat-status', student.status || [student.year, student.club].filter(Boolean).join(' · ')));
    main.append(momoAvatar(student), meta);
    main.setAttribute('aria-label', `${student.name} · ${student.school || '기타'}`);
    main.addEventListener('click', () => {
      // 좁은 화면에선 탭 즉시 대화, 넓은 화면에선 우측 미리보기 선택 (인게임 동작).
      if (MOMO_NARROW.matches) { openRoom(student.id); return; }
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
  const supported = momoSupportsAI(student.id);
  const chat = node('button', 'momo-friend-chat', '대화 시작');
  chat.type = 'button';
  chat.disabled = !supported;
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
  $('#momo-memory-query').value = '';
  void renderMomoMemories(activeRoom);
  $('#momo-profile').hidden = false;
  $('#momo-profile-close').focus();
}
function momoExpiryLabel(memory) {
  if (memory.expiresAt === null) return '만료 없음';
  const days = Math.max(0, Math.round((memory.expiresAt - Date.now()) / 86_400_000));
  return days ? `${days}일 뒤 만료` : '만료됨';
}
// 명시적 기억: 사용자가 확인한 문장만 저장한다. 모델 답변이 자동으로 기억이 되지는 않는다.
async function renderMomoMemories(roomId, highlightId = null) {
  const list = $('#momo-memory-list');
  if (!list) return;
  if (!momo) { list.replaceChildren(node('li', 'momo-memory-empty', '대화 저장소를 사용할 수 없습니다.')); return; }
  let memories;
  try { memories = await momo.memories(roomId); }
  catch (error) { list.replaceChildren(node('li', 'momo-memory-empty', `기억을 읽지 못했습니다: ${error.message}`)); return; }
  if (roomId !== activeRoom) return;
  const query = $('#momo-memory-query').value.trim();
  const shown = filterMemories(memories, query);
  if (!shown.length) {
    list.replaceChildren(node('li', 'momo-memory-empty', memories.length ? '검색과 맞는 기억이 없습니다.' : '저장한 기억이 아직 없습니다. 메시지를 길게 누르면 기억으로 만들 수 있어요.'));
    return;
  }
  list.replaceChildren(...shown.map(memory => momoMemoryRow(roomId, memory, highlightId)));
}
function momoMemoryRow(roomId, memory, highlightId) {
  const row = node('li', `momo-memory-row${memory.id === highlightId ? ' highlight' : ''}${memory.enabled ? '' : ' off'}`);
  const body = node('p', 'momo-memory-text', memory.text);
  const meta = node('p', 'momo-memory-meta', `${memory.enabled ? '사용 중' : '사용 중지'} · 이 방에서만 · ${momoExpiryLabel(memory)}${memory.sourceMessageId ? ' · 메시지에서' : ''}`);
  const actions = node('div', 'momo-memory-actions');
  const action = (label, handler) => { const button = node('button', '', label); button.type = 'button'; button.addEventListener('click', handler); actions.append(button); };
  action('수정', () => {
    const form = node('form', 'momo-memory-edit');
    const input = node('input', '');
    input.type = 'text';
    input.maxLength = 500;
    input.value = memory.text;
    input.setAttribute('aria-label', '기억 수정');
    const save = node('button', '', '저장'); save.type = 'submit';
    const cancel = node('button', '', '취소'); cancel.type = 'button';
    cancel.addEventListener('click', () => void renderMomoMemories(roomId, memory.id));
    form.append(input, save, cancel);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void (async () => {
        try { await momo.updateMemory(memory.id, { text: input.value.trim() }); }
        catch (error) { alert(`기억을 저장하지 못했습니다: ${error.message}`); return; }
        renderMomoMemories(roomId, memory.id);
      })();
    });
    row.replaceChildren(form);
    input.focus();
  });
  action(memory.enabled ? '사용 중지' : '다시 사용', () => {
    void (async () => {
      try { await momo.updateMemory(memory.id, { enabled: !memory.enabled }); }
      catch (error) { alert(`기억을 바꾸지 못했습니다: ${error.message}`); return; }
      renderMomoMemories(roomId, memory.id);
    })();
  });
  action(memory.expiresAt === null ? '만료 없음' : '만료 유지', () => {
    const daysLeft = memory.expiresAt === null ? null : Math.round((memory.expiresAt - Date.now()) / 86_400_000);
    const days = daysLeft === null ? 7 : daysLeft <= 15 ? 30 : null;
    const expiresAt = days === null ? null : Date.now() + days * 86_400_000;
    void (async () => {
      try { await momo.updateMemory(memory.id, { expiresAt }); }
      catch (error) { alert(`만료를 바꾸지 못했습니다: ${error.message}`); return; }
      renderMomoMemories(roomId, memory.id);
    })();
  });
  action('삭제', () => {
    if (!confirm('이 기억을 삭제할까요? 원문 대화는 남습니다.')) return;
    void (async () => {
      try { await momo.deleteMemory(memory.id); }
      catch (error) { alert(`기억을 삭제하지 못했습니다: ${error.message}`); return; }
      renderMomoMemories(roomId);
    })();
  });
  row.append(body, meta, actions);
  return row;
}
$('#momo-memory-add').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#momo-memory-input');
  const text = input.value.trim();
  if (!text || !momo) return;
  void (async () => {
    try { await momo.saveMemory({ roomId: activeRoom, text }); }
    catch (error) { alert(`기억을 저장하지 못했습니다: ${error.message}`); return; }
    input.value = '';
    void renderMomoMemories(activeRoom);
  })();
});
$('#momo-memory-query').addEventListener('input', () => { void renderMomoMemories(activeRoom); });
// 메시지 길게 누르기/오른쪽 클릭 → 기억하기. 기억은 저장된 메시지에서만 만든다.
let momoMenuTarget = null;
let momoPressTimer = null;
let momoPressPoint = null;
function openMomoMessageMenu(message, x, y) {
  if (!message?.id || message.status === 'unsaved' || !momo) return;
  momoMenuTarget = { roomId: activeRoom, message };
  const menu = $('#momo-message-menu');
  menu.hidden = false;
  menu.style.left = `${Math.min(x, innerWidth - 140)}px`;
  menu.style.top = `${Math.min(y, innerHeight - 90)}px`;
  $('#momo-message-save').focus();
}
function closeMomoMessageMenu() { momoMenuTarget = null; $('#momo-message-menu').hidden = true; }
$('#momo-message-cancel').addEventListener('click', closeMomoMessageMenu);
$('#momo-message-save').addEventListener('click', () => {
  const target = momoMenuTarget;
  closeMomoMessageMenu();
  if (!target) return;
  void (async () => {
    let saved;
    try { saved = await momo.saveMemory(memoryDraftFromMessage({ ...target.message, roomId: target.roomId })); }
    catch (error) { alert(`기억으로 저장하지 못했습니다: ${error.message}`); return; }
    openProfile();
    void renderMomoMemories(target.roomId, saved.id);
  })();
});
function momoMessageFromRow(row) {
  if (!row?.dataset.id) return null;
  return momoLog(activeRoom).find(message => message.id === row.dataset.id) ?? null;
}
$('#momo-messages').addEventListener('contextmenu', event => {
  const row = event.target.closest('.momo-row');
  const message = momoMessageFromRow(row);
  if (!message) return;
  event.preventDefault();
  openMomoMessageMenu(message, event.clientX, event.clientY);
});
$('#momo-messages').addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse') return;
  const row = event.target.closest('.momo-row');
  if (!row || row.classList.contains('unsaved')) return;
  momoPressPoint = [event.clientX, event.clientY];
  clearTimeout(momoPressTimer);
  momoPressTimer = setTimeout(() => {
    const message = momoMessageFromRow(row);
    if (message) openMomoMessageMenu(message, momoPressPoint[0], momoPressPoint[1]);
  }, 500);
});
$('#momo-messages').addEventListener('pointermove', event => {
  if (!momoPressPoint || !momoPressTimer) return;
  if (Math.abs(event.clientX - momoPressPoint[0]) > 10 || Math.abs(event.clientY - momoPressPoint[1]) > 10) {
    clearTimeout(momoPressTimer);
    momoPressTimer = null;
  }
});
$('#momo-messages').addEventListener('pointerup', () => { clearTimeout(momoPressTimer); momoPressTimer = null; });
$('#momo-messages').addEventListener('pointercancel', () => { clearTimeout(momoPressTimer); momoPressTimer = null; });
document.addEventListener('click', event => { if (!event.target.closest('#momo-message-menu')) closeMomoMessageMenu(); });
$('#momo-profile-open').addEventListener('click', openProfile);
$('#momo-profile-close').addEventListener('click', () => { $('#momo-profile').hidden = true; $('#momo-profile-open').focus(); });
$('#momo-profile-delete').addEventListener('click', () => {
  const roomId = activeRoom;
  const student = momoStudent(roomId);
  if (!momo) { alert('대화 저장소를 사용할 수 없어 삭제하지 못했습니다.'); return; }
  if (!confirm(`${student.short}와의 대화 기록을 이 브라우저에서 지울까요? 되돌릴 수 없습니다.`)) return;
  void (async () => {
    try {
      await deleteMomoRoom(roomId);
      if (momo) await momo.load(roomId);
    } catch (error) { alert(`삭제하지 못했습니다: ${error.message}`); return; }
    $('#momo-profile').hidden = true;
    if (activeScreen === 'momotalk') renderMomo();
    renderMomoList();
  })();
});
async function openRoom(id) {
  if (!momoSupportsAI(id) && !momo?.summary(id)) return;
  if (activeRoom !== id) cancelMomoAI('대화방 이동으로 로컬 AI 작업을 취소했습니다.');
  activeRoom = id;
  momoFriendId = id;
  momoUnread[id] = 0;
  persistUnread();
  showScreen('momotalk');
  const token = ++momoLoadToken;
  renderMomo();
  renderMomoList();
  if (!momo) return;
  try { await momo.load(id); }
  catch (error) { setMomoError(`대화를 불러오지 못했습니다: ${error.message}`, retryMomoStorage); renderMomo(); return; }
  if (token !== momoLoadToken || activeRoom !== id) return;
  await syncTopic(id);
  if (token !== momoLoadToken || activeRoom !== id) return;
  renderMomo();
  renderMomoList();
}
// 저장소에는 메시지 단위로만 쓴다. 실패하면 화면에 남겨 두고 배너에서 재시도한다.
async function appendMomo(roomId, { id = crypto.randomUUID(), speakerType, text, sourceKind, status = 'complete', createdAt } = {}) {
  const fallback = { id, me: speakerType === 'user', text, time: momoTime(), status: 'unsaved', speakerType, sourceKind, createdAt: null };
  if (!momo) { queueMomoUnsaved(roomId, fallback); return fallback; }
  try {
    const message = await momo.append(roomId, { id, speakerType, text, sourceKind, status, createdAt });
    momoChannel?.postMessage({ type: 'appended', roomId, id: message.id });
    return message;
  } catch (error) {
    if (error && error.name === 'ConstraintError') return fallback; // 같은 ID가 이미 저장됨(재시도 경합)
    queueMomoUnsaved(roomId, fallback);
    setMomoError('메시지를 저장하지 못했습니다. 화면에 남긴 뒤 재시도할 수 있습니다.', retryMomoStorage);
    return fallback;
  }
}
function queueMomoUnsaved(roomId, message) {
  const list = momoUnsaved.get(roomId) ?? [];
  if (!list.some(entry => entry.id === message.id)) list.push(message);
  momoUnsaved.set(roomId, list);
}
async function retryMomoStorage() {
  if (!momo) await openMomoStorage();
  const pending = [...momoUnsaved.entries()];
  momoUnsaved = new Map();
  let failed = 0;
  for (const [roomId, list] of pending) {
    for (const message of list) {
      try { await momo.append(roomId, { id: message.id, speakerType: message.speakerType, text: message.text, sourceKind: message.sourceKind }); }
      catch (error) { if (!error || error.name !== 'ConstraintError') { queueMomoUnsaved(roomId, message); failed++; } }
    }
  }
  setMomoError(failed ? '일부 메시지를 다시 저장하지 못했습니다.' : null, retryMomoStorage);
  if (activeScreen === 'momotalk') renderMomo();
  renderMomoList();
  renderMomoAIControls();
}
async function downloadMomoBundle() {
  try {
    if (!momo) throw new Error('대화 저장소가 준비되지 않았습니다.');
    const text = await momo.exportBundle();
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const anchor = node('a');
    anchor.href = url;
    anchor.download = `momotalk-backup-${dateKey()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch (error) { alert(`기록을 내보내지 못했습니다: ${error.message}`); return false; }
}
function momoStoreBlocked() { return !momo || momoUnsaved.size > 0; }
// 선생님 메시지 수가 곧 대화 진행도다. 저장된 방 카운터를 쓰므로 화면에 불러온 페이지 수와 무관하다.
function pendingTopic(roomId) {
  const topics = momoTopicsFor(roomId);
  return topics[(momo?.cached(roomId)?.userMessageCount ?? 0) % topics.length];
}
async function askTopic(roomId) {
  const topic = pendingTopic(roomId);
  if (topic) await appendMomo(roomId, { speakerType: 'character', text: topic.ask, sourceKind: 'script' });
}
async function syncTopic(roomId) {
  if (!momoSupportsAI(roomId) || momoUsesAI(roomId)) return;
  const last = momoLog(roomId).at(-1);
  if (!last || last.me || last.text !== pendingTopic(roomId)?.ask) await askTopic(roomId);
}
function resolveReply(reply) {
  if (reply === '@today') return momoEvents(today(), '오늘');
  if (reply === '@tomorrow') return momoEvents(addDays(today(), 1), '내일');
  return reply;
}
function renderMomoReplies() {
  const box = $('#momo-replies');
  if (!momoSupportsAI(activeRoom)) { box.replaceChildren(); box.hidden = true; return; }
  if (momoUsesAI(activeRoom)) {
    // 답변이 저장되지 않은 마지막 사용자 메시지는 같은 메시지 ID로 다시 생성한다.
    const target = momo?.cached(activeRoom) ? momo.retryTarget(activeRoom) : null;
    if (!target || !aiSession.ready || aiSession.busy || momoAIJob || momoStoreBlocked()) { box.replaceChildren(); box.hidden = true; return; }
    const retry = node('button', 'momo-reply-option momo-retry', '답변 다시 시도');
    retry.type = 'button';
    retry.addEventListener('click', () => { if (!momoAIJob) void generateMomoAI(target.text, target); });
    box.replaceChildren(retry);
    box.hidden = false;
    return;
  }
  const topic = pendingTopic(activeRoom);
  // 선택지는 학생이 말을 마친 뒤에만 노출한다 (선생님 답변 직후에는 숨김).
  const last = momoLog(activeRoom).at(-1);
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
  if (!momoSupportsAI(roomId) || momoUsesAI(roomId)) { done?.(); return; }
  const epoch = momoScriptEpoch;
  if (!text) { done?.(); return; }
  const last = momoLog(roomId).at(-1);
  const typing = momoRow(false, '', momoTime(), student, true, !!last && !last.me);
  const box = $('#momo-messages');
  if (activeScreen === 'momotalk' && activeRoom === roomId) { box.append(typing); box.scrollTop = box.scrollHeight; }
  setTimeout(async () => {
    typing.remove();
    if (epoch !== momoScriptEpoch || momoUsesAI(roomId)) return;
    await appendMomo(roomId, { speakerType: 'character', text, sourceKind: 'script' });
    momoChime();
    if (activeScreen === 'momotalk' && activeRoom === roomId) renderMomo();
    else { momoUnread[roomId] = (momoUnread[roomId] ?? 0) + 1; persistUnread(); }
    renderMomoList();
    done?.();
  }, 900);
}
function answerTopic(option) {
  if (!momoSupportsAI(activeRoom) || momoUsesAI(activeRoom)) return;
  const roomId = activeRoom;
  const student = momoStudent(roomId);
  void (async () => {
    await appendMomo(roomId, { speakerType: 'user', text: option.text, sourceKind: 'script' });
    renderMomo();
    renderMomoList();
    momoSay(roomId, student, resolveReply(option.reply), () => momoSay(roomId, student, pendingTopic(roomId)?.ask));
  })();
}
function renderMomoAIControls() {
  // 오류·취소는 상태 표시줄 없이 조용히 처리한다: 말풍선만 사라지고 입력은 다시 열린다.
  const enabled = momoUsesAI(activeRoom);
  const busy = aiSession.busy || !!momoAIJob;
  const readOnly = !momoSupportsAI(activeRoom);
  const needsSetup = enabled && !aiSession.ready;
  const blocked = momoStoreBlocked();
  $('#momo-ai-settings').hidden = !readOnly && !needsSetup && !blocked;
  $('#momo-ai-settings').disabled = readOnly;
  $('#momo-ai-settings').textContent = readOnly ? 'LLM 대화 미지원 · 기존 대화는 읽기만 가능합니다'
    : blocked ? '대화 저장소를 사용할 수 없습니다 · 아래 안내를 확인해 주세요'
    : '로컬 AI 모델을 설정해 주세요 · 설정으로 이동';
  $('#momo-input').hidden = readOnly || needsSetup || blocked;
  $('#momo-input').disabled = readOnly || blocked || (enabled && (busy || needsSetup));
  $('#momo-form .momo-send').hidden = readOnly || needsSetup || blocked;
  $('#momo-form .momo-send').disabled = readOnly || blocked || (enabled && (busy || needsSetup));
}
function currentMomoAI(job) {
  return momoAIJob === job && !job.cancelled && !document.hidden && activeScreen === 'momotalk' && activeRoom === job.roomId && momoUsesAI(job.roomId);
}
function cancelMomoAI(reason = '로컬 AI 작업을 취소했습니다.') {
  if (!momoAIJob) return;
  momoAIJob.cancelled = true;
  momoAIJob.row?.remove();
  void releaseMomoClaim(momoAIJob);
  aiSession.cancel('momotalk', errorWithCode('cancelled', reason));
}
async function runMomoAI(task) {
  if (aiSession.busy || momoAIJob || !momoUsesAI(activeRoom) || momoStoreBlocked()) return;
  if (!(await claimMomoRoom(activeRoom))) return;
  const job = { roomId: activeRoom, cancelled: false, momoEpoch };
  momoAIJob = job;
  renderMomoAIControls();
  try {
    await aiSession.run('momotalk', async client => {
      if (!currentMomoAI(job)) throw errorWithCode('cancelled', '대화 화면이 변경되었습니다.');
      await task(client, job);
    });
  } catch { /* 채팅 UX: 실패는 조용히. 내 메시지는 이미 남아 있다. */ } finally {
    void releaseMomoClaim(job);
    job.row?.remove();
    if (momoAIJob === job) momoAIJob = null;
    renderMomoAIControls();
    renderMomoReplies();
  }
}
// 개발자 도구가 보여 주는 마지막 프롬프트 조립 결과. 전체 대화가 아니라 선택·제외 요약만 담는다.
let momoPromptTrace = null;
async function momoModelInput(roomId, text, currentMessageId) {
  const fixed = promptCharsFor(roomId) ?? { system: 0, examples: 0 };
  let memories = [];
  try {
    memories = selectMemories(await momo.memories(roomId), { roomId, query: text, now: Date.now(), limit: MEMORY_LIMIT, charBudget: MEMORY_CHAR_BUDGET })
      .map(memory => ({ id: memory.id, text: memory.text }));
  } catch { memories = []; }
  let excerpts = [];
  try {
    const hits = await momo.searchRoom(roomId, { query: text, limit: EXCERPT_LIMITS.items + MOMO_HISTORY_TURNS * 2, extraPages: 2 });
    // 창에 이미 들어간 최근 메시지는 발췌에서 뺀다(같은 말이 두 번 들어가는 것을 막는다).
    const recent = momoLog(roomId).slice(-(MOMO_HISTORY_TURNS * 2 + 1)).map(entry => entry.id);
    excerpts = selectExcerpts(hits, { currentId: currentMessageId, recentIds: recent,
      itemChars: EXCERPT_LIMITS.itemChars, maxChars: EXCERPT_LIMITS.chars });
  } catch { excerpts = []; }
  const plan = momoPromptPlan({ history: momoLog(roomId).filter(entry => entry.id !== currentMessageId), text,
    fixedChars: fixed.system + fixed.examples, memories, excerpts });
  momoPromptTrace = { roomId, at: Date.now(), budget: PROMPT_CHAR_BUDGET, fixedChars: plan.fixedChars, historyChars: plan.historyChars,
    referenceChars: plan.referenceChars, promptChars: plan.promptChars, droppedTurns: plan.droppedTurns, fits: plan.fits,
    memories: plan.memories, excerpts: plan.excerpts, historyTurns: plan.messages.filter(message => message.role === 'assistant').length };
  return plan;
}
async function generateMomoAI(text, retry = null) {
  await runMomoAI(async (client, job) => {
    if (!aiSession.ready) throw new Error('설정에서 먼저 모델을 준비해 주세요.');
    if (!momo) throw new Error('대화 저장소가 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.');
    // 사용자 메시지는 생성 전에 저장한다. 같은 메시지를 다시 시도해도 새로 만들지 않는다.
    const message = retry ?? await appendMomo(job.roomId, { id: crypto.randomUUID(), speakerType: 'user', text, sourceKind: 'user-input' });
    const plan = await momoModelInput(job.roomId, text, message.id);
    job.row = momoRow(false, '', momoTime(), momoStudent(job.roomId), true);
    renderMomo(); renderMomoList();
    const box = $('#momo-messages');
    box.scrollTop = box.scrollHeight;
    const response = await client.request('generate', { messages: plan.messages, characterId: job.roomId, maxTokens: 128,
      memories: plan.memories, excerpts: plan.excerpts }, {
      timeoutMs: 60000,
      onEvent: event => {
        if (event.event === 'trace') { if (momoPromptTrace) momoPromptTrace.worker = event; return; }
        if (!currentMomoAI(job) || event.event !== 'token') return;
        const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        const bubble = job.row.querySelector('.momo-bubble');
        bubble.classList.remove('momo-typing');
        bubble.textContent = event.text;
        if (stick) box.scrollTop = box.scrollHeight;
      },
    });
    client.check();
    if (!currentMomoAI(job)) throw errorWithCode('cancelled', '대화 화면이 변경되어 답변을 저장하지 않았습니다.');
    // 방이 삭제·초기화됐거나 다른 탭이 먼저 답했다면 늦은 답변을 저장하지 않는다.
    if (job.momoEpoch !== momoEpoch || !momo.cached(job.roomId)) throw errorWithCode('cancelled', '대화 기록이 삭제되어 답변을 저장하지 않았습니다.');
    await appendMomo(job.roomId, { id: crypto.randomUUID(), speakerType: 'character', text: response.text, sourceKind: 'model-output' });
    job.row.remove(); job.row = null;
    renderMomo(); renderMomoList(); momoChime();
  });
}
$('#momo-ai-settings').addEventListener('click', () => {
  if (!momoSupportsAI(activeRoom)) return;
  openMomoSettings();
});
function openMomoSettings() {
  enterApp('settings');
  document.querySelector('[data-set="ai"]').click();
  $('#set-detail-title').focus({ preventScroll: true });
}
$('#momo-side-settings')?.addEventListener('click', openMomoSettings);
document.querySelectorAll('[data-app-back]').forEach(button => button.addEventListener('click', goBackApp));
aiSession.addEventListener('change', () => {
  if (momoMode !== aiSession.momoEnabled) {
    momoMode = aiSession.momoEnabled;
    momoScriptEpoch++;
    cancelMomoAI('답변 방식 변경으로 로컬 AI 작업을 취소했습니다.');
    if (activeScreen === 'momotalk') { syncTopic(activeRoom); renderMomo(); }
  }
  renderMomoAIControls();
});
// Other rooms keep the existing choice/search-based conversation flow.
$('#momo-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('#momo-input');
  const text = input.value.trim();
  if (!text) return;
  const roomId = activeRoom;
  const student = momoStudent(roomId);
  if (!momoSupportsAI(roomId) || momoStoreBlocked()) return;
  if (momoUsesAI(roomId)) {
    if (!aiSession.ready) { renderMomoAIControls(); $('#momo-ai-settings').focus(); return; }
    if (aiSession.busy || momoAIJob) return;
    const query = momoCalendarQuery(text);
    input.value = '';
    if (query) {
      void (async () => {
        await appendMomo(roomId, { speakerType: 'user', text, sourceKind: 'user-input' });
        await appendMomo(roomId, { speakerType: 'character', text: resolveReply(query), sourceKind: 'app' });
        renderMomo(); renderMomoList(); momoChime();
      })();
    } else void generateMomoAI(text);
    return;
  }
  input.value = '';
  void (async () => {
    await appendMomo(roomId, { speakerType: 'user', text, sourceKind: 'script' });
    renderMomo();
    renderMomoList();
    momoSay(roomId, student, resolveReply(momoReply(text, student)), () => momoSay(roomId, student, pendingTopic(roomId)?.ask));
  })();
});
document.querySelector('[data-momo-back]').addEventListener('click', () => showScreen('momo-list'));
$('#momo-search').addEventListener('input', event => {
  studentQuery = normalize(event.target.value.trim());
  renderStudentList();
});
MOMO_NARROW.addEventListener('change', renderStudentList);
renderMomo();
renderMomoList();

function makeEventCard(event) {
  const button = eventColor(node('button', 'day-event-card'), event);
  button.type = 'button';
  const body = node('span', 'event-card-body');
  const meta = node('span', 'event-card-meta', `${serverTag(event)} · ${CATEGORIES[event.category].label}`);
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
  const servers = [['all', '전체'], ...Object.entries(SERVERS).map(([key, server]) => [key, server.label])].map(([key, label]) => {
    const button = node('button', 'filter-chip');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(state.server === key));
    button.append(document.createTextNode(label));
    button.setAttribute('aria-label', `서버: ${label}`);
    button.addEventListener('click', () => setServer(key));
    return button;
  });
  $('#servers').replaceChildren(...servers);
}
function spanLabel(event) {
  return event.status === 'cancelled' ? `[취소] ${event.title}` : event.status === 'postponed' ? `[연기] ${event.title}` : event.title;
}

// 바 오른쪽 끝(종료일)에 붙는 라벨. 셀 칩과 같은 규칙: 자정 종료는 24:00으로 표기한다.
function endLabel(event, endDay) {
  if (event.all_day) return '종일';
  if (!event.end) return '종료 미정';
  return `${dateKey(event.end) > endDay ? '24:00' : clockLabel(event.end)} 종료`;
}

function bindEventButton(button, event) {
  button.type = 'button';
  button.title = `${event.title} · ${rangeLabel(event)} · ${STATUSES[event.status]}`;
  button.addEventListener('click', () => onEventClick(event));
  return button;
}

let spanSegs = [];

// Measure day cells and pin each week-row segment bar over the cells it spans.
function placeSpanBars() {
  const grid = $('#calendar-grid');
  const cells = grid.querySelectorAll(':scope > .day');
  if (!cells.length || !cells[0].offsetWidth) return; // 뷰가 숨겨진 동안은 재배치하지 않는다.
  const number = cells[0].querySelector('.day-number');
  const chipTop = cells[0].offsetTop + number.offsetTop + number.offsetHeight + 4;
  for (const seg of spanSegs) {
    const a = cells[seg.indices[0]];
    const b = cells[seg.indices[seg.indices.length - 1]];
    const bar = seg.bar;
    const left = a.offsetLeft + (seg.startPos - seg.indices[0]) * a.offsetWidth;
    const right = b.offsetLeft + (seg.endPos - seg.indices[seg.indices.length - 1]) * b.offsetWidth;
    bar.style.left = `${left}px`;
    bar.style.width = `${right - left}px`;
    bar.style.top = `${a.offsetTop + chipTop - cells[0].offsetTop + seg.lane * 21}px`;
  }
}

// Multi-day events become continuous bars across their cells (lanes per week row),
// so the title renders once at full width instead of a chip per day.
function renderSpanBars(days, entries, layer) {
  const visible = entries
    .map(entry => ({ ...entry, indices: days.flatMap((day, index) => entry.first <= day && day <= entry.last ? [index] : []) }))
    .filter(entry => entry.indices.length > 1);
  const rows = new Map();
  for (const entry of visible) {
    const { event } = entry;
    const firstIdx = entry.indices[0];
    const lastIdx = entry.indices[entry.indices.length - 1];
    // 종료·시작 시각을 하루 너비의 비율로 반영한다: 같은 날에 종료하고 시작하는 두 일정은 lane을 나눠 쓴다.
    // 진짜 시작·종료일이 그리드에 보일 때만 안쪽으로 당긴다(가장자리에서 잘린 바는 전체 폭 유지).
    const startFrac = !event.all_day && event.start && days[firstIdx] === entry.first ? timeFrac(clockLabel(event.start)) : 0;
    const endFrac = !event.all_day && event.end && days[lastIdx] === entry.last ? (dateKey(event.end) > entry.last ? 1 : timeFrac(clockLabel(event.end))) : 1;
    for (const indices of segments(entry.indices)) {
      const row = Math.floor(indices[0] / 7);
      (rows.get(row) ?? rows.set(row, []).get(row)).push({
        event,
        indices,
        endDay: entry.last,
        startPos: indices[0] + (indices[0] === firstIdx ? startFrac : 0),
        endPos: indices[indices.length - 1] + (indices[indices.length - 1] === lastIdx ? endFrac : 1),
        lane: 0,
      });
    }
  }
  const laneCount = new Map();
  spanSegs = [];
  for (const [row, segs] of rows) {
    laneCount.set(row, assignLanes(segs));
    spanSegs.push(...segs);
  }
  for (const seg of spanSegs) {
    const bar = eventColor(node('button', `day-event span-bar ${seg.event.status}`), seg.event);
    bar.append(node('span', 'event-name', spanLabel(seg.event)));
    if (days[seg.indices[seg.indices.length - 1]] === seg.endDay) bar.append(node('span', 'span-end', endLabel(seg.event, seg.endDay)));
    bindEventButton(bar, seg.event);
    bar.setAttribute('aria-label', `${days[seg.indices[0]]} ~ ${days[seg.indices[seg.indices.length - 1]]} ${bar.title}`);
    seg.bar = bar;
    layer.append(bar);
  }
  return laneCount;
}

function renderCalendar() {
  const [year, month] = state.month.split('-');
  $('#month-heading').replaceChildren(document.createTextNode(`${year}. `), node('span', '', month));
  $('#prev-month').disabled = state.month <= '1900-01';
  $('#next-month').disabled = state.month >= '2199-12';
  const events = sorted(filteredEvents());
  // ponytail: scan at most 1,000 events across 42 cells; add a date index only if this cap grows.
  const entries = events.map(event => ({ event, ...span(event) }));
  const days = displayDays(state.month);
  const layer = node('div', 'span-layer');
  const laneCount = renderSpanBars(days, entries, layer);
  const fragment = document.createDocumentFragment();
  const singles = new Map();
  for (const entry of entries) {
    let count = 0; let only = 0;
    days.forEach((day, index) => { if (entry.first <= day && day <= entry.last) { count++; only = index; } });
    if (count === 1) (singles.get(only) ?? singles.set(only, []).get(only)).push(entry);
  }
  for (let index = 0; index < days.length; index++) {
    const day = days[index];
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
    const here = singles.get(index) ?? [];
    if (laneCount.get(Math.floor(index / 7))) {
      const spacer = node('span', 'lane-spacer');
      spacer.style.height = `${laneCount.get(Math.floor(index / 7)) * 21}px`;
      cell.append(spacer);
    }
    here.slice(0, 3).forEach(({ event }) => {
      const button = eventColor(node('button', `day-event ${event.status}`), event);
      const clock = node('span', 'event-clock');
      const [from, to] = timeLabel(event, day).split('–');
      clock.append(node('span', '', from));
      if (to) clock.append(node('span', 'time-end', `–${to}`));
      button.append(clock, node('span', 'event-name', spanLabel(event)));
      bindEventButton(button, event);
      button.setAttribute('aria-label', `${day} ${button.title}`);
      cell.append(button);
    });
    if (here.length > 3) {
      const more = node('button', 'more-events', `+${here.length - 3}개 더 보기`);
      more.addEventListener('click', () => {
        selectDay(day);
        $('.briefing').scrollIntoView({ block: 'nearest', behavior: 'auto' });
        $('#day-events button')?.focus();
      });
      cell.append(more);
    }
    fragment.append(cell);
  }
  const grid = $('#calendar-grid');
  grid.replaceChildren(fragment, layer);
  placeSpanBars();
  const monthEvents = events.filter(event => overlaps(event, `${state.month}-01`, `${shiftMonth(state.month, 1)}-01`));
  renderAgenda(monthEvents);
}
window.addEventListener('resize', () => requestAnimationFrame(placeSpanBars));
function renderAgenda(events) {
  const list = $('#agenda');
  list.replaceChildren();
  if (!events.length) {
    list.append(node('p', 'empty-list', '이 달에는 표시할 일정이 없어요.\n다른 서버·분류를 선택하거나 JSON을 가져와 주세요.'));
    return;
  }
  events.forEach(event => {
    const row = eventColor(node('button', 'agenda-row'), event);
    const body = node('span', 'event-card-body');
    const meta = node('span', 'event-card-meta', `${serverTag(event)} · ${CATEGORIES[event.category].label} · ${STATUSES[event.status]}`);
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
    empty.append(node('span', 'empty-orbit'), node('strong', '', '잠깐, 쉬어 가도 괜찮아요.'), node('p', '', state.filter === 'all' && state.server === 'all' ? '이 날짜에는 등록된 일정이 없어요.' : '선택한 서버·분류의 일정이 없어요.'));
    container.append(empty);
  }
}
function renderFeatured(events = bannerEvents(serverEvents())) {
  const index = events.length ? state.featureRot % events.length : 0;
  const event = events[index];
  const image = $('#memo-banner');
  $('#banner-next').hidden = events.length < 2;
  showBanner(image, event);
  if (!event) state.featureShown = null;
  if (event) {
    const rotated = state.featureShown && state.featureShown !== event.id;
    image.alt = event.title;
    state.featureShown = event.id;
    if (rotated && !reducedMotion.matches) {
      const frame = bannerFrame(image);
      frame.getAnimations().forEach(animation => animation.cancel());
      frame.animate([
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
  if (!prefs.bannerAuto || document.hidden || document.querySelector('dialog[open]') || bannerFrame($('#memo-banner')).matches(':hover, :focus-within')) return;
  state.featureRot += 1;
  renderFeatured();
}, 6000);
function render() {
  $('#calendar-view').hidden = state.view !== 'month';
  $('#agenda').hidden = state.view !== 'list';
  renderFilters();
  renderCalendar();
  renderBriefing();
  renderMetrics();
  updateDockDate();
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
  $('#json-input').value = JSON.stringify(builtin, null, 2);
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
    const existing = state.builtin ? [] : state.events;
    const updates = incoming.filter(event => existing.some(old => old.id === event.id)).length;
    const merged = mergeEvents(existing, incoming);
    persist(merged); // Commit browser storage before changing the visible calendar.
    state.events = merged;
    state.builtin = false;
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
  document.documentElement.classList.add('trail-drag'); // 드래그 중 텍스트 선택 방지
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
  document.documentElement.classList.remove('trail-drag');
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
// 저장된 선택은 유지하고 첫 접속에서만 IP 국가를 조회한다. IP는 저장하지 않는다.
if (!languageChosen) {
  fetch('https://api.country.is/', { signal: AbortSignal.timeout(4000), credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then(response => { if (!response.ok) throw new Error('국가 조회 실패'); return response.json(); })
    .then(data => {
      if (languageChosen) return;
      prefs.lang = countryLanguage(data?.country, prefs.lang);
    })
    .catch(() => { /* 조회 실패 시 브라우저 언어 유지 */ })
    .finally(() => {
      if (languageChosen) return;
      languageChosen = true;
      savePrefs();
      render();
      if (activeScreen === 'settings') renderSetDetail();
      const event = state.events.find(event => event.id === state.detailId);
      if (event && $('#event-dialog').open) showBanner($('#event-banner'), event);
    });
}
// 새로고침해도 있던 화면 유지: 저장된 화면이 캘린더가 아니면 복원한다.
let pendingMomoRoom = null;
try {
  const savedScreen = JSON.parse(localStorage.getItem(SCREEN_KEY) ?? 'null');
  const screens = ['calendar', 'home', 'settings', 'momo-list', 'momotalk'];
  if (savedScreen && screens.includes(savedScreen.screen) && savedScreen.screen !== 'calendar') {
    if (savedScreen.screen === 'momotalk') {
      // 방의 존재 여부는 저장소를 연 뒤에 판단한다.
      if (typeof savedScreen.room === 'string' && savedScreen.room) pendingMomoRoom = savedScreen.room;
      else savedScreen.screen = 'momo-list';
    }
    if (savedScreen.screen === 'settings' && Object.hasOwn(SET_TITLES, savedScreen.tab)) {
      setTab = savedScreen.tab;
      document.querySelectorAll('.set-nav').forEach(other => other.setAttribute('aria-current', String(other.dataset.set === setTab)));
    }
    showScreen(savedScreen.screen);
    if (savedScreen.screen === 'settings') $('#app-settings').dataset.pane = 'detail';
  }
} catch { /* 저장 실패해도 캘린더 기본값 유지 */ }
// 저장소가 준비된 뒤에 대화방을 읽는다. 준비 전에는 화면에 안내만 표시한다.
void openMomoStorage().then(ready => {
  renderMomoList();
  renderMomoAIControls();
  if (!ready) { if (activeScreen === 'momotalk') renderMomo(); return; }
  if (activeScreen !== 'momotalk') return;
  const room = pendingMomoRoom ?? activeRoom;
  if (momoSupportsAI(room) || momo.summary(room)) void openRoom(room);
  else { showScreen('momo-list'); renderMomoList(); }
});
setInterval(updateClock, 1000);
setInterval(renderMetrics, 60_000);

