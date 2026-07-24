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

async function checkAstrillVPN(ip) {
    try {
        // Try multiple services that are better at detecting VPNs
        const services = [
            `https://ipinfo.io/${ip}/json`,
            `https://ip-api.com/json/${ip}?fields=status,country,city,isp,org,proxy,hosting,as,asname,reverse`,
            `https://api.ipgeolocation.io/ipgeo?apiKey=demo&ip=${ip}`
        ];

        let data = null;
        for (const url of services) {
            const result = await fetchWithTimeout(url);
            if (result && !result.error) {
                data = result;
                break;
            }
        }

        if (!data) return { isAstrill: false, isp: "unknown", details: "No data" };

        // Log the raw data for debugging (remove in production)
        console.log("IP Data:", JSON.stringify(data, null, 2));

        const isp = data.isp || data.org || data.connection?.isp || "unknown";
        const org = data.org || data.as?.org || data.connection?.organization || "";
        const asn = data.as || data.asn || data.connection?.asn || "";
        const hostname = data.hostname || data.reverse || "";
        const country = data.country || data.country_name || "";

        // Convert to lowercase for case-insensitive matching
        const ispLower = String(isp).toLowerCase();
        const orgLower = String(org).toLowerCase();
        const asnLower = String(asn).toLowerCase();
        const hostnameLower = String(hostname).toLowerCase();
        const countryLower = String(country).toLowerCase();

        // Comprehensive Astrill detection
        const isAstrill =
            ispLower.includes("astrill") ||
            ispLower.includes("veloxee") ||
            orgLower.includes("astrill") ||
            orgLower.includes("veloxee") ||
            asnLower.includes("58546") ||
            asnLower.includes("212238") ||
            asnLower.includes("as58546") ||
            asnLower.includes("as212238") ||
            hostnameLower.includes("astrill") ||
            hostnameLower.includes("veloxee") ||
            (countryLower === "se" && (ispLower.includes("astrill") || orgLower.includes("astrill"))) ||
            (data.proxy === true && (ispLower.includes("astrill") || orgLower.includes("astrill"))) ||
            (data.hosting === true && (ispLower.includes("astrill") || orgLower.includes("astrill")));

        // Check for general VPN/Proxy
        const isVpnProxy =
            data.proxy === true ||
            data.hosting === true ||
            data.vpn === true ||
            /vpn|proxy|datacenter|hosting/i.test(ispLower) ||
            /vpn|proxy|datacenter|hosting/i.test(orgLower) ||
            /vpn|proxy|datacenter|hosting/i.test(hostnameLower) ||
            (data.security?.is_vpn === true) ||
            (data.security?.is_proxy === true);

        return {
            isAstrill,
            isVpnProxy,
            isp: isp,
            org: org,
            asn: asn,
            hostname: hostname,
            country: country,
            rawData: data
        };

    } catch (error) {
        console.error("VPN check error:", error);
        return { isAstrill: false, isp: "unknown", details: error.message };
    }
}

async function getGeoDetails(ip, context) {
    if (!ip || ip === "unknown") {
        return {
            country: "unknown",
            city: "unknown",
            timezone: "unknown",
            vpnStatus: "unknown",
            isp: "unknown",
            vpnDetails: "No IP provided"
        };
    }

    const geo = context?.geo || {};
    let country = geo?.country?.name || geo?.country?.code || "unknown";
    let city = geo?.city || "unknown";
    let timezone = geo?.timezone || "unknown";

    // Perform comprehensive VPN check
    const vpnCheck = await checkAstrillVPN(ip);

    let vpnStatus = "unknown";
    let vpnDetails = "";

    if (vpnCheck.isAstrill) {
        vpnStatus = "🚩 ASTRIL VPN DETECTED";
        vpnDetails = `ISP: ${vpnCheck.isp} | ASN: ${vpnCheck.asn}`;
    } else if (vpnCheck.isVpnProxy) {
        vpnStatus = "⚠️ VPN/Proxy Detected";
        vpnDetails = `ISP: ${vpnCheck.isp} | Type: ${vpnCheck.isAstrill ? 'Astrill' : 'Other VPN'}`;
    } else if (vpnCheck.isp && vpnCheck.isp !== "unknown") {
        vpnStatus = "✅ Regular Connection";
        vpnDetails = `ISP: ${vpnCheck.isp}`;
    } else {
        vpnStatus = "❓ Unable to determine";
        vpnDetails = "Could not verify connection type";
    }

    // If we got data from the check, use it for ISP
    const isp = vpnCheck.isp !== "unknown" ? vpnCheck.isp :
        (data?.isp || data?.org || "unknown");

    return {
        country,
        city,
        timezone,
        vpnStatus,
        vpnDetails,
        isp: vpnCheck.isp || "unknown",
        rawVpnCheck: vpnCheck
    };
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

        // Create detailed description for Discord
        let description = `**IP:** ${ip}\n`;
        description += `**Country:** ${geo.country}\n`;
        description += `**City:** ${geo.city}\n`;
        description += `**ISP:** ${geo.isp}\n`;
        description += `**VPN Status:** ${geo.vpnStatus}\n`;
        if (geo.vpnDetails) {
            description += `**VPN Details:** ${geo.vpnDetails}\n`;
        }
        description += `**UA:** ${userAgent}\n`;
        description += `**Time:** ${timestamp}`;
        if (discordUserId) {
            description += `\n**Discord ID:** ${discordUserId}`;
        }

        const embed = {
            title: "👀 New Portfolio Visit",
            color: geo.vpnStatus.includes("ASTRIL") ? 15158332 : 5814783, // Red for Astrill
            description,
            footer: { text: `Connection Type: ${geo.vpnStatus}` }
        };

        await sendToDiscord({ content: "New visitor detected", embeds: [embed] });

        // Log detection for debugging
        console.log(`VPN Detection for ${ip}:`, {
            status: geo.vpnStatus,
            details: geo.vpnDetails,
            isp: geo.isp
        });

        return new Response(JSON.stringify({
            ok: true,
            vpnStatus: geo.vpnStatus,
            vpnDetails: geo.vpnDetails
        }), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        });
    } catch (error) {
        console.error("Handler error:", error);
        return new Response(JSON.stringify({ ok: false, error: error.message }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            }
        });
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
        return {
            statusCode: res.status || 200,
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*"
            },
            body: text
        };
    }

    return {
        statusCode: 200,
        headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({ ok: true })
    };
};