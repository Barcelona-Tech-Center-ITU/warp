/**
 * Site-admin bulk user import from CSV on the Users page.
 */
import fs from 'fs';
import { test, expect } from '../../fixtures';
import { logIn, logOut } from '../../helpers/auth';
import { ADMIN, USER1 } from '../../helpers/users';
import { querySql } from '../../helpers/db';
import { waitForViewReady } from '../../helpers/spa';

const BULK_CSV = [
  'email,account_type,group',
  'bulk.ok@example.com,User,group_1a',
  'not-an-email,User,',
  'user1@example.com,User,',
  'bulk.nogroup@example.com,User,no_such_group',
  'bulk.ok2@example.com,Admin,',
].join('\n');

test.describe('bulk user import', () => {

  test('non-admin cannot POST the bulk endpoint', async ({ page }) => {
    await logIn(page, USER1);
    const resp = await page.request.post('/xhr/users/bulk', {
      multipart: {
        file: {
          name: 'users.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from('email,account_type,group\na@b.com,User,\n'),
        },
      },
    });
    expect(resp.status()).toBe(403);
  });

  test('admin imports CSV, sees row failures, and can log in with a generated password', async ({ page }) => {
    await logIn(page, ADMIN);
    await page.goto('/users');
    await waitForViewReady(page, 'users');

    const downloadPromise = page.waitForEvent('download');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Import users from CSV' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'users.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(BULK_CSV),
    });
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('warp-user-passwords.csv');

    const tmp = await download.path();
    expect(tmp).toBeTruthy();
    const passwordsCsv = fs.readFileSync(tmp as string, 'utf8');
    const lines = passwordsCsv.trim().split(/\r?\n/);
    expect(lines[0]).toBe('email,password');
    const byEmail = Object.fromEntries(
      lines.slice(1).map((line) => {
        const idx = line.indexOf(',');
        return [line.slice(0, idx), line.slice(idx + 1)];
      }),
    );
    expect(Object.keys(byEmail).sort()).toEqual([
      'bulk.ok2@example.com',
      'bulk.ok@example.com',
    ]);

    const dialog = page.locator('dialog.warp-modal-sm');
    await expect(dialog).toHaveClass(/open/);
    await expect(dialog.getByText('Created 2 users')).toBeVisible();
    await expect(dialog.getByText('Failed 3 rows')).toBeVisible();
    await expect(dialog.getByText('Invalid email')).toBeVisible();
    await expect(dialog.getByText('Login already exists')).toBeVisible();
    await expect(dialog.getByText('Group does not exist')).toBeVisible();
    await dialog.getByRole('button', { name: 'Ok' }).click();

    await expect(page.getByRole('row', { name: 'edit bulk.ok bulk.ok User' })).toBeVisible();
    await expect(page.getByRole('row', { name: 'edit bulk.ok2 bulk.ok2 Admin' })).toBeVisible();

    const membership = await querySql(
      'SELECT COUNT(*)::int AS cnt FROM groups WHERE login = $1 AND "group" = $2',
      ['bulk.ok', 'group_1a'],
    );
    expect(membership.rows[0].cnt).toBe(1);

    const skipped = await querySql(
      'SELECT COUNT(*)::int AS cnt FROM users WHERE login = $1',
      ['bulk.nogroup'],
    );
    expect(skipped.rows[0].cnt).toBe(0);

    await logOut(page);
    await logIn(page, {
      login: 'bulk.ok',
      password: byEmail['bulk.ok@example.com'],
      name: 'bulk.ok',
    });
    await expect(page.locator('#mobile-nav')).toBeAttached();
  });

});
