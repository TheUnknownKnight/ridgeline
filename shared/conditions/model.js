/**
 * Trail-conditions state model: deterministic, hourly, no AI.
 *
 * Each trail point keeps a tiny state — snowpack (SWE, liquid water, cold
 * content, refrozen crust) and the wetness of the tread (FAO-56 surface
 * depletion) — and steps it through ~10 days of past weather and 3 days of
 * forecast. Air temperature is moved to the point's own elevation; sun on
 * the slope comes from its hillslope steepness and direction; trees shade
 * it. Then each hour can be read as "what is underfoot".
 *
 * Parameter sources (see .scratch/conditions/research.md):
 *  melt: Hock (1999) radiation-enhanced temperature index, MF 2.1 mm/°C/day, a 0.7e-3;
 *  rain/snow split: Snow-17 PXTEMP 1 °C ± 1 °C; rain-on-snow: Snow-17 eq. 5;
 *  liquid holding 4% (Snow-17 PLWHC); canopy transmissivity 1 − 0.8·fc (Ellis & Pomeroy 2007);
 *  tread bucket: FAO-56 eq. 77 (Ke max 1.15); night ground ~2 °C under the air on clear nights (NWS).
 * Snow firmness thresholds are heuristics and need field calibration.
 */
import { SURFACES } from './surfaces.js';
import { slopeNormal, beamOnSlope } from './solar.js';

export const P = {
  lapseC: 6.5,         // °C per km for air temperature
  dewLapseC: 1.8,      // °C per km for dew point
  MF: 2.1, aSnow: 0.0007, MBASE: 0, T50: 1.0, ramp: 1.0, PLWHC: 0.04, UADJ: 0.07,
  KeMax: 1.15,
  surfCool: 2.0,
  softMelt: 3,         // mm of melt since sunrise: soft, postholing likely
  freshSnow: 5,        // mm SWE of new, unconsolidated snow: fresh
  freshHours: 72,      // new snow counts as fresh this long without more snow (heuristic)
  settledDensity: 350, // kg/m³ that snow settles toward
  settleHours: 96,     // e-folding time of settling (48 h when wet or above freezing)
  seedDensity: 250,    // kg/m³ for an observed snowpack (Sturm 2010, early/mid season)
  activeLayerSwe: 75,  // mm: the top ~25 cm a night's cold reaches (not the whole pack)
  crustMax: 10,        // mm of refrozen surface crust a clear night can build
  maxLapseGapM: 2500,  // trail–cell elevation gaps are clamped here (bad elevations are caught upstream)
};

/** New-snow density (kg/m³) from air temperature, Hedstrom & Pomeroy (1998), clamped. */
const newSnowDensity = (Ta) => Math.min(200, Math.max(50, 67.92 + 51.25 * Math.exp(Math.min(0, Ta) / 2.59)));

const esatMb = (T) => 2.7489e8 * Math.exp(-4278.63 / (T + 242.792));
const snowFraction = (Ta) => Math.min(1, Math.max(0, (P.T50 + P.ramp - Ta) / (2 * P.ramp)));
const pressureMb = (elev) => { const He = elev / 100; return 33.86 * (29.9 - 0.335 * He + 0.00022 * Math.pow(Math.max(0, He), 2.4)); };

const rainOnSnowMelt = (Ta, rain, elev) => {
  const sigma = 6.12e-10;
  const m = sigma * (Math.pow(Ta + 273, 4) - Math.pow(273, 4)) + 0.0125 * rain * Math.max(Ta, 0)
    + 8.5 * P.UADJ * (1 / 6) * ((0.9 * esatMb(Ta) - 6.11) + 0.00057 * pressureMb(elev) * Ta);
  return Math.max(0, m);
};

/** Heat a snow surface loses on a night hour (mm of melt-equivalent): longwave out, less sensible heat in. */
const nightCooling = (Ta, Td, cloud, elev) => {
  const sigma = 5.670e-8;
  const T = Ta + 273.15;
  const e = 6.112 * Math.exp((17.67 * Td) / (Td + 243.5));
  const c = Math.min(1, Math.max(0, cloud / 100));
  const eps = 1.24 * Math.pow(e / T, 1 / 7) * (1 - c) + c;
  const lwLoss = sigma * Math.pow(273.15, 4) - eps * sigma * Math.pow(T, 4);
  const sensible = ((8.5 * P.UADJ) / 6) * 0.00057 * pressureMb(elev) * Ta;
  return Math.max(0, (lwLoss * 3600) / 334000 - sensible);
};

/** Share of clear-sky sun that gets through cloud (Kasten–Czeplak). */
const sunThroughCloud = (cloud) => 1 - 0.75 * Math.pow(Math.min(1, Math.max(0, cloud / 100)), 3.4);

/**
 * Forcing for one weather cell, hour by hour:
 * { time[], Ta[], Td[], P[], et0[], cloud[], sun[] (sunHour() or null), elevation }.
 * point: { elevM, slopeDeg, aspectDeg, canopy (0–1), surface }.
 * seed: optional { atIndex, sweMm } — an observed snowpack (SNODAS) that resets the model at that hour.
 * reads: hour indices to report. Returns Map(index → reading).
 */
export const runPoint = (point, forcing, { seed = null, reads = [] } = {}) => {
  const surface = SURFACES[point.surface] || SURFACES.dirt;
  const canopy = Math.min(1, Math.max(0, point.canopy || 0));
  const tauC = 1 - 0.8 * canopy;
  const shadeE = 1 - (2 / 3) * canopy;
  const normal = slopeNormal(point.slopeDeg, point.aspectDeg);
  const elev = point.elevM ?? forcing.elevation;
  const gap = elev - forcing.elevation;
  const dz = Math.max(-P.maxLapseGapM, Math.min(P.maxLapseGapM, gap)) / 1000;
  const wanted = new Set(reads);
  const out = new Map();

  const permanent = point.surface === 'ice';
  const st = {
    swe: permanent ? 500 : 0, depth: permanent ? 500 / 400 : 0, liq: 0, cc: 0, crust: 0,
    fresh: 0, hoursSinceSnow: 1e9, meltToday: 0,
    De: surface.TEW, litter: 0, hoursDry: 0, minGround6: [],
  };
  const clearSnow = () => { st.swe = 0; st.depth = 0; st.liq = 0; st.cc = 0; st.crust = 0; st.fresh = 0; st.meltToday = 0; };

  for (let h = 0; h < forcing.time.length; h++) {
    if (seed && h === seed.atIndex && !permanent) {
      st.swe = Math.max(0, seed.sweMm);
      st.depth = st.swe / P.seedDensity;
      st.liq = 0; st.cc = 0; st.crust = 0; st.fresh = 0;
    }
    const Ta = (forcing.Ta[h] ?? 0) - P.lapseC * dz;
    const Td = Math.min(Ta, (forcing.Td[h] ?? Ta - 5) - P.dewLapseC * dz);
    const precip = Math.max(0, forcing.P[h] || 0);
    const cloud = forcing.cloud[h] ?? 50;
    const sun = forcing.sun[h];
    const isDay = Boolean(sun);
    const beam = beamOnSlope(sun, normal);
    const beamFlat = sun ? sun.dni * sun.z : 0;
    const gRatio = sunThroughCloud(cloud);

    const snowIn = precip * snowFraction(Ta);
    const rainIn = precip - snowIn;
    st.swe += snowIn;
    st.depth += snowIn / newSnowDensity(Ta);
    // "Fresh" follows the storm total, not single hours; rain or a few quiet days end it.
    if (snowIn >= 0.05) { st.fresh += snowIn; st.hoursSinceSnow = 0; } else st.hoursSinceSnow++;
    if (rainIn > 0.2 || st.hoursSinceSnow > P.freshHours) st.fresh = 0;
    st.hoursDry = rainIn > 0.1 || snowIn > 0.1 ? 0 : st.hoursDry + 1;

    let melt = 0;
    if (st.swe > 0) {
      let pot = 0;
      if (rainIn > 0.25 && Ta > 0) pot = rainOnSnowMelt(Ta, rainIn, elev);
      else if (Ta > P.MBASE) pot = (P.MF / 24 + P.aSnow * beam * gRatio * tauC) * (Ta - P.MBASE) + 0.0125 * rainIn * Math.max(Ta, 0);
      const cool = isDay ? 0 : nightCooling(Ta, Td, cloud, elev);
      if (pot > 0) {
        const pay = Math.min(st.cc, pot);
        st.cc -= pay;
        pot -= pay;
        const density = st.depth > 0 ? st.swe / st.depth : P.settledDensity;
        melt = Math.min(st.swe, pot);
        st.swe -= melt;
        st.depth = Math.max(0, st.depth - melt / density);
        st.liq += melt;
        if (isDay) st.meltToday += melt;
        if (melt > 0.2) st.fresh = 0;
      } else {
        const refreeze = Math.min(st.liq, cool);
        st.liq -= refreeze;
        // Only the surface layer a night's cold reaches builds cold content, not the whole pack.
        st.cc = Math.min((Math.min(st.swe, P.activeLayerSwe) * -Math.min(0, Td)) / 159, st.cc + (cool - refreeze));
      }
      // A clear night refreezes the surface into a crust even when the air stays just above 0 °C.
      if (!isDay && cool > 0) st.crust = Math.min(P.crustMax, st.crust + cool);
      st.crust = Math.max(0, st.crust - melt);
      if (!isDay) st.meltToday = 0;
      st.liq += rainIn;
      const drain = Math.max(0, st.liq - P.PLWHC * st.swe);
      st.liq -= drain;
      st.De = Math.max(0, st.De - drain); // meltwater wets the tread under the snow
      // Settling: bulk density creeps toward settled snow, faster when wet or warm.
      if (st.swe > 0.05 && st.depth > 0) {
        const tau = st.liq > 0 || Ta > 0 ? P.settleHours / 2 : P.settleHours;
        const rho = st.swe / st.depth;
        st.depth = st.swe / (rho + (P.settledDensity - rho) * (1 - Math.exp(-1 / tau)));
      }
      if (st.swe <= 0.05) clearSnow();
    } else {
      st.meltToday = 0;
      let water = rainIn;
      if (surface.litter) {
        const take = Math.min(surface.litter - st.litter, water);
        st.litter += take;
        water -= take;
        st.litter = Math.max(0, st.litter - P.KeMax * (forcing.et0[h] || 0) * shadeE * 0.5);
      }
      st.De = Math.max(0, st.De - water);
      // Evaporation follows the sun on this slope, not on flat ground.
      const sunFactor = beamFlat > 20 ? 0.3 + 0.7 * Math.min(2, beam / beamFlat) : 1;
      const Kr = st.De <= surface.REW ? 1 : Math.max(0, (surface.TEW - st.De) / Math.max(1e-6, surface.TEW - surface.REW));
      st.De = Math.min(surface.TEW, st.De + Kr * P.KeMax * (forcing.et0[h] || 0) * shadeE * sunFactor);
    }

    const ground = Ta - (cloud < 30 && !isDay ? P.surfCool : 0);
    st.minGround6.push(ground);
    if (st.minGround6.length > 6) st.minGround6.shift();

    if (wanted.has(h)) {
      const depthCm = st.depth * 100;
      out.set(h, {
        Ta, ground, minGround6: Math.min(...st.minGround6), beam, isDay,
        sweMm: st.swe, depthCm, liq: st.liq, cc: st.cc, crust: st.crust,
        fresh: st.fresh, meltToday: st.meltToday, melt,
        wetness: surface.TEW ? 1 - st.De / surface.TEW : 0,
        // A trace of snow doesn't stop the tread underneath from being wet (and freezing).
        wet: depthCm < 0.5 && st.De <= surface.REW,
        litterWet: surface.litter ? st.litter / surface.litter : 0,
        hoursDry: st.hoursDry,
      });
    }
  }
  return out;
};
