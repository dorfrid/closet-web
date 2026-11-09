// Cloud labeling adapter (Anthropic API, called directly from the phone with the user's own key).
// Only face-hidden, metadata-free JPEGs are sent. The model labels and matches garments; it never crops.
const API = "https://api.anthropic.com/v1/messages";

async function call(key, model, content, maxTokens = 1500) {
  const r = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) {
    let msg = r.status + "";
    try { msg = (await r.json()).error?.message || msg; } catch {}
    throw new Error("Claude API: " + msg);
  }
  const j = await r.json();
  const text = j.content.filter(c => c.type === "text").map(c => c.text).join("");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0) throw new Error("Claude API: no JSON in reply");
  return JSON.parse(text.slice(s, e + 1));
}

export async function testKey(key, model) {
  return call(key, model, [{ type: "text", text: 'Reply with {"ok":true}' }], 20);
}

// Returns { garments: [{ category, color, description, visibility: "full"|"partial"|"hidden", outermost: bool }] }
export async function labelPhoto(key, model, jpegBase64, categories) {
  const prompt = `This photo shows one man wearing clothes. Faces are hidden on purpose.
List every garment he wears that is at least partly visible. Ignore accessories, bags, watches and anything not worn.
Return only JSON: {"garments":[{"category":"<one of: ${categories.join(", ")}>","color":"<plain color>","description":"<short, distinguishing details: fabric, pattern, logo, pockets, fit>","visibility":"full|partial|hidden","outermost":true|false}]}
"outermost" = true for the top garment that covers the upper body from the outside (only one upper garment can be outermost); true for bottoms and shoes.
If unsure about a garment, still list it with the closest category.`;
  return call(key, model, [
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegBase64 } },
    { type: "text", text: prompt },
  ]);
}

// list: [{ key, category, color, description }] → { groups: [[key, ...], ...] } (same physical item)
export async function matchGarments(key, model, list) {
  const prompt = `Below are garments detected in different photos of the same man. Group entries that are the SAME physical item (not just similar).
Only group when category is compatible and the color and distinguishing details agree. When unsure, keep them separate.
Return only JSON: {"groups":[["key1","key2"],["key3"]]} covering every key exactly once.
${JSON.stringify(list)}`;
  return call(key, model, [{ type: "text", text: prompt }], 2000);
}
