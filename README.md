# Closet — web v0.5

Personal wardrobe + weather app. Web first (installable on iPhone Home Screen); iOS and Android later.

## Layout
- `shared/` — **platform-neutral**, ported as-is to iOS/Android
  - `engine.js` — recommendation engine (pure functions: no network, clock or randomness)
  - `config.json` — thresholds and categories (change values here, not in code)
  - `golden-tests.json` — input → expected output; every port must pass all cases
  - `tokens.json` — colors (light/dark), radii, touch size
- `src/` — web adapters and UI: `db.js` (IndexedDB), `weather.js` (Open-Meteo), `images.js` (re-encode + background removal), `app.js` (screens), `strings.js` (all UI text)
- `sw.js` — offline cache (bump `VERSION` on each release)

## Data
Stays on the phone (IndexedDB). Settings → Export writes one JSON file (items, wears, ratings, events, photos) that the iOS/Android apps will import.

## Tests
`node --test shared/golden.test.mjs` — regenerate expectations only on purpose: `node shared/make-golden.mjs`, then review the diff.

## Deep link
`?rate=1` opens the comfort check directly (use from an iOS Shortcut automation).
