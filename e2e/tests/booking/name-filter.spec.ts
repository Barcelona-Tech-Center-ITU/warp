/**
 * Bookings page "User name" header filter starts empty over whatever the
 * actor is allowed to see, then uses a regular starts-with match on type.
 * Logged in as user1 (zone admin of Zone 1) so both names stay visible.
 */
import { test, expect } from '../../fixtures';
import { logIn } from '../../helpers/auth';
import { USER1, USER2 } from '../../helpers/users';
import { querySql } from '../../helpers/db';
import { getZoneSeats, futureDayTs } from '../../helpers/booking';
import { fillHeaderFilter } from '../../helpers/bookings-page';

test.describe('bookings page name filter', () => {
  test('zone admin: starts empty showing everyone in the zone, then starts-with on type', async ({ page }) => {
    const seats = await getZoneSeats(1);
    const ts = futureDayTs(1);
    // Two future bookings in the shared Zone 1 by two different users.
    await querySql(
      'INSERT INTO book (login, sid, fromts, tots) VALUES ($1,$2,$3,$4), ($5,$6,$3,$4)',
      [USER1.login, seats[0].id, ts + 9 * 3600, ts + 17 * 3600,
       USER2.login, seats[1].id],
    );

    await logIn(page, USER1);
    await page.goto('/bookings');
    await page.waitForLoadState('networkidle');

    const nameInput = page.locator(
      '.tabulator-col[tabulator-field="user_name"] .tabulator-header-filter input',
    );
    const row = (i: number) =>
      page.locator('.tabulator-row', { hasText: seats[i].name });

    // Default: empty box, no user filter → both bookings visible to a zone admin.
    await expect(nameInput).toHaveValue('');
    await expect(row(0)).toBeVisible();
    await expect(row(1)).toBeVisible();

    // Typing "B" is starts-with on the visible name: matches user2
    // ("Bar"), not user1 ("Foo").
    await fillHeaderFilter(page, 'user_name', 'B');
    await expect(row(1)).toBeVisible();
    await expect(row(0)).toHaveCount(0);

    // Clearing restores everyone the zone admin is allowed to see.
    await fillHeaderFilter(page, 'user_name', '');
    await expect(row(0)).toBeVisible();
    await expect(row(1)).toBeVisible();
  });
});
