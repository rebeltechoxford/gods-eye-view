# US airports

Positions of 5,871 airports in the United States and its territories, keyed
by ICAO-style identifier (`KUOX`, `PANC`, `TJSJ`, and `K` + the FAA local code
for small fields). The host uses it to place FIS-B weather text (METAR, TAF,
winds aloft, PIREP) and NOTAMs on the map, since FIS-B text carries only a
station identifier. It is read on the server and never loaded by the browser.

Source: OurAirports `airports.csv` (https://ourairports.com/data/), retrieved
2026-10-17. Rebuild with `node scripts/build-us-airports.mjs airports.csv`;
the script documents the filter and rounding.

License: public domain (OurAirports dedicates its data to the public domain
under The Unlicense).

Coverage check: 547 of the 554 METAR/TAF stations in FIS-B test group 30
resolve; the rest are weather stations that are not airports or closed
fields, and are listed without a map position.
