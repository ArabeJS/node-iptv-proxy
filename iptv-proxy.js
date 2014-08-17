#!/usr/bin/env node

global.__base = __dirname + '/';

stream  = require('stream');
http    = require('http');
url     = require('url');

/* npm deps */
express = require('express');
git     = require('git-rev');
ffmpeg  = require('fluent-ffmpeg');
require('array.prototype.findindex');

/*
 * Process command line options, and load config file
 */
var binname = process.argv.shift();

if ((binname == 'node') || (binname == 'nodejs'))
        binname += ' ' + process.argv.shift();

var conf_file = undefined;
var port = undefined;

function usage(err) {
        console.log("Usage: " + binname + " [opts]");
        console.log("");
        console.log("   -h | --help             prints this help");
        console.log("   -c | --config <file>    load config from <file>");
        console.log("   -p | --port <number>    override listening port");
        console.log("");

        if (err) {
                console.log(err);
                console.log();
        }

        process.exit(0);
}

while ((opt = process.argv.shift()) != undefined) {
        switch (opt) {
        case '-h':
        case '--help':
                usage();

        case '-c':
        case '--config':
                conf_file = process.argv.shift();
                break;

        case '-p':
        case '--port':
                port = process.argv.shift();
                break;

        default:
                usage("Unrecognized option " + opt);
        }
}

/*
 * Load config
 */
if (!conf_file)
        usage("No config file selected");

config = require(require('fs').realpathSync(conf_file));

if (port)
        config.server.port = port;

/*
 * Load internal dependencies
 */
streams = require(__base + 'lib/stream-manager');
changlue = require(__base + 'lib/channels-glue');
httpu = require(__base + 'lib/http-utils');

/*
 * Setup and launch express webapp
 * Expose a number of endpoints and APIs
 */
var app = express();

app.set('json spaces', 2);

app.get('/', function (req, res) {
        res.send("node-iptv-proxy");
});

app.get('/list', function(req, res) {
        /* list available channels */
        res.json({ channels: Object.keys(config.channels) });
});

app.get('/playlist', function(req, res) {
        var playlist = "";

        res.header("Content-Type", "audio/x-mpegurl");

        playlist += '#EXTM3U\r\n';
        Object.keys(config.channels).map(function(val) {
                playlist += '#EXTINF:-1 tvg-name="' + val + '",' + val + '\r\n';
                playlist += 'http://' + req.headers['host'] + '/stream/' + val+ '\r\n';
        });

        res.send(playlist);
});

app.get('/version', function(req, res) {
        git.short(function(commit) {
                res.json({ version: commit });
        });
});

app.get('/admin/stats/debug', function(req, res) {

        /* reply with some useful info / statistics */
        res.json({
                streams: streams.current.map(function(el) {
                        return { id: el.id,
                                 clients: el.clients.map(function(el) {
                                        return httpu.get_stream_stats(el);
                                })
                        };
                })
        });
});

function get_client_stats() {
        var stats = [];

        function gen_client_stats(e) {
                return e.clients.map(function(el) {
                        var info = {};

                        if (el.client_type != 'http-sink')
                                return;

                        var transcode_info = new RegExp("trans-([^-]*)-(.*)").exec(e.id);

                        info.uuid = el.uuid;
                        if (transcode_info) {
                                info.chan = transcode_info[2];
                                info.type = "transcoded";
                                info.profile = transcode_info[1];
                        } else {
                                info.chan = e.id;
                                info.type = "direct";
                        }

                        info.http = httpu.get_stream_stats(el);
                        info.uptime = Math.round((Date.now() - el.client_added) / 1000);

                        stats.push(info);
                });
        }

        streams.current.map(gen_client_stats);

        return stats;
}

app.get('/admin/stats/clients', function(req, res) {
        res.json(get_client_stats());
});

app.delete('/admin/client/:uuid', function(req, res) {
        var found = null;

        streams.current.map(function(e) {
                e.clients.map(function(el) {
                        if (el.uuid != req.params.uuid)
                                return;

                        found = { chan: e.id, handle: el };
                });
        });

        if (!found) {
                res.send(404);
        } else {
                streams.killClient(found.chan, found.handle);

                res.send(200);
        }
});

app.get('/admin/client/:uuid', function(req, res) {
        var stat = get_client_stats().filter(function(el) {
                return (el.uuid == req.params.uuid);
        }).pop();

        if (!stat) {
                res.send(404);
        } else {
                res.json(stat);
        }
});

app.delete('/admin/chan/:chan', function(req, res) {
        if (!streams.hasChan(req.params.chan))
                res.send(404);

        streams.killChan(req.params.chan);
        res.send(200);
});

app.get('/transcode.:profile?/:chan', function(req, res) {
        if (!config.transcode) {
                res.send(404, "Transcoding not enabled");
                return;
        }

        var chan = req.params.chan;
        var profile = req.params.profile || config.transcode["default"];

        if (profile == "disable" || !config.transcode[profile]) {
                res.send(404, "Invalid profile");
                return;
        }

        console.log("TRANSCODE: " + chan + " " + profile);

        changlue.try_chan("trans-" + profile + "-" + chan, function(err, data) {
                /* check wether the channel is already being transcoded*/
                if (!err) {
                        res.set(data.stream.headers);
                        streams.addClient("trans-" + profile + "-" + chan, res, "http-sink");

                        return;
                }

                /* if not, grab the corresponding (uncompressed) source stream
                 * and fire up ffmpeg */
                changlue.get_chan(chan, function(err, data) {
                        if (err) {
                                res.send(503, "Failed to start stream (" + err + ")");
                                return;
                        }

                        var sourceStream = data.stream;
                        var fakeClient = new (stream.PassThrough)({allowHalfOpen: false});
                        var transcodedChan = new (stream.PassThrough)();

                        res.writeHead(200, sourceStream.headers);

                        /* register fake (internal) client on source stream */
                        streams.addClient(chan, fakeClient, "transcode-" + profile);

                        /* register new transcoding channel and attach actual client to it */
                        streams.addChan("trans-" + profile + "-" + chan,
                                        transcodedChan, sourceStream.headers,
                                        function() {
                                                fakeClient.end();

                                                /* FIXME: hackish, for some reason end
                                                 *  doesn't always trigger this */
                                                streams.killClient(chan, fakeClient);
                                        });
                        streams.addClient("trans-" + profile + "-" + chan, res, "http-sink");

                        /* start encoding */
                        config.transcode[profile](new ffmpeg({ source: fakeClient }))
                                .fromFormat('mpegts')
                                .toFormat('mpegts')
                                .on('error', function (e) {
                                        console.log("FFMPEG_ERRROR: " + e.message);

                                        res.end();
                                        streams.killChan("trans-" + profile + "-" + chan);
                                })
                                .writeToStream(transcodedChan);
                });
        });
});

app.get('/stream/:chan', function(req, res) {
        var chan = req.params.chan;

        changlue.get_chan(chan, function(err, data) {
                if (err == "NotFound") {
                        res.send(404, "not found");
                        return;
                } else if (err) {
                        res.send(503, "Failed to start stream");
                        return;
                }

                res.set(data.stream.headers);
                streams.addClient(chan, res, "http-sink");
        });
});

app.listen(config.server.port);
