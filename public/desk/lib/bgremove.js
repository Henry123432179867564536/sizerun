// Logo background removal. Pure: works on { data: Uint8ClampedArray RGBA, width, height }, so it
// runs in the browser (canvas ImageData) and in Node tests alike.
//
// Logos usually sit on a plain background (white, off-white, a solid colour). We take that colour
// from the image border, then clear every pixel connected to the border that is close to it,
// measured as a perceptual distance (CIE76 ΔE in Lab). Pixels just past the cut-off become
// partly transparent with the background colour un-mixed from them, so anti-aliased edges keep
// their shape without a white halo. Enclosed background patches (inside an O, A or e) are cleared
// too, with a tighter cut-off so white artwork inside a coloured shape survives.

const STRENGTH = { gentle: 0.7, normal: 1, strong: 1.45 };
const MIN_THRESHOLD = 6;
const MAX_THRESHOLD = 40;

/** Does this image look like a logo on a plain, opaque background? */
export function analyseBackground(img) {
  const { width, height, data } = img;
  if (!width || !height) return { suggest: false, hasTransparency: false, background: null, uniformity: 0 };
  let transparent = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) transparent += 1;
  const hasTransparency = transparent > width * height * 0.01;
  const ring = borderPixels(img);
  const background = dominantColour(img, ring);
  const bgLab = toLab(background);
  const close = ring.filter((p) => deltaE(labAt(img, p), bgLab) < 12).length;
  const uniformity = ring.length ? close / ring.length : 0;
  return { suggest: !hasTransparency && uniformity >= 0.6, hasTransparency, background, uniformity };
}

/**
 * Removes the plain background. strength: 'gentle' | 'normal' | 'strong'. fillHoles also clears
 * enclosed background patches. Returns { image, removedShare, background, threshold }.
 */
export function removeBackground(img, { strength = 'normal', fillHoles = true } = {}) {
  const { width, height, data } = img;
  const n = width * height;
  const out = new Uint8ClampedArray(data);
  if (!n) return { image: { data: out, width, height }, removedShare: 0, background: null, threshold: 0 };

  const ring = borderPixels(img);
  const background = dominantColour(img, ring);
  const bgLab = toLab(background);

  // Distance of every pixel from the background colour.
  const dist = new Float32Array(n);
  for (let p = 0; p < n; p += 1) dist[p] = data[p * 4 + 3] < 8 ? 0 : deltaE(labAt(img, p), bgLab);

  const factor = STRENGTH[strength] ?? (Number(strength) > 0 ? Number(strength) : 1);
  const threshold = clamp(autoThreshold(dist) * factor, MIN_THRESHOLD, MAX_THRESHOLD * factor);
  const soft = threshold * 1.8; // the anti-aliased band past the cut-off

  // 1. Flood fill from the border through pixels within the soft band.
  const state = new Uint8Array(n); // 0 = artwork, 1 = background, 2 = edge (partial)
  const stack = [];
  for (const p of ring) if (dist[p] < soft && !state[p]) { state[p] = dist[p] < threshold ? 1 : 2; stack.push(p); }
  while (stack.length) {
    const p = stack.pop();
    if (state[p] === 2) continue; // edges don't spread the fill further
    const x = p % width;
    const y = (p - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (state[q] || dist[q] >= soft) continue;
        state[q] = dist[q] < threshold ? 1 : 2;
        stack.push(q);
      }
    }
  }

  // 2. Enclosed background patches (counters of letters). Tighter cut-off, and only patches big
  //    enough not to be specks of highlight inside the artwork.
  if (fillHoles) {
    const tight = threshold * 0.6;
    const seen = new Uint8Array(n);
    const minArea = Math.max(4, Math.round(n * 0.0004));
    for (let start = 0; start < n; start += 1) {
      if (state[start] || seen[start] || dist[start] >= tight) continue;
      const region = [start];
      seen[start] = 1;
      for (let i = 0; i < region.length; i += 1) {
        const p = region[i];
        const x = p % width;
        const y = (p - x) / width;
        const around = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
        for (const q of around) {
          if (q < 0 || seen[q] || state[q] || dist[q] >= tight) continue;
          seen[q] = 1;
          region.push(q);
        }
      }
      if (region.length >= minArea) for (const p of region) state[p] = 1;
    }
    // Soften the rim of every cleared region the same way as the outside edge.
    for (let p = 0; p < n; p += 1) {
      if (state[p] || dist[p] >= soft) continue;
      const x = p % width;
      if ((x > 0 && state[p - 1] === 1) || (x < width - 1 && state[p + 1] === 1)
        || (p >= width && state[p - width] === 1) || (p < n - width && state[p + width] === 1)) state[p] = 2;
    }
  }

  // 3. Artwork pixels touching the cleared area are anti-aliased mixes too: treat them as edges.
  for (let p = 0; p < n; p += 1) {
    if (state[p]) continue;
    const x = p % width;
    if ((x > 0 && state[p - 1] === 1) || (x < width - 1 && state[p + 1] === 1)
      || (p >= width && state[p - width] === 1) || (p < n - width && state[p + width] === 1)) state[p] = 3;
  }

  // 4. Write alpha. An edge pixel is a mix of the background and the nearest solid artwork
  //    colour: its alpha is how far it sits along that line, and the background is un-mixed
  //    from its colour so no halo is left on a coloured or dark page.
  let removed = 0;
  const [br, bg, bb] = background;
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    if (state[p] === 1) {
      out[i + 3] = 0;
      removed += 1;
      continue;
    }
    if (state[p] !== 2 && state[p] !== 3) continue;
    const fg = solidNeighbour(data, state, width, height, p);
    let a;
    if (fg) {
      const fr = fg[0] - br; const fgG = fg[1] - bg; const fb = fg[2] - bb;
      const len = fr * fr + fgG * fgG + fb * fb;
      a = len < 1 ? 1 : ((data[i] - br) * fr + (data[i + 1] - bg) * fgG + (data[i + 2] - bb) * fb) / len;
    } else {
      a = (dist[p] - threshold) / (soft - threshold);
    }
    a = clamp(a, 0, 1);
    if (a > 0.97) continue; // effectively solid: leave it untouched
    if (a < 0.04) {
      out[i + 3] = 0;
      removed += 1;
      continue;
    }
    if (fg) {
      out[i] = fg[0]; out[i + 1] = fg[1]; out[i + 2] = fg[2];
    } else {
      out[i] = clamp(Math.round((data[i] - (1 - a) * br) / a), 0, 255);
      out[i + 1] = clamp(Math.round((data[i + 1] - (1 - a) * bg) / a), 0, 255);
      out[i + 2] = clamp(Math.round((data[i + 2] - (1 - a) * bb) / a), 0, 255);
    }
    out[i + 3] = Math.round(a * data[i + 3]);
    removed += 1 - a;
  }

  const image = trimTransparent({ data: out, width, height });
  return { image, removedShare: removed / n, background, threshold };
}

/** Crops fully transparent margins, keeping a small padding. */
export function trimTransparent(img, padding = 0.04) {
  const { data, width, height } = img;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return img; // nothing visible: leave it alone
  const pad = Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * padding);
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (w === width && h === height) return img;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const from = ((minY + y) * width + minX) * 4;
    out.set(data.subarray(from, from + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

// ---- helpers ----------------------------------------------------------------------------------

// Colour of the closest solid artwork pixel (not background, not edge) within 3 px, or null.
function solidNeighbour(data, state, width, height, p) {
  const x0 = p % width;
  const y0 = (p - x0) / width;
  for (let r = 1; r <= 3; r += 1) {
    let best = null;
    let bestD = Infinity;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const q = y * width + x;
        if (state[q] !== 0) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = q; }
      }
    }
    if (best !== null) return [data[best * 4], data[best * 4 + 1], data[best * 4 + 2]];
  }
  return null;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// Indexes of the outermost 2-pixel ring (two rows/columns so a 1px frame doesn't win).
function borderPixels({ width, height }) {
  const out = [];
  const depth = Math.min(2, Math.floor(Math.min(width, height) / 2)) || 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x < depth || y < depth || x >= width - depth || y >= height - depth) out.push(y * width + x);
    }
  }
  return out;
}

// The most common border colour, bucketed to absorb JPEG noise, then averaged within its bucket.
function dominantColour({ data }, ring) {
  const buckets = new Map();
  for (const p of ring) {
    const i = p * 4;
    const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    const b = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    b.n += 1; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
    buckets.set(key, b);
  }
  let best = null;
  for (const b of buckets.values()) if (!best || b.n > best.n) best = b;
  return best ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
}

// Cut-off between "background" and "artwork": the widest gap in the distance histogram of
// non-background pixels (Otsu over ΔE), clamped to a sensible range.
function autoThreshold(dist) {
  const bins = new Float64Array(64);
  const scale = 64 / 100;
  for (const d of dist) bins[Math.min(63, Math.floor(d * scale))] += 1;
  let total = 0;
  let sum = 0;
  for (let i = 0; i < 64; i += 1) { total += bins[i]; sum += i * bins[i]; }
  let wB = 0;
  let sumB = 0;
  let best = 0;
  let at = 10;
  for (let i = 0; i < 64; i += 1) {
    wB += bins[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * bins[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best) { best = between; at = i; }
  }
  return clamp((at + 0.5) / scale * 0.5, MIN_THRESHOLD, 24);
}

function labAt({ data }, p) {
  const i = p * 4;
  return toLab([data[i], data[i + 1], data[i + 2]]);
}

function toLab([r, g, b]) {
  const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = lin(r); const G = lin(g); const B = lin(b);
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x); const fy = f(y); const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
