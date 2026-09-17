import csv
import io
import secrets

import flask
from jsonschema import validate, ValidationError
import orjson

from warp.db import *
from warp import utils
from warp.utils_tabulator import *
from warp.auth import loginMatch

# Same charset / length as the Generate button in js/views/users.js.
BULK_PASSWORD_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&*+-:;<=>?@^|"
BULK_PASSWORD_LENGTH = 10
BULK_CSV_HEADER = ('email', 'account_type', 'group')
BULK_ACCOUNT_TYPE_NAMES = {
    'admin': ACCOUNT_TYPE_ADMIN,
    'user': ACCOUNT_TYPE_USER,
    'blocked': ACCOUNT_TYPE_BLOCKED,
}

bp = flask.Blueprint('users', __name__, url_prefix='users')

@bp.route("list", endpoint='list', methods=["POST"])
@utils.validateJSONInput(tabulatorSchema,isAdmin=True)
def listW(report = False):              #list is a built-in type

    requestData = flask.request.get_json()

    query = Users.select(Users.login, Users.name, Users.account_type)

    (query, lastPage) = applyTabulatorToQuery(query,requestData)

    res = {
        "data": [ *query.iterator() ]
    }

    if lastPage is not None:
        res["last_page"] = lastPage

    return flask.current_app.response_class(
        response=orjson.dumps(res),
        status=200,
        mimetype='application/json')

editSchema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "login" : {"type" : "string"},
        "name" : {"type" : "string"},
        "account_type" : {"enum" : [ACCOUNT_TYPE_ADMIN,ACCOUNT_TYPE_USER,ACCOUNT_TYPE_BLOCKED,ACCOUNT_TYPE_GROUP]},
        "password" : {"type" : "string"},
        "action": {"enum": ["add","update"]},
        "groups": {
            "type": "array",
            "items": {
                "type": "string"
            },
        }
    },
    "required": [ "login", "action", "name", "account_type"]
}

# Format:
# { login: login, name: name, account_type: account_type, password: plain_text, action: "add|update" }
@bp.route("edit", methods=["POST"])
@utils.validateJSONInput(editSchema,isAdmin=True)
def edit():

    from werkzeug.security import generate_password_hash

    action_data = flask.request.get_json()

    if action_data['login'] == EVERYONE_KEY:
        return {"msg": "Reserved login", "code": 157}, 400

    class ApplyError(Exception):
        pass

    try:
        with DB.atomic():

            updColumns = {
                Users.name: action_data['name'],
                Users.account_type: action_data['account_type'],
            }

            if len(action_data.get('password','')) > 0 and action_data['account_type'] < ACCOUNT_TYPE_GROUP:
                updColumns[Users.password] = generate_password_hash(action_data['password'])

            if action_data['action'] == "update":

                updateQ = Users.update(updColumns) \
                                .where(Users.login == action_data['login'])

                # prevent conversion from User <=> Group
                if updColumns[ Users.account_type ] < ACCOUNT_TYPE_GROUP:
                    updateQ = updateQ.where( Users.account_type < ACCOUNT_TYPE_GROUP)
                else:
                    updateQ = updateQ.where( Users.account_type >= ACCOUNT_TYPE_GROUP)

                rowCount = updateQ.execute()

                if rowCount != 1:
                    raise ApplyError("Wrong number of affected rows", 153)

            elif action_data['action'] == "add":

                updColumns[Users.login] = action_data['login']
                Users.insert(updColumns).execute()

            if 'groups' in action_data:

                Groups.delete() \
                    .where(Groups.login == action_data['login']) \
                    .execute()

                gr = [{
                        Groups.login: action_data['login'],
                        Groups.group: i
                    } for i in action_data['groups']
                ]

                if len(gr):
                    Groups.insert(gr) \
                        .on_conflict_ignore() \
                        .execute()

    except IntegrityError as err:
        if action_data['action'] == "add":
            return {"msg": "Login exits", "code": 155 }, 400
        else:
            return {"msg": "Error", "code": 156 }, 400
    except ApplyError as err:
        return {"msg": "Error", "code": err.args[1] }, 400

    return {"msg": "ok" }, 200


deleteSchema = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
        "login" : {"type" : "string"},
        "force": {"type": "boolean"}
    },
    "required": [ "login" ]
}

# Format:
# { login: login, force: true|false }
@bp.route("delete", methods=["POST"])
@utils.validateJSONInput(deleteSchema,isAdmin=True)
def delete():

    action_data = flask.request.get_json()

    login = action_data['login']
    force = action_data.get('force', False)

    if not force:
        # A booking is "past" if it started before today in its OWN plan TZ.
        # fromts is wall-clock storage (PLAN per_plan_timezone §B); comparing it
        # to today() in a single default TZ is wrong once a user has bookings on
        # plans in different zones. BookUTC.from_utc is the real instant; today in
        # the booking's plan TZ is its wall-clock midnight as a real instant.
        # Same semantics as the old `fromts < today()` when all plans share a TZ.
        # today_in_tz_sql encapsulates the e2e debug time-offset.
        today_local = utils.today_in_tz_sql(BookUTC.timezone)
        rowCount = BookUTC.select(COUNT_STAR) \
                       .where(BookUTC.login == login) \
                       .where(BookUTC.from_utc < today_local) \
                       .scalar()

        if rowCount:
            return {"msg": "User has past bookings", "bookCount": rowCount, "code": 173}, 406

    try:
        with DB.atomic():

            # rowCount ?
            Users.delete().where(Users.login == login) \
                 .execute()

    except IntegrityError:
        return {"msg": "Error", "code":  174}, 400

    return {"msg": "ok" }, 200


@bp.route("groups/<login>")
def groups(login):

    if not flask.g.isAdmin:
        return {"msg":"Forbidden", "code": 175}, 403

    query = Groups.select(Users.login, Users.name) \
        .join(Users, on=(Groups.group == Users.login)) \
        .where(Groups.login == login)

    res = [ *query.iterator() ]

    return flask.current_app.response_class(
        response=orjson.dumps(res),
        status=200,
        mimetype='application/json')


def derive_login(email):
    """Return (login, reason). login is None and reason is a code on failure."""
    if email is None:
        return None, 'invalid_email'
    text = str(email).strip()
    if '@' not in text:
        return None, 'invalid_email'
    local, _, domain = text.partition('@')
    local = local.strip()
    domain = domain.strip()
    if not local or not domain:
        return None, 'invalid_email'
    return local, None


def parse_account_type(value):
    """Return (account_type int, reason)."""
    if value is None:
        return None, 'invalid_account_type'
    key = str(value).strip().lower()
    if not key or key not in BULK_ACCOUNT_TYPE_NAMES:
        return None, 'invalid_account_type'
    return BULK_ACCOUNT_TYPE_NAMES[key], None


def generate_bulk_password():
    return ''.join(secrets.choice(BULK_PASSWORD_CHARS) for _ in range(BULK_PASSWORD_LENGTH))


def parse_bulk_csv(text):
    """Parse a bulk-import CSV.

    Returns (rows, file_reason). On a file-level error, rows is None and
    file_reason is a code. Otherwise rows is a list of
    {row, email, account_type, group} dicts (raw strings, still to validate).
    """
    reader = csv.reader(io.StringIO(text))
    rows = []
    header_ok = False
    for i, parts in enumerate(reader, start=1):
        if not parts or all(not (c or '').strip() for c in parts):
            continue
        cells = [(c or '').strip() for c in parts]
        if not header_ok:
            got = tuple(c.lower() for c in cells[:3])
            if len(cells) < 3 or got != BULK_CSV_HEADER:
                return None, 'invalid_header'
            header_ok = True
            continue
        if len(cells) < 3:
            rows.append({
                'row': i,
                'email': cells[0] if cells else '',
                'account_type': cells[1] if len(cells) > 1 else '',
                'group': '',
                'too_few_columns': True,
            })
            continue
        rows.append({
            'row': i,
            'email': cells[0],
            'account_type': cells[1],
            'group': cells[2],
            'too_few_columns': False,
        })
    if not header_ok:
        return None, 'invalid_header'
    if not rows:
        return None, 'empty_file'
    return rows, None


def _login_key(login):
    if flask.current_app.config.get('LOGIN_IGNORECASE'):
        return login.lower()
    return login


def _login_exists(login):
    return Users.select(SQL_ONE).where(loginMatch(login)).exists()


def _existing_group_login(group_login):
    rows = list(Users.select(Users.login, Users.account_type).where(loginMatch(group_login)))
    if not rows:
        return None
    row = rows[0]
    if row['account_type'] < ACCOUNT_TYPE_GROUP:
        return None
    return row['login']


def _fail(row, email, reason):
    return {'row': row, 'email': email, 'reason': reason}


@bp.route("bulk", methods=["POST"])
def bulk():
    if not flask.g.isAdmin:
        return {"msg": "Forbidden", "code": 176}, 403

    upload = flask.request.files.get('file')
    if upload is None or not upload.filename:
        return {"msg": "No CSV file was uploaded", "code": 180, "reason": "missing_file"}, 400

    raw = upload.read()
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        return {"msg": "The file is not valid UTF-8 CSV", "code": 180, "reason": "decode_error"}, 400

    parsed, file_reason = parse_bulk_csv(text)
    if file_reason is not None:
        return {"msg": file_reason, "code": 180, "reason": file_reason}, 400

    from werkzeug.security import generate_password_hash

    created = 0
    failed = []
    passwords = []
    seen_logins = set()

    for item in parsed:
        email = item['email']
        row_num = item['row']

        if item['too_few_columns']:
            failed.append(_fail(row_num, email, 'too_few_columns'))
            continue

        login, email_reason = derive_login(email)
        if email_reason:
            failed.append(_fail(row_num, email, email_reason))
            continue

        if login == EVERYONE_KEY:
            failed.append(_fail(row_num, email, 'reserved_login'))
            continue

        account_type, type_reason = parse_account_type(item['account_type'])
        if type_reason:
            failed.append(_fail(row_num, email, type_reason))
            continue

        group = item['group']
        login_key = _login_key(login)
        if login_key in seen_logins or _login_exists(login):
            failed.append(_fail(row_num, email, 'login_exists'))
            continue

        group_login = None
        if group:
            group_login = _existing_group_login(group)
            if group_login is None:
                failed.append(_fail(row_num, email, 'group_not_found'))
                continue

        password = generate_bulk_password()
        try:
            with DB.atomic():
                Users.insert({
                    Users.login: login,
                    Users.name: login,
                    Users.account_type: account_type,
                    Users.password: generate_password_hash(password),
                }).execute()
                if group_login:
                    Groups.insert({
                        Groups.login: login,
                        Groups.group: group_login,
                    }).execute()
        except IntegrityError:
            failed.append(_fail(row_num, email, 'login_exists'))
            continue

        seen_logins.add(login_key)
        created += 1
        passwords.append({'email': email, 'password': password})

    return flask.current_app.response_class(
        response=orjson.dumps({
            'created': created,
            'failed': failed,
            'passwords': passwords,
        }),
        status=200,
        mimetype='application/json')


