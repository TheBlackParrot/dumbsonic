const settings = require("./settings.json");

const xml = require('xml');
const http = require('http');
const url = require('url');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const ffmpegStatic = require('ffmpeg-static');
process.env['FFMPEG_PATH'] = ffmpegStatic.path;
process.env['FFPROBE_PATH'] = ffmpegStatic.path.replace("ffmpeg", "ffprobe");
const ffmpeg = require('fluent-ffmpeg');
const sharp = require("sharp");
sharp.cache(false);
sharp.concurrency(1);
const fs = require("fs");

var db = new sqlite3.Database(settings.db);

/*
	SIDENOTE: I do **NOT** condone the use of MD5 being used as a cryptographic hash algorithm. Yell at the Subsonic developers to switch to a more robust hash algorithm.
*/

const defaultResponse = {
	"subsonic-response": [
		{
			_attr: {
				xmlns: settings.restapi,
				status: "ok",
				version: "1.16.1"
			}
		}
	]
};

function tryAlbumArt(folder, res, at) {
	let cover = `${folder}/${settings.art.files[at]}`;
	//console.log(`trying ${cover}`);
	
	fs.access(cover, fs.constants.R_OK, function(err) {
		if(!err) {
			sharp(cover).resize(settings.art.size).jpeg({quality: 95}).toBuffer(function(err, data, info) {
				res.writeHead(200, {"Content-type": "image/jpeg"});
				res.write(data);

				if(typeof callback == "function") {
					callback(res);
				} else {
					res.end();
				}
			});
		} else {
			if(at >= settings.art.files.length - 1) {
				sharp({
					create: {
						width: 100,
						height: 100,
						channels: 3,
						background: {r: 64, g: 64, b: 64}
					}
				}).jpeg({quality: 95}).toBuffer(function(err, data, info) {
					res.writeHead(200, {"Content-type": "image/jpeg"});
					res.write(data);

					if(typeof callback == "function") {
						callback(res);
					} else {
						res.end();
					}
				});
			} else {
				tryAlbumArt(folder, res, (at + 1))
			}
		}
	})	
}

function reply(res, req, obj, callback) {
	let parsed = url.parse(req.url, true)
	let query = parsed.query;
	let path = parsed.pathname;

	let type = "xml";
	if("f" in query) {
		if(["xml", "json", "jsonp"].indexOf(query.f) != -1) {
			type = query.f;
		}
	}

	if(type == "json" || type == "jsonp") {
		// support still WIP, need to get stuff out of _attr objects!
		let newObj = {"subsonic-response": {}};

		for(let idx in obj["subsonic-response"]) {
			if(idx == 0) {
				continue;
			}

			let part = obj["subsonic-response"][idx];
			let keys = Object.keys(part);

			for(let idxx in keys) {
				let key = keys[idxx];
				newObj["subsonic-response"][key] = part[key];

				/*if(Array.isArray(part[key])) {
					console.log(`${key} is array`)
				}*/
			}
		}

		newObj["subsonic-response"]["status"] = obj["subsonic-response"][0]._attr.status;
		newObj["subsonic-response"]["version"] = obj["subsonic-response"][0]._attr.version;

		obj = newObj;
	}

	let ctype;
	let data;
	switch(type) {
		case "json":
			ctype = "application/json";
			data = JSON.stringify(obj);
			break;

		case "jsonp":
			ctype = "application/javascript";
			data = JSON.stringify(obj);
			if("callback" in query) {
				data = query.callback + "(" + data + ");";
				console.log(data);
			}
			break;

		default:
			ctype = "text/xml";
			data = xml(obj);
			break;
	}

	res.writeHead(200, {
		"Access-Control-Allow-Origin": "*",
		"Content-type": ctype
	});
	res.write(data);

	if(typeof callback == "function") {
		callback(res);
	} else {
		res.end();
	}	
}

funcs = {
	"/ping": function(req, res, callback) {
		reply(res, req, defaultResponse, callback);
	},

	"/getLicense": function(req, res, callback) {
		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			license: [
				{
					_attr: {
						valid: true,
						email: "null@localhost",
						licenseExpires: "9999-12-31T23:59:59"
					}
				}
			]
		});

		reply(res, req, obj, callback);
	},

	"/getIndexes": function(req, res, callback) {
		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			indexes: []
		});

		chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
		indexed = {};
		db.each("SELECT DISTINCT artist, artist_hash FROM music_fts", function(err, row) {
			let addingTo = "#";
			let char = row.artist[0].toUpperCase();
			if(chars.indexOf(char) != -1) {
				addingTo = char;
			}

			if(!(addingTo in indexed)) {
				indexed[addingTo] = [];
			}
			indexed[addingTo].push({
				id: row.artist_hash,
				name: row.artist
			});
		}, function() {
			let found = Object.keys(indexed).sort();
			for(let idx in found) {
				char = found[idx];
				let artists = indexed[char].sort();

				toAdd = {
					index: [
						{
							_attr: {
								name: char
							}
						}
					]
				};

				for(let idx in artists) {
					let data = artists[idx];

					toAdd["index"].push({
						artist: [
							{
								_attr: data
							}
						]
					});
				}

				obj["subsonic-response"][1]["indexes"].push(toAdd)
			}

			reply(res, req, obj, callback);
		});
	},

	/*"/getMusicFolders": function(req, res, callback) {
		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			musicFolders: []
		});

		db.serialize(function() {
			let musicFolders = obj["subsonic-response"][1]["musicFolders"];

			db.each("SELECT DISTINCT artist_hash, artist FROM music_fts", function(err, row) {
				musicFolders.push({
					musicFolder: [
						{
							_attr: {
								id: row.artist_hash,
								name: row.artist
							}
						}
					]
				})
			}, function() {
				reply(res, req, obj, callback);
			});
		})
	},*/

	"/getMusicDirectory": function(req, res, callback) {
		let parsed = url.parse(req.url, true)
		let query = parsed.query;
		let path = parsed.pathname;

		query.id = query.id.replace(/[^a-f0-9]/gi, "");
		//console.log(query.id);

		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			directory: [
				{
					_attr: {}
				}
			]
		});

		let mainPart = obj["subsonic-response"][1]["directory"];
		let children = [];

		// 1: artist
		// 2: album
		// 3: title
		let stage = query.id[0];
		let search = "";
		let where = "";
		let wants = "";
		let children_wants = "";

		switch(stage) {
			case "1":
				where = "artist_hash";
				search = "album_hash";
				wants = "artist"
				children_wants = "album"
				break;

			case "2":
				where = "album_hash";
				search = "path_hash";
				wants = "album";
				children_wants = "path";
				break;

			default:
				// letting fail to see
				break;
		}

		let seen = [];
		let attrs = {};

		/*
		<child id="200000717" album="Celebrity" title="Celebrity [2001]" name="Celebrity" isDir="true" coverArt="al-200000717" songCount="3" duration="663" artistId="100000281" parent="100000281" artist="" year="2001" genre="Pop"/>

		<child id="300001123" parent="200000717" title="Pop" isDir="false" isVideo="false" type="music" albumId="200000717" album="Celebrity" artistId="100000281" artist="*NSYNC" coverArt="200000717" duration="238" bitRate="320" track="1"
		year="2001" genre="Pop" size="9650661" suffix="mp3" contentType="audio/mpeg" path="_NSYNC/Celebrity/Pop.mp3" transcodedSuffix="ogg" transcodedContentType="application/ogg"/>
		*/

		db.serialize(function() {
			db.each(`SELECT * FROM music_fts WHERE ${where} MATCH ?`, "\"" + query.id + "\"", function(err, row) {
				if(!("id" in mainPart[0]["_attr"])) {
					mainPart[0]["_attr"] = {
						id: query.id,
						name: row[wants]
					};
				}

				if(seen.indexOf(row[children_wants + "_hash"]) != -1) {
					return;
				} else {
					seen.push(row[children_wants + "_hash"]);
				}

				switch(stage) {
					case "1":
						attrs = {
							id: row["album_hash"],
							album: row["album"],
							name: row["album"],
							title: row["album"],
							isDir: true,
							artistId: row["artist_hash"],
							parent: row["artist_hash"],
							artist: row["artist"],
							album: row["album"],
							coverArt: row["album_hash"]
						};
						break;

					case "2":
						attrs = {
							id: row["path_hash"],
							parent: row["album_hash"],
							title: row["title"],
							isDir: false,
							isVideo: false,
							type: "music",
							albumId: row["album_hash"],
							album: row["album"],
							artistId: row["artist_hash"],
							artist: row["artist"],
							bitRate: row["bitrate"],
							duration: row["duration"],
							genre: row["genre"],
							path: row["path"].substr(1),
							transcodedSuffix: settings.audio.container,
							transcodedContentType: settings.audio.mimetype,
							coverArt: row["album_hash"]
						}
						break;
				}

				mainPart.push({
					child: [
						{
							_attr: attrs
						}
					]
				});
			}, function() {
				//console.log(children);
				//console.log(mainPart);
				//console.log(obj);

				reply(res, req, obj, callback);
			});
		});
	},

	"/getArtistInfo": function(req, res, callback) {
		out = `<subsonic-response xmlns="${settings.restapi}" status="ok" version="1.16.1">
			<artistInfo>
				<biography>Unimplemented.</biography>
			</artistInfo>
		</subsonic-response>`;

		res.writeHead(200, {"Content-type": "text/xml"});
		res.write(out);

		if(typeof callback == "function") {
			callback(res);
		} else {
			res.end();
		}
	},

	"/getUser": function(req, res, callback) {
		out = `<user username="testuser" email="null@localhost" scrobblingEnabled="true" adminRole="false" settingsRole="true" downloadRole="true" playlistRole="true" coverArtRole="false" commentRole="false" podcastRole="false" streamRole="true" jukeboxRole="false" shareRole="false"/>`

		res.writeHead(200, {"Content-type": "text/xml"});
		res.write(out);

		if(typeof callback == "function") {
			callback(res);
		} else {
			res.end();
		}
	},

	"/stream": function(req, res, callback) {
		let parsed = url.parse(req.url, true)
		let query = parsed.query;
		let path = parsed.pathname;

		query.id = query.id.replace(/[^a-f0-9]/gi, "");
		//console.log(query.id);

		db.serialize(function() {
			db.get(`SELECT path FROM music_fts WHERE path_hash MATCH ?`, "\"" + query.id + "\"", function(err, row) {
				if(typeof row === "undefined") {
					funcs["error"](req, res, {code: 70, msg: "The requested data was not found."});
					return;
				}

				let path = settings.dirs.music + "/" + row.path.substr(1).replace(/\\/g, "/");
				//console.log(path);

				let ffCmd = new ffmpeg(path)
					.audioCodec(settings.audio.codec)
					.audioBitrate(settings.audio.bitrate)
					.audioFrequency(settings.audio.rate)
					.outputOptions(settings.audio.options)
					.format(settings.audio.container)
					.on('end', function() {
						//console.log(`finished transcoding ${path}`);
						if(typeof callback == "function") {
							callback(res);
						} else {
							res.end();
						}
					});

				res.writeHead(200, {"Content-type": settings.audio.mimetype});
				let stream = ffCmd.pipe();
				stream.on('data', function(chunk) {
					res.write(chunk)
				});
			});
		});
	},

	"/getPlaylists": function(req, res, callback) {
		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			playlists: [
				{
					playlist: [
						{
							_attr: {
								id: 1,
								name: "Entire Library",
								owner: "system",
								public: true
							}
						}
					]
				},

				{
					playlist: [
						{
							_attr: {
								id: 4,
								name: "Added Within 7 Days",
								owner: "system",
								public: true
							}
						}
					]
				},

				{
					playlist: [
						{
							_attr: {
								id: 2,
								name: "Added Within 30 Days",
								owner: "system",
								public: true
							}
						}
					]
				},

				{
					playlist: [
						{
							_attr: {
								id: 3,
								name: "Added Within 90 Days",
								owner: "system",
								public: true
							}
						}
					]
				}
			]
		});

		reply(res, req, obj, callback);
	},

	"/getPlaylist": function(req, res, callback) {
		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			playlist: [
				{
					_attr: {
						id: 1
					}
				}
			]
		});

		let parsed = url.parse(req.url, true)
		let query = parsed.query;
		let path = parsed.pathname;

		query.id = query.id.replace(/[^a-f0-9]/gi, "");
		//console.log(query.id);

		let sql = "";
		switch(query.id) {
			case "1":
			case "2":
			case "3":
			case "4":
				sql = `SELECT * FROM music_fts`;
				break;

			default:
				funcs["error"](req, res, {code: 70, msg: "The requested data was not found."});
				return;				
				break;
		}

		db.serialize(function() {
			let playlist = obj["subsonic-response"][1]["playlist"];

			db.each(sql, function(err, row) {
				if(query.id >= 2 || query.id <= 4) {
					let mtime = parseInt(row.mtime);
					
					let minimum;
					if(query.id == 2) {
						minimum = Math.floor(Date.now()/1000) - 2592000;
					} else if(query.id == 3) {
						minimum = Math.floor(Date.now()/1000) - 7776000;
					} else if(query.id == 4) {
						minimum = Math.floor(Date.now()/1000) - 604800;
					}

					if(mtime < minimum) {
						return;
					}
				}

				let path = settings.dirs.music + "/" + row.path.substr(1).replace(/\\/g, "/");

				playlist.push({
					entry: [
						{
							_attr: {
								id: row.path_hash,
								parent: row.album_hash,
								title: row.title,
								album: row.album,
								artist: row.artist,
								isDir: false,
								duration: row.duration,
								bitRate: row.bitrate,
								isVideo: false,
								path: path,
								albumId: row.album_hash,
								artistId: row.artist_hash,
								type: "music",
								coverArt: row.album_hash
							}
						}
					]
				})
			}, function() {
				reply(res, req, obj, callback);			
			});
		})
	},

	"/getCoverArt": function(req, res, callback) {
		let parsed = url.parse(req.url, true)
		let query = parsed.query;
		let path = parsed.pathname;

		query.id = query.id.replace(/[^a-f0-9]/gi, "");
		//console.log(query.id);

		let which = "";
		switch(query.id[0]) {
			case "2":
				which = "album_hash";
				break;

			case "3":
				which = "path_hash";
				break;

			default:
				funcs["error"](req, res, {code: 0, msg: "Unimplemented."});
				return;
				break;
		}

		db.serialize(function() {
			db.get(`SELECT * FROM music_fts WHERE ${which} MATCH ?`, "\"" + query.id + "\"", function(err, row) {
				if(typeof row === "undefined") {
					funcs["error"](req, res, {code: 70, msg: "The requested data was not found."});
					return;
				}

				let path = settings.dirs.music + "/" + row.path.substr(1).replace(/\\/g, "/");
				let folder = path.substr(0, path.lastIndexOf("/"));

				tryAlbumArt(folder, res, 0)
			})
		})
	},

	"/getRandomSongs": function(req, res, callback) {
		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			randomSongs: []
		});

		let parsed = url.parse(req.url, true)
		let query = parsed.query;

		if("size" in query) {
			size = parseInt(query.size.replace(/[^0-9]/gi, "") || 10);
		} else {
			size = 10;
		}

		db.serialize(function() {
			let list = obj["subsonic-response"][1]["randomSongs"];

			db.each(`SELECT * FROM music_fts ORDER BY RANDOM() LIMIT ?`, size, function(err, row) {
				let path = settings.dirs.music + "/" + row.path.substr(1).replace(/\\/g, "/");

				list.push({
					song: [
						{
							_attr: {
								id: row.path_hash,
								parent: row.album_hash,
								title: row.title,
								album: row.album,
								artist: row.artist,
								isDir: false,
								duration: row.duration,
								bitRate: row.bitrate,
								isVideo: false,
								path: path,
								albumId: row.album_hash,
								artistId: row.artist_hash,
								type: "music",
								coverArt: row.album_hash
							}
						}
					]
				})
			}, function() {
				reply(res, req, obj, callback);
			});
		})		
	},

	"/getAlbumList": function(req, res, callback) {
		let obj = JSON.parse(JSON.stringify(defaultResponse));
		obj["subsonic-response"].push({
			albumList: []
		});

		let parsed = url.parse(req.url, true)
		let query = parsed.query;

		if("size" in query) {
			size = parseInt(query.size.replace(/[^0-9]/gi, "") || 10);
		} else {
			size = 10;
		}

		if("offset" in query) {
			offset = parseInt(query.offset.replace(/[^0-9]/gi, "") || 0);
		} else {
			offset = 0;
		}

		let type = "alphabeticalByName";
		if("type" in query) {
			let allowedTypes = ["random", "newest", "alphabeticalByName"];
			if(allowedTypes.indexOf(query.type) != -1) {
				type = query.type;
			} else {
				reply(res, req, defaultResponse, callback);
				return;
			}
		} else {
			reply(res, req, defaultResponse, callback);
			return;
		}

		let order = ""
		switch(type) {
			case "newest":
				order = `ORDER BY mtime DESC LIMIT ? OFFSET ${offset}`;
				break;

			case "random":
				order = `ORDER BY RANDOM() LIMIT ?`;
				break;

			case "alphabeticalByName":
				order = `ORDER BY album ASC LIMIT ? OFFSET ${offset}`;
				break;
		}

		db.serialize(function() {
			let list = obj["subsonic-response"][1]["albumList"];

			db.each(`SELECT DISTINCT album_hash, artist_hash, album, artist FROM music_fts ${order}`, size, function(err, row) {
				list.push({
					album: [
						{
							_attr: {
								id: row.album_hash,
								parent: row.artist_hash,
								title: row.album,
								album: row.album,
								artist: row.artist,
								isDir: true,
								coverArt: row.album_hash
							}
						}
					]
				})
			}, function() {
				reply(res, req, obj, callback);			
			});
		})		
	},

	"error": function(req, res, err, callback) {
		obj = {
			"subsonic-response": [
				{
					_attr: {
						xmlns: settings.restapi,
						status: "failed",
						version: "1.16.1"
					}
				},

				{
					error: [
						{
							_attr: {
								code: err.code,
								message: err.msg
							}
						}
					]
				}
			]
		}

		reply(res, req, obj, callback);
	}
}

let nullify = [
	"/savePlaylistQueue",
	"/getPlayQueue",
	"/getBookmarks",
	"/getGenres",
	"/getStarred",
	"/getPodcasts",
	"/getMusicFolders"
];
for(idx in nullify) {
	funcs[nullify[idx]] = funcs["/ping"];
}

funcs["/getAlbumList2"] = funcs["/getAlbumList"];
for(page in funcs) {
	funcs[`${page}.view`] = funcs[page];
	funcs[`/rest${page}.view`] = funcs[page];

	nullify.push(`${page}.view`);
	nullify.push(`/rest${page}.view`);
}
//console.log(Object.keys(funcs));

var endReq = function(res) {
	res.end();
}

http.createServer(function(req, res) {
	//console.log(req);
	let parsed = url.parse(req.url, true)
	let query = parsed.query;
	let path = parsed.pathname;
	//console.log("\n\n");

	if(!(path in funcs)) {
		res.writeHead(404);
		res.end();
		return;
	}

	console.log(query);

	if(!(path in nullify)) {
		let safeQuery = Object.assign({}, query);
		if("p" in safeQuery) { delete safeQuery["p"]; }
		if("t" in safeQuery) { delete safeQuery["t"]; }
		if("s" in safeQuery) { delete safeQuery["s"]; }
		console.log({
			ip: req.connection.remoteAddress,
			time: Math.floor(Date.now() / 1000),
			func: path,
			query: safeQuery
		});
	}

	let callback = endReq;

	if(!(query.u in settings.login)) {
		//console.log("invalid username");

		funcs["error"](req, res, {code: 40, msg: "Wrong username or password."}, callback);
		return;
	} else {
		//console.log("valid username");

		if("p" in query) {
			let hex = Buffer.from(settings.login[query.u], 'utf8').toString('hex');

			if(query.p != "enc:" + hex) {
				//console.log("invalid password");

				funcs["error"](req, res, {code: 40, msg: "Wrong username or password."}, callback);
				return;
			} else {
				//console.log(`valid password, trying ${path}`);

				if(path in funcs) {
					funcs[path](req, res, callback);
					return;
				}			
			}
		} else if("t" in query && "s" in query) {
			let correctHash = crypto.createHash("md5").update(settings.login[query.u] + query.s).digest("hex");

			if(query.t == correctHash) {
				//console.log(`valid token, trying ${path}`);

				if(path in funcs) {
					funcs[path](req, res, callback);
					return;
				}				
			} else {
				//console.log("invalid token");

				funcs["error"](req, res, {code: 40, msg: "Wrong username or password."}, callback);
				return;
			}
		}
	}
}).listen(settings.addr.port, settings.addr.ip);