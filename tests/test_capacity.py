# Tests for the capacity dashboard's occupancy sweep (warp/xhr/capacity.py).
#
# peak_concurrency is the whole metric: everything else in the endpoint is
# plain queries, so this is where an off-by-one (double-counting a booking that
# ends exactly when the next starts, or leaking a neighbouring day into the
# count) would silently distort every percentage on the dashboard.
#
# Run with:  python -m pytest tests/  (from the repo root)

import pytest

from warp.xhr.capacity import DAY, peak_concurrency

DAY_FROM = 0
DAY_TO = DAY
H = 3600


def peak(*intervals):
    return peak_concurrency(list(intervals), DAY_FROM, DAY_TO)


def test_no_bookings():
    assert peak() == 0


def test_single_booking():
    assert peak((9 * H, 17 * H)) == 1


def test_sequential_bookings_do_not_overlap():
    # Same seat freed and re-taken, and a booking that ends exactly when
    # another starts: one seat in use at any instant, never two.
    assert peak((8 * H, 12 * H), (12 * H, 16 * H)) == 1


def test_overlapping_bookings_stack():
    assert peak((8 * H, 12 * H), (9 * H, 10 * H), (9 * H, 17 * H)) == 3


def test_peak_is_the_maximum_not_the_total():
    # Four bookings, but never more than two at the same instant.
    assert peak((8 * H, 10 * H), (9 * H, 11 * H), (14 * H, 16 * H), (15 * H, 17 * H)) == 2


def test_neighbouring_days_are_clipped_out():
    yesterday = (-6 * H, -1 * H)
    tomorrow = (DAY + H, DAY + 5 * H)
    assert peak(yesterday, tomorrow) == 0
    # A multi-day booking still counts on each day it covers.
    assert peak((-6 * H, 10 * H)) == 1
    assert peak_concurrency([(-6 * H, DAY + 5 * H)], DAY, 2 * DAY) == 1


def test_booking_touching_the_day_boundary_is_not_counted():
    # [.., 0) and [DAY, ..) are outside [0, DAY) — an empty clip, not an overlap.
    assert peak((-4 * H, 0)) == 0
    assert peak((DAY, DAY + 4 * H)) == 0


@pytest.mark.parametrize('interval', [(5 * H, 5 * H), (10 * H, 9 * H)])
def test_empty_and_inverted_intervals_are_ignored(interval):
    assert peak(interval, (9 * H, 17 * H)) == 1
