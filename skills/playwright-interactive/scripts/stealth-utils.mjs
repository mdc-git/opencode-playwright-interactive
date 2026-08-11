// Pure helpers for the stealth runtime: no browser, profile or session state.
// Behavior math (pointer paths, timing, typing latency) lives here so the
// stateful runtime can stay focused on lifecycle and Playwright orchestration.

export const PERSONA_SCHEMA = 2;
export const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 });
export const MOBILE_DEVICE_SCALE_FACTOR = 3;
// Used only when neither the page's viewportSize() nor an in-page evaluation
// can produce dimensions (for example during an early navigation).
export const FALLBACK_VIEWPORT = Object.freeze({ width: 960, height: 540 });
export const IDENTITY_CONTEXT_OPTIONS = Object.freeze([
  "userAgent",
  "locale",
  "timezoneId",
  "isMobile",
  "hasTouch",
  "deviceScaleFactor",
  "viewport",
  "screen",
]);
export const IDENTITY_ARGUMENTS = Object.freeze([
  "--disable-blink-features=AutomationControlled",
  "--force-device-scale-factor",
  "--lang",
  "--user-agent",
]);
export const IDENTITY_HEADERS = Object.freeze([
  "accept-language",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "user-agent",
]);
export const STEALTH_ARGUMENTS = Object.freeze([
  "--disable-blink-features=AutomationControlled",
  "--disable-features=AutomationControlled,IsolateOrigins,site-per-process",
  "--no-first-run",
  "--no-default-browser-check",
]);
export const STRUCTURAL_ROLES = Object.freeze(["search", "main", "navigation", "banner", "contentinfo", "complementary", "region", "form", "heading", "list", "listitem", "presentation", "none"]);
export const BEHAVIOR_SCHEMA = 2;

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const settleWithin = (promise, milliseconds, fallback) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  sleep(milliseconds).then(() => fallback),
]);
export const uniform = (minimum, maximum) => minimum + Math.random() * (maximum - minimum);
export const normal = () => {
  let first = 0;
  let second = 0;
  while (!first) first = Math.random();
  while (!second) second = Math.random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
};
export const logNormal = (mean, sigma) => Math.max(1, Math.exp(Math.log(Math.max(1, mean)) + sigma * normal()));
export const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
// Fitts's law: expected movement time for a pointer travelling distance D to a
// target of width W, in milliseconds. Humans plan travel time from D and W.
export const fittsDuration = (distance, targetSize, profile) =>
  clamp(profile.fittsIntercept + profile.fittsSlope * Math.log2(distance / Math.max(1, targetSize) + 1), profile.fittsMinDuration, profile.fittsMaxDuration);
// Common digraphs are stored as units and typed quickly; rare combinations
// carry a planning cost. Returns a latency multiplier for a character pair.
const BIGRAM_EASE = /^(th|he|in|er|an|re|on|at|en|nd|ti|es|or|te|of|ed|is|it|al|ar|st|to|nt|ng|se|ha|as|ou|io|le|ve|co|me|de|hi|ri|ro|ic|ne|ea|ra|ce|li|ch|ll|be|ma|si|om|ur)$/;
export const digraphFactor = (previous, current) => {
  if (!previous) return 1.35;
  const pair = `${previous}${current}`.toLowerCase();
  if (BIGRAM_EASE.test(pair)) return 0.82;
  if (previous === current) return 0.92;
  if (/^[\s\p{Zs}]$/u.test(previous) || /^[\s\p{Zs}]$/u.test(current)) return 1.08;
  if (/[\p{P}\p{S}]/u.test(current) || /[A-Z]/.test(current)) return 1.22;
  return 1;
};
// QWERTY adjacency used for realistic substitution typos.
export const KEY_NEIGHBORHOOD = {
  q: "was", w: "qeasd", e: "wrsdf", r: "etdfg", t: "ryfgh", y: "tughj", u: "yihjk", i: "uojkl", o: "ipkl", p: "ol",
  a: "qwsz", s: "awedzx", d: "serfcx", f: "drtgvc", g: "ftyhvb", h: "gyujnb", j: "huikmn", k: "jiolm", l: "kop",
  z: "asx", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
};

export const pathBetween = (from, to, profile) => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const perpendicular = { x: -dy / distance, y: dx / distance };
  const bend = Math.min(80, distance * profile.curveFactor) * (Math.random() < 0.5 ? -1 : 1);
  const first = { x: from.x + dx * 0.3 + perpendicular.x * bend, y: from.y + dy * 0.3 + perpendicular.y * bend };
  const second = { x: from.x + dx * 0.7 - perpendicular.x * bend * 0.7, y: from.y + dy * 0.7 - perpendicular.y * bend * 0.7 };
  const steps = Math.max(5, Math.min(30, Math.round(distance / 15)));
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const inverse = 1 - t;
    points.push({ x: inverse ** 3 * from.x + 3 * inverse ** 2 * t * first.x + 3 * inverse * t ** 2 * second.x + t ** 3 * to.x, y: inverse ** 3 * from.y + 3 * inverse ** 2 * t * first.y + 3 * inverse * t ** 2 * second.y + t ** 3 * to.y });
  }
  if (distance > 40 && Math.random() < profile.overshootChance) {
    const amount = uniform(profile.overshootMin, profile.overshootMax);
    points.splice(-1, 0, { x: to.x + dx / distance * amount, y: to.y + dy / distance * amount });
  }
  return points;
};

export const pointFor = (box, profile) => {
  const targetSize = Math.max(box.width, box.height);
  if (box.stealthPoints?.length) return { ...box.stealthPoints[Math.floor(Math.random() * box.stealthPoints.length)], targetSize };
  return { x: box.width <= 1 ? box.x : clamp(box.x + box.width / 2 + normal() * profile.clickPrecision, box.x + 1, box.x + Math.max(1, box.width - 1)), y: box.height <= 1 ? box.y : clamp(box.y + box.height / 2 + normal() * profile.clickPrecision, box.y + 1, box.y + Math.max(1, box.height - 1)), targetSize };
};
