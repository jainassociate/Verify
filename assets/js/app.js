/**
 * TAX INTELLIGENCE PLATFORM - APP CONTROLLER
 */

// ── Environment Detection ─────────────────────────────────────────────────────
// IS_LOCAL       → localhost / 127.0.0.1          (dev mode — reads .env directly)
// IS_GITHUB      → *.github.io                    (static host — reads .env directly)
// IS_CF          → *.pages.dev or custom CF domain (uses server-side /api/* proxy)
//
// GitHub Pages is purely static: no server functions, no env vars, no _headers.
// Cloudflare Pages runs functions/api/[[route]].js which injects the Bearer token.
const hostname     = window.location.hostname;
const IS_LOCAL     = hostname === 'localhost' || hostname === '127.0.0.1';
const IS_GITHUB    = hostname.endsWith('.github.io');
const IS_CF        = !IS_LOCAL && !IS_GITHUB;   // Cloudflare Pages only
const NEEDS_PROXY  = IS_CF;                      // only CF has the server-side proxy

// Application State
const state = {
    config: {
        // Fallback defaults — used when .env cannot be loaded (e.g. GitHub Pages without .env in repo)
        // Priority chain: localStorage override > .env file > these defaults
        // On Cloudflare Pages, NEEDS_PROXY=true so these values are never used (CF Function handles auth)
        DOMAIN_ENDPOINT: 'https://endpoints.jainassociates.co.in',
        BEARER_TOKEN: '221120032903200005022000'
    },
    envReady: false,   // true once credentials are confirmed available
    activeTab: 'pan-verify',
    history: []
};

// Regex Patterns
const REGEX_PAN = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i;
const REGEX_GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i;

// DOM Elements
const elements = {
    // Nav & System
    menuItems: document.querySelectorAll('.menu-item'),
    tabPanels: document.querySelectorAll('.tab-panel'),
    clockTime: null, // clock removed
    serverStatusPill: document.getElementById('serverStatusPill'),
    serverStatusText: document.getElementById('serverStatusText'),
    // PAN Verify Form
    panVerifyForm: document.getElementById('panVerifyForm'),
    panVerifyInput: document.getElementById('panVerifyInput'),
    dobInput: document.getElementById('dobInput'),
    panVerifyBtn: document.getElementById('panVerifyBtn'),
    panVerifyError: document.getElementById('panVerifyError'),
    panVerifyResults: document.getElementById('panVerifyResults'),
    
    // PAN to GSTN Form
    panToGstnForm: document.getElementById('panToGstnForm'),
    panToGstnInput: document.getElementById('panToGstnInput'),
    panToGstnBtn: document.getElementById('panToGstnBtn'),
    panToGstnError: document.getElementById('panToGstnError'),
    panToGstnResults: document.getElementById('panToGstnResults'),
    
    // GSTIN Details Form
    gstinDetailsForm: document.getElementById('gstinDetailsForm'),
    gstinInput: document.getElementById('gstinInput'),
    gstinDetailsBtn: document.getElementById('gstinDetailsBtn'),
    gstinError: document.getElementById('gstinError'),
    gstinResults: document.getElementById('gstinResults'),
    
    // History
    historyTableBody: document.getElementById('historyTableBody'),
    clearHistoryBtn: document.getElementById('clearHistoryBtn'),
    
    toggleTokenVisibility: null  // settings modal removed
};

// Initialize Application
document.addEventListener('DOMContentLoaded', async () => {
    await loadEnvironment();
    initializeEventListeners();
    loadSearchHistory();
    await checkApiStatus();
});

// Load Environment Configuration
async function loadEnvironment() {
    setSystemStatus('connecting', 'Loading Config...');

    if (NEEDS_PROXY) {
        // ── Cloudflare Pages (Production) ────────────────────────────────
        // Credentials live in CF env vars (server-side only).
        // The /api/* proxy function will enforce their presence.
        // We mark envReady=true here; checkApiStatus() will confirm.
        state.envReady = true;
        // Hide the Settings modal trigger (credentials managed server-side)
        const settingsBtn = document.getElementById('openSettingsBtn');
        if (settingsBtn) settingsBtn.style.display = 'none';
        return;
    }

    // ── Local Dev / GitHub Pages ──────────────────────────────────────────
    // Both are static hosts that call the upstream API directly using .env credentials.
    let envVars = {};
    try {
        const res = await fetch('.env');
        if (res.ok) {
            const text = await res.text();
            envVars = parseEnvText(text);
            console.log('[DEV] .env loaded successfully.');
        }
    } catch (err) {
        console.warn('[DEV] Could not fetch .env:', err.message);
    }

    // Priority: window.APP_CONFIG (GitHub Actions secrets) > localStorage > .env file > hardcoded defaults
    const ciConfig      = window.APP_CONFIG || {};
    const savedEndpoint = localStorage.getItem('cfg_endpoint');
    const savedToken    = localStorage.getItem('cfg_token');

    state.config.DOMAIN_ENDPOINT = savedEndpoint || ciConfig.DOMAIN_ENDPOINT || envVars.DOMAIN_ENDPOINT || state.config.DOMAIN_ENDPOINT;
    state.config.BEARER_TOKEN    = savedToken    || ciConfig.BEARER_TOKEN    || envVars.BEARER_TOKEN    || state.config.BEARER_TOKEN;
    state.envReady = !!(state.config.DOMAIN_ENDPOINT && state.config.BEARER_TOKEN);
}

// Simple parser for raw .env file text
function parseEnvText(text) {
    const env = {};
    text.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const idx = trimmed.indexOf('=');
            if (idx > 0) {
                const key   = trimmed.substring(0, idx).trim();
                const value = trimmed.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
                env[key] = value;
            }
        }
    });
    return env;
}

// Ping the API to confirm credentials are live
async function checkApiStatus() {
    setSystemStatus('connecting', 'Checking API...');

    try {
        const controller = new AbortController();
        const timeoutId  = setTimeout(() => controller.abort(), 8000);

        // On CF: hit our own proxy (/api/verify-pan)
        // On local/GitHub: hit the upstream directly
        const pingUrl = NEEDS_PROXY
            ? '/api/verify-pan?pan=TESTPING'
            : `${state.config.DOMAIN_ENDPOINT}/api/verify-pan?pan=TESTPING`;

        const headers = NEEDS_PROXY
            ? {}   // CF Function injects Authorization server-side
            : { 'Authorization': `Bearer ${state.config.BEARER_TOKEN}` };

        // Direct mode: don't even try if config is missing
        if (!NEEDS_PROXY && !state.envReady) {
            setSystemStatus('offline', 'Config Missing');
            showConfigBanner();
            return;
        }

        const res = await fetch(pingUrl, { method: 'GET', headers, signal: controller.signal });
        clearTimeout(timeoutId);

        if (res.status === 503) {
            // CF Function returned 503 → ENV_NOT_CONFIGURED
            const json = await res.json().catch(() => ({}));
            if (json.code === 'ENV_NOT_CONFIGURED') {
                setSystemStatus('offline', 'Env Not Set');
                showConfigBanner();
                return;
            }
        }

        // Any HTTP response (even 4xx for bad PAN) means the server is reachable & auth works
        setSystemStatus('online', 'System Online');
        hideConfigBanner();
    } catch (err) {
        console.error('API ping failed:', err);
        setSystemStatus('offline', 'API Unreachable');
    }
}

function setSystemStatus(status, label) {
    elements.serverStatusPill.className = `server-status-pill ${status}`;
    elements.serverStatusText.textContent = label;
}

// Config Error Banner helpers
function showConfigBanner() {
    let banner = document.getElementById('cfConfigBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'cfConfigBanner';
        banner.className = 'cf-config-banner';
        banner.innerHTML = `
            <i class="fas fa-exclamation-triangle"></i>
            <div>
                <strong>API Environment Variables Not Configured</strong>
                <span>${NEEDS_PROXY
                    ? 'Go to <b>Cloudflare Pages → Settings → Environment Variables</b> and add <code>BEARER_TOKEN</code> and <code>DOMAIN_ENDPOINT</code>, then redeploy.'
                    : 'Add <code>BEARER_TOKEN</code> and <code>DOMAIN_ENDPOINT</code> to your <code>.env</code> file or use the ⚙ Settings icon above.'
                }</span>
            </div>
        `;
        const content = document.querySelector('.app-content');
        if (content) content.prepend(banner);
    }
    banner.style.display = 'flex';
    // Disable all submit buttons until resolved
    document.querySelectorAll('.submit-btn').forEach(btn => {
        btn.disabled = true;
        btn.title = 'API not available — environment variables not configured.';
    });
}

function hideConfigBanner() {
    const banner = document.getElementById('cfConfigBanner');
    if (banner) banner.style.display = 'none';
}

// Setup Event Handlers
function initializeEventListeners() {
    // Tab switching
    elements.menuItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetTab = item.getAttribute('data-tab');
            switchTab(targetTab);
        });
    });

    // Real-Time Form Validations
    setupValidation(elements.panVerifyInput, REGEX_PAN, elements.panVerifyError, () => {
        checkPanVerifyFormValidity();
    });
    elements.dobInput.addEventListener('input', (e) => {
        let val = e.target.value.replace(/[^0-9]/g, ''); // digits only
        if (val.length >= 3 && val.length <= 4) {
            val = val.slice(0, 2) + '/' + val.slice(2);
        } else if (val.length >= 5) {
            val = val.slice(0, 2) + '/' + val.slice(2, 4) + '/' + val.slice(4, 8);
        }
        e.target.value = val;
        
        const dobErrorEl = document.getElementById('dobError');
        const isValid = REGEX_DOB.test(val.trim());
        if (dobErrorEl) {
            dobErrorEl.style.display = (val.length > 0 && !isValid) ? 'block' : 'none';
        }
        checkPanVerifyFormValidity();
    });

    setupValidation(elements.panToGstnInput, REGEX_PAN, elements.panToGstnError, (isValid) => {
        elements.panToGstnBtn.disabled = !isValid;
    });

    setupValidation(elements.gstinInput, REGEX_GSTIN, elements.gstinError, (isValid) => {
        elements.gstinDetailsBtn.disabled = !isValid;
    });

    // Form Submissions
    elements.panVerifyForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await performPanVerification();
    });

    elements.panToGstnForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await performPanToGstnFinder();
    });

    elements.gstinDetailsForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await performGstinDetailsFinder();
    });


    // Clear History Log
    elements.clearHistoryBtn.addEventListener('click', () => {
        if (confirm("Are you sure you want to clear all verification logs from this session?")) {
            state.history = [];
            saveSearchHistory();
            renderSearchHistory();
        }
    });
}

// Routing Tab Switching
function switchTab(tabId) {
    state.activeTab = tabId;
    elements.menuItems.forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
    elements.tabPanels.forEach(panel => {
        panel.classList.toggle('active', panel.id === tabId);
    });
}

// Validation Utility Helper
function setupValidation(inputElement, regex, errorElement, callback) {
    inputElement.addEventListener('input', () => {
        let value = inputElement.value.trim().toUpperCase();
        inputElement.value = value; // Force uppercase in input
        
        const wrapper = inputElement.closest('.input-wrapper');
        
        if (value === "") {
            wrapper.className = "input-wrapper";
            errorElement.style.display = "none";
            if (callback) callback(false);
            return;
        }

        const isValid = regex.test(value);
        if (isValid) {
            wrapper.className = "input-wrapper valid";
            errorElement.style.display = "none";
        } else {
            wrapper.className = "input-wrapper invalid";
            errorElement.style.display = "block";
        }

        if (callback) callback(isValid);
    });
}

// DOB regex: DD/MM/YYYY
const REGEX_DOB = /^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])\/\d{4}$/;

function checkPanVerifyFormValidity() {
    const isPanValid = REGEX_PAN.test(elements.panVerifyInput.value.trim());
    const isDobValid = REGEX_DOB.test(elements.dobInput.value.trim());
    elements.panVerifyBtn.disabled = !(isPanValid && isDobValid);
    
    // Show visual feedback on DOB field
    const dobWrapper = elements.dobInput.closest('.input-wrapper');
    if (elements.dobInput.value.trim() === '') {
        dobWrapper.className = 'input-wrapper';
    } else if (isDobValid) {
        dobWrapper.className = 'input-wrapper valid';
    } else {
        dobWrapper.className = 'input-wrapper invalid';
    }
}

// DOB is already in DD/MM/YYYY — just return it directly
function formatDob(dateString) {
    return dateString ? dateString.trim() : '';
}

// For history reload — DOB is stored as DD/MM/YYYY, just fill back directly
function parseDobToDatePicker(dobString) {
    return dobString || '';
}

// Base Fetch Function — environment-aware routing
async function fetchFromApi(path, params = {}) {
    const query = new URLSearchParams(params).toString();
    const qs    = query ? '?' + query : '';

    let url, headers;

    if (IS_CF) {
        // ── Cloudflare Pages (Production) ────────────────────────────────
        // Call our own /api/* proxy — CF Function injects Authorization
        url     = `${path}${qs}`;   // e.g. /api/verify-pan?pan=ABC
        headers = {};
    } else {
        // ── Local Development ─────────────────────────────────────────────
        if (!state.envReady) {
            throw new Error('Credentials not configured. Add BEARER_TOKEN and DOMAIN_ENDPOINT to your .env file.');
        }
        url     = `${state.config.DOMAIN_ENDPOINT}${path}${qs}`;
        headers = { 'Authorization': `Bearer ${state.config.BEARER_TOKEN}` };
    }

    const response = await fetch(url, { method: 'GET', headers });

    // Handle CF Function 503 — env vars not set on Cloudflare Pages
    if (response.status === 503) {
        const json = await response.json().catch(() => ({}));
        if (json.code === 'ENV_NOT_CONFIGURED') {
            showConfigBanner();
            setSystemStatus('offline', 'Env Not Set');
            throw new Error('API environment variables are not configured in Cloudflare Pages. Contact the administrator.');
        }
    }

    if (!response.ok) {
        if (response.status === 401) {
            throw new Error('Authentication failed. Check BEARER_TOKEN in Cloudflare Pages Environment Variables.');
        }
        throw new Error(`API returned HTTP Status ${response.status}`);
    }

    return await response.json();
}

// Render Loading Skeleton Block
function showSkeletonLoader(containerElement) {
    containerElement.innerHTML = `
        <div class="skeleton-card">
            <div class="skeleton-line title"></div>
            <div class="skeleton-grid">
                <div>
                    <div class="skeleton-line medium"></div>
                    <div class="skeleton-line short"></div>
                </div>
                <div>
                    <div class="skeleton-line medium"></div>
                    <div class="skeleton-line short"></div>
                </div>
            </div>
            <div class="skeleton-grid">
                <div>
                    <div class="skeleton-line medium"></div>
                </div>
                <div>
                    <div class="skeleton-line short"></div>
                </div>
            </div>
        </div>
    `;
}

// Handle errors beautifully
function renderErrorCard(containerElement, errorTitle, errorMessage) {
    containerElement.innerHTML = `
        <div class="message-card error">
            <i class="fas fa-exclamation-triangle"></i>
            <h4>${escapeHtml(errorTitle)}</h4>
            <p>${escapeHtml(errorMessage)}</p>
        </div>
    `;
}

// Escapes raw HTML to prevent injection issues
function escapeHtml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Copy Text Command
function copyTextToClipboard(text, btnElement) {
    navigator.clipboard.writeText(text).then(() => {
        const originalHtml = btnElement.innerHTML;
        btnElement.innerHTML = `<i class="fas fa-check"></i> Copied!`;
        btnElement.style.backgroundColor = 'var(--success)';
        btnElement.style.color = 'white';
        btnElement.style.borderColor = 'var(--success)';
        
        setTimeout(() => {
            btnElement.innerHTML = originalHtml;
            btnElement.style.backgroundColor = '';
            btnElement.style.color = '';
            btnElement.style.borderColor = '';
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy text: ', err);
    });
}

// ----------------------------------------------------
// 1. PAN VERIFICATION PROCESSOR
// ----------------------------------------------------
async function performPanVerification(panVal = null, dobVal = null) {
    const pan = (panVal || elements.panVerifyInput.value).trim().toUpperCase();
    let dob = dobVal;
    
    if (!dobVal) {
        dob = formatDob(elements.dobInput.value);
    } else {
        // If coming from history reload, populate input field
        elements.dobInput.value = parseDobToDatePicker(dobVal);
    }
    
    elements.panVerifyInput.value = pan;
    checkPanVerifyFormValidity();

    showSkeletonLoader(elements.panVerifyResults);
    elements.panVerifyBtn.classList.add('loading');
    
    try {
        const data = await fetchFromApi('/api/verify-pan', { pan, dob });
        elements.panVerifyBtn.classList.remove('loading');
        
        if (data && data.status === 200 && data.data) {
            const panData = data.data;
            renderPanResults(panData, dob);
            
            // Add to session history logs
            addToHistory({
                type: 'pan',
                lookupId: pan,
                status: panData.status || 'Valid',
                summary: panData.fullNameAsPan || 'Unknown Cardholder',
                details: { ...panData, inputDob: dob }
            });
        } else {
            const errMsg = data.message ? data.message.join(', ') : 'Verification returned invalid payload.';
            renderErrorCard(elements.panVerifyResults, 'Lookup Failed', errMsg);
        }
    } catch (err) {
        elements.panVerifyBtn.classList.remove('loading');
        renderErrorCard(elements.panVerifyResults, 'Connection Error', err.message);
    }
}

function renderPanResults(data, dob) {
    const isOperative = String(data.status).toLowerCase().includes('operative') || String(data.status).toLowerCase().includes('valid');
    const badgeClass = isOperative ? 'success' : 'danger';
    const badgeIcon = isOperative ? 'check-circle' : 'times-circle';
    
    elements.panVerifyResults.innerHTML = `
        <div class="result-card ${badgeClass}-border">
            <div class="result-card-header">
                <h3>PAN Lookup Results: <span class="highlight-code text-uppercase">${escapeHtml(data.pan)}</span></h3>
                <div style="margin-left: auto; display: flex; gap: 8px;">
                    <span class="badge ${badgeClass}">
                        <i class="fas fa-${badgeIcon}"></i> ${escapeHtml(data.status)}
                    </span>
                    <button class="action-btn secondary" style="padding: 4px 12px; font-size: 0.8rem;" onclick="exportToPDF(this, 'PAN_Report_${data.pan}')">
                        <i class="fas fa-file-pdf"></i> Export PDF
                    </button>
                </div>
            </div>
            <div class="result-card-body">
                <div class="details-grid">
                    <div class="detail-item">
                        <span class="lbl">Registered Legal Name</span>
                        <span class="val highlight text-uppercase">${escapeHtml(data.fullNameAsPan || 'N/A')}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Permanent Account Number (PAN)</span>
                        <span class="val text-uppercase">${escapeHtml(data.pan)}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Date of Birth (DOB) Matched</span>
                        <span class="val">${escapeHtml(dob)}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Aadhaar Link Status</span>
                        <span class="val">${escapeHtml(data.dateOfAadhaarPanLinking || 'Not Linked / Non-applicable')}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">ITR Filer Status</span>
                        <span class="val">${escapeHtml(data.itrFilerOrNonFilerApplicability || 'Non-filer or N/A')}</span>
                    </div>
                </div>
            </div>
            <div class="result-card-footer">
                <button class="action-btn secondary" onclick="copyPanDetails(this)">
                    <i class="far fa-copy"></i> Copy Details
                </button>
                <button class="action-btn primary" onclick="searchAssociatedGst('${data.pan}')">
                    <i class="fas fa-link"></i> Find Linked GSTINs
                </button>
            </div>
        </div>
    `;
}

// Window scope functions for action buttons
window.copyPanDetails = function(btn) {
    const card = btn.closest('.result-card');
    const name = card.querySelector('.details-grid .detail-item:nth-child(1) .val').textContent;
    const pan = card.querySelector('.details-grid .detail-item:nth-child(2) .val').textContent;
    const dob = card.querySelector('.details-grid .detail-item:nth-child(3) .val').textContent;
    const aadhaar = card.querySelector('.details-grid .detail-item:nth-child(4) .val').textContent;
    
    const copyString = `PAN VERIFICATION REPORT\n=======================\nPAN Card Number: ${pan}\nFull Legal Name: ${name}\nDate of Birth: ${dob}\nAadhaar Link: ${aadhaar}\n`;
    copyTextToClipboard(copyString, btn);
};

window.searchAssociatedGst = function(pan) {
    elements.panToGstnInput.value = pan;
    // Trigger input validation on destination element
    elements.panToGstnInput.dispatchEvent(new Event('input'));
    switchTab('pan-to-gstn');
    performPanToGstnFinder(pan);
};


// ----------------------------------------------------
// 2. PAN TO GSTN FINDER PROCESSOR
// ----------------------------------------------------
async function performPanToGstnFinder(panVal = null) {
    const pan = (panVal || elements.panToGstnInput.value).trim().toUpperCase();
    elements.panToGstnInput.value = pan;
    elements.panToGstnBtn.disabled = !REGEX_PAN.test(pan);

    showSkeletonLoader(elements.panToGstnResults);
    elements.panToGstnBtn.classList.add('loading');

    try {
        const data = await fetchFromApi('/api/pan-to-gstin', { pan });
        elements.panToGstnBtn.classList.remove('loading');

        if (data && data.pan === pan) {
            renderPanToGstnResults(data);
            
            // Add to session logs
            addToHistory({
                type: 'pan-gstn',
                lookupId: pan,
                status: 'Success',
                summary: `${data.count} GSTIN(s) Found`,
                details: data
            });
        } else {
            renderErrorCard(elements.panToGstnResults, 'Lookup Failed', 'The registry did not return associated GSTINs.');
        }
    } catch (err) {
        elements.panToGstnBtn.classList.remove('loading');
        renderErrorCard(elements.panToGstnResults, 'Connection Error', err.message);
    }
}

function renderPanToGstnResults(data) {
    if (data.count === 0 || !data.items || data.items.length === 0) {
        elements.panToGstnResults.innerHTML = `
            <div class="message-card no-results">
                <i class="fas fa-search-minus"></i>
                <h4>No GSTIN Records Found</h4>
                <p>There are no active or canceled GST registrations associated with the PAN <strong>${escapeHtml(data.pan)}</strong>.</p>
            </div>
        `;
        return;
    }

    let itemsHtml = '';
    data.items.forEach(item => {
        const isActive = String(item.auth_status).toLowerCase() === 'active';
        const badgeClass = isActive ? 'success' : 'warning';
        const badgeIcon = isActive ? 'check' : 'times';
        
        itemsHtml += `
            <div class="gstin-item-card">
                <div class="gstin-item-header">
                    <span class="gstin-code">${escapeHtml(item.gstin)}</span>
                    <span class="badge ${badgeClass}">
                        <i class="fas fa-${badgeIcon}"></i> ${escapeHtml(item.auth_status)}
                    </span>
                </div>
                <div class="gstin-item-body">
                    <span class="state-info"><i class="fas fa-map-marker-alt"></i> State: <strong>${escapeHtml(item.state)}</strong></span>
                </div>
                <div class="gstin-item-actions">
                    <button class="micro-btn" onclick="copySingleGstin('${item.gstin}', this)">
                        <i class="far fa-copy"></i>
                    </button>
                    <button class="micro-btn accent" onclick="searchGstinDetails('${item.gstin}')">
                        View Registry Details <i class="fas fa-chevron-right"></i>
                    </button>
                </div>
            </div>
        `;
    });

    elements.panToGstnResults.innerHTML = `
        <div class="result-card traces-theme">
            <div class="result-card-header">
                <h3>PAN to GSTN Mapping: <span class="text-uppercase">${escapeHtml(data.pan)}</span></h3>
                <div style="margin-left: auto; display: flex; gap: 8px;">
                    <span class="badge info">
                        <i class="fas fa-link"></i> ${data.count} Registered
                    </span>
                    <button class="action-btn secondary" style="padding: 4px 12px; font-size: 0.8rem;" onclick="exportToPDF(this, 'PAN_GSTN_Report_${data.pan}')">
                        <i class="fas fa-file-pdf"></i> Export PDF
                    </button>
                </div>
            </div>
            <div class="result-card-body">
                <p style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 12px;">The following GST registrations are registered under PAN holder. Click on "View Registry Details" to pull the detailed state folder.</p>
                <div class="gstin-items-grid">
                    ${itemsHtml}
                </div>
            </div>
        </div>
    `;
}

window.copySingleGstin = function(gstin, btn) {
    copyTextToClipboard(gstin, btn);
};

window.searchGstinDetails = function(gstin) {
    elements.gstinInput.value = gstin;
    elements.gstinInput.dispatchEvent(new Event('input'));
    switchTab('gstin-details');
    performGstinDetailsFinder(gstin);
};


// ----------------------------------------------------
// 3. GSTIN DETAILS FINDER PROCESSOR
// ----------------------------------------------------
async function performGstinDetailsFinder(gstinVal = null) {
    const gstin = (gstinVal || elements.gstinInput.value).trim().toUpperCase();
    elements.gstinInput.value = gstin;
    elements.gstinDetailsBtn.disabled = !REGEX_GSTIN.test(gstin);

    showSkeletonLoader(elements.gstinResults);
    elements.gstinDetailsBtn.classList.add('loading');

    try {
        const data = await fetchFromApi('/api/gstin-details', { gstnin: gstin });
        elements.gstinDetailsBtn.classList.remove('loading');

        if (data && data.gstin === gstin) {
            renderGstinDetailsResults(data);
            
            // Add to session history
            addToHistory({
                type: 'gstin',
                lookupId: gstin,
                status: data.status || 'Active',
                summary: data.tradename || data.name || 'Unknown Business',
                details: data
            });
        } else {
            renderErrorCard(elements.gstinResults, 'No Record', `No business registry found matching GSTIN ${gstin}`);
        }
    } catch (err) {
        elements.gstinDetailsBtn.classList.remove('loading');
        renderErrorCard(elements.gstinResults, 'Connection Error', err.message);
    }
}

function renderGstinDetailsResults(data) {
    const isActive = String(data.status).toLowerCase() === 'active';
    const badgeClass = isActive ? 'success' : 'danger';
    const badgeIcon = isActive ? 'check-circle' : 'times-circle';
    
    // Nature of business items
    const natureString = data.nature ? data.nature.join(', ') : 'Not Specified';
    
    // Address Builder
    const addr = data.pradr || {};
    const formattedAddress = [
        addr.bno, addr.bnm, addr.flno, addr.st, addr.loc, addr.locality, addr.city, addr.district, addr.stcd, addr.pncd
    ].filter(val => val && val.trim() !== "").join(', ');

    elements.gstinResults.innerHTML = `
        <div class="result-card ${badgeClass}-border">
            <div class="result-card-header">
                <h3>GSTIN Profile: <span class="highlight-code text-uppercase">${escapeHtml(data.gstin)}</span></h3>
                <div style="margin-left: auto; display: flex; gap: 8px;">
                    <span class="badge ${badgeClass}">
                        <i class="fas fa-${badgeIcon}"></i> Status: ${escapeHtml(data.status)}
                    </span>
                    <button class="action-btn secondary" style="padding: 4px 12px; font-size: 0.8rem;" onclick="exportToPDF(this, 'GSTIN_Report_${data.gstin}')">
                        <i class="fas fa-file-pdf"></i> Export PDF
                    </button>
                </div>
            </div>
            <div class="result-card-body">
                <div class="details-grid" style="margin-bottom: 24px;">
                    <div class="detail-item" style="grid-column: 1 / -1;">
                        <span class="lbl">Trade Name (Brand Name)</span>
                        <span class="val highlight text-uppercase" style="font-size:1.2rem; color:var(--primary-navy);">${escapeHtml(data.tradename || 'N/A')}</span>
                    </div>
                    <div class="detail-item" style="grid-column: 1 / -1;">
                        <span class="lbl">Legal Name of Taxpayer (Director/Owner)</span>
                        <span class="val text-uppercase">${escapeHtml(data.name)}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">GSTIN Number</span>
                        <span class="val text-uppercase">${escapeHtml(data.gstin)}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Taxpayer Type</span>
                        <span class="val">${escapeHtml(data.type || 'Regular')}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Constitution of Business</span>
                        <span class="val">${escapeHtml(data.constitution || 'Sole Proprietorship')}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Date of Registration</span>
                        <span class="val">${escapeHtml(data.registrationDate)}</span>
                    </div>
                    
                    ${data.cancellationDate ? `
                    <div class="detail-item">
                        <span class="lbl" style="color:var(--danger);">Date of Cancellation</span>
                        <span class="val" style="color:var(--danger);">${escapeHtml(data.cancellationDate)}</span>
                    </div>` : ''}

                    <div class="detail-item">
                        <span class="lbl">State jurisdiction</span>
                        <span class="val">${escapeHtml(data.state)}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Center Jurisdiction</span>
                        <span class="val">${escapeHtml(data.center)}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">E-Invoice Status</span>
                        <span class="val">${escapeHtml(data.einvoiceStatus || 'No')}</span>
                    </div>
                    <div class="detail-item">
                        <span class="lbl">Nature of Activities</span>
                        <span class="val">${escapeHtml(natureString)}</span>
                    </div>
                </div>

                <div style="border-top:1px solid var(--border-color); padding-top:16px; margin-top:16px;">
                    <h4 style="font-size:0.85rem; text-transform:uppercase; color:var(--text-muted); margin-bottom:8px; letter-spacing:0.5px;">Principal Place of Business</h4>
                    <p style="font-weight:600; color:var(--text-primary); font-size:0.92rem; line-height:1.4;"><i class="fas fa-map-marker-alt" style="color:var(--primary-orange); margin-right:6px;"></i> ${escapeHtml(formattedAddress || 'No primary address returned')}</p>
                </div>
            </div>
            <div class="result-card-footer">
                <button class="action-btn secondary" onclick="copyGstinDetails(this)">
                    <i class="far fa-copy"></i> Copy Business Profile
                </button>
            </div>
        </div>
    `;
}

window.copyGstinDetails = function(btn) {
    const card = btn.closest('.result-card');
    const tradeName = card.querySelector('.details-grid .detail-item:nth-child(1) .val').textContent;
    const legalName = card.querySelector('.details-grid .detail-item:nth-child(2) .val').textContent;
    const gstin = card.querySelector('.details-grid .detail-item:nth-child(3) .val').textContent;
    const status = card.querySelector('.result-card-header .badge').textContent.trim();
    const address = card.querySelector('div[style*="border-top"] p').textContent.trim();
    
    const copyString = `GSTIN PROFILE SUMMARY\n======================\nTrade Name: ${tradeName}\nLegal Name: ${legalName}\nGSTIN Number: ${gstin}\nStatus: ${status}\nAddress: ${address}\n`;
    copyTextToClipboard(copyString, btn);
};


// ----------------------------------------------------
// 4. SEARCH HISTORY & LOG SERVICES
// ----------------------------------------------------
function loadSearchHistory() {
    try {
        const historyData = localStorage.getItem('tax_intelligence_history');
        if (historyData) {
            state.history = JSON.parse(historyData);
        }
    } catch (e) {
        console.error("Failed to parse local search history: ", e);
        state.history = [];
    }
    renderSearchHistory();
}

function saveSearchHistory() {
    localStorage.setItem('tax_intelligence_history', JSON.stringify(state.history));
}

function addToHistory(item) {
    // Prevent duplicated lookup entries by moving existing ones to front
    state.history = state.history.filter(h => !(h.type === item.type && h.lookupId === item.lookupId));
    
    // Prefix current date timestamp
    const historyItem = {
        ...item,
        timestamp: Date.now()
    };
    
    state.history.unshift(historyItem);
    
    // Cap history size to 30 lookups
    if (state.history.length > 30) {
        state.history.pop();
    }
    
    saveSearchHistory();
    renderSearchHistory();
}

function deleteHistoryItem(index) {
    state.history.splice(index, 1);
    saveSearchHistory();
    renderSearchHistory();
}

function reloadHistoryItem(index) {
    const item = state.history[index];
    if (!item) return;

    if (item.type === 'pan') {
        switchTab('pan-verify');
        elements.panVerifyInput.value = item.lookupId;
        // Trigger inputs rendering
        elements.panVerifyInput.dispatchEvent(new Event('input'));
        renderPanResults(item.details, item.details.inputDob);
    } else if (item.type === 'pan-gstn') {
        switchTab('pan-to-gstn');
        elements.panToGstnInput.value = item.lookupId;
        elements.panToGstnInput.dispatchEvent(new Event('input'));
        renderPanToGstnResults(item.details);
    } else if (item.type === 'gstin') {
        switchTab('gstin-details');
        elements.gstinInput.value = item.lookupId;
        elements.gstinInput.dispatchEvent(new Event('input'));
        renderGstinDetailsResults(item.details);
    }
}

// Bind to window scope so onclick calls trigger correctly
window.deleteHistoryRow = function(index) {
    deleteHistoryItem(index);
};

window.reloadHistoryRow = function(index) {
    reloadHistoryItem(index);
};

function renderSearchHistory() {
    if (state.history.length === 0) {
        elements.historyTableBody.innerHTML = `
            <tr class="empty-row-placeholder">
                <td colspan="6" class="text-center">
                    <div class="empty-state">
                        <i class="fas fa-folder-open"></i>
                        <p>No verification logs found. Run lookups above to populate history.</p>
                    </div>
                </td>
            </tr>
        `;
        return;
    }

    let rowsHtml = '';
    state.history.forEach((item, index) => {
        const date = new Date(item.timestamp);
        const formattedDate = date.toLocaleDateString('en-IN', {
            day: '2-digit', month: '2-digit', year: 'numeric'
        }) + ' ' + date.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });

        let typeLabel = '';
        if (item.type === 'pan') typeLabel = '<span class="badge info"><i class="fas fa-id-card"></i> PAN Verify</span>';
        if (item.type === 'pan-gstn') typeLabel = '<span class="badge" style="background-color:#fafaf9; border-color:#d6d3d1; color:#44403c;"><i class="fas fa-link"></i> PAN to GSTN</span>';
        if (item.type === 'gstin') typeLabel = '<span class="badge" style="background-color:#fff1f2; border-color:#fecdd3; color:#be123c;"><i class="fas fa-file-invoice-dollar"></i> GSTN Info</span>';

        const isSuccess = String(item.status).toLowerCase().includes('operative') || String(item.status).toLowerCase().includes('valid') || String(item.status).toLowerCase() === 'active' || String(item.status).toLowerCase() === 'success';
        const badgeClass = isSuccess ? 'success' : 'danger';
        
        rowsHtml += `
            <tr>
                <td style="white-space: nowrap; font-family: monospace;">${formattedDate}</td>
                <td>${typeLabel}</td>
                <td style="font-family: monospace; font-weight: 700; text-transform: uppercase;">${escapeHtml(item.lookupId)}</td>
                <td><span class="badge ${badgeClass}">${escapeHtml(item.status)}</span></td>
                <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.summary)}</td>
                <td class="actions-col">
                    <button class="history-btn" onclick="reloadHistoryRow(${index})" title="View Cached Result">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="history-btn delete-item-btn" onclick="deleteHistoryRow(${index})" title="Delete entry">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                </td>
            </tr>
        `;
    });

    elements.historyTableBody.innerHTML = rowsHtml;
}

// ----------------------------------------------------
// PDF EXPORT UTILITY
// ----------------------------------------------------
window.exportToPDF = function(btn, filename) {
    if (typeof html2pdf === 'undefined') {
        alert("PDF export library is still loading. Please try again in a few seconds.");
        return;
    }

    const card = btn.closest('.result-card');
    
    // Temporarily hide action buttons during PDF generation
    const actionElements = card.querySelectorAll('button, .result-card-footer, .gstin-item-actions');
    actionElements.forEach(el => el.style.display = 'none');

    const opt = {
        margin:       0.5,
        filename:     filename + '.pdf',
        image:        { type: 'jpeg', quality: 0.98 },
        html2canvas:  { scale: 2, useCORS: true },
        jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    // Apply high-contrast CSS overrides just for PDF render
    card.classList.add('pdf-export-mode');

    html2pdf().set(opt).from(card).save().then(() => {
        // Restore action buttons and remove PDF styling
        actionElements.forEach(el => el.style.display = '');
        card.classList.remove('pdf-export-mode');
    });
};
