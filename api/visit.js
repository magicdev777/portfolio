import { sendToDiscord } from "./discord.js";

function getHeaderValue(req, headerName) {
    if (!req || !req.headers) {
        return undefined;
    }

    if (typeof req.headers.get === "function") {
        const direct = req.headers.get(headerName);
        if (direct) {
            return direct;
        }

        const lower = headerName.toLowerCase();
        const lowerValue = req.headers.get(lower);
        if (lowerValue) {
            return lowerValue;
        }
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
            if (ip) {
                return ip;
            }
        }
    }

    return "unknown";
}

function getUserAgent(req, body) {
    if (body?.userAgent) {
        return body.userAgent;
    }

    const value = getHeaderValue(req, "user-agent");
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }

    return "unknown";
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

async function getGeoDetails(ip, context) {
    const geo = context?.geo;
    const country = geo?.country?.name || geo?.country?.code || "unknown";
    const city = geo?.city || "unknown";
    const timezone = geo?.timezone || "unknown";

    if (!ip || ip === "unknown") {
        return { country, city, timezone, vpnStatus: "unknown" };
    }

    try {
        const response = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`);
        if (!response.ok) {
            return { country, city, timezone, vpnStatus: "unknown" };
        }

        const data = await response.json();
        const vpnStatus = data?.privacy?.vpn === true
            ? "likely VPN"
            : data?.privacy?.proxy === true || data?.privacy?.relay === true || data?.privacy?.tor === true
                ? "likely proxy/TOR"
                : "likely not VPN";

        return {
            country: data?.country || country,
            city: data?.city || city,
            timezone: data?.timezone || timezone,
            vpnStatus,
        };
    } catch (error) {
        return { country, city, timezone, vpnStatus: "unknown" };
    }
}

function parseBody(body) {
    if (!body) {
        return {};
    }

    if (typeof body === "object") {
        return body;
    }

    const trimmed = String(body).trim();
    if (!trimmed) {
        return {};
    }

    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            return JSON.parse(trimmed);
        } catch (error) {
            return {};
        }
    }

    try {
        const params = new URLSearchParams(trimmed);
        return Object.fromEntries(params.entries());
    } catch (error) {
        return {};
    }
}

export default async (req, context) => {
    // Handle CORS preflight
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
        let pathValue = req.url;

        if (req.method === "POST") {
            body = parseBody(req.body);
        } else {
            // For GET requests, try to parse query params from the URL
            try {
                const base = req.headers && req.headers.host ? `https://${req.headers.host}` : "https://example.com";
                const url = new URL(req.url, base);
                body = Object.fromEntries(url.searchParams.entries());
                pathValue = body.path || url.pathname || req.url;
            } catch (e) {
                body = {};
            }
        }

        const ip = getClientIp(req, context);
        const timestamp = new Date().toISOString();
        const userAgent = getUserAgent(req, body);
        const discordUserId = getDiscordUserId(req, body);
        const geo = await getGeoDetails(ip, context);

        let description = `IP: ${ip || "unknown"}\n` +
            `Country: ${geo.country || "unknown"}\n` +
            `City: ${geo.city || "unknown"}\n` +
            `Timezone: ${geo.timezone || "unknown"}\n` +
            `User Agent: ${String(userAgent)}\n` +
            `Visited At: ${timestamp}\n` +
            `VPN: ${geo.vpnStatus || "unknown"}`;

        if (discordUserId) {
            description += `\nDiscord User ID: ${discordUserId}`;
        }

        const embed = {
            title: "Visitor detected",
            color: 5814783,
            description,
        };

        await sendToDiscord({ content: "New portfolio visit", embeds: [embed] });

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
};
