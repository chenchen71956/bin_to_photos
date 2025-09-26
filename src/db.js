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
        // bin_photos：仅保留投票集合与时间字段，简洁初始化
        db.exec(
            "CREATE TABLE IF NOT EXISTS bin_photos (" +
                "bin TEXT PRIMARY KEY, " +
                "voted_urls TEXT, " +
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
        // tg_polls：记录 Telegram 投票与选项映射
		db.exec(
			"CREATE TABLE IF NOT EXISTS tg_polls (" +
				"poll_id TEXT PRIMARY KEY, " +
				"owner TEXT NOT NULL, " +
				"repo TEXT NOT NULL, " +
				"number INTEGER NOT NULL, " +
				"bin TEXT, " +
				"chat_id TEXT, " +
				"message_id INTEGER, " +
				"options_json TEXT, " +
				"created_at TEXT, " +
				"finalized INTEGER DEFAULT 0" +
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
        const row = db.prepare("SELECT voted_urls FROM bin_photos WHERE bin = ?").get(String(bin));
        if (!row || !row.voted_urls) return [];
        // 不做去重，按集合原样返回
        return parsePhotosUrl(row.voted_urls);
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

function replaceBinPhotos(bin, urls) {
    if (!bin) return false;
    const list = Array.isArray(urls) ? urls : (typeof urls === "string" ? parsePhotosUrl(urls) : []);
    const now = new Date().toISOString();
    const db = safeGetDb();
    if (!db) return false;
    try {
        const binStr = String(bin);
        const votedJson = JSON.stringify(list.map((u) => String(u).trim()).filter((u) => u.length > 0));
        const exists = db.prepare("SELECT 1 FROM bin_photos WHERE bin = ?").get(binStr);
        if (exists) {
            db.prepare("UPDATE bin_photos SET voted_urls = ?, update_at = ? WHERE bin = ?")
              .run(votedJson, now, binStr);
        } else {
            db.prepare("INSERT INTO bin_photos (bin, voted_urls, creat_at, update_at) VALUES (?, ?, ?, ?)")
              .run(binStr, votedJson, now, now);
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

function insertTgPollMapping({ poll_id, owner, repo, number, bin, chat_id, message_id, options }) {
    const db = safeGetDb();
    if (!db) return false;
    try {
        const now = new Date().toISOString();
        const optionsJson = Array.isArray(options) ? JSON.stringify(options) : String(options || "");
        const stmt = db.prepare(
            "INSERT OR REPLACE INTO tg_polls (poll_id, owner, repo, number, bin, chat_id, message_id, options_json, created_at, finalized) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT finalized FROM tg_polls WHERE poll_id = ?), 0))"
        );
        const res = stmt.run(String(poll_id), String(owner), String(repo), Number(number), bin ? String(bin) : null, String(chat_id), Number(message_id || 0), optionsJson, now, String(poll_id));
        return !!(res && res.changes > 0);
    } catch {
        return false;
    } finally {
        try { db.close(); } catch {}
    }
}

function getTgPollById(poll_id) {
    const db = safeGetDb();
    if (!db) return null;
    try {
        const row = db.prepare("SELECT poll_id, owner, repo, number, bin, chat_id, message_id, options_json, finalized FROM tg_polls WHERE poll_id = ?")
            .get(String(poll_id));
        return row || null;
    } catch {
        return null;
    } finally {
        try { db.close(); } catch {}
    }
}

function finalizeTgPoll(poll_id) {
    const db = safeGetDb();
    if (!db) return false;
    try {
        const res = db.prepare("UPDATE tg_polls SET finalized = 1 WHERE poll_id = ?").run(String(poll_id));
        return !!(res && res.changes > 0);
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

module.exports = { getBinPhotos, DB_PATH, initDb, setDbPath, upsertBinPhotos, upsertBinPhotosSplit, replaceBinPhotos, hasIssue, insertIssueIfNew, insertTgPollMapping, getTgPollById, finalizeTgPoll };


