const DATA_URL = '../train-trip-planner/routes.json';
const SAVED_SCHEDULES_KEY = 'train-trip-planner-saved-schedules-v1';

const state = {
    routes: [],
    cities: [],
    currentRoute: null,
    renderedSchedule: null,
    renderedStops: []
};

document.addEventListener('DOMContentLoaded', async () => {
    wireUi();
    setMinDate();
    await loadRoutes();
    renderSavedSchedules();
});

function wireUi() {
    document.getElementById('planner-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await searchRoutes();
    });
    document.getElementById('resetBtn').addEventListener('click', resetPlanner);
    document.getElementById('generateBtn').addEventListener('click', generateSchedule);
    document.getElementById('downloadBtn').addEventListener('click', downloadSchedule);
    document.getElementById('saveBtn').addEventListener('click', saveRenderedSchedule);
    document.getElementById('editBtn').addEventListener('click', showStopEditor);
}

async function loadRoutes() {
    try {
        const response = await fetch(DATA_URL);
        if (!response.ok) {
            throw new Error(`Failed to load route data: ${response.status}`);
        }
        const routes = await response.json();
        state.routes = routes.map((route) => ({
            ...route,
            origin_city: route.stops[0]?.city_name || '',
            destination_city: route.stops[route.stops.length - 1]?.city_name || '',
            departure_time: route.stops[0]?.stop_time || '',
            arrival_time: route.stops[route.stops.length - 1]?.stop_time || ''
        }));
        state.cities = [...new Set(state.routes.flatMap((route) => route.stops.map((stop) => stop.city_name)))].sort((a, b) => a.localeCompare(b));
        populateCitySelects();
        showMessage('Route data loaded.', 'success');
    } catch (error) {
        console.error(error);
        showMessage('Unable to load the planner data right now.', 'error');
    }
}

function populateCitySelects() {
    const originSelect = document.getElementById('origin');
    const destinationSelect = document.getElementById('destination');
    for (const city of state.cities) {
        const originOption = document.createElement('option');
        originOption.value = city;
        originOption.textContent = city;
        originSelect.appendChild(originOption);

        const destinationOption = document.createElement('option');
        destinationOption.value = city;
        destinationOption.textContent = city;
        destinationSelect.appendChild(destinationOption);
    }
}

function setMinDate() {
    const input = document.getElementById('startDate');
    input.min = new Date().toISOString().split('T')[0];
}

async function searchRoutes() {
    const origin = document.getElementById('origin').value;
    const destination = document.getElementById('destination').value;
    const startDate = document.getElementById('startDate').value;

    if (!origin || !destination || !startDate) {
        showMessage('Please choose an origin, destination, and start date.', 'error');
        return;
    }
    if (origin === destination) {
        showMessage('Origin and destination must be different.', 'error');
        return;
    }
    if (state.routes.length === 0) {
        showMessage('Route data is still loading.', 'error');
        return;
    }

    toggleBusy(true, 'searchBtn');
    try {
        const directRoutes = findDirectRoutes(origin, destination);
        const routes = directRoutes.length > 0 ? directRoutes : findConnectionRoutes(origin, destination);
        if (routes.length === 0) {
            hideRouteAndStopSections();
            showMessage('No supported route was found between those cities in the hosted sample data.', 'error');
            return;
        }
        renderRoutes(routes, origin, destination);
        showMessage(`${routes.length} route option${routes.length === 1 ? '' : 's'} found.`, 'success');
    } finally {
        toggleBusy(false, 'searchBtn');
    }
}

function findDirectRoutes(origin, destination) {
    return state.routes
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

function findConnectionRoutes(origin, destination) {
    const connectionRoutes = [];
    const seen = new Set();
    for (const route1 of state.routes) {
        const originIndex = route1.stops.findIndex((stop) => stop.city_name === origin);
        if (originIndex === -1) {
            continue;
        }
        for (let hubIndex = originIndex + 1; hubIndex < route1.stops.length; hubIndex += 1) {
            const hubCity = route1.stops[hubIndex].city_name;
            for (const route2 of state.routes) {
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
                const previewSchedule = buildConnectionSchedule({
                    route1,
                    route2,
                    hubCity,
                    origin,
                    destination,
                    startDate: '2026-01-01',
                    stopDurations: {}
                });
                connectionRoutes.push({
                    id: `conn_${route1.id}_${route2.id}`,
                    route_name: `${route1.route_name} → ${route2.route_name}`,
                    origin_city: origin,
                    destination_city: destination,
                    departure_time: segment1[0].stop_time,
                    arrival_time: segment2[segment2.length - 1].stop_time,
                    duration_hours: calculateScheduleDuration(previewSchedule),
                    is_connection: true,
                    connection_hub: hubCity,
                    route1_id: route1.id,
                    route2_id: route2.id
                });
            }
        }
    }
    return connectionRoutes;
}

function renderRoutes(routes, origin, destination) {
    state.currentRoute = null;
    state.renderedSchedule = null;
    state.renderedStops = [];

    const routesSection = document.getElementById('routesSection');
    const routesList = document.getElementById('routesList');
    const routesSummary = document.getElementById('routesSummary');
    routesList.innerHTML = '';
    routesSummary.textContent = `Showing routes from ${origin} to ${destination}. Select one to customize your stopovers.`;

    routes.forEach((route) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'route-card';
        card.innerHTML = `
            <h3>${escapeHtml(route.route_name)}</h3>
            ${route.is_connection ? `<div class="route-badge">Connection via ${escapeHtml(route.connection_hub)}</div>` : ''}
            <div class="route-meta">
                <div><strong>Departure</strong><div>${escapeHtml(route.departure_time)}</div></div>
                <div><strong>Arrival</strong><div>${escapeHtml(route.arrival_time)}</div></div>
                <div><strong>Duration</strong><div>${escapeHtml(route.duration_hours)}</div></div>
                <div><strong>Type</strong><div>${route.is_connection ? 'Connection' : 'Direct'}</div></div>
            </div>
        `;
        card.addEventListener('click', () => selectRoute(route, card));
        routesList.appendChild(card);
    });

    routesSection.classList.remove('hidden');
    document.getElementById('stopsSection').classList.add('hidden');
    document.getElementById('scheduleSection').classList.add('hidden');
}

function selectRoute(route, element) {
    state.currentRoute = route;
    document.querySelectorAll('.route-card').forEach((card) => card.classList.remove('selected'));
    element.classList.add('selected');
    renderStopSelection(route, []);
}

function renderStopSelection(route, selectedStops) {
    const selectedMap = new Map(selectedStops.map((stop) => [stop.city, stop.duration]));
    const stopsList = document.getElementById('stopsList');
    stopsList.innerHTML = '';

    if (route.is_connection) {
        const route1 = getRouteById(route.route1_id);
        const route2 = getRouteById(route.route2_id);
        const segment1 = getStopsBetween(route1, route.origin_city, route.connection_hub);
        const segment2 = getStopsBetween(route2, route.connection_hub, route.destination_city);
        appendStopHeading(stopsList, route1.route_name);
        appendStopRows(stopsList, segment1, route.origin_city, route.connection_hub, selectedMap, true, false);
        appendConnectionHubRow(stopsList, segment1[segment1.length - 1], segment2[0], selectedMap);
        appendStopHeading(stopsList, route2.route_name);
        appendStopRows(stopsList, segment2, route.connection_hub, route.destination_city, selectedMap, false, true);
    } else {
        const directRoute = getRouteById(route.id);
        const segmentStops = getStopsBetween(directRoute, route.origin_city, route.destination_city);
        appendStopRows(stopsList, segmentStops, route.origin_city, route.destination_city, selectedMap, true, true);
    }

    document.getElementById('stopsSection').classList.remove('hidden');
    document.getElementById('scheduleSection').classList.add('hidden');
}

function appendStopHeading(container, label) {
    const heading = document.createElement('div');
    heading.className = 'route-badge';
    heading.textContent = label;
    container.appendChild(heading);
}

function appendConnectionHubRow(container, arrivalStop, departureStop, selectedMap) {
    const stopCard = document.createElement('div');
    stopCard.className = 'stop-card';
    const inputId = `stop-${slugify(arrivalStop.city_name)}-connection`;
    const isSelected = selectedMap.has(arrivalStop.city_name);
    const duration = isSelected ? selectedMap.get(arrivalStop.city_name) : 4;
    stopCard.innerHTML = `
        <div class="stop-row">
            <input type="checkbox" id="${inputId}" data-city="${escapeHtml(arrivalStop.city_name)}" ${isSelected ? 'checked' : ''}>
            <div>
                <label for="${inputId}"><strong>${escapeHtml(arrivalStop.city_name)}</strong></label><br>
                Connection hub · arrive ${escapeHtml(arrivalStop.stop_time)} · next daily departure ${escapeHtml(departureStop.stop_time)}
            </div>
        </div>
        <div class="stop-duration ${isSelected ? 'visible' : ''}" data-duration-for="${inputId}">
            <label for="duration-${inputId}">Layover duration (hours)</label>
            <input class="duration-input" type="number" id="duration-${inputId}" min="0" max="72" step="0.5" value="${duration}">
        </div>
    `;
    const checkbox = stopCard.querySelector('input[type="checkbox"]');
    const durationRow = stopCard.querySelector('.stop-duration');
    checkbox.addEventListener('change', () => {
        durationRow.classList.toggle('visible', checkbox.checked);
    });
    container.appendChild(stopCard);
}

function appendStopRows(container, stops, originCity, destinationCity, selectedMap, includeOriginLabel, includeDestinationLabel) {
    stops.forEach((stop, index) => {
        const isOrigin = stop.city_name === originCity && index === 0;
        const isDestination = stop.city_name === destinationCity && index === stops.length - 1;
        if ((isOrigin && !includeOriginLabel) || (isDestination && !includeDestinationLabel)) {
            return;
        }
        const stopCard = document.createElement('div');
        stopCard.className = 'stop-card';
        const inputId = `stop-${slugify(stop.city_name)}-${stop.id}`;
        const duration = selectedMap.has(stop.city_name) ? selectedMap.get(stop.city_name) : 2;

        if (isOrigin || isDestination) {
            stopCard.innerHTML = `
                <div class="stop-row">
                    <div>
                        <strong>${escapeHtml(stop.city_name)}</strong><br>
                        ${isOrigin ? `Origin departure at ${escapeHtml(stop.stop_time)}` : `Destination arrival at ${escapeHtml(stop.stop_time)}`}
                    </div>
                </div>
            `;
        } else {
            stopCard.innerHTML = `
                <div class="stop-row">
                    <input type="checkbox" id="${inputId}" data-city="${escapeHtml(stop.city_name)}" ${selectedMap.has(stop.city_name) ? 'checked' : ''}>
                    <div>
                        <label for="${inputId}"><strong>${escapeHtml(stop.city_name)}</strong></label><br>
                        Arrives at ${escapeHtml(stop.stop_time)}
                    </div>
                </div>
                <div class="stop-duration ${selectedMap.has(stop.city_name) ? 'visible' : ''}" data-duration-for="${inputId}">
                    <label for="duration-${inputId}">Stop duration (hours)</label>
                    <input class="duration-input" type="number" id="duration-${inputId}" min="0" max="72" step="0.5" value="${duration}">
                </div>
            `;
            const checkbox = stopCard.querySelector('input[type="checkbox"]');
            const durationRow = stopCard.querySelector('.stop-duration');
            checkbox.addEventListener('change', () => {
                durationRow.classList.toggle('visible', checkbox.checked);
            });
        }

        container.appendChild(stopCard);
    });
}

function getSelectedStops() {
    return Array.from(document.querySelectorAll('#stopsList input[type="checkbox"]:checked')).map((checkbox) => {
        const durationInput = document.getElementById(`duration-${checkbox.id}`);
        const duration = durationInput ? Number.parseFloat(durationInput.value) : 0;
        return {
            city: checkbox.dataset.city,
            duration: Number.isFinite(duration) && duration >= 0 ? duration : 0
        };
    });
}

function generateSchedule() {
    if (!state.currentRoute) {
        showMessage('Select a route first.', 'error');
        return;
    }

    const startDate = document.getElementById('startDate').value;
    if (!startDate) {
        showMessage('Choose a start date first.', 'error');
        return;
    }

    const selectedStops = getSelectedStops();
    const stopDurations = Object.fromEntries(selectedStops.map((stop) => [stop.city, stop.duration]));
    const origin = document.getElementById('origin').value;
    const destination = document.getElementById('destination').value;

    toggleBusy(true, 'generateBtn');
    try {
        const schedule = state.currentRoute.is_connection
            ? buildConnectionSchedule({
                route1: getRouteById(state.currentRoute.route1_id),
                route2: getRouteById(state.currentRoute.route2_id),
                hubCity: state.currentRoute.connection_hub,
                origin,
                destination,
                startDate,
                stopDurations
            })
            : buildDirectSchedule({
                route: getRouteById(state.currentRoute.id),
                origin,
                destination,
                startDate,
                stopDurations
            });

        if (schedule.length === 0) {
            showMessage('Unable to build a schedule for that selection.', 'error');
            return;
        }

        const rendered = {
            route: state.currentRoute,
            origin,
            destination,
            startDate,
            selectedStops,
            schedule,
            totalDuration: calculateScheduleDuration(schedule)
        };
        state.renderedSchedule = rendered;
        state.renderedStops = selectedStops;
        renderSchedule(rendered);
        showMessage('Schedule generated.', 'success');
    } finally {
        toggleBusy(false, 'generateBtn');
    }
}

function buildDirectSchedule({ route, origin, destination, startDate, stopDurations }) {
    const segmentStops = getStopsBetween(route, origin, destination);
    if (segmentStops.length < 2) {
        return [];
    }
    const schedule = [];
    buildSegmentTravel({
        schedule,
        segmentStops,
        segmentDestination: destination,
        startDate,
        stopDurations,
        routeName: route.route_name,
        addBoardEvent: true
    });
    return schedule;
}

function buildConnectionSchedule({ route1, route2, hubCity, origin, destination, startDate, stopDurations }) {
    const schedule = [];
    const segment1Stops = getStopsBetween(route1, origin, hubCity);
    const segment2Stops = getStopsBetween(route2, hubCity, destination);
    if (segment1Stops.length < 2 || segment2Stops.length < 2) {
        return [];
    }

    schedule.push({ isSegmentHeader: true, event: `🚆 ${route1.route_name}` });
    const leg1Result = buildSegmentTravel({
        schedule,
        segmentStops: segment1Stops,
        segmentDestination: hubCity,
        startDate,
        stopDurations,
        routeName: route1.route_name,
        addBoardEvent: true
    });

    const hubArrival = combineDateTime(leg1Result.arrivalDate, leg1Result.arrivalTime);
    const requestedHubDuration = Number(stopDurations[hubCity] || 0);
    const desiredHubDeparture = addHours(hubArrival, requestedHubDuration);
    const hubDeparture = getNextServiceDateTime(segment2Stops[0].stop_time, desiredHubDeparture);
    const layoverHours = roundHours((hubDeparture.getTime() - hubArrival.getTime()) / 3600000);

    schedule.push({
        city: hubCity,
        event: formatLayoverLabel(layoverHours),
        time: formatTime(hubArrival),
        date: formatDate(hubArrival),
        route_name: route1.route_name
    });

    schedule.push({ isSegmentHeader: true, event: `🚆 ${route2.route_name}` });
    buildSegmentTravel({
        schedule,
        segmentStops: segment2Stops,
        segmentDestination: destination,
        startDate: formatDate(hubDeparture),
        stopDurations,
        routeName: route2.route_name,
        addBoardEvent: true
    });

    return schedule;
}

function buildSegmentTravel({ schedule, segmentStops, segmentDestination, startDate, stopDurations, routeName, addBoardEvent }) {
    let activeStops = segmentStops;
    let activeRouteName = routeName;
    let currentDate = parseDate(startDate);

    if (addBoardEvent) {
        schedule.push({
            city: activeStops[0].city_name,
            event: 'Board',
            time: activeStops[0].stop_time,
            date: formatDate(currentDate),
            route_name: activeRouteName
        });
    }

    let currentIndex = 0;
    let previousMinutes = timeToMinutes(activeStops[0].stop_time);
    let arrivalDate = parseDate(startDate);
    let arrivalTime = activeStops[0].stop_time;

    while (currentIndex < activeStops.length - 1) {
        const nextStop = activeStops[currentIndex + 1];
        const nextMinutes = timeToMinutes(nextStop.stop_time);
        if (nextMinutes < previousMinutes) {
            currentDate = addDays(currentDate, 1);
        }
        const isDestination = nextStop.city_name === segmentDestination && currentIndex + 1 === activeStops.length - 1;
        const requestedDuration = stopDurations[nextStop.city_name];
        const arrivalDateTime = combineDateTime(currentDate, nextStop.stop_time);

        if (!isDestination && Number.isFinite(requestedDuration) && requestedDuration > 0) {
            const desiredDeparture = addHours(arrivalDateTime, requestedDuration);
            const nextAvailable = findNextDeparture(nextStop.city_name, desiredDeparture, segmentDestination);
            if (!nextAvailable) {
                break;
            }
            const actualDeparture = combineDateTime(parseDate(nextAvailable.departureDate), nextAvailable.departureTime);
            const stopHours = roundHours((actualDeparture.getTime() - arrivalDateTime.getTime()) / 3600000);
            schedule.push({
                city: nextStop.city_name,
                event: formatDurationLabel(stopHours),
                time: nextStop.stop_time,
                date: formatDate(arrivalDateTime),
                route_name: activeRouteName
            });
            schedule.push({
                city: nextStop.city_name,
                event: 'Board',
                time: nextAvailable.departureTime,
                date: nextAvailable.departureDate,
                route_name: nextAvailable.route.route_name
            });
            activeStops = nextAvailable.remainingStops;
            activeRouteName = nextAvailable.route.route_name;
            currentDate = parseDate(nextAvailable.departureDate);
            currentIndex = 0;
            previousMinutes = timeToMinutes(activeStops[0].stop_time);
            arrivalDate = currentDate;
            arrivalTime = nextAvailable.departureTime;
            continue;
        }

        schedule.push({
            city: nextStop.city_name,
            event: isDestination ? 'Disembark' : 'Stop',
            time: nextStop.stop_time,
            date: formatDate(arrivalDateTime),
            route_name: activeRouteName
        });
        arrivalDate = currentDate;
        arrivalTime = nextStop.stop_time;
        previousMinutes = nextMinutes;
        currentIndex += 1;
    }

    return { arrivalDate, arrivalTime };
}

function findNextDeparture(city, desiredDepartureDateTime, destination) {
    const availableRoutes = state.routes.filter((route) => hasOrderedStops(route, city, destination));
    for (const route of availableRoutes) {
        const remainingStops = getStopsBetween(route, city, destination);
        if (remainingStops.length === 0) {
            continue;
        }
        const departure = getNextServiceDateTime(remainingStops[0].stop_time, desiredDepartureDateTime);
        if (departure.getTime() >= desiredDepartureDateTime.getTime()) {
            return {
                route,
                departureTime: remainingStops[0].stop_time,
                departureDate: formatDate(departure),
                remainingStops
            };
        }
    }
    return null;
}

function renderSchedule(rendered) {
    const scheduleSummary = document.getElementById('scheduleSummary');
    const scheduleBody = document.getElementById('scheduleBody');
    scheduleSummary.innerHTML = '';
    scheduleBody.innerHTML = '';

    [
        `${rendered.origin} → ${rendered.destination}`,
        rendered.route.route_name,
        rendered.totalDuration,
        `${rendered.selectedStops.length} stopover${rendered.selectedStops.length === 1 ? '' : 's'}`
    ].forEach((item) => {
        const pill = document.createElement('span');
        pill.className = 'summary-pill';
        pill.textContent = item;
        scheduleSummary.appendChild(pill);
    });

    rendered.schedule.forEach((event) => {
        const row = document.createElement('tr');
        if (event.isSegmentHeader) {
            row.className = 'segment-row';
            row.innerHTML = `<td colspan="4">${escapeHtml(event.event)}</td>`;
        } else {
            if (event.event.includes('stop') || event.event.includes('layover')) {
                row.classList.add('duration-row');
            }
            row.innerHTML = `
                <td>${escapeHtml(event.date || '')}</td>
                <td>${escapeHtml(event.time || '')}</td>
                <td>${escapeHtml(event.city || '')}</td>
                <td>${escapeHtml(event.event || '')}</td>
            `;
        }
        scheduleBody.appendChild(row);
    });

    document.getElementById('scheduleSection').classList.remove('hidden');
    document.getElementById('stopsSection').classList.add('hidden');
}

function saveRenderedSchedule() {
    if (!state.renderedSchedule) {
        showMessage('Generate a schedule before saving it.', 'error');
        return;
    }
    const name = window.prompt('Name this itinerary:', `${state.renderedSchedule.origin} to ${state.renderedSchedule.destination}`);
    if (!name) {
        return;
    }
    const savedSchedules = getSavedSchedules();
    savedSchedules.unshift({
        id: crypto.randomUUID(),
        name,
        savedAt: new Date().toISOString(),
        ...state.renderedSchedule
    });
    localStorage.setItem(SAVED_SCHEDULES_KEY, JSON.stringify(savedSchedules.slice(0, 12)));
    renderSavedSchedules();
    showMessage(`Saved "${name}" to this browser.`, 'success');
}

function renderSavedSchedules() {
    const container = document.getElementById('savedSchedulesList');
    const schedules = getSavedSchedules();
    container.innerHTML = '';

    if (schedules.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'empty-state';
        emptyState.innerHTML = '<p>No saved itineraries yet.</p>';
        container.appendChild(emptyState);
        return;
    }

    schedules.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'saved-item';
        card.innerHTML = `
            <div>
                <strong>${escapeHtml(item.name)}</strong>
                <p>${escapeHtml(item.origin)} → ${escapeHtml(item.destination)}</p>
                <p>Start date: ${escapeHtml(item.startDate)} · Saved ${formatSavedDate(item.savedAt)}</p>
            </div>
            <div class="saved-item-actions">
                <button class="action-button secondary" type="button">Load</button>
                <button class="action-button danger" type="button">Delete</button>
            </div>
        `;
        const [loadButton, deleteButton] = card.querySelectorAll('button');
        loadButton.addEventListener('click', () => loadSavedSchedule(item.id));
        deleteButton.addEventListener('click', () => deleteSavedSchedule(item.id));
        container.appendChild(card);
    });
}

function loadSavedSchedule(id) {
    const saved = getSavedSchedules().find((item) => item.id === id);
    if (!saved) {
        showMessage('That saved itinerary could not be found.', 'error');
        return;
    }

    document.getElementById('origin').value = saved.origin;
    document.getElementById('destination').value = saved.destination;
    document.getElementById('startDate').value = saved.startDate;
    state.currentRoute = saved.route;
    state.renderedSchedule = saved;
    state.renderedStops = saved.selectedStops || [];

    const matchingRouteCard = Array.from(document.querySelectorAll('.route-card')).find((card) => card.querySelector('h3')?.textContent === saved.route.route_name);
    if (matchingRouteCard) {
        document.querySelectorAll('.route-card').forEach((card) => card.classList.remove('selected'));
        matchingRouteCard.classList.add('selected');
    } else {
        renderRoutes([saved.route], saved.origin, saved.destination);
        const onlyCard = document.querySelector('.route-card');
        if (onlyCard) {
            onlyCard.classList.add('selected');
        }
    }

    renderStopSelection(saved.route, saved.selectedStops || []);
    renderSchedule(saved);
    showMessage(`Loaded "${saved.name}".`, 'success');
}

function deleteSavedSchedule(id) {
    const remaining = getSavedSchedules().filter((item) => item.id !== id);
    localStorage.setItem(SAVED_SCHEDULES_KEY, JSON.stringify(remaining));
    renderSavedSchedules();
    showMessage('Saved itinerary deleted.', 'success');
}

function showStopEditor() {
    if (!state.currentRoute) {
        return;
    }
    renderStopSelection(state.currentRoute, state.renderedStops);
}

function downloadSchedule() {
    if (!state.renderedSchedule) {
        showMessage('Generate a schedule before downloading it.', 'error');
        return;
    }
    const rows = [['Date', 'Time', 'City', 'Event']];
    state.renderedSchedule.schedule.forEach((event) => {
        if (event.isSegmentHeader) {
            rows.push(['', '', '', event.event]);
        } else {
            rows.push([event.date || '', event.time || '', event.city || '', event.event || '']);
        }
    });
    const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `train-trip-planner-${state.renderedSchedule.startDate}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
}

function resetPlanner() {
    document.getElementById('planner-form').reset();
    document.getElementById('routesSection').classList.add('hidden');
    document.getElementById('stopsSection').classList.add('hidden');
    document.getElementById('scheduleSection').classList.add('hidden');
    document.getElementById('scheduleBody').innerHTML = '';
    document.getElementById('scheduleSummary').innerHTML = '';
    state.currentRoute = null;
    state.renderedSchedule = null;
    state.renderedStops = [];
    setMinDate();
    clearMessage();
}

function getRouteById(routeId) {
    return state.routes.find((route) => String(route.id) === String(routeId));
}

function getStopsBetween(route, origin, destination) {
    const originIndex = route.stops.findIndex((stop) => stop.city_name === origin);
    const destinationIndex = route.stops.findIndex((stop, index) => index > originIndex && stop.city_name === destination);
    if (originIndex === -1 || destinationIndex === -1) {
        return [];
    }
    return route.stops.slice(originIndex, destinationIndex + 1);
}

function hasOrderedStops(route, origin, destination) {
    return getStopsBetween(route, origin, destination).length > 0;
}

function calculateScheduleDuration(schedule) {
    const events = schedule.filter((event) => !event.isSegmentHeader && event.date && event.time);
    if (events.length < 2) {
        return 'Unknown duration';
    }
    const start = combineDateTime(parseDate(events[0].date), events[0].time);
    const end = combineDateTime(parseDate(events[events.length - 1].date), events[events.length - 1].time);
    const hours = roundHours((end.getTime() - start.getTime()) / 3600000);
    return formatDurationHuman(hours);
}

function formatDurationFromStops(stops) {
    const baseDate = parseDate('2026-01-01');
    let currentDate = baseDate;
    let previousMinutes = timeToMinutes(stops[0].stop_time);
    for (let index = 1; index < stops.length; index += 1) {
        const minutes = timeToMinutes(stops[index].stop_time);
        if (minutes < previousMinutes) {
            currentDate = addDays(currentDate, 1);
        }
        previousMinutes = minutes;
    }
    const start = combineDateTime(baseDate, stops[0].stop_time);
    const end = combineDateTime(currentDate, stops[stops.length - 1].stop_time);
    return formatDurationHuman(roundHours((end.getTime() - start.getTime()) / 3600000));
}

function formatDurationHuman(hours) {
    const rounded = Math.max(0, hours);
    const days = Math.floor(rounded / 24);
    const remainingHours = rounded % 24;
    if (days > 0 && remainingHours > 0) {
        return `${days} day${days === 1 ? '' : 's'} ${stripTrailingZero(remainingHours)} hour${remainingHours === 1 ? '' : 's'}`;
    }
    if (days > 0) {
        return `${days} day${days === 1 ? '' : 's'}`;
    }
    return `${stripTrailingZero(remainingHours)} hour${remainingHours === 1 ? '' : 's'}`;
}

function formatDurationLabel(hours) {
    return `${stripTrailingZero(hours)} hour${hours === 1 ? '' : 's'} stop`;
}

function formatLayoverLabel(hours) {
    return `${stripTrailingZero(hours)} hour${hours === 1 ? '' : 's'} layover`;
}

function getNextServiceDateTime(serviceTime, notBefore) {
    let departure = combineDateTime(parseDate(formatDate(notBefore)), serviceTime);
    while (departure.getTime() < notBefore.getTime()) {
        departure = addDays(departure, 1);
    }
    return departure;
}

function getSavedSchedules() {
    try {
        const raw = localStorage.getItem(SAVED_SCHEDULES_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch (error) {
        console.error(error);
        return [];
    }
}

function showMessage(message, kind) {
    const region = document.getElementById('status-region');
    region.innerHTML = '';
    const banner = document.createElement('div');
    banner.className = kind === 'error' ? 'error-banner' : 'success-banner';
    banner.textContent = message;
    region.appendChild(banner);
}

function clearMessage() {
    document.getElementById('status-region').innerHTML = '';
}

function hideRouteAndStopSections() {
    document.getElementById('routesSection').classList.add('hidden');
    document.getElementById('stopsSection').classList.add('hidden');
    document.getElementById('scheduleSection').classList.add('hidden');
}

function toggleBusy(isBusy, buttonId) {
    const button = document.getElementById(buttonId);
    if (!button) {
        return;
    }
    button.disabled = isBusy;
    if (buttonId === 'searchBtn') {
        button.textContent = isBusy ? 'Searching…' : 'Search routes';
    }
    if (buttonId === 'generateBtn') {
        button.textContent = isBusy ? 'Building…' : 'Generate schedule';
    }
}

function parseDate(value) {
    return new Date(`${value}T00:00:00`);
}

function combineDateTime(dateLike, timeString) {
    const date = dateLike instanceof Date ? new Date(dateLike.getTime()) : parseDate(dateLike);
    const [hours, minutes] = timeString.split(':').map(Number);
    date.setHours(hours, minutes, 0, 0);
    return date;
}

function addHours(date, hours) {
    return new Date(date.getTime() + (hours * 3600000));
}

function addDays(date, days) {
    return new Date(date.getTime() + (days * 86400000));
}

function formatDate(date) {
    return new Date(date.getTime() - (date.getTimezoneOffset() * 60000)).toISOString().slice(0, 10);
}

function formatTime(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function timeToMinutes(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    return (hours * 60) + minutes;
}

function roundHours(value) {
    return Math.round(value * 2) / 2;
}

function csvEscape(value) {
    const safe = String(value ?? '');
    return `"${safe.replace(/"/g, '""')}"`;
}

function slugify(value) {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function stripTrailingZero(value) {
    return Number.isInteger(value) ? String(value) : String(value).replace(/\.0$/, '');
}

function formatSavedDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleDateString();
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
