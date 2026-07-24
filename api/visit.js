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

function guessOriginIP(req) {
    // List of headers that might contain the original IP (in order of reliability)
    const originHeaders = [
        // Cloudflare headers
        { name: 'cf-connecting-ip', desc: 'Cloudflare Connecting IP' },
        { name: 'cf-pseudo-ipv4', desc: 'Cloudflare Pseudo IPv4' },
        { name: 'cf-ray', desc: 'Cloudflare Ray (contains edge IP)' },

        // Proxy/VPN headers
        { name: 'x-forwarded-for', desc: 'X-Forwarded-For (first IP)' },
        { name: 'x-real-ip', desc: 'X-Real-IP' },
        { name: 'x-original-forwarded-for', desc: 'X-Original-Forwarded-For' },
        { name: 'x-nginx-proxy', desc: 'Nginx Proxy' },
        { name: 'x-varnish', desc: 'Varnish Cache' },
        { name: 'x-client-ip', desc: 'Client IP' },
        { name: 'x-cluster-client-ip', desc: 'Cluster Client IP' },
        { name: 'x-original-ip', desc: 'Original IP' },
        { name: 'x-envoy-external-address', desc: 'Envoy External Address' },
        { name: 'x-appengine-user-ip', desc: 'Google App Engine IP' },
        { name: 'x-b3-traceid', desc: 'Zipkin Trace (may contain IP)' },

        // Load balancer headers
        { name: 'x-forwarded-host', desc: 'Forwarded Host' },
        { name: 'x-forwarded-server', desc: 'Forwarded Server' },
        { name: 'x-forwarded-proto', desc: 'Forwarded Proto' },

        // Other possible headers
        { name: 'via', desc: 'Via header' },
        { name: 'client-ip', desc: 'Client IP' },
        { name: 'true-client-ip', desc: 'True Client IP' },
        { name: 'x-proxy-ip', desc: 'Proxy IP' },
        { name: 'x-originating-ip', desc: 'Originating IP' },
        { name: 'x-remote-ip', desc: 'Remote IP' },
        { name: 'x-remote-addr', desc: 'Remote Address' },
        { name: 'x-connection-ip', desc: 'Connection IP' }
    ];

    const possibleOrigins = [];
    const publicIPs = [];

    // Check each header
    for (const header of originHeaders) {
        const value = getHeaderValue(req, header.name);
        if (value) {
            // Handle comma-separated lists (e.g., X-Forwarded-For)
            const ips = value.split(',').map(ip => ip.trim()).filter(ip => ip);

            // Check if it's a private IP (likely the real origin)
            for (const ip of ips) {
                const isPrivate = isPrivateIP(ip);
                const isPublic = !isPrivate && isValidIP(ip);

                possibleOrigins.push({
                    ip: ip,
                    header: header.name,
                    description: header.desc,
                    isPrivate: isPrivate,
                    isPublic: isPublic,
                    position: possibleOrigins.length
                });

                if (isPublic) {
                    publicIPs.push(ip);
                }
            }
        }
    }

    // Guess the origin IP
    let guessedOrigin = null;
    let confidence = 0;

    // Strategy 1: Look for a public IP in X-Forwarded-For chain (usually the first public IP is the origin)
    const xff = getHeaderValue(req, 'x-forwarded-for');
    if (xff) {
        const ips = xff.split(',').map(ip => ip.trim()).filter(ip => ip);
        // Find the first public IP in the chain (excluding private IPs that might be internal proxies)
        for (const ip of ips) {
            if (isValidIP(ip) && !isPrivateIP(ip)) {
                guessedOrigin = ip;
                confidence = 80;
                break;
            }
        }
        // If all IPs are private, take the last one (furthest from client)
        if (!guessedOrigin && ips.length > 0) {
            const lastIP = ips[ips.length - 1];
            if (isValidIP(lastIP) && isPrivateIP(lastIP)) {
                guessedOrigin = lastIP;
                confidence = 40;
            }
        }
    }

    // Strategy 2: Check CF-Connecting-IP (Cloudflare)
    if (!guessedOrigin) {
        const cfIP = getHeaderValue(req, 'cf-connecting-ip');
        if (cfIP && isValidIP(cfIP)) {
            guessedOrigin = cfIP;
            confidence = 90;
        }
    }

    // Strategy 3: Check X-Real-IP
    if (!guessedOrigin) {
        const realIP = getHeaderValue(req, 'x-real-ip');
        if (realIP && isValidIP(realIP) && !isPrivateIP(realIP)) {
            guessedOrigin = realIP;
            confidence = 70;
        }
    }

    // Strategy 4: Check True-Client-IP
    if (!guessedOrigin) {
        const trueIP = getHeaderValue(req, 'true-client-ip');
        if (trueIP && isValidIP(trueIP) && !isPrivateIP(trueIP)) {
            guessedOrigin = trueIP;
            confidence = 75;
        }
    }

    // Strategy 5: Check X-Original-Forwarded-For
    if (!guessedOrigin) {
        const origIP = getHeaderValue(req, 'x-original-forwarded-for');
        if (origIP) {
            const ips = origIP.split(',').map(ip => ip.trim()).filter(ip => ip && isValidIP(ip));
            for (const ip of ips) {
                if (!isPrivateIP(ip)) {
                    guessedOrigin = ip;
                    confidence = 65;
                    break;
                }
            }
        }
    }

    // Strategy 6: Check if there are multiple public IPs and the current one is a datacenter
    const currentIP = getClientIp(req, {});
    if (publicIPs.length > 0 && currentIP !== 'unknown') {
        const uniquePublicIPs = [...new Set(publicIPs)];
        // Remove the current IP if it's in the list
        const otherIPs = uniquePublicIPs.filter(ip => ip !== currentIP);
        if (otherIPs.length > 0) {
            // The first different public IP is likely the origin
            if (!guessedOrigin || confidence < 50) {
                guessedOrigin = otherIPs[0];
                confidence = 60;
            }
        }
    }

    return {
        guessedOrigin: guessedOrigin,
        confidence: confidence,
        possibleOrigins: possibleOrigins,
        publicIPsFound: publicIPs,
        totalHeadersChecked: originHeaders.length,
        currentIP: getClientIp(req, {})
    };
}

function isPrivateIP(ip) {
    if (!ip || typeof ip !== 'string') return false;

    // IPv4 private ranges
    const privateRanges = [
        /^10\./,                    // 10.0.0.0/8
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
        /^192\.168\./,              // 192.168.0.0/16
        /^127\./,                   // 127.0.0.0/8
        /^169\.254\./,              // 169.254.0.0/16
        /^::1$/,                    // IPv6 loopback
        /^fc00:/,                   // IPv6 private
        /^fe80:/,                   // IPv6 link-local
        /^fd00:/                    // IPv6 unique local
    ];

    return privateRanges.some(range => range.test(ip));
}

function isValidIP(ip) {
    if (!ip || typeof ip !== 'string') return false;

    // Simple IP validation (IPv4 and IPv6)
    const ipv4Pattern = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Pattern = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::1$|^::$/;

    if (ipv4Pattern.test(ip)) {
        const parts = ip.split('.').map(Number);
        return parts.every(part => part >= 0 && part <= 255);
    }

    return ipv6Pattern.test(ip);
}

async function checkAstrillVPN(ip) {
    try {
        // Try multiple APIs for better detection
        let data = null;
        let apiData = {};

        // Try ip-api.com first (has proxy/datacenter detection)
        const ipApiData = await fetchWithTimeout(`https://ip-api.com/json/${ip}?fields=status,country,city,isp,org,proxy,hosting,as,asname,reverse,query,mobile,timezone`);
        if (ipApiData && ipApiData.status !== "fail") {
            apiData.ipApi = ipApiData;
            data = ipApiData;
        }

        // Try ipinfo.io for additional details
        const ipInfoData = await fetchWithTimeout(`https://ipinfo.io/${ip}/json`);
        if (ipInfoData && ipInfoData.ip) {
            apiData.ipInfo = ipInfoData;
            if (!data) data = ipInfoData;
        }

        // Try ipapi.is for additional verification
        const ipApiIsData = await fetchWithTimeout(`https://ipapi.is/${ip}`);
        if (ipApiIsData && ipApiIsData.ip) {
            apiData.ipApiIs = ipApiIsData;
            if (!data) data = ipApiIsData;
        }

        // Try whoisxmlapi for VPN detection
        const whoisData = await fetchWithTimeout(`https://ipwhois.io/json/${ip}`);
        if (whoisData && whoisData.ip) {
            apiData.whois = whoisData;
        }

        if (!data) {
            return {
                isAstrill: false,
                isVPN: false,
                isp: "unknown",
                details: "No data available",
                confidence: 0
            };
        }

        // Extract data from all sources
        const isp = data.isp || data.org || data.connection?.isp || "unknown";
        const org = data.org || data.as?.org || data.connection?.organization || "";
        const asn = data.as || data.asn || data.connection?.asn || "";
        const hostname = data.hostname || data.reverse || "";
        const country = data.country || data.country_name || data.countryCode || "";

        // Convert to lowercase for case-insensitive matching
        const ispLower = String(isp).toLowerCase();
        const orgLower = String(org).toLowerCase();
        const asnLower = String(asn).toLowerCase();
        const hostnameLower = String(hostname).toLowerCase();
        const countryLower = String(country).toLowerCase();
        const combinedText = `${ispLower} ${orgLower} ${asnLower} ${hostnameLower}`;

        // Astrill specific detection
        const astrillKeywords = [
            'astrill',
            'veloxee',
            'as58546',
            'as212238',
            '58546',
            '212238',
            'astrill vpn'
        ];

        // Known Astrill IP ranges (commonly used)
        const astrillIPRanges = [
            '50.7.253.',  // FDCservers IP range often used by Astrill
            '185.159.',
            '185.160.',
            '185.161.',
            '46.246.',
            '194.50.',
            '195.54.',
            '185.53.',
            '193.187.',
            '5.134.'
        ];

        let isAstrill = false;
        let confidence = 0;
        let matchedKeywords = [];

        // Check 1: Exact keyword matches
        for (const keyword of astrillKeywords) {
            if (combinedText.includes(keyword)) {
                isAstrill = true;
                confidence += 30;
                matchedKeywords.push(keyword);
            }
        }

        // Check 2: IP range matching
        for (const range of astrillIPRanges) {
            if (ip.startsWith(range)) {
                isAstrill = true;
                confidence += 40;
                matchedKeywords.push(`IP range: ${range}`);
                break;
            }
        }

        // Check 3: ASN detection
        const astrilASNs = ['58546', '212238', 'AS58546', 'AS212238'];
        for (const as of astrilASNs) {
            if (asn.includes(as) || asnLower.includes(as.toLowerCase())) {
                isAstrill = true;
                confidence += 30;
                matchedKeywords.push(`ASN: ${as}`);
            }
        }

        // Check 4: FDCservers (often used by Astrill)
        if (ispLower.includes('fdcservers') || orgLower.includes('fdcservers')) {
            confidence += 25;
            if (asn.includes('30058') || asn.includes('AS30058')) {
                isAstrill = true;
                matchedKeywords.push('FDCservers (Astrill common host)');
            }
        }

        // Check 5: Combined indicators
        const vpnIndicators = [
            data.proxy === true,
            data.hosting === true,
            data.vpn === true,
            data.security?.is_vpn === true,
            data.security?.is_proxy === true,
            data.mobile === false && (data.hosting === true || data.proxy === true)
        ];

        if (vpnIndicators.some(v => v === true)) {
            confidence += 10;
            if (matchedKeywords.length === 0) {
                matchedKeywords.push('VPN indicators detected');
            }
        }

        // Check 6: Cross-reference with multiple APIs
        if (apiData.ipInfo && apiData.ipApi) {
            if ((apiData.ipInfo.org?.toLowerCase().includes('fdcservers') ||
                apiData.ipApi.org?.toLowerCase().includes('fdcservers')) &&
                (apiData.ipInfo.country === 'US' || apiData.ipApi.country === 'US')) {
                confidence += 15;
                if (!isAstrill) {
                    matchedKeywords.push('Multiple sources confirm datacenter');
                }
            }
        }

        // Final determination
        if (confidence >= 40) {
            isAstrill = true;
        }

        // Determine if it's a general VPN
        let isVPN = false;
        const generalVPNKeywords = ['vpn', 'proxy', 'datacenter', 'hosting', 'cloud'];
        for (const keyword of generalVPNKeywords) {
            if (combinedText.includes(keyword) ||
                data.proxy === true ||
                data.hosting === true ||
                data.vpn === true) {
                isVPN = true;
                break;
            }
        }

        // Determine status
        let status = "✅ Regular Connection";
        let details = `ISP: ${isp}`;
        let color = 5814783; // Blue

        if (isAstrill && confidence >= 40) {
            status = "🚨 ASTRIL VPN DETECTED";
            details = `ISP: ${isp} | ASN: ${asn} | Confidence: ${confidence}% | Matched: ${matchedKeywords.join(', ')}`;
            color = 15158332; // Red
        } else if (isVPN || confidence >= 20) {
            status = "⚠️ VPN/Datacenter Detected";
            details = `ISP: ${isp} | ASN: ${asn} | Confidence: ${confidence}% | Indicators: ${matchedKeywords.join(', ')}`;
            color = 16766720; // Orange
        }

        // Check if it's definitely not Astrill but is a datacenter
        if (!isAstrill && (ispLower.includes('fdcservers') || ispLower.includes('datacenter'))) {
            status = "⚠️ Datacenter IP Detected";
            details = `ISP: ${isp} | ASN: ${asn} (Likely used for VPNs)`;
            color = 16766720; // Orange
        }

        console.log(`Astrill Detection for ${ip}:`, {
            isAstrill,
            confidence,
            matchedKeywords,
            isp,
            asn,
            status
        });

        return {
            isAstrill,
            isVPN,
            confidence,
            matchedKeywords,
            isp,
            org,
            asn,
            hostname,
            country,
            status,
            details,
            color,
            apiData
        };

    } catch (error) {
        console.error("Astrill VPN check error:", error);
        return {
            isAstrill: false,
            isVPN: false,
            confidence: 0,
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
            color: 8947848,
            originIP: null,
            originConfidence: 0
        };
    }

    const geo = context?.geo || {};
    let country = geo?.country?.name || geo?.country?.code || "unknown";
    let city = geo?.city || "unknown";
    let timezone = geo?.timezone || "unknown";

    // Perform comprehensive Astrill VPN check
    const vpnCheck = await checkAstrillVPN(ip);

    // Guess origin IP from headers
    const originGuess = guessOriginIP(context?.request || { headers: {} });

    return {
        country: country !== "unknown" ? country : vpnCheck.country || "unknown",
        city,
        timezone,
        vpnStatus: vpnCheck.status,
        vpnDetails: vpnCheck.details,
        isp: vpnCheck.isp || "unknown",
        color: vpnCheck.color || 5814783,
        asn: vpnCheck.asn || "unknown",
        confidence: vpnCheck.confidence || 0,
        matchedKeywords: vpnCheck.matchedKeywords || [],
        originIP: originGuess.guessedOrigin,
        originConfidence: originGuess.confidence,
        possibleOrigins: originGuess.possibleOrigins || [],
        publicIPsFound: originGuess.publicIPsFound || []
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

        // Get geo details with origin IP detection
        const geo = await getGeoDetails(ip, { ...context, request: req });

        // Create detailed description for Discord
        let description = `**IP:** ${ip}\n`;
        description += `**Country:** ${geo.country}\n`;
        description += `**City:** ${geo.city}\n`;
        description += `**ISP:** ${geo.isp}\n`;
        description += `**ASN:** ${geo.asn}\n`;
        description += `**VPN Status:** ${geo.vpnStatus}\n`;
        description += `**Confidence:** ${geo.confidence}%\n`;
        description += `**Details:** ${geo.vpnDetails}\n`;

        // Add origin IP if detected
        if (geo.originIP && geo.originIP !== ip) {
            description += `**🔍 Origin IP:** ${geo.originIP} (Confidence: ${geo.originConfidence}%)\n`;
            if (geo.possibleOrigins && geo.possibleOrigins.length > 0) {
                const headers = geo.possibleOrigins.map(o => `${o.header} (${o.description})`).join(', ');
                description += `**📋 Headers:** ${headers}\n`;
            }
        } else if (geo.originIP === ip) {
            description += `**🔍 Origin IP:** Same as current (No proxy detected)\n`;
        }

        description += `**UA:** ${userAgent}\n`;
        description += `**Time:** ${timestamp}`;
        if (discordUserId) {
            description += `\n**Discord ID:** ${discordUserId}`;
        }

        const embed = {
            title: "👀 New Portfolio Visit",
            color: geo.color,
            description,
            footer: {
                text: `Confidence: ${geo.confidence}% | Origin: ${geo.originIP || 'Unknown'} | Matched: ${geo.matchedKeywords.join(', ') || 'None'}`
            }
        };

        // Send to Discord
        try {
            await sendToDiscord({ content: "New visitor detected", embeds: [embed] });
        } catch (discordError) {
            console.error("Discord send error:", discordError);
        }

        // Log detection for debugging
        console.log(`Complete Detection for ${ip}:`, {
            vpnStatus: geo.vpnStatus,
            originIP: geo.originIP,
            originConfidence: geo.originConfidence,
            possibleOrigins: geo.possibleOrigins,
            isp: geo.isp,
            asn: geo.asn,
            confidence: geo.confidence
        });

        return new Response(JSON.stringify({
            ok: true,
            vpnStatus: geo.vpnStatus,
            vpnDetails: geo.vpnDetails,
            isp: geo.isp,
            asn: geo.asn,
            confidence: geo.confidence,
            isAstrill: geo.vpnStatus.includes("ASTRIL"),
            originIP: geo.originIP,
            originConfidence: geo.originConfidence,
            possibleOrigins: geo.possibleOrigins
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