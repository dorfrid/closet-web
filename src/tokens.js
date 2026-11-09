// Applies shared/tokens.json as CSS variables, following the system light/dark setting.
export async function applyTokens() {
  const t = await (await fetch("./shared/tokens.json")).json();
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const set = () => {
    const pal = t.color[mq.matches ? "dark" : "light"];
    for (const [k, v] of Object.entries(pal)) document.documentElement.style.setProperty("--" + k, v);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", pal.bg);
  };
  set(); mq.addEventListener("change", set);
}
