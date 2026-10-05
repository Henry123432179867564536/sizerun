import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseBackground, removeBackground, trimTransparent } from '../public/desk/lib/bgremove.js';

// A w×h image painted by fn(x, y) → [r, g, b, a?].
function paint(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    const [r, g, b, a = 255] = fn(x, y);
    data.set([r, g, b, a], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
// Anti-aliased disc: coverage falls from 1 to 0 over the last pixel of the radius.
const disc = (cx, cy, r, colour, bg) => (x, y) => {
  const cover = Math.min(1, Math.max(0, r - Math.hypot(x - cx, y - cy) + 0.5));
  return colour.map((c, i) => Math.round(c * cover + bg[i] * (1 - cover)));
};

test('white background is removed, artwork kept, image trimmed', () => {
  const img = paint(100, 100, disc(50, 50, 20, [200, 30, 40], [255, 255, 255]));
  assert.equal(analyseBackground(img).suggest, true);
  const { image } = removeBackground(img);
  assert.ok(image.width < 50 && image.height < 50, `trimmed to ${image.width}×${image.height}`);
  const c = Math.floor(image.width / 2);
  assert.equal(px(image, c, c)[3], 255);
  assert.deepEqual(px(image, c, c).slice(0, 3), [200, 30, 40]);
  assert.equal(px(image, 0, 0)[3], 0);
});

test('edge pixels are partly transparent with no white fringe', () => {
  const img = paint(80, 80, disc(40, 40, 20, [20, 20, 120], [255, 255, 255]));
  const { image } = removeBackground(img);
  let partial = 0;
  for (let i = 0; i < image.data.length; i += 4) {
    const a = image.data[i + 3];
    if (a > 0 && a < 255) {
      partial += 1;
      // un-mixed colour stays dark blue, not washed towards white
      assert.ok(image.data[i] < 120 && image.data[i + 1] < 120, `fringe pixel ${Array.from(image.data.subarray(i, i + 4))}`);
    }
  }
  assert.ok(partial > 0);
});

test('off-white noisy JPEG-like background is removed', () => {
  let seed = 7;
  const noise = () => { seed = (seed * 16807) % 2147483647; return (seed % 13) - 6; };
  const img = paint(90, 60, (x, y) => (x > 30 && x < 60 && y > 20 && y < 40 ? [10, 10, 10] : [250 + noise(), 250 + noise(), 247 + noise()]));
  const { image } = removeBackground(img);
  let opaque = 0;
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 200) opaque += 1;
  assert.ok(Math.abs(opaque - 29 * 19) < 60, `opaque pixels ${opaque}`);
});

test('counter inside a letter is cleared only with fillHoles', () => {
  const ring = (x, y) => { const d = Math.hypot(x - 40, y - 40); return d < 20 && d > 10 ? [0, 0, 0] : [255, 255, 255]; };
  const img = paint(80, 80, ring);
  const filled = removeBackground(img).image;
  const kept = removeBackground(img, { fillHoles: false }).image;
  const centre = (im) => px(im, Math.floor(im.width / 2), Math.floor(im.height / 2))[3];
  assert.equal(centre(filled), 0);
  assert.equal(centre(kept), 255);
});

test('white logo on black: black is the background', () => {
  const img = paint(60, 60, (x, y) => (x > 20 && x < 40 && y > 20 && y < 40 ? [255, 255, 255] : [0, 0, 0]));
  const { image, background } = removeBackground(img);
  assert.ok(background.every((c) => c < 10));
  assert.equal(px(image, 0, 0)[3], 0);
  assert.equal(px(image, Math.floor(image.width / 2), Math.floor(image.height / 2))[3], 255);
});

test('transparent logos and photos are not suggested', () => {
  const clear = paint(40, 40, (x, y) => (x > 10 && x < 30 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
  assert.equal(analyseBackground(clear).suggest, false);
  const photo = paint(40, 40, (x, y) => [(x * 37 + y * 11) % 256, (x * 7 + y * 53) % 256, (x * y) % 256]);
  assert.equal(analyseBackground(photo).suggest, false);
});

test('trimTransparent leaves an all-transparent image alone and handles 1×1', () => {
  const empty = paint(5, 5, () => [0, 0, 0, 0]);
  assert.equal(trimTransparent(empty), empty);
  const one = paint(1, 1, () => [255, 255, 255]);
  assert.doesNotThrow(() => removeBackground(one));
});

test('fast enough for a 1024×1024 logo', () => {
  const img = paint(1024, 1024, disc(512, 512, 300, [30, 60, 200], [255, 255, 255]));
  const t = performance.now();
  removeBackground(img);
  assert.ok(performance.now() - t < 2500, `${Math.round(performance.now() - t)} ms`);
});
