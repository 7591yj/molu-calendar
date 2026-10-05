import { MODELS, LEGACY_GEMMA2, DEFAULT_MODEL_ID, CHARACTERS, characterById, ENGINE_NAMES, ENGINE_GUIDANCE, BENCHMARK, MODEL_OVERHEAD_BYTES, modelCardURL, modelById, gb, inspectEnvironment, benchmarkModels, recommendModel, summarizeSamples, describeError, modelConsentText } from './local-ai.js';
import { localAISession as session } from './local-ai-session.js';
const LABELS = { comfortable: '쾌적', usable: '사용 가능 · 첫 응답 느림', slow: '응답 기준 미달', invalid: '측정 불충분', unsupported: '실행 환경 비호환', error: '실행 오류', cancelled: '측정 취소' };
// 대화 DB는 수 MB 단위일 수 있으므로 GB 고정 표기 대신 단위를 바꾼다.
const bytes = value => {
  if (!Number.isFinite(value)) return '확인 불가';
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};
let panel;

export function localAISettings({ row, section, element, toggle, choose = () => {}, page = (title, build) => build(), momo = null }) {
  if (panel) return panel;
  let client; // Valid only inside a session lease.
  const saved = session.settings;
  const state = {
    characterId: characterById(saved?.characterId)?.id ?? CHARACTERS[0].id,
    modelId: saved?.catalogVersion === BENCHMARK.version ? modelById(saved?.modelId)?.id ?? DEFAULT_MODEL_ID : DEFAULT_MODEL_ID,
    results: Array.isArray(saved?.results) ? saved.results.filter(result => result && modelById(result.modelId) && result.version === BENCHMARK.version)
      .map(result => result.samples?.length === BENCHMARK.samples ? { ...result, ...summarizeSamples(result.samples) } : result) : [],
    fingerprint: typeof saved?.fingerprint === 'string' ? saved.fingerprint : '',
    env: null, busy: false, checking: false, cache: {}, chat: [], status: '기기 환경을 확인하고 있습니다.',
  };
  const model = () => modelById(state.modelId);
  const runtime = () => state.env?.engines?.[model().engine] ?? { supported: false, reason: state.env?.reason };
  const runtimeStatus = () => runtime().supported ? `${ENGINE_NAMES[model().engine]} 기본 조건 확인 · 모델 로드와 실제 생성으로 호환성을 확인해 주세요.` : runtime().reason;
  const unsupported = reason => {
    if (state.env) state.env.engines[model().engine] = { supported: false, reason };
  };
  const familyModels = () => MODELS.filter(candidate => candidate.family === model().family);
  const stale = () => state.results.length > 0 && state.fingerprint !== state.env?.fingerprint;
  const save = () => {
    if (!session.save({ modelId: state.modelId, characterId: state.characterId, results: state.results, fingerprint: state.fingerprint })) persistence.textContent = '설정·측정 결과를 저장하지 못했습니다. 현재 탭에서만 유지됩니다.';
  };
  panel = element('div', 'local-ai-settings');
  const envRows = {};
  const envRow = (key, label) => {
    const item = row(label, { value: '확인 중' });
    envRows[key] = item.querySelector('.ios-value');
    return item;
  };
  const status = element('p', 'ai-status visually-hidden', state.status);
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const detail = element('p', 'ai-detail');
  const progressWrap = element('div', 'ai-progress-wrap');
  const progress = element('div', 'ai-progress');
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', '모델 다운로드·준비 진행률');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  progress.setAttribute('aria-valuenow', '0');
  const progressFill = element('div', 'ai-progress-fill');
  progress.append(progressFill);
  progressWrap.hidden = true;
  const progressText = element('span', 'ai-progress-text', '');
  progressWrap.append(progress, progressText);
  const persistence = element('p', 'ios-section-footer');
  const controls = [];
  const button = (label, handler, danger = false) => {
    const item = row(label, { onSelect: handler, chevron: false, danger });
    controls.push(item);
    return item;
  };
  const action = (label, handler, kind = '') => {
    const item = element('button', `ai-action${kind ? ` ${kind}` : ''}`, label);
    item.type = 'button';
    item.addEventListener('click', handler);
    return item;
  };
  const applyModel = id => { if (state.busy || state.checking || session.busy || !modelById(id)) return; state.modelId = id; state.status = runtimeStatus(); save(); render(); };
  const modelChoiceRow = row('모델', { value: modelById(state.modelId)?.name ?? model().name, onSelect: () => choose('모델', MODELS.map(candidate => [candidate.id, candidate.name]), () => state.modelId, applyModel) });
  const modelInfo = element('p', 'ios-section-footer');
  const source = element('a', '', '모델 카드·이용 조건 확인');
  source.target = '_blank';
  source.rel = 'noopener noreferrer';
  const sourceLine = element('p', 'ios-section-footer');
  sourceLine.append(source);
  const loadedRow = row('현재 메모리에 로드된 모델', { value: '없음' });
  const cachedRow = row('선택 모델의 캐시 파일', { value: '확인 중' });
  const cachedSizeRow = row('선택 모델 캐시 용량', { value: '확인 중' });
  const runtimeCacheRow = row('공유 실행 파일 (WASM·설정)', { value: '확인 중' });
  const cacheCounts = () => state.cache?.counts ?? {};
  const cacheBytes = id => state.cache?.bytes?.[id];
  const setValue = (target, text) => { target.querySelector('.ios-value').textContent = text; };
  const results = element('div', 'ai-results');
  const output = element('pre', 'ai-output', '메시지는 미리 작성할 수 있습니다. 다운로드·로드 후 보내기를 눌러 대화해 보세요.');
  output.setAttribute('aria-label', '로컬 AI 테스트 답변');
  output.tabIndex = 0;
  const form = document.createElement('form');
  form.className = 'ai-chat-form';
  const input = document.createElement('textarea');
  input.id = 'ai-prompt';
  input.rows = 2;
  input.maxLength = 800;
  input.placeholder = '메시지를 입력하세요 (최대 800자)';
  input.setAttribute('aria-label', '테스트 메시지');
  const send = element('button', 'ai-send', '로컬 모델로 보내기');
  send.type = 'submit';
  form.append(input, send);
  const applyCharacter = id => {
    if (state.busy || state.checking || session.busy || !characterById(id)) return;
    state.characterId = id;
    state.chat = [];
    output.textContent = '';
    chatStats.textContent = '';
    state.status = `${characterById(state.characterId).name}로 전환했습니다. 이전 대화 문맥을 지웠습니다.`;
    save(); render();
  };
  const characterChoiceRow = row('테스트 캐릭터', { value: characterById(state.characterId)?.name ?? characterById(CHARACTERS[0].id).name, onSelect: () => choose('테스트 캐릭터', CHARACTERS.map(character => [character.id, character.name]), () => state.characterId, applyCharacter) });
  const chatStats = element('p', 'ios-section-footer');
  const loadButton = action('다운로드·로드', () => run(async () => {
    if (!consent([model()])) return;
    client.stop();
    state.chat = [];
    output.textContent = '';
    state.status = `${model().name} 다운로드·로드 중`;
    render();
    const result = await client.request('load', { modelId: state.modelId }, {
      timeoutMs: 15 * 60 * 1000,
      onEvent: event => { showProgress(event); },
    });
    state.status = `${model().name} 준비 완료 · 다운로드 포함 ${(result.loadMs / 1000).toFixed(1)}초`;
    await refreshCache();
  }), 'ai-action-primary');
  const unloadButton = button('GPU 메모리 해제', () => run(async () => {
    client.stop();
    state.chat = [];
    state.status = '모델 메모리를 해제했습니다. 다운로드한 캐시는 유지됩니다.';
    render();
  }));
  const deleteCaches = handler => () => run(async () => {
    if (globalThis.aiTest?.cache) {
      state.cache = await handler(async params => {
        const result = await client.request('delete', params);
        globalThis.aiTest.cache = JSON.parse(JSON.stringify(result));
        return result;
      });
    } else {
      const { deleteModelCaches } = await import('./local-ai.js');
      state.cache = await handler(deleteModelCaches);
    }
    await refreshStorage();
  });
  const deleteWeightsButton = button('선택 모델 가중치 삭제', deleteCaches(async remove => {
    if (!confirm(`${model().name}의 가중치 파일을 삭제할까요? 실행 파일·대화·측정 결과는 유지됩니다.`)) return state.cache;
    if (session.loaded === state.modelId) { session.client.stop(); state.chat = []; }
    state.status = '선택한 모델의 가중치 파일을 삭제했습니다.';
    return remove({ modelId: state.modelId, scope: 'weights' });
  }), true);
  const deleteRuntimeButton = button('공유 실행 파일 삭제', deleteCaches(async remove => {
    if (!confirm('WASM·설정 등 공유 실행 파일을 삭제할까요? 다음 로드 시 다시 받습니다. 모델 가중치는 유지됩니다.')) return state.cache;
    state.status = '공유 실행 파일을 삭제했습니다.';
    return remove({ scope: 'runtime' });
  }), true);
  const legacyDeleteButton = button('이전 Gemma 2 다운로드 삭제', deleteCaches(async remove => {
    if (!confirm('이전에 받은 Gemma 2 파일을 삭제할까요? 현재 모델과 대화는 유지됩니다.')) return state.cache;
    state.status = '이전 Gemma 2 캐시 파일을 삭제했습니다.';
    return remove({ modelId: LEGACY_GEMMA2.id });
  }), true);
  const benchButton = action('작은 모델부터 성능 측정·추천', () => run(async () => {
    const candidates = familyModels();
    if (!consent(candidates)) return;
    state.chat = [];
    output.textContent = '';
    state.results = stale() ? [] : state.results.filter(result => !candidates.some(candidate => candidate.id === result.modelId));
    state.fingerprint = state.env.fingerprint;
    save();
    await benchmarkModels(client, candidates, update => {
      const prefix = update.model.name;
      if (update.phase === 'loading') state.status = `${prefix} 다운로드·로드 중 (성능 판정 제외)`;
      if (update.phase === 'warming') state.status = `${prefix} 최초 준비 중 (성능 판정 제외)`;
      if (update.phase === 'measuring') state.status = `${prefix} 측정 ${update.sample}/${BENCHMARK.samples}`;
      if (update.event === 'token') output.textContent = update.text;
      if (update.phase === 'result') {
        if (update.result.status === 'unsupported') unsupported(update.result.reason);
        state.results.push(update.result);
        save();
        renderResults();
      }
      showProgress(update);
    });
    const winner = recommendModel(state.results, model().family);
    if (winner) { state.modelId = winner.id; save(); }
    state.status = !runtime().supported ? runtime().reason : winner ? `측정 종료 · ${winner.name}을 권장 후보로 선택했습니다. 다운로드·로드를 눌러 대화해 보세요.` : '측정 종료 · 이번 측정에서 응답 기준을 통과한 모델이 없습니다. 결과의 오류 원인을 확인해 주세요.';
    await refreshCache();
  }), 'ai-action-primary');
  const cancelButton = action('진행 중인 작업 취소', () => session.cancel('settings'), 'ai-action-destructive');
  const detectButton = button('기기 환경·저장 공간 다시 확인', () => detect());
  const clearButton = button('측정 결과 초기화', () => {
    if (!confirm('로컬 AI 측정 결과를 지울까요? 모델 다운로드는 유지됩니다.')) return;
    state.results = [];
    state.fingerprint = '';
    save(); render();
  }, true);
  const clearChatButton = button('테스트 대화 지우기', () => {
    state.chat = [];
    output.textContent = '';
    chatStats.textContent = '';
  });
  const clearMomoButton = button('모모톡 대화 기록 삭제', () => run(async () => {
    if (!momo) return;
    if (!confirm('모모톡 대화 기록을 모두 지울까요? 첫 인사만 남고 설정·측정 결과·모델 다운로드는 유지됩니다.')) return;
    await momo.deleteAll();
    state.status = '모모톡 대화 기록을 삭제했습니다.';
    await refreshTranscriptStorage();
    render();
  }), true);
  const exportMomoButton = button('모모톡 기록 내보내기 (JSON)', () => run(async () => {
    if (!momo) return;
    const done = await momo.exportBundle();
    if (done) state.status = '모모톡 기록을 JSON 파일로 내보냈습니다.';
    render();
  }));
  const importMomoFile = element('input', 'visually-hidden');
  importMomoFile.type = 'file';
  importMomoFile.accept = 'application/json,.json';
  importMomoFile.setAttribute('aria-label', '모모톡 기록 백업 파일');
  importMomoFile.addEventListener('change', () => {
    const file = importMomoFile.files?.[0];
    importMomoFile.value = '';
    if (!file) return;
    void run(async () => {
      if (!momo) return;
      if (file.size > 32 * 1024 * 1024) throw new Error('백업 파일이 너무 큽니다.');
      const raw = await file.text();
      const result = await momo.importBundle(raw);
      if (result) state.status = `백업에서 방 ${result.rooms}개·메시지 ${result.messages}건을 가져왔습니다.`;
      await refreshTranscriptStorage();
      render();
    });
  });
  const importMomoButton = button('모모톡 기록 가져오기 (JSON)', () => importMomoFile.click());
  // ── 대화 저장소: 사용량 추정·보존 요청 (P5) ──
  const storageUsageRow = row('대화 저장소 사용량 (추정)', { value: '확인 중' });
  const storagePersistRow = row('브라우저 보존 상태', { value: '확인 중' });
  const refreshTranscriptStorage = async () => {
    let estimate = null;
    try { estimate = await navigator.storage?.estimate?.(); } catch { /* 선택 API */ }
    setValue(storageUsageRow, estimate
      ? `${bytes(estimate.usage)} / ${bytes(estimate.quota)} · origin 전체 추정`
      : '이 브라우저에서 확인할 수 없습니다.');
    let persisted = null;
    try { persisted = await navigator.storage?.persisted?.(); } catch { /* 선택 API */ }
    setValue(storagePersistRow, persisted === null ? '확인할 수 없습니다.' : persisted ? '보존 허용됨' : '보존 미허용');
  };
  const persistButton = button('대화 저장소 보존 요청', () => {
    if (state.persisting) return;
    // persist()는 브라우저가 사용자에게 물어볼 수 있고, 그동안 응답이 없다. 진행 중임을 먼저 보여 준다.
    void (async () => {
      state.persisting = true;
      state.status = '저장소 보존을 요청했습니다. 브라우저가 허용 여부를 물어볼 수 있습니다.';
      render();
      try {
        if (typeof navigator.storage?.persist !== 'function') {
          state.status = '이 브라우저는 저장소 보존 요청을 지원하지 않습니다. JSON 내보내기로 백업해 주세요.';
          return;
        }
        let granted = false;
        try { granted = await navigator.storage.persist(); } catch { granted = false; }
        state.status = granted
          ? '브라우저가 보존을 허용했습니다. 그래도 사이트 데이터 삭제·비공개 모드 종료로 지워질 수 있으니 JSON 백업을 유지하세요.'
          : '브라우저가 보존을 허용하지 않았습니다(정책·사용자 설정에 따름). JSON 내보내기로 백업해 주세요.';
      } finally {
        state.persisting = false;
        await refreshTranscriptStorage();
        render();
      }
    })();
  });
  const clearAppDataButton = button('일정·북마크 등 앱 데이터 삭제', () => {
    if (!confirm('일정·북마크·크롭·화면 등 앱 데이터를 지울까요? AI 설정·측정 결과·모델 다운로드는 유지됩니다.')) return;
    try {
      for (const key of ['molu.calendar.v1', 'molu.bookmarks.v1', 'molu.prefs.v1', 'molu.banner-crop.v1', 'molu.screen.v1', 'molu.momo.fav.v1']) localStorage.removeItem(key);
    } catch { /* 저장 실패해도 화면은 유지 */ }
    state.status = '앱 데이터를 삭제했습니다. 새로고침하면 기본 일정으로 돌아갑니다.';
    render();
  }, true);

  const momoToggle = toggle('모모톡 로컬 AI', '페르소나가 등록된 캐릭터와 선택한 모델로 대화', session.momoEnabled, value => {
    if (session.busy) return;
    if (!session.save({ momoEnabled: value })) persistence.textContent = '선택을 저장하지 못했습니다. 현재 탭에서만 유지됩니다.';
  });
  controls.push(momoToggle);
  const modelStatusRow = row('실행 상태', { value: state.status });
  const benchmarkStatusRow = row('측정 상태', { value: state.status });
  const openChat = () => page('테스트 대화', buildChatSections);
  const chatEntryRow = () => { const entry = row('테스트 대화', { value: characterById(state.characterId)?.name ?? '', onSelect: openChat }); entry.classList.add('ai-chat-entry'); return entry; };
  const modelActionGroup = element('div', 'ai-actions');
  modelActionGroup.append(loadButton);
  const benchmarkActionGroup = element('div', 'ai-actions');
  benchmarkActionGroup.append(benchButton, cancelButton);
  const modelSection = section([modelChoiceRow, loadedRow, cachedRow, cachedSizeRow, runtimeCacheRow, modelStatusRow, unloadButton, deleteWeightsButton, deleteRuntimeButton, legacyDeleteButton], { header: '모델 관리' });
  const benchmarkSection = section([benchmarkStatusRow], { header: '성능 측정', footer: '같은 계열에서 작은 모델부터 하나씩 실행합니다. 최초 준비 후 같은 한국어 대화로 3회 측정하며, 첫 답변 3초 이내는 쾌적, 5초 이내·5 tok/s 이상은 통과입니다. 첫 답변 5초 초과 또는 생성 30초 초과는 응답 기준 미달입니다. 다운로드·초기화·네트워크 오류와 사양 부족은 구분합니다. 기준 미달·오류 이후 큰 모델은 미측정으로 남깁니다.' });
  const benchmarkResultSection = section([clearButton], { footer: '결과는 이 브라우저에만 저장됩니다. 권장은 실행 적합성이지 한국어·캐릭터 대화 품질 보장이 아닙니다. 다른 계열의 tok/s는 토큰 분할이 달라 직접 비교하기 어렵습니다.' });
  function buildChatSections() {
    return [
      section([characterChoiceRow], { header: '테스트 대화', footer: '선택한 캐릭터의 시스템 프롬프트로 답합니다. 캐릭터 전환 시 이전 대화 문맥은 초기화되며, 성능 측정에는 캐릭터 프롬프트를 쓰지 않습니다. 메시지는 모델 로드 전에도 작성할 수 있으며, 전송하려면 다운로드·로드가 필요합니다. 최근 2번의 대화만 문맥으로 사용합니다. 테스트 내용은 서버에 보내거나 영구 저장하지 않습니다. 추론 모드는 끄고 최대 128토큰까지 생성합니다.' }),
      form, output, chatStats, section([clearChatButton]), persistence,
    ];
  }
  panel.append(
    status,
    section([momoToggle], { footer: '실험 기능 · 설정 테스트와 모모톡은 모델 하나를 공유하며 동시에 생성하지 않습니다. 켜면 등록된 캐릭터에 적용합니다. 미지원 학생은 새 대화를 시작할 수 없으며 기존 기록은 읽기만 가능합니다. CPU 실행·LoRA·임의 모델 가져오기는 아직 지원하지 않습니다.' }),
    section([
      envRow('browser', '브라우저'), envRow('webgpu', 'GPU 실행 지원'), envRow('gpu', '브라우저가 제공한 GPU'),
      envRow('buffers', '셰이더당 저장 버퍼 한도'),
      envRow('vram', 'GPU 메모리 (VRAM)'), envRow('ram', '시스템 RAM (대략)'), envRow('cores', '논리 프로세서'),
      envRow('storage', '브라우저 저장 여유 (추정)'), envRow('webllm', 'WebLLM 실행 조건'), envRow('litert', 'LiteRT-LM 실행 조건'), detectButton,
    ], { header: '기기 환경', footer: 'GPU 메모리 실측 API는 없습니다. 실행 가능성은 셰이더 한도·실제 로드·생성으로 판단합니다. RAM은 반올림·상한 제한된 값일 수 있고, 저장 공간은 VRAM이 아닙니다. 다른 GPU 프로그램과 탭을 닫고 전원을 연결한 상태에서 측정해 주세요.' }),
    modelSection,
    modelInfo, sourceLine,
    modelActionGroup,
    benchmarkSection,
    benchmarkActionGroup,
    progressWrap, detail, results,
    benchmarkResultSection,
    section([chatEntryRow()], { header: '테스트 대화', footer: '모델·캐릭터를 고른 뒤 별도 화면에서 대화합니다.' }),
    section([exportMomoButton, importMomoButton, importMomoFile, clearMomoButton, clearAppDataButton], { header: '데이터 정리', footer: '각 항목은 독립적으로 삭제됩니다. 모모톡 백업은 방·메시지 원문과 형식·중복·순서를 검증한 뒤에만 가져오며, 기록이 남아 있으면 자동으로 덮어쓰지 않습니다. 모델 가중치는 위 모델 관리에서 지우세요. 전체 초기화는 데이터 탭에서 할 수 있습니다.' }),
    section([storageUsageRow, storagePersistRow, persistButton], { header: '대화 저장소', footer: '사용량은 이 브라우저 origin 전체의 추정치이며 대화 DB만의 크기가 아닙니다. 보존 허용은 요청일 뿐이고 사용자가 사이트 데이터를 지우면 함께 삭제됩니다. 비공개 모드에서는 창을 닫을 때 사라질 수 있고, 개발 서버 포트가 바뀌면 다른 origin이라 이전 기록이 보이지 않습니다. 백업은 위 내보내기를 사용하세요.' }),
    section([], { footer: '최초 다운로드는 Hugging Face와 모델 라이브러리 호스팅 서버에 접속합니다(IP 등 접속 정보 전달). 대화·GPU 정보는 전송하지 않으며, 실패해도 클라우드 AI로 전환하지 않습니다. 탭을 숨기면 작업을 취소하고 실행 중 모델을 해제합니다. 캐시는 브라우저 정책에 의해 삭제될 수 있습니다.' }),
  );

  void refreshTranscriptStorage();

  function consent(candidates) {
    return confirm(modelConsentText(candidates, state.env?.storage));
  }
  let progressRatio = 0;
  function showProgress(event) {
    // 항상 왼쪽→오른쪽 determinate. 값 없는 이벤트는 마지막 값 유지 (불확정 애니메이션 금지).
    let value = Number(event.progress);
    if (!Number.isFinite(value)) value = progressRatio;
    // WebLLM 콜백이 0~100 스케일일 수 있어 1 초과는 100으로 나눈다.
    if (value > 1) value /= 100;
    progressRatio = Math.max(0, Math.min(1, value || 0));
    progressFill.style.width = `${(progressRatio * 100).toFixed(1)}%`;
    const visible = state.busy && event.phase !== 'measuring' && event.event !== 'token';
    progressWrap.hidden = !visible;
    progressWrap.classList.toggle('is-active', visible && progressRatio > 0 && progressRatio < 1);
    if (visible) {
      const percent = `${Math.round(progressRatio * 100)}%`;
      progressText.textContent = percent;
      progress.setAttribute('aria-valuenow', String(Math.round(progressRatio * 100)));
      progress.setAttribute('aria-valuetext', percent);
    }
    if (event.event === 'progress') detail.textContent = String(event.text ?? '').slice(0, 300);
    if (status.textContent !== state.status) status.textContent = state.status;
  }
  async function refreshStorage() {
    try { if (state.env) state.env.storage = await navigator.storage?.estimate(); } catch { /* optional */ }
  }
  const testCache = () => globalThis.aiTest?.cache ? JSON.parse(JSON.stringify(globalThis.aiTest.cache)) : null;
  async function refreshCache() {
    state.cache = testCache() ?? await (await import('./local-ai.js')).inspectModelCaches();
    await refreshStorage();
  }
  async function run(task) {
    if (state.busy || state.checking || session.busy) return;
    state.busy = true;
    detail.textContent = '';
    render();
    try { await session.run('settings', async scoped => { client = scoped; await task(); }); }
    catch (error) {
      state.chat = [];
      state.cache = {}; // A cancelled download may have left files since the last cache scan.
      const diagnosis = describeError(error);
      if (diagnosis.status === 'unsupported') unsupported(diagnosis.reason);
      state.status = diagnosis.reason;
      detail.textContent = ['cancelled', 'hidden'].includes(error.code) ? '중단된 샘플은 추천에 사용하지 않습니다. 부분 다운로드는 선택 모델 다운로드 삭제로 정리할 수 있습니다.' : '';
    } finally {
      client = null;
      state.busy = false;
      progressWrap.hidden = true;
      render();
    }
  }
  async function detect() {
    if (state.busy || state.checking) return;
    state.checking = true;
    render();
    try {
      const { inspectEnvironment } = await import('./local-ai.js');
      state.env = await inspectEnvironment();
      state.status = runtimeStatus();
      try { await refreshCache(); } catch { state.cache = {}; detail.textContent = '캐시 정보를 확인하지 못했습니다. 모델 로드 시 다시 확인합니다.'; }
    } catch (error) {
      state.status = `환경 확인 실패: ${String(error.message).slice(0, 160)}`;
    } finally { state.checking = false; render(); }
  }
  function recommendationText() {
    const isStale = stale();
    const winner = runtime().supported && !isStale && recommendModel(state.results, model().family);
    return state.env && !runtime().supported ? '현재 실행 환경에서는 이 엔진의 모델을 추천할 수 없습니다. 다른 엔진의 모델을 선택하거나 위의 호환성 안내를 확인해 주세요. 이미 받은 모델 캐시는 삭제할 수 있습니다.'
      : isStale ? '모델 목록·기기·브라우저 조건이 달라졌습니다. 저장된 결과는 참고용이며 다시 측정해야 추천할 수 있습니다.'
      : winner ? `권장 후보: ${winner.name} · 이 계열에서 응답 기준을 통과한 가장 큰 모델`
      : '아직 권장 모델이 없습니다. 성능 측정을 실행해 주세요.';
  }
  function renderResults() {
    results.replaceChildren();
    const summary = element('div', 'ai-result ai-result-summary');
    summary.append(element('strong', '', '권장 모델'), element('span', '', recommendationText()));
    results.append(summary);
    for (const candidate of familyModels()) {
      const result = state.results.find(entry => entry.modelId === candidate.id);
      const item = element('div', 'ai-result');
      const title = element('strong', '', candidate.name);
      const summary = element('span', '', result ? LABELS[result.status] ?? '재측정 필요' : '미측정');
      item.append(title, summary);
      if (result) {
        const text = Number.isFinite(result.ttftMs) && Number.isFinite(result.tokensPerSecond)
          ? `첫 답변 ${(result.ttftMs / 1000).toFixed(2)}초 · ${result.tokensPerSecond.toFixed(1)} tok/s · 3회 중앙값`
          : String(result.reason ?? '통계를 확인할 수 없습니다.');
        item.append(element('p', '', text));
        if (Number.isFinite(result.loadMs)) item.append(element('small', '', `다운로드·로드 ${(result.loadMs / 1000).toFixed(1)}초 (판정 제외)`));
      }
      results.append(item);
    }
  }
  function render() {
    const env = state.env;
    const locked = state.busy || state.checking || session.busy;
    momoToggle.setAttribute('aria-checked', String(session.momoEnabled));
    envRows.browser.textContent = env?.browser ?? '확인 중';
    envRows.webgpu.textContent = env ? `${ENGINE_NAMES[model().engine]} · ${runtime().supported ? '기본 조건 확인 · 실측 필요' : '실행 조건 미충족'}` : '확인 중';
    envRows.buffers.textContent = `${env?.limits?.maxStorageBuffersPerShaderStage ?? '확인 불가'} / 어댑터 한도 사용`;
    envRows.gpu.textContent = env?.gpu ?? '확인 중';
    envRows.gpu.title = env?.gpu ?? '';
    envRows.vram.textContent = '브라우저에서 확인 불가';
    envRows.vram.title = env?.vramReason ?? '';
    envRows.ram.textContent = env?.memoryGB ? `약 ${env.memoryGB} GB · 정확한 용량 아님` : '확인 불가';
    envRows.ram.title = env && !env.memoryGB ? env.memoryReason ?? '' : '';
    envRows.cores.textContent = env?.cores ? `${env.cores}개` : '확인 불가';
    envRows.webllm.textContent = !env ? '확인 중' : env.engines?.webllm?.supported ? '실행 가능 · 실측 필요' : '실행 불가';
    envRows.webllm.title = env?.engines?.webllm?.reason ?? ENGINE_GUIDANCE.webllm;
    envRows.litert.textContent = !env ? '확인 중' : env.engines?.litert?.supported ? '실행 가능 · 실측 필요' : '실행 불가';
    envRows.litert.title = env?.engines?.litert?.reason ?? ENGINE_GUIDANCE.litert;
    setValue(modelChoiceRow, modelById(state.modelId)?.name ?? model().name);
    setValue(characterChoiceRow, characterById(state.characterId)?.name ?? characterById(CHARACTERS[0].id).name);
    modelChoiceRow.disabled = locked;
    characterChoiceRow.disabled = locked;
    for (const entry of panel.querySelectorAll('.ai-chat-entry .ios-value')) entry.textContent = characterById(state.characterId)?.name ?? '';
    setValue(modelStatusRow, session.owner === 'momotalk' ? '모모톡 로컬 AI 작업 중입니다.' : state.status);
    setValue(benchmarkStatusRow, session.owner === 'momotalk' ? '모모톡 로컬 AI 작업 중입니다.' : state.status);
    modelInfo.textContent = `${model().name} · ${ENGINE_NAMES[model().engine]} · ${model().engine === 'litert' ? '웹 전용 혼합 정밀도' : '4비트'} · 문맥 ${BENCHMARK.context.toLocaleString()}토큰 · 다운로드 약 ${gb(model().bytes + MODEL_OVERHEAD_BYTES)} · GPU 메모리 참고값 약 ${(model().memoryMB / 1000).toFixed(1)} GB (기기별 차이, 보장값 아님). ${model().engine === 'litert' ? 'Gemma 4는 E2B 한 모델부터 실행을 검증합니다. 한도 9에서도 초기화 요청이 가능하지만 실제 모델 호환성·속도는 측정해야 합니다.' : ''}`;
    source.href = modelCardURL(model());
    setValue(loadedRow, modelById(session.loaded)?.name ?? '없음');
    setValue(cachedRow, cacheCounts()[state.modelId] === undefined ? '확인 불가' : `${cacheCounts()[state.modelId]}개 (부분 파일 포함)`);
    setValue(cachedSizeRow, cacheBytes(state.modelId) === undefined ? '확인 불가' : gb(cacheBytes(state.modelId)));
    setValue(runtimeCacheRow, state.cache?.runtimeBytes === undefined ? '확인 불가' : gb(state.cache.runtimeBytes));
    for (const control of controls) control.disabled = locked;
    persistButton.disabled = locked || state.persisting === true;
    loadButton.disabled = locked || !runtime().supported;
    benchButton.disabled = locked || !runtime().supported;
    unloadButton.disabled ||= !session.loaded;
    deleteWeightsButton.disabled ||= cacheCounts()[state.modelId] === 0;
    legacyDeleteButton.hidden = !(cacheCounts()[LEGACY_GEMMA2.id] > 0);
    clearButton.disabled ||= state.results.length === 0;
    cancelButton.disabled = !state.busy;
    cancelButton.hidden = !state.busy;
    input.disabled = state.busy;
    send.disabled = locked || !session.ready;
    panel.setAttribute('aria-busy', String(locked));
    if (status.textContent !== state.status) status.textContent = session.owner === 'momotalk' ? '모모톡 로컬 AI 작업 중입니다.' : state.status;
    renderResults();
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || !session.ready) return;
    run(async () => {
      const messages = [...state.chat.slice(-4).map(message => ({ ...message, content: message.content.slice(0, 1000) })), { role: 'user', content: text }];
      input.value = '';
      output.textContent = '';
      state.status = `${characterById(state.characterId).name} · ${modelById(session.loaded).name} 답변 생성 중`;
      render();
      let response;
      try {
        response = await client.request('generate', { messages, characterId: state.characterId, maxTokens: 128 }, {
          timeoutMs: 60000,
          onEvent: update => { if (update.event === 'token') output.textContent = update.text; },
        });
      } catch (error) { input.value = text; throw error; }
      state.chat = [...messages, { role: 'assistant', content: response.text }].slice(-4);
      chatStats.textContent = `첫 답변 ${(response.ttftMs / 1000).toFixed(2)}초 · ${Number.isFinite(response.tokensPerSecond) ? response.tokensPerSecond.toFixed(1) : '측정 불가'} tok/s · ${response.tokens ?? '?'}토큰`;
      state.status = '로컬 답변 생성 완료';
    });
  });
  session.addEventListener('change', () => {
    state.modelId = session.modelId;
    if (!session.loaded) state.chat = [];
    if (session.owner === 'momotalk') state.cache = {};
    if (!state.busy && !state.checking && session.notice) state.status = session.notice;
    render();
    if (!state.env && !state.busy && !state.checking && !session.busy) void detect();
  });
  render();
  void detect();
  return panel;
}
