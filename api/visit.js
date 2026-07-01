const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "https://discord.com/api/webhooks/1521512418675654696/gZFOV9bgnRR05-pqL1CeVI_T082BwKgUkXxrsE96Ym4nPfoKUKdojXeQiQi939G3VHY8";

function getClientIp(req) {
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

    return req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown";
}

async function sendToDiscord(payload) {
    const body = JSON.stringify(payload);
    const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Discord webhook failed: ${response.status} ${text}`);
    }
}

module.exports = async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ ok: false, error: "Method not allowed" });
        return;
    }

    try {
        const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
        const ip = getClientIp(req);
        const timestamp = new Date().toISOString();

        await sendToDiscord({
            content: "New portfolio visit",
            embeds: [
                {
                    title: "Visitor detected",
                    color: 5814783,
                    fields: [
                        { name: "IP", value: ip || "unknown" },
                        { name: "Path", value: body.path || req.url },
                        { name: "User Agent", value: body.userAgent || "unknown" },
                        { name: "Time", value: timestamp },
                    ],
                },
            ],
        });

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ ok: false, error: error.message });
    }
};
