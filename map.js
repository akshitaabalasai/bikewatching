// map.js

import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// ====== CONFIG ======

// TODO: replace with your actual Mapbox public token
mapboxgl.accessToken = 'pk.eyJ1IjoiYWtzaGl0YWFiIiwiYSI6ImNtaTFhdTNlajEzZnQya3ExbWE4NHJ5dGgifQ.YADJk8xekP2IGh0oyBYMIQ';

// minute buckets for performance
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);

// quantize scale for flow (0=arrivals, 1=departures)
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// ====== HELPERS ======

function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
  const date = new Date(0, 0, 0, 0, minutes);
  return date.toLocaleString('en-US', { timeStyle: 'short' });
}

function getCoords(station, map) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) {
    return tripsByMinute.flat();
  }

  let minMinute = (minute - 60 + 1440) % 1440;
  let maxMinute = (minute + 60) % 1440;

  if (minMinute > maxMinute) {
    const beforeMidnight = tripsByMinute.slice(minMinute);
    const afterMidnight = tripsByMinute.slice(0, maxMinute);
    return beforeMidnight.concat(afterMidnight).flat();
  } else {
    return tripsByMinute.slice(minMinute, maxMinute).flat();
  }
}

// compute arrivals/departures/totalTraffic per station
function computeStationTraffic(stations, timeFilter = -1) {
  const depTrips = filterByMinute(departuresByMinute, timeFilter);
  const arrTrips = filterByMinute(arrivalsByMinute, timeFilter);

  const departures = d3.rollup(
    depTrips,
    (v) => v.length,
    (d) => d.start_station_id
  );

  const arrivals = d3.rollup(
    arrTrips,
    (v) => v.length,
    (d) => d.end_station_id
  );

  return stations.map((station) => {
    const id = station.short_name;
    station.departures = departures.get(id) ?? 0;
    station.arrivals = arrivals.get(id) ?? 0;
    station.totalTraffic = station.departures + station.arrivals;
    return station;
  });
}

// ====== BIKE LANES (Step 2) ======

async function addBikeLanes(map) {
  // Boston
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });

  map.addLayer({
    id: 'boston-bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: {
      'line-color': 'green',
      'line-width': 3,
      'line-opacity': 0.4,
    },
  });

  // Cambridge
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://raw.githubusercontent.com/cambridgegis/cambridgegis_data/main/Recreation/Bike_Facilities/RECREATION_BikeFacilities.geojson',
  });

  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 3,
      'line-opacity': 0.4,
    },
  });
}

// ====== STATIONS + SVG OVERLAY (Step 3) ======

async function addStationsOverlay(map) {
  const svg = d3.select('#map').select('svg');

  const jsonUrl = 'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';
  const jsonData = await d3.json(jsonUrl);
  let stations = jsonData.data.stations;

  const circles = svg
    .selectAll('circle')
    .data(stations, (d) => d.short_name)
    .enter()
    .append('circle')
    .attr('r', 5)
    .attr('opacity', 0.8)
    .attr('stroke', 'white')
    .attr('stroke-width', 1)
    .style('--departure-ratio', 0.5)
    .each(function (d) {
      d3.select(this)
        .append('title')
        .text(d.name);
    });

  function updatePositions() {
    circles
      .attr('cx', (d) => getCoords(d, map).cx)
      .attr('cy', (d) => getCoords(d, map).cy);
  }

  updatePositions();
  map.on('move', updatePositions);
  map.on('zoom', updatePositions);
  map.on('resize', updatePositions);
  map.on('moveend', updatePositions);

  return { stations, svg, circles };
}

// ====== TRAFFIC + FILTERING (Steps 4–5) ======

async function setupTrafficAndFiltering(map, stations, svg, circles) {
  // load trips and bucket by minute
  await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    (trip) => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);

      const startMin = minutesSinceMidnight(trip.started_at);
      const endMin = minutesSinceMidnight(trip.ended_at);

      departuresByMinute[startMin].push(trip);
      arrivalsByMinute[endMin].push(trip);

      return trip;
    }
  );

  stations = computeStationTraffic(stations, -1);

  const radiusScale = d3
    .scaleSqrt()
    .domain([0, d3.max(stations, (d) => d.totalTraffic)])
    .range([0, 25]);

  function applyCircleVisuals(stationsData) {
    circles
      .data(stationsData, (d) => d.short_name)
      .join('circle')
      .attr('r', (d) => radiusScale(d.totalTraffic))
      .style('--departure-ratio', (d) =>
        stationFlow(
          d.totalTraffic === 0 ? 0.5 : d.departures / d.totalTraffic
        )
      )
      .each(function (d) {
        d3.select(this)
          .select('title')
          .text(
            `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`
          );
      });
  }

  applyCircleVisuals(stations);

  const timeSlider = document.getElementById('time-slider');
  const selectedTime = document.getElementById('selected-time');
  const anyTimeLabel = document.getElementById('any-time');

  function updateScatterPlot(timeFilter) {
    // change radius range depending on filter
    timeFilter === -1
      ? radiusScale.range([0, 25])
      : radiusScale.range([3, 50]);

    const filteredStations = computeStationTraffic(stations, timeFilter);
    applyCircleVisuals(filteredStations);
  }

  function updateTimeDisplay() {
    const timeFilter = Number(timeSlider.value);

    if (timeFilter === -1) {
      selectedTime.textContent = '';
      anyTimeLabel.style.display = 'block';
    } else {
      selectedTime.textContent = formatTime(timeFilter);
      anyTimeLabel.style.display = 'none';
    }

    updateScatterPlot(timeFilter);
  }

  timeSlider.addEventListener('input', updateTimeDisplay);
  updateTimeDisplay();
}

// ====== MAIN MAP INIT ======

const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

map.on('load', async () => {
  await addBikeLanes(map);
  const { stations, svg, circles } = await addStationsOverlay(map);
  await setupTrafficAndFiltering(map, stations, svg, circles);
});