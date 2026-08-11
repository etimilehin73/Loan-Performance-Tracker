const RATE = 0.04;
const STORAGE_KEY = 'loan-performance-tracker-records-monthly';
const LOCAL_BACKEND_ROOT = 'http://127.0.0.1:5000';
const API_ROOT = (() => {
  // When opened directly from a local file (file://), use the local Flask backend.
  if (window.location.protocol === 'file:') {
    return LOCAL_BACKEND_ROOT;
  }

  const hostname = window.location.hostname;
  const port = window.location.port;

  // When served from a local dev server (e.g. Flask on a non-5000 port),
  // fall back to the local Flask backend on 127.0.0.1:5000.
  if ((hostname === '127.0.0.1' || hostname === 'localhost') && port && port !== '5000') {
    return LOCAL_BACKEND_ROOT;
  }

  // When served from the same origin (e.g. Render's https://<app>.onrender.com),
  // use relative paths so the frontend talks to the same Flask app.
  // This is also the case when the file is served by Flask itself on port 5000.
  return '';
})();

const ACCESS_TIMEOUT_SECONDS = 60;
const defaultRecords = [
  { month: 'Jan 2026', issued: 120000, recovered: 14000, defaulted: 2500 },
  { month: 'Feb 2026', issued: 126000, recovered: 15000, defaulted: 3200 },
  { month: 'Mar 2026', issued: 131000, recovered: 16000, defaulted: 2900 },
  { month: 'Apr 2026', issued: 136000, recovered: 16500, defaulted: 3600 },
  { month: 'May 2026', issued: 141000, recovered: 17500, defaulted: 4000 }
];

let records = [];

const totalIssuedEl = document.getElementById('totalIssued');
const totalRecoveredEl = document.getElementById('totalRecovered');
const totalDefaultedEl = document.getElementById('totalDefaulted');
const netPortfolioEl = document.getElementById('netPortfolio');
const recoveryRateEl = document.getElementById('recoveryRate');
const cashInflowEl = document.getElementById('cashInflow');
const defaultExposureEl = document.getElementById('defaultExposure');
const portfolioNoteEl = document.getElementById('portfolioNote');
const recordsBody = document.getElementById('recordsBody');
const loanForm = document.getElementById('loanForm');
const chartCanvas = document.getElementById('monthlyChart');

const accessGate = document.getElementById('accessGate');
const gmailAddress = document.getElementById('gmailAddress');
const gmailCodeInput = document.getElementById('gmailCodeInput');
const gmailMessage = document.getElementById('gmailMessage');
const gmailCountdown = document.getElementById('gmailCountdown');
const requestGmailBtn = document.getElementById('requestGmailBtn');
const verifyGmailBtn = document.getElementById('verifyGmailBtn');
const rememberEmailCheckbox = document.getElementById('rememberEmail');
const clearEmailBtn = document.getElementById('clearEmailBtn');

const REMEMBERED_EMAIL_KEY = 'rememberedGmailEmail';
const SESSION_TOKEN_KEY = 'dashboardSessionToken';

const accessSummary = document.getElementById('accessSummary');
const appShell = document.querySelector('.app-shell');
const isDashboardView = Boolean(totalIssuedEl && totalRecoveredEl && totalDefaultedEl && netPortfolioEl && recoveryRateEl && cashInflowEl && defaultExposureEl && portfolioNoteEl && recordsBody && loanForm && chartCanvas);

let gmailTimer = null;
let gmailExpiresAt = null;
let gmailValidated = false;

function sessionToken() {
  return sessionStorage.getItem(SESSION_TOKEN_KEY) || '';
}

function authHeaders(extra = {}) {
  const token = sessionToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem('gmailValidated');
  gmailValidated = false;
}

function rememberedEmail() {
  return localStorage.getItem(REMEMBERED_EMAIL_KEY) || '';
}

function persistEmailPreference(email) {
  if (rememberEmailCheckbox && rememberEmailCheckbox.checked && email) {
    localStorage.setItem(REMEMBERED_EMAIL_KEY, email);
  } else {
    localStorage.removeItem(REMEMBERED_EMAIL_KEY);
  }
}

function forgetEmail() {
  localStorage.removeItem(REMEMBERED_EMAIL_KEY);

  if (rememberEmailCheckbox) {
    rememberEmailCheckbox.checked = false;
  }

  if (gmailAddress) {
    gmailAddress.value = '';
    gmailAddress.focus();
  }

  if (gmailCodeInput) {
    gmailCodeInput.value = '';
  }

  clearGmailFlow();
}

function loadLocalRecords() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : defaultRecords;
  } catch (error) {
    return defaultRecords;
  }
}

function saveLocalRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

async function apiFetch(path, options = {}) {
  const requestUrl = `${API_ROOT}${path}`;

  try {
    return await fetch(requestUrl, options);
  } catch (error) {
    const isLocalRequest = window.location.protocol === 'file:'
      || window.location.hostname === '127.0.0.1'
      || window.location.hostname === 'localhost';

    if (isLocalRequest) {
      const localUrl = `${LOCAL_BACKEND_ROOT}${path}`;
      if (localUrl !== requestUrl) {
        return await fetch(localUrl, options);
      }
    }

    throw error;
  }
}

async function fetchLoanRecords() {
  try {
    const response = await apiFetch('/api/loans', {
      method: 'GET',
      headers: authHeaders({ 'Accept': 'application/json' })
    });

    if (response.status === 401) {
      clearSession();
      validateAccessUnlock();
      records = [];
      return;
    }

    if (!response.ok) {
      throw new Error('Failed to load loan records from backend');
    }

    const data = await response.json();
    if (Array.isArray(data) && data.length > 0) {
      records = data;
      saveLocalRecords();
      return;
    }
  } catch (error) {
    records = loadLocalRecords();
  }
}

async function postLoanRecord(record) {
  try {
    const response = await apiFetch('/api/loans', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(record)
    });

    if (response.status === 401) {
      clearSession();
      validateAccessUnlock();
      return records;
    }

    if (!response.ok) {
      throw new Error('Loan save failed');
    }

    const data = await response.json();
    if (Array.isArray(data)) {
      records = data;
      saveLocalRecords();
      return records;
    }
  } catch (error) {
    records.push(record);
    saveLocalRecords();
    return records;
  }
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(value);
}

function computeSummary() {
  const totalIssued = records.reduce((sum, row) => sum + Number(row.issued || 0), 0);
  const totalRecovered = records.reduce((sum, row) => sum + Number(row.recovered || 0), 0);
  const totalDefaulted = records.reduce((sum, row) => sum + Number(row.defaulted || 0), 0);
  const netPortfolio = totalRecovered - totalDefaulted;
  const recoveryRate = totalIssued === 0 ? 0 : (totalRecovered / totalIssued) * 100;
  const defaultExposure = totalIssued === 0 ? 0 : (totalDefaulted / totalIssued) * 100;

  totalIssuedEl.textContent = formatMoney(totalIssued);
  totalRecoveredEl.textContent = formatMoney(totalRecovered);
  totalDefaultedEl.textContent = formatMoney(totalDefaulted);
  netPortfolioEl.textContent = formatMoney(netPortfolio);
  recoveryRateEl.textContent = `${recoveryRate.toFixed(2)}%`;
  cashInflowEl.textContent = formatMoney(totalRecovered);
  defaultExposureEl.textContent = `${defaultExposure.toFixed(2)}%`;

  portfolioNoteEl.textContent = netPortfolio >= 0
    ? 'The portfolio is delivering steady monthly cash inflow, with repayments outpacing missed collections.'
    : 'Defaults are beginning to outweigh recovered collections, which weakens expected month-end inflow.';
}

function renderRecords() {
  recordsBody.innerHTML = '';

  records.forEach((row) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${row.month}</td>
      <td>${formatMoney(Number(row.issued || 0))}</td>
      <td>${formatMoney(Number(row.recovered || 0))}</td>
      <td>${formatMoney(Number(row.defaulted || 0))}</td>
    `;
    recordsBody.appendChild(tr);
  });

  drawChart();
}

function drawChart() {
  if (!chartCanvas) {
    return;
  }

  const context = chartCanvas.getContext('2d');
  const width = 900;
  const height = 320;
  const padding = { top: 20, right: 24, bottom: 48, left: 56 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(
    ...records.flatMap((row) => [Number(row.issued || 0), Number(row.recovered || 0), Number(row.defaulted || 0)]),
    1
  ) * 1.15;

  chartCanvas.width = width;
  chartCanvas.height = height;

  context.clearRect(0, 0, width, height);
  context.strokeStyle = 'rgba(255,255,255,0.08)';
  context.fillStyle = '#9bb0d4';
  context.font = '12px Segoe UI';

  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (chartHeight / 4) * i;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();

    const labelValue = Math.round((maxValue - (maxValue / 4) * i) / 1000) * 1000;
    context.fillText(formatMoney(labelValue), 8, y + 4);
  }

  const groupWidth = chartWidth / records.length;
  const barWidth = Math.min(18, groupWidth / 5);

  records.forEach((row, index) => {
    const monthStart = padding.left + groupWidth * index + groupWidth / 2 - barWidth * 1.5;
    const issued = Number(row.issued || 0);
    const recovered = Number(row.recovered || 0);
    const defaulted = Number(row.defaulted || 0);

    renderBar(context, monthStart, issued, 'rgba(91, 180, 255, 0.88)', maxValue, chartHeight, padding, barWidth);
    renderBar(context, monthStart + barWidth + 4, recovered, 'rgba(87, 217, 123, 0.88)', maxValue, chartHeight, padding, barWidth);
    renderBar(context, monthStart + (barWidth + 4) * 2, defaulted, 'rgba(255, 111, 159, 0.88)', maxValue, chartHeight, padding, barWidth);

    context.fillStyle = '#9bb0d4';
    context.fillText(row.month, monthStart - 6, height - 18);
  });
}

function renderBar(context, x, value, color, maxValue, chartHeight, padding, barWidth) {
  const barHeight = (value / maxValue) * chartHeight;
  const y = padding.top + chartHeight - barHeight;

  context.fillStyle = color;
  context.fillRect(x, y, barWidth, barHeight);
}

function toggleAccessGate(visible) {
  if (!accessGate) {
    return;
  }

  accessGate.classList.toggle('hidden', !visible);
}

function updateAccessSummary() {
  if (!accessSummary) {
    return;
  }

  const gmailStatus = gmailValidated ? 'Gmail confirmed' : 'Gmail pending';
  const summaryText = gmailValidated
    ? 'Access granted. Opening dashboard now.'
    : `Access locked. ${gmailStatus}.`;

  accessSummary.innerHTML = `<strong>${summaryText}</strong>`;
}

function formatCountdown(seconds) {
  return seconds > 0 ? `Expires in ${seconds}s` : 'Expired';
}

function clearGmailFlow() {
  gmailExpiresAt = null;
  gmailTimer && clearInterval(gmailTimer);
  gmailTimer = null;

  if (gmailCountdown) {
    gmailCountdown.textContent = '';
  }

  if (gmailMessage) {
    gmailMessage.textContent = 'Request a fresh Gmail code within 60 seconds.';
  }

  if (verifyGmailBtn) {
    verifyGmailBtn.disabled = true;
  }
}

function beginGmailCountdown(expiresIn) {
  clearGmailFlow();
  gmailExpiresAt = Date.now() + expiresIn * 1000;

  if (gmailMessage) {
    gmailMessage.textContent = 'Gmail code sent. Check your inbox.';
  }

  if (verifyGmailBtn) {
    verifyGmailBtn.disabled = false;
  }

  gmailTimer = setInterval(() => {
    const remaining = Math.ceil((gmailExpiresAt - Date.now()) / 1000);
    if (gmailCountdown) {
      gmailCountdown.textContent = formatCountdown(remaining);
    }
    if (remaining <= 0) {
      clearGmailFlow();
      if (gmailMessage) {
        gmailMessage.textContent = 'Gmail confirmation expired. Request a new code.';
      }
    }
  }, 250);
}

function validateAccessUnlock() {
  if (gmailValidated) {
    toggleAccessGate(false);
    return true;
  }

  toggleAccessGate(true);
  updateAccessSummary();
  return false;
}

if (requestGmailBtn) {
  requestGmailBtn.addEventListener('click', async () => {
    const email = gmailAddress.value.trim();
    if (!email) {
      gmailMessage.textContent = 'Enter the authorized Gmail address before requesting code.';
      return;
    }

    try {
      const response = await apiFetch('/api/confirm/request-gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await response.json();
      if (!response.ok) {
        gmailMessage.textContent = data.error || 'Unable to request Gmail code.';
        if (data.details) {
          gmailMessage.textContent += ` (${data.details})`;
        }
        return;
      }

      persistEmailPreference(email);
      sessionStorage.setItem('gmailValidated', 'false');

      // Keep the flow on the current page — no redirect, so the email
      // input keeps whatever was typed into it.
      beginGmailCountdown(Number(data.expires_in) || ACCESS_TIMEOUT_SECONDS);
      if (gmailMessage) {
        let message = data.message || 'Gmail code sent. Check your inbox.';
        if (data.debug_code) {
          message += ` Demo code: ${data.debug_code}`;
        }
        gmailMessage.textContent = message;
      }
    } catch (error) {
      gmailMessage.textContent = `Unable to contact backend for Gmail request. Ensure the backend is running at http://127.0.0.1:5000. ${error.message || error}`;
    }
  });
}

if (verifyGmailBtn) {
  verifyGmailBtn.addEventListener('click', async () => {
    const entry = gmailCodeInput.value.trim();
    const email = gmailAddress.value.trim();

    if (!email || !entry) {
      gmailMessage.textContent = 'Enter both email and Gmail code to verify.';
      return;
    }

    try {
      const response = await apiFetch('/api/confirm/verify-gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code: entry })
      });
      const data = await response.json();
      if (!response.ok) {
        gmailMessage.textContent = data.error || 'Gmail verification failed.';
        return;
      }

      gmailValidated = true;
      sessionStorage.setItem('gmailValidated', 'true');
      if (data.token) {
        sessionStorage.setItem(SESSION_TOKEN_KEY, data.token);
      }
      persistEmailPreference(email);
      clearGmailFlow();
      gmailMessage.textContent = 'Gmail confirmed successfully.';
      validateAccessUnlock();

      if (isDashboardView) {
        await fetchLoanRecords();
        computeSummary();
        renderRecords();
      }

      // Only navigate back to index when verifying from confirm.html.
      // On the index page the flow completes in place, so the email
      // input stays intact.
      if (!accessGate) {
        window.setTimeout(() => {
          window.location.href = `index.html?email=${encodeURIComponent(email)}`;
        }, 400);
      }
    } catch (error) {
      gmailMessage.textContent = `Unable to contact backend for Gmail verification. Ensure the backend is running at http://127.0.0.1:5000. ${error.message || error}`;
    }
  });
}

if (clearEmailBtn) {
  clearEmailBtn.addEventListener('click', forgetEmail);
}

if (rememberEmailCheckbox && gmailAddress) {
  rememberEmailCheckbox.addEventListener('change', () => {
    persistEmailPreference(gmailAddress.value.trim());
  });
}

const returnLink = document.getElementById('returnLink');
if (returnLink) {
  returnLink.addEventListener('click', (event) => {
    event.preventDefault();
    const email = gmailAddress ? gmailAddress.value.trim() : '';
    const base = returnLink.getAttribute('href') || 'index.html';
    const separator = base.includes('?') ? '&' : '?';
    window.location.href = email
      ? `${base}${separator}email=${encodeURIComponent(email)}`
      : base;
  });
}

if (loanForm) {
  loanForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const month = document.getElementById('month').value.trim();
    const issued = Number(document.getElementById('amount').value || 0);
    const recovered = Number(document.getElementById('recovered').value || 0);
    const defaulted = Number(document.getElementById('defaulted').value || 0);

    if (!month || issued < 0 || recovered < 0 || defaulted < 0) {
      return;
    }

    await postLoanRecord({ month, issued, recovered, defaulted });
    renderRecords();
    computeSummary();
    loanForm.reset();
  });
}

(async function initializeApp() {
  // A dashboard session only counts as unlocked while its token is present.
  gmailValidated = sessionStorage.getItem('gmailValidated') === 'true' && Boolean(sessionToken());
  if (!gmailValidated) {
    clearSession();
  }

  ['pendingGmailEmail', 'pendingGmailCode'].forEach((legacyKey) => {
    localStorage.removeItem(legacyKey);
    sessionStorage.removeItem(legacyKey);
  });

  // The email box is only pre-filled when the user explicitly asked to be
  // remembered, or when it was carried across pages in the URL.
  const saved = rememberedEmail();
  const linkedEmail = new URLSearchParams(window.location.search).get('email') || '';
  if (gmailAddress) {
    gmailAddress.value = linkedEmail || saved;
  }
  if (rememberEmailCheckbox) {
    rememberEmailCheckbox.checked = Boolean(saved);
  }

  if (isDashboardView && gmailValidated) {
    await fetchLoanRecords();
    computeSummary();
    renderRecords();
    drawChart();
  }

  clearGmailFlow();
  updateAccessSummary();
  validateAccessUnlock();
})();
