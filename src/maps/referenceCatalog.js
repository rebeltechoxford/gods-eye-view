/** Curated reference maps. Portable data only: no credentials or acquisition. */
export const CORE_MAP_IDS = Object.freeze([
  'photoreal',
  'bing-aerial',
  'bing-labels',
  'esri-imagery',
  'osm',
]);
const esriTerms =
  'https://doc.arcgis.com/en/arcgis-online/reference/access-use-constraints.htm';
const faaRoot =
  'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/';
const faaCredit =
  'Federal Aviation Administration, Aeronautical Information Services';
export const REFERENCE_MAPS = Object.freeze(
  [
    {
      id: 'esri-topo',
      label: 'Esri Topographic · legacy',
      shortLabel: 'TOPO',
      family: 'Reference maps',
      sourceType: 'arcgis',
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer',
      maximumLevel: 23,
      coverage: 'Global topographic reference; detail varies by region.',
      lifecycle:
        'Legacy raster; not updated since 2021; retirement December 2029.',
      credit:
        'Sources: Esri, HERE, Garmin, Intermap, increment P Corp., GEBCO, USGS, FAO, NPS, NRCAN, GeoBase, IGN, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), © OpenStreetMap contributors, and the GIS User Community',
      termsUrl: esriTerms,
      aliases: ['esri topo', 'esri topographic'],
    },
    {
      id: 'esri-terrain',
      label: 'Esri Terrain · legacy',
      shortLabel: 'RELIEF',
      family: 'Reference maps',
      sourceType: 'arcgis',
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer',
      maximumLevel: 13,
      coverage:
        'Global shaded relief and bathymetry imagery; terrain heights use the existing GEV terrain provider.',
      lifecycle:
        'Legacy raster; not updated since 2021; retirement December 2029.',
      credit: 'Sources: Esri, USGS, NOAA',
      termsUrl: esriTerms,
      aliases: ['esri terrain', 'esri relief'],
    },
    {
      id: 'esri-ocean',
      label: 'Esri Ocean',
      shortLabel: 'OCEAN',
      family: 'Reference maps',
      sourceType: 'arcgis',
      url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer',
      maximumLevel: 16,
      coverage:
        'Global ocean bathymetry reference; this is not a nautical chart.',
      credit: 'Esri, Garmin, GEBCO, NOAA NGDC, and other contributors',
      termsUrl: esriTerms,
      aliases: ['esri ocean', 'ocean basemap'],
    },
    {
      id: 'usgs-topo',
      label: 'USGS Topographic',
      shortLabel: 'USGS',
      family: 'Reference maps',
      sourceType: 'arcgis',
      url: 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer',
      maximumLevel: 23,
      coverage:
        'United States topographic detail with global reference context; source coverage varies.',
      credit:
        'USGS The National Map: National Boundaries Dataset, 3DEP Elevation Program, Geographic Names Information System, National Hydrography Dataset, National Land Cover Database, National Structures Dataset, National Transportation Dataset; USGS Global Ecosystems; U.S. Census Bureau TIGER/Line; USFS Roads; Natural Earth; U.S. Department of State HIU; NOAA NCEI',
      termsUrl:
        'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer',
      aliases: ['usgs topo', 'usgs topographic', 'usgs'],
    },
    {
      id: 'noaa-enc',
      label: 'NOAA Electronic Nautical Charts',
      shortLabel: 'ENC',
      family: 'Nautical charts',
      sourceType: 'wms',
      url: 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/WMSServer',
      layers: '0,1,2,3,4,5,6,7,8,9,10,11,12',
      maximumLevel: 18,
      coverage:
        'NOAA-charted U.S. waters; no global chart coverage. Weekly updates can interrupt service.',
      referenceOnly: true,
      credit: 'NOAA Office of Coast Survey',
      termsUrl: 'https://nauticalcharts.noaa.gov/learn/faq.html',
      aliases: [
        'noaa enc',
        'noaa charts',
        'nautical charts',
        'electronic nautical charts',
      ],
    },
    {
      id: 'faa-vfr',
      label: 'FAA VFR Sectional',
      shortLabel: 'VFR',
      family: 'Aviation charts',
      sourceType: 'arcgis',
      url: `${faaRoot}VFR_Sectional/MapServer`,
      minimumChartLevel: 8,
      maximumLevel: 12,
      coverage:
        'U.S. sectional coverage varies. Zoom in for chart detail (levels 8–12). Check current edition and alerts.',
      referenceOnly: true,
      credit: faaCredit,
      termsUrl:
        'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/vfr/',
      aliases: ['faa vfr', 'vfr sectional', 'sectional charts'],
    },
    {
      id: 'faa-ifr-low',
      label: 'FAA IFR Low / Area',
      shortLabel: 'IFR LOW',
      family: 'Aviation charts',
      sourceType: 'arcgis',
      url: `${faaRoot}IFR_AreaLow/MapServer`,
      minimumChartLevel: 7,
      maximumLevel: 12,
      coverage:
        'U.S. low-altitude/area chart coverage varies. Zoom in for chart detail (levels 7–12). Check current edition and alerts.',
      referenceOnly: true,
      credit: faaCredit,
      termsUrl:
        'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/ifr/',
      aliases: ['faa ifr low', 'ifr low', 'low altitude charts'],
    },
    {
      id: 'faa-ifr-high',
      label: 'FAA IFR High',
      shortLabel: 'IFR HIGH',
      family: 'Aviation charts',
      sourceType: 'arcgis',
      url: `${faaRoot}IFR_High/MapServer`,
      minimumChartLevel: 5,
      maximumLevel: 9,
      coverage:
        'CONUS and Alaska high-altitude enroute charts; detail varies (levels 5–9). Check current edition and alerts.',
      referenceOnly: true,
      credit: faaCredit,
      termsUrl:
        'https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/ifr/',
      aliases: ['faa ifr high', 'ifr high', 'high altitude charts'],
    },
  ].map((entry) =>
    Object.freeze({
      ...entry,
      kind: 'reference',
      requiresIon: false,
      aliases: Object.freeze(entry.aliases),
    }),
  ),
);
export const REFERENCE_MAP_IDS = Object.freeze(
  REFERENCE_MAPS.map(({ id }) => id),
);
export const ALL_MAP_IDS = Object.freeze([
  ...CORE_MAP_IDS,
  ...REFERENCE_MAP_IDS,
]);
export function referenceMap(id) {
  return REFERENCE_MAPS.find((entry) => entry.id === id) || null;
}
