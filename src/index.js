import { Hono } from 'hono';

const app = new Hono();

// Chain configurations mapping
const CHAIN_CONFIGS = {
	// Base Mainnet (chainId: 8453)
	'8453': {
		alchemy: {
			url: 'https://base-mainnet.g.alchemy.com/v2/',
			apiKey: (c) => c.env.ALCHEMY_API_KEY
		},
		infura: {
			url: 'https://base-mainnet.infura.io/v3/',
			apiKey: (c) => c.env.INFURA_API_KEY
		},
		graph: {
			url: (c) => c.env.GRAPH_BASE_URL,
			apiKey: (c) => c.env.GRAPH_API_KEY
		}
	},
	// Base Sepolia (chainId: 84532)
	'84532': {
		alchemy: {
			url: 'https://base-sepolia.g.alchemy.com/v2/',
			apiKey: (c) => c.env.ALCHEMY_API_KEY
		},
		infura: {
			url: 'https://base-sepolia.infura.io/v3/',
			apiKey: (c) => c.env.INFURA_API_KEY
		},
		graph: {
			url: (c) => c.env.GRAPH_BASE_SEPOLIA_URL,
			apiKey: (c) => c.env.GRAPH_API_KEY
		}
	}
};

// Helper function to get chain config
function getChainConfig(c, chainId, provider) {
	const chainConfig = CHAIN_CONFIGS[chainId];
	if (!chainConfig) {
		throw new Error(`Unsupported chain ID: ${chainId}`);
	}
	
	const providerConfig = chainConfig[provider];
	if (!providerConfig) {
		throw new Error(`Unsupported provider: ${provider} for chain ${chainId}`);
	}
	
	return {
		url: typeof providerConfig.url === 'function' ? providerConfig.url(c) : providerConfig.url,
		apiKey: typeof providerConfig.apiKey === 'function' ? providerConfig.apiKey(c) : providerConfig.apiKey
	};
}

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

// Middleware: CORS and domain validation combined
app.use(async (c, next) => {
	const origin = c.req.header('Origin');
	const referer = c.req.header('Referer');
	const allowedDomains = c.env.ALLOWED_DOMAINS;
	const allowedGatewayIPs = c.env.ALLOWED_GATEWAY_IPS;

	// Handle OPTIONS requests (CORS preflight)
	if (c.req.method === 'OPTIONS') {
		// For OPTIONS, we need to check if the origin is allowed
		let allowedOrigin = null;
		
		// Check if request is from localhost
		const isLocalhost = origin && (
			origin.includes('localhost') || 
			origin.includes('127.0.0.1') ||
			origin.startsWith('http://localhost') ||
			origin.startsWith('https://localhost')
		);

		if (isLocalhost) {
			// For localhost, check gateway IP
			const gatewayIP = c.req.header('CF-Connecting-IP') || 'unknown';
			const allowedIPs = allowedGatewayIPs ? allowedGatewayIPs.split(',').map(ip => ip.trim()) : [];
			
			if (allowedIPs.includes(gatewayIP)) {
				allowedOrigin = origin; // Allow the specific localhost origin
			}
		} else {
			// Check if origin is in allowed domains
			const allowedDomainList = allowedDomains ? allowedDomains.split(',').map(domain => domain.trim()) : [];
			if (origin && allowedDomainList.includes(origin)) {
				allowedOrigin = origin; // Allow the specific origin
			}
		}

		// Always set CORS headers for OPTIONS requests, even if origin is not allowed
		// This prevents the browser from showing "No 'Access-Control-Allow-Origin' header" error
		if (allowedOrigin) {
			c.header('Access-Control-Allow-Origin', allowedOrigin);
			c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
			c.header(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, Content-Length, X-Requested-With, chain-id'
			);
			console.log('Responding to OPTIONS request with 200 for allowed origin:', allowedOrigin);
			return c.body(null, 200);
		} else {
			// For unauthorized origins, still set CORS headers but return 200 for OPTIONS
			// The actual request will be blocked later with 403
			c.header('Access-Control-Allow-Origin', origin || '*');
			c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
			c.header(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, Content-Length, X-Requested-With, chain-id'
			);
			console.log('Responding to OPTIONS request with 200 for unauthorized origin (will block actual request):', origin);
			return c.body(null, 200);
		}
	}

	// For non-OPTIONS requests, set CORS headers and validate domain
	let allowedOrigin = null;
	
	// Check if request is from localhost
	const isLocalhost = origin && (
		origin.includes('localhost') || 
		origin.includes('127.0.0.1') ||
		origin.startsWith('http://localhost') ||
		origin.startsWith('https://localhost')
	);

	if (isLocalhost) {
		// Get the real client IP (the gateway that sent the request to Cloudflare)
		const gatewayIP = c.req.header('CF-Connecting-IP') || 'unknown';
		
		console.log(`Localhost request from gateway IP: ${gatewayIP}`);
		
		// Parse allowed gateway IPs from environment variable
		const allowedIPs = allowedGatewayIPs ? allowedGatewayIPs.split(',').map(ip => ip.trim()) : [];
		
		// Check if the gateway IP is in the allowed list
		if (allowedIPs.includes(gatewayIP)) {
			console.log(`Allowing localhost access from authorized gateway IP: ${gatewayIP}`);
			allowedOrigin = origin;
		} else {
			console.log(`Denying localhost access from unauthorized gateway IP: ${gatewayIP}`);
			// Set CORS headers even for rejected requests
			c.header('Access-Control-Allow-Origin', origin || '*');
			c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
			c.header(
				'Access-Control-Allow-Headers',
				'Content-Type, Authorization, Content-Length, X-Requested-With, chain-id'
			);
			return c.json({ error: 'Access denied: Localhost access not allowed from this gateway IP address' }, 403);
		}
	} else {
		// Parse allowed domains from environment variable
		const allowedDomainList = allowedDomains ? allowedDomains.split(',').map(domain => domain.trim()) : [];
		
		// Check if origin is in the allowed domains list
		if (origin && allowedDomainList.includes(origin)) {
			allowedOrigin = origin;
		} else {
			// Check if referer starts with any allowed domain (fallback)
			if (referer && allowedDomainList.some(domain => referer.startsWith(domain))) {
				allowedOrigin = origin || '*'; // Use origin if available, otherwise wildcard
			} else {
				// Set CORS headers even for rejected requests
				c.header('Access-Control-Allow-Origin', origin || '*');
				c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
				c.header(
					'Access-Control-Allow-Headers',
					'Content-Type, Authorization, Content-Length, X-Requested-With, chain-id'
				);
				return c.json({ error: 'Access denied: Request not from allowed domain' }, 403);
			}
		}
	}

	// Set CORS headers for the validated origin
	c.header('Access-Control-Allow-Origin', allowedOrigin);
	c.header('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
	c.header(
		'Access-Control-Allow-Headers',
		'Content-Type, Authorization, Content-Length, X-Requested-With, chain-id'
	);

	await next();
});

// Route: POST /alchemy/*
app.post('/alchemy', async (c) => {
	const chainId = c.req.header('chain-id') || '84532'; // Default to Sepolia
	const config = getChainConfig(c, chainId, 'alchemy');
	return proxyRequest(c, config.url, config.apiKey, '/alchemy');
});

// Route: POST /infura/*
app.post('/infura', async (c) => {
	const chainId = c.req.header('chain-id') || '84532'; // Default to Sepolia
	const config = getChainConfig(c, chainId, 'infura');
	return proxyRequest(c, config.url, config.apiKey, '/infura');
});

// Route: POST /graph/*
app.post('/graph', async (c) => {
	try {
		const body = await c.req.json();
		const chainId = c.req.header('chain-id') || '84532'; // Default to Sepolia
		const config = getChainConfig(c, chainId, 'graph');
		
		// Add request headers logging
		console.log('Graph request headers:', Object.fromEntries(c.req.raw.headers));
		console.log('Graph request body:', body);
		console.log('Graph URL:', config.url);

		const response = await fetch(config.url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${config.apiKey || ''}`,
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