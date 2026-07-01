// test_visit_run.mjs - ESM version
process.env.DEBUG_VISIT = 'true';
process.env.DISCORD_WEBHOOK_URL = 'https://example.com/fake-webhook';

// Mock fetch so sendToDiscord doesn't make a network call
global.fetch = async (url, opts) => {
    return { ok: true, text: async () => 'ok' };
};

// Minimal Response polyfill used by the function
global.Response = class {
    constructor(body, init = {}) {
        this._body = body;
        this.status = init.status || 200;
        this.headers = init.headers || {};
    }
    async text() {
        if (typeof this._body === 'string') return this._body;
        try {
            return JSON.stringify(this._body);
        } catch (e) {
            return String(this._body);
        }
    }
};

const mod = await import('./api/visit.js');

const req = {
    method: 'GET',
    headers: {
        host: 'dancing-cuchufli-92d20d.netlify.app',
        'user-agent': 'node-test-agent/1.0',
        'x-forwarded-for': '203.0.113.45, 70.41.3.18',
        'cf-connecting-ip': undefined,
        'x-nf-client-connection-ip': undefined
    },
    url: '/api/visit?path=/&userAgent=node-test-agent/1.0',
    body: null,
};

const context = { clientContext: { sourceIp: '198.51.100.23' } };

const res = await mod.default(req, context);
console.log('Response status:', res.status);
console.log('Response body:', await res.text());
