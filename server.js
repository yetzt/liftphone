#!/usr/bin/env node

// node modules
var fs = require("fs");
var path = require("path");

// node modules
var debug = require("debug")("liftphone");
var request = require("request");
var express = require("express");
var bodyparser = require("body-parser");

// check for config file
if (!fs.existsSync(path.resolve(__dirname, "config.js"))) console.error("config.js not found") || process.exit(1);

// load config
var config = require(path.resolve(__dirname, "config.js"));

// new instance of express
var app = new express();
app.disable("x-powered-by");
app.enable("trust proxy");

// activate body parser
app.use(bodyparser.urlencoded({extended: true}));

// load station data
var stations = JSON.parse(fs.readFileSync(path.resolve(__dirname, "stations.json")));

function fixstring(str){
	str = str.replace(/([0-9]+)\/([0-9]+)/,"$1 und $2");
	str = str.replace(/zu Bstg/,"zu Bahnsteig");
	str = str.replace(/UG/,"Untergeschoss");
	str = str.replace(/Hbf/,"Hauptbahnhof");
	str = str.replace(/Sächs Schweiz/,"Sächsische Schweiz");
	str = str.replace(/Vogtl/,"Vogtland");
	str = str.replace(/Oberpf/,"Oberpfalz");
	str = str.replace(/ob Bf/,"oberer Bahnhof");
	str = str.replace(/Pbf/,"Personenbahnhof");
	str = str.replace(/b Tegel/,"bei Tegel");
	return str;
}

function resolve(id, fn){
	// get status
	request({
		method: "GET",
		url: "https://adam.noncd.db.de/api/v1.0/facilities/"+id,
		headers: { "user-agent": "LiftPhone/1" },
	}, function(err, resp, data){
		if (err) return fn("Es ist leider ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.");
		if (resp.statusCode !== 200) return fn("Es ist leider ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.");
		try {
			data = JSON.parse(data);
		} catch (err) {
			return fn("Es ist leider ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.");
		}
		
		// check if station is cached
		if (stations.hasOwnProperty(data.stationnumber.toString())) {
			return fn(null, {
				station: stations[data.stationnumber.toString()],
				description: data.description,
				state: data.state
			});
		}
		
		// get station name
		request({
			method: "GET",
			url: "https://adam.noncd.db.de/api/v1.0/stations/"+data.stationnumber,
			headers: { "user-agent": "LiftPhone/1" },
		}, function(err, resp, sdata){
			if (err) return fn("Es ist leider ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.");
			if (resp.statusCode !== 200) return fn("Es ist leider ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.");
			try {
				sdata = JSON.parse(sdata);
			} catch (err) {
				return fn("Es ist leider ein Fehler aufgetreten. Bitte versuchen Sie es später erneut.");
			}
			
			return fn(null, {
				station: sdata.name,
				description: data.description || "Aufzug",
				state: data.state
			});
			
		});
		
	});
};

function answer(res, text){
	var message = [];
	message.push('<?xml version="1.0" encoding="UTF-8" ?>');
	message.push('<Response>');
	message.push('<Say voice="woman" language="de">'+text+'</Say>');		
	message.push('<Pause length="1"/>');
	message.push('<Gather action="https://liftphone.dsst.io/" method="post" numDigits="8">');
	message.push('<Say voice="woman" language="de">Wenn Sie einen weiteren Aufzug abfragen möchten, geben Sie bitte die Achtstellige Aufzugnummer ein.</Say>');
	message.push('</Gather>');
	message.push('<Say voice="woman" language="de">Auf wiederhören.</Say>');
	message.push('</Response>');
	res.set('Content-Type', 'text/xml');
	res.send(message.join("\n"));
	return;
};

// default twiml
app.get("/", function(req, res){
	res.send('<?xml version="1.0" encoding="UTF-8" ?>\n<Response>\n\t<Gather action="https://liftphone.dsst.io/" method="post" numDigits="8">\n\t\t<Say voice="woman" language="de">Bitte geben Sie die Achtstellige Aufzugnummer ein.</Say>\n\t</Gather>\n\t<Say voice="woman" language="de">Auf wiederhören.</Say>\n</Response>');
});

app.post("/", function(req, res){
	var id = null;
	if (req.params.hasOwnProperty("Digits")) id = req.params.Digits;
	else if (req.body.hasOwnProperty("Digits")) id = req.body.Digits;
	if (!id) return answer(res, "Es wurde leider keine Aufzugnummer eingegeben.");
	
	resolve(id, function(err, data){
		if (err) return answer(res, err);
		
		switch (data.state) {
			case "ACTIVE": var msg = "ist betriebsbereit."; break;
			case "INACTIVE": var msg = "ist leider defekt."; break;
			case "UNKNOWN": var msg = "ist unbekannt."; break;
		}
		return answer(res, data.description+" in "+data.station+" "+msg);
	});
});

// listen on socket or port
(function(app, config){
	// try for socket
	if (config.hasOwnProperty("socket")) {
		var mask = process.umask(0);
		(function(fn){
			fs.exists(config.socket, function(ex){
				if (!ex) return fn();
				debug("unlinking old socket %s", config.socket);
				fs.unlink(config.socket, function(err){
					if (err) return console.error("could not unlink old socket", config.socket) || process.exit(1);
					fn();
				});
			});
		})(function(){
			app.__server = app.listen(config.socket, function(err){
				if (err) return console.error("could not create socket", config.socket) || process.exit(1);
				if (mask) process.umask(mask);
				debug("server listening on socket %s", config.socket);
			});
		});
	// try for hostname and port
	} else if (config.hasOwnProperty("host") && (typeof config.host === "string") && (config.host !== "") && (config.host !== "*")) {
		app.__server = app.listen(config.port, config.host, function(err) {
			if (err) return console.error("could not bind to %s", [config.host, config.port].join(":")) || process.exit(1);
			debug("server listening on %s", [config.host, config.port].join(":"));
		});
	// try for port
	} else if (config.hasOwnProperty("port") && Number.isInteger(config.port)) {
		app.__server = app.listen(config.port, function(err) {
			if (err) return console.error("could not bind to *:%s", config.port) || process.exit(1);
			debug("server listening on *:%s", config.port);
		});
	// die 
	} else {
		return console.error("neither socket nor hostname/port provided") || process.exit(1);
	};
})(app, config);