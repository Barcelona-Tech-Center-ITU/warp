/**
 * Desktop top-nav: Home takes you to the landing page.
 */
import { test, expect } from '../fixtures';
import { logIn, expectLoggedIn } from '../helpers/auth';
import { USER1 } from '../helpers/users';
import { waitForViewReady } from '../helpers/spa';

test.describe('desktop Home nav', () => {

  test('Home is visible in the top bar', async ({ page }) => {
    await logIn(page, USER1);
    await expectLoggedIn(page);
    await expect(page.locator('#nav-home a', { hasText: 'Home' })).toBeVisible();
  });

  test('clicking Home from Bookings opens the landing page', async ({ page }) => {
    await logIn(page, USER1);
    await expectLoggedIn(page);

    await page.goto('/bookings');
    await waitForViewReady(page, 'bookings');

    await page.locator('#nav-home a', { hasText: 'Home' }).click();
    await waitForViewReady(page, 'index');
    await expect(page.locator('.index_home')).toBeVisible();
    await expect(page.locator('.index_home')).toContainText('Booking a seat');
  });

  test('Home is the active nav item on the landing page', async ({ page }) => {
    await logIn(page, USER1);
    await expectLoggedIn(page);
    await waitForViewReady(page, 'index');

    await expect(page.locator('#nav-home li')).toHaveClass(/active/);

    await page.locator('#nav-left-dynamic a', { hasText: 'Bookings' }).click();
    await waitForViewReady(page, 'bookings');
    await expect(page.locator('#nav-home li')).not.toHaveClass(/active/);
  });

});
