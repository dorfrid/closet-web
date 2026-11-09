// Weather adapter: Open-Meteo on the web (free for non-commercial use). iOS will use WeatherKit behind the same shape.
// Output shape (v2): { v: 2, fetchedAt, hourly: [{ time: "YYYY-MM-DDTHH:MM", tempC, rh, windKmh, apparentC }], current: { tempC, apparentC, windKmh, humidity } }
// apparentC is Open-Meteo's own apparent temperature, kept for analysis only; the engine computes feels-like itself.
export async function fetchForecast(lat, lon) {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(3) + "&longitude=" + lon.toFixed(3) +
    "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,apparent_temperature&current=temperature_2m,apparent_temperature,wind_speed_10m,relative_humidity_2m" +
    "&wind_speed_unit=kmh&timezone=auto&forecast_days=3";
  const r = await fetch(url);
  if (!r.ok) throw new Error("weather " + r.status);
  const j = await r.json();
  const H = j.hourly;
  const hourly = H.time.map((t, i) => ({ time: t, tempC: H.temperature_2m[i], rh: H.relative_humidity_2m[i], windKmh: H.wind_speed_10m[i], apparentC: H.apparent_temperature[i] }));
  const c = j.current || {};
  return { v: 2, fetchedAt: new Date().toISOString(), hourly,
    current: { tempC: c.temperature_2m, apparentC: c.apparent_temperature, windKmh: c.wind_speed_10m, humidity: c.relative_humidity_2m } };
}
