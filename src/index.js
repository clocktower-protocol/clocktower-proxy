import { Hono } from 'hono';

const app = new Hono();

// Helper: Proxy request to a provider (Alchemy or Infura)
async function proxyRequest(c, baseUrl, apiKey, prefix) {
	try {
	  const body = await c.req.json();
	  const path = c.req.path.replace(prefix, '');
	  const url = `${baseUrl}${apiKey}${path}`;
  
	  console.log(`Request path for ${prefix}:`, path);
	  console.log(`URL for ${prefix}:`, url);
  
	  const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	  });
  
	  // Log response details
	  console.log(`${prefix} Response status:`, response.status);
	  console.log(`${prefix} Response headers:`, Object.fromEntries(response.headers));
  
	  // Try to parse response body
	  let data;
	  const contentType = response.headers.get('Content-Type') || '';
	  try {
		data = await response.text(); // Get raw text first
		console.log(`${prefix} Raw response:`, data);
		data = JSON.parse(data); // Try parsing as JSON
	  } catch (error) {
		console.error(`${prefix} JSON parsing error:`, error);
		return c.json(
		  { error: `${prefix} API returned invalid JSON`, details: data },
		  response.status || 500
		);
	  }
  
	  if (!response.ok) {
		console.log(`${prefix} API error response:`, data);
		return c.json({ error: `${prefix} API error`, details: data }, response.status);
	  }
  
	  return c.json(data, 200);
	} catch (error) {
	  console.error(`${prefix} Proxy error:`, error);
	  return c.json({ error: error.message || 'Internal Server Error' }, 500);
	}
  }

// Middleware: CORS and OPTIONS handling
app.use(async (c, next) => {
	// Set CORS headers for all responses
	c.header('Access-Control-Allow-Origin', '*');
	c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
	c.header(
	  'Access-Control-Allow-Headers',
	  'Content-Type, Authorization, Content-Length, X-Requested-With, chain-id'
	);
  
	// Handle OPTIONS requests
	if (c.req.method === 'OPTIONS') {
		console.log('Responding to OPTIONS request with 200');
		return c.body(null, 200); 
	}
  
	await next();
});

// Middleware: Restrict to allowed domains
app.use(async (c, next) => {
  const origin = c.req.header('Origin');
  const referer = c.req.header('Referer');
  const allowedDomain = c.env.ALLOWED_DOMAIN;
  const allowedDomain2 = c.env.ALLOWED_DOMAIN2;

  // Skip domain check for OPTIONS requests to allow CORS preflight
  if (c.req.method === 'OPTIONS') {
	console.log('Responding to OPTIONS request with 200');
    return next();
  }

  if (origin && (origin === allowedDomain || origin === allowedDomain2)) {
    return next(); // Proceed to next middleware or handler
  }
  if (referer && referer.startsWith(allowedDomain2)) {
    return next();
  }

  return c.json({ error: 'Access denied: Request not from allowed domain' }, 403);
});

// Route: POST /alchemy/*
app.post('/alchemy', async (c) => {
	return proxyRequest(c, c.env.ALCHEMY_BASE_SEPOLIA_URL, c.env.ALCHEMY_API_KEY, '/alchemy');
});
  
// Route: POST /infura/*
app.post('/infura', async (c) => {
	return proxyRequest(c, c.env.INFURA_BASE_SEPOLIA_URL, c.env.INFURA_API_KEY, '/infura');
});

// Route: POST /graph/*
app.post('/graph', async (c) => {
  try {
    const body = await c.req.json();

    //checks if the chain-id is 8453, if it is, use the mainnet graph url, if it is not, use the sepolia graph url
    const chainId = c.req.header('chain-id');
    const url = chainId === '8453' ? c.env.GRAPH_BASE_URL : c.env.GRAPH_BASE_SEPOLIA_URL;
    
    // Add request headers logging
    console.log('Graph request headers:', Object.fromEntries(c.req.raw.headers));
    console.log('Graph request body:', body);
    console.log('Graph URL:', url);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${c.env.GRAPH_API_KEY || ''}`,
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // Log response details
    console.log('Graph Response status:', response.status);
    console.log('Graph Response headers:', Object.fromEntries(response.headers));

    // Try to parse response body
    let data;
    try {
      data = await response.text();
      console.log('Graph Raw response:', data);
      data = JSON.parse(data);
    } catch (error) {
      console.error('Graph JSON parsing error:', error);
      return c.json(
        { error: 'Graph API returned invalid JSON', details: data },
        response.status || 500
      );
    }

    if (!response.ok) {
      console.log('Graph API error response:', data);
      return c.json({ error: 'Graph API error', details: data }, response.status);
    }

    return c.json(data, 200);
  } catch (error) {
    console.error('Graph Proxy error:', error);
    return c.json({ error: error.message || 'Internal Server Error' }, 500);
  }
});

// Handle 404 for unmatched routes
app.notFound((c) => {
  return c.json({ error: 'Not Found' }, 404);
});

export default app;