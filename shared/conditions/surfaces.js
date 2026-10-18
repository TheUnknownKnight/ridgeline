/**
 * What is underfoot, and how it holds water, sheds it, freezes and slips.
 *
 * REW / TEW are the FAO-56 evaporation-layer parameters (mm): readily and
 * totally evaporable water. A tread is "wet" while its depletion De ≤ REW
 * and bone dry at De = TEW. Values: FAO-56 Table 19 midpoints for soils,
 * ASCE (1992) depression storage for rock and pavement; forest litter adds
 * ~7.6 mm of storage on top of the soil.
 */
export const SURFACES = {
  paved:  { label: 'Paved',                 REW: 0.5, TEW: 1,   mud: false, slick: false, iceProne: true,  dusty: false, loose: false },
  gravel: { label: 'Gravel',                REW: 4,   TEW: 9,   mud: false, slick: false, iceProne: false, dusty: true,  loose: true },
  dirt:   { label: 'Dirt',                  REW: 9,   TEW: 19,  mud: true,  slick: false, iceProne: false, dusty: true,  loose: false },
  fine:   { label: 'Wet meadow or clay',    REW: 10,  TEW: 25,  mud: true,  slick: true,  iceProne: false, dusty: false, loose: false, sticky: true },
  sand:   { label: 'Sand',                  REW: 4.5, TEW: 9,   mud: false, slick: false, iceProne: false, dusty: true,  loose: false },
  rock:   { label: 'Rock',                  REW: 1.5, TEW: 2.5, mud: false, slick: true,  iceProne: true,  dusty: false, loose: false },
  scree:  { label: 'Scree or talus',        REW: 1.5, TEW: 2.5, mud: false, slick: true,  iceProne: true,  dusty: false, loose: true },
  forest: { label: 'Forest floor',          REW: 9,   TEW: 19,  mud: true,  slick: true,  iceProne: false, dusty: false, loose: false, litter: 7.6 },
  ice:    { label: 'Glacier or permanent snow', REW: 0, TEW: 0, mud: false, slick: true,  iceProne: true,  dusty: false, loose: false },
};

/**
 * Surface class from 30 m land cover (Annual NLCD), hillslope and tree
 * canopy. Land cover describes the ground around the tread, not the tread
 * itself, so these are always labelled as inferred.
 */
export const surfaceFromLandCover = ({ nlcd, slopeDeg = 0, canopy = 0, elevationM = 0 }) => {
  switch (nlcd) {
    case 12: return 'ice';
    case 21: return 'gravel';                 // developed open space: park paths, trailheads
    case 22: case 23: case 24: return 'paved';
    case 31:                                  // barren: granite, talus, desert flats
      if (slopeDeg >= 30) return 'scree';
      return slopeDeg < 5 && elevationM < 1500 ? 'sand' : 'rock';
    case 41: case 42: case 43: return canopy >= 0.4 ? 'forest' : 'dirt';
    case 90: case 95: return 'fine';          // wetlands
    default: return 'dirt';                   // shrub, grassland, pasture, open water at 30 m
  }
};
