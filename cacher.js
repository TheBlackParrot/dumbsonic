import settings from './settings.json' with { type: 'json' };

import sqlite3 from 'sqlite3';
import * as mm from 'music-metadata';
import * as fs from 'fs';
import * as pathutil from 'path';
import * as crypto from 'crypto';

const db = new sqlite3.Database(settings.db);

// this API is so ass backwards god i hate the hell out of it

db.serialize(function() {
	db.run("DROP TABLE IF EXISTS music_fts");
	db.run("CREATE VIRTUAL TABLE music_fts USING fts5(title, artist, album, genre, duration, bitrate, path, mtime, artist_hash, album_hash, path_hash);");
});

async function readThroughDir(path) {
	console.log(`checking ${path}`);
	const stats = await fs.promises.stat(path);

	if(stats.isDirectory()) {
		const files = await fs.promises.readdir(path);
		
		for(let x in files) {
			let r = files[x];
			console.log(`${path}/${r}`);

			await readThroughDir(`${path}/${r}`);
		}
	} else {
		await parseForDatabase(path);
	}
}

async function parseForDatabase(path) {
	if(settings.allowed_exts.indexOf(pathutil.extname(path).substring(1)) === -1) {
		return;
	}
	
	const metadata = await mm.parseFile(path, {native: false, skipCovers: true});
	const stats = await fs.promises.stat(path);

	metadata.common["mtime"] = Math.floor(stats.mtimeMs/1000);
	modDatabase(path, metadata);
}

function modDatabase(path, metadata) {
	let values = [
		(metadata.common.title || path.substring(path.lastIndexOf("/") + 1)),
		(metadata.common.artist || "Unknown Artist"),
		(metadata.common.album || "Unknown Album"),
		(metadata.common.genre === undefined ? " " : metadata.common.genre.join(", ")),
		Math.ceil(metadata.format.duration),
		Math.floor(metadata.format.bitrate/1000),
		path.replace(settings.dirs.music, ""),
		metadata.common.mtime
	];

	values = values.concat([
		"3" + crypto.createHash("sha224").update(values[6]).digest("hex"),
		"1" + crypto.createHash("sha224").update(values[1]).digest("hex"),
		"2" + crypto.createHash("sha224").update(values[2]).digest("hex")
	]);

	db.serialize(function() {
		db.run("INSERT INTO music_fts (title, artist, album, genre, duration, bitrate, path, mtime, path_hash, artist_hash, album_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", values);
		console.log(`added ${path}`);
	});
}

const files = await fs.promises.readdir(settings.dirs.music);
for(let x in files) {
	let path = files[x];
	console.log(`${settings.dirs.music}/${path}`);

	await readThroughDir(`${settings.dirs.music}/${path}`);
}
