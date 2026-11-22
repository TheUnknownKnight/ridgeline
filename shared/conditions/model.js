/**
 * Trail-conditions state model: deterministic, hourly, no AI.
 *
 * Each trail point keeps a compact physical state — snowpack (SWE, liquid water,
 * cold content, refrozen melt-freeze crust, aging albedo) and tread moisture /
 * bare-ground ice / dew & frost — and steps it through past weather and the
 * forecast. Temperature, dew point, wind, rain/snow partitioning (wet-bulb),
 * slope/horizon sunlight, diffuse light and tree canopy sheltering all interact
 * hourly, then each point reading translates into trail conditions and runoff.
 */
import { SURFACES } from './surfaces.js';
import { slopeNormal, irradianceOnSlope } from './solar.js';

export const P = {
  lapseC: 6.5,         // °C per km for air temperature
  dewLapseC: 1.8,      // °C per km for dew point
  MF: 2.1,             // mm/°C/day temperature-index melt factor
  aSnow: 0.0007,       // legacy radiation sensitivity (kept for reference/params)
  aRadSnow: 0.0042,    // mm/hr per W/m² of absorbed shortwave radiation
  MBASE: 0,
  T50: 0.8,            // 50% rain/snow hydrometeor temperature threshold (°C)
  ramp: 1.0,
  PLWHC: 0.04,         // Snow-17 liquid water holding capacity fraction
  UADJ: 0.07,          // baseline turbulent wind function when wind speed is absent
  KeMax: 1.15,         // FAO-56 max soil evaporation coefficient
  surfCool: 2.0,       // clear, calm night radiative ground cooling drop (°C)
  softMelt: 3,         // mm melt since sunrise -> soft/postholing
  freshSnow: 5,        // mm SWE of new unconsolidated snow -> fresh
  freshHours: 72,
  settledDensity: 350, // kg/m³ cold settled snow target
  wetDensity: 410,     // kg/m³ ripe isothermal snow target
  settleHours: 96,     // e-folding settling hours (halved when wet/above 0 °C)
  seedDensity: 250,    // kg/m³ baseline cold observed snowpack density
  activeLayerSwe: 75,  // mm SWE surface layer participating in overnight cooling
  crustMax: 10,        // mm equivalent max melt-freeze surface crust
  maxLapseGapM: 2500,  // clamp extreme DEM/grid elevation gaps
};

/** New-snow density (kg/m³) from air temperature (Hedstrom & Pomeroy 1998, clamped). */
const newSnowDensity = (Ta) => Math.min(200, Math.max(50, 67.92 + 51.25 * Math.exp(Math.min(0, Ta) / 2.59)));

const esatMb = (T) => 2.7489e8 * Math.exp(-4278.63 / (T + 242.792));
const eActualMb = (Td) => 6.112 * Math.exp((17.67 * Td) / (Td + 243.5));
const pressureMb = (elev) => { const He = elev / 100; return 33.86 * (29.9 - 0.335 * He + 0.00022 * Math.pow(Math.max(0, He), 2.4)); };

/** Stull (2011) wet-bulb temperature (°C) with a gentle mountain-pressure evaporative boost. */
export const wetBulbC = (Ta, Td, elevM = 0) => {
  const rh = Math.min(100, Math.max(5, 100 * (eActualMb(Td) / Math.max(0.1, eActualMb(Ta)))));
  const stull = Ta * Math.atan(0.151977 * Math.sqrt(rh + 8.313659))
    + Math.atan(Ta + rh) - Math.atan(rh - 1.676331)
    + 0.00391838 * Math.pow(rh, 1.5) * Math.atan(0.023101 * rh) - 4.686035;
  const pScale = 1013.25 / Math.max(400, pressureMb(elevM));
  return Ta - (Ta - stull) * Math.min(1.25, 0.85 + 0.15 * pScale);
};

/** Hydrometeor phase partitioning: saturated air follows T50 ± ramp, dry air cools up to 0.5 °C via evaporation. */
const snowFraction = (Ta, Tw) => {
  const evapShift = Math.max(0, Math.min(0.5, (Ta - Tw) * 0.15));
  const Tm = Ta - evapShift;
  return Math.min(1, Math.max(0, (P.T50 + P.ramp - Tm) / (2 * P.ramp)));
};

/** NWS / Environment Canada wind chill (°C), or air temperature when warm/calm. */
export const windChillC = (Ta, windMs) => {
  if (windMs == null) return Ta;
  const kmh = windMs * 3.6;
  if (Ta > 10 || kmh <= 4.8) return Ta;
  const v016 = Math.pow(kmh, 0.16);
  return 13.12 + 0.6215 * Ta - 11.37 * v016 + 0.3965 * Ta * v016;
};

/** Rain-on-snow hourly melt (Snow-17 eq. 5, using actual Td vapor pressure and wind). */
const rainOnSnowMelt = (Ta, Td, rain, elev, uEff) => {
  const sigma = 6.12e-10;
  const ea = eActualMb(Td);
  const m = sigma * (Math.pow(Ta + 273, 4) - Math.pow(273, 4))
    + 0.0125 * rain * Math.max(Ta, 0)
    + 8.5 * uEff * (1 / 6) * ((ea - 6.11) + 0.00057 * pressureMb(elev) * Ta);
  return Math.max(0, m);
};

/**
 * Radiative + turbulent heat lost from the snow surface (mm melt-equivalent/h).
 * Accounts for snow surface temperature, cloud cover, and forest-canopy sky view.
 */
const nightCooling = (Ta, Td, cloud, elev, canopy, uEff, snowSurfaceC) => {
  const sigma = 5.670e-8;
  const T = Ta + 273.15;
  const Ts = snowSurfaceC + 273.15;
  const e = eActualMb(Td);
  const c = Math.min(1, Math.max(0, cloud / 100));
  const epsSky = 1.24 * Math.pow(e / T, 1 / 7) * (1 - c) + c;
  const svf = 1 - 0.75 * canopy;
  // Trees radiate downward at air temperature, damping radiative crust formation under canopy.
  const epsEff = (1 - svf) * 0.96 + svf * epsSky;
  const lwLoss = sigma * Math.pow(Ts, 4) - epsEff * sigma * Math.pow(T, 4);
  const sensible = ((8.5 * uEff) / 6) * 0.00057 * pressureMb(elev) * (Ta - snowSurfaceC);
  return Math.max(0, (lwLoss * 3600) / 334000 - sensible);
};

/** Fraction of rain that infiltrates the trail surface vs shedding down steep terrain. */
const infiltrationFraction = (surfaceKey, slopeDeg) => {
  const s = Math.min(1, Math.max(0, slopeDeg / 45));
  if (surfaceKey === 'paved' || surfaceKey === 'rock' || surfaceKey === 'scree') {
    return Math.max(0.25, 0.8 - 0.5 * s);
  }
  return Math.max(0.55, 1 - 0.35 * Math.pow(s, 1.4));
};

const pushWindow = (buf, val, maxLen) => {
  buf.vals.push(val);
  buf.sum += val;
  if (buf.vals.length > maxLen) buf.sum -= buf.vals.shift();
};

/**
 * Step one trail point hour-by-hour through weather forcing:
 *   forcing = { time[], Ta[], Td[], P[], et0[], cloud[], sun[], elevation, wind?[] }
 *   point   = { elevM, slopeDeg, aspectDeg, canopy (0–1), surface, horizonDeg? }
 *   seed    = optional { atIndex, sweMm } from NOAA SNODAS
 *   reads   = hour indices to sample. Returns Map(index -> reading).
 */
export const runPoint = (point, forcing, { seed = null, reads = [] } = {}) => {
  const surfaceKey = point.surface || 'dirt';
  const surface = SURFACES[surfaceKey] || SURFACES.dirt;
  const canopy = Math.min(1, Math.max(0, point.canopy || 0));
  const shadeE = 1 - (2 / 3) * canopy;
  const normal = slopeNormal(point.slopeDeg, point.aspectDeg);
  const elev = point.elevM ?? forcing.elevation;
  const gap = elev - forcing.elevation;
  const dz = Math.max(-P.maxLapseGapM, Math.min(P.maxLapseGapM, gap)) / 1000;
  const wanted = new Set(reads);
  const out = new Map();

  const permanent = surfaceKey === 'ice';
  const st = {
    swe: permanent ? 500 : 0, depth: permanent ? 500 / 400 : 0,
    liq: 0, cc: 0, crust: 0, albedo: 0.75,
    fresh: 0, hoursSinceSnow: 1e9, meltToday: 0,
    De: surface.TEW, litter: 0, dew: 0, frost: 0, groundIce: 0,
    hoursDry: 0, minGround6: [],
    melt24: { vals: [], sum: 0 }, runoff48: { vals: [], sum: 0 },
  };
  const clearSnow = () => {
    st.swe = 0; st.depth = 0; st.liq = 0; st.cc = 0; st.crust = 0;
    st.fresh = 0; st.meltToday = 0; st.albedo = 0.78;
  };

  for (let h = 0; h < forcing.time.length; h++) {
    const Ta = (forcing.Ta[h] ?? 0) - P.lapseC * dz;
    const Td = Math.min(Ta, (forcing.Td[h] ?? Ta - 5) - P.dewLapseC * dz);
    const Tw = wetBulbC(Ta, Td, elev);
    const windMs = forcing.wind?.[h] != null
      ? Math.max(0.2, (forcing.wind[h] / 3.6) * (1 - 0.6 * canopy))
      : null;
    const uEff = windMs != null ? Math.max(0.03, 0.03 + 0.025 * windMs) : P.UADJ;
    const windDryFactor = windMs != null ? 1 + 0.1 * Math.max(0, windMs - 1.5) : 1;

    if (seed && h === seed.atIndex && !permanent) {
      // Preserve fresh storm snow that fell right before the SNODAS snapshot instead of wiping it.
      const keepFresh = st.hoursSinceSnow <= P.freshHours ? Math.min(st.fresh, seed.sweMm) : 0;
      const warmPrior = h > 24 && (forcing.Ta.slice(Math.max(0, h - 72), h).reduce((s, v) => s + (v ?? 0) - P.lapseC * dz, 0) / Math.min(h, 72)) > 1.5;
      const seedRho = warmPrior ? 340 : P.seedDensity;
      st.swe = Math.max(0, seed.sweMm);
      st.depth = st.swe / seedRho;
      st.liq = 0; st.cc = 0; st.crust = 0;
      st.fresh = keepFresh;
      st.albedo = warmPrior ? 0.60 : 0.72;
    }

    const precip = Math.max(0, forcing.P[h] || 0);
    const cloud = forcing.cloud[h] ?? 50;
    const c = Math.min(1, Math.max(0, cloud / 100));
    const sun = forcing.sun[h];
    const isDay = Boolean(sun);
    const irr = irradianceOnSlope(sun, normal, {
      cloud,
      canopy,
      slopeDeg: point.slopeDeg,
      horizonDeg: point.horizonDeg,
      groundAlbedo: st.swe > 0 ? st.albedo : 0.2,
    });
    const sunFactor = irr.flat > 20 ? 0.3 + 0.7 * Math.min(2, irr.total / irr.flat) : 1;

    const snowIn = precip * snowFraction(Ta, Tw);
    const rainIn = precip - snowIn;
    st.swe += snowIn;
    st.depth += snowIn / newSnowDensity(Ta);
    if (snowIn >= 0.05) {
      st.fresh += snowIn;
      st.hoursSinceSnow = 0;
      // Even a thin coating refreshes snow albedo toward clean powder (~0.86).
      const refresh = 1 - Math.exp(-snowIn / 2);
      st.albedo = st.albedo + (0.86 - st.albedo) * refresh;
    } else {
      st.hoursSinceSnow++;
    }
    if (rainIn > 0.2 || st.hoursSinceSnow > P.freshHours) st.fresh = 0;
    st.hoursDry = rainIn > 0.1 || snowIn > 0.1 ? 0 : st.hoursDry + 1;

    let melt = 0;
    let runoff = 0;
    if (st.swe > 0) {
      let pot = 0;
      if (rainIn > 0.25 && Ta > 0) {
        pot = rainOnSnowMelt(Ta, Td, rainIn, elev, uEff);
      } else {
        const thermalMelt = Ta > P.MBASE
          ? (P.MF / 24) * (1 + (windMs != null ? 0.12 * Math.max(0, windMs - 1.5) : 0)) * (Ta - P.MBASE)
            + 0.0125 * rainIn * Math.max(Ta, 0)
          : 0;
        // Absorbed shortwave can soften sunlit spring snow even slightly below 0 °C.
        const sunGate = Ta >= 0 || st.liq > 0 ? 1 : Ta > -4 ? (Ta + 4) / 4 : 0;
        const radMelt = irr.total > 0 && sunGate > 0
          ? (1 - st.albedo) * P.aRadSnow * irr.total * sunGate
          : 0;
        pot = thermalMelt + radMelt;
      }

      const snowSurfaceC = (st.liq > 0 || pot > 0.05) ? 0 : Math.min(0, Ta - 1.5 * (1 - 0.75 * canopy) * (1 - c));
      const cool = (!isDay || irr.total < 25) ? nightCooling(Ta, Td, cloud, elev, canopy, uEff, snowSurfaceC) : 0;
      const net = pot - cool;

      if (net > 0) {
        let meltBudget = net;
        const pay = Math.min(st.cc, meltBudget);
        st.cc -= pay;
        meltBudget -= pay;
        const density = st.depth > 0 ? st.swe / st.depth : P.settledDensity;
        melt = Math.min(st.swe, meltBudget);
        st.swe -= melt;
        st.depth = Math.max(0, st.depth - melt / density);
        st.liq += melt;
        if (isDay) st.meltToday += melt;
        if (melt > 0.2) st.fresh = 0;
      } else if (net < 0) {
        const coolNet = -net;
        const refreeze = Math.min(st.liq, coolNet);
        st.liq -= refreeze;
        // Melt-freeze crust forms only when actual liquid water refreezes, never on cold dry powder.
        if (refreeze > 0) st.crust = Math.min(P.crustMax, st.crust + refreeze * 1.5);
        const capCc = (Math.min(st.swe, P.activeLayerSwe) * -Math.min(0, Ta)) / 159;
        st.cc = Math.min(capCc, st.cc + (coolNet - refreeze));
      }

      st.crust = Math.max(0, st.crust - melt);
      if (!isDay) st.meltToday = 0;
      st.liq += rainIn;
      const drain = Math.max(0, st.liq - P.PLWHC * st.swe);
      st.liq -= drain;
      runoff = drain;
      st.De = Math.max(0, st.De - drain); // meltwater wets the tread underneath

      // Decay snow albedo toward ripe snow (0.50), faster when melting/wet.
      const tauAlbedo = st.liq > 0 || Ta > 0 ? 72 : 360;
      st.albedo = 0.50 + (st.albedo - 0.50) * Math.exp(-1 / tauAlbedo);

      // Settling: bulk density creeps toward settled/ripe snow.
      if (st.swe > 0.05 && st.depth > 0) {
        const wetOrWarm = st.liq > 0 || Ta > 0;
        const targetRho = wetOrWarm ? P.wetDensity : P.settledDensity;
        const tau = wetOrWarm ? P.settleHours / 2 : P.settleHours;
        const rho = st.swe / st.depth;
        if (rho < targetRho) {
          st.depth = st.swe / (rho + (targetRho - rho) * (1 - Math.exp(-1 / tau)));
        }
      }
      if (st.swe <= 0.05) clearSnow();
    } else {
      st.meltToday = 0;
      const infil = rainIn * infiltrationFraction(surfaceKey, point.slopeDeg || 0);
      runoff = rainIn - infil;
      let water = infil;
      if (surface.litter) {
        const take = Math.min(surface.litter - st.litter, water);
        st.litter += take;
        water -= take;
        st.litter = Math.max(0, st.litter - P.KeMax * (forcing.et0[h] || 0) * shadeE * sunFactor * windDryFactor * 0.5);
      }
      st.De = Math.max(0, st.De - water);
      const Kr = st.De <= surface.REW ? 1 : Math.max(0, (surface.TEW - st.De) / Math.max(1e-6, surface.TEW - surface.REW));
      st.De = Math.min(surface.TEW, st.De + Kr * P.KeMax * (forcing.et0[h] || 0) * shadeE * sunFactor * windDryFactor);
    }

    // Smooth radiative surface cooling attenuated by cloud cover, tree canopy, and wind mixing.
    const svfCanopy = 1 - 0.75 * canopy;
    const calmFactor = windMs != null ? Math.max(0.2, 1 - windMs / 6) : 1;
    const surfDrop = P.surfCool * Math.pow(1 - c, 1.4) * svfCanopy * calmFactor;
    const ground = Ta - surfDrop;

    // Dew/frost and thin bare-ground verglas inertia.
    if (st.swe <= 0.05) {
      if (ground <= Td + 0.5 && precip === 0) {
        const cond = 0.12 * calmFactor * Math.min(1, 0.3 + Math.max(0, Td + 0.5 - ground) * 0.4);
        if (ground <= 0) st.frost = Math.min(0.8, st.frost + cond);
        else st.dew = Math.min(0.6, st.dew + cond);
      } else {
        const dry = Math.max(0.015, (forcing.et0[h] || 0.02) * shadeE * sunFactor * windDryFactor);
        st.dew = Math.max(0, st.dew - dry * 0.8);
        if (ground > 0) st.frost = Math.max(0, st.frost - dry * 0.6);
      }

      const treadWet = st.De <= surface.REW;
      if (ground <= -0.2 && (treadWet || st.dew > 0.05)) {
        const rate = Math.min(0.35, -ground * 0.12);
        // Conserve mass: dry ground can only freeze liquid dew actually present, never manufacture sheet ice from frost.
        const freeze = treadWet ? rate : Math.min(st.dew, rate);
        st.groundIce = Math.min(2.5, st.groundIce + freeze);
        if (st.dew > 0) st.dew = Math.max(0, st.dew - freeze);
      } else if (st.groundIce > 0 && (ground > 0 || irr.total > 120)) {
        const iceMelt = Math.min(st.groundIce, 0.25 * Math.max(0, ground) + 0.002 * irr.total);
        st.groundIce -= iceMelt;
        st.De = Math.max(0, st.De - iceMelt);
      }
    } else {
      st.dew = 0; st.frost = 0; st.groundIce = 0;
    }

    st.minGround6.push(ground);
    if (st.minGround6.length > 6) st.minGround6.shift();
    pushWindow(st.melt24, melt, 24);
    pushWindow(st.runoff48, runoff, 48);

    if (wanted.has(h)) {
      const depthCm = st.depth * 100;
      const bareEnough = depthCm < 0.5;
      out.set(h, {
        Ta, Td, Tw, cloud, ground, minGround6: Math.min(...st.minGround6),
        beam: irr.beam, diffuse: irr.diffuse, totalSunWm2: irr.total, blockedSun: irr.blocked, isDay,
        windMs, windChillC: windChillC(Ta, windMs),
        fogRisk: cloud >= 85 && (Ta - Td) <= 1.5,
        sweMm: st.swe, depthCm, liq: st.liq, cc: st.cc, crust: st.crust, albedo: st.albedo,
        fresh: st.fresh, meltToday: st.meltToday, melt, snowmelt24hMm: st.melt24.sum, runoff48hMm: st.runoff48.sum,
        wetness: surface.TEW ? 1 - st.De / surface.TEW : 0,
        // A trace of snow doesn't stop the tread underneath from being wet (and freezing).
        wet: bareEnough && st.De <= surface.REW,
        dewWet: bareEnough ? Math.min(1, st.dew / 0.35) : 0,
        frostMm: bareEnough ? st.frost : 0,
        groundIceMm: bareEnough ? st.groundIce : 0,
        litterWet: surface.litter ? st.litter / surface.litter : 0,
        hoursDry: st.hoursDry,
      });
    }
  }
  return out;
};
