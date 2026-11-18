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

const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'DC'
];

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

const buildUpstreamUrl = (company, stateCode) => {
  const upstream = new URL('https://sbaexit.com/search_company23.php');
  upstream.searchParams.set('company', company);
  upstream.searchParams.set('state', stateCode);
  return upstream.toString();
};

const fetchUpstreamPayload = async (upstreamUrl) => {
  try {
    const response = await fetch(upstreamUrl, {
      headers: {
        accept: 'application/json, text/plain, */*'
      }
    });

    const contentType = response.headers.get('content-type') || '';
    const rawBody = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        contentType,
        rawBody,
        parsedPayload: null
      };
    }

    let parsedPayload = null;
    try {
      parsedPayload = contentType.includes('application/json') ? JSON.parse(rawBody) : JSON.parse(rawBody);
    } catch (_parseError) {
      parsedPayload = rawBody;
    }

    return {
      ok: true,
      status: response.status,
      contentType,
      rawBody,
      parsedPayload
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: '',
      rawBody: sanitizeText(error && error.message),
      parsedPayload: null
    };
  }
};

const collectSearchTargets = (state) => {
  if (state) {
    return [state];
  }

  return US_STATE_CODES;
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

    const debugMode = url.searchParams.get('debug') === '1';
    const searchTargets = collectSearchTargets(state);
    const upstreamUrls = searchTargets.map((stateCode) => buildUpstreamUrl(company, stateCode));
    const startedAt = Date.now();

    console.log(`[proxy] upstream request count=${upstreamUrls.length} company=${company}`);

    try {
      const upstreamResults = await Promise.all(upstreamUrls.map((upstreamUrl) => fetchUpstreamPayload(upstreamUrl)));
      const durationMs = Date.now() - startedAt;

      const failedResponses = upstreamResults.filter((result) => !result.ok);
      const successfulResponses = upstreamResults.filter((result) => result.ok);
      const debugPreviews = upstreamResults.map((result, index) => ({
        state: searchTargets[index],
        status: result.status,
        responsePreview: result.rawBody.slice(0, 200)
      }));

      if (successfulResponses.length === 0) {
        const firstFailed = failedResponses[0];
        return jsonResponse({
          error: 'Lookup unavailable',
          message: 'Upstream service did not respond successfully.',
          ...(debugMode ? {
            debug: {
              upstreamUrls,
              status: firstFailed ? firstFailed.status : 502,
              durationMs,
              responsePreview: firstFailed ? firstFailed.rawBody.slice(0, 500) : '',
              failedCount: failedResponses.length,
              upstreamSamples: debugPreviews
            }
          } : {})
        }, 502, allowOrigin);
      }

      const allSourceItems = successfulResponses.flatMap((result) => {
        const payload = result.parsedPayload;
        const upstreamError = Array.isArray(payload)
          ? payload.find((entry) => entry && typeof entry === 'object' && entry.Error)
          : (payload && typeof payload === 'object' && payload.Error ? payload : null);

        if (upstreamError) {
          return [];
        }

        return toItemArray(payload);
      });

      const sourceItems = allSourceItems;
      const dedupeMap = new Map();
      const normalized = sourceItems
        .filter((item) => hasMeaningfulCompanyData(item))
        .map((item) => normalizeResultItem(item, company))
        .filter((item) => companyMatchesQuery(item.name, company))
        .filter((item) => item.state.length > 0 && item.status.length > 0);

      normalized.forEach((item) => {
        const key = `${item.name}::${item.state}::${item.status}`.toUpperCase();
        if (!dedupeMap.has(key)) {
          dedupeMap.set(key, item);
        }
      });

      const results = Array.from(dedupeMap.values());

      return jsonResponse({
        results,
        ...(debugMode ? {
          debug: {
            upstreamUrls,
            status: 200,
            durationMs,
            contentType: 'application/json; charset=utf-8',
            sourceCount: sourceItems.length,
            resultCount: results.length,
            failedCount: failedResponses.length,
            upstreamSamples: debugPreviews.slice(0, 8)
          }
        } : {})
      }, 200, allowOrigin);
    } catch (error) {
      console.error('Cloudflare worker lookup error:', error);
      return jsonResponse({ error: 'Lookup unavailable', message: 'The business lookup service is unavailable right now.' }, 502, allowOrigin);
    }
  }
};
