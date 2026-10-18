/**
 * Read a route file (GPX, KML or GeoJSON) into one coordinate list.
 *
 * Every track and route is joined in file order, so a thru-hike exported as
 * one track per section becomes one continuous route. Only coordinates are
 * kept — names, timestamps and sensor data never leave this module.
 */
import { gpx, kml } from '@tmcw/togeojson';

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NAME_LENGTH = 120;

export class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

const UNREADABLE = "Ridgeline can't read this file. Open a GPX, KML or GeoJSON route.";
const POINTS_ONLY = 'This file has waypoints only — export it as a track.';
const NO_LINES = 'This file has no tracks or routes. Export your route as a GPX track and try again.';

const cleanName = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH) : '');

const baseName = (fileName) => cleanName(String(fileName || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''));

/** LineString parts of any geometry, recursing into collections. */
const linesOf = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates];
  if (geometry.type === 'MultiLineString') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') return (geometry.geometries || []).flatMap(linesOf);
  return [];
};

const isPointGeometry = (geometry) => geometry?.type === 'Point' || geometry?.type === 'MultiPoint';

/** Concatenate line features in order and count what was joined. */
const collect = (features) => {
  const coords = [];
  let trackCount = 0;
  let segmentCount = 0;
  let hasPoints = false;
  let firstLineName = '';
  for (const feature of features) {
    const lines = linesOf(feature?.geometry).filter(line => Array.isArray(line) && line.length);
    if (!lines.length) {
      hasPoints ||= isPointGeometry(feature?.geometry);
      continue;
    }
    trackCount++;
    segmentCount += lines.length;
    firstLineName ||= cleanName(feature.properties?.name);
    for (const line of lines) {
      for (const c of line) {
        if (Array.isArray(c)) coords.push(c.length > 2 ? [c[0], c[1], c[2]] : [c[0], c[1]]);
      }
    }
  }
  if (!coords.length) throw new ImportError(hasPoints ? POINTS_ONLY : NO_LINES);
  return { coords, trackCount, segmentCount, firstLineName };
};

/**
 * Many apps export a planned <rte> alongside the <trk> of the same trip;
 * joining both would double the mileage. Use the tracks when there are any,
 * otherwise the routes. Each element is converted on its own to keep
 * document order (togeojson emits all tracks before all routes).
 */
const gpxFeaturesInOrder = (dom) => {
  const features = [];
  const tracks = dom.querySelectorAll('trk');
  for (const el of tracks.length ? tracks : dom.querySelectorAll('rte')) {
    const single = document.implementation.createDocument(null, 'gpx', null);
    single.documentElement.append(single.importNode(el, true));
    features.push(...gpx(single).features);
  }
  return features;
};

const textOf = (dom, selector) => cleanName(dom.querySelector(selector)?.textContent);

const result = (collected, name, fileName) => ({
  coords: collected.coords,
  name: name || collected.firstLineName || baseName(fileName),
  meta: {
    fileName: String(fileName || ''),
    trackCount: collected.trackCount,
    segmentCount: collected.segmentCount,
    pointCount: collected.coords.length,
  },
});

const fromXml = (text, fileName) => {
  const dom = new DOMParser().parseFromString(text, 'application/xml');
  if (dom.getElementsByTagName('parsererror').length) {
    throw new ImportError('This file is damaged or not valid XML. Export it again from your mapping app.');
  }
  const root = dom.documentElement?.localName?.toLowerCase();
  if (root === 'gpx') {
    const collected = collect(gpxFeaturesInOrder(dom));
    return result(collected, textOf(dom, ':root > metadata > name') || textOf(dom, ':root > name'), fileName);
  }
  if (root === 'kml') {
    const collected = collect(kml(dom).features);
    return result(collected, textOf(dom, 'Document > name'), fileName);
  }
  throw new ImportError(UNREADABLE);
};

const fromGeoJson = (text, fileName) => {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError("This file isn't valid GeoJSON. Export it again, or use GPX.");
  }
  let features = [];
  if (json?.type === 'FeatureCollection') features = Array.isArray(json.features) ? json.features : [];
  else if (json?.type === 'Feature') features = [json];
  else if (json?.type) features = [{ type: 'Feature', geometry: json, properties: {} }];
  const collected = collect(features);
  return result(collected, cleanName(json?.name), fileName);
};

/** Parse file text. Detects the format from the content, not the extension. */
export const parseRouteText = (text, fileName = '') => {
  const body = String(text || '').replace(/^﻿/, '').trimStart();
  if (body.startsWith('<')) return fromXml(body, fileName);
  if (body.startsWith('{')) return fromGeoJson(body, fileName);
  throw new ImportError(UNREADABLE);
};

/** Read a File from a picker or drop. Resolves to { coords, name, meta }. */
export const readRouteFile = async (file) => {
  if (!file) throw new ImportError('No file was selected.');
  if (file.size > MAX_FILE_BYTES) {
    throw new ImportError('This file is over 50 MB. Simplify the track in your mapping app, then open it again.');
  }
  let text;
  try {
    text = await file.text();
  } catch {
    throw new ImportError("Ridgeline couldn't open this file. Try saving it again.");
  }
  return parseRouteText(text, file.name);
};
