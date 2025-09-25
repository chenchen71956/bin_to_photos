"use strict";

const https = require("https");
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
			const req = https.get(u, (res) => {
				const status = res.statusCode || 0;
				// 处理重定向
				if ([301, 302, 303, 307, 308].includes(status)) {
					const loc = res.headers && (res.headers.location || res.headers.Location);
					if (loc && redirectsLeft > 0) {
						res.resume();
						return resolve(fetchOnce(loc, redirectsLeft - 1));
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


