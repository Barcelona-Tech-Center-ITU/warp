"use strict";

import Utils from './modules/utils.js';

// Day timestamps are the backend's fake-UTC integers (wall-clock digits in the
// plan's zone), so they must be read back in UTC — getDay()/getDate() would
// re-anchor them to the browser's zone and shift the label by a day.
function dayLabel(ts) {
    var d = new Date(ts * 1000);
    return TR('weekdaysShort.' + d.getUTCDay()) + ' ' + d.toISOString().substring(5, 10);
}

function level(pct, thresholds) {
    if (pct === null || pct === undefined) return 'none';
    if (pct >= thresholds.alert) return 'alert';
    if (pct >= thresholds.warn) return 'warn';
    return 'ok';
}

function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
}

function renderDay(day, capacity, thresholds) {
    var row = el('li', 'warp-capacity-day');
    row.appendChild(el('span', 'warp-capacity-day-label', dayLabel(day.ts)));

    var bar = el('span', 'warp-capacity-bar');
    var fill = el('span', 'warp-capacity-bar-fill warp-capacity-' + level(day.pct, thresholds));
    fill.style.width = Math.min(day.pct || 0, 100) + '%';
    bar.appendChild(fill);
    row.appendChild(bar);

    row.appendChild(el('span', 'warp-capacity-day-value',
        day.peak + ' / ' + capacity + ' (' + day.pct + '%)'));
    return row;
}

function renderCard(plan, thresholds) {
    var card = el('div', 'card warp-capacity-card');
    var content = el('div', 'card-content');
    card.appendChild(content);

    var head = el('div', 'warp-capacity-card-head');
    var name = el('a', 'warp-capacity-plan-name', plan.name);
    name.href = window.warpGlobals.URLs['plan'].replace('__PID__', plan.pid);
    head.appendChild(name);

    if (plan.peakPct !== null) {
        head.appendChild(el('span',
            'warp-capacity-badge warp-capacity-' + level(plan.peakPct, thresholds),
            plan.peakPct + '%'));
    }
    content.appendChild(head);

    if (!plan.capacity) {
        content.appendChild(el('div', 'warp-capacity-sub', TR('capacity.NoCapacity')));
        return card;
    }

    content.appendChild(el('div', 'warp-capacity-sub',
        TR('capacity.PeakOccupancy') + ' — ' + TR('capacity.Seats', {count: plan.capacity})));

    var days = el('ul', 'warp-capacity-days');
    for (let d of plan.days)
        days.appendChild(renderDay(d, plan.capacity, thresholds));
    content.appendChild(days);

    return card;
}

function renderAlerts(container, plans, thresholds) {
    var items = [];
    for (let p of plans)
        for (let d of p.days)
            if (d.pct !== null && d.pct >= thresholds.alert)
                items.push({name: p.name, ts: d.ts, pct: d.pct});

    if (!items.length) {
        container.style.display = 'none';
        return;
    }

    container.appendChild(el('div', 'warp-capacity-alerts-title',
        TR('capacity.AlertsHeading', {pct: thresholds.alert})));
    var list = el('ul', 'warp-capacity-alerts-list');
    for (let i of items) {
        var row = el('li');
        row.appendChild(el('span', 'warp-capacity-alert-plan', i.name));
        row.appendChild(el('span', 'warp-capacity-alert-day', dayLabel(i.ts)));
        row.appendChild(el('span', 'warp-capacity-alert-pct', i.pct + '%'));
        list.appendChild(row);
    }
    container.appendChild(list);
    container.style.display = '';
}

export async function mount(ctx) {
    const root = ctx.root;

    var result = await Utils.xhr.get(window.warpGlobals.URLs['capacitySummary'], {toastOnSuccess: false});
    var data = result.response;

    var cards = root.querySelector('#capacity_cards');
    if (!data.plans.length) {
        cards.appendChild(el('div', 'warp-capacity-empty', TR('capacity.NoPlans')));
        return;
    }

    renderAlerts(root.querySelector('#capacity_alerts'), data.plans, data.thresholds);
    for (let p of data.plans)
        cards.appendChild(renderCard(p, data.thresholds));
}

export default { mount };
