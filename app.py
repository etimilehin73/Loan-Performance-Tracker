import csv
import io
import os
import smtplib
import time
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR

load_dotenv(BASE_DIR / '.env')

app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path='')
CORS(app, resources={r"/api/*": {"origins": "*"}}, send_wildcard=True)

ACCESS_TIMEOUT_SECONDS = 60

DEFAULT_RECORDS = [
    {'month': 'Jan 2026', 'issued': 120000, 'recovered': 14000, 'defaulted': 2500},
    {'month': 'Feb 2026', 'issued': 126000, 'recovered': 15000, 'defaulted': 3200},
    {'month': 'Mar 2026', 'issued': 131000, 'recovered': 16000, 'defaulted': 2900},
    {'month': 'Apr 2026', 'issued': 136000, 'recovered': 16500, 'defaulted': 3600},
    {'month': 'May 2026', 'issued': 141000, 'recovered': 17500, 'defaulted': 4000},
]

SMTP_EMAIL = os.getenv('SMTP_EMAIL')
SMTP_PASSWORD = os.getenv('SMTP_PASSWORD')
DEFAULT_AUTHORIZED_EMAIL = 'executive.confirmation@gmail.com'
AUTHORIZED_EMAILS = tuple(dict.fromkeys([
    email.strip().lower()
    for email in [
        os.getenv('AUTHORIZED_EMAIL', ''),
        DEFAULT_AUTHORIZED_EMAIL,
    ]
    if email and email.strip()
]))

FIREBASE_COLLECTION = os.getenv('FIREBASE_COLLECTION', 'loan_records')
FIREBASE_VERIFICATIONS_COLLECTION = os.getenv('FIREBASE_VERIFICATIONS_COLLECTION', 'verification_codes')

# ---------------------------------------------------------------------------
# Firebase Firestore integration (cloud database)
# ---------------------------------------------------------------------------
firestore_db = None
_firebase_error = None

def _locate_service_account_key():
    """Return the path to the Firebase service-account JSON key.

    Priority:
      1. GOOGLE_APPLICATION_CREDENTIALS environment variable (used on Render).
      2. A file named firebase-service-account.json in this project directory.
    """
    env_path = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
    if env_path and Path(env_path).exists():
        return env_path

    local_path = BASE_DIR / 'firebase-service-account.json'
    if local_path.exists():
        return str(local_path)

    return None


try:
    from firebase_admin import credentials, firestore, initialize_app
    cred_path = _locate_service_account_key()
    if cred_path:
        cred = credentials.Certificate(cred_path)
        initialize_app(cred)
        firestore_db = firestore.client()
    else:
        _firebase_error = 'GOOGLE_APPLICATION_CREDENTIALS not set and no firebase-service-account.json found.'
except Exception as exc:  # pragma: no cover
    _firebase_error = 'Firebase initialization failed: %s' % exc


def is_authorized_email(email: str) -> bool:
    return normalize_email(email) in AUTHORIZED_EMAILS


def generate_code():
    return str(100000 + int(os.urandom(2).hex(), 16) % 900000)


def normalize_email(email: str) -> str:
    return (email or '').strip().lower()


def normalize_verification_target(channel: str, target: str) -> str:
    return normalize_email(target)


def send_gmail_message(email_address: str, code: str) -> tuple[bool, str]:
    if not (SMTP_EMAIL and SMTP_PASSWORD):
        return False, 'SMTP configuration is missing. Ensure SMTP_EMAIL and SMTP_PASSWORD are set.'

    try:
        message = EmailMessage()
        message['Subject'] = 'Loan Performance Tracker access code'
        message['From'] = SMTP_EMAIL
        message['To'] = email_address
        message.set_content(f'Your Loan Performance Tracker Gmail code is: {code}')

        with smtplib.SMTP('smtp.gmail.com', 587, timeout=20) as smtp:
            smtp.ehlo()
            smtp.starttls()
            smtp.login(SMTP_EMAIL, SMTP_PASSWORD)
            smtp.send_message(message)

        return True, ''
    except Exception as exc:
        return False, str(exc)


# ---------------------------------------------------------------------------
# Persistence layer (Firestore with SQLite fallback for local dev)
# ---------------------------------------------------------------------------
# Set if a runtime Firestore call fails (e.g. API disabled). The app then
# transparently falls back to SQLite for the remainder of the session.
_firebase_runtime_error = None


def _use_firestore() -> bool:
    # Only consider Firestore active if initialization succeeded AND no
    # runtime failure has switched us to the SQLite fallback yet.
    return firestore_db is not None and not _firebase_runtime_error


def _sqlite_connection():
    import sqlite3
    DB_PATH = BASE_DIR / 'loan_tracker.db'
    conn = sqlite3.connect(DB_PATH, detect_types=sqlite3.PARSE_DECLTYPES)
    conn.row_factory = sqlite3.Row
    return conn


def _initialize_sqlite():
    import sqlite3
    DB_PATH = BASE_DIR / 'loan_tracker.db'
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _sqlite_connection() as conn:
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS loan_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month TEXT NOT NULL,
                issued REAL NOT NULL,
                recovered REAL NOT NULL,
                defaulted REAL NOT NULL,
                created_at TEXT NOT NULL
            )
            '''
        )
        conn.execute(
            '''
            CREATE TABLE IF NOT EXISTS verification_codes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel TEXT NOT NULL,
                target TEXT NOT NULL,
                code TEXT NOT NULL,
                expires_at INTEGER NOT NULL,
                verified INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )
            '''
        )
        conn.commit()

        existing = conn.execute('SELECT COUNT(1) AS count FROM loan_records').fetchone()['count']
        if existing == 0:
            for record in DEFAULT_RECORDS:
                conn.execute(
                    'INSERT INTO loan_records (month, issued, recovered, defaulted, created_at) VALUES (?, ?, ?, ?, ?)',
                    (record['month'], record['issued'], record['recovered'], record['defaulted'], datetime.utcnow().isoformat()),
                )
            conn.commit()


def _disable_firestore(error):
    """Record a Firestore failure and switch to the SQLite fallback."""
    global _firebase_runtime_error
    _firebase_runtime_error = str(error)


def fetch_loan_records() -> list:
    if _use_firestore():
        try:
            docs = firestore_db.collection(FIREBASE_COLLECTION).order_by('created_at').stream()
            return [doc.to_dict() for doc in docs]
        except Exception as exc:  # pragma: no cover
            _disable_firestore(exc)

    with _sqlite_connection() as conn:
        rows = conn.execute('SELECT month, issued, recovered, defaulted FROM loan_records ORDER BY id ASC').fetchall()
        return [dict(row) for row in rows]


def save_loan_record(record: dict):
    if _use_firestore():
        try:
            doc = dict(record)
            doc['created_at'] = datetime.utcnow().isoformat()
            firestore_db.collection(FIREBASE_COLLECTION).add(doc)
            return
        except Exception as exc:  # pragma: no cover
            _disable_firestore(exc)

    with _sqlite_connection() as conn:
        conn.execute(
            'INSERT INTO loan_records (month, issued, recovered, defaulted, created_at) VALUES (?, ?, ?, ?, ?)',
            (record['month'], record['issued'], record['recovered'], record['defaulted'], datetime.utcnow().isoformat()),
        )
        conn.commit()


def store_verification(channel: str, target: str, code: str) -> int:
    expires_at = int(time.time()) + ACCESS_TIMEOUT_SECONDS
    entry = {
        'channel': channel,
        'target': normalize_verification_target(channel, target),
        'code': code,
        'expires_at': expires_at,
        'verified': False,
        'created_at': int(time.time()),
    }
    if _use_firestore():
        try:
            firestore_db.collection(FIREBASE_VERIFICATIONS_COLLECTION).add(entry)
            return expires_at
        except Exception as exc:  # pragma: no cover
            _disable_firestore(exc)

    with _sqlite_connection() as conn:
        conn.execute(
            'INSERT INTO verification_codes (channel, target, code, expires_at, verified, created_at) VALUES (?, ?, ?, ?, 0, ?)',
            (entry['channel'], entry['target'], entry['code'], entry['expires_at'], entry['created_at']),
        )
        conn.commit()
    return expires_at


def verify_code(channel: str, target: str, code: str):
    normalized_target = normalize_verification_target(channel, target)
    now = int(time.time())

    if _use_firestore():
        try:
            docs = (
                firestore_db.collection(FIREBASE_VERIFICATIONS_COLLECTION)
                .where('channel', '==', channel)
                .where('target', '==', normalized_target)
                .where('code', '==', code)
                .order_by('created_at', direction='DESCENDING')
                .limit(1)
                .stream()
            )
            doc = next(iter(list(docs)), None)
            if not doc:
                return False, 'invalid or expired'
            data = doc.to_dict()
            if data.get('verified'):
                return False, 'code has already been used'
            if data['expires_at'] < now:
                return False, 'code has expired'
            firestore_db.collection(FIREBASE_VERIFICATIONS_COLLECTION).document(doc.id).update({'verified': True})
            return True, ''
        except Exception as exc:  # pragma: no cover
            _disable_firestore(exc)

    with _sqlite_connection() as conn:
        row = conn.execute(
            'SELECT id, expires_at, verified FROM verification_codes WHERE channel = ? AND target = ? AND code = ? ORDER BY id DESC LIMIT 1',
            (channel, normalized_target, code),
        ).fetchone()
        if not row:
            return False, 'invalid or expired'
        if row['verified']:
            return False, 'code has already been used'
        if row['expires_at'] < now:
            return False, 'code has expired'
        conn.execute('UPDATE verification_codes SET verified = 1 WHERE id = ?', (row['id'],))
        conn.commit()
        return True, ''


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route('/')
def index():
    return send_from_directory(STATIC_DIR, 'index.html')


@app.route('/<path:path>')
def static_file(path):
    return send_from_directory(STATIC_DIR, path)


@app.route('/api/health')
def health():
    return jsonify({
        'status': 'ok',
        'version': '1.1',
        'database': 'firestore' if _use_firestore() else ('sqlite-fallback' if _firebase_error is None else 'sqlite'),
        'firebase_error': _firebase_error,
    })


@app.route('/api/confirm/request-gmail', methods=['POST'])
def request_gmail():
    payload = request.get_json(force=True)
    email_address = (payload.get('email') or '').strip()
    if not email_address:
        return jsonify({'error': 'Email address is required.'}), 400
    if not is_authorized_email(email_address):
        return jsonify({'error': 'Email address is not authorized for this application.'}), 403
    code = generate_code()
    expires_at = store_verification('gmail', email_address, code)
    sent, error = send_gmail_message(email_address, code)
    if not sent:
        if 'SMTP configuration is missing' in (error or ''):
            return jsonify({
                'success': True,
                'message': 'Gmail code generated in demo mode. Use the displayed code to continue.',
                'expires_in': expires_at - int(time.time()),
                'debug_code': code,
            })

        return jsonify({
            'error': 'Gmail provider is not configured or failed to send. Configure SMTP settings to send the code to the email address.',
            'details': error,
        }), 500

    return jsonify({
        'success': True,
        'message': 'Gmail code request processed.',
        'expires_in': expires_at - int(time.time()),
    })


@app.route('/api/confirm/verify-gmail', methods=['POST'])
def verify_gmail():
    payload = request.get_json(force=True)
    email_address = (payload.get('email') or '').strip()
    code = (payload.get('code') or '').strip()
    if not email_address or not code:
        return jsonify({'error': 'Email address and code are required.'}), 400
    if not is_authorized_email(email_address):
        return jsonify({'error': 'Email address is not authorized for this application.'}), 403

    verified, reason = verify_code('gmail', email_address, code)
    if verified:
        return jsonify({'success': True, 'message': 'Gmail confirmation verified.'})

    return jsonify({'error': f'Gmail verification failed: {reason}.'}), 400


@app.route('/api/loans', methods=['GET', 'POST'])
def loans():
    if request.method == 'GET':
        return jsonify(fetch_loan_records())

    payload = request.get_json(force=True)
    month = (payload.get('month') or '').strip()
    issued = payload.get('issued')
    recovered = payload.get('recovered')
    defaulted = payload.get('defaulted')

    if not month or issued is None or recovered is None or defaulted is None:
        return jsonify({'error': 'Month, issued, recovered, and defaulted values are required.'}), 400

    try:
        issued = float(issued)
        recovered = float(recovered)
        defaulted = float(defaulted)
    except (ValueError, TypeError):
        return jsonify({'error': 'Issued, recovered, and defaulted must be numeric.'}), 400

    record = {'month': month, 'issued': issued, 'recovered': recovered, 'defaulted': defaulted}
    save_loan_record(record)
    return jsonify(fetch_loan_records())


@app.route('/api/export/csv', methods=['GET'])
def export_csv():
    rows = fetch_loan_records()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['Month', 'Issued', 'Recovered', 'Defaulted'])
    for row in rows:
        writer.writerow([row['month'], row['issued'], row['recovered'], row['defaulted']])
    response = app.response_class(
        response=output.getvalue(),
        status=200,
        mimetype='text/csv',
    )
    response.headers['Content-Disposition'] = 'attachment; filename=loan_records.csv'
    return response


if __name__ == '__main__':
    if not _use_firestore():
        _initialize_sqlite()
    app.run(host='0.0.0.0', port=int(os.getenv('PORT', '5000')), debug=True)
