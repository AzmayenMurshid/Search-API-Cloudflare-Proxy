const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  }
});

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'yanko-business-search-proxy' });
    }

    if (url.pathname !== '/api/business-search') {
      return jsonResponse({ error: 'Not found' }, 404);
    }

    const query = (url.searchParams.get('query') || '').trim();
    if (!query || query.length < 3) {
      return jsonResponse({ error: 'Query too short', message: 'Provide at least 3 characters.' }, 400);
    }

    const upstreamUrl = `https://api.openbrewerydb.org/v1/breweries?by_name=${encodeURIComponent(query)}&per_page=8`;

    try {
      const upstreamResponse = await fetch(upstreamUrl, {
        headers: {
          accept: 'application/json'
        }
      });

      if (!upstreamResponse.ok) {
        return jsonResponse({ error: 'Lookup unavailable', message: 'Upstream service did not respond successfully.' }, 502);
      }

      const breweries = await upstreamResponse.json();
      const results = (Array.isArray(breweries) ? breweries : []).map((item) => {
        const city = item.city || '';
        const state = item.state || item.state_province || '';
        const street = item.street || item.address_1 || '';
        const industry = item.brewery_type || 'Business';

        return {
          id: item.id || item.name,
          name: item.name || 'Unknown Business',
          address: [street, city, state].filter(Boolean).join(', '),
          industry,
          phone: item.phone || '',
          category: industry,
          city,
          state,
          status: 'Active',
          rating: '-',
          icon: 'fa-beer-mug-empty',
          description: `${industry} listing from OpenBreweryDB.`
        };
      });

      return jsonResponse({ results });
    } catch (error) {
      console.error('Cloudflare worker lookup error:', error);
      return jsonResponse({ error: 'Lookup unavailable', message: 'The business lookup service is unavailable right now.' }, 502);
    }
  }
};
