# Security defaults: response headers on every route and the session cookie's
# SameSite default (warp/__init__.py, warp/config.py).
#
# Run with:  python -m pytest tests/  (from the repo root)

import warp


def _app(monkeypatch):
    monkeypatch.setenv('FLASK_DEBUG', '1')
    monkeypatch.delenv('WARP_BASE_PATH', raising=False)
    monkeypatch.delenv('WARP_SESSION_COOKIE_SAMESITE', raising=False)
    return warp.create_app()


def test_security_headers_on_public_and_gated_routes(monkeypatch):
    c = _app(monkeypatch).test_client()
    for path in ('/sw.js', '/'):   # public route, and the session-gate redirect
        r = c.get(path)
        assert r.headers['X-Frame-Options'] == 'DENY', path
        assert r.headers['X-Content-Type-Options'] == 'nosniff', path
        assert r.headers['Referrer-Policy'] == 'same-origin', path


def test_session_cookie_samesite_defaults_to_lax(monkeypatch):
    assert _app(monkeypatch).config['SESSION_COOKIE_SAMESITE'] == 'Lax'


def test_session_cookie_samesite_env_override(monkeypatch):
    monkeypatch.setenv('WARP_SESSION_COOKIE_SAMESITE', 'None')
    monkeypatch.setenv('FLASK_DEBUG', '1')
    assert warp.create_app().config['SESSION_COOKIE_SAMESITE'] == 'None'
