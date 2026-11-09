// Weather adapter: Open-Meteo on the web (free for non-commercial use). iOS will use WeatherKit behind the same shape.
// Output shape: { fetchedAt, hourly: [{ time: "YYYY-MM-DDTHH:MM", feelsC, tempC }], current: { tempC, feelsC, windKmh, humidity } }
export async function fetchForecast(lat, lon) {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lat.toFixed(3) + "&longitude=" + lon.toFixed(3) +
    "&hourly=apparent_temperature,temperature_2m&current=temperature_2m,apparent_temperature,wind_speed_10m,relative_humidity_2m" +
    "&wind_speed_unit=kmh&timezone=auto&forecast_days=3";
  const r = await fetch(url);
  if (!r.ok) throw new Error("weather " + r.status);
  const j = await r.json();
  const hourly = j.hourly.time.map((t, i) => ({ time: t, feelsC: j.hourly.apparent_temperature[i], tempC: j.hourly.temperature_2m[i] }));
  const c = j.current || {};
  return { fetchedAt: new Date().toISOString(), hourly,
    current: { tempC: c.temperature_2m, feelsC: c.apparent_temperature, windKmh: c.wind_speed_10m, humidity: c.relative_humidity_2m } };
}
