"use strict";

const https = require("https");
const http = require("http");
const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });
let printedProxyHint = false;

function pickProxyAgentFor(targetUrl) {
	const rawProxy = process.env.IMG_PROXY_URL || process.env.TELEGRAM_PROXY_URL || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
	if (!rawProxy) return null;
	try {
		const p = new URL(rawProxy);
		const proto = (p.protocol || "").toLowerCase();
		if (!printedProxyHint) { try { console.log(`[HTTP] 使用代理下载图片: ${p.protocol}//${p.hostname}${p.port ? ":" + p.port : ""}`); } catch {} printedProxyHint = true; }
		if (proto.startsWith("socks")) {
			try {
				const { SocksProxyAgent } = require("socks-proxy-agent");
				return new SocksProxyAgent(rawProxy);
			} catch {}
		} else if (proto.startsWith("http")) {
			try {
				const { HttpsProxyAgent } = require("https-proxy-agent");
				return new HttpsProxyAgent(rawProxy);
			} catch {}
		}
	} catch {}
	return null;
}
const { URL } = require("url");

function buildRequestUrl(bin) {
	const base = "https://lingchenxi.top/Bincheck/banklist.php";
	const url = new URL(base);
	url.searchParams.set("bin", bin);
	return url.toString();
}

function httpGetJson(url) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, (res) => {
			let data = "";
			res.setEncoding("utf8");

			res.on("data", (chunk) => {
				data += chunk;
			});

			res.on("end", () => {
				const status = res.statusCode || 0;
				if (status < 200 || status >= 300) {
					return reject(new Error(`HTTP ${status}: ${data?.slice(0, 200) || ""}`));
				}
				try {
					const json = JSON.parse(data);
					resolve(json);
				} catch (err) {
					resolve(data);
				}
			});
		});

		req.on("error", (err) => reject(err));
		req.setTimeout(15000, () => {
			req.destroy(new Error("Request timed out"));
		});
	});
}

async function checkBin(bin) {
	const url = buildRequestUrl(bin);
	return httpGetJson(url);
}

function httpGetBuffer(url) {
	function fetchOnce(u, redirectsLeft) {
		return new Promise((resolve, reject) => {
			let mod = https;
			let agent = httpsAgent;
			let options;
			try {
				const parsed = new URL(u);
				mod = parsed.protocol === "http:" ? http : https;
				const proxyAgent = pickProxyAgentFor(u);
				agent = proxyAgent || (parsed.protocol === "http:" ? httpAgent : httpsAgent);
				options = {
					protocol: parsed.protocol,
					hostname: parsed.hostname,
					port: parsed.port || (parsed.protocol === "http:" ? 80 : 443),
					path: parsed.pathname + (parsed.search || ""),
					headers: { "User-Agent": "bin-to-photos/1.0", "Accept": "image/*", "Connection": "keep-alive" },
					agent,
				};
			} catch {
				options = u;
			}
			const req = mod.get(options, (res) => {
				const status = res.statusCode || 0;
				// 处理重定向
				if ([301, 302, 303, 307, 308].includes(status)) {
					const loc = res.headers && (res.headers.location || res.headers.Location);
					if (loc && redirectsLeft > 0) {
						res.resume();
						let nextUrl = loc;
						try { nextUrl = new URL(loc, u).toString(); } catch {}
						return resolve(fetchOnce(nextUrl, redirectsLeft - 1));
					}
					return reject(new Error(`HTTP redirect without location or too many redirects (${status})`));
				}

				if (status < 200 || status >= 300) {
					let data = Buffer.alloc(0);
					res.on("data", (chunk) => {
						const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
						data = Buffer.concat([data, b]);
					});
					res.on("end", () => reject(new Error(`HTTP ${status}: ${data.toString("utf8").slice(0, 200)}`)));
					return;
				}

			const chunks = [];
				res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
				res.on("end", () => resolve(Buffer.concat(chunks)));
			});
			req.on("error", (err) => reject(err));
		req.setTimeout(20000, () => req.destroy(new Error("Request timed out")));
		});
	}

	return fetchOnce(url, 5);
}

module.exports = { buildRequestUrl, httpGetJson, checkBin, httpGetBuffer };


