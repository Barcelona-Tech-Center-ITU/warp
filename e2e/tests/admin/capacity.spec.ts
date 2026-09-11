/**
 * Capacity dashboard: per-plan peak occupancy over the booking horizon, and
 * the warn/alert thresholds (CAPACITY_WARN_THRESHOLD / CAPACITY_ALERT_THRESHOLD).
 *
 * Plan Parking (pid 3) is the plan under test: 5 seats and no sample bookings,
 * so every percentage is exact and readable (1 seat = 20%).
 */
import { test, expect } from '../../fixtures';
import { logIn } from '../../helpers/auth';
import { ADMIN, USER1 } from '../../helpers/users';
import { querySql } from '../../helpers/db';
import { futureDayTs, getZoneSeats, getFirstZoneDate, bookSeatUI } from '../../helpers/booking';
import { waitForViewReady } from '../../helpers/spa';

const PARKING_PID = 3;
const PARKING_ZID = 3;

function parkingCard(page: import('@playwright/test').Page) {
  return page.locator('.warp-capacity-card').filter({ hasText: 'Plan Parking' });
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

  test('admin can access /capacity, a regular user cannot', async ({ page }) => {
    await logIn(page, ADMIN);
    expect((await page.request.get('/capacity')).status()).toBe(200);

    await logIn(page, USER1);
    expect((await page.request.get('/capacity')).status()).toBe(403);
    expect((await page.request.get('/xhr/capacity/summary')).status()).toBe(403);
  });

  test('every plan gets a card, empty plans read 0%', async ({ page }) => {
    await logIn(page, ADMIN);
    await page.goto('/capacity');
    await waitForViewReady(page, 'capacity');

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

    await page.goto('/capacity');
    await waitForViewReady(page, 'capacity');

    const card = parkingCard(page);
    await expect(card.locator('.warp-capacity-badge')).toHaveText('20%');
    await expect(card.locator('.warp-capacity-day', { hasText: '1 / 5 (20%)' })).toHaveCount(1);
  });

  test('crossing the warning threshold marks the plan busy but raises no alert', async ({ page }) => {
    await seedFullDay(4);   // 4/5 = 80%: at/above warn (75), below alert (90)

    await logIn(page, ADMIN);
    await page.goto('/capacity');
    await waitForViewReady(page, 'capacity');

    await expect(parkingCard(page).locator('.warp-capacity-badge')).toHaveClass(/warp-capacity-warn/);
    await expect(page.locator('.warp-capacity-alerts')).toBeHidden();
  });

  test('crossing the alert threshold lists the day as an alert', async ({ page }) => {
    await seedFullDay(5);   // 5/5 = 100%

    await logIn(page, ADMIN);
    await page.goto('/capacity');
    await waitForViewReady(page, 'capacity');

    await expect(parkingCard(page).locator('.warp-capacity-badge')).toHaveClass(/warp-capacity-alert/);

    const alerts = page.locator('.warp-capacity-alerts');
    await expect(alerts).toBeVisible();
    await expect(alerts.locator('li')).toHaveCount(1);
    await expect(alerts.locator('li')).toContainText('Plan Parking');
    await expect(alerts.locator('.warp-capacity-alert-pct')).toHaveText('100%');
  });

  test('capacity is reachable from the admin menu', async ({ page }) => {
    await logIn(page, ADMIN);
    await page.goto('/');
    await page.locator('nav .dropdown-trigger[data-target="admin_menu_dropdown"]').click();
    await page.locator('#admin_menu_dropdown a', { hasText: 'Capacity' }).click();
    await waitForViewReady(page, 'capacity');
    expect(new URL(page.url()).pathname).toBe('/capacity');
  });

});
