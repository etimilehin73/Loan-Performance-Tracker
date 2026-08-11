# Task: Fix email input clearing on "Request Gmail code"

## Steps
- [x] Create TODO.md with plan steps
- [x] Edit script.js: stop navigating away on "Request Gmail code" click
- [x] Edit script.js: store email in localStorage and pre-fill debug code
- [x] Edit script.js: only redirect to index.html when on confirm page after verify
- [x] Edit script.js: restore email from localStorage/sessionStorage/URL on init
- [x] Edit confirm.html: add id to "Return to dashboard" link
- [x] Add graceful Firestore runtime fallback to app.py (SQLite fallback works)
- [x] Update README with Firestore enable instructions + "auto-id" explanation

## Firestore migration / server restart
- [x] Stopped ALL stale app.py processes (debug reloader had spawned duplicates on port 5000)
- [x] Started a completely fresh server process
- [x] Confirmed fresh import: Firestore initializes (use_firestore=True, db active, no errors)
- [x] Confirmed running server `/api/health` reports `database=firestore`
- [x] Verified Firestore read: `/api/loans` reads from Firestore
- [x] Verified Firestore write path end-to-end via POST /api/loans (write + read-back)

