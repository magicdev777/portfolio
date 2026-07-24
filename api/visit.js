const { sendToDiscord } = require("./discord.js");

function getHeaderValue(req, headerName) {
    if (!req || !req.headers) return undefined;

    if (typeof req.headers.get === "function") {
        let val = req.headers.get(headerName) || req.headers.get(headerName.toLowerCase());
        if (val) return val;
    }

    const candidates = [headerName, headerName.toLowerCase(), headerName.toUpperCase()];
    for (const key of candidates) {
        if (typeof req.headers[key] === "string") return req.headers[key];
    }
    return undefined;
}

function getClientIp(req, context) {
    const candidates = [
        context?.ip, context?.clientContext?.sourceIp, context?.clientContext?.ip,
        context?.request?.ip, context?.ipAddress, context?.geo?.ip
    ];

    for (const v of candidates) {
        if (typeof v === "string" && v.trim()) return v.trim();
    }

    const headers = ["x-nf-client-connection-ip", "cf-connecting-ip", "x-forwarded-for", "x-real-ip", "client-ip"];
    for (const h of headers) {
        const val = getHeaderValue(req, h);
        if (val) return val.split(",")[0].trim();
    }
    return "unknown";
}

function getUserAgent(req, body) {
    if (body?.userAgent) return body.userAgent;
    const ua = getHeaderValue(req, "user-agent");
    return typeof ua === "string" && ua.trim() ? ua.trim() : "unknown";
}

function getDiscordUserId(req, body) {
    const c = [body?.discordUserId, body?.userId, body?.discord_id, body?.discord_user_id];
    for (const v of c) if (typeof v === "string" && v.trim()) return v.trim();
    return undefined;
}

async function fetchWithTimeout(url, timeout = 5000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
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

    let vpnStatus = "unknown";
    let isp = "unknown";

    try {
        // Try multiple services in order
        let data = await fetchWithTimeout(`https://ipinfo.io/${ip}/json`);
        if (!data) data = await fetchWithTimeout(`https://ipapi.is/${ip}`);
        if (!data) data = await fetchWithTimeout(`https://ip-api.com/json/${ip}?fields=status,country,city,isp,org,proxy,hosting`);

        if (data && (!data.status || data.status !== "fail")) {
            const org = (data.org || data.isp || data.asn?.org || "").toLowerCase();
            const asn = (data.asn?.asn || data.asn || "").toString();

            isp = org || data.isp || "unknown";

            const isAstrill = org.includes("astrill") ||
                org.includes("veloxee") ||
                asn.includes("58546") ||
                asn.includes("212238");

            if (isAstrill) {
                vpnStatus = "🚩 Likely Astrill VPN";
            } else if (data.proxy || data.hosting || data.vpn || /vpn|proxy|datacenter/i.test(org)) {
                vpnStatus = "⚠️ Likely VPN / Proxy";
            } else {
                vpnStatus = "likely not VPN";
            }
        }
    } catch (e) {
        console.error("Geo lookup error:", e);
    }

    return { country, city, vpnStatus, isp };
}

function parseBody(body) {
    if (!body) return {};
    if (typeof body === "object") return body;

    const str = String(body).trim();
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
        return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
    }

    try {
        let body = req.method === "POST" ? parseBody(req.body) : {};
        if (req.method === "GET") {
            try {
                const base = req.headers?.host ? `https://${req.headers.host}` : "https://example.com";
                const url = new URL(req.url, base);
                body = Object.fromEntries(url.searchParams.entries());
            } catch { }
        }

        const ip = getClientIp(req, context);
        const timestamp = new Date().toISOString();
        const userAgent = getUserAgent(req, body);
        const discordUserId = getDiscordUserId(req, body);
        const geo = await getGeoDetails(ip, context);

        const description = `IP: ${ip}\nCountry: ${geo.country}\nCity: ${geo.city}\nISP: ${geo.isp}\nVPN: ${geo.vpnStatus}\nUA: ${userAgent}\nTime: ${timestamp}${discordUserId ? `\nDiscord ID: ${discordUserId}` : ""}`;

        const embed = { title: "👀 New Portfolio Visit", color: 5814783, description };

        await sendToDiscord({ content: "New visitor detected", embeds: [embed] });

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });
    } catch (error) {
        console.error("Handler error:", error);
        return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }
}

module.exports = visitHandler;
module.exports.handler = async (event, context) => {
    const req = {
        method: event?.httpMethod || "GET",
        headers: event?.headers || {},
        url: event?.path || "/",
        body: event?.body || null,
    };

    const res = await visitHandler(req, context);

    if (res && typeof res.text === "function") {
        const text = await res.text();
        return { statusCode: res.status || 200, headers: {}, body: text };
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ok: true })
    };
};