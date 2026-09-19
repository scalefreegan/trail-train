// Sunrise / sunset in race-local wall clock, with no dependency.
//
// Why: race.json carries `sun: { sunrise, sunset }`, which drives the night
// bands in web/src/race/pacing.ts and the heat bands in caffeine.ts. Today
// those two strings are hand-authored per race. build-course.mjs can compute
// them instead, from the start coordinates in the course GPX plus the race
// date and IANA timezone, and stamp them with provenance `by: "computed"`.
//
// SOURCE OF THE FORMULAS
//   NOAA Global Monitoring Laboratory, Solar Calculation Details and the
//   companion spreadsheet NOAA_Solar_Calculations_day.xls
//   (https://gml.noaa.gov/grad/solcalc/calcdetails.html). The column letters in
//   the comments below are that spreadsheet's, so the two can be diffed
//   line-by-line. NOAA in turn follows Jean Meeus, "Astronomical Algorithms"
//   (2nd ed., 1998), chapters 25 (solar position) and 28 (equation of time),
//   with the low-precision solar coordinates that are accurate to ~0.01°.
//
// ACCURACY
//   NOAA states ±1 minute for latitudes under 72°, degrading near the poles
//   because the sun crosses the horizon at a shallow angle there. Refraction is
//   handled the standard way: "sunrise" is the moment the sun's upper limb
//   touches the horizon, i.e. a zenith angle of 90.833° (0.833° = 0.53° for the
//   solar semi-diameter + 0.30° for mean atmospheric refraction). This ignores
//   observer elevation and terrain, which matter more than the algorithm's own
//   error on a mountain course — a runner deep in a canyon loses the sun long
//   before astronomical sunset.

import { raceStart, zoneOffsetMinutes } from "./clock.mjs";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Zenith angle of the sun's center at apparent sunrise/sunset, in degrees. */
const HORIZON_ZENITH_DEG = 90.833;

/** Julian Day number of 1970-01-01T00:00:00Z, the Unix epoch. */
const JD_UNIX_EPOCH = 2440587.5;

const rad = (deg) => (deg * Math.PI) / 180;
const deg = (radians) => (radians * 180) / Math.PI;

/**
 * Solar declination and the equation of time for a Julian Day.
 * @param {number} jd Julian Day (UT), fractional
 * @returns {{declDeg:number, eqTimeMin:number}} declination in degrees;
 *          equation of time (apparent solar time − mean solar time) in minutes.
 */
function solarCoordinates(jd) {
  const t = (jd - 2451545.0) / 36525.0; // G: Julian century since J2000.0

  // I: geometric mean longitude of the sun, degrees
  const meanLong = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  // J: geometric mean anomaly of the sun, degrees
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  // K: eccentricity of Earth's orbit
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  // L: equation of the center, degrees
  const center =
    Math.sin(rad(meanAnom)) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(rad(2 * meanAnom)) * (0.019993 - 0.000101 * t) +
    Math.sin(rad(3 * meanAnom)) * 0.000289;
  // M → P: true longitude, then apparent longitude (nutation + aberration)
  const trueLong = meanLong + center;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(rad(125.04 - 1934.136 * t));
  // Q → R: mean obliquity of the ecliptic, then the corrected obliquity
  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliqCorr = meanObliq + 0.00256 * Math.cos(rad(125.04 - 1934.136 * t));

  // T: solar declination, degrees
  const declDeg = deg(Math.asin(Math.sin(rad(obliqCorr)) * Math.sin(rad(appLong))));

  // U / V: "var y" and the equation of time, minutes
  const y = Math.tan(rad(obliqCorr / 2)) ** 2;
  const eqTimeMin =
    4 *
    deg(
      y * Math.sin(2 * rad(meanLong)) -
        2 * eccent * Math.sin(rad(meanAnom)) +
        4 * eccent * y * Math.sin(rad(meanAnom)) * Math.cos(2 * rad(meanLong)) -
        0.5 * y * y * Math.sin(4 * rad(meanLong)) -
        1.25 * eccent * eccent * Math.sin(2 * rad(meanAnom)),
    );

  return { declDeg, eqTimeMin };
}

/** Day fraction (0–1, may be <0 or >1) → "HH:MM" on the local clock. */
function clockFromDayFraction(fraction) {
  let minutes = Math.round(fraction * 1440);
  minutes = ((minutes % 1440) + 1440) % 1440; // wrap into the day
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Sunrise and sunset for one place on one race-local calendar day.
 *
 * Both are returned as race-local wall clock ("HH:MM"), on the same calendar
 * day, so they drop straight into `race.json.sun`. In the polar day / polar
 * night case — where the sun never crosses the horizon and the hour-angle
 * arccos has no solution — both fields are null.
 *
 * @param {{lat:number, lon:number, date:string, timeZone:string}} args
 *   lat/lon in signed decimal degrees (north and EAST positive, so a US
 *   longitude is negative); date as a race-local "YYYY-MM-DD"; timeZone an
 *   IANA id such as "America/Phoenix".
 * @returns {{sunrise: string|null, sunset: string|null}}
 */
export function sunTimes({ lat, lon, date, timeZone }) {
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
    throw new RangeError(`sun: latitude out of range: ${lat}`);
  }
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new RangeError(`sun: longitude out of range: ${lon}`);
  }
  const iso = ISO_DATE.exec(String(date));
  if (!iso) throw new TypeError(`sun: expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];

  // The zone's UTC offset for THIS date, read at race-local noon so a DST
  // transition in the small hours cannot pick the wrong side of the shift. The
  // same offset is used twice — once to place the day on the Julian scale, once
  // to put solar noon back on the local clock — so the two always agree.
  const offsetMin = zoneOffsetMinutes(raceStart(date, "12:00", timeZone), timeZone);

  // F: Julian Day of race-local NOON, expressed in UT. Evaluating the solar
  // coordinates mid-day rather than at midnight keeps the declination and
  // equation of time centered on the interval we are solving for.
  const jd = Date.UTC(year, month - 1, day, 12) / 86400000 + JD_UNIX_EPOCH - offsetMin / 1440;
  const { declDeg, eqTimeMin } = solarCoordinates(jd);

  // W: the sunrise hour angle, degrees. Its arccos argument leaves [-1, 1]
  // exactly when the sun stays above (polar day) or below (polar night) the
  // horizon for the whole 24 h.
  const cosHourAngle =
    Math.cos(rad(HORIZON_ZENITH_DEG)) / (Math.cos(rad(lat)) * Math.cos(rad(declDeg))) -
    Math.tan(rad(lat)) * Math.tan(rad(declDeg));
  if (cosHourAngle < -1 || cosHourAngle > 1) return { sunrise: null, sunset: null };
  const hourAngleDeg = deg(Math.acos(cosHourAngle));

  // X: solar noon as a fraction of the local day. 720 min = 12:00; 4 min of
  // clock time per degree of longitude; then the equation of time and the
  // zone offset move it from apparent local solar time onto the wall clock.
  const solarNoonFrac = (720 - 4 * lon - eqTimeMin + offsetMin) / 1440;
  // Y / Z: the hour angle converted to time, either side of solar noon.
  const halfDayFrac = (hourAngleDeg * 4) / 1440;

  return {
    sunrise: clockFromDayFraction(solarNoonFrac - halfDayFrac),
    sunset: clockFromDayFraction(solarNoonFrac + halfDayFrac),
  };
}
