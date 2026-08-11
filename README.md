# Loan Performance Tracker

A lightweight browser-based dashboard for tracking **monthly** loan activity in an organization (issuance, recovery, and defaults). It includes a Flask backend, a Gmail confirmation access gate, and a Power BI–friendly data export.

## Architecture

- **Frontend**: `index.html`, `confirm.html`, `script.js`, `styles.css` (static, served by Flask).
- **Backend**: Python Flask (`app.py`).
- **Database**: 
  - **Firebase Firestore** (cloud) when deployed — durable and shared across devices.
  - **Local SQLite** automatically as a fallback for local development without Firebase credentials.
- **Deployment**: Render (free tier) — runs the Python Flask app.
- **Power BI**: reads data via the web endpoint `/api/export/csv`.

```
Browser ──► Flask (Render) ──► Firebase Firestore
                │
                └── Power BI ◄── https://<your-app>.onrender.com/api/export/csv
```

---

## Run locally

### 1. Install Python

Install Python 3.10+ from https://www.python.org/downloads/.

### 2. Create a virtual environment

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

### 3. Install dependencies

```powershell
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

### 4. Configure Gmail and the authorized account

Copy the example environment file:

```powershell
copy .env.example .env
```

Then open `.env` and set:

- `SMTP_EMAIL` — your Gmail address used for SMTP
- `SMTP_PASSWORD` — your Gmail app password or SMTP password
- `AUTHORIZED_EMAIL` — the only Gmail address authorized to use the app (defaults to `executive.confirmation@gmail.com` if omitted)

> If no SMTP is configured, the app runs in **demo mode** and shows the generated code on-screen so you can still test the flow.

### 5. (Optional) Connect Firebase for cloud storage

The app finds your Firebase service-account key automatically in two places (in order):
1. The `GOOGLE_APPLICATION_CREDENTIALS` environment variable (used on Render).
2. A file named `firebase-service-account.json` in this project folder (already `.gitignore`d).

Place your service-account JSON key as `firebase-service-account.json` in the project root, then start the server:

```powershell
$env:GOOGLE_APPLICATION_CREDENTIALS = "C:\path\to\firebase-service-account.json"
python app.py
```

> **Important:** If Cloud Firestore is **not yet enabled** in your Firebase console, the app automatically falls back to the local SQLite database so it keeps working. The `/api/health` endpoint reports which database is active (`firestore` or `sqlite-fallback`).

### Enable the Cloud Firestore API (required for cloud storage)

Your service-account key may already be valid (the app will authenticate), but Firebase's **Cloud Firestore API** must be enabled in your project. Do this once:

> **About the "auto-id" prompt:** The app creates all collections and documents automatically using Firestore's `.add()` method, which auto-generates document IDs for you. You do **NOT** need to create collections or documents manually.

1. Go to https://console.firebase.google.com and open your project (e.g. `paygaploanperformance`).
2. In the left menu: **Build → Firestore Database**.
3. Click **Create database** — pick a location (e.g. `nam5 (us-central)`), and select **Production mode**.
4. Confirm the database creation. **Stop here** — do not create any collections or documents (this is the "auto-id" step you can ignore/close). The app creates `loan_records` and `verification_codes` automatically.
5. Wait a few minutes for the API to activate, then **restart the app**.

> If you see a `403 Cloud Firestore API has not been used...` error, the API is still propagating after enabling — wait a few minutes and restart. Once enabled, `/api/health` will report `"database": "firestore"`.

### 6. Start the backend server

```powershell
python app.py
```

Open `http://127.0.0.1:5000` in your browser.

---

## Deploy online to Render (keeps Python backend)

Netlify cannot run Python, so to keep the Flask backend, deploy on **Render**.

### 1. Create a Firebase project

1. Go to https://firebase.google.com and create a project (free).
2. In the project, enable **Cloud Firestore** (Build → Firestore Database → Create database).
3. Create two collections (Firestore will auto-create them on first write, but you can create them now):
   - `loan_records` — documents with fields: `month`, `issued`, `recovered`, `defaulted`, `created_at`.
   - `verification_codes` — documents for the Gmail code flow.
4. Generate a service-account key:
   - Project settings → **Service accounts** → **Generate new private key**.
   - Download the JSON file (e.g. `firebase-service-account.json`).

### 2. Push the project to GitHub

- Create a GitHub repo and push this folder.
- **Do NOT commit** the service-account JSON key (it is `.gitignore`d).

### 3. Create the app on Render

1. Go to https://render.com and sign up / log in.
2. Click **New → Web Service** and connect your GitHub repo.
3. Render auto-detects this is a Python app. Use the following settings:
   - **Build**: `pip install -r requirements.txt`
   - **Start**: `gunicorn app:app` (already in the `Procfile`)
4. Under **Environment Variables**, add:
   - `GOOGLE_APPLICATION_CREDENTIALS` — but Render needs an actual file path. Two ways:
     - **Recommended**: Commit a **base64-encoded** version of your key and decode it at startup, OR
     - Use Render **Disk** to store the JSON, OR
     - (Simplest) Paste the service-account JSON contents into a `firebase-service-account.json` file that you place in the repo using an environment var path like `/opt/render/project/src/firebase-service-account.json`.
   
   The simplest reliable setup is to include the JSON file in the repo (it's already `.gitignore`d, so if you want it in the repo you must force-add it) — but be aware that exposes your key to your repo access. For production security, decode it from a Render secret.
5. Add these env vars too:
   - `AUTHORIZED_EMAIL` — the Gmail allowed to access the dashboard
   - `SMTP_EMAIL`, `SMTP_PASSWORD` — for sending real Gmail codes (optional)
   - `FIREBASE_COLLECTION=loan_records`
   - `FIREBASE_VERIFICATIONS_COLLECTION=verification_codes`
6. Click **Create Web Service**. Render will build and deploy, giving you a public URL like:
   ```
   https://<your-app>.onrender.com
   ```

---

## Power BI connection (web endpoint)

Once deployed, point Power BI to the web data endpoint:

1. In **Power BI Desktop**, choose **Get Data → Web**.
2. Enter your deployed CSV endpoint:
   ```
   https://<your-app>.onrender.com/api/export/csv
   ```
3. Load the CSV — it will contain the columns: **Month, Issued, Recovered, Defaulted**.
4. Refresh the dataset whenever you want the latest data from Firestore.

For local testing, you can use the same endpoint locally:
```
http://127.0.0.1:5000/api/export/csv
```

---

## API endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Health check + which database is active |
| GET | `/api/loans` | List all loan records (JSON) |
| POST | `/api/loans` | Add a loan record |
| POST | `/api/confirm/request-gmail` | Request a Gmail verification code |
| POST | `/api/confirm/verify-gmail` | Verify a Gmail code |
| GET | `/api/export/csv` | Export all loan data as CSV (for Power BI) |

---

## Features

- Flask backend with Firebase Firestore (cloud) + SQLite fallback (local)
- Gmail confirmation access gate (60-second code expiry)
- Authorization restricted to one configured Gmail address
- Export loan data as CSV for Power BI or reporting
- Deployable to Render

