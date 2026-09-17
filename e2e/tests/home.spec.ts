/**
 * Landing page: the short "how to use WARP" explanation every user lands on,
 * with the Capacity dashboard underneath the intro cards.
 *
 * It used to redirect straight to the user's default plan, which meant regular
 * users never saw the page — the default plan is now a shortcut button on it
 * instead, so the redirect must NOT come back.
 */
import { test, expect } from '../fixtures';
import { logIn } from '../helpers/auth';
import { USER1 } from '../helpers/users';
import { apiSetPrefs } from '../helpers/settings';
import { waitForViewReady } from '../helpers/spa';

test.describe('landing page', () => {

  test('explains how to book and shows the capacity dashboard', async ({ page }) => {
    await logIn(page, USER1);
    await page.goto('/');
    await waitForViewReady(page, 'index');

    await expect(page.locator('.index_steps li')).toHaveCount(4);
    await expect(page.locator('.card-title', { hasText: 'How busy is the office?' })).toBeVisible();
    await expect(page.locator('.warp-capacity-card').first()).toBeVisible();
    await expect(page.locator('#index_capacity_link')).toHaveCount(0);
    await expect(page.getByText('Open the capacity dashboard')).toHaveCount(0);
  });

  test('a default plan becomes a shortcut button instead of a redirect', async ({ page }) => {
    await logIn(page, USER1);
    await apiSetPrefs(page, { default_plan: 1 });

    await page.goto('/');
    await waitForViewReady(page, 'index');

    // Still on the landing page (the pre-existing behaviour navigated away).
    expect(new URL(page.url()).pathname).toBe('/');
    const btn = page.locator('#index_default_plan_btn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveText('Open Plan 1A');

    await btn.click();
    await waitForViewReady(page, 'plan');
    expect(new URL(page.url()).pathname).toBe('/plan/1');
  });

  test('no default plan means no shortcut button', async ({ page }) => {
    await logIn(page, USER1);
    await page.goto('/');
    await waitForViewReady(page, 'index');
    await expect(page.locator('#index_default_plan_btn')).toBeHidden();
  });

});
