"use strict";

const https = require("https");

function httpJson(url, token) {
	return new Promise((resolve, reject) => {
		const options = new URL(url);
		options.headers = {
			"User-Agent": "bin-to-photos/1.0",
			"Accept": "application/vnd.github+json",
		};
		if (token) options.headers["Authorization"] = `Bearer ${token}`;
		const req = https.request(options, (res) => {
			let data = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (data += c));
			res.on("end", () => {
				try {
					resolve(JSON.parse(data));
				} catch (e) {
					resolve(null);
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(15000, () => req.destroy(new Error("timeout")));
		req.end();
	});
}

function patchJson(url, token, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const options = {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + (u.search || ""),
            method: "PATCH",
            headers: {
                "User-Agent": "bin-to-photos/1.0",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
            },
        };
        if (token) options.headers["Authorization"] = `Bearer ${token}`;
        const req = https.request(options, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
        try { req.write(JSON.stringify(body || {})); } catch {}
        req.end();
    });
}

function postJson(url, token, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const options = {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname + (u.search || ""),
            method: "POST",
            headers: {
                "User-Agent": "bin-to-photos/1.0",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
            },
        };
        if (token) options.headers["Authorization"] = `Bearer ${token}`;
        const req = https.request(options, (res) => {
            let data = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (data += c));
            res.on("end", () => {
                try { resolve(JSON.parse(data)); } catch { resolve(null); }
            });
        });
        req.on("error", reject);
        req.setTimeout(15000, () => req.destroy(new Error("timeout")));
        try { req.write(JSON.stringify(body || {})); } catch {}
        req.end();
    });
}

function parseBinAndUrlsFromText(text) {
	if (!text || typeof text !== "string") return null;
	const binMatch = text.match(/\b(\d{6})\b/);
	if (!binMatch) return null;

	// 分来源拆分：
	// 1) 附件：来自 <img src="..."> 捕获到的链接
	// 2) 文本：正文中出现的 https 链接（排除已归为附件的）
	const attachRaw = [...text.matchAll(/src=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
	const textRaw = [...text.matchAll(/https?:\/\/[^\s)\]">]+/gi)].map((m) => m[0]);

	const attachClean = attachRaw.map(sanitizeUrl).filter(Boolean);
	const textClean = textRaw
		.map(sanitizeUrl)
		.filter(Boolean)
		// 屏蔽 GitHub Issue 页面链接（示例链接等非图片资源）
		.filter((u) => !isGithubIssueLink(u));

	// 去重并相互排除：优先将链接放入附件集合，再从文本集合剔除重复
	const seenAttach = new Set();
	const attachUrls = [];
	for (const u of attachClean) {
		const key = normalizeUrl(u);
		if (seenAttach.has(key)) continue;
		seenAttach.add(key);
		attachUrls.push(u);
	}
	const seenText = new Set();
	const textUrls = [];
	for (const u of textClean) {
		const key = normalizeUrl(u);
		if (seenAttach.has(key) || seenText.has(key)) continue;
		seenText.add(key);
		textUrls.push(u);
	}

	if (textUrls.length === 0 && attachUrls.length === 0) return null;
	return { bin: binMatch[1], textUrls, attachUrls };
}

function sanitizeUrl(u) {
	if (!u || typeof u !== "string") return null;
	let s = u.trim();
	// 去除常见结尾符
	s = s.replace(/[)\]>'".,;]+$/g, "");
	return s;
}

function normalizeUrl(u) {
	try {
		const url = new URL(u);
		url.hash = ""; // 忽略 hash
		return url.toString().toLowerCase();
	} catch {
		return (u || "").trim().toLowerCase();
	}
}

function tryGetHost(u) {
	try { return new URL(u).host.toLowerCase(); } catch { return null; }
}

function isGithubIssueLink(u) {
	try {
		const url = new URL(u);
		if (!/\bgithub\.com$/i.test(url.hostname)) return false;
		// 路径包含 /issues/ 即视为 Issue 页面链接（非附件、非直链图片）
		return /\/(issues|pull)\//i.test(url.pathname);
	} catch {
		return false;
	}
}

async function listIssues({ owner, repo, token, page = 1, per_page = 100 }) {
    let url = `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${per_page}&page=${page}`;
    return await httpJson(url, token);
}

async function listAllOpenIssues({ owner, repo, token, per_page = 100 }) {
    const all = [];
    let page = 1;
    // 无最大页限制，直到返回空数组为止
    while (true) {
        const batch = await listIssues({ owner, repo, token, page, per_page });
        if (!Array.isArray(batch) || batch.length === 0) break;
        all.push(...batch);
        page += 1;
    }
    return all;
}

async function getIssue({ owner, repo, number, token }) {
	const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
	return await httpJson(url, token);
}

async function closeIssue({ owner, repo, number, token }) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
    return await patchJson(url, token, { state: "closed" });
}

async function createIssueComment({ owner, repo, number, token, body }) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`;
    return await postJson(url, token, { body });
}

module.exports = { listIssues, listAllOpenIssues, getIssue, closeIssue, createIssueComment, parseBinAndUrlsFromText };


