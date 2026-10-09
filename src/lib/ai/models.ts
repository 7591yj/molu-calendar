// Pinned, reviewed model artifacts only. No arbitrary URLs or user-supplied WASM.
export type EngineKind = "litert" | "webllm";
export interface ModelArtifact {
  id: string;
  engine: EngineKind;
  revision: string;
}
export interface Model extends ModelArtifact {
  name: string;
  family: string;
  rank: number;
  bytes: number;
  memoryMB: number;
}
export interface GPUAdapterInfoView {
  vendor?: string;
  architecture?: string;
  description?: string;
  isFallbackAdapter?: boolean;
  type?: string;
}
export interface GPUAdapterView {
  info?: GPUAdapterInfoView;
  isFallbackAdapter?: boolean;
  type?: string;
  features: ReadonlySet<string>;
  limits: Readonly<Record<string, number>>;
}
export const MODELS: Model[] = [
  {
    id: "gemma-4-E2B-it-web",
    name: "Gemma 4 E2B",
    engine: "litert",
    family: "Gemma 4",
    rank: 1,
    bytes: 2008432640,
    memoryMB: 1800,
    revision: "b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1",
  },
];
// Retained only to delete old downloads; never offered for loading or recommendation.
export const LEGACY_GEMMA2: ModelArtifact = {
  id: "gemma-2-2b-it-q4f16_1-MLC",
  engine: "webllm",
  revision: "de9cc76f0d4b3a49a0f718df424944054bf1eec1",
};
export const DEFAULT_MODEL_ID = "gemma-4-E2B-it-web";
export const LITERT_ASSET_PATH = "/vendor/litert-lm/0.17.1/";
export const LITERT_CACHE = "molu/litert-model-v1";
export const ENGINE_NAMES = { webllm: "WebLLM", litert: "LiteRT-LM" };
export const BENCHMARK = Object.freeze({
  version: "webllm-0.2.85-litert-0.17.1-ko-v3",
  context: 4096,
  firstMs: 5000,
  comfortableMs: 3000,
  minTps: 5,
  samples: 3,
  minTokens: 16,
  maxTokens: 96,
});
// TVM detectGPUDevice() minima in the pinned WebLLM 0.2.85 runtime, before any model loads.
// Buffer sizes are API limits, NOT installed/free VRAM. Do not clamp runtime requests to hide failures.
export const WEBGPU_LIMITS = Object.freeze({
  maxStorageBuffersPerShaderStage: 10,
  maxComputeWorkgroupStorageSize: 32768,
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
});
export function gpuLimitReason(
  key: string,
  available: number | string,
  required: number | string | undefined = WEBGPU_LIMITS[
    key as keyof typeof WEBGPU_LIMITS
  ],
) {
  return (
    `현재 브라우저/GPU의 WebGPU 실행 한도가 부족합니다: ${key} 현재 ${available} / 필요 ${required}. ` +
    "VRAM 용량이나 생성 속도의 문제가 아니며, 작은 모델로 바꿔도 현재 WebLLM 엔진은 실행되지 않습니다. " +
    "최신 Chrome/Edge 등 다른 GPU 가속 브라우저에서 다시 확인해 주세요. 앱에서 이 한도를 올릴 수는 없습니다."
  );
}
export const ENGINE_GUIDANCE = Object.freeze({
  webllm:
    "WebLLM: Chromium(WebGPU shader-f16 + 저장 버퍼 10개)이 필요합니다. Firefox·Safari에서는 실행되지 않습니다.",
  litert:
    "LiteRT-LM: Chromium WebGPU가 필요합니다. Safari 26+는 WebGPU를 지원하지만 어댑터 정보 공개가 제한적이라 실측이 필요합니다.",
});
export function runtimeCompatibility(
  adapter: GPUAdapterView,
  engine: EngineKind = "webllm",
) {
  if (
    adapter.info?.isFallbackAdapter ??
    adapter.isFallbackAdapter ??
    (adapter.info?.type === "software" || adapter.type === "software")
  )
    return "소프트웨어 GPU 어댑터는 지원하지 않습니다. GPU 가속 브라우저에서 다시 확인해 주세요.";
  // LiteRT requests the adapter's limits, not TVM's minima. Model execution still needs testing.
  if (engine === "litert") return null;
  if (!adapter.features.has("shader-f16"))
    return "현재 모델에 필요한 GPU의 shader-f16 기능을 사용할 수 없습니다. CPU 실행은 이번 버전에 포함되지 않습니다.";
  for (const [key, minimum] of Object.entries(WEBGPU_LIMITS)) {
    const value = adapter.limits?.[key];
    if (!Number.isFinite(value) || (value ?? 0) < minimum)
      return gpuLimitReason(key, Number.isFinite(value) ? value! : "확인 불가");
  }
  return null;
}

export const MODEL_OVERHEAD_BYTES = 50 * 1024 * 1024; // tokenizer, WASM, configs; estimate, not a quota guarantee
export const modelCardURL = (model: ModelArtifact) =>
  model.engine === "litert"
    ? "https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm"
    : `https://huggingface.co/mlc-ai/${model.id}`;
export const modelURL = (model: ModelArtifact) =>
  `${modelCardURL(model)}/resolve/${model.revision}/${model.engine === "litert" ? `${model.id}.litertlm` : ""}`;
export const modelById = (id: string | null | undefined) =>
  MODELS.find((model) => model.id === id);
export const errorWithCode = (code: string, message: string) =>
  Object.assign(new Error(message), { code });
export const CACHE_MODELS = [...MODELS, LEGACY_GEMMA2];
export const CACHE_NAMES = [
  "webllm/model",
  "webllm/config",
  "webllm/wasm",
  LITERT_CACHE,
];
