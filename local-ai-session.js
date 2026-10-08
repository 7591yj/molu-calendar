import { BENCHMARK, DEFAULT_MODEL_ID, LocalAIClient, modelById, errorWithCode } from './local-ai.js';

export const AI_SETTINGS_KEY = 'molu.local-ai.v1';

// One tab, one Worker. A lease covers the WHOLE workflow, including gaps between benchmark samples.
export class LocalAISession extends EventTarget {
  constructor(client = new LocalAIClient(), storage) {
    super();
    this.client = client;
    this.job = null;
    this.notice = '';
    try { this.storage = storage ?? globalThis.localStorage; this.settings = JSON.parse(this.storage?.getItem(AI_SETTINGS_KEY) ?? 'null'); } catch { /* optional storage */ }
    if (!this.settings || typeof this.settings !== 'object' || Array.isArray(this.settings)) this.settings = {};
    this.settings.modelId = this.settings.catalogVersion === BENCHMARK.version && modelById(this.settings.modelId) ? this.settings.modelId : DEFAULT_MODEL_ID;
    this.settings.momoEnabled = this.settings.momoEnabled === true;
  }
  get owner() { return this.job?.owner ?? null; }
  get busy() { return this.job !== null; }
  get loaded() { return this.client.loaded; }
  get modelId() { return this.settings.modelId; }
  get momoEnabled() { return this.settings.momoEnabled; }
  get ready() { return this.loaded === this.modelId; }
  notify() { this.dispatchEvent(new Event('change')); }
  save(patch) {
    this.settings = { ...this.settings, ...patch, catalogVersion: BENCHMARK.version };
    let saved = !!this.storage;
    try { this.storage?.setItem(AI_SETTINGS_KEY, JSON.stringify(this.settings)); } catch { saved = false; }
    this.notify();
    return saved;
  }
  async run(owner, task) {
    if (this.busy) throw errorWithCode('busy', '다른 로컬 AI 작업이 진행 중입니다. 완료하거나 해당 화면에서 중단해 주세요.');
    const job = { owner, error: null };
    this.job = job;
    this.notice = '';
    this.notify();
    const check = () => {
      if (job.error) throw job.error;
      if (this.job !== job) throw errorWithCode('cancelled', '종료된 로컬 AI 작업입니다.');
    };
    const client = {
      check,
      request: async (...args) => {
        check();
        const result = await this.client.request(...args);
        check();
        this.notify();
        return result;
      },
      stop: () => { if (this.job === job && !job.error) { this.client.stop(); this.notify(); } },
    };
    try {
      check();
      const result = await task(client);
      check();
      return result;
    } catch (error) {
      this.client.stop(error);
      throw error;
    } finally {
      this.job = null;
      this.notify();
    }
  }
  cancel(owner, error = errorWithCode('cancelled', '작업을 취소했습니다. 이미 받은 파일은 캐시에 남을 수 있습니다.')) {
    if (this.owner !== owner) return false;
    if (this.job) this.job.error = error;
    this.notice = error.message;
    this.client.stop(error);
    this.notify();
    return true;
  }
}

export const localAISession = new LocalAISession();
if (globalThis.document) {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) localAISession.cancel(localAISession.owner, errorWithCode('hidden', '백그라운드 전환으로 로컬 AI 작업을 취소하고 모델 메모리를 해제했습니다.'));
  });
  globalThis.addEventListener('pagehide', () => localAISession.cancel(localAISession.owner));
}
