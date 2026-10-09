import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCropPosition, cropSettings, cropRegion, cropImageStyle, moveCropCenter, resizeCrop, withCrop } from '../../compat/calendar-v1/banner-crop.ts';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} ≠ ${expected}`);

test('저장된 크롭 위치를 숫자로 읽고 잘못된 값은 중앙으로 되돌린다', () => {
  assert.deepEqual(parseCropPosition('25% 80%'), [25, 80]);
  assert.deepEqual(parseCropPosition('101% 0%'), [100, 0]);
  for (const value of [undefined, null, {}, 'broken', 'NaN% NaN%']) assert.deepEqual(parseCropPosition(value), [50, 50]);
});

test('원본 선택 영역은 실제 2:1 cover 크롭과 같다', () => {
  const tall = cropRegion(1280, 720, [50, 50]);
  near(tall.w, 100);
  near(tall.h, 640 / 720 * 100);
  near(tall.y, (720 - 640) / 2 / 720 * 100);
  const wide = cropRegion(780, 100, [100, 50]);
  near(wide.x, 580 / 780 * 100);
  near(wide.w, 200 / 780 * 100);
  assert.equal(wide.y, 0);
  assert.equal(wide.h, 100);
  assert.deepEqual(cropRegion(640, 320, [50, 50]), { x: 0, y: 0, w: 100, h: 100 });
});

test('팝업 초안·원래대로는 기존 값에 영향 없고 저장 후보만 바뀐다', () => {
  const saved = { 'banner.webp': '20% 80%', 'other.webp': '30% 50%' };
  const draft = parseCropPosition(saved['banner.webp']);
  draft[1] = 10;
  assert.equal(saved['banner.webp'], '20% 80%'); // 취소해도 저장값 유지.
  const next = withCrop(saved, 'banner.webp', draft);
  assert.deepEqual(next['banner.webp'], { position: [20, 10], scale: 1 });
  const reset = withCrop(saved, 'banner.webp', [50, 50]);
  assert.equal(reset['banner.webp'], undefined);
  assert.equal(reset['other.webp'], '30% 50%');
  assert.equal(saved['banner.webp'], '20% 80%');
});

test('기존 위치 문자열과 새 스케일 설정을 읽고 범위를 제한한다', () => {
  assert.deepEqual(cropSettings('25% 80%'), { position: [25, 80], scale: 1 });
  assert.deepEqual(cropSettings({ position: [25, 80], scale: 2 }), { position: [25, 80], scale: 2 });
  assert.deepEqual(cropSettings({ position: [NaN, 3], scale: Infinity }), { position: [50, 50], scale: 1 });
  assert.equal(cropSettings({ scale: 0 }).scale, 0.25);
  assert.equal(cropSettings({ scale: 99 }).scale, 5);
  const saved = withCrop({}, 'banner.webp', [50, 50], 2);
  assert.deepEqual(saved['banner.webp'], { position: [50, 50], scale: 2 });
  assert.equal(withCrop(saved, 'banner.webp', [50, 50], 1)['banner.webp'], undefined);
});

test('큰 선택 영역은 원본 밖까지 확장되고 이미지 주변을 투명하게 남긴다', () => {
  const region = cropRegion(640, 320, [50, 50], 2);
  assert.deepEqual(region, { x: -50, y: -50, w: 200, h: 200 });
  assert.deepEqual(cropImageStyle(region), { left: '25%', top: '25%', width: '50%', height: '50%' });
  assert.deepEqual(cropRegion(640, 320, [50, 50], 0.5), { x: 25, y: 25, w: 50, h: 50 });
  // Smaller area zooms into the image, without changing its aspect ratio.
  assert.deepEqual(cropImageStyle(cropRegion(640, 320, [50, 50], 0.5)), { left: '-50%', top: '-50%', width: '200%', height: '200%' });
  const wide = cropRegion(780, 100, [50, 50], 4);
  near(wide.x, -10 / 780 * 100);
  near(wide.y, -150);
  near(wide.w, 800 / 780 * 100);
  assert.equal(wide.h, 400);
});

test('이전 크롭을 중심 좌표로 바꿔도 같은 영역이며 저장 값은 독립적이다', () => {
  const old = cropSettings('25% 80%');
  const region = cropRegion(1280, 720, old.position, old.scale);
  const center = [region.x + region.w / 2, region.y + region.h / 2];
  const converted = cropRegion(1280, 720, old.position, old.scale, center);
  near(converted.x, region.x);
  near(converted.y, region.y);
  assert.equal(converted.w, region.w);
  const saved = withCrop({}, 'banner.webp', old.position, old.scale, center);
  assert.deepEqual(cropSettings(saved['banner.webp']).center, center);
  center[0] = -100;
  assert.notEqual(saved['banner.webp'].center[0], -100);
  assert.equal(withCrop(saved, 'banner.webp', [25, 80], 1, [50, 50])['banner.webp'], undefined);
  assert.deepEqual(cropSettings({ center: [NaN, 20] }), { position: [50, 50], scale: 1 });
  assert.deepEqual(cropSettings({ center: [-999, 999] }).center, [-500, 500]);
});

test('가장자리·모서리 8개는 반대쪽 기준점을 유지하며 2:1로 크기를 바꾼다', () => {
  const settings = { position: [50, 50], center: [50, 50], scale: 1 };
  for (const handle of ['n', 'e', 's', 'w', 'nw', 'ne', 'sw', 'se']) {
    const sx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
    const sy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
    const resized = resizeCrop(640, 320, settings, sx * 10, sy * 5, { width: 320, height: 160 }, handle);
    near(resized.scale, 660 / 640);
    const region = cropRegion(640, 320, settings.position, resized.scale, resized.center);
    near(region.w * 640 / (region.h * 320), 2);
    near(region.x / 100 * 640 + (1 - sx) / 2 * region.w / 100 * 640, 320 - sx * 320);
    near(region.y / 100 * 320 + (1 - sy) / 2 * region.h / 100 * 320, 160 - sy * 160);
  }
  assert.deepEqual(settings.center, [50, 50]);
});

test('보기 배율이 달라도 같은 원본 이동은 같은 크롭을 만든다', () => {
  const settings = { position: [50, 50], center: [50, 50], scale: 1 };
  const normal = resizeCrop(640, 320, settings, 20, 10, { width: 640, height: 320 }, 'se');
  const zoomed = resizeCrop(640, 320, settings, 40, 20, { width: 1280, height: 640 }, 'se');
  assert.deepEqual(zoomed, normal);
  assert.deepEqual(moveCropCenter([50, 50], 10, 5, { width: 320, height: 160 }), moveCropCenter([50, 50], 20, 10, { width: 640, height: 320 }));
  assert.deepEqual(moveCropCenter([490, -490], 100, -100, { width: 100, height: 100 }), [500, -500]);
});

test('리사이즈 한계와 원본 밖 투명 영역에서도 반대편을 유지한다', () => {
  const settings = { position: [50, 50], center: [50, 50], scale: 0.5 };
  assert.equal(resizeCrop(640, 320, settings, -9999, 0, { width: 640, height: 320 }, 'e').scale, 0.25);
  assert.equal(resizeCrop(640, 320, settings, 9999, 0, { width: 640, height: 320 }, 'e').scale, 5);
  const resized = resizeCrop(640, 320, settings, -400, -200, { width: 640, height: 320 }, 'nw');
  const region = cropRegion(640, 320, settings.position, resized.scale, resized.center);
  assert.ok(region.x < 0 && region.y < 0);
  near(region.x + region.w, 75);
  near(region.y + region.h, 75);
});
