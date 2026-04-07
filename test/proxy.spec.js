import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';

const TRUSTED = 'https://trusted.example';

function rpcBody() {
	return JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', id: 1 });
}

/** @param {string} path */
function url(path) {
	return `http://example.com${path}`;
}

/**
 * @param {string} pathname
 * @param {RequestInit & { headers?: Record<string, string>; defaultOrigin?: boolean }} [init]
 */
async function fetchWorker(pathname, init = {}) {
	const ctx = createExecutionContext();
	const hdr = {
		...(init.defaultOrigin === false ? {} : { Origin: TRUSTED }),
		'Content-Type': 'application/json',
		...init.headers,
	};
	const headers = new Headers(hdr);
	const req = new Request(url(pathname), {
		method: init.method ?? 'POST',
		headers,
		body: init.body !== undefined ? init.body : rpcBody(),
	});
	const res = await worker.fetch(req, env, ctx);
	await waitOnExecutionContext(ctx);
	return res;
}

describe('HTTP proxy and security', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		globalThis.fetch = vi.fn(async () =>
			Response.json({ jsonrpc: '2.0', result: '0x14a34', id: 1 }),
		);
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe('access control', () => {
		it('allows Origin in ALLOWED_DOMAINS', async () => {
			const res = await fetchWorker('/alchemy');
			expect(res.status).toBe(200);
			const json = await res.json();
			expect(json.result).toBe('0x14a34');
		});

		it('allows Referer fallback when Origin is absent', async () => {
			const res = await fetchWorker('/alchemy', {
				defaultOrigin: false,
				headers: {
					Referer: 'https://trusted.example/app',
					'Content-Type': 'application/json',
				},
			});
			expect(res.status).toBe(200);
		});

		it('returns 403 when Origin and Referer are not allowed', async () => {
			const res = await fetchWorker('/alchemy', {
				headers: {
					Origin: 'https://evil.example',
					'Content-Type': 'application/json',
				},
			});
			expect(res.status).toBe(403);
			const j = await res.json();
			expect(j.error).toContain('allowed domain');
		});

		it('returns 403 for localhost Origin when CF-Connecting-IP is not allowlisted', async () => {
			const res = await fetchWorker('/alchemy', {
				headers: {
					Origin: 'http://localhost:5173',
					'CF-Connecting-IP': '203.0.113.50',
					'Content-Type': 'application/json',
				},
			});
			expect(res.status).toBe(403);
			const j = await res.json();
			expect(j.error).toContain('gateway IP');
		});

		it('allows localhost Origin when CF-Connecting-IP is allowlisted', async () => {
			const res = await fetchWorker('/alchemy', {
				headers: {
					Origin: 'http://localhost:5173',
					'CF-Connecting-IP': '10.0.0.1',
					'Content-Type': 'application/json',
				},
			});
			expect(res.status).toBe(200);
		});

		it('handles OPTIONS preflight with CORS headers', async () => {
			const ctx = createExecutionContext();
			const req = new Request(url('/alchemy'), {
				method: 'OPTIONS',
				headers: { Origin: TRUSTED, 'Access-Control-Request-Method': 'POST' },
			});
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
			expect(res.headers.get('Access-Control-Allow-Origin')).toBe(TRUSTED);
		});
	});

	describe('request size', () => {
		it('returns 413 when Content-Length exceeds 1MB', async () => {
			const res = await fetchWorker('/alchemy', {
				headers: {
					'Content-Length': String(2 * 1024 * 1024),
					Origin: TRUSTED,
					'Content-Type': 'application/json',
				},
			});
			expect(res.status).toBe(413);
		});

		it('does not apply size limit to OPTIONS', async () => {
			const ctx = createExecutionContext();
			const req = new Request(url('/alchemy'), {
				method: 'OPTIONS',
				headers: {
					Origin: TRUSTED,
					'Content-Length': String(2 * 1024 * 1024),
				},
			});
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(200);
		});
	});

	describe('POST /alchemy', () => {
		it('returns 400 on invalid JSON body', async () => {
			const res = await fetchWorker('/alchemy', { body: 'not-json' });
			expect(res.status).toBe(400);
			const j = await res.json();
			expect(j.error).toContain('Invalid JSON');
		});

		it('returns 400 on invalid chain-id', async () => {
			const res = await fetchWorker('/alchemy', {
				headers: { 'chain-id': '99999', Origin: TRUSTED, 'Content-Type': 'application/json' },
			});
			expect(res.status).toBe(400);
		});

		it('defaults to chain 84532 and calls Base Sepolia Alchemy URL', async () => {
			await fetchWorker('/alchemy');
			expect(globalThis.fetch).toHaveBeenCalled();
			const call = vi.mocked(globalThis.fetch).mock.calls[0];
			const target = String(call[0]);
			expect(target).toContain('base-sepolia.g.alchemy.com');
			expect(target).toContain(env.ALCHEMY_API_KEY);
			expect(call[1].method).toBe('POST');
			expect(JSON.parse(call[1].body)).toMatchObject({ jsonrpc: '2.0', method: 'eth_chainId' });
		});

		it('returns 400 when Content-Type is not JSON', async () => {
			const res = await fetchWorker('/alchemy', {
				headers: { 'Content-Type': 'text/plain', Origin: TRUSTED },
			});
			expect(res.status).toBe(400);
		});

		it('returns error when upstream returns non-JSON', async () => {
			vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response('not json', { status: 200 }));
			const res = await fetchWorker('/alchemy');
			expect(res.status).toBe(200);
			const j = await res.json();
			expect(j.error).toContain('invalid JSON');
		});

		it('proxies upstream API error status and details', async () => {
			vi.mocked(globalThis.fetch).mockResolvedValueOnce(
				new Response(JSON.stringify({ reason: 'bad' }), {
					status: 502,
					headers: { 'Content-Type': 'application/json' },
				}),
			);
			const res = await fetchWorker('/alchemy');
			expect(res.status).toBe(502);
			const j = await res.json();
			expect(j.error).toContain('alchemy API error');
			expect(j.details.reason).toBe('bad');
		});

		it('returns 408 when fetch aborts', async () => {
			vi.mocked(globalThis.fetch).mockRejectedValueOnce(
				Object.assign(new Error('aborted'), { name: 'AbortError' }),
			);
			const res = await fetchWorker('/alchemy');
			expect(res.status).toBe(408);
		});
	});

	describe('POST /infura', () => {
		it('calls Base Sepolia Infura URL with test key', async () => {
			await fetchWorker('/infura');
			const call = vi.mocked(globalThis.fetch).mock.calls[0];
			const target = String(call[0]);
			expect(target).toContain('base-sepolia.infura.io');
			expect(target).toContain(env.INFURA_API_KEY);
		});
	});

	describe('POST /graph', () => {
		it('sends Bearer token and POSTs to graph URL', async () => {
			await fetchWorker('/graph');
			const call = vi.mocked(globalThis.fetch).mock.calls[0];
			const init = call[1];
			expect(String(call[0])).toContain(new URL(env.GRAPH_BASE_SEPOLIA_URL).hostname);
			const h = init.headers;
			const auth = typeof h.get === 'function' ? h.get('Authorization') : h.Authorization;
			expect(auth).toBe(`Bearer ${env.GRAPH_API_KEY}`);
			expect(init.method).toBe('POST');
		});

		it('returns 400 on invalid JSON before proxy', async () => {
			const res = await fetchWorker('/graph', { body: '{' });
			expect(res.status).toBe(400);
		});
	});

	describe('routing', () => {
		it('returns 404 JSON for unknown path', async () => {
			const ctx = createExecutionContext();
			const req = new Request(url('/nope'), {
				method: 'GET',
				headers: { Origin: TRUSTED },
			});
			const res = await worker.fetch(req, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(res.status).toBe(404);
			const j = await res.json();
			expect(j.error).toBe('Not Found');
		});
	});
});
