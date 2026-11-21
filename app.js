/* Deadline Quest — countdown map engine, milestone manager and wallpaper exporter. */
(() => {
  'use strict';

  // ---------------------------------------------------------------- constants
  const MAP_W = 768, MAP_H = 1376;            // native size of master-wallpaper.png
  const DAY = 86400000;
  const STORE_KEY = 'deadline-quest/v1';
  const DEVICES = {
    iphone: { w: 1170, h: 2532, label: 'iPhone' },
    android: { w: 1080, h: 1920, label: 'Android' },
  };
  // Inside the Android and iOS apps (Capacitor) the native Wallpaper plugin is available; on the web both are empty.
  const CAP = window.Capacitor;
  const NATIVE = CAP && CAP.isNativePlatform && CAP.isNativePlatform() && window.capacitorExports
    ? window.capacitorExports.registerPlugin('Wallpaper') : null;
  const APP_OS = NATIVE ? CAP.getPlatform() : '';                 // 'android' | 'ios' | ''

  // Traveler roster. Frames live at assets/sprites/<prefix>-0..3.png (idle, walk 1, walk 2, victory),
  // all built by tools/key_heroes.py on a 360x360 canvas with the feet at y = 350.
  // Keys are <species>_<m|f>; `hair` is the drawn hair colour (for the Original swatch), null when bald.
  const HEROES = {
    human_m:  { label: 'Human (M)',  prefix: 'hero',          skin: true, hair: '#6e4426', note: 'Mostly hidden under the hood.' },
    human_f:  { label: 'Human (F)',  prefix: 'hero-human-f',  skin: true, hair: '#7a3a22' },
    elf_m:    { label: 'Elf (M)',    prefix: 'hero-elf-m',    skin: true, hair: '#e8b23a' },
    elf_f:    { label: 'Elf (F)',    prefix: 'hero-elf-f',    skin: true, hair: '#3f9a3a' },
    orc_m:    { label: 'Orc (M)',    prefix: 'hero-orc-m',    hair: null, note: 'This orc is bald.', skinNote: 'Orc skin stays green.' },
    orc_f:    { label: 'Orc (F)',    prefix: 'hero-orc-f',    hair: '#2a2522', skinNote: 'Orc skin stays green.' },
    dwarf_m:  { label: 'Dwarf (M)',  prefix: 'hero-dwarf-m',  skin: true, hair: '#d8541c', note: 'The beard changes too.' },
    dwarf_f:  { label: 'Dwarf (F)',  prefix: 'hero-dwarf-f',  skin: true, hair: '#d8541c', note: 'The beard changes too.' },
    wizard_m: { label: 'Wizard (M)', prefix: 'hero-wizard-m', skin: true, hair: '#e8e8ee', note: 'The beard changes too.' },
    wizard_f: { label: 'Wizard (F)', prefix: 'hero-wizard-f', skin: true, hair: '#5a3420' },
  };
  const SPECIES = [['human', 'Human'], ['elf', 'Elf'], ['orc', 'Orc'], ['dwarf', 'Dwarf'], ['wizard', 'Wizard']];
  // Island activity animations drawn by Gemini: [frame name, frames per second, frame used in exports].
  const ACT_ANIM = [['camp', 3, 1], ['hoe', 4.5, 1], ['type', 6, 0], ['med', 2.5, 2]];
  // Hair colours: shadow, mid, highlight. Each hair pixel is mapped onto the ramp by its brightness,
  // so the drawn shading survives. Masks come from tools/hair_masks.py (<prefix>-hair.png, HAIR_FRAMES order).
  const HAIR = {
    natural: { label: 'Original' },
    black:   { label: 'Black',  ramp: ['#141418', '#2c2c36', '#4e4e5e'] },
    brown:   { label: 'Brown',  ramp: ['#3a2212', '#6e4426', '#a36c3e'] },
    red:     { label: 'Red',    ramp: ['#5e140c', '#a8301a', '#e8662e'] },
    blonde:  { label: 'Blonde', ramp: ['#8a5c18', '#d8a640', '#fbe7a0'] },
    white:   { label: 'White',  ramp: ['#7e7e8a', '#c8c8d2', '#fbfbff'] },
  };
  // Skin tones, recoloured the same way from masks made by tools/skin_masks.py (<prefix>-skin.png).
  // Light is the drawn art. Orcs are green and keep their skin.
  const SKIN = {
    light:       { label: 'Light', swatch: ['#c98e66', '#eeb994', '#fbdcc0'] },
    tan:         { label: 'Tan',         ramp: ['#8a5532', '#c08458', '#e2b28a'] },
    lightbrown:  { label: 'Light brown', ramp: ['#5e3820', '#8f5c3a', '#bb8660'] },
    darkbrown:   { label: 'Dark brown',  ramp: ['#2e1a10', '#4e3020', '#7a5038'] },
  };
  // Caught in the rain: [frames, fps] played one after another, a second each: hugging themselves and shaking,
  // a puff of cold breath, blowing into their hands. Any a traveler has no art for is skipped.
  const COLD_ANIM = ['shiver', 'breath', 'warm'], COLD_FPS = { shiver: 8, breath: 4, warm: 4 };
  const HAIR_FRAMES = ['0', '1', '2', '3', ...[...ACT_ANIM.map(([a]) => a), ...COLD_ANIM].flatMap(a => [0, 1, 2, 3].map(i => `${a}-${i}`))];
  const HERO_CANVAS = 360, HERO_FEET = 350, HERO_SCALE = 0.256;   // 250 px body -> 64 map px

  // Island types, measured on the painted map (x, y, w, h in map pixels). sign = the blank signboard, hero = where the
  // traveler's feet stand, storm = the overdue cloud's centre. entry = waypoints from the landing stone to the hero spot,
  // exit = from the hero spot out over the last stepping stone.
  // Milestones 1..N-2 cycle Basecamp, Workshop, Observatory (a copy of the painted trio every three islands);
  // the last two are always the Crystal Shrine and the Final Castle.
  // in / out = the landing stone at the island's edge on the way in / out; entry / exit = on-island waypoints after
  // landing / before leaving. Between islands one stone shape is laid at even spacing on the straight line from
  // the out stone to the next island's in stone (the painted stepping stones are erased; see PAINTED_STONES).
  const TYPES = [
    { name: 'Basecamp', sign: [205, 1163, 103, 52], hero: [136, 1188], storm: [200, 1012],                // by the campfire
      in: [430, 1186], entry: [[322, 1160], [199, 1162], [160, 1197]],
      exit: [[160, 1197], [197, 1194], [199, 1162], [322, 1160], [340, 1118]], out: [344, 1093] },        // round the fire, behind the sign
    { name: 'Workshop', sign: [405, 970, 105, 51], hero: [335, 1007], storm: [452, 872],                  // beside the crop row
      in: [382, 1051], entry: [], exit: [[372, 1030], [387, 975]], out: [384, 941] },
    { name: 'Observatory', sign: [171, 811, 104, 51], hero: [311, 810], storm: [212, 700],                // at the computer
      in: [290, 865], entry: [], exit: [[318, 800]], out: [330, 761] },
    { name: 'Crystal Shrine', sign: [354, 641, 106, 51], hero: [335, 693], storm: [412, 540],
      in: [370, 722], entry: [], exit: [[340, 645], [470, 640]], out: [505, 641] },                    // behind the sign, out toward the castle
    { name: 'Final Castle', sign: [518, 489, 150, 30], hero: [503, 522], storm: [600, 322],
      in: [575, 599], entry: [[586, 578], [540, 575], [505, 545]], exit: [], out: null },             // up the stair stones
  ];
  // Centres of the stepping stones painted out in the water. They come in different sizes and colours, so they are
  // erased from the island cut-outs and replaced by evenly spaced copies of one stone. Stones painted on the islands
  // themselves (the castle's stair stones, the mossy landing stones of the shrine and observatory) stay.
  const PAINTED_STONES = [[556, 615], [536, 632], [351, 740], [330, 761], [308, 885], [336, 902], [361, 921],
    [384, 941], [382, 1051], [363, 1073], [344, 1093]];
  const STONE_STEP = 30;                        // centre-to-centre spacing of the laid stones
  const MIN_MS = 5, MAX_MS = 20;
  const PITCH = 170, TRIO_H = PITCH * 3;        // one extra island adds 170 px of map; a trio copy is 510 px tall
  const BANNER_Y = 465, BANNER_Y_ANDROID = 530;   // countdown banner centre (map y), see drawBanner
  const SHRINE_GAP = 80;                        // extra water between the shrine and the first inserted island
  // Layout: the Final Castle and the Crystal Shrine stay where they are painted (castle top right, the countdown
  // banner beside it on the left); the trio and its copies alternate left and right below them.
  const ROMAN = ['', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  // The quest: an 8-month house build, planned backward from the goal (done-when criteria in CLAUDE_CODE_BUILD.md §4).
  const DEFAULT_MS = [
    { task: 'Plans & Financing',    date: '2026-12-21', done: false },
    { task: 'Permits & Site Prep',  date: '2027-01-21', done: false },
    { task: 'Foundation Poured',    date: '2027-02-21', done: false },
    { task: 'Framing & Dry-In',     date: '2027-03-21', done: false },
    { task: 'MEP Rough-Ins',        date: '2027-04-21', done: false },
    { task: 'Insulation & Drywall', date: '2027-05-21', done: false },
    { task: 'Cabinets & Trim',      date: '2027-06-21', done: false },
    { task: 'Final Inspection',     date: '2027-07-21', done: false },
    { task: 'Build My Own House',   date: '2027-07-21', done: false },
  ];

  // Layer anchors on the base map.
  const WATER_TOP = Math.round(MAP_H * 0.35);            // Layer 2 region y 35%–100%
  const SKY = [MAP_H * 0.04, MAP_H * 0.26];              // Layer 3 region y 4%–26%
  const WATERFALLS = [[491, 521, 38, 70], [634, 554, 25, 64]];
  const CHIMNEY = [503, 872];
  const CRYSTAL = [409, 579];
  const CASTLE = [590, 412];

  const FONT_DISPLAY = '"Press Start 2P", "Courier New", monospace';
  const FONT_PIXEL = '"Pixelify Sans", "Trebuchet MS", sans-serif';

  // ------------------------------------------------------------------- state
  const state = {
    ms: clone(DEFAULT_MS),
    device: 'iphone',
    lock: false,
    hero: 'human_m',
    hair: 'natural',
    skin: 'light',
    selected: 1,
  };
  load();

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const IMG = {};
  let waterMask = null, shimmer = null, oceanPattern = null;

  const hero = { d: 0, goal: 0, face: 1, cheerUntil: 0, moving: false };

  // ----------------------------------------------------------------- helpers
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function parseDate(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
  // dayShift > 0 only while the Android app draws the wallpapers for the coming days (see "native apps").
  let dayShift = 0;
  function startOfToday() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate() + dayShift); }
  function isoDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function daysUntil(s) { return Math.round((parseDate(s) - startOfToday()) / DAY); }
  function fmtShort(s) { return parseDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase(); }
  function fmtLong(s) { return parseDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
  function activeIndex() { const i = state.ms.findIndex(m => !m.done); return i === -1 ? state.ms.length - 1 : i; }
  function allDone() { return state.ms.every(m => m.done); }
  function doneCount() { return state.ms.filter(m => m.done).length; }
  function goal() { return state.ms[state.ms.length - 1]; }
  // Days a milestone is past its date while still open (0 = not overdue). The date itself still counts as on time.
  function daysLate(i) { const m = state.ms[i]; return m.done ? 0 : Math.max(0, -daysUntil(m.date)); }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ ms: state.ms, device: state.device, lock: state.lock, hero: state.hero, hair: state.hair, skin: state.skin })); } catch (_) {}
    queueDaily();
  }
  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!raw) return;
      if (Array.isArray(raw.ms) && raw.ms.length >= MIN_MS && raw.ms.length <= MAX_MS && raw.ms.every(m => m && typeof m.task === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.date))) {
        state.ms = raw.ms.map(m => ({ task: m.task, date: m.date, done: !!m.done }));
      }
      if (DEVICES[raw.device]) state.device = raw.device;
      state.lock = !!raw.lock;
      if (HEROES[raw.hero]) state.hero = raw.hero;
      if (HAIR[raw.hair]) state.hair = raw.hair;
      if (SKIN[raw.skin]) state.skin = raw.skin;
    } catch (_) {}
  }

  function loadImage(src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('Could not load ' + src));
      im.src = src;
    });
  }

  async function loadAssets() {
    const names = ['ocean-tile', 'plaque-active', 'badge-complete', 'badge-crest'];
    for (let i = 0; i < 4; i++) names.push('smoke-' + i, 'crystal-' + i, 'waterfall-' + i);
    for (let i = 0; i < 3; i++) names.push('cloud-' + i, 'castle-glow-' + i, 'bolt-' + i);
    for (let i = 0; i < 4; i++) names.push('storm-' + i, 'clear-' + i);
    const jobs = [loadImage('assets/master-wallpaper.png').then(im => { IMG.map = im; })];
    for (const n of names) jobs.push(loadImage('assets/sprites/' + n + '.png').then(im => { IMG[n] = im; }));
    jobs.push(loadHero('human_m'), loadHero(state.hero));
    await Promise.all(jobs);
  }

  // Loads a traveler's four frames once; other characters load only when picked.
  const heroLoads = {};
  function loadHero(key) {
    const p = HEROES[key].prefix;
    const names = ['0', '1', '2', '3'];
    for (const [a] of ACT_ANIM) for (let i = 0; i < 4; i++) names.push(`${a}-${i}`);
    for (const a of COLD_ANIM) for (let i = 0; i < 4; i++) names.push(`${a}-${i}`);   // optional: missing ones are skipped
    if (HEROES[key].hair) names.push('hair');
    if (HEROES[key].skin) names.push('skin');
    heroLoads[key] = heroLoads[key] || Promise.all(names.map(i =>
      loadImage(`assets/sprites/${p}-${i}.png`).then(im => { IMG[`${p}-${i}`] = im; }, () => {})));
    return heroLoads[key];
  }

  // Hair recolouring: built once per traveler, frame and colour, then cached in IMG.
  function canvasOf(img, sx = 0, w = img.width) {
    const c = document.createElement('canvas');
    c.width = w; c.height = img.height;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, sx, 0, w, img.height, 0, 0, w, img.height);
    return { c, x, d: x.getImageData(0, 0, w, img.height) };
  }
  const lum = (d, i) => 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
  const lumRange = {};
  function maskLum(key, kind) {                                   // 5th..95th percentile brightness of the masked part
    const rk = key + kind;
    if (lumRange[rk]) return lumRange[rk];
    const p = HEROES[key].prefix;
    const px = canvasOf(IMG[`${p}-0`]).d.data, mk = canvasOf(IMG[`${p}-${kind}`], 0, HERO_CANVAS).d.data;
    const L = [];
    for (let i = 0; i < px.length; i += 4) if (mk[i + 3] > 127) L.push(lum(px, i));
    L.sort((a, b) => a - b);
    let lo = L[Math.floor(L.length * 0.05)] || 20, hi = L[Math.floor(L.length * 0.95)] || 200;
    if (hi - lo < 30) { const m = (lo + hi) / 2; lo = m - 15; hi = m + 15; }
    return (lumRange[rk] = { lo: Math.max(1, lo), hi });
  }
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  function recolor(key, frame, base, ramp, kind) {
    const idx = HAIR_FRAMES.indexOf(frame);
    const strip = IMG[`${HEROES[key].prefix}-${kind}`];
    if (idx < 0 || !strip) return base;
    try {
      const { lo, hi } = maskLum(key, kind);
      const [c0, c1, c2] = ramp.map(hex);
      const out = canvasOf(base), d = out.d.data;
      const mk = canvasOf(strip, idx * HERO_CANVAS, HERO_CANVAS).d.data;
      for (let i = 0; i < d.length; i += 4) {
        const w = mk[i + 3] / 255;
        if (!w || !d[i + 3]) continue;
        const L = lum(d, i), t = (L - lo) / (hi - lo);
        let r, g, b;
        if (t < 0) { const k = L / lo; [r, g, b] = c0.map(v => v * k); }
        else {
          const [a, z, u] = t <= 0.5 ? [c0, c1, t * 2] : [c1, c2, Math.min(1, t * 2 - 1)];
          [r, g, b] = a.map((v, j) => v + (z[j] - v) * u);
        }
        d[i] += (r - d[i]) * w; d[i + 1] += (g - d[i + 1]) * w; d[i + 2] += (b - d[i + 2]) * w;
      }
      out.x.putImageData(out.d, 0, 0);
      return out.c;
    } catch (_) { return base; }                                  // e.g. opened from file:// (tainted canvas)
  }
  function heroImage(key, frame, hair = state.hair, skin = state.skin) {
    const p = HEROES[key].prefix, base = IMG[`${p}-${frame}`];
    if (!base) return base;
    const hr = HEROES[key].hair && HAIR[hair] && HAIR[hair].ramp;
    const sr = HEROES[key].skin && SKIN[skin] && SKIN[skin].ramp;
    if (!hr && !sr) return base;
    const k = `${p}-${frame}@${hr ? hair : ''}~${sr ? skin : ''}`;
    if (!(k in IMG)) {                                            // skin first, then hair (the masks don't overlap)
      let im = base;
      if (sr) im = recolor(key, frame, im, sr, 'skin');
      if (hr) im = recolor(key, frame, im, hr, 'hair');
      IMG[k] = im;
    }
    return IMG[k];
  }

  // Sea: a bright, saturated mid blue (hue 185-215 deg, saturation > 0.55, value > 0.7). Snow, grey-blue rocks,
  // pillars, the observatory dome, waterfalls and surf are pale or grey; pine trees and shadows are darker.
  function isSea(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    if (mx < 179 || (mx - mn) / mx <= 0.55 || mx !== b) return false;   // blue-dominant, saturated and bright
    const h = 240 + 60 * (r - g) / (mx - mn);                              // hue when blue is the max
    return h >= 185 && h <= 215;
  }

  // Layer 2 setup: a mask of sea pixels below y = 35%, so islands stay untouched.
  function buildWaterMask() {
    const h = WORLD_H - WATER_TOP;
    const c = document.createElement('canvas');
    c.width = MAP_W; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(world || fireMap || IMG.map, 0, -WATER_TOP);
    let data, island = null;
    if (landLayer) island = landLayer.getContext('2d').getImageData(0, WATER_TOP, MAP_W, h).data;
    try { data = x.getImageData(0, 0, MAP_W, h); }
    catch (_) { console.warn('Deadline Quest: serve over http(s) to enable the ocean shimmer and PNG export.'); return; }
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
      const water = isSea(d[i], d[i + 1], d[i + 2]) && !(island && island[i + 3] > 10);
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = water ? 255 : 0;
    }
    x.putImageData(data, 0, 0);
    waterMask = c;
    buildSparkles(d, h);
    shimmer = document.createElement('canvas');
    shimmer.width = MAP_W; shimmer.height = h;
    oceanPattern = shimmer.getContext('2d').createPattern(IMG['ocean-tile'], 'repeat');
  }

  // Deterministic water glints: ~40 points that sit on open water (never on land).
  let sparkles = [];
  function buildSparkles(maskData, h) {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const at = (x, y) => maskData[(y * MAP_W + x) * 4 + 3];
    const isWater = (x, y) => x >= 3 && x < MAP_W - 3 && y >= 3 && y < h - 3 &&
      at(x, y) && at(x, y - 3) && at(x, y + 3) && at(x - 3, y) && at(x + 3, y);
    sparkles = [];
    const want = Math.round(42 * h / (MAP_H - WATER_TOP));
    for (let tries = 0; sparkles.length < want && tries < 5000 * want / 42; tries++) {
      const x = Math.floor(rnd() * MAP_W), y = Math.floor(rnd() * h);
      if (isWater(x, y)) sparkles.push({ x, y: y + WATER_TOP, phase: rnd() * Math.PI * 2, speed: 1.2 + rnd() * 1.2, big: rnd() < 0.3 });
    }
  }
  function drawSparkles(ctx, t, v) {
    for (const k of sparkles) {
      if (k.y < v.t - 4 || k.y > v.b + 4) continue;
      const b = Math.sin(t * k.speed + k.phase);
      if (b < 0.72) continue;                                       // only the crest of each cycle
      const a = (b - 0.72) / 0.28;
      ctx.globalAlpha = 0.35 + 0.6 * a;
      ctx.fillStyle = a > 0.6 ? '#ffffff' : '#fff8d6';
      ctx.fillRect(k.x, k.y, 1, 1);
      if (a > 0.35) {                                               // small pixel cross at the peak
        const r = k.big ? 2 : 1;
        ctx.fillRect(k.x - r, k.y, r, 1); ctx.fillRect(k.x + 1, k.y, r, 1);
        ctx.fillRect(k.x, k.y - r, 1, r); ctx.fillRect(k.x, k.y + 1, 1, r);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Basecamp flag and Observatory telescope are painted into the map. For the live view we lift
  // them into their own sprites, patch the hole they leave, and redraw them animated.
  const FLAG = { rect: [243, 1055, 50, 31], pole: 244 };
  const SCOPE = { rect: [213, 702, 36, 36], pivot: [220, 732] };
  let fenceSprite = null;
  let liveMap = null, fireMap = null, flagSprite = null, scopeSprite = null;

  function liftOut(ctx, rect, isPart, fillFrom) {
    const [rx, ry, rw, rh] = rect;
    const img = ctx.getImageData(rx, ry, rw, rh), d = img.data;
    const out = new ImageData(rw, rh), o = out.data;
    const mask = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4;
      if (isPart(d[i], d[i + 1], d[i + 2], rx + x, ry + y)) mask[y * rw + x] = 1;
    }
    // grow the mask by one pixel to take the dark outline with it
    const grown = mask.slice();
    const on = (x, y) => x >= 0 && y >= 0 && x < rw && y < rh && mask[y * rw + x];
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4;
      if (!mask[y * rw + x] && d[i] + d[i + 1] + d[i + 2] < 260 &&
          (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1))) grown[y * rw + x] = 1;
    }
    for (let k = 0; k < grown.length; k++) if (grown[k]) {
      o[k * 4] = d[k * 4]; o[k * 4 + 1] = d[k * 4 + 1]; o[k * 4 + 2] = d[k * 4 + 2]; o[k * 4 + 3] = 255;
    }
    fillFrom(d, grown, rw, rh);
    ctx.putImageData(img, rx, ry);
    const c = document.createElement('canvas');
    c.width = rw; c.height = rh;
    c.getContext('2d').putImageData(out, 0, 0);
    return c;
  }
  // Fill each lifted pixel by blending the nearest kept pixels above and below it.
  function fillVertical(d, m, w, h) {
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      if (!m[y * w + x]) continue;
      let a = y; while (a >= 0 && m[a * w + x]) a--;
      let b = y; while (b < h && m[b * w + x]) b++;
      const ia = a >= 0 ? (a * w + x) * 4 : -1, ib = b < h ? (b * w + x) * 4 : -1;
      if (ia < 0 && ib < 0) continue;
      const f = ia < 0 ? 1 : ib < 0 ? 0 : (y - a) / (b - a);
      const k = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = ia < 0 ? d[ib + c] : d[ia + c], bot = ib < 0 ? d[ia + c] : d[ib + c];
        d[k + c] = Math.round(top * (1 - f) + bot * f);
      }
    }
  }
  // Fill each lifted pixel with the nearest kept pixel above it (sky behind the telescope).
  function fillFromAbove(d, m, w, h) {
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      if (!m[y * w + x]) continue;
      let a = y; while (a > 0 && m[a * w + x]) a--;
      const src = (a * w + x) * 4, k = (y * w + x) * 4;
      d[k] = d[src]; d[k + 1] = d[src + 1]; d[k + 2] = d[src + 2];
    }
  }
  // Fill each lifted pixel with the pixel 46 rows below it (clean grass texture, no smearing).
  function fillCloneBelow(d, m, w, h) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      const sy = y + 46;
      if (sy >= h || m[sy * w + x]) continue;
      const k = (y * w + x) * 4, src = (sy * w + x) * 4;
      d[k] = d[src]; d[k + 1] = d[src + 1]; d[k + 2] = d[src + 2];
    }
  }


  function buildLiveMap() {
    const c = document.createElement('canvas');
    c.width = MAP_W; c.height = MAP_H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(IMG.map, 0, 0);
    try {
      flagSprite = liftOut(x, FLAG.rect, (r, g, b) => r > g + 55 && r > b + 55, fillVertical);
      scopeSprite = liftOut(x, SCOPE.rect, (r, g, b, px, py) => {
        const sky = b > r + 45 && b > 150;
        const aboveDome = py < 720 + (px - 210) * 1.27 - 1;          // the dome's top-right edge
        return !sky && aboveDome && px > 218;
      }, fillFromAbove);
      liveMap = c;
      // Basecamp scene: the campfire replaces the lantern. Patch the gap with grass from just below.
      const f = document.createElement('canvas');
      f.width = MAP_W; f.height = MAP_H;
      const fx = f.getContext('2d', { willReadFrequently: true });
      fx.drawImage(c, 0, 0);
      liftOut(fx, [159, 1136, 36, 96], (r, g, b, px, py) =>
        py < 1184 && !(g > r + 12 && g > b + 12) && !(py < 1143 && px > 182), fillCloneBelow);
      fireMap = f;
      // Workshop fence planks, redrawn over the traveler so they stand behind it in the field.
      const [fx0, fy0, fw, fh] = FENCE.rect;
      const fd = x.getImageData(fx0, fy0, fw, fh), p = fd.data;
      for (let i = 0; i < p.length; i += 4) {
        const r = p[i], g = p[i + 1], b = p[i + 2];
        const wood = r > g + 15 && g - b < 75 && r < 235, dark = r + g + b < 200;
        if (!(wood || dark) || g > r - 5) p[i + 3] = 0;
      }
      fenceSprite = document.createElement('canvas');
      fenceSprite.width = fw; fenceSprite.height = fh;
      fenceSprite.getContext('2d').putImageData(fd, 0, 0);
    } catch (_) { liveMap = fireMap = fenceSprite = null; }
  }

  // ------------------------------------------------------------------ world
  // The map can hold more than five islands. The painted sky, castle and shrine stay put as a top piece; the
  // Basecamp-Workshop-Observatory trio is cut out of the painting (ocean removed) and stacked below the shrine as
  // often as needed, every other copy mirrored so the zig-zag keeps alternating. The ocean is tiled from a patch of
  // the painting and stepping stones bridge the joints. With five islands the painted map is used untouched.
  const SKY_H = 1246, BOTTOM_H = MAP_H - SKY_H; // the painting's sky/ocean backdrop, and its bottom strip with the corner clouds
  const CLEAR_R = 48;                         // painted water is cleared this far around land (islands move)
  const SEA_FADE = [440, 480];                 // the painted distant sea fades into the tiled sea between these rows
  const OCEAN_PATCH = [616, 1114, 128, 128];  // open sea with even ripples: no ripple rings, no darker wave bands
  let world = null, landLayer = null, WORLD_H = MAP_H, worldOK = false;
  let skyPiece = null, bottomPiece = null, parts = [], stoneSprites = [], oceanFill = null, skyRows = null, castleCX = 585;
  let INST = [];

  function insertedHeight(n) { return n > MIN_MS ? (n - MIN_MS) * PITCH + SHRINE_GAP : 0; }
  function typeOf(i) { const n = state.ms.length; return i >= n - 2 ? 3 + (i - (n - 2)) : i % 3; }
  function placeOf(i) { return TYPES[typeOf(i)]; }
  function placeName(i) { const t = typeOf(i), k = t < 3 ? Math.floor(i / 3) : 0; return TYPES[t].name + (k ? ' ' + ROMAN[k] : ''); }
  // Where milestone i's island sits. Trio islands: trio k (0 = the painted one, at the bottom), mirrored on odd trios,
  // the whole lower map pushed down by the inserted height. The shrine and the castle stay where they are painted.
  // P maps a painted point into the world, R a rectangle; f is the facing sign (-1 on mirrored islands).
  function instOf(i) {
    const n = state.ms.length, INS = insertedHeight(n);
    let k = -1, mir = false, dx = 0, dy = 0;
    if (i < n - 2) { k = Math.floor(i / 3); mir = k % 2 === 1; dy = INS - k * TRIO_H; }
    const P = ([x, y]) => [(mir ? MAP_W - x : x) + dx, y + dy];
    const R = ([x, y, w, h]) => [(mir ? MAP_W - x - w : x) + dx, y + dy, w, h];
    return { k, mir, dx, dy, P, R, f: mir ? -1 : 1 };
  }
  function withInst(ctx, inst, fn) {
    ctx.save();
    ctx.translate((inst.mir ? MAP_W : 0) + inst.dx, inst.dy);
    if (inst.mir) ctx.scale(-1, 1);
    fn();
    ctx.restore();
  }

  // Cuts the pieces out of the fire map once: label the land (non-water) components below y = 640, tell the shrine,
  // the two upper stepping stones and the clouds apart from the three islands, and bake each into its own sprite.
  // Cuts the pieces out of the fire map once: label the land (non-water) components of the whole painting, keep the
  // clouds with the sky/ocean backdrop, and bake every island (with the stepping stones of its own path) into a sprite.
  function buildPieces() {
    worldOK = false;
    if (!fireMap) return;
    try {
      const src = fireMap.getContext('2d', { willReadFrequently: true });
      const H = MAP_H, d = src.getImageData(0, 0, MAP_W, H).data;
      const land = new Uint8Array(MAP_W * H), lab = new Int32Array(MAP_W * H), stack = new Int32Array(MAP_W * H);
      // islands are told apart with a loose water test (anything bluish), which keeps them separate; each island
      // then takes back the pale land next to it that the strict sea test says is not sea (see `pown` below)
      for (let p = 0; p < land.length; p++) { const i = p * 4; land[p] = d[i + 2] > d[i] + 40 ? 0 : 1; }
      // open water is what the picture's edges can reach; bluish pixels enclosed by land (towers, screens, banners)
      // belong to their island
      const open = new Uint8Array(MAP_W * H);
      let sp = 0;
      const seed = p => { if (!land[p] && !open[p]) { open[p] = 1; stack[sp++] = p; } };
      for (let x = 0; x < MAP_W; x++) { seed(x); seed((H - 1) * MAP_W + x); }
      for (let y = 0; y < H; y++) { seed(y * MAP_W); seed(y * MAP_W + MAP_W - 1); }
      while (sp) {
        const q = stack[--sp], x = q % MAP_W, y = (q / MAP_W) | 0;
        if (x > 0) seed(q - 1); if (x < MAP_W - 1) seed(q + 1); if (y > 0) seed(q - MAP_W); if (y < H - 1) seed(q + MAP_W);
      }
      for (let p = 0; p < land.length; p++) land[p] = open[p] ? 0 : 1;
      const comps = [null];
      for (let p = 0; p < land.length; p++) {
        if (!land[p] || lab[p]) continue;
        const id = comps.length, c = { id, n: 0, white: 0, sx: 0, sy: 0, x0: MAP_W, x1: 0, y0: H, y1: 0 };
        sp = 0; stack[sp++] = p; lab[p] = id;
        while (sp) {
          const q = stack[--sp], x = q % MAP_W, y = (q / MAP_W) | 0, i = q * 4;
          c.n++; c.sx += x; c.sy += y;
          if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
          if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 190 && Math.abs(d[i] - d[i + 2]) < 30) c.white++;
          const nb = [x > 0 ? q - 1 : -1, x < MAP_W - 1 ? q + 1 : -1, y > 0 ? q - MAP_W : -1, y < H - 1 ? q + MAP_W : -1];
          for (const r of nb) if (r >= 0 && land[r] && !lab[r]) { lab[r] = id; stack[sp++] = r; }
        }
        comps.push(c);
      }
      const at = (x, y) => lab[y * MAP_W + x];
      const castleId = at(590, 500), shrineId = at(470, 715);
      if (!castleId || !shrineId || comps[castleId].n < 5000 || comps[shrineId].n < 5000) throw new Error('map pieces not found');
      const cb = comps[castleId];
      castleCX = (cb.x0 + cb.x1) / 2;
      // clouds stay in the backdrop: whitish components away from the castle (its glow rays are cream too)
      const nearCastle = c => c.x1 >= cb.x0 - 10 && c.x0 <= cb.x1 + 10 && c.y1 >= cb.y0 - 10 && c.y0 <= cb.y1 + 10;
      const cloud = c => c.n > 150 && c.white / c.n > 0.6 && !nearCastle(c);
      // the island each component belongs to: land by the nearest signboard, stones by the path they sit on
      const owner = new Int8Array(comps.length).fill(-1);
      const big = comps.slice(1).filter(c => c.n >= 2000 && !cloud(c));    // the islands themselves
      for (const c of big) {
        const cx = c.sx / c.n, cy = c.sy / c.n;
        let best = -1, bd = Infinity;
        TYPES.forEach((T, t) => {
          const dd = Math.hypot(cx - (T.sign[0] + T.sign[2] / 2), cy - (T.sign[1] + T.sign[3] / 2));
          if (dd < bd) { bd = dd; best = t; }
        });
        owner[c.id] = best;
      }
      owner[castleId] = 4; owner[shrineId] = 3;
      // stepping stones go with the path they sit on; other loose bits (foam, rocks) go with the island whose box
      // holds them, or are left out
      const stones = new Set();
      TYPES.forEach((T, t) => [...T.entry, ...T.exit].forEach(([x, y]) => {
        const id = at(x, y);
        if (id && comps[id].n < 1500) { owner[id] = t; stones.add(id); }
      }));
      for (const c of comps.slice(1)) {
        if (c.n >= 2000 || cloud(c) || stones.has(c.id)) continue;
        const cx = c.sx / c.n, cy = c.sy / c.n;
        const hosts = big.filter(b => cx >= b.x0 - 12 && cx <= b.x1 + 12 && cy >= b.y0 - 12 && cy <= b.y1 + 12);
        const host = hosts.length === 1 ? hosts[0] : null;      // in two islands' boxes: ambiguous, left out
        owner[c.id] = host ? owner[host.id] : -1;
      }
      // pixel owners: each island's own land, grown up to GROW px into adjacent pale land (snow, grey rocks, surf,
      // the observatory dome, waterfalls, pine trees); shared regions go to whichever island is nearer
      const GROW = 30, N = MAP_W * H;
      const pown = new Int8Array(N).fill(-1), dist = new Uint8Array(N), queue = new Int32Array(N);
      let qh = 0, qt = 0;
      for (let q = 0; q < N; q++) if (lab[q] && owner[lab[q]] >= 0) { pown[q] = owner[lab[q]]; queue[qt++] = q; }
      while (qh < qt) {
        const q = queue[qh++];
        if (dist[q] >= GROW) continue;
        const x = q % MAP_W, y = (q / MAP_W) | 0;
        for (const r of [x > 0 ? q - 1 : -1, x < MAP_W - 1 ? q + 1 : -1, y > 0 ? q - MAP_W : -1, y < H - 1 ? q + MAP_W : -1]) {
          if (r < 0 || pown[r] >= 0 || lab[r]) continue;
          const i = r * 4;
          if (isSea(d[i], d[i + 1], d[i + 2])) continue;
          pown[r] = pown[q]; dist[r] = dist[q] + 1; queue[qt++] = r;
        }
      }
      const cut = (x0, y0, x1, y1, keep) => {
        const c = document.createElement('canvas');
        c.width = x1 - x0; c.height = y1 - y0;
        const img = src.getImageData(x0, y0, x1 - x0, y1 - y0), p = img.data;
        for (let yy = 0; yy < y1 - y0; yy++) for (let xx = 0; xx < x1 - x0; xx++) {
          const k = (yy * (x1 - x0) + xx) * 4;
          p[k + 3] = Math.round(255 * Math.max(0, Math.min(1, keep(x0 + xx, y0 + yy, at(x0 + xx, y0 + yy)))));
        }
        c.getContext('2d').putImageData(img, 0, 0);
        return c;
      };
      const boxes = TYPES.map(T => [MAP_W, MAP_H, 0, 0]);         // each island's box
      for (let q = 0; q < N; q++) {
        const t = pown[q]; if (t < 0) continue;
        const x = q % MAP_W, y = (q / MAP_W) | 0, b = boxes[t];
        if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x + 1 > b[2]) b[2] = x + 1; if (y + 1 > b[3]) b[3] = y + 1;
      }
      boxes.forEach((b, t) => { if (b[2] <= b[0]) throw new Error('island not found: ' + TYPES[t].name); });
      // gaps inside an island's outline (sea painted between pine branches, peaks and rocks) stay with the island:
      // close the island's mask by CLOSE px, then keep everything its outside can't reach
      const CLOSE = 3;
      const boxFilter = (m, w, h, r, max) => {                    // separable square max/min filter
        const t = new Uint8Array(w * h), o = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          let v = max ? 0 : 1;
          for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = max ? v | m[y * w + k] : v & m[y * w + k];
          t[y * w + x] = v;
        }
        for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
          let v = max ? 0 : 1;
          for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = max ? v | t[k * w + x] : v & t[k * w + x];
          o[y * w + x] = v;
        }
        return o;
      };
      boxes.forEach((b, t) => {
        const x0 = Math.max(0, b[0] - CLOSE - 1), y0 = Math.max(0, b[1] - CLOSE - 1);
        const x1 = Math.min(MAP_W, b[2] + CLOSE + 1), y1 = Math.min(H, b[3] + CLOSE + 1), w = x1 - x0, h = y1 - y0;
        const m = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = pown[(y0 + y) * MAP_W + x0 + x] === t ? 1 : 0;
        const closed = boxFilter(boxFilter(m, w, h, CLOSE, true), w, h, CLOSE, false);
        const out = new Uint8Array(w * h), st = [];
        const push = q => { if (!closed[q] && !out[q]) { out[q] = 1; st.push(q); } };
        for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
        for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
        while (st.length) {
          const q = st.pop(), x = q % w, y = (q / w) | 0;
          if (x > 0) push(q - 1); if (x < w - 1) push(q + 1); if (y > 0) push(q - w); if (y < h - 1) push(q + w);
        }
        for (let q = 0; q < w * h; q++) {
          const g = (y0 + ((q / w) | 0)) * MAP_W + x0 + (q % w);
          if (!out[q] && pown[g] < 0 && !(lab[g] && cloud(comps[lab[g]]))) pown[g] = t;
        }
      });
      // the backdrop: open water and clouds, cleared within CLEAR_R of any land (ripple rings, rock shadows and the
      // castle's halo fade into the blue, so the sky colour or the tiled ocean takes over there)
      const mark = new Uint8Array(MAP_W * H), clr = new Uint8Array(MAP_W * H);
      for (let p = 0; p < mark.length; p++) mark[p] = (lab[p] && !cloud(comps[lab[p]])) || pown[p] >= 0 ? 1 : 0;
      for (let y = 0; y < H; y++) {                               // horizontal pass
        let run = 0;
        for (let x = 0; x < MAP_W + CLEAR_R; x++) {
          if (x < MAP_W && mark[y * MAP_W + x]) run = 2 * CLEAR_R + 1;
          if (run && x >= CLEAR_R) clr[y * MAP_W + x - CLEAR_R] = 1;
          if (run) run--;
        }
      }
      for (let x = 0; x < MAP_W; x++) {                           // vertical pass
        let run = 0;
        for (let y = 0; y < H + CLEAR_R; y++) {
          if (y < H && clr[y * MAP_W + x] === 1) run = 2 * CLEAR_R + 1;
          if (run && y >= CLEAR_R) clr[(y - CLEAR_R) * MAP_W + x] |= 2;
          if (run) run--;
        }
      }
      // painted water is kept only for the sky and distant sea; nearer, the tiled sea takes over (one even texture)
      const seaKeep = y => Math.max(0, Math.min(1, (SEA_FADE[1] - y) / (SEA_FADE[1] - SEA_FADE[0])));
      // clouds keep their soft edge: pixels up to 4 px from a cloud that aren't sea
      const cloudEdge = new Uint8Array(N);
      const cq = [];
      for (let q = 0; q < N; q++) if (lab[q] && cloud(comps[lab[q]])) { cloudEdge[q] = 1; cq.push(q); }
      for (let step = 0; step < 4; step++) {
        const next = [];
        for (const q of cq) {
          const x = q % MAP_W, y = (q / MAP_W) | 0;
          for (const r of [x > 0 ? q - 1 : -1, x < MAP_W - 1 ? q + 1 : -1, y > 0 ? q - MAP_W : -1, y < H - 1 ? q + MAP_W : -1]) {
            if (r < 0 || cloudEdge[r] || lab[r] || pown[r] >= 0) continue;
            const i = r * 4;
            if (isSea(d[i], d[i + 1], d[i + 2])) continue;
            cloudEdge[r] = 1; next.push(r);
          }
        }
        cq.length = 0; cq.push(...next);
      }
      const backdrop = (x, y, id) => (id && cloud(comps[id])) || cloudEdge[y * MAP_W + x] ? 1
        : clr[y * MAP_W + x] & 2 || pown[y * MAP_W + x] >= 0 ? 0 : !id ? seaKeep(y) : 0;
      // sky and distant sea, one colour per row (the median of that row's open water): what shows wherever the
      // painting is cleared around a moved island, so the gap matches its surroundings; fades out into the tiled sea
      skyRows = document.createElement('canvas'); skyRows.width = 1; skyRows.height = SEA_FADE[1];
      const rows = skyRows.getContext('2d').createImageData(1, SEA_FADE[1]);
      let prev = [57, 155, 228];
      for (let y = 0; y < SEA_FADE[1]; y++) {
        const r = [], g = [], b = [];
        for (let x = 0; x < MAP_W; x++) if (!lab[y * MAP_W + x]) { const i = (y * MAP_W + x) * 4; r.push(d[i]); g.push(d[i + 1]); b.push(d[i + 2]); }
        const med = v => v.sort((p, q) => p - q)[v.length >> 1];
        if (r.length > 20) prev = [med(r), med(g), med(b)];
        rows.data.set([...prev, Math.round(255 * Math.min(1, (SEA_FADE[1] - y) / (SEA_FADE[1] - SEA_FADE[0])))], y * 4);
      }
      skyRows.getContext('2d').putImageData(rows, 0, 0);
      skyPiece = cut(0, 0, MAP_W, SKY_H, (x, y, id) => backdrop(x, y, id) * Math.min(1, (SKY_H - y) / 30));
      bottomPiece = cut(0, SKY_H, MAP_W, MAP_H, (x, y, id) => backdrop(x, y, id) * Math.min(1, (y - SKY_H) / 30));
      // painted stones to erase, inside each stone's ellipse: water or shadow, muted tan stone (sand top and side) and
      // dark muted outlines. Cliffs (a strongly saturated brown), pines and grass (green) stay.
      const erase = new Uint8Array(N);
      for (const [sx, sy] of PAINTED_STONES) {
        for (let y = sy - 15; y <= sy + 19; y++) for (let x = sx - 23; x <= sx + 23; x++) {
          if (((x - sx) / 22) ** 2 + ((y - sy - 2) / 16) ** 2 > 1) continue;
          const i = (y * MAP_W + x) * 4, r = d[i], g = d[i + 1], b = d[i + 2];
          const mx = Math.max(r, g, b), sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
          const water = b > g && b > r + 20, green = g > r && g >= b - 6 && !water;
          const stone = r > b + 25 && r >= g && sat < 0.55, outline = mx < 115 && sat < 0.5;
          if (!green && (water || stone || outline)) erase[y * MAP_W + x] = 1;
        }
      }
      const onStone = (x, y) => erase[y * MAP_W + x] === 1;
      // each island's cut-out, minus erased stones and any loose specks (pieces under 40 px left by the erasing)
      parts = boxes.map(([x0, y0, x1, y1], t) => {
        const w = x1 - x0, h = y1 - y0, m = new Uint8Array(w * h), seen = new Uint8Array(w * h);
        for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++)
          m[yy * w + xx] = pown[(y0 + yy) * MAP_W + x0 + xx] === t && !onStone(x0 + xx, y0 + yy) ? 1 : 0;
        for (let q = 0; q < w * h; q++) {
          if (!m[q] || seen[q]) continue;
          const piece = [q]; seen[q] = 1;
          for (let k = 0; k < piece.length; k++) {
            const c = piece[k], xx = c % w, yy = (c / w) | 0;
            for (const r of [xx > 0 ? c - 1 : -1, xx < w - 1 ? c + 1 : -1, yy > 0 ? c - w : -1, yy < h - 1 ? c + w : -1])
              if (r >= 0 && m[r] && !seen[r]) { seen[r] = 1; piece.push(r); }
          }
          if (piece.length < 40) for (const c of piece) m[c] = 0;
        }
        return { x: x0, y: y0, img: cut(x0, y0, x1, y1, (x, y) => m[(y - y0) * w + x - x0]) };
      });
      // the one stone shape that is laid between islands: a free-standing painted stone
      const sid = at(361, 921);
      if (!sid || comps[sid].n > 1500) throw new Error('no stepping stone found');
      const sc = comps[sid];
      stoneSprites = [cut(sc.x0, sc.y0, sc.x1 + 1, sc.y1 + 1, (x, y, i) => i === sid ? 1 : 0)];
      // ocean: a patch of open water mirrored into a seamless 2x2 tile
      const [px, py, pw, ph] = OCEAN_PATCH;
      const tile = document.createElement('canvas'); tile.width = pw * 2; tile.height = ph * 2;
      const tx = tile.getContext('2d');
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
        tx.save(); tx.translate(i ? pw * 2 : 0, j ? ph * 2 : 0); tx.scale(i ? -1 : 1, j ? -1 : 1);
        tx.drawImage(fireMap, px, py, pw, ph, 0, 0, pw, ph); tx.restore();
      }
      oceanFill = tx.createPattern(tile, 'repeat');
      worldOK = true;
    } catch (_) { worldOK = false; }
  }

  // Composes the world for the current chain and rebuilds the route and the water mask.
  function buildWorld() {
    const n = state.ms.length;
    INST = state.ms.map((_, i) => instOf(i));
    buildChain();
    WORLD_H = MAP_H + (worldOK ? insertedHeight(n) : 0);
    world = landLayer = null;
    if (worldOK) {
      const c = document.createElement('canvas');
      c.width = MAP_W; c.height = WORLD_H;
      const x = c.getContext('2d');
      x.fillStyle = oceanFill; x.fillRect(0, 0, MAP_W, WORLD_H);
      x.imageSmoothingEnabled = false;
      x.drawImage(skyRows, 0, 0, MAP_W, skyRows.height);
      x.drawImage(skyPiece, 0, 0);
      x.drawImage(bottomPiece, 0, WORLD_H - BOTTOM_H);
      const land = landLayer = document.createElement('canvas');   // the islands on their own, to test for water
      land.width = MAP_W; land.height = WORLD_H;
      const lx = land.getContext('2d', { willReadFrequently: true });
      for (let i = n - 1; i >= 0; i--) {
        const I = INST[i], part = parts[typeOf(i)];
        withInst(lx, I, () => lx.drawImage(part.img, part.x, part.y));
      }
      // stones only where they sit on water; drawn under the islands so the ones by an edge tuck under the cliff
      const s = stoneSprites[0];
      for (const [jx, jy] of STONES) {
        const px = Math.round(jx), py = Math.round(jy);
        if (px < 0 || px >= MAP_W || py < 0 || py >= WORLD_H || lx.getImageData(px, py, 1, 1).data[3] > 10) continue;
        x.drawImage(s, Math.round(jx - s.width / 2), Math.round(jy - s.height / 2));
      }
      x.drawImage(land, 0, 0);
      world = c;
    }
    if (IMG.map) buildWaterMask();
  }

  // The wave is built column by column at map resolution, then drawn once (no seams when scaled).
  let flagWave = null;
  function drawFlag(ctx, t) {
    const [rx, ry, rw, rh] = FLAG.rect, PAD = 3;
    if (!flagWave) { flagWave = document.createElement('canvas'); flagWave.width = rw + PAD * 2; flagWave.height = rh + PAD * 2; }
    const f = flagWave.getContext('2d');
    f.clearRect(0, 0, flagWave.width, flagWave.height);
    f.imageSmoothingEnabled = false;
    for (let col = 0; col < rw; col++) {
      const reach = Math.max(0, rx + col - FLAG.pole) / (rw - 1);   // 0 at the pole, 1 at the tip
      const dy = Math.round(Math.sin(t * 2.6 - col * 0.22) * 1.8 * reach);
      const dx = Math.round(Math.sin(t * 1.3) * 0.8 * reach);
      f.drawImage(flagSprite, col, 0, 1, rh, PAD + col + dx, PAD + dy, 1, rh);
    }
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(flagWave, rx - PAD, ry - PAD);
  }
  function drawScope(ctx, t) {
    const [rx, ry] = SCOPE.rect, [px, py] = SCOPE.pivot;
    const ang = Math.sin(t * 0.9) * 0.07 + Math.sin(t * 1.4) * 0.02;   // about ±5 degrees, slow
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scopeSprite, rx - px, ry - py);
    ctx.restore();
  }

  // ------------------------------------------------------- island activities
  // Shown only while the traveler is at that island:
  // 0 Basecamp: sitting on a log by a campfire, playing guitar · 1 Workshop: hoeing a field
  // 2 Observatory: sitting at a desk, typing · 3 Shrine: cross-legged on a cushion, eyes closed
  // 4 Castle: planting fireworks · 5 (goal complete): the fireworks show, on a loop
  const FIRE = [176, 1181];                       // centre of the fire, ground level
  const FENCE = { rect: [336, 978, 54, 38], spot: [366, 994] };   // fence planks; where the traveler hoes, behind them
  const SCREEN = [262, 783, 29, 17];              // the Observatory monitor's screen
  const hash = n => { n = Math.sin(n * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };

  function drawCampfire(ctx, t) {
    ctx.save();                                                   // drawn 1.5x so it reads next to the traveler
    ctx.translate(FIRE[0], FIRE[1]); ctx.scale(1.5, 1.5); ctx.translate(-FIRE[0], -FIRE[1]);
    drawCampfire1x(ctx, t);
    ctx.restore();
  }
  function drawCampfire1x(ctx, t) {
    const [cx, gy] = FIRE;
    const frame = Math.floor(t * 8) % 4;
    // stones, back row first
    for (let k = 0; k < 8; k++) {
      const a = Math.PI + k * Math.PI / 4;
      const sx = Math.round(cx + Math.cos(a) * 12) - 2, sy = Math.round(gy - 3 + Math.sin(a) * 3.5) - 1;
      if (Math.sin(a) > 0) continue;
      stone(ctx, sx, sy);
    }
    // crossed logs
    for (let i = 0; i < 15; i++) {
      ctx.fillStyle = i === 0 || i === 14 ? '#c99a5b' : '#6e4220';
      ctx.fillRect(cx - 7 + i, Math.round(gy - 3 - i * 0.28), 1, 3);
      ctx.fillRect(cx + 7 - i, Math.round(gy - 3 - i * 0.28), 1, 3);
    }
    // flames
    const base = gy - 5;
    for (let dx = -6; dx <= 6; dx++) {
      const h = Math.max(1, Math.round((6.5 - Math.abs(dx)) * 2.1 + hash(dx * 13 + frame * 7) * 4 - 1));
      const col = (len, c) => { ctx.fillStyle = c; ctx.fillRect(cx + dx, base - len, 1, len); };
      col(h, '#d9481c');
      if (Math.abs(dx) <= 4) col(Math.round(h * 0.72), '#ff9a1f');
      if (Math.abs(dx) <= 3) col(Math.round(h * 0.45), '#ffd84a');
      if (Math.abs(dx) <= 1) col(Math.round(h * 0.2), '#fff4c0');
      if (hash(dx * 5 + frame * 3) > 0.82) { ctx.fillStyle = '#ff9a1f'; ctx.fillRect(cx + dx, base - h - 2, 1, 1); }
    }
    // front stones over the logs
    for (let k = 0; k < 8; k++) {
      const a = Math.PI + k * Math.PI / 4;
      if (Math.sin(a) <= 0) continue;
      stone(ctx, Math.round(cx + Math.cos(a) * 12) - 2, Math.round(gy - 3 + Math.sin(a) * 3.5) - 1);
    }
    // sparks
    for (let i = 0; i < 6; i++) {
      const p = (t * 0.7 + i / 6) % 1;
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle = i % 2 ? '#ffd84a' : '#ff9a1f';
      ctx.fillRect(Math.round(cx + Math.sin(i * 3.1 + t * 2) * 4 + (i - 3) * 1.5), Math.round(base - 12 - p * 34), 1, 1);
    }
    ctx.globalAlpha = 1;
  }
  function stone(ctx, x, y) {
    ctx.fillStyle = '#3b3a40'; ctx.fillRect(x - 1, y - 1, 6, 5);
    ctx.fillStyle = '#8a8f99'; ctx.fillRect(x, y, 4, 3);
    ctx.fillStyle = '#c3c7cf'; ctx.fillRect(x, y, 3, 1);
  }
  function drawFireLight(ctx, t) {
    const f = 0.34 + 0.07 * Math.sin(t * 9) + 0.04 * Math.sin(t * 23);
    const g = ctx.createRadialGradient(FIRE[0], FIRE[1] - 14, 2, FIRE[0], FIRE[1] - 14, 70);
    g.addColorStop(0, 'rgba(255,170,60,0.9)');
    g.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = f;
    ctx.fillStyle = g;
    ctx.fillRect(FIRE[0] - 72, FIRE[1] - 86, 144, 144);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }


  function drawScreen(ctx, t, typing) {
    const [sx, sy, sw, sh] = SCREEN;
    ctx.fillStyle = '#0f2b33'; ctx.fillRect(sx, sy, sw, sh);
    const scroll = typing ? Math.floor(t * 3) : 0;
    const colors = ['#5fd38d', '#8fd3ff', '#ffd84a', '#e6e9ff'];
    let lastEnd = sx + 2, lastY = sy + 2;
    for (let k = 0; k < 5; k++) {
      const line = k + scroll, y = sy + 2 + k * 3;
      const indent = Math.floor(hash(line * 3.7) * 3) * 2;
      const len = 6 + Math.floor(hash(line * 9.1) * (sw - 10 - indent));
      ctx.fillStyle = colors[line % colors.length];
      ctx.fillRect(sx + 2 + indent, y, len, 1);
      lastEnd = sx + 2 + indent + len; lastY = y;
    }
    if (!typing || Math.floor(t * 2.5) % 2) { ctx.fillStyle = '#ffffff'; ctx.fillRect(Math.min(lastEnd + 1, sx + sw - 2), lastY - 1, 1, 3); }
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(sx, sy, sw, 1);
  }


  // Castle: the traveler plants three rockets beside a crate; when the goal is complete they launch.
  const ROCKETS = { x: 455, y: 524, colors: [['#e8433a', '#8e1f1a'], ['#3d8bff', '#1d4a9a'], ['#ffcf4a', '#a2700e']] };
  const SPARK_COLORS = [['#ffd84a', '#fff4c0'], ['#ff6a5a', '#ffd0c8'], ['#5fd3ff', '#e0f8ff'], ['#7dff8a', '#e6ffe8'], ['#ffffff', '#fff4c0'], ['#ff9a1f', '#ffe0a0']];
  const ROCKET_SCALE = 1.6;
  const rocketSpot = i => [ROCKETS.x + (i * 5 + 1.5) * ROCKET_SCALE, ROCKETS.y];

  function drawCrate(ctx) {
    ctx.save();
    ctx.translate(ROCKETS.x, ROCKETS.y); ctx.scale(ROCKET_SCALE, ROCKET_SCALE);
    ctx.fillStyle = '#3b2414'; ctx.fillRect(-11, -6, 8, 6);
    ctx.fillStyle = '#9a6332'; ctx.fillRect(-10, -5, 6, 4);
    ctx.fillStyle = '#c4884a'; ctx.fillRect(-10, -5, 6, 1);
    ctx.fillStyle = '#e8433a'; ctx.fillRect(-9, -8, 1, 3); ctx.fillStyle = '#ffcf4a'; ctx.fillRect(-7, -8, 1, 3);
    ctx.restore();
  }
  // One rocket with its base (bottom of the launch stick) at bx, by.
  function drawRocket(ctx, bx, by, i, fuseLit) {
    const [c, dark] = ROCKETS.colors[i % 3];
    ctx.save();
    ctx.translate(bx, by); ctx.scale(ROCKET_SCALE, ROCKET_SCALE);
    ctx.fillStyle = '#6e4220'; ctx.fillRect(0, -6, 1, 6);              // launch stick
    ctx.fillStyle = '#2a1606'; ctx.fillRect(-2, -15, 5, 10);
    ctx.fillStyle = c; ctx.fillRect(-1, -14, 3, 8);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(-1, -11, 3, 1);
    ctx.fillStyle = dark; ctx.fillRect(-1, -16, 3, 2); ctx.fillRect(0, -17, 1, 1);
    ctx.fillStyle = '#2a1606'; ctx.fillRect(0, -6, 1, 1);
    if (fuseLit) {
      ctx.fillStyle = '#fff4c0'; ctx.fillRect(0, -5, 1, 1);
      ctx.fillStyle = '#ffd84a'; ctx.fillRect(-1, -4, 1, 1); ctx.fillRect(1, -4, 1, 1);
    }
    ctx.restore();
  }

  // Planting loop at the castle: carry a rocket down, plant it, repeat x3, pause, start over.
  const PLANT_EACH = 2.2;
  function plantingState(t) {
    const k = Math.floor(t / PLANT_EACH) % 4, phase = (t % PLANT_EACH) / PLANT_EACH;
    if (k === 3) return { planted: 3, carrying: -1, phase };
    return { planted: phase > 0.72 ? k + 1 : k, carrying: phase > 0.72 ? -1 : k, phase };
  }

  // The finale: three rockets launch in turn, then a big three-shell finale from the crate.
  const SHOW_LEN = 9;
  const SHELLS = [                                                 // pos: x offset from the castle's centre, y
    { rocket: 0, at: 0.9, pos: [60, 185], color: 0, size: 1 },
    { rocket: 1, at: 1.7, pos: [-250, 600], color: 1, size: 1 },
    { rocket: 2, at: 2.5, pos: [80, 330], color: 2, size: 1 },
    { rocket: -1, at: 4.0, pos: [-80, 250], color: 3, size: 1.25 },
    { rocket: -1, at: 4.15, pos: [15, 115], color: 4, size: 1.25 },
    { rocket: -1, at: 4.3, pos: [40, 370], color: 5, size: 1.25 },
  ];
  const STILL_U = [1.05, 1.3, 0.85, 1.15, 0.95, 0.7];        // wallpaper: every shell mid-bloom
  function showRockets(ctx, ts, still) {
    drawCrate(ctx);
    SHELLS.forEach(sh => {
      if (sh.rocket < 0 || (!still && ts >= sh.at)) return;
      if (still) return;
      const [bx, by] = rocketSpot(sh.rocket);
      drawRocket(ctx, bx, by, sh.rocket, ts > sh.at - 0.6 && Math.floor(ts * 12) % 2 === 0);
    });
  }

  function drawFireworks(ctx, ts, still, castle) {
    const LAUNCH = 0.5, BLOOM = 2.0;
    SHELLS.forEach((sh, i) => {
      const u = still ? STILL_U[i] : ts - sh.at;
      if (u < 0 || u > LAUNCH + BLOOM) return;
      const bx = castle.P([castleCX, 0])[0] + sh.pos[0], by = sh.pos[1];
      const [c1, c2] = SPARK_COLORS[sh.color];
      const [d1] = SPARK_COLORS[(sh.color + 3) % SPARK_COLORS.length];
      const [sx, sy0] = castle.P(sh.rocket >= 0 ? rocketSpot(sh.rocket) : [ROCKETS.x - 10, ROCKETS.y]);
      const sy = sy0 - 26;
      if (u < LAUNCH) {                                               // the rocket climbing
        const q = 1 - Math.pow(1 - u / LAUNCH, 2);
        for (let k = 0; k <= 6; k++) {
          const qq = Math.max(0, q - k * 0.03);
          ctx.globalAlpha = k ? 0.8 - k * 0.11 : 1;
          ctx.fillStyle = k ? '#ffb347' : '#fff4c0';
          const size = k ? 1 : 2;
          ctx.fillRect(Math.round(sx + (bx - sx) * qq) - (size >> 1), Math.round(sy + (by - sy) * qq) - (size >> 1), size, size);
        }
        ctx.globalAlpha = 1;
        return;
      }
      const q = (u - LAUNCH) / BLOOM, fade = 1 - q, seed = i * 31;
      if (q < 0.12) {                                                 // the flash
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 0.85 * (1 - q / 0.12);
        ctx.fillStyle = c2;
        ctx.beginPath(); ctx.arc(bx, by, 26 * sh.size, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      const spread = 1 - Math.pow(1 - Math.min(1, q * 2), 3), drop = 26 * q * q;
      const rings = [[40, 1, c1, c2, 4], [22, 0.55, d1, '#ffffff', 3]];
      for (const [n, rs, col, early, head] of rings) {
        for (let k = 0; k < n; k++) {
          const a = k * Math.PI * 2 / n + hash(seed + 2 + rs) * 6.28;
          const v = (62 + hash(seed + k) * 16) * rs * sh.size;
          const ca = Math.cos(a), sa = Math.sin(a);
          const px = bx + ca * v * spread, py = by + sa * v * spread + drop;
          if (q < 0.5 && rs === 1) {
            ctx.globalAlpha = (0.5 - q) * 1.6;
            ctx.strokeStyle = col; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(bx + ca * v * spread * 0.45, by + sa * v * spread * 0.45 + drop * 0.5); ctx.lineTo(px, py); ctx.stroke();
          }
          ctx.globalAlpha = Math.min(1, fade * 1.4);
          ctx.fillStyle = q < 0.18 ? early : col;
          const size = q < 0.35 ? head : q < 0.75 ? 3 : 2;
          ctx.fillRect(Math.round(px - size / 2), Math.round(py - size / 2), size, size);
          if (q > 0.45 && hash(seed + k * 3 + rs + Math.floor(ts * 12)) > 0.65) {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(Math.round(px), Math.round(py + 3 + q * 6), 2, 2);
          }
        }
      }
      ctx.globalAlpha = 1;
    });
  }


  // Which activity the traveler is doing right now (or -1 while walking or cheering).
  function activity(live) {
    if (allDone()) return -1;                                      // celebrating: the fireworks show
    if (!live) return activeIndex();
    if (hero.moving || performance.now() < hero.cheerUntil) return -1;
    return PLACE_S.findIndex(d => Math.abs(d - hero.d) < 0.5);
  }

  // --------------------------------------------------------------- drawing
  // Draws a sprite; smooth when shrinking (avoids crunchy downsampling), pixelated when enlarging.
  function sprite(ctx, img, x, y, w, h) {
    const m = ctx.getTransform();
    ctx.imageSmoothingEnabled = w * Math.abs(m.a) < img.width * 0.95;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, x, y, w, h);
  }

  // The view: the map is scaled to cover the screen width (and the painted height), then a camera picks which
  // part of the taller world is on screen. camY is the world y at the top of the screen.
  function viewFor(cw, ch, camY) {
    const s = Math.max(cw / MAP_W, ch / MAP_H);
    const ox = (cw - MAP_W * s) / 2, visH = ch / s;
    return { s, ox, oy: -camY * s, visH, l: -ox / s, r: (cw - ox) / s, t: camY, b: camY + visH };
  }
  function clampCam(y, visH) {
    if (WORLD_H <= visH) return (WORLD_H - visH) / 2;              // the whole world fits: centred, as painted
    return Math.min(WORLD_H - visH, Math.max(0, y));
  }
  // Follow the traveler: their island sits low on the screen with the islands ahead above it. The camera rises to
  // keep the castle (and the countdown banner beside it) in view while the traveler still fits on screen; on a long
  // map with the traveler far below, it follows the traveler and the banner moves to the bottom (see drawBanner).
  function followCam(heroY, visH) {
    const cam = clampCam(heroY - visH * 0.78, visH), top = clampCam(bannerY() - visH * BANNER_MIN, visH);
    if (cam <= top) return cam;
    if (heroY - top <= visH * 0.88) return top;
    return clampCam(heroY - visH * 0.62, visH);
  }

  /** Render the full scene. live=false gives the clean static wallpaper composition. */
  function drawScene(ctx, cw, ch, t, live, camY) {
    const v = viewFor(cw, ch, camY);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#1e8fe0';
    ctx.fillRect(0, 0, cw, ch);
    ctx.setTransform(v.s, 0, 0, v.s, v.ox, v.oy);

    const n = state.ms.length, act = activity(live), T = live ? t : 0.3;
    sprite(ctx, world || fireMap || liveMap || IMG.map, 0, 0, MAP_W, WORLD_H);   // Layer 1
    for (let i = 0; i < n - 2; i++) {                              // painted props of every island copy
      const I = INST[i], ty = typeOf(i);
      withInst(ctx, I, () => {
        if (ty === 0) {
          if (flagSprite) { if (live) drawFlag(ctx, t); else { ctx.imageSmoothingEnabled = false; ctx.drawImage(flagSprite, FLAG.rect[0], FLAG.rect[1]); } }
          if (fireMap) drawCampfire(ctx, T);                       // the Basecamp fire always burns (no lantern)
        }
        if (ty === 2) { if (scopeSprite) drawScope(ctx, live ? t : 0); if (act === i) drawScreen(ctx, t, live); }
      });
    }
    const still = !live || reduceMotion.matches;
    const ts = still ? 0 : t % SHOW_LEN;
    const castle = INST[n - 1], shrine = INST[n - 2];
    withInst(ctx, castle, () => {
      if (act >= 0 && typeOf(act) === 4) {
        drawCrate(ctx);
        const st = live ? plantingState(t) : { planted: 2 };
        for (let i = 0; i < st.planted; i++) drawRocket(ctx, ...rocketSpot(i), i, false);
      }
      if (allDone()) showRockets(ctx, ts, still);
    });
    if (live) {
      drawShimmer(ctx, t, v);                                      // Layer 2
      drawClouds(ctx, t);                                          // Layer 3
      withInst(ctx, castle, () => drawWaterfalls(ctx, t));         // Layer 4
      for (let i = 0; i < n - 2; i++) if (typeOf(i) === 1) withInst(ctx, INST[i], () => drawSmoke(ctx, t));   // Layer 5
      drawGlow(ctx, t, shrine, castle);                            // Layer 6
    }
    drawPlaques(ctx, t, live);                                     // Layer 7
    drawHero(ctx, t, live, act);                                   // Layer 8
    if (fireMap) for (let i = 0; i < n - 2; i++) if (typeOf(i) === 0) withInst(ctx, INST[i], () => drawFireLight(ctx, T));
    if (allDone()) drawFireworks(ctx, ts, still, castle);
    drawStorms(ctx, t, live);                                      // overdue milestones
    drawBanner(ctx, v);                                            // Layer 9
  }

  function drawShimmer(ctx, t, v) {
    if (!waterMask) return;
    const s = shimmer.getContext('2d');
    const h = shimmer.height;
    const y0 = Math.max(0, Math.floor(v.t) - WATER_TOP), y1 = Math.min(h, Math.ceil(v.b) - WATER_TOP);   // visible band only
    if (y1 <= y0) return;
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, MAP_W, h);
    s.fillStyle = oceanPattern;
    const STRIP = 6;
    for (let y = y0 - y0 % STRIP; y < y1; y += STRIP) {
      const ox = t * 2.2 + Math.sin(y * 0.045 + t * 0.5) * 2.5;   // very slow drift + gentle wave
      oceanPattern.setTransform(new DOMMatrix().translateSelf(ox, -t * 0.6).scaleSelf(0.5));
      s.fillRect(0, y, MAP_W, STRIP);
    }
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(waterMask, 0, 0);
    ctx.globalAlpha = 0.18;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(shimmer, 0, y0, MAP_W, y1 - y0, 0, WATER_TOP + y0, MAP_W, y1 - y0);
    ctx.globalAlpha = 1;
    drawSparkles(ctx, t, v);
  }

  const CLOUDS = [
    { img: 'cloud-0', y: 0.30, speed: 6, scale: 0.42, x0: 120 },
    { img: 'cloud-2', y: 0.62, speed: 4, scale: 0.40, x0: 520 },
    { img: 'cloud-1', y: 0.92, speed: 8, scale: 0.36, x0: 330 },
  ];
  function drawClouds(ctx, t) {
    const span = SKY[1] - SKY[0];
    ctx.globalAlpha = 0.95;
    for (const c of CLOUDS) {
      const im = IMG[c.img];
      const w = im.width * c.scale, h = im.height * c.scale;
      const loop = MAP_W + w;
      const x = ((c.x0 + c.speed * t) % loop + loop) % loop - w;
      const y = SKY[0] + span * c.y - h;
      sprite(ctx, im, Math.round(x), Math.round(y), w, h);
    }
    ctx.globalAlpha = 1;
  }

  function drawWaterfalls(ctx, t) {
    const f = Math.floor(t * 6) % 4;                               // 6 FPS
    ctx.globalAlpha = 0.9;
    for (const [x, y, w, h] of WATERFALLS) sprite(ctx, IMG['waterfall-' + f], x, y, w, h);
    ctx.globalAlpha = 1;
  }

  function drawSmoke(ctx, t) {
    const LIFE = 1.0;                                               // 4 frames × 250 ms
    for (let k = 0; k < 3; k++) {
      const p = ((t / LIFE) + k / 3) % 1;
      const f = Math.min(3, Math.floor(p * 4));                     // 4 FPS frame steps
      const q = (f + 0.5) / 4;                                      // position steps with the frame
      const im = IMG['smoke-' + f];
      const w = 14 + q * 22, h = w * im.height / im.width;
      ctx.globalAlpha = 0.85 * (1 - q * 0.9);
      sprite(ctx, im, CHIMNEY[0] - w * 0.35 + q * 26, CHIMNEY[1] - h - q * 46, w, h);
    }
    ctx.globalAlpha = 1;
  }

  function drawGlow(ctx, t, shrine, castle) {
    const a = 0.4 + 0.35 * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI / 3.5));   // 40%–75%, 3.5 s
    withInst(ctx, shrine, () => {
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = a;
      const g = ctx.createRadialGradient(CRYSTAL[0], CRYSTAL[1], 2, CRYSTAL[0], CRYSTAL[1], 48);
      g.addColorStop(0, 'rgba(214,150,255,0.9)');
      g.addColorStop(1, 'rgba(120,60,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(CRYSTAL[0] - 50, CRYSTAL[1] - 50, 100, 100);
      const cr = IMG['crystal-' + (Math.floor(t * 4) % 4)];
      const cw = cr.width * 0.3, chh = cr.height * 0.3;
      sprite(ctx, cr, CRYSTAL[0] - cw / 2, CRYSTAL[1] - chh / 2, cw, chh);
    });
    withInst(ctx, castle, () => {
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = a;
      const g = ctx.createRadialGradient(CASTLE[0], CASTLE[1], 4, CASTLE[0], CASTLE[1], 120);
      g.addColorStop(0, 'rgba(255,214,110,0.75)');
      g.addColorStop(1, 'rgba(255,170,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(CASTLE[0] - 120, CASTLE[1] - 120, 240, 240);
      const cg = IMG['castle-glow-' + (Math.floor(t * 3) % 3)];
      const gw = 24, gh = gw * cg.height / cg.width;
      sprite(ctx, cg, CASTLE[0] - gw / 2, CASTLE[1] + 4 - gh / 2, gw, gh);
    });
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function fitFont(ctx, text, weight, family, max, min, width) {
    for (let size = max; size >= min; size -= 0.5) {
      ctx.font = `${weight} ${size}px ${family}`;
      if (ctx.measureText(text).width <= width) return size;
    }
    return 0;
  }
  function wrap2(ctx, text, width) {
    const words = text.split(/\s+/);
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
      const w = Math.max(ctx.measureText(a).width, ctx.measureText(b).width);
      if (!best || w < best.w) best = { a, b, w };
    }
    return best;
  }
  function ellipsize(ctx, text, width) {
    if (ctx.measureText(text).width <= width) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > width) text = text.slice(0, -1);
    return text.trimEnd() + '…';
  }

  // ------------------------------------------------------- overdue storms
  // A storm cloud sits over any island whose milestone is past its date and still open. 1-2 days late: light rain.
  // 3+ days: heavy rain and lightning. Completing it plays the clearing animation (sky breaks up, gold sparkles).
  const STORM_W = 176, CLEAR_LEN = 1.8;
  const clears = {};                                              // milestone index -> performance.now() when cleared
  function stormLevel(d) { return d >= 3 ? 2 : d >= 1 ? 1 : 0; }

  function drawStorms(ctx, t, live) {
    const still = !live || reduceMotion.matches;
    state.ms.forEach((m, i) => {
      const lvl = stormLevel(daysLate(i));
      if (lvl) drawStorm(ctx, i, lvl, t, still);
      else if (live && clears[i]) {
        const e = (performance.now() - clears[i]) / 1000;
        if (e < CLEAR_LEN && !reduceMotion.matches) drawClearing(ctx, i, e); else delete clears[i];
      }
    });
  }

  function drawStorm(ctx, i, lvl, t, still) {
    const [cx, cy] = INST[i].P(placeOf(i).storm);
    const cloud = IMG['storm-' + (still ? 0 : Math.floor(t * 2.2 + i) % 4)];
    const w = STORM_W, h = w * cloud.height / cloud.width;
    const base = cy + h * 0.32;                                   // underside of the cloud
    // gloom over the island
    const g = ctx.createRadialGradient(cx, base + 95, 10, cx, base + 95, 190);
    g.addColorStop(0, `rgba(24,28,58,${lvl === 2 ? 0.34 : 0.24})`);
    g.addColorStop(1, 'rgba(24,28,58,0)');
    ctx.fillStyle = g;
    ctx.fillRect(cx - 200, base - 100, 400, 400);
    // rain: slanted streaks falling from the cloud's underside onto the island
    const drops = lvl === 2 ? 70 : 34, fall = 150, speed = lvl === 2 ? 190 : 150;
    ctx.strokeStyle = lvl === 2 ? 'rgba(214,226,255,0.85)' : 'rgba(214,226,255,0.7)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let k = 0; k < drops; k++) {
      const sx = cx - w * 0.4 + hash(i * 97 + k) * w * 0.8;
      const ph = (hash(i * 31 + k * 7) + (still ? 0 : t * speed / fall)) % 1;
      const y = base + ph * fall, x = sx - ph * fall * 0.18;
      ctx.moveTo(x, y); ctx.lineTo(x - 2, y + 9);
    }
    ctx.stroke();
    // lightning: a double flicker every few seconds (one still bolt in the exported wallpaper)
    if (lvl === 2) {
      const period = 4.2 + i * 0.7, u = (t + i * 1.9) % period;
      const flash = still ? true : (u < 0.09 || (u > 0.16 && u < 0.24));
      if (flash && !(reduceMotion.matches && !still)) {
        const n = Math.floor((t + i * 1.9) / period) + i;
        const b = IMG['bolt-' + (still ? 1 : n % 3)];
        const bw = 52, bh = bw * b.height / b.width;
        const bx = cx - 30 + hash(n * 13) * 50;
        if (!still) {
          const f = ctx.createRadialGradient(bx, base + 40, 5, bx, base + 40, 160);
          f.addColorStop(0, 'rgba(235,240,255,0.35)'); f.addColorStop(1, 'rgba(235,240,255,0)');
          ctx.fillStyle = f; ctx.fillRect(bx - 160, base - 120, 320, 320);
        }
        sprite(ctx, b, bx - bw / 2, base - 6, bw, bh);
      }
    }
    sprite(ctx, cloud, cx - w / 2, cy - h / 2, w, h);
  }

  function drawClearing(ctx, i, e) {
    const [cx, cy] = INST[i].P(placeOf(i).storm);
    const f = Math.min(3, Math.floor(e / CLEAR_LEN * 4));
    const im = IMG['clear-' + f], w = STORM_W, h = w * im.height / im.width;
    ctx.globalAlpha = Math.min(1, (CLEAR_LEN - e) / 0.4);
    sprite(ctx, im, cx - w / 2, cy - h / 2, w, h);
    // gold sparkles bursting out of the gap
    const q = e / CLEAR_LEN;
    for (let k = 0; k < 26; k++) {
      const a = hash(i * 7 + k) * Math.PI * 2, r = (12 + hash(k * 3 + i) * 70) * Math.min(1, q * 1.6);
      const x = cx + Math.cos(a) * r, y = cy + 6 + Math.sin(a) * r * 0.6 + q * q * 24;
      ctx.globalAlpha = Math.max(0, 1 - q) * (0.6 + 0.4 * Math.sin(e * 20 + k));
      ctx.fillStyle = k % 3 ? '#ffd84a' : '#fff6cf';
      const sz = k % 4 === 0 ? 3 : 2;
      ctx.fillRect(Math.round(x), Math.round(y), sz, sz);
    }
    ctx.globalAlpha = 1;
  }

  function drawPlaques(ctx, t, live) {
    const act = activeIndex(), n = state.ms.length;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    state.ms.forEach((m, i) => {
      const [x, y, w, h] = INST[i].R(placeOf(i).sign);
      const isCastle = i === n - 1;
      const status = m.done ? 'done' : i === act ? 'now' : 'later';

      if (status === 'now') sprite(ctx, IMG['plaque-active'], x - 7, y - 7, w + 14, h + 14);
      const late = daysLate(i);
      if (late) {                                                  // overdue: pulsing red frame
        ctx.save();
        ctx.globalAlpha = live && !reduceMotion.matches ? 0.65 + 0.35 * Math.sin(t * 4) : 1;
        ctx.strokeStyle = '#e8352a'; ctx.lineWidth = 3;
        ctx.strokeRect(x - 3, y - 3, w + 6, h + 6);
        ctx.restore();
      }

      const ink = status === 'later' ? '#76563a' : '#3b2414';
      const innerW = w - 16;
      const task = m.task.trim() || placeName(i);
      ctx.fillStyle = ink;

      if (isCastle) {                                              // text starts right of the crest
        const tw = w - 30, cx = x + 20 + tw / 2;
        const size = fitFont(ctx, task.toUpperCase(), 600, FONT_PIXEL, 15, 8, tw);
        ctx.font = `600 ${size || 8}px ${FONT_PIXEL}`;
        ctx.fillText(ellipsize(ctx, task.toUpperCase(), tw), cx, y + h / 2 + 1);
      } else {
        let dateTxt = (status === 'now' ? '▶ ' : '') + fmtShort(m.date);
        if (late) {
          ctx.font = `400 7.5px ${FONT_DISPLAY}`;
          dateTxt = `${late} DAY${late > 1 ? 'S' : ''} LATE`;
          if (ctx.measureText(dateTxt).width > innerW) dateTxt = `${late}D LATE`;
        }
        let size = fitFont(ctx, task, 600, FONT_PIXEL, 15, 11, innerW);
        if (size) {
          ctx.font = `600 ${size}px ${FONT_PIXEL}`;
          ctx.fillText(task, x + w / 2, y + h * 0.38);
        } else {
          ctx.font = `600 12px ${FONT_PIXEL}`;
          const two = wrap2(ctx, task, innerW);
          if (two) {
            const longer = ctx.measureText(two.a).width >= ctx.measureText(two.b).width ? two.a : two.b;
            size = fitFont(ctx, longer, 600, FONT_PIXEL, 12, 8.5, innerW);
          }
          ctx.font = `600 ${size || 8.5}px ${FONT_PIXEL}`;
          if (two) {
            ctx.fillText(ellipsize(ctx, two.a, innerW), x + w / 2, y + h * 0.24);
            ctx.fillText(ellipsize(ctx, two.b, innerW), x + w / 2, y + h * 0.5);
          } else {
            ctx.fillText(ellipsize(ctx, task, innerW), x + w / 2, y + h * 0.38);
          }
        }
        ctx.font = `400 7.5px ${FONT_DISPLAY}`;
        ctx.fillStyle = late ? '#c8231a' : status === 'now' ? '#b4410c' : status === 'done' ? '#2f7d48' : '#76563a';
        ctx.fillText(dateTxt, x + w / 2, y + h * 0.77);
      }

      if (isCastle) {
        const im = IMG['badge-crest'], bw = 30, bh = bw * im.height / im.width;
        sprite(ctx, im, x - 20, y + h / 2 - bh / 2 - 2, bw, bh);
      }
      if (status === 'done') {
        const im = IMG['badge-complete'], bw = 34, bh = bw * im.height / im.width;
        sprite(ctx, im, x + w - 24, y - bh + 10, bw, bh);
      }

      if (live && state.selected === i) {
        const pulse = reduceMotion.matches ? 0.9 : 0.55 + 0.45 * Math.sin(t * 5);
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        ctx.lineDashOffset = -t * 12;
        ctx.strokeRect(x - 10, y - 10, w + 20, h + 20);
        ctx.restore();
      }
    });
  }

  function drawHero(ctx, t, live, act) {
    const cold = act >= 0 && act < state.ms.length && daysLate(act) > 0;   // caught in the storm: stop and shiver
    if (cold) act = -1;
    const ty = act >= 0 ? typeOf(act) : -1, I = act >= 0 ? INST[act] : null;   // island type and placement (mirrored copies face the other way)
    let x, y, frame, squash = 1, face = 1;
    const finished = allDone();
    if (live) {
      [x, y] = pointAt(hero.d); face = hero.face;
      if (hero.moving) {
        frame = 1 + (Math.floor(t * 8) % 2);                       // 2-frame walk cycle
        y -= (Math.floor(t * 8) % 2) * 1.5;
      } else if (finished || performance.now() < hero.cheerUntil) {
        frame = 3;
      } else {
        frame = 0;
        squash = [1, 0.985, 0.97, 0.985][Math.floor(t * 3) % 4];    // idle breathing at 3 FPS
      }
    } else {
      [x, y] = pointAt(heroTarget());
      frame = finished ? 3 : 0;
    }
    let carry = null;
    const anim = ty >= 0 && ty < 4 ? ACT_ANIM[ty] : null;          // drawn island activities
    if (anim) {
      frame = `${anim[0]}-${live ? Math.floor(t * anim[1]) % 4 : anim[2]}`;
      face = I.f; squash = 1;
    }
    else if (ty === 4) {                                           // planting rockets
      face = -I.f;
      const st = live ? plantingState(t) : { carrying: 2, phase: 0.45 };
      if (st.carrying >= 0) {
        const [gx, gy] = I.P(rocketSpot(st.carrying));
        const down = Math.min(1, Math.max(0, (st.phase - 0.2) / 0.5));
        squash = 1 - down * 0.08;
        carry = { i: st.carrying, x: x - 13 * face + (gx - (x - 13 * face)) * down, y: y - 14 + (gy - (y - 14)) * down };
      }
    }
    if (ty === 1) { [x, y] = I.P(FENCE.spot); face = -I.f; }         // in the field, behind the fence, facing left
    // Drawn cold frames: each available animation for a second in turn. Stills show the cold breath.
    const pre = HEROES[state.hero].prefix;
    const coldAnims = COLD_ANIM.filter(a => IMG[`${pre}-${a}-0`]);
    const coldArt = cold && frame === 0 && coldAnims.length > 0;
    if (coldArt) {
      squash = 1;
      if (!live || reduceMotion.matches) frame = coldAnims.includes('breath') ? 'breath-2' : `${coldAnims[0]}-1`;
      else {
        const u = t % coldAnims.length, a = coldAnims[Math.floor(u)];
        frame = `${a}-${Math.floor((u % 1) * COLD_FPS[a]) % 4}`;
      }
    }
    // a newly picked traveler may still be loading: show their idle frame, or the default traveler's, meanwhile
    const im = heroImage(state.hero, String(frame)) || IMG[`${pre}-0`] || IMG['hero-0'];
    if (!im) return;
    const w = HERO_CANVAS * HERO_SCALE, h = w;

    ctx.save();
    ctx.fillStyle = 'rgba(20,40,20,0.28)';                          // contact shadow
    ctx.beginPath(); ctx.ellipse(x, y - 1, 13, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.translate(x, y);
    ctx.scale(face, squash);
    sprite(ctx, im, -w / 2, -HERO_FEET * HERO_SCALE, w, h);
    ctx.restore();

    if (ty === 1 && fenceSprite) withInst(ctx, I, () => { ctx.imageSmoothingEnabled = false; ctx.drawImage(fenceSprite, FENCE.rect[0], FENCE.rect[1]); });
    if (carry) drawRocket(ctx, carry.x, carry.y, carry.i, false);
  }

  function pixelPanel(ctx, x, y, w, h, u) {
    const box = (bx, by, bw, bh, c) => {
      ctx.fillStyle = c;
      ctx.fillRect(bx + u, by, bw - 2 * u, bh);
      ctx.fillRect(bx, by + u, bw, bh - 2 * u);
    };
    box(x + u, y + u, w, h, 'rgba(0,0,0,0.45)');                    // drop shadow
    box(x, y, w, h, '#2a1606');                                      // outline
    box(x + u, y + u, w - 2 * u, h - 2 * u, '#ffcf4a');              // gold frame
    box(x + 2 * u, y + 2 * u, w - 4 * u, h - 4 * u, '#2a1606');
    box(x + 3 * u, y + 3 * u, w - 6 * u, h - 6 * u, 'rgba(22,29,74,0.94)');
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x + 4 * u, y + 3 * u, w - 8 * u, u);
  }

  function bannerText() {
    const d = daysUntil(goal().date);
    if (allDone()) return { big: 'QUEST', bigTail: 'COMPLETE!', line: goal().task };
    if (d > 1) return { big: String(d), bigTail: 'DAYS LEFT', line: 'until ' + goal().task };
    if (d === 1) return { big: '1', bigTail: 'DAY LEFT', line: 'until ' + goal().task };
    if (d === 0) return { big: 'D-DAY', bigTail: 'TODAY!', line: goal().task };
    return { big: String(-d), bigTail: 'DAYS OVER', line: goal().task };
  }

  // Sits on the left beside the Final Castle, below the lock screen's clock (at least BANNER_MIN of the way down).
  // When the castle is scrolled out of that spot (a long map with the traveler far below) it moves to the bottom of
  // the screen, between the lock screen's flashlight and camera buttons, where the follow camera leaves water.
  // Android lock screens put a larger clock lower down (date and widgets end about 35% of the way down), so there the
  // banner sits a little lower, beside the castle's cliff.
  const BANNER_H = 88, BANNER_R = 428, BANNER_MIN = 0.3, BANNER_BOTTOM = 44;
  function bannerY() { return state.device === 'android' || APP_OS === 'android' ? BANNER_Y_ANDROID : BANNER_Y; }
  function drawBanner(ctx, v) {
    const H = BANNER_H, cy = bannerY();
    let x, y, W;
    if (cy >= v.t + v.visH * BANNER_MIN - 0.5) {             // beside the castle
      const L = Math.max(v.l + 14, 22), R = Math.min(BANNER_R, v.r - 14);
      W = Math.min(332, R - L);
      x = Math.round(L + (R - L - W) / 2); y = Math.round(cy - H / 2);
    } else {                                                        // at the bottom
      W = Math.min(332, v.r - v.l - 28);
      x = Math.round((v.l + v.r) / 2 - W / 2); y = Math.round(v.b - BANNER_BOTTOM - H);
    }
    pixelPanel(ctx, x, y, W, H, 3);

    const crest = IMG['badge-crest'];
    const cw = 50, chh = cw * crest.height / crest.width;
    sprite(ctx, crest, x + 12, y + H / 2 - chh / 2, cw, chh);

    const tx = x + 72, tw = W - 72 - 14;
    const b = bannerText();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    let bigSize = fitFont(ctx, b.big, 400, FONT_DISPLAY, 24, 12, tw * 0.55);
    ctx.font = `400 ${bigSize || 12}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#3a1c00';
    ctx.fillText(b.big, tx + 2, y + 39);
    ctx.fillStyle = '#ffcf4a';
    ctx.fillText(b.big, tx, y + 37);
    const bw = ctx.measureText(b.big).width;
    const tailSize = fitFont(ctx, b.bigTail, 400, FONT_DISPLAY, 10, 6, tw - bw - 8);
    ctx.font = `400 ${tailSize || 6}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#fff3c9';
    ctx.fillText(b.bigTail, tx + bw + 8, y + 37);

    const lineSize = fitFont(ctx, b.line, 600, FONT_PIXEL, 15, 9, tw);
    ctx.font = `600 ${lineSize || 9}px ${FONT_PIXEL}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(ellipsize(ctx, b.line, tw), tx, y + 58);

    ctx.font = `500 11px ${FONT_PIXEL}`;
    ctx.fillStyle = '#a9c4ff';
    ctx.fillText(ellipsize(ctx, `${fmtLong(goal().date).toUpperCase()} · ${doneCount()}/${state.ms.length} CLEARED`, tw), tx, y + 74);
  }

  // ------------------------------------------------------------ hero motion
  // The whole route is one polyline: island 0, its stepping stones, island 1, ... the castle.
  // The hero lives at a distance along it and walks toward a target distance.
  let CHAIN = [], CUM = [0], PLACE_S = [], STONES = [];
  function buildChain() {
    CHAIN = []; PLACE_S = []; STONES = [];
    const n = state.ms.length;
    state.ms.forEach((_, i) => {
      const T = placeOf(i), I = INST[i];
      if (i) {                                                      // land on this island, then walk to the spot
        CHAIN.push(...T.entry.map(I.P));
      }
      PLACE_S.push(CHAIN.length);
      CHAIN.push(I.P(T.hero));
      if (i < n - 1) {                                              // leave, then cross on evenly spaced stones
        CHAIN.push(...T.exit.map(I.P));
        const N = placeOf(i + 1), J = INST[i + 1];
        const [ax, ay] = I.P(T.out), [bx, by] = J.P(N.in);
        const k = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / STONE_STEP));
        for (let s = 0; s <= k; s++) {
          const p = [ax + (bx - ax) * s / k, ay + (by - ay) * s / k];
          STONES.push(p); CHAIN.push(p);
        }
      }
    });
    CUM = [0];
    for (let k = 1; k < CHAIN.length; k++) CUM.push(CUM[k - 1] + Math.hypot(CHAIN[k][0] - CHAIN[k - 1][0], CHAIN[k][1] - CHAIN[k - 1][1]));
    PLACE_S = PLACE_S.map(n => CUM[n]);
  }

  function pointAt(dist) {
    dist = Math.max(0, Math.min(CUM[CUM.length - 1], dist));
    let k = 1;
    while (k < CUM.length - 1 && CUM[k] < dist) k++;
    const f = (dist - CUM[k - 1]) / ((CUM[k] - CUM[k - 1]) || 1);
    return [CHAIN[k - 1][0] + (CHAIN[k][0] - CHAIN[k - 1][0]) * f, CHAIN[k - 1][1] + (CHAIN[k][1] - CHAIN[k - 1][1]) * f];
  }

  // The hero stands at the current milestone's island and walks on when it is marked complete.
  function heroTarget() { return PLACE_S[activeIndex()]; }

  function retarget(force) {
    const goal = heroTarget();
    if (!force && goal === hero.goal) return;
    hero.goal = goal;
    cam.follow = true;                                             // the camera walks with them
    if (reduceMotion.matches) snapHero();
    requestRender();
  }
  function snapHero() {
    hero.d = hero.goal = heroTarget();
    hero.moving = false;
  }
  function stepHero(dt) {
    if (performance.now() < hero.cheerUntil) { hero.moving = false; return; }
    const diff = hero.goal - hero.d;
    if (Math.abs(diff) < 0.01) { hero.d = hero.goal; hero.moving = false; hero.face = 1; return; }
    const before = pointAt(hero.d)[0];
    hero.d += Math.sign(diff) * Math.min(Math.abs(diff), 105 * dt);   // map px per second
    const dx = pointAt(hero.d)[0] - before;
    if (Math.abs(dx) > 0.05) hero.face = dx < 0 ? -1 : 1;
    hero.moving = true;
  }

  buildWorld();                                                    // route only, until the map has loaded
  snapHero();

  // ---------------------------------------------------------------- canvas
  const canvas = document.getElementById('scene');
  const ctx = canvas.getContext('2d');
  let ready = false, needsFrame = true, last = 0, start = performance.now();

  function resizeCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    requestRender();
  }
  function requestRender() { needsFrame = true; }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!ready) return;
    const animate = !reduceMotion.matches;
    if (!animate && !needsFrame && !hero.moving) return;
    if (animate && now - last < 1000 / 30) return;                  // cap at 30 FPS
    const dt = Math.min(0.1, (now - (last || now)) / 1000);
    last = now;
    stepHero(dt);
    const t = animate ? (now - start) / 1000 : 0;
    stepCam(dt);
    drawScene(ctx, canvas.width, canvas.height, t, true, cam.y);
    needsFrame = false;
  }

  // ---------------------------------------------------------------- camera
  // Follows the traveler; a drag, swipe or wheel on the preview takes over, and "Find traveler" hands back.
  const cam = { y: 0, target: 0, follow: true, drag: false, init: false };
  let ptr = null, dragged = false, uiScroll = null;
  function liveVisH() { const r = canvas.getBoundingClientRect(); return viewFor(r.width, r.height, 0).visH; }
  function scrollable() { return WORLD_H > liveVisH() + 1; }
  function stepCam(dt) {
    const visH = liveVisH();
    if (cam.follow) cam.target = followCam(pointAt(hero.d)[1], visH);
    cam.target = clampCam(cam.target, visH);
    if (!cam.init || cam.drag || reduceMotion.matches) { cam.y = cam.target; cam.init = true; }
    else {
      cam.y += (cam.target - cam.y) * Math.min(1, dt * 5);
      if (Math.abs(cam.target - cam.y) < 0.05) cam.y = cam.target; else needsFrame = true;
    }
    const sc = scrollable();
    if (sc !== uiScroll) { uiScroll = sc; canvas.style.touchAction = sc ? 'none' : ''; }
    const btn = document.getElementById('recenter');
    if (btn) btn.hidden = !(sc && !cam.follow);
  }
  function lookAt(i) {                                             // bring milestone i's island into view
    if (!scrollable()) return;
    const [, y] = INST[i].P(placeOf(i).hero);
    cam.follow = false;
    cam.target = clampCam(y - liveVisH() * 0.55, liveVisH());
    requestRender();
  }
  canvas.addEventListener('pointerdown', e => {
    if (!scrollable() || !e.isPrimary) return;
    ptr = { y: e.clientY, cam: cam.target, moved: false };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  });
  canvas.addEventListener('pointermove', e => {
    if (!ptr) return;
    const d = e.clientY - ptr.y;
    if (!ptr.moved && Math.abs(d) < 6) return;
    ptr.moved = true; cam.follow = false; cam.drag = true;
    const r = canvas.getBoundingClientRect(), v = viewFor(r.width, r.height, 0);
    cam.target = clampCam(ptr.cam - d / v.s, v.visH);
    requestRender();
  });
  const endDrag = () => { if (ptr) dragged = ptr.moved; ptr = null; cam.drag = false; requestRender(); };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', e => {
    if (!scrollable()) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect(), v = viewFor(r.width, r.height, 0);
    cam.follow = false;
    cam.target = clampCam(cam.target + e.deltaY / v.s, v.visH);
    requestRender();
  }, { passive: false });
  document.getElementById('recenter').addEventListener('click', () => { cam.follow = true; requestRender(); });

  canvas.addEventListener('click', e => {
    if (dragged) { dragged = false; return; }
    const r = canvas.getBoundingClientRect();
    const v = viewFor(r.width, r.height, cam.y);
    const mx = (e.clientX - r.left - v.ox) / v.s, my = (e.clientY - r.top - v.oy) / v.s;
    let hit = -1, best = Infinity;
    state.ms.forEach((m, i) => {
      const [x, y, w, h] = INST[i].R(placeOf(i).sign);
      const dx = Math.max(x - mx, 0, mx - (x + w)), dy = Math.max(y - my, 0, my - (y + h));
      const d = Math.hypot(dx, dy);
      if (d < 40 && d < best) { best = d; hit = i; }
    });
    if (hit === -1) {
      const [hx, hy] = pointAt(hero.d);
      const d = Math.hypot(mx - hx, my - (hy - 30));
      if (d < 40) hit = activeIndex();
    }
    if (hit !== -1) {
      select(hit);
      const li = document.getElementById('ms-' + hit);
      if (li) li.scrollIntoView({ block: 'nearest', behavior: reduceMotion.matches ? 'auto' : 'smooth' });
    }
  });

  // -------------------------------------------------------------------- UI
  const $ = id => document.getElementById(id);
  const list = $('msList');

  function select(i, look) {
    state.selected = state.selected === i ? null : i;
    if (look && state.selected === i) lookAt(i);
    renderList();
    requestRender();
  }

  function statusOf(i) {
    const m = state.ms[i];
    if (m.done) return ['done', 'Cleared'];
    if (daysLate(i)) return ['late', 'Overdue'];
    if (i === activeIndex()) return i === state.ms.length - 1 ? ['goal', 'Final quest'] : ['now', 'Current'];
    return i === state.ms.length - 1 ? ['goal', 'Goal'] : ['later', 'Upcoming'];
  }
  function metaText(i) {
    const m = state.ms[i];
    const d = daysUntil(m.date);
    if (m.done) return `Cleared. Target was ${fmtLong(m.date)}.`;
    if (i < state.ms.length - 1 && m.date > goal().date) return `Heads up: this is due after your goal date (${fmtLong(goal().date)}).`;
    if (d > 1) return `${d} days left · due ${fmtLong(m.date)}`;
    if (d === 1) return `Due tomorrow · ${fmtLong(m.date)}`;
    if (d === 0) return `Due today · ${fmtLong(m.date)}`;
    return `${-d} day${d === -1 ? '' : 's'} overdue · was due ${fmtLong(m.date)}`;
  }

  function renderList() {
    list.textContent = '';
    const n = state.ms.length;
    $('addBtn').disabled = n >= MAX_MS;
    $('addBtn').title = n >= MAX_MS ? `The map holds ${MAX_MS} islands at most.` : '';
    state.ms.forEach((m, i) => {
      const [cls, label] = statusOf(i);
      const open = state.selected === i;
      const li = document.createElement('li');
      li.className = 'ms';
      li.id = 'ms-' + i;
      li.setAttribute('aria-current', String(open));
      li.innerHTML = `
        <button type="button" class="ms-row" aria-expanded="${open}" aria-controls="ms-edit-${i}">
          <span class="ms-num">${i + 1}</span>
          <span class="ms-text">
            <span class="ms-place"></span>
            <span class="ms-task"></span>
            <span class="ms-date"></span>
          </span>
          <span class="chip ${cls}">${label}</span>
        </button>
        <div class="ms-edit" id="ms-edit-${i}" ${open ? '' : 'hidden'}>
          <div class="fields">
            <label class="field" for="task-${i}">${i === n - 1 ? 'Goal' : 'Task'}
              <input id="task-${i}" type="text" maxlength="40" autocomplete="off" placeholder="What needs doing?">
            </label>
            <label class="field" for="date-${i}">${i === n - 1 ? 'Goal date' : 'Target date'}
              <input id="date-${i}" type="date" required>
            </label>
          </div>
          <p class="ms-meta"></p>
          <div class="ms-actions">
            <button type="button" class="complete-btn ${m.done ? 'undo' : ''}">${m.done ? 'Mark as not done' : (i === n - 1 ? 'Claim the castle' : 'Mark complete')}</button>
            ${i < n - 2 && n > MIN_MS ? '<button type="button" class="link remove-btn">Remove this island</button>' : ''}
          </div>
        </div>`;
      li.querySelector('.ms-place').textContent = placeName(i);
      li.querySelector('.ms-task').textContent = m.task || placeName(i);
      li.querySelector('.ms-date').textContent = fmtLong(m.date);
      li.querySelector('.ms-meta').textContent = metaText(i);
      const taskIn = li.querySelector('#task-' + i), dateIn = li.querySelector('#date-' + i);
      taskIn.value = m.task;
      dateIn.value = m.date;

      li.querySelector('.ms-row').addEventListener('click', () => select(i, true));
      taskIn.addEventListener('input', () => {
        m.task = taskIn.value;
        li.querySelector('.ms-task').textContent = m.task || placeName(i);
        save(); updateCountdown(); requestRender();
      });
      dateIn.addEventListener('change', () => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIn.value)) { dateIn.value = m.date; return; }
        m.date = dateIn.value;
        save(); updateCountdown(); renderList(); requestRender();
        $('date-' + i)?.focus();
      });
      li.querySelector('.complete-btn').addEventListener('click', () => toggleDone(i));
      li.querySelector('.remove-btn')?.addEventListener('click', () => removeIsland(i));
      list.appendChild(li);
    });
  }

  // Adding an island inserts a milestone just before the Crystal Shrine (the next type in the Basecamp, Workshop,
  // Observatory cycle); removing one takes any island before the shrine. The map is rebuilt around the new chain.
  function layoutChanged() {
    for (const k of Object.keys(clears)) delete clears[k];
    buildWorld();
    snapHero();
    cam.follow = true;
    save(); renderList(); updateCountdown(); requestRender();
  }
  function addIsland() {
    const n = state.ms.length;
    if (n >= MAX_MS) { toast(`The map holds ${MAX_MS} islands at most.`, true); return; }
    if (!worldOK) { toast('Extra islands need the page served over http(s), not opened as a file.', true); return; }
    const prev = parseDate(state.ms[n - 3].date).getTime(), shrine = parseDate(state.ms[n - 2].date).getTime();
    const mid = new Date(Math.round((prev + Math.max(prev + DAY, shrine)) / 2));   // halfway to the shrine, at least a day on
    const date = `${mid.getFullYear()}-${pad(mid.getMonth() + 1)}-${pad(mid.getDate())}`;
    state.ms.splice(n - 2, 0, { task: '', date, done: false });
    state.selected = n - 2;
    layoutChanged();
    toast(`${placeName(n - 2)} added before the Crystal Shrine.`);
    $('task-' + (n - 2))?.focus();
  }
  function removeIsland(i) {
    const n = state.ms.length;
    if (n <= MIN_MS || i >= n - 2) return;
    const name = placeName(i);
    state.ms.splice(i, 1);
    if (state.selected !== null && state.selected > i) state.selected--;
    else if (state.selected === i) state.selected = null;
    layoutChanged();
    toast(`${name} removed.`);
  }
  $('addBtn').addEventListener('click', addIsland);

  function toggleDone(i) {
    const before = activeIndex();
    if (!state.ms[i].done && daysLate(i)) clears[i] = performance.now();   // the storm breaks up
    state.ms[i].done = !state.ms[i].done;
    const after = activeIndex();
    if (state.ms[i].done && !reduceMotion.matches) hero.cheerUntil = performance.now() + 1200;
    retarget(after !== before);
    save();
    renderList();
    updateCountdown();
    requestRender();
    toast(state.ms[i].done ? `${placeName(i)} cleared!` : `${placeName(i)} reopened.`);
    $('ms-' + i)?.querySelector('.complete-btn')?.focus();
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function updateCountdown() {
    const g = goal();
    $('goalTitle').textContent = g.task || 'Your goal';
    $('goalDate').textContent = `Target: ${fmtLong(g.date)} (counts to the end of that day)`;
    const deadline = parseDate(g.date).getTime() + DAY;
    let diff = Math.max(0, deadline - Date.now());
    const D = Math.floor(diff / DAY); diff -= D * DAY;
    const H = Math.floor(diff / 3600000); diff -= H * 3600000;
    const M = Math.floor(diff / 60000); diff -= M * 60000;
    const S = Math.floor(diff / 1000);
    $('cdD').textContent = D; $('cdH').textContent = pad(H); $('cdM').textContent = pad(M); $('cdS').textContent = pad(S);
    const n = doneCount(), N = state.ms.length;
    $('progressBar').style.width = (n / N * 100) + '%';
    $('progressText').textContent = allDone() ? `All ${N} milestones cleared. Quest complete!` : `${n} of ${N} milestones cleared`;
  }

  let lastDay = startOfToday().getTime();
  function tick() {
    updateCountdown();
    const now = new Date();
    $('lockTime').textContent = state.device === 'android'
      ? now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
      : now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/, '');
    $('lockDate').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (startOfToday().getTime() !== lastDay) { lastDay = startOfToday().getTime(); renderList(); requestRender(); queueDaily(true); }
  }

  function applyDevice() {
    $('phone').dataset.device = state.device;
    for (const b of document.querySelectorAll('.seg button[data-device]')) b.setAttribute('aria-checked', String(b.dataset.device === state.device));
    const d = DEVICES[state.device];
    $('downloadSize').textContent = `Still PNG · ${d.w}×${d.h} · ${d.label}`;
    tick();
    resizeCanvas();
  }
  // Traveler picker: Person + Species dropdowns pick one of the ten characters; swatches pick the hair colour.
  function renderRoster() {
    const sp = $('selSpecies');
    if (!sp.options.length) {
      for (const [v, label] of SPECIES) sp.add(new Option(label, v));
      const onPick = () => pickHero(`${sp.value}_${$('selSex').value}`);
      $('selSex').addEventListener('change', onPick);
      sp.addEventListener('change', onPick);
    }
    const [species, sex] = state.hero.split('_');
    sp.value = species; $('selSex').value = sex;
    renderHair();
    renderSkin();
    renderPreview();
  }
  function renderHair() {
    const box = $('hairSwatches'), h = HEROES[state.hero];
    box.textContent = '';
    for (const [key, c] of Object.entries(HAIR)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.hair = key;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(state.hair === key));
      b.disabled = !h.hair && key !== 'natural';
      b.innerHTML = '<i></i><span></span>';
      const sw = b.querySelector('i');
      if (c.ramp) sw.style.background = `linear-gradient(180deg, ${c.ramp[2]}, ${c.ramp[1]} 55%, ${c.ramp[0]})`;
      else if (h.hair) sw.style.background = h.hair;
      else sw.classList.add('none');
      b.querySelector('span').textContent = c.label;
      b.addEventListener('click', () => pickHair(key));
      box.appendChild(b);
    }
    $('hairNote').textContent = h.note || '';
    $('hairNote').hidden = !h.note;
  }
  function renderSkin() {
    const box = $('skinSwatches'), h = HEROES[state.hero];
    if (!box) return;
    box.textContent = '';
    for (const [key, c] of Object.entries(SKIN)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.skin = key;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(state.skin === key));
      b.disabled = !h.skin && key !== 'light';
      b.innerHTML = '<i></i><span></span>';
      const sw = b.querySelector('i'), r = c.ramp || c.swatch;
      if (h.skin || key !== 'light') sw.style.background = `linear-gradient(180deg, ${r[2]}, ${r[1]} 55%, ${r[0]})`;
      else sw.style.background = 'linear-gradient(180deg, #8fd16a, #4f9a3a 55%, #2f6a24)';   // orc green
      b.querySelector('span').textContent = h.skin || key !== 'light' ? c.label : 'Green';
      b.addEventListener('click', () => pickSkin(key));
      box.appendChild(b);
    }
    $('skinNote').textContent = h.skinNote || '';
    $('skinNote').hidden = !h.skinNote;
  }
  function pickSkin(key) {
    state.skin = key;
    save();
    for (const b of $('skinSwatches').querySelectorAll('.swatch')) b.setAttribute('aria-checked', String(b.dataset.skin === key));
    renderPreview();
    requestRender();
  }
  function renderPreview() {
    const img = $('travelerImg'), key = state.hero;
    img.alt = HEROES[key].label;
    const im = heroImage(key, '0');
    const fallback = `assets/sprites/${HEROES[key].prefix}-0.png`;
    if (!im) { img.src = fallback; return; }
    try {                                                         // crop to the figure so it fills the box
      const { d } = canvasOf(im), a = d.data, W = d.width;
      let x0 = W, y0 = W, x1 = 0, y1 = 0;
      for (let i = 3; i < a.length; i += 4) if (a[i] > 40) {
        const x = (i >> 2) % W, y = (i >> 2) / W | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      const side = Math.max(x1 - x0, y1 - y0) + 12, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const c = document.createElement('canvas');
      c.width = c.height = 144;
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(im, cx - side / 2, cy - side / 2, side, side, 0, 0, 144, 144);
      img.src = c.toDataURL('image/png');
    } catch (_) { img.src = fallback; }
  }
  function pickHair(key) {
    state.hair = key;
    save();
    for (const b of $('hairSwatches').querySelectorAll('.swatch')) b.setAttribute('aria-checked', String(b.dataset.hair === key));
    renderPreview();
    requestRender();
  }
  function pickHero(key) {
    if (!HEROES[key]) return;
    state.hero = key;
    save();
    renderHair();
    renderSkin();
    loadHero(key).then(() => {
      if (state.hero !== key) return;
      renderPreview();
      if (!reduceMotion.matches) hero.cheerUntil = performance.now() + 900;   // a little hello
      requestRender();
    }).catch(() => toast(`Couldn't load ${HEROES[key].label}. Check your connection and try again.`, true));
  }

  function applyLock() {
    $('lock').hidden = !state.lock;
    $('lockToggle').checked = state.lock;
  }

  let toastTimer;
  function toast(msg, err) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('err', !!err);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  // --------------------------------------------------------------- export
  function wallpaperCanvas(d) {
    const c = document.createElement('canvas');
    c.width = d.w; c.height = d.h;
    const visH = d.h / viewFor(d.w, d.h, 0).s;
    drawScene(c.getContext('2d'), d.w, d.h, 0, false, followCam(pointAt(heroTarget())[1], visH));   // base map + plaques + hero + banner only
    return c;
  }
  function pngBase64(c) { return c.toDataURL('image/png').slice('data:image/png;base64,'.length); }

  async function exportWallpaper() {
    const d = DEVICES[state.device];
    const c = wallpaperCanvas(d);
    if (APP_OS === 'ios') {                                       // the iOS share sheet: Save Image, or a Shortcut
      await NATIVE.shareImage({ data: pngBase64(c) });
      return '';
    }
    if (APP_OS === 'android') {                                   // straight into the photo library
      await NATIVE.saveImage({ data: pngBase64(c), name: `deadline-quest-${d.w}x${d.h}.png` });
      return 'Saved to Pictures › Deadline Quest.';
    }
    let blob;
    try { blob = await new Promise(res => c.toBlob(res, 'image/png')); }
    catch (_) { blob = null; }
    if (!blob) throw new Error('The browser blocked the export. Open the page from a web server (http or https), not as a local file.');
    const name = `deadline-quest-${state.device}-${d.w}x${d.h}.png`;
    // Embedded viewers (iframes) block downloads and sharing: show the image so it can be saved by hand.
    let framed = false;
    try { framed = window.self !== window.top; } catch (_) { framed = true; }
    const file = new File([blob], name, { type: 'image/png' });
    const touch = matchMedia('(pointer: coarse)').matches;
    let canShare = false;
    try { canShare = !!(navigator.canShare && navigator.canShare({ files: [file] })); } catch (_) { canShare = false; }
    if (framed) { showSaveSheet(c.toDataURL('image/png'), d, canShare ? file : null, true); return ''; }
    if (touch && canShare) {
      try { await navigator.share({ files: [file], title: 'Deadline Quest wallpaper' }); return 'Wallpaper ready. Choose "Save Image" to add it to Photos.'; }
      catch (e) { if (e.name === 'AbortError') return ''; }
    }
    // Phones: link downloads are unreliable (Safari may open the image instead or ask), so show the picture with a
    // Share button and press-and-hold instructions.
    if (touch) { showSaveSheet(c.toDataURL('image/png'), d, canShare ? file : null, false); return ''; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return `Saved ${name}`;
  }

  let shareFile = null;
  function showSaveSheet(src, d, file, framed) {
    const sheet = $('saveSheet');
    shareFile = file;
    $('saveImg').src = src;
    $('saveSize').textContent = `${d.w}×${d.h} · ${d.label}`;
    $('saveShare').hidden = !file;
    $('saveWarn').hidden = !framed;
    $('saveWarn').textContent = 'This preview runs inside another page, which can block saving. If nothing works here, open Deadline Quest directly in Safari or Chrome.';
    sheet.hidden = false;
    (file ? $('saveShare') : $('saveClose')).focus();
  }
  // The Share button calls navigator.share straight from the tap, with the file already made, so the browser's
  // user-gesture rule is always met.
  $('saveShare').addEventListener('click', async () => {
    if (!shareFile) return;
    try { await navigator.share({ files: [shareFile], title: 'Deadline Quest wallpaper' }); }
    catch (e) {
      if (e.name === 'AbortError') return;
      $('saveWarn').hidden = false;
      $('saveWarn').textContent = `Sharing is blocked here (${e.name}). Press and hold the image and choose Save to Photos, or open Deadline Quest directly in Safari or Chrome.`;
    }
  });
  $('saveClose').addEventListener('click', () => { $('saveSheet').hidden = true; $('saveImg').removeAttribute('src'); shareFile = null; $('downloadBtn').focus(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('saveSheet').hidden) $('saveClose').click(); });

  $('downloadBtn').addEventListener('click', async () => {
    if (!ready) return;
    const btn = $('downloadBtn');
    btn.disabled = true;
    try { const msg = await exportWallpaper(); if (msg) toast(msg); }
    catch (e) { toast(e.message, true); }
    finally { btn.disabled = false; }
  });

  for (const b of document.querySelectorAll('.seg button[data-device]')) {
    b.addEventListener('click', () => { state.device = b.dataset.device; save(); applyDevice(); });
  }
  $('lockToggle').addEventListener('change', e => { state.lock = e.target.checked; save(); applyLock(); });
  $('resetBtn').addEventListener('click', () => {
    state.ms = clone(DEFAULT_MS);
    state.selected = 1;
    layoutChanged();
    toast('Milestones reset to the default quest.');
  });

  reduceMotion.addEventListener?.('change', () => {
    if (reduceMotion.matches) snapHero();
    requestRender();
  });
  new ResizeObserver(resizeCanvas).observe(canvas);

  // ------------------------------------------- "How to use your wallpaper"
  // The guide sits under the milestones. The "How it works" link beside the download button scrolls to it and
  // opens the tab for the chosen phone. Tabs follow the WAI-ARIA pattern (arrow keys move between them).
  const TABS = ['iphone', 'android', 'compare'];
  function showTab(name) {
    for (const t of TABS) {
      const on = t === name, tab = $('tab-' + t);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      $('pane-' + t).hidden = !on;
    }
  }
  for (const t of TABS) {
    $('tab-' + t).addEventListener('click', () => showTab(t));
    $('tab-' + t).addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      const n = TABS[(TABS.indexOf(t) + d + TABS.length) % TABS.length];
      showTab(n); $('tab-' + n).focus(); e.preventDefault();
    });
  }
  $('howtoLink').addEventListener('click', () => {
    showTab(state.device === 'android' ? 'android' : 'iphone');
    const el = $('howto');
    el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    $('howtoTitle').focus({ preventScroll: true });
  });
  if (location.hash === '#howto') showTab(state.device === 'android' ? 'android' : 'iphone');
  $('pageUrl').textContent = location.href.split('#')[0];
  $('copyUrl').addEventListener('click', async () => {
    const btn = $('copyUrl'), code = $('pageUrl');
    try { await navigator.clipboard.writeText(code.textContent); btn.textContent = 'Copied'; }
    catch (_) {                                                 // clipboard refused: select the text instead
      const r = document.createRange(); r.selectNodeContents(code);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      btn.textContent = 'Selected';
    }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });

  // ---------------------------------------------------------- native apps
  // In the apps the wallpaper is drawn at the phone's own screen size and Download saves to the photo library.
  // Android can also set the wallpaper itself. With daily updates on, the app draws one picture per day for the next
  // DAILY_DAYS days (the picture only depends on the date: day count, overdue storms) and hands them to the plugin;
  // a background job (WorkManager, hourly) puts up the right one after midnight. No server is involved. Any change
  // redraws the set; opening the app redraws it only when fewer than DAILY_MIN days are left, so the window keeps
  // moving forward without redrawing every time.
  const DAILY_DAYS = 21, DAILY_MIN = 14, SIG_KEY = 'deadline-quest/daily-sig';
  const wall = { target: 'lock', auto: false, through: '' };
  let dailyTimer = 0, dailyRun = 0, dailyForce = false;
  function queueDaily(soft) {
    if (APP_OS !== 'android' || !wall.auto) return;
    if (!soft) dailyForce = true;
    clearTimeout(dailyTimer);
    dailyTimer = setTimeout(refreshDaily, 1500);                  // let a burst of edits settle first
  }
  function dailySig(d) { return JSON.stringify([state.ms, state.hero, state.hair, state.skin, d.w, d.h, wall.target]); }
  async function refreshDaily() {
    if (!ready) { queueDaily(true); return; }
    const d = DEVICES[state.device], sig = dailySig(d);
    let lastSig = '';
    try { lastSig = localStorage.getItem(SIG_KEY) || ''; } catch (_) {}
    dayShift = DAILY_MIN;
    const soon = isoDate(startOfToday());
    dayShift = 0;
    if (!dailyForce && sig === lastSig && wall.through >= soon) return;   // nothing changed, plenty left
    dailyForce = false;
    const run = ++dailyRun, dates = [];
    try {
      await loadHero(state.hero);
      for (let k = 0; k < DAILY_DAYS; k++) {
        showWallStatus(`Preparing the next 3 weeks of wallpapers… ${k + 1}/${DAILY_DAYS}`);
        let date, data;
        dayShift = k;
        try { date = isoDate(startOfToday()); data = pngBase64(wallpaperCanvas(d)); }
        finally { dayShift = 0; }
        if (run !== dailyRun) return;                             // a newer change started over
        await NATIVE.store({ date, data });
        dates.push(date);
      }
      if (run !== dailyRun) return;
      const st = await NATIVE.finish({ dates, target: wall.target });
      wall.through = st.through || '';
      try { localStorage.setItem(SIG_KEY, sig); } catch (_) {}
      showWallStatus();
    } catch (e) {
      if (run === dailyRun) showWallStatus(`Daily update failed: ${e.message || e}`, true);
    }
  }
  function showWallStatus(msg, err) {
    const el = $('autoStatus');
    if (!el) return;
    el.classList.toggle('err', !!err);
    if (msg) { el.textContent = msg; return; }
    el.textContent = wall.auto && wall.through
      ? `On. Pictures are ready through ${fmtLong(wall.through)}; open the app now and then to keep it going.`
      : 'Off. The wallpaper only changes when you tap Set as wallpaper.';
  }
  async function setWallpaperNow() {
    const btn = $('setWallBtn');
    btn.disabled = true;
    try {
      await loadHero(state.hero);
      await NATIVE.setNow({ data: pngBase64(wallpaperCanvas(DEVICES[state.device])), target: wall.target });
      toast(wall.target === 'home' ? 'Home screen wallpaper set.' : wall.target === 'lock' ? 'Lock screen wallpaper set.' : 'Lock and home screen wallpaper set.');
    } catch (e) { toast(`Couldn't set the wallpaper: ${e.message || e}`, true); }
    finally { btn.disabled = false; }
  }
  function renderWallTarget() {
    for (const b of document.querySelectorAll('#wallTarget button')) b.setAttribute('aria-checked', String(b.dataset.target === wall.target));
  }
  async function initNative() {
    if (!NATIVE) return;
    document.documentElement.dataset.app = APP_OS;               // CSS shows the app-only parts, hides web-only ones
    try {                                                         // draw at this phone's real resolution
      const s = await NATIVE.screen();
      const key = APP_OS === 'ios' ? 'iphone' : 'android';
      if (s && s.w > 300 && s.h > s.w) Object.assign(DEVICES[key], { w: Math.min(s.w, 1600), h: Math.min(s.h, 3600), label: 'This phone' });
      state.device = key;
      applyDevice();
    } catch (_) {}
    if (APP_OS !== 'android') return;
    $('appWall').hidden = false;
    $('downloadBtn').querySelector('.dl-main').textContent = 'Save picture';
    try { const st = await NATIVE.status(); Object.assign(wall, { target: st.target || 'lock', auto: !!st.auto, through: st.through || '' }); }
    catch (_) {}
    $('autoWall').checked = wall.auto;
    renderWallTarget();
    showWallStatus();
    $('setWallBtn').addEventListener('click', setWallpaperNow);
    for (const b of document.querySelectorAll('#wallTarget button')) b.addEventListener('click', () => {
      wall.target = b.dataset.target;
      renderWallTarget();
      if (wall.auto) queueDaily(); else NATIVE.setTarget({ target: wall.target }).catch(() => {});
    });
    $('autoWall').addEventListener('change', async e => {
      wall.auto = e.target.checked;
      if (wall.auto) { dailyForce = true; refreshDaily(); return; }
      dailyRun++;
      clearTimeout(dailyTimer);
      try { await NATIVE.disable(); } catch (_) {}
      wall.through = '';
      showWallStatus();
    });
    queueDaily(true);                                             // extend the window when the app opens
    document.addEventListener('visibilitychange', () => { if (!document.hidden) queueDaily(true); });
  }

  // ----------------------------------------------------------------- boot
  applyDevice();
  applyLock();
  renderRoster();
  renderList();
  updateCountdown();
  setInterval(tick, 1000);
  requestAnimationFrame(frame);

  const fonts = Promise.all([
    document.fonts.load(`400 24px ${FONT_DISPLAY}`),
    document.fonts.load(`600 15px ${FONT_PIXEL}`),
    document.fonts.load(`500 11px ${FONT_PIXEL}`),
  ]).catch(() => {});
  const fontTimeout = new Promise(res => setTimeout(res, 2500));

  loadAssets()
    .then(() => Promise.race([fonts, fontTimeout]))
    .then(() => { buildLiveMap(); buildPieces(); buildWorld(); snapHero(); ready = true; resizeCanvas(); renderPreview(); })
    .catch(err => { toast(err.message + '. Check that the assets folder sits next to index.html.', true); });

  // Fonts may finish after the race timeout; redraw once they do.
  fonts.then(requestRender);
  initNative();
})();
