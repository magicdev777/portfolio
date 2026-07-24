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

async function checkVPN(ip) {
    try {
        // Try ip-api.com first as it has good proxy/datacenter detection
        let data = await fetchWithTimeout(`https://ip-api.com/json/${ip}?fields=status,country,city,isp,org,proxy,hosting,as,asname,reverse,query`);

        // If ip-api fails, try ipinfo.io
        if (!data || data.status === "fail") {
            data = await fetchWithTimeout(`https://ipinfo.io/${ip}/json`);
        }

        // If both fail, try ipapi.is
        if (!data || !data.isp) {
            const ipapiData = await fetchWithTimeout(`https://ipapi.is/${ip}`);
            if (ipapiData) {
                data = ipapiData;
            }
        }

        if (!data) {
            return {
                isVPN: false,
                isAstrill: false,
                isp: "unknown",
                details: "No data available"
            };
        }

        // Extract data from various API formats
        const isp = data.isp || data.org || data.connection?.isp || "unknown";
        const org = data.org || data.as?.org || data.connection?.organization || "";
        const asn = data.as || data.asn || data.connection?.asn || "";
        const hostname = data.hostname || data.reverse || "";

        // Convert to lowercase for case-insensitive matching
        const ispLower = String(isp).toLowerCase();
        const orgLower = String(org).toLowerCase();
        const asnLower = String(asn).toLowerCase();
        const hostnameLower = String(hostname).toLowerCase();
        const combinedText = `${ispLower} ${orgLower} ${asnLower} ${hostnameLower}`;

        // Define known datacenter/VPN keywords
        const vpnKeywords = [
            // Datacenter/Cloud providers
            'fdcservers', 'digitalocean', 'aws', 'amazon', 'azure', 'google cloud', 'gcp',
            'vultr', 'linode', 'hetzner', 'ovh', 'rackspace', 'scaleway', 'cloudflare',
            'cloud', 'datacenter', 'hosting', 'server', 'dedicated',
            // VPN providers
            'vpn', 'proxy', 'astrill', 'veloxee', 'nordvpn', 'expressvpn', 'surfshark',
            'cyberghost', 'private internet access', 'pia', 'protonvpn', 'hide.me',
            'ipvanish', 'torguard', 'vyprvpn', 'hotspot shield', 'windscribe',
            // Known VPN ASNs
            'as58546', 'as212238', 'as30058', 'as20473', 'as14061', 'as16276',
            'as16509', 'as14618', 'as63949', 'as24940', 'as13335'
        ];

        // Check if any VPN keyword matches
        let isVPN = false;
        let matchedKeyword = "";
        let isAstrill = false;

        for (const keyword of vpnKeywords) {
            if (combinedText.includes(keyword.toLowerCase())) {
                isVPN = true;
                matchedKeyword = keyword;
                if (keyword === 'astrill' || keyword === 'veloxee' ||
                    keyword === 'as58546' || keyword === 'as212238') {
                    isAstrill = true;
                }
                break;
            }
        }

        // Check specific ASN for FDCservers (datacenter)
        if (asn.includes('30058') || isp.includes('FDCservers')) {
            isVPN = true;
            matchedKeyword = 'FDCservers Datacenter';
        }

        // Check proxy/hosting flags from ip-api
        if (data.proxy === true || data.hosting === true) {
            isVPN = true;
            if (!matchedKeyword) matchedKeyword = 'Proxy/Hosting detected';
        }

        // Determine VPN status
        let status = "✅ Regular Connection";
        let details = `ISP: ${isp}`;
        let color = 5814783; // Blue

        if (isAstrill) {
            status = "🚩 ASTRIL VPN DETECTED";
            details = `ISP: ${isp} | ASN: ${asn}`;
            color = 15158332; // Red
        } else if (isVPN) {
            status = "⚠️ VPN/Datacenter Detected";
            details = `ISP: ${isp} | ASN: ${asn} | Detected: ${matchedKeyword}`;
            color = 16766720; // Orange
        }

        return {
            isVPN,
            isAstrill,
            isp,
            org,
            asn,
            status,
            details,
            color,
            matchedKeyword,
            rawData: data
        };

    } catch (error) {
        console.error("VPN check error:", error);
        return {
            isVPN: false,
            isAstrill: false,
            isp: "unknown",
            status: "❓ Unable to determine",
            details: `Error: ${error.message}`,
            color: 8947848 // Gray
        };
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
            vpnDetails: "No IP provided",
            color: 8947848
        };
    }

    const geo = context?.geo || {};
    let country = geo?.country?.name || geo?.country?.code || "unknown";
    let city = geo?.city || "unknown";
    let timezone = geo?.timezone || "unknown";

    // Perform comprehensive VPN check
    const vpnCheck = await checkVPN(ip);

    return {
        country,
        city,
        timezone,
        vpnStatus: vpnCheck.status,
        vpnDetails: vpnCheck.details,
        isp: vpnCheck.isp || "unknown",
        color: vpnCheck.color || 5814783,
        asn: vpnCheck.asn || "unknown",
        matchedKeyword: vpnCheck.matchedKeyword || "none"
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
        description += `**ASN:** ${geo.asn}\n`;
        description += `**VPN Status:** ${geo.vpnStatus}\n`;
        description += `**Details:** ${geo.vpnDetails}\n`;
        description += `**UA:** ${userAgent}\n`;
        description += `**Time:** ${timestamp}`;
        if (discordUserId) {
            description += `\n**Discord ID:** ${discordUserId}`;
        }

        const embed = {
            title: "👀 New Portfolio Visit",
            color: geo.color,
            description,
            footer: { text: `Detection: ${geo.matchedKeyword || 'None'}` }
        };

        await sendToDiscord({ content: "New visitor detected", embeds: [embed] });

        // Log detection for debugging
        console.log(`VPN Detection for ${ip}:`, {
            status: geo.vpnStatus,
            details: geo.vpnDetails,
            isp: geo.isp,
            asn: geo.asn,
            matchedKeyword: geo.matchedKeyword
        });

        return new Response(JSON.stringify({
            ok: true,
            vpnStatus: geo.vpnStatus,
            vpnDetails: geo.vpnDetails,
            isp: geo.isp,
            asn: geo.asn
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