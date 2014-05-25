var influxRequest = require('./lib/InfluxRequest.js');
var url = require('url');
var moment = require('moment');
var dgram = require('dgram');
var _ = require('underscore');

var InfluxDB = function(hosts, port, username, password, database, udp_write, udp_port, logFunction) {


    this.request = new influxRequest();

    this.options = {
        hosts: [],
        disabled_hosts: [],
        port: port || 8086,
        udp_write: false || udp_write,
        udp_port: 4444 || udp_port,
        username: username || 'root',
        password: password || 'root',
        database: database,
        depreciatedLogging: ((process.env.NODE_ENV === undefined || 'development') || logFunction) ? logFunction || console.log : false
    };

    if (this.options.udp_write)
        this.udp_socket = dgram.createSocket("udp4");

    if (!_.isArray(hosts) && 'string' === typeof hosts) {
        this.options.hosts = [hosts];
        this.request.addHost(hosts, this.options.port);
    }

    if (_.isArray(hosts)) {
        var self = this;
        self.options.hosts = hosts;
        _.each(hosts, function(host) {
            self.request.addHost(host, self.options.port);
        });
    }

    return this;
};

InfluxDB.prototype._parseCallback = function(callback) {
    return function(err, res, body) {
        if (err) {
            return callback(err);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
            return callback(new Error(body));
        }
        return callback(null, body);
    };
};

InfluxDB.prototype.setRequestTimeout = function(value) {
    return this.request.setRequestTimeout(value);
};

InfluxDB.prototype.setFailoverTimeout = function(value) {
    return this.request.setFailoverTimeout(value);
};


InfluxDB.prototype.url = function(database, query) {

    return url.format({
        pathname: database,
        query: _.extend({
            u: this.options.username,
            p: this.options.password
        }, query || {})
    });
};

InfluxDB.prototype.createDatabase = function(databaseName, callback) {
    this.request.post({
        url: this.url('db'),
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            name: databaseName
        }, null)
    }, this._parseCallback(callback));
};

InfluxDB.prototype.deleteDatabase = function(databaseName, callback) {
    this.request.get({
        method: 'DELETE',
        url: this.url('db/' + databaseName)
    }, this._parseCallback(callback));
};

InfluxDB.prototype.getDatabaseNames = function(callback) {
    this.request.get({
        url: this.url('db'),
        json: true
    }, this._parseCallback(function(err, dbs) {
        if (err) {
            return callback(err, dbs);
        }
        return callback(err, _.map(dbs, function(db) {
            return db.name;
        }));
    }));
};


InfluxDB.prototype.getSeriesNames = function(databaseName, callback) {
    // if database defined on connection level use it unless overwritten
    if (this.options.database && typeof databaseName === 'function') {
        callback = databaseName;
        databaseName = this.options.database;
    }

    this.request.get({
        url: this.url('db/' + databaseName + '/series', {
            q: 'list series'
        }),
        json: true
    }, this._parseCallback(function(err, series) {
        if (err) {
            return callback(err, series);
        }
        return callback(err, _.map(series, function(series) {
            return series.name;
        }));
    }));
};



InfluxDB.prototype.createUser = function(databaseName, username, password, callback) {
    this.request.post({
        url: this.url('db/' + databaseName + '/users'),
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            name: username,
            password: password
        }, null)
    }, this._parseCallback(callback));
};

InfluxDB.prototype.updateUser = function(databaseName, userName, options, callback) {
    this.request.post({
        url: this.url('db/' + databaseName + '/users/' + userName),
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify(options, null)
    }, this._parseCallback(callback));
};

InfluxDB.prototype.writeSeries = function(series, options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }

    var query = options.query || {};
    var data = [];
    var self = this;

    _.each(series, function(dataPoints, seriesName) {
        var datum = {
            points: [],
            name: seriesName,
            columns: []
        };
        // Collect column names first
        var columns = {};
        _.each(dataPoints, function(values) {
            _.each(values, function(_, k) {
                columns[k] = true;
            });
        });
        datum.columns = _.keys(columns);
        // Add point values with null where needed
        _.each(dataPoints, function(values) {
            var point = [];
            _.each(datum.columns, function(k) {
                var v = typeof values[k] === 'undefined' ? null : values[k];
                if (k === 'time' && v instanceof Date) {
                    v = self.options.udp_write ? moment(v).unix() : v.valueOf()
                    query.time_precision = 'm';
                }
                point.push(v);
            });
            datum.points.push(point);
        });
        data.push(datum);
    });

    if (this.options.udp_write) {
        var buffer = new Buffer(JSON.stringify(data));
        _.each(this.options.hosts, function(host) {
            self.udp_socket.send(buffer, 0, buffer.length, self.options.udp_port, host);
        });
    } else {
        this.request.post({
            url: this.seriesUrl(this.options.database),
            headers: {
                'content-type': 'application/json'
            },
            pool: 'undefined' !== typeof options.pool ? options.pool : {},
            body: JSON.stringify(data)
        }, this._parseCallback(callback));
    }
};

InfluxDB.prototype.writePoint = function(seriesName, values, options, callback) {
    var data = {};
    data[seriesName] = [values];
    this.writeSeries(data, options, callback);
};

InfluxDB.prototype.writePoints = function(seriesName, points, options, callback) {
    var data = {};
    data[seriesName] = points;
    this.writeSeries(data, options, callback);
};

InfluxDB.prototype.query = function(query, callback) {
    this.request.get({
        url: this.url('db/' + this.options.database + '/series', {
            q: query
        }),
        json: true
    }, this._parseCallback(callback));
};

InfluxDB.prototype.dropSeries = function(databaseName, seriesName, callback) {
    if ('function' === typeof seriesName) {
        callback = seriesName;
        seriesName = databaseName;
        databaseName = this.options.database;
    }
    this.request.get({
        url: this.url('db/' + databaseName + '/series/' + seriesName),
        method: 'DELETE',
        json: true
    }, this._parseCallback(callback));
};

InfluxDB.prototype.getContinuousQueries = function(databaseName, callback) {
    if ('function' === typeof databaseName) {
        callback = databaseName;
        databaseName = this.options.database;
    }
    this.request.get({
        url: this.url('db/' + databaseName + '/continuous_queries'),
        json: true
    }, this._parseCallback(callback));
};


InfluxDB.prototype.dropContinuousQuery = function(databaseName, queryID, callback) {
    if ('function' === typeof queryID) {
        callback = queryID;
        queryID = databaseName;
        databaseName = this.options.database;
    }
    this.request.get({
        url: this.url('db/' + databaseName + '/continuous_queries/' + queryID),
        method: 'DELETE',
        json: true
    }, this._parseCallback(callback));
};

// legacy function
InfluxDB.prototype.readPoints = function(query, callback) {
    if (this.options.depreciatedLogging) this.options.depreciatedLogging('influx.readPoints() has been depreciated, please use influx.query()');
    this.query(query, callback);
};

InfluxDB.prototype.seriesUrl = function(databaseName) {
    if (!databaseName) databaseName = this.options.database;
    return this.url('db/' + databaseName + '/series');
};

InfluxDB.prototype.getHostsAvailable = function() {
    return this.request.getHostsAvailable();
};

InfluxDB.prototype.getHostsDisabled = function() {
    return this.request.getHostsDisabled();
};

var createClient = function() {
    var args = arguments;
    var Client = function() {
        return InfluxDB.apply(this, args);
    };
    Client.prototype = InfluxDB.prototype;
    return new Client();
};


var parseResult = function(res) {
    return _.map(res.points, function(point) {
        var objectPoint = {};
        _.each(res.columns, function(name, n) {
            objectPoint[name] = point[n];
        });
        return objectPoint;
    });
};

module.exports = createClient;
module.exports.parseResult = parseResult;
module.exports.InfluxDB = InfluxDB;