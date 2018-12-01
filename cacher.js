const settings = require("./settings.json");

const sqlite3 = require('sqlite3');
const mm = require('music-metadata');
const fs = require("fs");
const pathutil = require("path");
const crypto = require("crypto");

var db = new sqlite3.Database(settings.db);

// this API is so ass backwards god i hate the hell out of it

db.serialize(function() {
	db.run("DROP TABLE IF EXISTS music_fts");
	db.run("CREATE VIRTUAL TABLE music_fts USING fts5(title, artist, album, genre, duration, bitrate, path, mtime, artist_hash, album_hash, path_hash);");
});

function readThroughDir(path) {
	console.log(`checking ${path}`)
	fs.stat(path, function(err, stats) {
		if(err) {
			console.log(err);
			return;
		}

		if(stats.isDirectory()) {
			fs.readdir(path, function(err, files) {
				if(err) {
					console.log(err);
					return;
				}

				for(let x in files) {
					let r = files[x];
					console.log(`${path}/${r}`);

					readThroughDir(`${path}/${r}`);
				}				
			});
		} else {
			parseForDatabase(path);
		}
	});
}

function parseForDatabase(path) {
	if(settings.allowed_exts.indexOf(pathutil.extname(path).substr(1)) == -1) {
		return;
	}

	mm.parseFile(path, {native: false, skipCovers: true})
		.then(function(metadata) {
			fs.stat(path, function(err, stats) {
				metadata.common["mtime"] = Math.floor(stats.mtimeMs/1000)
				modDatabase(path, metadata);
			});
		})
		.catch(function(err) {
			console.log(err);
		});
}

function modDatabase(path, metadata) {
	let values = [
		(metadata.common.title || path.substr(path.lastIndexOf("/") + 1)),
		(metadata.common.artist || "Unknown Artist"),
		(metadata.common.album || "Unknown Album"),
		(metadata.common.genre === undefined ? "" : metadata.common.genre.join(", ")),
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

fs.readdir(settings.dirs.music, function(err, files) {
	if(err) {
		console.log(err);
		return;
	}

	for(let x in files) {
		let path = files[x];
		console.log(`${settings.dirs.music}/${path}`);

		readThroughDir(`${settings.dirs.music}/${path}`);
	}
})
