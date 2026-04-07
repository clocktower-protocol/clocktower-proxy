import { describe, expect, it } from 'vitest';
import {
	sanitizeUrl,
	validateChainId,
	validateHeaders,
	validateRequestBody,
	validateRequestPath,
	validateRequestSize,
} from '../src/validation.js';

function sizeCtx(contentLength) {
	return {
		req: {
			header: (name) => (name.toLowerCase() === 'content-length' ? contentLength : undefined),
		},
	};
}

describe('validateChainId', () => {
	it('rejects empty and non-string', () => {
		expect(validateChainId('').valid).toBe(false);
		expect(validateChainId(undefined).valid).toBe(false);
		expect(validateChainId(84532).valid).toBe(false);
	});

	it('rejects non-numeric characters', () => {
		expect(validateChainId('84a53').valid).toBe(false);
	});

	it('rejects unsupported numeric chain', () => {
		expect(validateChainId('42220').valid).toBe(false);
	});

	it('accepts supported chains', () => {
		for (const id of ['8453', '84532', '1']) {
			const r = validateChainId(id);
			expect(r.valid).toBe(true);
			expect(r.chainId).toBe(id);
		}
	});
});

describe('validateRequestPath', () => {
	it('allows empty path', () => {
		expect(validateRequestPath('')).toEqual({ valid: true, path: '' });
	});

	it('rejects non-string', () => {
		expect(validateRequestPath(null).valid).toBe(false);
	});

	it('rejects traversal and suspicious segments', () => {
		for (const p of ['../x', 'foo//bar', 'a\\b', '..']) {
			expect(validateRequestPath(p).valid).toBe(false);
		}
	});

	it('rejects disallowed characters', () => {
		expect(validateRequestPath('foo?bar').valid).toBe(false);
		expect(validateRequestPath('x y').valid).toBe(false);
	});

	it('allows safe paths', () => {
		expect(validateRequestPath('v2/extra').valid).toBe(true);
		expect(validateRequestPath('a-b_c/1').valid).toBe(true);
	});
});

describe('validateRequestBody', () => {
	it('rejects non-objects', () => {
		expect(validateRequestBody(null).valid).toBe(false);
		expect(validateRequestBody(undefined).valid).toBe(false);
		expect(validateRequestBody('x').valid).toBe(false);
	});

	it('rejects circular structures', () => {
		const o = {};
		o.self = o;
		expect(validateRequestBody(o).valid).toBe(false);
	});

	it('rejects oversized JSON', () => {
		const body = { pad: 'x'.repeat(2 * 1024 * 1024) };
		expect(validateRequestBody(body).valid).toBe(false);
	});

	it('rejects deep nesting', () => {
		function wrapChain(n) {
			let inner = { leaf: 1 };
			for (let i = 0; i < n; i++) {
				inner = { w: inner };
			}
			return inner;
		}
		// maxDepth 10: visiting the primitive leaf must not use depth > 10
		expect(validateRequestBody(wrapChain(9)).valid).toBe(true);
		expect(validateRequestBody(wrapChain(10)).valid).toBe(false);
	});

	it('accepts typical JSON-RPC body', () => {
		const r = validateRequestBody({ jsonrpc: '2.0', method: 'eth_chainId', id: 1 });
		expect(r.valid).toBe(true);
		expect(r.body).toEqual({ jsonrpc: '2.0', method: 'eth_chainId', id: 1 });
	});
});

describe('validateHeaders', () => {
	it('allows missing Content-Type', () => {
		const h = new Headers();
		expect(validateHeaders(h).valid).toBe(true);
	});

	it('allows application/json Content-Type', () => {
		const h = new Headers({ 'content-type': 'application/json; charset=utf-8' });
		expect(validateHeaders(h).valid).toBe(true);
	});

	it('rejects wrong Content-Type when present', () => {
		const h = new Headers({ 'content-type': 'text/plain' });
		expect(validateHeaders(h).valid).toBe(false);
	});

	it('validates chain-id when present', () => {
		const bad = new Headers({
			'content-type': 'application/json',
			'chain-id': 'evil',
		});
		expect(validateHeaders(bad).valid).toBe(false);
		const good = new Headers({
			'content-type': 'application/json',
			'chain-id': '84532',
		});
		expect(validateHeaders(good).valid).toBe(true);
	});
});

describe('sanitizeUrl', () => {
	it('accepts https URLs', () => {
		const r = sanitizeUrl('https://base-sepolia.g.alchemy.com/v2/key');
		expect(r.valid).toBe(true);
		expect(r.url).toBe('https://base-sepolia.g.alchemy.com/v2/key');
	});

	it('allows http for localhost', () => {
		const r = sanitizeUrl('http://localhost:8545/path');
		expect(r.valid).toBe(true);
	});

	it('rejects http for non-localhost', () => {
		expect(sanitizeUrl('http://example.com/x').valid).toBe(false);
	});

	it('rejects malformed URL', () => {
		expect(sanitizeUrl('not a url').valid).toBe(false);
	});
});

describe('validateRequestSize', () => {
	it('accepts when Content-Length absent', () => {
		expect(validateRequestSize(sizeCtx(undefined)).valid).toBe(true);
	});

	it('accepts when under limit', () => {
		expect(validateRequestSize(sizeCtx('1048576')).valid).toBe(true);
		expect(validateRequestSize(sizeCtx('1024')).valid).toBe(true);
	});

	it('rejects over limit and NaN', () => {
		expect(validateRequestSize(sizeCtx('1048577')).valid).toBe(false);
		expect(validateRequestSize(sizeCtx('not-a-number')).valid).toBe(false);
	});
});
