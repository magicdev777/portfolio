const { sendToDiscord } = require("./discord.js");

function getHeaderValue(req, headerName) {
    if (!req || !req.headers) {
        return undefined;
    }

    if (typeof req.headers.get === "function") {
        const direct = req.headers.get(headerName);
        if (direct) return direct;

        const lower = headerName.toLowerCase();
        const lowerValue = req.headers.get(lower);
        if (lowerValue) return lowerValue;
    }

    const candidates = [headerName, headerName.toLowerCase(), headerName.toUpperCase()];
    for (const key of candidates) {
        const value = req.headers[key];
        if (typeof value === "string") {
            return value;
        }
    }
    return undefined;
}

function getClientIp(req, context) {
    const directCandidates = [
        context?.ip,
        context?.clientContext?.sourceIp,
        context?.clientContext?.ip,
        context?.request?.ip,
        context?.request?.headers?.["x-forwarded-for"],
        context?.ipAddress,
        context?.geo?.ip,
    ];

    for (const value of directCandidates) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }

    const headerCandidates = [
        "x-nf-client-connection-ip",
        "cf-connecting-ip",
        "x-forwarded-for",
        "x-real-ip",
        "client-ip",
        "x-client-ip",
        "true-client-ip",
    ];

    for (const headerName of headerCandidates) {
        const value = getHeaderValue(req, headerName);
        if (typeof value === "string") {
            const ip = value.split(",")[0].trim();
            if (ip) return ip;
        }
    }

    return "unknown";
}

function getUserAgent(req, body) {
    if (body?.userAgent) return body.userAgent;

    const value = getHeaderValue(req, "user-agent");
    return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function getDiscordUserId(req, body) {
    const candidates = [
        body?.discordUserId,
        body?.userId,
        body?.discord_id,
        body?.discord_user_id,
        body?.discordUserID,
    ];

    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }

    const headerCandidates = ["x-discord-user-id", "discord-user-id", "x-user-id"];
    for (const headerName of headerCandidates) {
        const value = getHeaderValue(req, headerName);
        if (typeof value === "string" && value.trim()) {
            return value.trim();
        }
    }

    return undefined;
}

// Helper: Fetch with timeout
async function fetchWithTimeout(url, timeout = 4000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(id);
        if (!response.ok) return null;
        return await response.json();
    } catch {
        clearTimeout(id);
        return null;
    }
}

async function getGeoDetails(ip, context) {
    if (!ip || ip === "unknown") {
        return {
            country: "unknown",
            city: "unknown",
            timezone: "unknown",
            vpnStatus: "unknown",
            isp: "unknown"
        };
    }

    const geo = context?.geo || {};
    let country = geo?.country?.name || geo?.country?.code || "unknown";
    let city = geo?.city || "unknown";
    let timezone = geo?.timezone || "unknown";

    try {
        // Try multiple services
        let data = await fetchWithTimeout(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, 4000);

        if (!data) {
            data = await fetchWithTimeout(`https://ipapi.is/${encodeURIComponent(ip)}`, 4000);
        }

        if (!data) {
            // Third fallback
            data = await fetchWithTimeout(`https://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,city,isp,org,proxy,hosting`, 3000);
        }

        if (!data || (data.status && data.status === "fail")) {
            return { country, city, timezone, vpnStatus: "unknown", isp: "unknown" };
        }

        const org = (data.org || data.asn?.org || data.isp || data.name || "").toLowerCase();
        const hostname = (data.hostname || data.host || "").toLowerCase();
        const asn = (data.asn?.asn || data.asn || "").toString();
        const company = (data.company?.name || "").toLowerCase();

        // === Stronger Astrill Detection ===
        const astrillKeywords = [
            "astrill", "veloxee", "a1vpn", "astrill systems",
            "astrill limited", "jovica mizdrakski"
        ];

        const isAstrill = astrillKeywords.some(kw =>
            org.includes(kw) ||
            hostname.includes(kw) ||
            company.includes(kw)
        ) ||
            asn === "AS58546" ||
            asn === "AS212238" ||
            asn.includes("58546") ||
            asn.includes("212238");

        // General VPN/Proxy signals
        const isVPN =
            data.privacy?.vpn === true ||
            data.is_vpn === true ||
            data.vpn === true ||
            data.proxy === true ||
            data.hosting === true ||
            data.datacenter === true ||
            /vpn|proxy|datacenter|hosting|cloud|server farm|veloxee/i.test(org);

        let vpnStatus = "likely not VPN";

        if (isAstrill) {
            vpnStatus = "🚩 Likely Astrill VPN";
        } else if (isVPN) {
            vpnStatus = "⚠️ Likely VPN / Proxy";
        } else if (data.proxy || data.tor) {
            vpnStatus = "⚠️ Likely Proxy / TOR";
        }

        return {
            country: data.country || country,
            city: data.city || city,
            timezone: data.timezone || timezone,
            vpnStatus,
            isp: org || company || data.isp || "unknown"
        };

    } catch (error) {
        console.error("Geo lookup error:", error);
        return { country, city, timezone, vpnStatus: "unknown", isp: "unknown" };
    }
}

function parseBody(body) {
    if (!body) return {};

    if (typeof body === "object") return body;

    const trimmed = String(body).trim();
    if (!trimmed) return {};

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        } catch {
            return {};
        }
    }

    try {
        const params = new URLSearchParams(trimmed);
        return Object.fromEntries(params.entries());
    } catch {
        return {};
    }
}

async function visitHandler(req, context) {
    // CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type",
            },
        });
    }

    if (!["POST", "GET"].includes(req.method)) {
        return new Response(JSON.stringify({ ok: false, error: "Method not allowed" }), {
            status: 405,
            headers: { "Content-Type": "application/json" },
        });
    }

    try {
        let body = {};
        if (req.method === "POST") {
            body = parseBody(req.body);
        } else {
            try {
                const base = req.headers && req.headers.host ? `https://${req.headers.host}` : "https://example.com";
                const url = new URL(req.url, base);
                body = Object.fromEntries(url.searchParams.entries());
            } catch (e) {
                body = {};
            }
        }

        const ip = getClientIp(req, context);
        const timestamp = new Date().toISOString();
        const userAgent = getUserAgent(req, body);
        const discordUserId = getDiscordUserId(req, body);
        const geo = await getGeoDetails(ip, context);

        // Build Discord message
        let description = `IP: ${ip}\n` +
            `Country: ${geo.country}\n` +
            `City: ${geo.city}\n` +
            `ISP: ${geo.isp}\n` +
            `VPN Status: ${geo.vpnStatus}\n` +
            `User Agent: ${userAgent}\n` +
            `Visited At: ${timestamp}`;

        if (discordUserId) {
            description += `\nDiscord User ID: ${discordUserId}`;
        }

        const embed = {
            title: "👀 New Portfolio Visit",
            color: 5814783,
            description: description,
        };

        await sendToDiscord({ content: "New visitor detected", embeds: [embed] });

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (error) {
        console.error(error);
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}

// Netlify / Serverless handler
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
            if (res.headers && typeof res.headers.forEach === "function") {
                res.headers.forEach((value, key) => { headers[key] = value; });
            } else if (res.headers) {
                Object.assign(headers, res.headers);
            }
        } catch (e) { }

        return {
            statusCode: res.status || 200,
            headers,
            body: bodyText,
        };
    }

    if (res && typeof res === "object" && ("status" in res || "body" in res)) {
        return {
            statusCode: res.status || 200,
            headers: res.headers || { "Content-Type": "application/json" },
            body: typeof res.body === "string" ? res.body : JSON.stringify(res.body),
        };
    }

    return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: typeof res === "string" ? res : JSON.stringify(res),
    };
};