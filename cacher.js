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
	db.run("CREATE VIRTUAL TABLE music_fts USING fts5(title, artist, album, genre, duration, bitrate, path, title_hash, artist_hash, album_hash, path_hash);");
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
					console.log(`${path}\\${r}`);

					readThroughDir(`${path}\\${r}`);
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

	mm.parseFile(path, {native: true})
		.then(function(metadata) {
			modDatabase(path, metadata);
		})
		.catch(function(err) {
			console.log(err);
		});
}

function modDatabase(path, metadata) {
	values = [
		metadata.common.title,
		metadata.common.artist,
		metadata.common.album,
		(metadata.common.genre === undefined ? "" : metadata.common.genre.join(", ")),
		Math.ceil(metadata.format.duration),
		Math.floor(metadata.format.bitrate/1000),
		path.replace(settings.dirs.music, "")
	];

	let values_ex = values.concat([
		"3" + crypto.createHash("sha224").update(values[0]).digest("hex"),
		"1" + crypto.createHash("sha224").update(values[1]).digest("hex"),
		"2" + crypto.createHash("sha224").update(values[2]).digest("hex"),
		"4" + crypto.createHash("sha224").update(values[6]).digest("hex")
	]);


	db.serialize(function() {
		db.run("INSERT INTO music_fts (title, artist, album, genre, duration, bitrate, path, title_hash, artist_hash, album_hash, path_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", values_ex);
	});
}

fs.readdir(settings.dirs.music, function(err, files) {
	if(err) {
		console.log(err);
		return;
	}

	for(let x in files) {
		let path = files[x];
		console.log(`${settings.dirs.music}\\${path}`);

		readThroughDir(`${settings.dirs.music}\\${path}`);
	}
})
