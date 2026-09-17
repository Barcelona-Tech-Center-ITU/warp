/**
 * Capacity dashboard: per-plan peak occupancy over the booking horizon, the
 * warn/alert thresholds (CAPACITY_WARN_THRESHOLD / CAPACITY_ALERT_THRESHOLD),
 * and the zone scoping that decides which plans a regular user sees.
 *
 * The dashboard lives on Home. Plan Parking (pid 3) is the plan under test:
 * 5 seats and no sample bookings, so every percentage is exact and readable
 * (1 seat = 20%).
 */
import { test, expect } from '../fixtures';
import { logIn } from '../helpers/auth';
import { ADMIN, USER1 } from '../helpers/users';
import { querySql } from '../helpers/db';
import { futureDayTs, getZoneSeats, getFirstZoneDate, bookSeatUI } from '../helpers/booking';
import { waitForViewReady } from '../helpers/spa';

const PARKING_PID = 3;
const PARKING_ZID = 3;

function parkingCard(page: import('@playwright/test').Page) {
  return page.locator('.warp-capacity-card').filter({ hasText: 'Plan Parking' });
}

async function openDashboard(page: import('@playwright/test').Page) {
  await page.goto('/');
  await waitForViewReady(page, 'index');
}

/** Book `count` parking seats for the whole of the same future day. A precondition
 *  of "the plan is nearly full" can't be produced by a reasonable number of UI
 *  bookings, so the rows are seeded (the DB backchannel e2e/README.md allows).
 *  One throwaway account per seat: the schema forbids a user holding two
 *  overlapping bookings, and the sample data has fewer users than seats. */
async function seedFullDay(count: number): Promise<number> {
  const seats = await getZoneSeats(PARKING_ZID);
  const ts = futureDayTs(1);
  for (const [i, seat] of seats.slice(0, count).entries()) {
    const login = `capacity_user${i}`;
    await querySql(
      "INSERT INTO users (login, name, account_type) VALUES ($1, $1, 20)",
      [login],
    );
    await querySql(
      'INSERT INTO book (login, sid, fromts, tots) VALUES ($1, $2, $3, $4)',
      [login, seat.id, ts + 8 * 3600, ts + 18 * 3600],
    );
  }
  return ts;
}

test.describe('capacity dashboard', () => {

  test('the dashboard is open to every logged-in user', async ({ page }) => {
    await logIn(page, ADMIN);
    expect((await page.request.get('/capacity')).status()).toBe(200);

    await logIn(page, USER1);
    expect((await page.request.get('/capacity')).status()).toBe(200);
    expect((await page.request.get('/xhr/capacity/summary')).status()).toBe(200);
  });

  test('a regular user only sees the plans they can access', async ({ page }) => {
    // user1 reaches Zone 1A directly and Zone 1B through group_1b, but has no
    // role in Parking — so Plan Parking must not appear at all.
    await logIn(page, USER1);
    await openDashboard(page);

    await expect(page.locator('.warp-capacity-plan-name')).toHaveText(['Plan 1A', 'Plan 1B']);
    await expect(parkingCard(page)).toHaveCount(0);
  });

  test('every plan gets a card, empty plans read 0%', async ({ page }) => {
    await logIn(page, ADMIN);
    await openDashboard(page);

    await expect(page.locator('.warp-capacity-card')).toHaveCount(3);
    const card = parkingCard(page);
    await expect(card).toContainText('5');
    await expect(card.locator('.warp-capacity-badge')).toHaveText('0%');
    // No bookings anywhere in the sample data, so nothing is flagged.
    await expect(page.locator('.warp-capacity-alerts')).toBeHidden();
  });

  test('a seat booked through the UI shows up as occupancy', async ({ page }) => {
    await logIn(page, ADMIN);
    const [seat] = await getZoneSeats(PARKING_ZID);
    const ts = await getFirstZoneDate(page, PARKING_PID);
    await bookSeatUI(page, PARKING_PID, seat, [ts]);

    await openDashboard(page);

    const card = parkingCard(page);
    await expect(card.locator('.warp-capacity-badge')).toHaveText('20%');
    await expect(card.locator('.warp-capacity-day', { hasText: '1 / 5 (20%)' })).toHaveCount(1);
  });

  test('crossing the warning threshold marks the plan busy but raises no alert', async ({ page }) => {
    await seedFullDay(4);   // 4/5 = 80%: at/above warn (75), below alert (90)

    await logIn(page, ADMIN);
    await openDashboard(page);

    await expect(parkingCard(page).locator('.warp-capacity-badge')).toHaveClass(/warp-capacity-warn/);
    await expect(page.locator('.warp-capacity-alerts')).toBeHidden();
  });

  test('crossing the alert threshold lists the day as an alert', async ({ page }) => {
    await seedFullDay(5);   // 5/5 = 100%

    await logIn(page, ADMIN);
    await openDashboard(page);

    await expect(parkingCard(page).locator('.warp-capacity-badge')).toHaveClass(/warp-capacity-alert/);

    const alerts = page.locator('.warp-capacity-alerts');
    await expect(alerts).toBeVisible();
    await expect(alerts.locator('li')).toHaveCount(1);
    await expect(alerts.locator('li')).toContainText('Plan Parking');
    await expect(alerts.locator('.warp-capacity-alert-pct')).toHaveText('100%');
  });

  test('the dashboard is on Home, not in the nav; /capacity redirects there', async ({ page }) => {
    await logIn(page, USER1);
    await openDashboard(page);

    await expect(page.locator('#nav-left-dynamic a', { hasText: 'Capacity' })).toHaveCount(0);
    await expect(page.locator('.warp-capacity-card').first()).toBeVisible();

    await page.goto('/capacity');
    await waitForViewReady(page, 'index');
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(page.locator('.warp-capacity-card').first()).toBeVisible();
  });

});
