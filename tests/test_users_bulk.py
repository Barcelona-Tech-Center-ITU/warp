# Tests for bulk user CSV import (warp/xhr/users.py).
#
# Parser/mapping helpers are pure. Endpoint tests use the live dev DB the same
# way tests/test_prefs_language.py does (DevelopmentSettings).
# Run with:  python -m pytest tests/test_users_bulk.py

from io import BytesIO

import pytest

from warp.db import ACCOUNT_TYPE_ADMIN, ACCOUNT_TYPE_USER, ACCOUNT_TYPE_BLOCKED
from warp.xhr.users import (
    BULK_PASSWORD_CHARS,
    BULK_PASSWORD_LENGTH,
    derive_login,
    generate_bulk_password,
    parse_account_type,
    parse_bulk_csv,
)


def test_derive_login_from_email():
    assert derive_login('this.name@domain.com') == ('this.name', None)
    assert derive_login('  this.name@domain.com  ') == ('this.name', None)


def test_derive_login_rejects_invalid():
    assert derive_login('')[1] == 'invalid_email'
    assert derive_login('no-at-sign')[1] == 'invalid_email'
    assert derive_login('@domain.com')[1] == 'invalid_email'
    assert derive_login('local@')[1] == 'invalid_email'
    assert derive_login(None)[1] == 'invalid_email'


def test_parse_account_type_names():
    assert parse_account_type('Admin') == (ACCOUNT_TYPE_ADMIN, None)
    assert parse_account_type('user') == (ACCOUNT_TYPE_USER, None)
    assert parse_account_type(' BLOCKED ') == (ACCOUNT_TYPE_BLOCKED, None)
    assert parse_account_type('Group')[1] == 'invalid_account_type'
    assert parse_account_type('20')[1] == 'invalid_account_type'
    assert parse_account_type('')[1] == 'invalid_account_type'


def test_parse_bulk_csv_happy_path():
    text = (
        'email,account_type,group\n'
        'a@example.com,User,group_1a\n'
        'b@example.com,Admin,\n'
    )
    rows, err = parse_bulk_csv(text)
    assert err is None
    assert len(rows) == 2
    assert rows[0]['row'] == 2
    assert rows[0]['email'] == 'a@example.com'
    assert rows[0]['account_type'] == 'User'
    assert rows[0]['group'] == 'group_1a'
    assert rows[1]['group'] == ''


def test_parse_bulk_csv_header_case_and_spaces():
    text = ' Email , Account_Type , Group \nthis.name@x.com,User,\n'
    rows, err = parse_bulk_csv(text)
    assert err is None
    assert rows[0]['email'] == 'this.name@x.com'


def test_parse_bulk_csv_skips_empty_lines():
    text = 'email,account_type,group\n\nthis.name@x.com,User,\n\n'
    rows, err = parse_bulk_csv(text)
    assert err is None
    assert len(rows) == 1


def test_parse_bulk_csv_invalid_header():
    rows, err = parse_bulk_csv('login,name,password\na,b,c\n')
    assert rows is None
    assert err == 'invalid_header'


def test_parse_bulk_csv_empty_file():
    rows, err = parse_bulk_csv('email,account_type,group\n')
    assert rows is None
    assert err == 'empty_file'


def test_parse_bulk_csv_too_few_columns():
    text = 'email,account_type,group\nonly-email\n'
    rows, err = parse_bulk_csv(text)
    assert err is None
    assert rows[0]['too_few_columns'] is True
    assert rows[0]['row'] == 2


def test_generate_bulk_password_shape():
    pw = generate_bulk_password()
    assert len(pw) == BULK_PASSWORD_LENGTH
    assert all(c in BULK_PASSWORD_CHARS for c in pw)


@pytest.fixture
def app(monkeypatch):
    monkeypatch.setenv('FLASK_DEBUG', '1')
    import warp
    return warp.create_app()


def _login_admin(client):
    assert client.post('/login', data={'login': 'admin', 'password': 'noneshallpass'}).status_code == 302


def _login_user(client):
    assert client.post('/login', data={'login': 'user1', 'password': 'password'}).status_code == 302


def _post_csv(client, text, filename='users.csv'):
    return client.post(
        '/xhr/users/bulk',
        data={'file': (BytesIO(text.encode('utf-8')), filename)},
    )


def test_bulk_forbidden_for_non_admin(app):
    with app.test_client() as c:
        _login_user(c)
        r = _post_csv(c, 'email,account_type,group\na@b.com,User,\n')
        assert r.status_code == 403
        assert r.get_json()['code'] == 176


def test_bulk_missing_file(app):
    with app.test_client() as c:
        _login_admin(c)
        r = c.post('/xhr/users/bulk')
        assert r.status_code == 400
        assert r.get_json()['reason'] == 'missing_file'


def test_bulk_invalid_header(app):
    with app.test_client() as c:
        _login_admin(c)
        r = _post_csv(c, 'foo,bar,baz\n1,2,3\n')
        assert r.status_code == 400
        assert r.get_json()['reason'] == 'invalid_header'


def test_bulk_creates_and_continues_on_row_errors(app):
    csv_text = '\n'.join([
        'email,account_type,group',
        'bulk.ok@example.com,User,group_1a',
        'not-an-email,User,',
        'user1@example.com,User,',
        'bulk.nogroup@example.com,User,no_such_group',
        'bulk.ok2@example.com,Admin,',
        'bulk.ok@other.com,User,',
        'bulk.blocked@example.com,Blocked,',
    ]) + '\n'
    with app.test_client() as c:
        _login_admin(c)
        r = _post_csv(c, csv_text)
        assert r.status_code == 200
        body = r.get_json()
        assert body['created'] == 3
        assert len(body['passwords']) == 3
        emails = {p['email'] for p in body['passwords']}
        assert emails == {
            'bulk.ok@example.com',
            'bulk.ok2@example.com',
            'bulk.blocked@example.com',
        }
        for p in body['passwords']:
            assert len(p['password']) == BULK_PASSWORD_LENGTH

        reasons = {(f['email'], f['reason']) for f in body['failed']}
        assert ('not-an-email', 'invalid_email') in reasons
        assert ('user1@example.com', 'login_exists') in reasons
        assert ('bulk.nogroup@example.com', 'group_not_found') in reasons
        assert ('bulk.ok@other.com', 'login_exists') in reasons

        import warp.db as dbmod
        dbmod.DB.connect(reuse_if_open=True)
        try:
            ok = dbmod.DB.execute_sql(
                "SELECT login, name, account_type FROM users WHERE login = %s",
                ('bulk.ok',),
            ).fetchone()
            assert ok[0] == 'bulk.ok'
            assert ok[1] == 'bulk.ok'
            assert int(ok[2]) == ACCOUNT_TYPE_USER
            member = dbmod.DB.execute_sql(
                'SELECT COUNT(*) FROM groups WHERE login = %s AND "group" = %s',
                ('bulk.ok', 'group_1a'),
            ).fetchone()
            assert member[0] == 1
            no_user = dbmod.DB.execute_sql(
                "SELECT COUNT(*) FROM users WHERE login = %s",
                ('bulk.nogroup',),
            ).fetchone()
            assert no_user[0] == 0
        finally:
            dbmod.DB.close()
