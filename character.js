import {
  AmbientLight, Box3, DirectionalLight, Euler, Group, LoadingManager, MathUtils,
  OrthographicCamera, Quaternion, Scene, Vector3, WebGLRenderer,
} from 'three';
import { MMDLoader } from '@moeru/three-mmd';

let active = null;
let loading = false;
const MODEL_URL = '/models/gura/GawrGura.pmx';
const MODEL_FILES = new Set(['GawrGura.pmx', 'body.png', 'ex.png', 'face.png', 'hair.png', 'nhair.png', 'weapon.png']);

// ponytail: procedural test gait, not a VMD performance. Replace with licensed walk/idle clips when available.
export function walkFrame(seconds, travelSeconds = 18) {
  if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(travelSeconds) || travelSeconds <= 0) throw new RangeError('Invalid walking time');
  const pause = 2;
  const phase = seconds % (2 * (travelSeconds + pause));
  if (phase < travelSeconds) return { position: -1 + 2 * phase / travelSeconds, direction: 1, walking: true };
  if (phase < travelSeconds + pause) return { position: 1, direction: 1, walking: false };
  if (phase < 2 * travelSeconds + pause) return { position: 1 - 2 * (phase - travelSeconds - pause) / travelSeconds, direction: -1, walking: true };
  return { position: -1, direction: -1, walking: false };
}

export function modelResource(url, origin) {
  if (url.startsWith('data:image/png;base64,')) return url;
  const resolved = new URL(url, origin);
  const filename = resolved.pathname.slice('/models/gura/'.length);
  if (resolved.origin !== new URL(origin).origin || !resolved.pathname.startsWith('/models/gura/') || !MODEL_FILES.has(filename) || resolved.username || resolved.password) {
    throw new Error('모델에 허용되지 않은 외부 리소스가 있습니다.');
  }
  return resolved.href;
}

export async function toggleCharacter() {
  if (active) {
    active.dispose();
    return;
  }
  // Guard against re-entry while the PMX is loading: a second click must not spawn a second renderer.
  if (loading) return;
  loading = true;
  const stage = document.querySelector('#character-stage');
  const controls = document.querySelector('#character-controls');
  const button = document.querySelector('#character-toggle');
  const status = document.querySelector('#character-status');
  const motionButton = document.querySelector('#character-motion');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new AbortController();
  const scene = new Scene();
  const camera = new OrthographicCamera(-10, 10, 20, 0, .1, 1000);
  const holder = new Group();
  const textures = new Set();
  const joints = new Map();
  const euler = new Euler();
  const quaternion = new Quaternion();
  let renderer, mmd, observer, frameId = 0, disposed = false;
  let elapsed = 0, lastFrame = 0, userPaused = false, blend = 0;
  let height = 12, baseY = 0, travelLimit = 0, travelSeconds = 18;

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(frameId);
    listeners.abort();
    observer?.disconnect();
    mmd?.dispose();
    if (mmd) {
      mmd.mesh.skeleton.dispose();
      mmd.mesh.geometry.dispose();
      for (const material of mmd.mesh.material) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
        material.dispose();
      }
    }
    textures.forEach(texture => texture.dispose());
    renderer?.dispose();
    renderer?.forceContextLoss();
    stage.replaceChildren();
    stage.hidden = true;
    stage.dataset.state = 'off';
    controls.hidden = true;
    button.textContent = '구라 불러오기';
    button.setAttribute('aria-pressed', 'false');
    status.textContent = 'PMX 로컬 테스트';
    active = null;
  }
  function pose(name, x = 0, y = 0, z = 0) {
    const joint = joints.get(name);
    if (!joint) return;
    joint.bone.quaternion.copy(joint.rest).multiply(quaternion.setFromEuler(euler.set(x, y, z)));
  }
  function paused() {
    return userPaused || reducedMotion.matches || document.hidden || Boolean(document.querySelector('dialog[open]'));
  }
  function draw(delta = 0) {
    const motion = walkFrame(elapsed, travelSeconds);
    const moving = !paused() && motion.walking;
    blend = paused() ? 0 : MathUtils.damp(blend, moving ? 1 : 0, 10, delta);
    const step = Math.sin(elapsed * 7.5) * blend;
    mmd.beforeUpdate();
    for (const side of ['左', '右']) {
      const sign = side === '左' ? 1 : -1;
      const arm = joints.get(`${side}腕`);
      pose(`${side}腕`, -step * sign * .22, 0, -(arm?.side ?? sign) * 1.05);
      pose(`${side}ひじ`, -.16);
      pose(`${side}足`, step * sign * .3);
      pose(`${side}ひざ`, Math.max(0, -step * sign) * .35);
    }
    holder.position.set(motion.position * travelLimit, baseY + Math.abs(step) * height * .01, 0);
    holder.rotation.y = reducedMotion.matches ? 0 : MathUtils.damp(holder.rotation.y, motion.walking ? motion.direction * .8 : 0, 8, delta);
    mmd.update(delta, { ik: false, physics: false });
    renderer.render(scene, camera);
  }
  function frame(now) {
    frameId = 0;
    if (disposed || paused()) return;
    if (lastFrame && now - lastFrame < 1000 / 30) { frameId = requestAnimationFrame(frame); return; }
    const delta = lastFrame ? Math.min((now - lastFrame) / 1000, .05) : 0;
    lastFrame = now;
    elapsed += delta;
    draw(delta);
    frameId = requestAnimationFrame(frame);
  }
  function refresh() {
    if (disposed || !mmd) return;
    cancelAnimationFrame(frameId);
    frameId = 0;
    lastFrame = 0;
    motionButton.disabled = reducedMotion.matches;
    motionButton.textContent = userPaused ? '걷기 재생' : '걷기 멈춤';
    motionButton.setAttribute('aria-pressed', String(!userPaused));
    stage.dataset.state = paused() ? 'paused' : 'walking';
    document.querySelector('#character-motion-note').textContent = reducedMotion.matches ? '동작 줄이기 · 정지 표시' : paused() ? '일시정지 · 테스트 모델' : '간이 걷기 · VMD 미사용';
    draw();
    if (!paused()) frameId = requestAnimationFrame(frame);
  }
  function resize() {
    if (!renderer || disposed) return;
    const width = stage.clientWidth;
    const canvasHeight = stage.clientHeight;
    const viewHeight = height * 1.22;
    const viewWidth = viewHeight * width / canvasHeight;
    camera.left = -viewWidth / 2;
    camera.right = viewWidth / 2;
    camera.top = viewHeight;
    camera.bottom = 0;
    camera.updateProjectionMatrix();
    travelLimit = Math.max(0, (viewWidth - height * .9) / 2);
    travelSeconds = Math.max(3, (width - canvasHeight * .75) / 45);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.setSize(width, canvasHeight);
    refresh();
  }

  try {
    button.textContent = '구라 불러오는 중…';
    status.textContent = '모델과 텍스처 읽는 중';
    stage.dataset.state = 'loading';
    renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    renderer.domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      if (disposed) return;
      dispose();
      status.textContent = '3D 연결이 중단됐습니다. 다시 불러와 주세요.';
    }, { signal: listeners.signal });
    stage.replaceChildren(renderer.domElement);
    camera.position.set(0, 0, 50);
    scene.add(new AmbientLight(0xffffff, 1.3));
    const light = new DirectionalLight(0xffffff, 1.8);
    light.position.set(-5, 15, 20);
    scene.add(light, holder);
    let resourcesLoading = false;
    let onReady;
    const errors = [];
    const manager = new LoadingManager();
    manager.setURLModifier(url => modelResource(url, location.origin));
    manager.onStart = () => { resourcesLoading = true; };
    manager.onLoad = () => { resourcesLoading = false; onReady?.(); };
    manager.onError = url => errors.push(url);
    mmd = await new MMDLoader(manager).loadAsync(MODEL_URL, progress => {
      if (progress.total) status.textContent = `모델 읽는 중 ${Math.round(progress.loaded / progress.total * 100)}%`;
    });
    if (resourcesLoading) await new Promise(resolve => { onReady = resolve; });
    if (errors.length) throw new Error('모델 텍스처 일부를 읽지 못했습니다.');
    const mesh = mmd.mesh;
    mesh.frustumCulled = false;
    // Small on-screen companion: keep original files intact, cap GPU texture resolution at 1024px.
    for (const material of mesh.material) for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    for (const texture of textures) {
      const image = texture.image;
      if (!image || Math.max(image.width, image.height) <= 1024) continue;
      const canvas = document.createElement('canvas');
      const scale = 1024 / Math.max(image.width, image.height);
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      texture.image = canvas;
      texture.needsUpdate = true;
    }
    holder.add(mesh);
    mesh.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(mesh);
    height = bounds.max.y - bounds.min.y;
    if (!Number.isFinite(height) || height <= 0) throw new Error('모델의 크기를 읽지 못했습니다.');
    baseY = -bounds.min.y + height * .035;
    for (const bone of mesh.skeleton.bones) joints.set(bone.name, { bone, rest: bone.quaternion.clone(), side: Math.sign(bone.getWorldPosition(new Vector3()).x) });
    stage.hidden = false;
    controls.hidden = false;
    button.textContent = '구라 숨기기';
    button.setAttribute('aria-pressed', 'true');
    status.textContent = 'Gawr Gura · PMX 테스트';
    loading = false;
    active = { dispose };
    window.addEventListener('resize', resize, { signal: listeners.signal });
    document.addEventListener('visibilitychange', refresh, { signal: listeners.signal });
    reducedMotion.addEventListener('change', refresh, { signal: listeners.signal });
    motionButton.addEventListener('click', () => { userPaused = !userPaused; refresh(); }, { signal: listeners.signal });
    document.querySelector('#character-hide').addEventListener('click', dispose, { signal: listeners.signal });
    window.addEventListener('pagehide', dispose, { signal: listeners.signal });
    observer = new MutationObserver(refresh);
    document.querySelectorAll('dialog').forEach(dialog => observer.observe(dialog, { attributes: true, attributeFilter: ['open'] }));
    resize();
  } catch (error) {
    loading = false;
    dispose();
    throw error;
  }
}
