// Generates shared/golden-tests.json from hand-written cases.
// Expected values are reviewed by a person before commit; ports must reproduce them exactly.
import { readFileSync, writeFileSync } from "node:fs";
import { recommend, personalOffset, requiredWarmth } from "./engine.js";
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
  { name: "offset: three 'warmer' answers", fn: "personalOffset",
    input: [{ ts: "2026-11-08T19:00Z", sensation: -1, preference: "warmer" }, { ts: "2026-11-09T17:57Z", sensation: -2, preference: "warmer" }, { ts: "2026-11-09T18:20Z", sensation: -1, preference: "warmer" }] },
  { name: "offset: capped at -3", fn: "personalOffset",
    input: Array.from({ length: 10 }, (_, i) => ({ ts: `2026-11-0${i}T08:00Z`, sensation: -2, preference: "warmer" })) },
  { name: "bands: 15C needs 3, 14.9C needs 5", fn: "requiredWarmth", input: [15, 14.9] },
];
const fns = { recommend: i => recommend(i, cfg), personalOffset: i => personalOffset(i, cfg), requiredWarmth: i => i.map(t => requiredWarmth(t, cfg)) };
const out = { schemaVersion: cfg.schemaVersion, cases: cases.map(c => ({ ...c, expected: fns[c.fn](c.input) })) };
writeFileSync(new URL("./golden-tests.json", import.meta.url), JSON.stringify(out, null, 2));
for (const c of out.cases) console.log("-", c.name, "\n ", JSON.stringify(c.expected));
