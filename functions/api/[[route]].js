/**
 * Cloudflare Pages Function — API Proxy
 * File: functions/api/[[route]].js
 *
 * Catches all requests to /api/* and proxies them to the upstream
 * endpoint using environment variables set in the CF Pages dashboard.
 *
 * Required Environment Variables (set in CF Pages → Settings → Variables):
 *   DOMAIN_ENDPOINT  e.g. https://endpoints.jainassociates.co.in
 *   BEARER_TOKEN     e.g. 221120032903200005022000
 */

export async function onRequest(context) {
    const { request, env, params } = context;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: corsHeaders()
        });
    }

    const BEARER_TOKEN   = env.BEARER_TOKEN   || '';
    const DOMAIN_ENDPOINT = env.DOMAIN_ENDPOINT || '';

    // ── Guard: Environment Variables Not Configured ──────────────────────
    if (!BEARER_TOKEN || !DOMAIN_ENDPOINT) {
        return jsonResponse({
            error: true,
            code: 'ENV_NOT_CONFIGURED',
            message: 'API is not available. The environment variables BEARER_TOKEN and DOMAIN_ENDPOINT have not been configured in Cloudflare Pages settings. Please contact the administrator.'
        }, 503);
    }

    // ── Build Upstream URL ────────────────────────────────────────────────
    // params.route is an array of path segments after /api/
    // e.g. /api/verify-pan?pan=ABC → params.route = ['verify-pan']
    const routeSegments = params.route ? params.route.join('/') : '';
    const incomingUrl   = new URL(request.url);
    const upstreamUrl   = `${DOMAIN_ENDPOINT.replace(/\/$/, '')}/api/${routeSegments}${incomingUrl.search}`;

    // ── Forward to Upstream API ───────────────────────────────────────────
    let upstreamResponse;
    try {
        upstreamResponse = await fetch(upstreamUrl, {
            method:  request.method,
            headers: {
                'Authorization': `Bearer ${BEARER_TOKEN}`,
                'Accept':        'application/json'
            }
        });
    } catch (fetchErr) {
        return jsonResponse({
            error: true,
            code: 'UPSTREAM_UNREACHABLE',
            message: `Could not reach the upstream API server: ${fetchErr.message}`
        }, 502);
    }

    // ── Stream Response Back to Client ────────────────────────────────────
    const body        = await upstreamResponse.text();
    const contentType = upstreamResponse.headers.get('Content-Type') || 'application/json';

    return new Response(body, {
        status:  upstreamResponse.status,
        headers: {
            'Content-Type': contentType,
            ...corsHeaders()
        }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders() {
    return {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };
}

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders()
        }
    });
}
