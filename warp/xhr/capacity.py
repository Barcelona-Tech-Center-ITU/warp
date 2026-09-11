from collections import defaultdict
from time import gmtime

import flask

from warp.db import *
from warp import utils

bp = flask.Blueprint('capacity', __name__, url_prefix='capacity')

DAY = 24 * 3600


def peak_concurrency(intervals, dayFrom, dayTo):
    """Max number of intervals covering the same instant within [dayFrom, dayTo).

    intervals are (fromTS, toTS) pairs on the plan's wall-clock scale (the same
    scale as book.fromts/tots); parts outside the day are clipped away. A
    booking that ends exactly when another starts is not an overlap, which the
    event sort gives for free: at an equal timestamp -1 sorts before +1."""
    events = []
    for (f, t) in intervals:
        f = max(f, dayFrom)
        t = min(t, dayTo)
        if f >= t:
            continue
        events.append((f, 1))
        events.append((t, -1))
    events.sort()

    peak = 0
    current = 0
    for (_, delta) in events:
        current += delta
        if current > peak:
            peak = current
    return peak


@bp.route("summary", endpoint='summary', methods=["GET"])
def summary():
    """Per-plan occupancy over the booking horizon: for each bookable day, the
    peak number of simultaneously booked seats against the plan's capacity."""
    if not flask.g.isAdmin:
        flask.abort(403)

    config = flask.current_app.config
    thresholds = {
        "warn": config['CAPACITY_WARN_THRESHOLD'],
        "alert": config['CAPACITY_ALERT_THRESHOLD'],
    }
    omittedWeekdays = set(config['OMITTED_WEEKDAYS'])

    plans = [*Plan.select(Plan.id, Plan.name, Plan.timezone).order_by(Plan.name).iterator()]
    if not plans:
        return {"thresholds": thresholds, "plans": []}, 200

    # A seat counts towards capacity only if it can actually be booked: enabled,
    # and in a zone that isn't disabled. The booking query filters identically so
    # numerator and denominator can never disagree.
    capacityQuery = Seat.select(Seat.pid, COUNT_STAR.alias('capacity')) \
        .join(Zone, on=(Seat.zid == Zone.id)) \
        .where(Seat.enabled == True) \
        .where(Zone.zone_type != ZONE_TYPE_DISABLED) \
        .group_by(Seat.pid)
    capacity = {r['pid']: r['capacity'] for r in capacityQuery.iterator()}

    # Each plan has its own timezone, so its horizon sits on its own wall-clock
    # scale. One query over the union of the horizons, split per plan in Python.
    ranges = {p['id']: utils.getTimeRange(p['timezone']) for p in plans}
    globalFrom = min(r['fromTS'] for r in ranges.values())
    globalTo = max(r['toTS'] for r in ranges.values())

    bookQuery = Book.select(Seat.pid, Book.fromts, Book.tots) \
        .join(Seat, on=(Book.sid == Seat.id)) \
        .join(Zone, on=(Seat.zid == Zone.id)) \
        .where(Seat.enabled == True) \
        .where(Zone.zone_type != ZONE_TYPE_DISABLED) \
        .where((Book.fromts < globalTo) & (Book.tots > globalFrom))

    bookingsByPlan = defaultdict(list)
    for b in bookQuery.iterator():
        bookingsByPlan[b['pid']].append((b['fromts'], b['tots']))

    res = []
    for p in plans:
        pid = p['id']
        cap = capacity.get(pid, 0)
        intervals = bookingsByPlan.get(pid, [])
        timeRange = ranges[pid]

        days = []
        peakPct = None
        for dayFrom in range(timeRange['fromTS'], timeRange['toTS'], DAY):
            if gmtime(dayFrom).tm_wday in omittedWeekdays:
                continue
            peak = peak_concurrency(intervals, dayFrom, dayFrom + DAY)
            pct = round(100 * peak / cap) if cap else None
            days.append({"ts": dayFrom, "peak": peak, "pct": pct})
            if pct is not None and (peakPct is None or pct > peakPct):
                peakPct = pct

        res.append({
            "pid": pid,
            "name": p['name'],
            "timezone": p['timezone'],
            "capacity": cap,
            "peakPct": peakPct,
            "days": days,
        })

    return {"thresholds": thresholds, "plans": res}, 200
