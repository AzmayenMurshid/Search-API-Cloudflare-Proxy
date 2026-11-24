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

const QUERY_GUARD_MODES = new Set(['off', 'monitor', 'enforce']);
const QUERY_MAX_LENGTH = 120;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F]/g;
const CONTROL_CHAR_TEST_PATTERN = /[\u0000-\u001F\u007F]/;
const UNSUPPORTED_QUERY_CHAR_PATTERN = /[^a-zA-Z0-9\s&'.,()\-/#]/;

const summarizeForLog = (value) => sanitizeText(value)
  .replace(CONTROL_CHAR_PATTERN, ' ')
  .replace(/\s+/g, ' ')
  .slice(0, 160);

const resolveQueryGuardMode = (env) => {
  const configuredMode = sanitizeText(env && env.QUERY_GUARD_MODE).toLowerCase();
  return QUERY_GUARD_MODES.has(configuredMode) ? configuredMode : 'monitor';
};

const normalizeIncomingQuery = (value) => sanitizeText(value)
  .replace(CONTROL_CHAR_PATTERN, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const validateIncomingQuery = (rawQuery, mode) => {
  const initialValue = sanitizeText(rawQuery);
  const normalizedValue = normalizeIncomingQuery(initialValue);
  const truncatedValue = normalizedValue.slice(0, QUERY_MAX_LENGTH);

  const hadControlChars = CONTROL_CHAR_TEST_PATTERN.test(initialValue);
  const exceededMaxLength = normalizedValue.length > QUERY_MAX_LENGTH;
  const hasUnsupportedChars = truncatedValue.length > 0 && UNSUPPORTED_QUERY_CHAR_PATTERN.test(truncatedValue);

  const reasons = [];
  if (hadControlChars) {
    reasons.push('control_chars_removed');
  }
  if (exceededMaxLength) {
    reasons.push('query_too_long');
  }
  if (hasUnsupportedChars) {
    reasons.push('unsupported_characters');
  }

  const wouldBlock = hadControlChars || exceededMaxLength || hasUnsupportedChars;
  const blocked = mode === 'enforce' && wouldBlock;

  return {
    normalizedQuery: truncatedValue,
    reasons,
    wouldBlock,
    blocked,
    logPreview: summarizeForLog(truncatedValue),
    rawPreview: summarizeForLog(initialValue),
    rawLength: initialValue.length,
    normalizedLength: truncatedValue.length
  };
};

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

  if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) {
    return true;
  }

  // Allow short prefixes such as "Haf" to match "Hafeed Inc".
  if (normalizedQuery.length >= 3) {
    const nameStartsWithQuery = normalizedName.startsWith(normalizedQuery);
    const queryStartsWithName = normalizedName.length >= 3 && normalizedQuery.startsWith(normalizedName);
    if (nameStartsWithQuery || queryStartsWithName) {
      return true;
    }
  }

  const queryTokens = extractMatchTokens(query);
  const nameTokens = extractMatchTokens(normalizedName);
  if (queryTokens.length === 0) {
    return normalizedName.includes(normalizedQuery);
  }

  return queryTokens.some((queryToken) => nameTokens.some((nameToken) => {
    if (nameToken.includes(queryToken) || queryToken.includes(nameToken)) {
      return true;
    }

    // Small edit-distance tolerance handles nearby misspellings.
    if (queryToken.length >= 4) {
      const maxDistance = queryToken.length >= 7 ? 2 : 1;
      let previousRow = Array.from({ length: nameToken.length + 1 }, (_, index) => index);

      for (let i = 1; i <= queryToken.length; i += 1) {
        const currentRow = [i];
        for (let j = 1; j <= nameToken.length; j += 1) {
          const insertCost = currentRow[j - 1] + 1;
          const deleteCost = previousRow[j] + 1;
          const substituteCost = previousRow[j - 1] + (queryToken[i - 1] === nameToken[j - 1] ? 0 : 1);
          currentRow[j] = Math.min(insertCost, deleteCost, substituteCost);
        }
        previousRow = currentRow;
      }

      return previousRow[nameToken.length] <= maxDistance;
    }

    return false;
  }));
};

const extractCompanyName = (searchParams) => {
  const rawQuery = sanitizeText(searchParams.get('query'));
  const explicitCompany = sanitizeText(searchParams.get('company'));

  return explicitCompany || rawQuery;
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
      status: ''
    };
  }

  const name = item.name || item.company || item.company_name || item.business_name || item.legal_name || fallbackCompany || 'Unknown Business';
  const status = sanitizeText(item.status || item.is_the_active_or_dissolved_).toUpperCase();

  return {
    id: item.id || item.business_id || item.file_number || name,
    name,
    status
  };
};

const buildUpstreamUrl = (company) => {
  const upstream = new URL('https://api.openbrewerydb.org/v1/breweries');
  upstream.searchParams.set('company', company);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const allowOrigin = env.ALLOWED_ORIGIN || '*';
    const queryGuardMode = resolveQueryGuardMode(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: buildCorsHeaders(allowOrigin)
      });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ 
        ok: true, 
        service: 'yanko-business-search-proxy' 
      }, 200, allowOrigin);
    }

    if (url.pathname !== '/api/business-search') {
      return jsonResponse({ error: 'Not found' }, 404, allowOrigin);
    }

    const company = extractCompanyName(url.searchParams);
    const queryValidation = validateIncomingQuery(company, queryGuardMode);

    if (queryValidation.reasons.length > 0) {
      console.warn('[query-guard] input adjusted or flagged', {
        mode: queryGuardMode,
        wouldBlock: queryValidation.wouldBlock,
        blocked: queryValidation.blocked,
        reasons: queryValidation.reasons,
        rawLength: queryValidation.rawLength,
        normalizedLength: queryValidation.normalizedLength,
        rawPreview: queryValidation.rawPreview,
        normalizedPreview: queryValidation.logPreview
      });
    }

    if (queryValidation.blocked) {
      return jsonResponse({
        error: 'Invalid query',
        message: 'Search query was blocked by input validation. Remove special characters and shorten the query to 120 characters or less.',
        code: 'QUERY_VALIDATION_FAILED',
        details: queryValidation.reasons
      }, 400, allowOrigin);
    }

    const validatedCompany = queryValidation.normalizedQuery;
    if (!validatedCompany || validatedCompany.length < 3) {
      return jsonResponse({ 
        error: 'Query too short', 
        message: 'Provide at least 3 characters.' 
      }, 400, allowOrigin);
    }

    const debugMode = url.searchParams.get('debug') === '1';
    const upstreamUrl = buildUpstreamUrl(validatedCompany);
    const startedAt = Date.now();

    console.log(`[proxy] upstream request company=${validatedCompany}`);

    try {
      const upstreamResult = await fetchUpstreamPayload(upstreamUrl);
      const durationMs = Date.now() - startedAt;

      if (!upstreamResult.ok) {
        return jsonResponse({
          error: 'Lookup unavailable',
          message: 'Upstream service did not respond successfully.',
          ...(debugMode ? {
            debug: {
              upstreamUrl,
              status: upstreamResult.status,
              durationMs,
              responsePreview: upstreamResult.rawBody.slice(0, 500)
            }
          } : {})
        }, 502, allowOrigin);
      }

      const payload = upstreamResult.parsedPayload;
      const upstreamError = Array.isArray(payload)
        ? payload.find((entry) => entry && typeof entry === 'object' && entry.Error)
        : (payload && typeof payload === 'object' && payload.Error ? payload : null);

      if (upstreamError) {
        return jsonResponse({
          error: 'Lookup unavailable',
          message: 'Upstream service returned an error.',
          ...(debugMode ? {
            debug: {
              upstreamUrl,
              status: 502,
              durationMs,
              responsePreview: upstreamResult.rawBody.slice(0, 500)
            }
          } : {})
        }, 502, allowOrigin);
      }

      const sourceItems = toItemArray(payload);
      const dedupeMap = new Map();
      const normalized = sourceItems
        .filter((item) => hasMeaningfulCompanyData(item))
        .map((item) => normalizeResultItem(item, validatedCompany))
        .filter((item) => companyMatchesQuery(item.name, validatedCompany));

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
            upstreamUrl,
            status: 200,
            durationMs,
            contentType: 'application/json; charset=utf-8',
            sourceCount: sourceItems.length,
            resultCount: results.length
          }
        } : {})
      }, 200, allowOrigin);
    } catch (error) {
      console.error('Cloudflare worker lookup error:', error);
      return jsonResponse({ 
        error: 'Lookup unavailable', 
        message: 'The business lookup service is unavailable right now.' 
      }, 502, allowOrigin);
    }
  }
};
