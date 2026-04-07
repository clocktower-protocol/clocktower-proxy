// Enhanced size validation
export function validateRequestSize(c) {
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

export function validateChainId(chainId) {
	if (!chainId || typeof chainId !== 'string') {
		return { valid: false, error: 'Chain ID must be a non-empty string' };
	}

	if (!/^\d+$/.test(chainId)) {
		return { valid: false, error: 'Chain ID must contain only digits' };
	}

	const supportedChainIds = ['8453', '84532', '1'];
	if (!supportedChainIds.includes(chainId)) {
		return { valid: false, error: `Unsupported chain ID: ${chainId}. Supported: ${supportedChainIds.join(', ')}` };
	}

	return { valid: true, chainId };
}

export function validateRequestPath(path) {
	if (typeof path !== 'string') {
		return { valid: false, error: 'Path must be a string' };
	}

	if (path === '') {
		return { valid: true, path: '' };
	}

	if (path.includes('..') || path.includes('//') || path.includes('\\')) {
		return { valid: false, error: 'Invalid path: contains path traversal characters' };
	}

	if (!/^[a-zA-Z0-9\/\-_]+$/.test(path)) {
		return { valid: false, error: 'Invalid path: contains disallowed characters' };
	}

	return { valid: true, path };
}

export function validateRequestBody(body) {
	if (!body || typeof body !== 'object') {
		return { valid: false, error: 'Request body must be a valid JSON object' };
	}

	try {
		JSON.stringify(body);
	} catch (_error) {
		return { valid: false, error: 'Request body contains circular references or invalid JSON' };
	}

	const bodyString = JSON.stringify(body);
	const sizeInBytes = new TextEncoder().encode(bodyString).length;
	const maxSize = 1024 * 1024; // 1MB

	if (sizeInBytes > maxSize) {
		return {
			valid: false,
			error: `Request body too large (${Math.round(sizeInBytes / 1024)}KB). Maximum size: ${maxSize / (1024 * 1024)}MB`,
		};
	}

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

export function validateHeaders(headers) {
	const validation = { valid: true, errors: [] };

	const contentType = headers.get('content-type');
	if (contentType && !contentType.includes('application/json')) {
		validation.errors.push('Content-Type must be application/json');
		validation.valid = false;
	}

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

export function sanitizeUrl(url) {
	try {
		const urlObj = new URL(url);
		if (urlObj.protocol !== 'https:' && !urlObj.hostname.includes('localhost')) {
			return { valid: false, error: 'Only HTTPS URLs are allowed (except localhost)' };
		}
		return { valid: true, url: urlObj.toString() };
	} catch (_error) {
		return { valid: false, error: 'Invalid URL format' };
	}
}
