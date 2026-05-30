// Google Weather API client (Google Maps Platform — Preview).
//
// Built as a drop-in source for our existing weather shapes so nothing
// downstream changes: googleDaily() returns the brief/cron getWeather shape;
// googleEnriched() returns the modal (beta-weather) shape. The condition
// mapper turns Google's weatherCondition.type enum into our emoji + text.
//
// Defensive on purpose: the API is in Preview and field paths can shift, so
// every accessor is optional-chained with fallbacks. On any failure callers
// fall back to Open-Meteo (lib/weather), so a wrong path degrades gracefully
// rather than breaking weather.
//
// Auth: API key in GOOGLE_WEATHER_API_KEY (Netlify env), passed as ?key=.
// Units: unitsSystem=IMPERIAL → temps °F, wind mph.

const GOOGLE_WX_BASE = 'https://weather.googleapis.com/v1';

// weatherCondition.type → our emoji + lowercase text. Unknown types fall back
// to the description text Google supplies (or a neutral default).
const GWX_CONDITION = {
  CLEAR:                 { e: '☀️', t: 'clear' },
  MOSTLY_CLEAR:          { e: '🌤️', t: 'mostly clear' },
  PARTLY_CLOUDY:         { e: '⛅', t: 'partly cloudy' },
  MOSTLY_CLOUDY:         { e: '🌥️', t: 'mostly cloudy' },
  CLOUDY:                { e: '☁️', t: 'cloudy' },
  WINDY:                 { e: '💨', t: 'windy' },
  WIND_AND_RAIN:         { e: '🌧️', t: 'wind and rain' },
  LIGHT_RAIN_SHOWERS:    { e: '🌦️', t: 'light rain showers' },
  CHANCE_OF_SHOWERS:     { e: '🌦️', t: 'chance of showers' },
  SCATTERED_SHOWERS:     { e: '🌦️', t: 'scattered showers' },
  RAIN_SHOWERS:          { e: '🌦️', t: 'rain showers' },
  HEAVY_RAIN_SHOWERS:    { e: '🌧️', t: 'heavy rain showers' },
  LIGHT_TO_MODERATE_RAIN:{ e: '🌧️', t: 'rain' },
  MODERATE_TO_HEAVY_RAIN:{ e: '🌧️', t: 'heavy rain' },
  RAIN:                  { e: '🌧️', t: 'rain' },
  LIGHT_RAIN:            { e: '🌦️', t: 'light rain' },
  HEAVY_RAIN:            { e: '🌧️', t: 'heavy rain' },
  RAIN_PERIODICALLY_HEAVY:{ e: '🌧️', t: 'rain' },
  LIGHT_SNOW_SHOWERS:    { e: '🌨️', t: 'light snow showers' },
  CHANCE_OF_SNOW_SHOWERS:{ e: '🌨️', t: 'chance of snow' },
  SCATTERED_SNOW_SHOWERS:{ e: '🌨️', t: 'scattered snow' },
  SNOW_SHOWERS:          { e: '🌨️', t: 'snow showers' },
  HEAVY_SNOW_SHOWERS:    { e: '❄️', t: 'heavy snow' },
  LIGHT_TO_MODERATE_SNOW:{ e: '🌨️', t: 'snow' },
  MODERATE_TO_HEAVY_SNOW:{ e: '❄️', t: 'heavy snow' },
  SNOW:                  { e: '❄️', t: 'snow' },
  LIGHT_SNOW:            { e: '🌨️', t: 'light snow' },
  HEAVY_SNOW:            { e: '❄️', t: 'heavy snow' },
  SNOWSTORM:             { e: '❄️', t: 'snowstorm' },
  SNOW_PERIODICALLY_HEAVY:{ e: '❄️', t: 'heavy snow' },
  HEAVY_SNOW_STORM:      { e: '❄️', t: 'snowstorm' },
  BLOWING_SNOW:          { e: '❄️', t: 'blowing snow' },
  RAIN_AND_SNOW:         { e: '🌨️', t: 'rain and snow' },
  HAIL:                  { e: '🌨️', t: 'hail' },
  HAIL_SHOWERS:          { e: '🌨️', t: 'hail showers' },
  THUNDERSTORM:          { e: '⛈️', t: 'thunderstorm' },
  THUNDERSHOWER:         { e: '⛈️', t: 'thundershowers' },
  LIGHT_THUNDERSTORM_RAIN:{ e: '⛈️', t: 'thunderstorm' },
  SCATTERED_THUNDERSTORMS:{ e: '⛈️', t: 'scattered thunderstorms' },
  HEAVY_THUNDERSTORM:    { e: '⛈️', t: 'heavy thunderstorm' },
  FOG:                   { e: '🌫️', t: 'fog' },
  HAZE:                  { e: '🌫️', t: 'haze' },
};
function gwxCondition(wc) {
  const type = wc && wc.type;
  const mapped = type && GWX_CONDITION[type];
  if (mapped) return { emoji: mapped.e, text: mapped.t };
  const desc = wc && wc.description && (wc.description.text || wc.description);
  return { emoji: '🌡️', text: desc ? String(desc).toLowerCase() : 'mild' };
}

const gn = (v) => (v == null ? null : (typeof v === 'number' ? v : (v.degrees != null ? v.degrees : (v.value != null ? v.value : Number(v)))));
const r0 = (v) => { const n = gn(v); return n == null || Number.isNaN(Number(n)) ? null : Math.round(Number(n)); };

// "2026-05-30T06:42:00Z" → "6:42a"
function gwxClock(iso, tz) {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    let s = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz || 'UTC' });
    // "6:42 AM" → "6:42a"
    return s.replace(/\s*AM$/i, 'a').replace(/\s*PM$/i, 'p').replace(/^0/, '');
  } catch (_) { return null; }
}
// hour label "2p" / "Now"
function gwxHourLabel(iso, tz, isNow) {
  if (isNow) return 'Now';
  if (!iso) return '';
  try {
    const s = new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: tz || 'UTC' });
    return s.replace(/\s*AM$/i, 'a').replace(/\s*PM$/i, 'p');
  } catch (_) { return ''; }
}
function gwxDaylightMin(sunrise, sunset) {
  if (!sunrise || !sunset) return null;
  const a = Date.parse(sunrise), b = Date.parse(sunset);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

function gwxKey() {
  const k = process.env.GOOGLE_WEATHER_API_KEY;
  if (!k) throw new Error('GOOGLE_WEATHER_API_KEY_missing');
  return k;
}
async function gwxFetch(path, params) {
  const qs = new URLSearchParams({ key: gwxKey(), unitsSystem: 'IMPERIAL', ...params });
  const r = await fetch(`${GOOGLE_WX_BASE}/${path}?${qs}`);
  if (!r.ok) throw new Error(`google_wx_${path}_${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

// ── Enriched (modal / beta-weather) ─────────────────────────────────────────
async function googleEnriched(lat, lng, tz, label) {
  const loc = { 'location.latitude': String(lat), 'location.longitude': String(lng) };
  const [cur, days, hours] = await Promise.all([
    gwxFetch('currentConditions:lookup', loc),
    gwxFetch('forecast/days:lookup',  { ...loc, days: '2' }),
    gwxFetch('forecast/hours:lookup', { ...loc, hours: '12' }),
  ]);

  const curCond = gwxCondition(cur.weatherCondition);
  const fdays = days.forecastDays || [];
  const d0 = fdays[0] || {}, d1 = fdays[1] || {};
  const d0day = d0.daytimeForecast || {}, d1day = d1.daytimeForecast || {};
  const d0cond = gwxCondition(d0day.weatherCondition || d0.weatherCondition);
  const d1cond = gwxCondition(d1day.weatherCondition || d1.weatherCondition);
  const sunrise = d0.sunEvents && d0.sunEvents.sunriseTime;
  const sunset  = d0.sunEvents && d0.sunEvents.sunsetTime;

  const fhours = hours.forecastHours || [];
  const hourly = fhours.slice(0, 12).map((h, i) => {
    const c = gwxCondition(h.weatherCondition);
    const t = (h.interval && h.interval.startTime) || h.displayDateTime || (h.time);
    return {
      label:      gwxHourLabel(t, tz, i === 0),
      temp_f:     r0(h.temperature),
      precip_pct: r0(h.precipitation && h.precipitation.probability && h.precipitation.probability.percent),
      emoji:      c.emoji, code: null,
    };
  });

  return {
    ok: true, has_location: true, location_label: label || null,
    updated_at: cur.currentTime || new Date().toISOString(),
    current: {
      temp_f:    r0(cur.temperature),
      feels_f:   r0(cur.feelsLikeTemperature),
      humidity:  r0(cur.relativeHumidity),
      wind_mph:  r0(cur.wind && cur.wind.speed),
      gust_mph:  r0(cur.wind && cur.wind.gust),
      condition: curCond.text, emoji: curCond.emoji, code: null,
    },
    today: {
      high_f:        r0(d0.maxTemperature),
      low_f:         r0(d0.minTemperature),
      feels_high_f:  r0(d0.feelsLikeMaxTemperature),
      precip_pct:    r0(d0day.precipitation && d0day.precipitation.probability && d0day.precipitation.probability.percent),
      uv_max:        r0(d0day.uvIndex != null ? d0day.uvIndex : d0.maxUvIndex),
      condition:     d0cond.text, emoji: d0cond.emoji, code: null,
      sunrise_label: gwxClock(sunrise, tz),
      sunset_label:  gwxClock(sunset, tz),
      daylight_min:  gwxDaylightMin(sunrise, sunset),
    },
    tomorrow: {
      high_f:     r0(d1.maxTemperature),
      low_f:      r0(d1.minTemperature),
      precip_pct: r0(d1day.precipitation && d1day.precipitation.probability && d1day.precipitation.probability.percent),
      condition:  d1cond.text, emoji: d1cond.emoji, code: null,
    },
    hourly,
    provider: 'google',
  };
}

// ── Daily (brief/cron getWeather shape) ─────────────────────────────────────
// Google's days forecast is an array starting "today" in the location's tz, so
// to serve an arbitrary requested date we compute its offset from today and
// index into the array (the brief asks for today; the cron asks today+tomorrow).
function gwxLocalDate(tz) {
  try { return new Date().toLocaleDateString('en-CA', { timeZone: tz || 'UTC' }); } // YYYY-MM-DD
  catch (_) { return new Date().toISOString().slice(0, 10); }
}
function gwxDayOffset(targetDate, baseDate) {
  const a = Date.parse(baseDate + 'T00:00:00Z'), b = Date.parse(targetDate + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}
async function googleDaily(lat, lng, dateLocal, tz, label) {
  const loc = { 'location.latitude': String(lat), 'location.longitude': String(lng) };
  let offset = 0;
  if (dateLocal) offset = Math.max(0, Math.min(9, gwxDayOffset(dateLocal, gwxLocalDate(tz))));
  const days = await gwxFetch('forecast/days:lookup', { ...loc, days: String(offset + 1) });
  const d0 = (days.forecastDays || [])[offset] || (days.forecastDays || [])[0];
  if (!d0) return null;
  const day = d0.daytimeForecast || {};
  const cond = gwxCondition(day.weatherCondition || d0.weatherCondition);
  const sunrise = d0.sunEvents && d0.sunEvents.sunriseTime;
  const sunset  = d0.sunEvents && d0.sunEvents.sunsetTime;
  return {
    location:      label || null,
    temp_high_f:   r0(d0.maxTemperature),
    temp_low_f:    r0(d0.minTemperature),
    condition:     cond.text,
    weather_emoji: cond.emoji,
    weather_code:  null,
    sunrise:       sunrise || null,
    sunset:        sunset || null,
    daylight_min:  gwxDaylightMin(sunrise, sunset),
  };
}

module.exports = { googleEnriched, googleDaily, gwxCondition };
