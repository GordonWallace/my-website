const SCHEDULE_FILES = ['lake-shore-limited.csv', 'southwest-chief.csv'];
const SCHEDULES_BASE = new URL('../train-trip-planner/schedules/', window.location.href).href;
const SAVED_SCHEDULES_KEY = 'train-trip-planner-hosted-saves-v1';
const HEIGHT_MESSAGE_TYPE = 'train-trip-planner:height';

const originalFetch = window.fetch.bind(window);
let routesPromise;

document.addEventListener('click', (nativeEvent) => {
    window.event = nativeEvent;
}, true);

installHeightReporter();
installFetchBridge();

function installHeightReporter() {
    const postHeight = () => {
        const height = Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0
        );
        window.parent.postMessage({ type: HEIGHT_MESSAGE_TYPE, height }, '*');
    };

    window.addEventListener('load', postHeight);
    window.addEventListener('resize', postHeight);

    const observer = new MutationObserver(() => {
        window.requestAnimationFrame(postHeight);
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
    });
}

function installFetchBridge() {
    window.fetch = async (input, init = {}) => {
        const requestUrl = new URL(typeof input === 'string' ? input : input.url, window.location.href);
        if (requestUrl.origin === window.location.origin && requestUrl.pathname.startsWith('/api/')) {
            try {
                return await handleApiRequest(requestUrl, init);
            } catch (error) {
                console.error('Bridge API error:', error);
                return jsonResponse({ error: 'Bridge error' }, 500);
            }
        }

        return originalFetch(input, init);
    };
}

async function handleApiRequest(url, init) {
    const method = (init.method || 'GET').toUpperCase();
    const pathname = url.pathname;

    if (pathname === '/api/cities' && method === 'GET') {
        const routes = await loadRoutes();
        return jsonResponse({ cities: getAllCities(routes) });
    }

    if (pathname === '/api/routes' && method === 'POST') {
        const body = parseJsonBody(init.body);
        if (!body.origin || !body.destination) {
            return jsonResponse({ error: 'Origin and destination required' }, 400);
        }

        const routes = await loadRoutes();
        const directRoutes = findDirectRoutes(routes, body.origin, body.destination);
        const responseRoutes = directRoutes.length > 0
            ? directRoutes
            : findConnectionRoutes(routes, body.origin, body.destination);
        return jsonResponse({ routes: responseRoutes });
    }

    if (pathname.startsWith('/api/stops/') && method === 'GET') {
        const routeId = Number(pathname.split('/').pop());
        const route = getRouteById(await loadRoutes(), routeId);
        return route
            ? jsonResponse({ stops: route.stops })
            : jsonResponse({ error: 'Route not found' }, 404);
    }

    if (pathname === '/api/generate-schedule' && method === 'POST') {
        const body = parseJsonBody(init.body);
        if (!body.route_id || !body.start_date) {
            return jsonResponse({ error: 'Route ID and start date required' }, 400);
        }

        const routes = await loadRoutes();
        const selectedStops = Array.isArray(body.selected_stops) ? body.selected_stops : [];
        const stopDurations = Object.fromEntries(selectedStops.map((stop) => [stop.city, Number(stop.duration) || 0]));

        let generated;
        if (typeof body.route_id === 'string' && body.route_id.startsWith('conn_')) {
            const [, route1Id, route2Id] = body.route_id.split('_');
            generated = buildConnectionSchedule({
                routes,
                route1: getRouteById(routes, Number(route1Id)),
                route2: getRouteById(routes, Number(route2Id)),
                hubCity: findConnectionHub(routes, Number(route1Id), Number(route2Id), body.origin_city, body.destination_city),
                origin: body.origin_city,
                destination: body.destination_city,
                startDate: body.start_date,
                stopDurations
            });
        } else {
            generated = buildDirectSchedule({
                route: getRouteById(routes, Number(body.route_id)),
                origin: body.origin_city,
                destination: body.destination_city,
                startDate: body.start_date,
                stopDurations,
                routes
            });
        }

        if (!generated || generated.schedule.length === 0) {
            return jsonResponse({ error: 'Unable to generate schedule' }, 400);
        }

        return jsonResponse({
            schedule: generated.schedule,
            route_name: generated.routeName,
            total_duration: calculateScheduleDuration(generated.schedule)
        });
    }

    if (pathname === '/api/save-schedule' && method === 'POST') {
        const body = parseJsonBody(init.body);
        if (!body.name || !body.schedule_data) {
            return jsonResponse({ error: 'Name and schedule data required' }, 400);
        }

        const saves = getSavedSchedules();
        const id = window.crypto.randomUUID();
        saves.unshift({
            id,
            name: body.name,
            origin: body.schedule_data.origin,
            destination: body.schedule_data.destination,
            date: body.schedule_data.start_date,
            schedule_data: body.schedule_data,
            saved_at: new Date().toISOString()
        });
        localStorage.setItem(SAVED_SCHEDULES_KEY, JSON.stringify(saves.slice(0, 24)));
        return jsonResponse({ id, status: 'ok' });
    }

    if (pathname === '/api/load-schedules' && method === 'GET') {
        const schedules = getSavedSchedules().map((item) => ({
            id: item.id,
            name: item.name,
            origin: item.origin,
            destination: item.destination,
            date: item.date,
            saved_at: item.saved_at
        }));
        return jsonResponse({ schedules });
    }

    if (pathname.startsWith('/api/load-schedule/') && method === 'GET') {
        const scheduleId = pathname.split('/').pop();
        const match = getSavedSchedules().find((item) => item.id === scheduleId);
        return match
            ? jsonResponse({ schedule_data: match.schedule_data })
            : jsonResponse({ error: 'Schedule not found' }, 404);
    }

    if (pathname.startsWith('/api/delete-schedule/') && method === 'DELETE') {
        const scheduleId = pathname.split('/').pop();
        const remaining = getSavedSchedules().filter((item) => item.id !== scheduleId);
        localStorage.setItem(SAVED_SCHEDULES_KEY, JSON.stringify(remaining));
        return jsonResponse({ status: 'ok' });
    }

    return jsonResponse({ error: 'Unsupported endpoint' }, 404);
}

function parseJsonBody(body) {
    if (!body) {
        return {};
    }
    return typeof body === 'string' ? JSON.parse(body) : body;
}

function jsonResponse(data, status = 200) {
    return new window.Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json'
        }
    });
}

async function loadRoutes() {
    if (!routesPromise) {
        routesPromise = Promise.all(
            SCHEDULE_FILES.map((fileName, index) => loadRouteFromCsv(fileName, index + 1))
        );
    }
    return routesPromise;
}

async function loadRouteFromCsv(fileName, routeId) {
    const response = await originalFetch(`${SCHEDULES_BASE}/${fileName}`, { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Failed to load ${fileName}: ${response.status}`);
    }

    const text = await response.text();
    const rows = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const routeName = parseCsvLine(rows.shift())[0].trim();
    const stops = rows.map((line, index) => {
        const [station, time] = parseCsvLine(line);
        return {
            id: routeId * 100 + index + 1,
            route_id: routeId,
            stop_number: index + 1,
            city_name: station.split(',')[0].trim(),
            stop_time: normalizeTime(time)
        };
    });

    return {
        id: routeId,
        route_name: routeName,
        origin_city: stops[0]?.city_name || '',
        destination_city: stops[stops.length - 1]?.city_name || '',
        departure_time: stops[0]?.stop_time || '',
        arrival_time: stops[stops.length - 1]?.stop_time || '',
        stops
    };
}

function parseCsvLine(line) {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (inQuotes && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (character === ',' && !inQuotes) {
            values.push(current);
            current = '';
        } else {
            current += character;
        }
    }

    values.push(current);
    return values;
}

function normalizeTime(value = '') {
    const [hours = '0', minutes = '00'] = value.trim().split(':');
    return `${String(Number(hours)).padStart(2, '0')}:${minutes.padStart(2, '0')}`;
}

function getAllCities(routes) {
    return [...new Set(routes.flatMap((route) => route.stops.map((stop) => stop.city_name)))]
        .sort((left, right) => left.localeCompare(right));
}

function findDirectRoutes(routes, origin, destination) {
    return routes
        .filter((route) => hasOrderedStops(route, origin, destination))
        .map((route) => {
            const segmentStops = getStopsBetween(route, origin, destination);
            return {
                id: route.id,
                route_name: route.route_name,
                origin_city: origin,
                destination_city: destination,
                departure_time: segmentStops[0].stop_time,
                arrival_time: segmentStops[segmentStops.length - 1].stop_time,
                duration_hours: formatDurationFromStops(segmentStops),
                is_connection: false
            };
        });
}

function findConnectionRoutes(routes, origin, destination) {
    const matches = [];
    const seen = new Set();

    for (const route1 of routes) {
        const originIndex = route1.stops.findIndex((stop) => stop.city_name === origin);
        if (originIndex === -1) {
            continue;
        }

        for (let hubIndex = originIndex + 1; hubIndex < route1.stops.length; hubIndex += 1) {
            const hubCity = route1.stops[hubIndex].city_name;
            for (const route2 of routes) {
                const hubOnRoute2 = route2.stops.findIndex((stop) => stop.city_name === hubCity);
                const destinationOnRoute2 = route2.stops.findIndex((stop) => stop.city_name === destination);
                if (hubOnRoute2 === -1 || destinationOnRoute2 === -1 || hubOnRoute2 >= destinationOnRoute2) {
                    continue;
                }

                const key = `${route1.id}:${route2.id}:${hubCity}`;
                if (seen.has(key)) {
                    continue;
                }
                seen.add(key);

                const segment1 = getStopsBetween(route1, origin, hubCity);
                const segment2 = getStopsBetween(route2, hubCity, destination);
                const preview = buildConnectionSchedule({
                    routes,
                    route1,
                    route2,
                    hubCity,
                    origin,
                    destination,
                    startDate: '2026-01-01',
                    stopDurations: {}
                });

                matches.push({
                    id: `conn_${route1.id}_${route2.id}`,
                    route_name: `${route1.route_name} → ${route2.route_name}`,
                    origin_city: origin,
                    destination_city: destination,
                    departure_time: segment1[0].stop_time,
                    arrival_time: segment2[segment2.length - 1].stop_time,
                    duration_hours: calculateScheduleDuration(preview.schedule),
                    is_connection: true,
                    connection_hub: hubCity,
                    route1_id: route1.id,
                    route2_id: route2.id
                });
            }
        }
    }

    return matches;
}

function buildDirectSchedule({ route, origin, destination, startDate, stopDurations, routes }) {
    if (!route) {
        return null;
    }

    const segmentStops = getStopsBetween(route, origin || route.origin_city, destination || route.destination_city);
    const schedule = [];

    buildSegmentTravel({
        routes,
        schedule,
        segmentStops,
        segmentDestination: destination || route.destination_city,
        startDate,
        stopDurations,
        routeName: route.route_name,
        addBoardEvent: true
    });

    return {
        routeName: route.route_name,
        schedule
    };
}

function buildConnectionSchedule({ routes, route1, route2, hubCity, origin, destination, startDate, stopDurations }) {
    if (!route1 || !route2 || !hubCity) {
        return null;
    }

    const schedule = [];
    const segment1Stops = getStopsBetween(route1, origin, hubCity);
    const firstSegment = buildSegmentTravel({
        routes,
        schedule,
        segmentStops: segment1Stops,
        segmentDestination: hubCity,
        startDate,
        stopDurations,
        routeName: route1.route_name,
        addBoardEvent: true,
        addHeader: true,
        skipFinalDisembark: true
    });

    const arrivalStop = segment1Stops[segment1Stops.length - 1];
    const arrivalDateTime = firstSegment.lastDateTime;
    const nextTrainTime = route2.stops.find((stop) => stop.city_name === hubCity)?.stop_time;
    const initialDeparture = getNextServiceDateTime(nextTrainTime, arrivalDateTime);
    const requestedHubDeparture = addHours(arrivalDateTime, stopDurations[hubCity] || 0);
    const hubDeparture = requestedHubDeparture > initialDeparture
        ? getNextServiceDateTime(nextTrainTime, requestedHubDeparture)
        : initialDeparture;
    const layoverHours = roundHours((hubDeparture - arrivalDateTime) / 36e5);

    schedule.push({
        city: hubCity,
        event: `Disembark - ${formatLayoverLabel(layoverHours)}`,
        time: formatTime(arrivalDateTime),
        date: formatDate(arrivalDateTime),
        route_name: route1.route_name
    });

    schedule.push({
        city: '',
        event: `🚆 ${route2.route_name}`,
        time: '',
        date: '',
        route_name: '',
        is_segment_header: true
    });

    schedule.push({
        city: hubCity,
        event: 'Board',
        time: formatTime(hubDeparture),
        date: formatDate(hubDeparture),
        route_name: route2.route_name
    });

    const segment2Stops = getStopsBetween(route2, hubCity, destination);
    buildSegmentTravel({
        routes,
        schedule,
        segmentStops: segment2Stops,
        segmentDestination: destination,
        startDate: formatDate(hubDeparture),
        stopDurations,
        routeName: route2.route_name,
        addBoardEvent: false,
        skipFirstStop: true,
        startDateTimeOverride: hubDeparture
    });

    return {
        routeName: `${route1.route_name} → ${route2.route_name}`,
        schedule
    };
}

function buildSegmentTravel({
    routes,
    schedule,
    segmentStops,
    segmentDestination,
    startDate,
    stopDurations,
    routeName,
    addBoardEvent,
    addHeader = false,
    skipFinalDisembark = false,
    skipFirstStop = false,
    startDateTimeOverride = null
}) {
    if (addHeader) {
        schedule.push({
            city: '',
            event: `🚆 ${routeName}`,
            time: '',
            date: '',
            route_name: '',
            is_segment_header: true
        });
    }

    let currentDateTime = startDateTimeOverride || combineDateTime(startDate, segmentStops[0].stop_time);
    let previousTime = segmentStops[0].stop_time;

    const startIndex = skipFirstStop ? 1 : 0;
    for (let index = startIndex; index < segmentStops.length; index += 1) {
        const stop = segmentStops[index];
        const isOrigin = index === 0;
        const isDestination = stop.city_name === segmentDestination;

        if (index > 0) {
            const nextDateTime = getNextServiceDateTime(stop.stop_time, currentDateTime);
            if (timeToMinutes(stop.stop_time) < timeToMinutes(previousTime) || nextDateTime > currentDateTime) {
                currentDateTime = nextDateTime;
            } else {
                currentDateTime = combineDateTime(formatDate(currentDateTime), stop.stop_time);
            }
        }

        if (isOrigin && addBoardEvent) {
            schedule.push({
                date: formatDate(currentDateTime),
                time: formatTime(currentDateTime),
                city: stop.city_name,
                event: 'Board',
                route_name: routeName
            });
            previousTime = stop.stop_time;
            continue;
        }

        if (!isDestination && stopDurations[stop.city_name] > 0) {
            schedule.push({
                date: formatDate(currentDateTime),
                time: formatTime(currentDateTime),
                city: stop.city_name,
                event: formatDurationLabel(stopDurations[stop.city_name]),
                route_name: routeName
            });

            const nextDeparture = findNextDeparture(routes, stop.city_name, addHours(currentDateTime, stopDurations[stop.city_name]), segmentDestination);
            if (!nextDeparture) {
                throw new Error(`No onward departure found from ${stop.city_name}`);
            }

            schedule.push({
                date: formatDate(nextDeparture.departureDateTime),
                time: formatTime(nextDeparture.departureDateTime),
                city: stop.city_name,
                event: 'Board',
                route_name: routeName
            });

            currentDateTime = nextDeparture.departureDateTime;
            const nextStops = nextDeparture.route.stops.slice(nextDeparture.originIndex + 1, nextDeparture.destinationIndex + 1);
            return buildSegmentTravel({
                routes,
                schedule,
                segmentStops: [nextDeparture.route.stops[nextDeparture.originIndex], ...nextStops],
                segmentDestination,
                startDate: formatDate(nextDeparture.departureDateTime),
                stopDurations,
                routeName: nextDeparture.route.route_name,
                addBoardEvent: false,
                startDateTimeOverride: nextDeparture.departureDateTime,
                skipFirstStop: true
            });
        }

        if (!(isDestination && skipFinalDisembark)) {
            schedule.push({
                date: formatDate(currentDateTime),
                time: formatTime(currentDateTime),
                city: stop.city_name,
                event: isDestination ? 'Disembark' : 'Stop',
                route_name: routeName
            });
        }

        previousTime = stop.stop_time;
    }

    return { lastDateTime: currentDateTime };
}

function findNextDeparture(routes, city, desiredDepartureDateTime, destination) {
    let bestMatch = null;

    for (const route of routes) {
        const originIndex = route.stops.findIndex((stop) => stop.city_name === city);
        const destinationIndex = route.stops.findIndex((stop) => stop.city_name === destination);
        if (originIndex === -1 || destinationIndex === -1 || originIndex >= destinationIndex) {
            continue;
        }

        const departureDateTime = getNextServiceDateTime(route.stops[originIndex].stop_time, desiredDepartureDateTime);
        if (!bestMatch || departureDateTime < bestMatch.departureDateTime) {
            bestMatch = {
                route,
                originIndex,
                destinationIndex,
                departureDateTime
            };
        }
    }

    return bestMatch;
}

function findConnectionHub(routes, route1Id, route2Id, origin, destination) {
    const route1 = getRouteById(routes, route1Id);
    const route2 = getRouteById(routes, route2Id);
    const originIndex = route1.stops.findIndex((stop) => stop.city_name === origin);
    const destinationIndex = route2.stops.findIndex((stop) => stop.city_name === destination);

    for (let index = originIndex + 1; index < route1.stops.length; index += 1) {
        const city = route1.stops[index].city_name;
        const hubIndex = route2.stops.findIndex((stop) => stop.city_name === city);
        if (hubIndex !== -1 && hubIndex < destinationIndex) {
            return city;
        }
    }

    return null;
}

function getSavedSchedules() {
    try {
        const raw = localStorage.getItem(SAVED_SCHEDULES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function getRouteById(routes, routeId) {
    return routes.find((route) => route.id === routeId) || null;
}

function getStopsBetween(route, origin, destination) {
    const originIndex = route.stops.findIndex((stop) => stop.city_name === origin);
    const destinationIndex = route.stops.findIndex((stop) => stop.city_name === destination);
    return originIndex === -1 || destinationIndex === -1 ? [] : route.stops.slice(originIndex, destinationIndex + 1);
}

function hasOrderedStops(route, origin, destination) {
    return getStopsBetween(route, origin, destination).length > 1;
}

function calculateScheduleDuration(schedule) {
    const datedEntries = schedule.filter((entry) => entry.date && entry.time);
    if (datedEntries.length < 2) {
        return '0 hours';
    }
    const durationHours = roundHours((combineDateTime(datedEntries[datedEntries.length - 1].date, datedEntries[datedEntries.length - 1].time) - combineDateTime(datedEntries[0].date, datedEntries[0].time)) / 36e5);
    return formatDurationHuman(durationHours);
}

function formatDurationFromStops(stops) {
    const startMinutes = timeToMinutes(stops[0].stop_time);
    let endMinutes = timeToMinutes(stops[stops.length - 1].stop_time);
    if (endMinutes < startMinutes) {
        endMinutes += 24 * 60;
    }
    return formatDurationHuman(roundHours((endMinutes - startMinutes) / 60));
}

function formatDurationHuman(hours) {
    const wholeHours = Math.floor(hours);
    const days = Math.floor(wholeHours / 24);
    const remainingHours = wholeHours % 24;

    if (days > 0 && remainingHours > 0) {
        return `${days} day${days === 1 ? '' : 's'} ${remainingHours} hour${remainingHours === 1 ? '' : 's'}`;
    }
    if (days > 0) {
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${stripTrailingZero(hours)} hour${hours === 1 ? '' : 's'}`;
}

function formatDurationLabel(hours) {
    return `${stripTrailingZero(roundHours(hours))} hour stop`;
}

function formatLayoverLabel(hours) {
    return `${stripTrailingZero(roundHours(hours))} hour layover`;
}

function getNextServiceDateTime(serviceTime, notBefore) {
    if (!serviceTime) {
        return notBefore;
    }
    let candidate = combineDateTime(formatDate(notBefore), serviceTime);
    while (candidate < notBefore) {
        candidate = addDays(candidate, 1);
    }
    return candidate;
}

function combineDateTime(dateLike, timeString) {
    return new Date(`${dateLike}T${normalizeTime(timeString)}:00`);
}

function addHours(date, hours) {
    return new Date(date.getTime() + hours * 36e5);
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 864e5);
}

function formatDate(date) {
    return date.toISOString().slice(0, 10);
}

function formatTime(date) {
    return date.toTimeString().slice(0, 5);
}

function timeToMinutes(timeString) {
    const [hours, minutes] = normalizeTime(timeString).split(':').map(Number);
    return (hours * 60) + minutes;
}

function roundHours(value) {
    return Math.round(value * 10) / 10;
}

function stripTrailingZero(value) {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0$/, '');
}
