const https = require("https");
const { URL } = require("url");

function getWebhookUrl(webhookUrl) {
    const resolvedWebhookUrl = webhookUrl || process.env.DISCORD_WEBHOOK_URL || process.env.WEBHOOK_URL;

    if (typeof resolvedWebhookUrl === "string" && resolvedWebhookUrl.trim()) {
        return resolvedWebhookUrl.trim();
    }

    throw new Error("DISCORD_WEBHOOK_URL is not configured");
}

async function sendToDiscord(payload, webhookUrl) {
    const resolvedWebhookUrl = getWebhookUrl(webhookUrl);
    const body = JSON.stringify(payload);

    if (typeof fetch === "function") {
        try {
            const response = await fetch(resolvedWebhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
            });

            const text = await response.text();
            if (!response.ok) {
                throw new Error(`Discord webhook failed: ${response.status} ${text}`);
            }

            return { ok: true };
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("Discord webhook failed")) {
                throw error;
            }

            throw new Error(`Discord webhook error: ${error.message}`);
        }
    }

    return new Promise((resolve, reject) => {
        const webhook = new URL(resolvedWebhookUrl);
        const requestOptions = {
            hostname: webhook.hostname,
            path: `${webhook.pathname}${webhook.search}`,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
        };

        const webhookReq = https.request(requestOptions, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ ok: true });
                } else {
                    reject(new Error(`Discord webhook failed: ${res.statusCode} ${data}`));
                }
            });
        });

        webhookReq.on("error", (error) => {
            reject(new Error(`Discord webhook error: ${error.message}`));
        });
        webhookReq.write(body);
        webhookReq.end();
    });
}

module.exports = { sendToDiscord };
