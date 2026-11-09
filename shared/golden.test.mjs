// Runs the shared golden tests against the JS engine: node --test shared/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { recommend, personalOffset, requiredWarmth, feelsLike, summarizeWindow } from "./engine.js";
const cfg = JSON.parse(readFileSync(new URL("./config.json", import.meta.url)));
const golden = JSON.parse(readFileSync(new URL("./golden-tests.json", import.meta.url)));
const fns = { recommend: i => recommend(i, cfg), personalOffset: i => personalOffset(i, cfg), requiredWarmth: i => i.map(t => requiredWarmth(t, cfg)),
  feelsLike: i => i.map(([t, rh, w]) => feelsLike(t, rh, w, cfg)),
  summarizeWindow: i => summarizeWindow(i.hourly, i.date, i.leave, i.back, cfg) };
for (const c of golden.cases) test(c.name, () => assert.deepEqual(fns[c.fn](c.input), c.expected));
