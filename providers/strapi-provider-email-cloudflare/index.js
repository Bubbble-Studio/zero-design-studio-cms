"use strict";

const https = require("node:https");

const DEFAULT_API_BASE_URL = "https://api.cloudflare.com/client/v4";

const isPresent = (value) => {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

const compact = (object) =>
  Object.entries(object).reduce((acc, [key, value]) => {
    if (isPresent(value)) acc[key] = value;
    return acc;
  }, {});

const normalizeAddress = (address) => {
  if (!address) return undefined;

  if (Array.isArray(address)) {
    return address.map(normalizeAddress).filter(Boolean);
  }

  if (typeof address === "object") {
    if (address.email) {
      return compact({ address: address.email, name: address.name });
    }

    if (address.address) {
      return compact({ address: address.address, name: address.name });
    }
  }

  return address;
};

const normalizeAttachmentContent = (content) => {
  if (!content) return undefined;
  if (Buffer.isBuffer(content)) return content.toString("base64");
  return content;
};

const normalizeAttachments = (attachments = []) => {
  if (!Array.isArray(attachments)) return undefined;

  return attachments
    .map((attachment) =>
      compact({
        content: normalizeAttachmentContent(attachment.content),
        filename: attachment.filename,
        type: attachment.type || attachment.contentType,
        disposition: attachment.disposition,
        content_id: attachment.contentId || attachment.cid,
      })
    )
    .filter((attachment) => attachment.content && attachment.filename);
};

const postJson = (urlString, apiToken, payload) =>
  new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const body = JSON.stringify(payload);

    const request = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks = [];

        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let data = null;

          try {
            data = raw ? JSON.parse(raw) : null;
          } catch (error) {
            reject(new Error(`Cloudflare email returned invalid JSON: ${raw}`));
            return;
          }

          resolve({ statusCode: response.statusCode, data });
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });

module.exports = {
  init(providerOptions = {}, settings = {}) {
    const { accountId, apiToken, apiBaseUrl = DEFAULT_API_BASE_URL } = providerOptions;

    return {
      async send(options = {}) {
        if (!accountId) {
          throw new Error("Cloudflare email provider missing accountId");
        }

        if (!apiToken) {
          throw new Error("Cloudflare email provider missing apiToken");
        }

        const to = normalizeAddress(options.to);
        const from = normalizeAddress(options.from || settings.defaultFrom);
        const replyTo = normalizeAddress(
          options.replyTo || options.reply_to || settings.defaultReplyTo
        );

        if (!to) {
          throw new Error("Cloudflare email provider missing recipient");
        }

        if (!from) {
          throw new Error("Cloudflare email provider missing sender");
        }

        const payload = compact({
          to,
          from,
          cc: normalizeAddress(options.cc),
          bcc: normalizeAddress(options.bcc),
          reply_to: replyTo,
          subject: options.subject,
          html: options.html,
          text: options.text,
          headers: options.headers,
          attachments: normalizeAttachments(options.attachments),
        });

        const endpoint = `${apiBaseUrl.replace(/\/$/, "")}/accounts/${accountId}/email/sending/send`;
        const response = await postJson(endpoint, apiToken, payload);

        if (
          response.statusCode < 200 ||
          response.statusCode >= 300 ||
          response.data?.success === false
        ) {
          const message = response.data?.errors?.[0]?.message || "unknown Cloudflare email error";
          throw new Error(`Cloudflare email failed: ${message}`);
        }

        return response.data;
      },
    };
  },
};

