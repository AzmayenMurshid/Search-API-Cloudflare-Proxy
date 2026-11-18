const buildCorsHeaders = (origin = '*') => ({
  'content-type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization'
});

const jsonResponse = (body, status = 200, origin = '*') => new Response(JSON.stringify(body), {
  status,
  headers: buildCorsHeaders(origin)
});

const sanitizeText = (value) => String(value || '').trim();

const normalizeForMatch = (value) => sanitizeText(value)
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const COMPANY_STOP_WORDS = new Set([
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'lp',
  'llp',
  'pllc',
  'the',
  'and',
  'of'
]);

const extractMatchTokens = (value) => normalizeForMatch(value)
  .split(' ')
  .filter((token) => token.length >= 3 && !COMPANY_STOP_WORDS.has(token));

const companyMatchesQuery = (companyName, query) => {
  const normalizedName = normalizeForMatch(companyName);
  const normalizedQuery = normalizeForMatch(query);

  if (!normalizedName || !normalizedQuery) {
    return false;
  }

  if (normalizedName.includes(normalizedQuery)) {
    return true;
  }

  const queryTokens = extractMatchTokens(query);
  if (queryTokens.length === 0) {
    return normalizedName.includes(normalizedQuery);
  }

  return queryTokens.every((token) => normalizedName.includes(token));
};

const extractCompanyAndState = (searchParams, defaultState = '') => {
  const rawQuery = sanitizeText(searchParams.get('query'));
  const explicitCompany = sanitizeText(searchParams.get('company'));
  const explicitState = sanitizeText(searchParams.get('state')).toUpperCase();

  if (explicitCompany) {
    return {
      company: explicitCompany,
      state: /^[A-Z]{2}$/.test(explicitState) ? explicitState : ''
    };
  }

  // Supports current module format: "Business Name - FL"
  const stateSuffixMatch = rawQuery.match(/^(.*?)(?:\s*[-,]\s*|\s+)([A-Za-z]{2})$/);
  if (stateSuffixMatch) {
    const company = sanitizeText(stateSuffixMatch[1]);
    const state = sanitizeText(stateSuffixMatch[2]).toUpperCase();
    if (company && /^[A-Z]{2}$/.test(state)) {
      return { company, state };
    }
  }

  return {
    company: rawQuery,
    state: /^[A-Z]{2}$/.test(explicitState) ? explicitState : defaultState
  };
};

const toItemArray = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!payload || typeof payload !== 'object') {
    return [];
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.items)) {
    return payload.items;
  }

  return [payload];
};

const hasMeaningfulCompanyData = (item) => {
  if (!item || typeof item !== 'object') {
    return false;
  }

  const fields = [
    item.name,
    item.company,
    item.company_name,
    item.business_name,
    item.legal_name,
    item.file_number,
    item.business_id,
    item.uei,
    item.duns,
    item.business_address,
    item.registered_agent_full_address
  ];

  return fields.some((value) => sanitizeText(value).length > 0);
};

const normalizeResultItem = (item, fallbackCompany) => {
  if (!item || typeof item !== 'object') {
    return {
      id: fallbackCompany,
      name: fallbackCompany || 'Unknown Business',
      state: '',
      status: ''
    };
  }

  const name = item.name || item.company || item.company_name || item.business_name || item.legal_name || fallbackCompany || 'Unknown Business';
  const state = sanitizeText(item.state || item.business_state || item.business_address_state || item.entity_formation_state).toUpperCase();
  const status = sanitizeText(item.status || item.is_the_active_or_dissolved_).toUpperCase();

  return {
    id: item.id || item.business_id || item.file_number || name,
    name,
    state,
    status
  };
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const defaultState = '';

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(allowOrigin)
      });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'yanko-business-search-proxy' }, 200, allowOrigin);
    }

    if (url.pathname !== '/api/business-search') {
      return jsonResponse({ error: 'Not found' }, 404, allowOrigin);
    }

    const { company, state } = extractCompanyAndState(url.searchParams, defaultState);
    if (!company || company.length < 3) {
      return jsonResponse({ error: 'Query too short', message: 'Provide at least 3 characters.' }, 400, allowOrigin);
    }

    if (!state) {
      return jsonResponse({
        error: 'State required',
        message: 'Provide state as ?state=FL or include it in query as "Company Name - FL".'
      }, 400, allowOrigin);
    }

    const debugMode = url.searchParams.get('debug') === '1';
    const upstream = new URL('https://sbaexit.com/search_company23.php');
    upstream.searchParams.set('company', company);
    if (state) {
      upstream.searchParams.set('state', state);
    }

    const upstreamUrl = upstream.toString();
    const startedAt = Date.now();

    console.log(`[proxy] upstream request ${upstreamUrl}`);

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: {
          accept: 'application/json, text/plain, */*'
        }
      });

      const durationMs = Date.now() - startedAt;
      const contentType = upstreamResponse.headers.get('content-type') || '';
      const rawBody = await upstreamResponse.text();
      const preview = rawBody.slice(0, 500);

      console.log(`[proxy] upstream response status=${upstreamResponse.status} durationMs=${durationMs} preview=${preview}`);

      if (!upstreamResponse.ok) {
        return jsonResponse({
          error: 'Lookup unavailable',
          message: 'Upstream service did not respond successfully.',
          ...(debugMode ? {
            debug: {
              upstreamUrl,
              status: upstreamResponse.status,
              durationMs,
              responsePreview: preview
            }
          } : {})
        }, 502, allowOrigin);
      }

      let parsedPayload = null;
      try {
        parsedPayload = contentType.includes('application/json') ? JSON.parse(rawBody) : JSON.parse(rawBody);
      } catch (_parseError) {
        parsedPayload = rawBody;
      }

      const upstreamError = Array.isArray(parsedPayload)
        ? parsedPayload.find((entry) => entry && typeof entry === 'object' && entry.Error)
        : (parsedPayload && typeof parsedPayload === 'object' && parsedPayload.Error ? parsedPayload : null);

      if (upstreamError) {
        return jsonResponse({
          error: 'Lookup unavailable',
          message: String(upstreamError.Error),
          ...(debugMode ? {
            debug: {
              upstreamUrl,
              status: upstreamResponse.status,
              durationMs,
              contentType,
              responsePreview: preview
            }
          } : {})
        }, 400, allowOrigin);
      }

      const sourceItems = toItemArray(parsedPayload);
      const results = sourceItems
        .filter((item) => hasMeaningfulCompanyData(item))
        .map((item) => normalizeResultItem(item, company))
        .filter((item) => companyMatchesQuery(item.name, company))
        .filter((item) => item.state.length > 0 && item.status.length > 0);

      return jsonResponse({
        results,
        ...(debugMode ? {
          debug: {
            upstreamUrl,
            status: upstreamResponse.status,
            durationMs,
            contentType,
            sourceCount: sourceItems.length,
            resultCount: results.length,
            responsePreview: preview
          }
        } : {})
      }, 200, allowOrigin);
    } catch (error) {
      console.error('Cloudflare worker lookup error:', error);
      return jsonResponse({ error: 'Lookup unavailable', message: 'The business lookup service is unavailable right now.' }, 502, allowOrigin);
    }
  }
};
