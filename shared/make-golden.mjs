// Generates shared/golden-tests.json from hand-written cases.
// Expected values are reviewed by a person before commit; ports must reproduce them exactly.
import { readFileSync, writeFileSync } from "node:fs";
import { recommend, personalOffset, requiredWarmth, feelsLike, summarizeWindow } from "./engine.js";
const cfg = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));

const closet = [
  { id: "tee-white", category: "tee" },
  { id: "tee-black", category: "tee" },
  { id: "ls-grey", category: "longsleeve" },
  { id: "sweat-grey", category: "sweatshirt" },
  { id: "lj-navy", category: "lightjacket" },
  { id: "jacket-olive", category: "jacket" },
  { id: "jeans-dark", category: "jeans" },
  { id: "pants-warm", category: "warmpants" },
  { id: "sneakers-white", category: "sneakers" },
  { id: "boots-brown", category: "boots" },
];
const cases = [
  { name: "cool evening 18C, no offset: tee + light jacket, open", fn: "recommend",
    input: { items: closet, window: { minFeelsC: 18, maxFeelsC: 21 }, offsetC: 0, today: "2026-11-09", wears: [] } },
  { name: "same evening with -0.5 offset: jacket closed", fn: "recommend",
    input: { items: closet, window: { minFeelsC: 18, maxFeelsC: 21 }, offsetC: -0.5, today: "2026-11-09", wears: [] } },
  { name: "warm day 25C: tee only", fn: "recommend",
    input: { items: closet, window: { minFeelsC: 25, maxFeelsC: 29 }, offsetC: 0, today: "2026-11-09", wears: [] } },
  { name: "cold 9C: warmth 6, warm pants, jacket closed", fn: "recommend",
    input: { items: closet, window: { minFeelsC: 9, maxFeelsC: 12 }, offsetC: 0, today: "2026-11-09", wears: [] } },
  { name: "recency: white tee worn yesterday, black tee chosen", fn: "recommend",
    input: { items: closet, window: { minFeelsC: 25, maxFeelsC: 29 }, offsetC: 0, today: "2026-11-09", wears: [{ date: "2026-11-08", itemIds: ["tee-white"] }] } },
  { name: "incomplete closet: no shoes", fn: "recommend",
    input: { items: closet.filter(i => !i.id.startsWith("sneakers") && !i.id.startsWith("boots")), window: { minFeelsC: 20, maxFeelsC: 24 }, offsetC: 0, today: "2026-11-09", wears: [] } },
  { name: "coherence: 16C with shorts in closet → long pants, not shorts", fn: "recommend",
    input: { items: [...closet, { id: "shorts-grey", category: "shorts" }], window: { minFeelsC: 16, maxFeelsC: 20 }, offsetC: 0, today: "2026-11-09", wears: [{ date: "2026-11-08", itemIds: ["jeans-dark"] }] } },
  { name: "warm day 27C: shorts allowed", fn: "recommend",
    input: { items: [...closet, { id: "shorts-grey", category: "shorts" }], window: { minFeelsC: 27, maxFeelsC: 31 }, offsetC: 0, today: "2026-11-09", wears: [{ date: "2026-11-08", itemIds: ["jeans-dark"] }, { date: "2026-11-07", itemIds: ["pants-warm"] }] } },
  { name: "work dress code: 27C but longPants → no shorts", fn: "recommend",
    input: { items: [...closet, { id: "shorts-grey", category: "shorts" }], window: { minFeelsC: 27, maxFeelsC: 31 }, offsetC: 0, today: "2026-11-09", wears: [{ date: "2026-11-08", itemIds: ["jeans-dark"] }, { date: "2026-11-07", itemIds: ["pants-warm"] }], constraints: { longPants: true } } },
  { name: "work dress code with only shorts → incomplete: long pants", fn: "recommend",
    input: { items: [...closet.filter(i => !["jeans-dark", "pants-warm"].includes(i.id)), { id: "shorts-grey", category: "shorts" }], window: { minFeelsC: 27, maxFeelsC: 31 }, offsetC: 0, today: "2026-11-09", wears: [], constraints: { longPants: true } } },
  { name: "offset: three 'warmer' answers", fn: "personalOffset",
    input: [{ ts: "2026-11-08T19:00Z", sensation: -1, preference: "warmer" }, { ts: "2026-11-09T17:57Z", sensation: -2, preference: "warmer" }, { ts: "2026-11-09T18:20Z", sensation: -1, preference: "warmer" }] },
  { name: "offset: capped at -3", fn: "personalOffset",
    input: Array.from({ length: 10 }, (_, i) => ({ ts: `2026-11-0${i}T08:00Z`, sensation: -2, preference: "warmer" })) },
  { name: "bands: 15C needs 3, 14.9C needs 5", fn: "requiredWarmth", input: [15, 14.9] },
  { name: "feels-like: [T, RH, wind km/h] → calm mild, windy cool morning (chill capped), humid summer, missing data", fn: "feelsLike",
    input: [[13, 70, 0], [13, 70, 25], [6, 60, 60], [30, 70, 10], [21, null, 10]] },
  { name: "window: shows air temps, decides by feels-like", fn: "summarizeWindow",
    input: { date: "2026-11-10", leave: "07:30", back: "19:00", hourly: [
      { time: "2026-11-10T06:00", tempC: 11, rh: 75, windKmh: 12 }, { time: "2026-11-10T07:00", tempC: 13, rh: 72, windKmh: 15 },
      { time: "2026-11-10T13:00", tempC: 21, rh: 50, windKmh: 18 }, { time: "2026-11-10T19:00", tempC: 16, rh: 65, windKmh: 10 },
      { time: "2026-11-11T07:00", tempC: 30, rh: 50, windKmh: 5 }] } },
];
const fns = { recommend: i => recommend(i, cfg), personalOffset: i => personalOffset(i, cfg), requiredWarmth: i => i.map(t => requiredWarmth(t, cfg)),
  feelsLike: i => i.map(([t, rh, w]) => feelsLike(t, rh, w, cfg)),
  summarizeWindow: i => summarizeWindow(i.hourly, i.date, i.leave, i.back, cfg) };
const out = { schemaVersion: cfg.schemaVersion, cases: cases.map(c => ({ ...c, expected: fns[c.fn](c.input) })) };
writeFileSync(new URL("./golden-tests.json", import.meta.url), JSON.stringify(out, null, 2));
for (const c of out.cases) console.log("-", c.name, "\n ", JSON.stringify(c.expected));
