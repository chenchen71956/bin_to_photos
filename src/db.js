"use strict";

const fs = require("fs");
const path = require("path");
let Database;
try {
	Database = require("better-sqlite3");
} catch {}

const DEFAULT_DB_DIR = path.join(__dirname, "..", "data");
let DB_PATH = path.join(DEFAULT_DB_DIR, "bin.db");

function ensureDirectoryExists(filePath) {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

function safeGetDb() {
	if (!Database) return null;
	ensureDirectoryExists(DB_PATH);
	const db = new Database(DB_PATH);
	try { db.pragma("journal_mode = WAL"); } catch {}
	try {
		// bin_photos：包含按来源分列的 URL
		db.exec(
			"CREATE TABLE IF NOT EXISTS bin_photos (" +
				"bin TEXT PRIMARY KEY, " +
				"photos_url TEXT, " +
				"text_urls TEXT, " +
				"attach_urls TEXT, " +
				"creat_at TEXT, " +
				"update_at TEXT" +
			")"
		);
		// gh_issues：记录已见过的 open issues（分来源存储）
		db.exec(
			"CREATE TABLE IF NOT EXISTS gh_issues (" +
				"owner TEXT NOT NULL, " +
				"repo TEXT NOT NULL, " +
				"number INTEGER NOT NULL, " +
				"title TEXT, " +
				"body TEXT, " +
				"state TEXT, " +
				"created_at TEXT, " +
				"updated_at TEXT, " +
				"parsed_bin TEXT, " +
				"text_urls TEXT, " +
				"attach_urls TEXT, " +
				"PRIMARY KEY(owner, repo, number)" +
			")"
		);
		// gh_votes：记录每一条投票
		db.exec(
			"CREATE TABLE IF NOT EXISTS gh_votes (" +
				"id INTEGER PRIMARY KEY AUTOINCREMENT, " +
				"owner TEXT NOT NULL, " +
				"repo TEXT NOT NULL, " +
				"number INTEGER NOT NULL, " +
				"user_id TEXT NOT NULL, " +
				"intent TEXT NOT NULL, " +
				"group_id INTEGER, " +
				"created_at TEXT" +
			")"
		);
	} catch {}
	return db;
}

function initDb(explicitPath) {
	if (explicitPath && typeof explicitPath === "string" && explicitPath.trim().length > 0) {
		DB_PATH = explicitPath.trim();
	}
	// 若首次 require 失败，这里再尝试一次（用于安装后重新启动的健壮性）
	if (!Database) {
		try { Database = require("better-sqlite3"); } catch {}
	}
	const db = safeGetDb();
	if (!db) return false;
	try { db.pragma("journal_mode = WAL"); } catch {}
	try { db.close(); } catch {}
	return true;
}

function setDbPath(p) {
	if (typeof p === "string" && p.trim().length > 0) {
		DB_PATH = p.trim();
	}
}

function parsePhotosUrl(raw) {
	if (!raw || typeof raw !== "string") return [];
	const s = raw.trim();
	if (s.startsWith("[") && s.endsWith("]")) {
		try {
			const list = JSON.parse(s);
			return Array.isArray(list)
				? list.map((u) => String(u).trim()).filter((u) => u.length > 0)
				: [];
		} catch {}
	}
	return s
		.split(/[\n,;]+/)
		.map((u) => u.trim())
		.filter((u) => u.length > 0);
}

function getBinPhotos(bin) {
	if (!bin) return [];
	const db = safeGetDb();
	if (!db) return [];
	try {
        const row = db.prepare("SELECT photos_url, text_urls, attach_urls FROM bin_photos WHERE bin = ?").get(String(bin));
        if (!row) return [];
        const legacy = row.photos_url ? parsePhotosUrl(row.photos_url) : [];
        let textList = [];
        let attachList = [];
        try { textList = row.text_urls ? parsePhotosUrl(row.text_urls) : []; } catch {}
        try { attachList = row.attach_urls ? parsePhotosUrl(row.attach_urls) : []; } catch {}

        // 优先策略：有附件仅用附件；无附件则用文本；都没有再用旧字段
        const pick = attachList.length > 0 ? attachList : (textList.length > 0 ? textList : legacy);
        const seen = new Set();
        const result = [];
        for (const u of pick) {
            const k = String(u).trim();
            if (!k || seen.has(k)) continue;
            seen.add(k);
            result.push(k);
        }
        return result;
	} catch {
		return [];
	} finally {
		try { db.close(); } catch {}
	}
}

function upsertBinPhotos(bin, urls) {
	if (!bin) return false;
	const incomingList = Array.isArray(urls) ? urls : (typeof urls === "string" ? parsePhotosUrl(urls) : []);
	const newUrls = incomingList.map((u) => String(u).trim()).filter((u) => u.length > 0);
	if (newUrls.length === 0) return false;

	const now = new Date().toISOString();
	const db = safeGetDb();
	if (!db) return false;
	try {
		const binStr = String(bin);
		const row = db.prepare("SELECT text_urls FROM bin_photos WHERE bin = ?").get(binStr);
		const existingText = row && row.text_urls ? parsePhotosUrl(row.text_urls) : [];
		const seen = new Set();
		const mergedText = [];
		for (const u of existingText) {
			const key = u.trim(); if (!key || seen.has(key)) continue; seen.add(key); mergedText.push(key);
		}
		for (const u of newUrls) {
			const key = u.trim(); if (!key || seen.has(key)) continue; seen.add(key); mergedText.push(key);
		}
		const textJson = JSON.stringify(mergedText);
		if (row) {
			db.prepare("UPDATE bin_photos SET text_urls = ?, update_at = ? WHERE bin = ?").run(textJson, now, binStr);
		} else {
			db.prepare("INSERT INTO bin_photos (bin, text_urls, creat_at, update_at) VALUES (?, ?, ?, ?)")
				.run(binStr, textJson, now, now);
		}
		return true;
	} catch {
		return false;
	} finally {
		try { db.close(); } catch {}
	}
}

function upsertBinPhotosSplit(bin, textUrls, attachUrls) {
	if (!bin) return false;
	const textList = Array.isArray(textUrls) ? textUrls : (typeof textUrls === "string" ? parsePhotosUrl(textUrls) : []);
	const attachList = Array.isArray(attachUrls) ? attachUrls : (typeof attachUrls === "string" ? parsePhotosUrl(attachUrls) : []);
	const now = new Date().toISOString();
	const db = safeGetDb();
	if (!db) return false;
	try {
		const binStr = String(bin);
		const row = db.prepare("SELECT text_urls, attach_urls FROM bin_photos WHERE bin = ?").get(binStr);
		const existingText = row && row.text_urls ? parsePhotosUrl(row.text_urls) : [];
		const existingAttach = row && row.attach_urls ? parsePhotosUrl(row.attach_urls) : [];

		const mergeUnique = (base, incoming) => {
			const seen = new Set();
			const merged = [];
			for (const u of base) {
				const k = String(u).trim(); if (!k || seen.has(k)) continue; seen.add(k); merged.push(k);
			}
			for (const u of incoming) {
				const k = String(u).trim(); if (!k || seen.has(k)) continue; seen.add(k); merged.push(k);
			}
			return merged;
		};

		const mergedText = mergeUnique(existingText, textList);
		const mergedAttach = mergeUnique(existingAttach, attachList);

		if (row) {
			db.prepare("UPDATE bin_photos SET text_urls = ?, attach_urls = ?, update_at = ? WHERE bin = ?")
				.run(JSON.stringify(mergedText), JSON.stringify(mergedAttach), now, binStr);
		} else {
			db.prepare("INSERT INTO bin_photos (bin, text_urls, attach_urls, creat_at, update_at) VALUES (?, ?, ?, ?, ?)")
				.run(binStr, JSON.stringify(mergedText), JSON.stringify(mergedAttach), now, now);
		}
		return true;
	} catch {
		return false;
	} finally {
		try { db.close(); } catch {}
	}
}

function hasIssue(owner, repo, number) {
	const db = safeGetDb();
	if (!db) return false;
	try {
		const row = db.prepare("SELECT 1 FROM gh_issues WHERE owner = ? AND repo = ? AND number = ?").get(String(owner), String(repo), Number(number));
		return !!row;
	} catch {
		return false;
	} finally {
		try { db.close(); } catch {}
	}
}

function insertIssueIfNew(params) {
	const { owner, repo, number, title, body, state, created_at, updated_at, parsed_bin, text_urls, attach_urls } = params || {};
	const db = safeGetDb();
	if (!db) return false;
	try {
		const textJson = Array.isArray(text_urls) ? JSON.stringify(text_urls) : (typeof text_urls === "string" ? text_urls : null);
		const attachJson = Array.isArray(attach_urls) ? JSON.stringify(attach_urls) : (typeof attach_urls === "string" ? attach_urls : null);
		const stmt = db.prepare(
			"INSERT OR IGNORE INTO gh_issues (owner, repo, number, title, body, state, created_at, updated_at, parsed_bin, text_urls, attach_urls) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
		);
		const res = stmt.run(String(owner), String(repo), Number(number), title || null, body || null, state || null, created_at || null, updated_at || null, parsed_bin || null, textJson, attachJson);
		return res && res.changes > 0;
	} catch {
		return false;
	} finally {
		try { db.close(); } catch {}
	}
}

function insertVoteRecord({ owner, repo, number, user_id, intent, group_id }) {
    const db = safeGetDb();
    if (!db) return false;
    try {
        const now = new Date().toISOString();
        const stmt = db.prepare(
            "INSERT INTO gh_votes (owner, repo, number, user_id, intent, group_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        );
        const res = stmt.run(String(owner), String(repo), Number(number), String(user_id), String(intent), group_id ? Number(group_id) : null, now);
        return !!(res && res.changes > 0);
    } catch {
        return false;
    } finally {
        try { db.close(); } catch {}
    }
}

function getIssueRecord(owner, repo, number) {
    const db = safeGetDb();
    if (!db) return null;
    try {
        const row = db.prepare("SELECT owner, repo, number, title, body, parsed_bin, text_urls, attach_urls FROM gh_issues WHERE owner = ? AND repo = ? AND number = ?")
            .get(String(owner), String(repo), Number(number));
        if (!row) return null;
        let text = [];
        let attach = [];
        try { text = row.text_urls ? parsePhotosUrl(row.text_urls) : []; } catch {}
        try { attach = row.attach_urls ? parsePhotosUrl(row.attach_urls) : []; } catch {}
        return { owner: row.owner, repo: row.repo, number: row.number, title: row.title, body: row.body, bin: row.parsed_bin, textUrls: text, attachUrls: attach };
    } catch {
        return null;
    } finally {
        try { db.close(); } catch {}
    }
}

module.exports = { getBinPhotos, DB_PATH, initDb, setDbPath, upsertBinPhotos, upsertBinPhotosSplit, hasIssue, insertIssueIfNew, getIssueRecord, insertVoteRecord };


