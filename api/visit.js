import { sendToDiscord } from "./discord.js";

function getClientIp(req, context) {
    // Netlify Functions provide IP via context
    if (context?.clientContext?.sourceIp) {
        return context.clientContext.sourceIp;
    }

    // Fallback to headers for other platforms
    const headerCandidates = [
        req.headers["x-nf-client-connection-ip"],
        req.headers["cf-connecting-ip"],
        req.headers["x-forwarded-for"],
        req.headers["x-real-ip"],
        req.headers["client-ip"],
    ];

    for (const value of headerCandidates) {
        if (typeof value === "string") {
            const ip = value.split(",")[0].trim();
            if (ip) {
                return ip;
            }
        }
    }

    return "unknown";
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
        const userAgent = body.userAgent || req.headers["user-agent"] || "unknown";
        const pathField = body.path || pathValue || req.url;

        // Optional debug: include raw header candidates and context when DEBUG_VISIT=true
        const debugEnabled = String(process.env.DEBUG_VISIT || "").toLowerCase() === "true";
        let debugFields = [];
        if (debugEnabled) {
            const headerCandidates = {
                "x-nf-client-connection-ip": req.headers["x-nf-client-connection-ip"],
                "cf-connecting-ip": req.headers["cf-connecting-ip"],
                "x-forwarded-for": req.headers["x-forwarded-for"],
                "x-real-ip": req.headers["x-real-ip"],
                "client-ip": req.headers["client-ip"],
                "via": req.headers["via"],
                "host": req.headers["host"],
            };

            try {
                const headerDebug = Object.entries(headerCandidates)
                    .map(([k, v]) => `${k}: ${v || "(none)"}`)
                    .join("\n");

                debugFields.push({ name: "Raw IP headers", value: headerDebug.substring(0, 1024) });
            } catch (e) {
                // ignore
            }

            try {
                const ctx = context ? JSON.stringify(context).substring(0, 1024) : "(none)";
                debugFields.push({ name: "Context", value: ctx });
            } catch (e) {
                // ignore
            }
        }

        const embed = {
            title: "Visitor detected",
            color: 5814783,
            fields: [
                { name: "IP", value: ip || "unknown" },
                { name: "Path", value: String(pathField) },
                { name: "User Agent", value: String(userAgent) },
                { name: "Time", value: timestamp },
            ].concat(debugFields),
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
