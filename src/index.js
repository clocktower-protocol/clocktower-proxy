import { Hono } from 'hono';

const app = new Hono();

// Enhanced size validation
function validateRequestSize(c) {
	const contentLength = c.req.header('content-length');
	const maxSize = 1024 * 1024; // 1MB
	
	if (contentLength) {
		const size = parseInt(contentLength, 10);
		if (isNaN(size) || size > maxSize) {
			return { valid: false, error: `Request too large. Maximum size: ${maxSize / (1024 * 1024)}MB` };
		}
	}
	
	return { valid: true };
}

// Input validation functions
function validateChainId(chainId) {
	if (!chainId || typeof chainId !== 'string') {
		return { valid: false, error: 'Chain ID must be a non-empty string' };
	}
	
	// Only allow numeric chain IDs
	if (!/^\d+$/.test(chainId)) {
		return { valid: false, error: 'Chain ID must contain only digits' };
	}
	
	// Check if chain ID is supported
	const supportedChainIds = ['8453', '84532'];
	if (!supportedChainIds.includes(chainId)) {
		return { valid: false, error: `Unsupported chain ID: ${chainId}. Supported: ${supportedChainIds.join(', ')}` };
	}
	
	return { valid: true, chainId };
}

function validateRequestPath(path) {
	if (typeof path !== 'string') {
		return { valid: false, error: 'Path must be a string' };
	}
	
	// Allow empty paths for base endpoints
	if (path === '') {
		return { valid: true, path: '' };
	}
	
	// Prevent path traversal attacks
	if (path.includes('..') || path.includes('//') || path.includes('\\')) {
		return { valid: false, error: 'Invalid path: contains path traversal characters' };
	}
	
	// Only allow alphanumeric, hyphens, underscores, and forward slashes
	if (!/^[a-zA-Z0-9\/\-_]+$/.test(path)) {
		return { valid: false, error: 'Invalid path: contains disallowed characters' };
	}
	
	return { valid: true, path };
}

function validateRequestBody(body) {
	if (!body || typeof body !== 'object') {
		return { valid: false, error: 'Request body must be a valid JSON object' };
	}
	
	// Check for circular references
	try {
		JSON.stringify(body);
	} catch (error) {
		return { valid: false, error: 'Request body contains circular references or invalid JSON' };
	}
	
	// Enhanced size limit with better estimation
	const bodyString = JSON.stringify(body);
	const sizeInBytes = new TextEncoder().encode(bodyString).length;
	const maxSize = 1024 * 1024; // 1MB
	
	if (sizeInBytes > maxSize) {
		return { 
			valid: false, 
			error: `Request body too large (${Math.round(sizeInBytes / 1024)}KB). Maximum size: ${maxSize / (1024 * 1024)}MB` 
		};
	}
	
	// Check for deeply nested objects (prevent DoS)
	const maxDepth = 10;
	function checkDepth(obj, depth = 0) {
		if (depth > maxDepth) {
			return false;
		}
		if (typeof obj === 'object' && obj !== null) {
			for (const key in obj) {
				if (!checkDepth(obj[key], depth + 1)) {
					return false;
				}
			}
		}
		return true;
	}
	
	if (!checkDepth(body)) {
		return { valid: false, error: 'Request body too deeply nested (max 10 levels)' };
	}
	
	return { valid: true, body };
}

function validateHeaders(headers) {
	const validation = { valid: true, errors: [] };
	
	// Validate Content-Type
	const contentType = headers.get('content-type');
	if (contentType && !contentType.includes('application/json')) {
		validation.errors.push('Content-Type must be application/json');
		validation.valid = false;
	}
	
	// Validate chain-id header if present
	const chainId = headers.get('chain-id');
	if (chainId) {
		const chainValidation = validateChainId(chainId);
		if (!chainValidation.valid) {
			validation.errors.push(`Invalid chain-id header: ${chainValidation.error}`);
			validation.valid = false;
		}
	}
	
	return validation;
}

function sanitizeUrl(url) {
	// Basic URL validation and sanitization
	try {
		const urlObj = new URL(url);
		// Only allow HTTPS URLs (except for localhost development)
		if (urlObj.protocol !== 'https:' && !urlObj.hostname.includes('localhost')) {
			return { valid: false, error: 'Only HTTPS URLs are allowed (except localhost)' };
		}
		return { valid: true, url: urlObj.toString() };
	} catch (error) {
		return { valid: false, error: 'Invalid URL format' };
	}
}

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

// Helper: Proxy request to a provider (Alchemy or Infura) with validation
async function proxyRequest(c, baseUrl, apiKey, prefix) {
	try {
		// Validate request body
		let body;
		try {
			body = await c.req.json();
		} catch (error) {
			return c.json({ error: 'Invalid JSON in request body' }, 400);
		}
		
		const bodyValidation = validateRequestBody(body);
		if (!bodyValidation.valid) {
			return c.json({ error: bodyValidation.error }, 400);
		}
		
		// Validate and sanitize path
		const path = c.req.path.replace(prefix, '');
		const pathValidation = validateRequestPath(path);
		if (!pathValidation.valid) {
			return c.json({ error: pathValidation.error }, 400);
		}
		
		// Validate and sanitize URL
		const url = `${baseUrl}${apiKey}${path}`;
		const urlValidation = sanitizeUrl(url);
		if (!urlValidation.valid) {
			return c.json({ error: urlValidation.error }, 400);
		}
		
		// Validate headers
		const headerValidation = validateHeaders(c.req.raw.headers);
		if (!headerValidation.valid) {
			return c.json({ error: `Header validation failed: ${headerValidation.errors.join(', ')}` }, 400);
		}

		console.log(`Request path for ${prefix}:`, path);
		console.log(`URL for ${prefix}:`, urlValidation.url);

		// Add timeout to fetch request
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
		
		try {
			const response = await fetch(urlValidation.url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(bodyValidation.body),
				signal: controller.signal
			});
			
			clearTimeout(timeoutId);
			
			// Log response details (without sensitive data)
			console.log(`${prefix} Response status:`, response.status);

			// Try to parse response body
			let data;
			try {
				data = await response.text();
				data = JSON.parse(data);
			} catch (error) {
				console.error(`${prefix} JSON parsing error:`, error);
				return c.json(
					{ error: `${prefix} API returned invalid JSON` },
					response.status || 500
				);
			}

			if (!response.ok) {
				console.log(`${prefix} API error response:`, data);
				return c.json({ error: `${prefix} API error`, details: data }, response.status);
			}

			return c.json(data, 200);
		} catch (error) {
			clearTimeout(timeoutId);
			if (error.name === 'AbortError') {
				return c.json({ error: 'Request timeout' }, 408);
			}
			throw error;
		}
	} catch (error) {
		console.error(`${prefix} Proxy error:`, error);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
}

// Request size validation middleware
app.use(async (c, next) => {
	// Skip size validation for OPTIONS requests
	if (c.req.method === 'OPTIONS') {
		return next();
	}
	
	const sizeValidation = validateRequestSize(c);
	if (!sizeValidation.valid) {
		return c.json({ error: sizeValidation.error }, 413); // Payload Too Large
	}
	
	await next();
});

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

// Route: POST /alchemy/* with validation
app.post('/alchemy', async (c) => {
	try {
		// Validate chain-id header
		const chainId = c.req.header('chain-id') || '84532';
		const chainValidation = validateChainId(chainId);
		if (!chainValidation.valid) {
			return c.json({ error: chainValidation.error }, 400);
		}
		
		const config = getChainConfig(c, chainValidation.chainId, 'alchemy');
		return proxyRequest(c, config.url, config.apiKey, '/alchemy');
	} catch (error) {
		console.error('Alchemy route error:', error);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// Route: POST /infura/* with validation
app.post('/infura', async (c) => {
	try {
		// Validate chain-id header
		const chainId = c.req.header('chain-id') || '84532';
		const chainValidation = validateChainId(chainId);
		if (!chainValidation.valid) {
			return c.json({ error: chainValidation.error }, 400);
		}
		
		const config = getChainConfig(c, chainValidation.chainId, 'infura');
		return proxyRequest(c, config.url, config.apiKey, '/infura');
	} catch (error) {
		console.error('Infura route error:', error);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// Route: POST /graph/* with validation
app.post('/graph', async (c) => {
	try {
		// Validate request body
		let body;
		try {
			body = await c.req.json();
		} catch (error) {
			return c.json({ error: 'Invalid JSON in request body' }, 400);
		}
		
		const bodyValidation = validateRequestBody(body);
		if (!bodyValidation.valid) {
			return c.json({ error: bodyValidation.error }, 400);
		}
		
		// Validate chain-id header
		const chainId = c.req.header('chain-id') || '84532';
		const chainValidation = validateChainId(chainId);
		if (!chainValidation.valid) {
			return c.json({ error: chainValidation.error }, 400);
		}
		
		const config = getChainConfig(c, chainValidation.chainId, 'graph');
		
		// Validate and sanitize Graph URL
		const urlValidation = sanitizeUrl(config.url);
		if (!urlValidation.valid) {
			return c.json({ error: urlValidation.error }, 400);
		}
		
		// Validate headers
		const headerValidation = validateHeaders(c.req.raw.headers);
		if (!headerValidation.valid) {
			return c.json({ error: `Header validation failed: ${headerValidation.errors.join(', ')}` }, 400);
		}

		console.log('Graph URL:', urlValidation.url);

		// Add timeout to fetch request
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout
		
		try {
			const response = await fetch(urlValidation.url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${config.apiKey || ''}`,
					'Accept': 'application/json',
				},
				body: JSON.stringify(bodyValidation.body),
				signal: controller.signal
			});
			
			clearTimeout(timeoutId);
			
			// Log response details (without sensitive data)
			console.log('Graph Response status:', response.status);

			// Try to parse response body
			let data;
			try {
				data = await response.text();
				data = JSON.parse(data);
			} catch (error) {
				console.error('Graph JSON parsing error:', error);
				return c.json(
					{ error: 'Graph API returned invalid JSON' },
					response.status || 500
				);
			}

			if (!response.ok) {
				console.log('Graph API error response:', data);
				return c.json({ error: 'Graph API error', details: data }, response.status);
			}

			return c.json(data, 200);
		} catch (error) {
			clearTimeout(timeoutId);
			if (error.name === 'AbortError') {
				return c.json({ error: 'Request timeout' }, 408);
			}
			throw error;
		}
	} catch (error) {
		console.error('Graph Proxy error:', error);
		return c.json({ error: 'Internal Server Error' }, 500);
	}
});

// Handle 404 for unmatched routes
app.notFound((c) => {
	return c.json({ error: 'Not Found' }, 404);
});

export default app;