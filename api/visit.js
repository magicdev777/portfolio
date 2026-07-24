const { sendToDiscord } = require("./discord.js");

function getHeaderValue(req, headerName) {
    if (!req || !req.headers) return undefined;

    if (typeof req.headers.get === "function") {
        let val = req.headers.get(headerName);
        if (val) return val;
        val = req.headers.get(headerName.toLowerCase());
        if (val) return val;
    }

    const candidates = [headerName, headerName.toLowerCase(), headerName.toUpperCase()];
    for (const key of candidates) {
        if (typeof req.headers[key] === "string") {
            return req.headers[key];
        }
    }
    return undefined;
}

function getClientIp(req, context) {
    const direct = [
        context?.ip,
        context?.clientContext?.sourceIp,
        context?.clientContext?.ip,
        context?.request?.ip,
        context?.ipAddress,
        context?.geo?.ip,
    ];

    for (const v of direct) {
        if (typeof v === "string" && v.trim()) return v.trim();
    }

    const headers = [
        "x-nf-client-connection-ip", "cf-connecting-ip", "x-forwarded-for",
        "x-real-ip", "client-ip", "x-client-ip", "true-client-ip"
    ];

    for (const h of headers) {
        const val = getHeaderValue(req, h);
        if (val) {
            return val.split(",")[0].trim();
        }
    }
    return "unknown";
}

function getUserAgent(req, body) {
    if (body?.userAgent) return body.userAgent;
    const ua = getHeaderValue(req, "user-agent");
    return typeof ua === "string" && ua.trim() ? ua.trim() : "unknown";
}

function getDiscordUserId(req, body) {
    const candidates = [body?.discordUserId, body?.userId, body?.discord_id, body?.discord_user_id, body?.discordUserID];
    for (const v of candidates) {
        if (typeof v === "string" && v.trim()) return v.trim();
    }
    const headers = ["x-discord-user-id", "discord-user-id", "x-user-id"];
    for (const h of headers) {
        const val = getHeaderValue(req, h);
        if (val) return val.trim();
    }
    return undefined;
}

async function fetchWithTimeout(url, timeout = 4000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!res.ok) return null;
        return await res.json();
    } catch {
        clearTimeout(id);
        return null;
    }
}

async function getGeoDetails(ip, context) {
    if (!ip || ip === "unknown") {
        return { country: "unknown", city: "unknown", timezone: "unknown", vpnStatus: "unknown", isp: "unknown" };
    }

    const geo = context?.geo || {};
    let country = geo?.country?.name || geo?.country?.code || "unknown";
    let city = geo?.city || "unknown";
    let timezone = geo?.timezone || "unknown";

    try {
        let data = null;

        // Primary sources
        data = await fetchWithTimeout(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, 3500);
        if (!data) data = await fetchWithTimeout(`https://ipapi.is/${encodeURIComponent(ip)}`, 3500);
        if (!data) data = await fetchWithTimeout(`https://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,city,isp,org,proxy,hosting,query`, 3000);

        if (!data || (data.status && data.status === "fail")) {
            return { country, city, timezone, vpnStatus: "unknown", isp: "unknown" };
        }

        const orgLower = (data.org || data.asn?.org || data.isp || data.name || "").toLowerCase();
        const hostnameLower = (data.hostname || "").toLowerCase();
        const asnStr = (data.asn?.asn || data.asn || "").toString();
        const companyLower = (data.company?.name || "").toLowerCase();

        // === Enhanced Astrill Detection ===
        const astrillTerms = ["astrill", "veloxee", "a1vpn", "astrill systems", "jovica"];
        const isAstrill = astrillTerms.some(term =>
            orgLower.includes(term) ||
            hostnameLower.includes(term) ||
            companyLower.includes(term)
        ) || ["58546", "212238"].some(a => asnStr.includes(a));

        // General VPN signals
        const isGeneralVPN =
            data.privacy?.vpn === true ||
            data.is_vpn === true ||
            data.vpn === true ||
            data.proxy === true ||
            data.hosting === true ||
            /vpn|proxy|datacenter|hosting|veloxee|astrill/i.test(orgLower);

        let vpnStatus = "likely not VPN";

        if (isAstrill) {
            vpnStatus = "🚩 Likely Astrill VPN";
        } else if (isGeneralVPN) {
            vpnStatus = "⚠️ Likely VPN / Proxy";
        } else if (data.proxy || data.tor) {
            vpnStatus = "⚠️ Likely Proxy / TOR";
        }

        return {
            country: data.country || country,
            city: data.city || city,
            timezone: data.timezone || timezone,
            vpnStatus,
            isp: orgLower || companyLower || data.isp || "unknown"
        };

    } catch (err) {
        console.error("Geo lookup failed:", err);
        return { country, city, timezone, vpnStatus: "unknown", isp: "unknown" };
    }
}

function parseBody(body) {
    if (!body) return {};
    if (typeof body === "object") return body;

    const str = String(body).trim();
    if (!str) return {};

    if (str.startsWith("{") || str.startsWith("[")) {
        try { return JSON.parse(str); } catch { return {}; }
    }

    try {
        const params = new URLSearchParams(str);
        return Object.fromEntries(params.entries());
    } catch { return {}; }
}

async function visitHandler(req, context) {
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            }
        });
    }

    if (!["GET", "POST"].includes(req.method)) {
        return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json" }
        });
    }

    try {
        let body = req.method === "POST" ? parseBody(req.body) : {};

        if (req.method === "GET") {
            try {
                const base = req.headers?.host ? `https://${req.headers.host}` : "https://example.com";
                const url = new URL(req.url, base);
                body = Object.fromEntries(url.searchParams.entries());
            } catch (e) { }
        }

        const ip = getClientIp(req, context);
        const timestamp = new Date().toISOString();
        const userAgent = getUserAgent(req, body);
        const discordUserId = getDiscordUserId(req, body);
        const geo = await getGeoDetails(ip, context);

        let description = `IP: ${ip}\n` +
            `Country: ${geo.country}\n` +
            `City: ${geo.city}\n` +
            `ISP: ${geo.isp}\n` +
            `VPN Status: ${geo.vpnStatus}\n` +
            `User Agent: ${userAgent}\n` +
            `Time: ${timestamp}`;

        if (discordUserId) description += `\nDiscord User ID: ${discordUserId}`;

        const embed = {
            title: "👀 New Portfolio Visit",
            color: 5814783,
            description
        };

        await sendToDiscord({ content: "New visitor detected", embeds: [embed] });

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    } catch (error) {
        console.error(error);
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

module.exports = visitHandler;
module.exports.handler = async (event, context) => {
    const queryString = event?.queryStringParameters && Object.keys(event.queryStringParameters).length
        ? `?${new URLSearchParams(event.queryStringParameters).toString()}`
        : "";

    const req = {
        method: event?.httpMethod || event?.method || "GET",
        headers: event?.headers || {},
        url: (event?.path || "/") + queryString,
        body: event?.body || null,
    };

    const res = await visitHandler(req, context);

    if (res && typeof res.text === "function") {
        const bodyText = await res.text();
        const headers = {};
        try {
            if (res.headers?.forEach) {
                res.headers.forEach((v, k) => headers[k] = v);
            } else if (res.headers) {
                Object.assign(headers, res.headers);
            }
        } catch (e) { }
        return { statusCode: res.status || 200, headers, body: bodyText };
    }

    if (res && typeof res === "object" && ("status" in res || "body" in res)) {
        return {
            statusCode: res.status || 200,
            headers: res.headers || { "Content-Type": "application/json" },
            body: typeof res.body === "string" ? res.body : JSON.stringify(res.body)
        };
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: typeof res === "string" ? res : JSON.stringify(res)
    };
};