import { Locator } from '@playwright/test';
import { test, expect } from '../fixtures';
import { logIn, expectLoggedIn } from '../helpers/auth';
import { waitForViewReady } from '../helpers/spa';
import { ADMIN } from '../helpers/users';

/**
 * The logo is raster artwork in two checked-in variants (colour + white
 * knockout) instead of the old CSS-tinted SVG wordmark, so a wrong path or a
 * missing file degrades to an invisible broken image rather than an obvious
 * failure. These tests prove both variants actually decode, and that the index
 * splash shows the one that can be seen against the current page background.
 */

/** An <img> that is not just present but actually loaded (a 404 gives width 0). */
async function expectRendered(img: Locator): Promise<void> {
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
}

test.describe('branding', () => {

  test('the login page shows the nav logo', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle('Giga Desk Booking');
    await expectRendered(page.locator('nav img.logo'));
  });

  test('the app bar shows the nav logo', async ({ page }) => {
    await logIn(page, ADMIN);
    await expectLoggedIn(page);
    await expectRendered(page.locator('nav img.logo'));
  });

  test('the index splash shows the colour logo on the light theme', async ({ page }) => {
    await logIn(page, ADMIN);
    await expectLoggedIn(page);
    await waitForViewReady(page, 'index');
    await expectRendered(page.locator('#index-logo'));
    await expect(page.locator('#index-logo-dark')).toBeHidden();
  });

});

test.describe('branding on the dark theme', () => {
  test.use({ colorScheme: 'dark' });

  test('the index splash swaps in the white logo', async ({ page }) => {
    await logIn(page, ADMIN);
    await expectLoggedIn(page);
    await waitForViewReady(page, 'index');
    await expectRendered(page.locator('#index-logo-dark'));
    await expect(page.locator('#index-logo')).toBeHidden();
  });

});
