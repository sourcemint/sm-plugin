
const PATH = require("path");
const URL = require("url");
const HTTP = require("http");
const HTTPS = require("https");
const URI = require("sm-util/lib/uri");


var externalProxies = {};

exports.for = function(API, core, node, pluginId, callback) {
	try {
		var id = "sm-plugin-" + pluginId;
		// TODO: Use dynamic `node.core.require(id)` here.
		var pluginModule = require(id);
		if (typeof pluginModule.for !== "function") {
			return callback(new Error("Plugin '" + id + "' does not implement `exports.for = function(plugin)`."));
		}
		var PluginInstance = function() {}
		PluginInstance.prototype = new Plugin(API, core, node, pluginId);
		var pluginInstance = new PluginInstance();
		pluginModule.for(API, pluginInstance);
		return callback(null, pluginInstance);
	} catch(err) {
		return callback(err);
	}
}


var Plugin = function(API, core, node, pluginId) {
	var self = this;
	self.API = API;
	self.core = core;
	self.node = node,
	self.pluginId = pluginId;
	// TODO: Relocate `URL_PROXY_CACHE` to `sourcemint-proxy-js` (so we can also proxy calls npm makes to outside).
	self.externalUriCache = new self.API.URL_PROXY_CACHE.UrlProxyCache(self.node.getCachePath("external"), {
        ttl: 0    // Indefinite by default.
    });
    self.externalUriCache.parseUrl = function(url) {
	    var urlInfo = URL.parse(url);
	    urlInfo.cachePath = PATH.join(self.externalUriCache.path, self.API.HELPERS.uriToPath(url));
	    return urlInfo;
	}
	self.latestInfoCache = new self.API.URL_PROXY_CACHE.UrlProxyCache(self.node.getCachePath("latest"), {
        ttl: 0    // Indefinite by default.
    });
    self.latestInfoCache.parseUrl = function(url) {
	    var urlInfo = URL.parse(url);
	    urlInfo.cachePath = PATH.join(self.latestInfoCache.path, self.API.HELPERS.uriToPath(url));
	    return urlInfo;
	}
}

// Resolve a locator descriptor to a fully qualified locator object.
Plugin.prototype.resolveLocator = function(locator, options, callback) {
	return callback(new Error("TODO: Implement `resolveLocator()` for pm '" + this.pluginId + "'."));
}

// Get the current status of the package in the working tree.
Plugin.prototype.status = function(options, callback) {
	return callback(null, false);	
}

// Get the latest status of the package by contacting remote and storing in cache.
Plugin.prototype.latest = function(options, callback) {
	return callback(null, false);	
}

Plugin.prototype.download = function(uri, options, callback) {
	return this.fetchExternalUri(uri, options, callback);
}

Plugin.prototype.install = function(packagePath, options) {
	return this.API.Q.resolve();
}

Plugin.prototype.bump = function(options) {
	var deferred = this.API.Q.defer();
	this.node.getPlugin("git", function(err, pm) {
		if (err) return deferred.reject(err);
		return pm.bump(options).then(deferred.resolve, deferred.reject);
	});
	return deferred.promise;
}

Plugin.prototype.export = function(path, options) {
	return this.API.Q.reject(new Error("TODO: Implement `export()` for pm '" + this.pluginId + "'."));
}

Plugin.prototype.publish = function(options) {
	return this.API.Q.resolve();
}

// Called once package is placed in final destination in dependency tree.
Plugin.prototype.postinstall = function(node, options) {
	var self = this;
	return self.API.Q.fcall(function() {
		if (!node.parent) return;
		var bin = {};
		// TODO: The descriptor should be merged by the time we use it here.
		if (node.descriptor.package && node.descriptor.package.bin) {
			bin = self.API.UTIL.copy(node.descriptor.package.bin);
		}
		if (node.descriptors.locator && node.descriptors.locator.descriptor && node.descriptors.locator.descriptor.bin) {
			self.API.UTIL.update(bin, node.descriptors.locator.descriptor.bin);
		}
		var done = self.API.Q.resolve();
		if (bin && self.API.UTIL.len(bin) > 0) {
			self.API.UTIL.forEach(bin, function(bin) {
				var binName = bin[0];
				var plainBinName = null;
				if (binName !== node.name) {
					plainBinName = binName;
					binName = node.name + "-" + binName;
				}
				var linkPath = PATH.join(node.parent.path, ".sm", "bin", binName);
				var sourcePath = PATH.join("../..", node.relpath.substring(node.parent.relpath.length) , bin[1]);
				options.logger.debug("Linking command '" + PATH.join(PATH.dirname(linkPath), sourcePath) + "' to '" + linkPath + "'.");
				if (self.API.FS.existsSync(linkPath)) {
					var stat = self.API.FS.lstatSync(linkPath);
					if (!stat.isSymbolicLink()) {
						throw new Error("Cannot link '" + PATH.join(PATH.dirname(linkPath), sourcePath) + "' to '" + linkPath + "' as file exists at '" + linkPath + "'.");
					}
					var linkVal = self.API.FS.readlinkSync(linkPath);
					if (linkVal !== sourcePath) {
						throw new Error("Cannot link '" + PATH.join(PATH.dirname(linkPath), sourcePath) + "' to '" + linkPath + "' as link at '" + linkPath + "' already points to '" + linkVal + "'.");
					}
				} else {
					if (!self.API.FS.existsSync(PATH.dirname(linkPath))) {
						self.API.FS.mkdirsSync(PATH.dirname(linkPath));
					}
					self.API.FS.symlinkSync(sourcePath, linkPath);
					self.API.FS.chmodSync(linkPath, 0755);
					if (node.level === 1) {
						self.API.FS.writeFileSync(PATH.join(node.top.path, ".sm", ".reload-shell"), "");
					}
				}
				if (plainBinName) {
					linkPath = PATH.join(node.parent.path, ".sm", "bin", plainBinName);
					if (!self.API.FS.existsSync(linkPath)) {
						self.API.FS.symlinkSync(binName, linkPath);
					}
				}
			});
		}
		return done;
	});
}


// Helper functions.

Plugin.prototype.fetchExternalUri = function(uri, options, callback) {
	var self = this;
    var parsedUri = URL.parse(uri);
	if (/^\//.test(uri) || parsedUri.protocol === "file:") {
        return self.node.getPlugin("path", function(err, plugin) {
            if (err) return callback(err);
            return plugin.download(uri, options, function(err, response) {
                if (err) return callback(err);
                return callback(null, response);
            });
        });
	}
	var opts = self.API.UTIL.copy(options);
	if (typeof opts.ttl === "undefined") {
        opts.ttl = self.API.HELPERS.ttlForOptions(opts);
	}
	if (typeof opts.loadBody === "undefined") {
        opts.loadBody = false;
	}

	function fetchViaPlugin(callback) {
		// See if pointer is a URI.
		var parsedPointer = self.API.URI_PARSER.parse2(uri);
		if (parsedPointer && parsedPointer.hostname) {
			// Remove domain ending to leave host name. (e.g. remove `.com`).
			var hostname = parsedPointer.hostname.split(".");
			for (var i=hostname.length-1 ; i>=0 ; i--) {
				if (URI.TLDS.indexOf(hostname[i].toUpperCase()) !== -1) {
					hostname.splice(i, 1);				
				}
			}
			// Subdomains should be suffixes, not prefixes.
			hostname.reverse();
			var pluginId = hostname.join("-");
			// `pointer` is a URI so we ask plugin `pluginId` (based on hostname) to resolve locator.
	        return self.node.getPlugin(pluginId, function(err, plugin) {
	            if (err) {
					if (err.message === ("Cannot find module 'sm-plugin-" + pluginId + "'")) return callback(null, false);
	            	return callback(err);
	            }
	            if (!plugin.hasOwnProperty("download")) return callback(null, false);
				opts.logger.info("Asking plugin '" + pluginId + "' to download '" + uri + "' to external uri cache");
	            return plugin.download(uri, options, function(err, response) {
	                if (err) return callback(err);
	                return callback(null, response);
	            });
	        });

			return resolve(pluginId, callback);
		}
		return callback(null, false);
	}

	return fetchViaPlugin(function(err, response) {
		if (err) {
			console.error("ERROR", err.stack);
		}
		if (response) return callback(null, response);
		opts.logger.info("Fetching '" + uri + "' to external uri cache using default fetcher");
	    return self.externalUriCache.get(uri, opts, callback);
	});
}

// TODO: Relocate core logic to `sm-proxy`.
Plugin.prototype.getExternalProxy = function(options, callback) {
	var self = this;

	var host = options.host;
	var port = options.port;

	var proxyId = host + ":" + port + ":" + options.time;
	if (externalProxies[proxyId]) {
		if (self.API.UTIL.isArrayLike(externalProxies[proxyId])) {
			externalProxies[proxyId][1].push(callback);
		} else {
			callback(null, externalProxies[proxyId][1]);
		}
		return;
	}
	externalProxies[proxyId] = [
		callback
	];
    var proxy = new self.API.HTTP_PROXY.HttpProxy({
        target: {
        	https: true,
        	host: host,
        	port: port
        },
        changeOrigin: true
    });
    var instance = [
	    HTTPS.createServer({
	        key: self.API.FS.readFileSync(PATH.join(self.API.HELPERS.getInternalConfigPath(), "proxy-ssl-private-key"), "utf8"),
	        cert: self.API.FS.readFileSync(PATH.join(self.API.HELPERS.getInternalConfigPath(), "proxy-ssl.crt"), "utf8")
		}, function (req, res) {
			// Only run `GET` and `HEAD` requests through cache.
			if (req.method === "GET" || req.method === "HEAD") {
				var uri = "https://" + host + ":" + port + req.url;
				var opts = self.API.UTIL.copy(options);
				opts.loadBody = true;
				return self.fetchExternalUri(uri, opts, function(err, result) {
					if (err) {
						res.writeHead(500);
						console.error(err.stack);
						res.end("Internal server error");
						return;
					}
					if (typeof result.body === "undefined") {
						result.headers["content-length"] = 0;
					}
					res.writeHead((result.status===304)?200:result.status, result.headers);
					res.end(result.body || "");
				});
			} else {
		        proxy.proxyRequest(req, res);
			}
		})
	];
    self.API.OS.getTmpPort(function(err, port) {
    	if (err) {
    		externalProxies[proxyId].forEach(function(err) {
    			return callback(err);
    		})
    		delete externalProxies[proxyId];
    		return;
    	}
    	instance[1] = {
    		host: "localhost",
    		port: port
    	};
	    instance[0].listen(instance[1].port, instance[1].host, function() {
    		externalProxies[proxyId].forEach(function(err) {
    			return callback(null, instance[1]);
    		});
    		externalProxies[proxyId] = instance;
	    });
    });
}

Plugin.prototype.getLatestInfoCache = function(uri, responder, options, callback) {
	var self = this;
	var opts = self.API.UTIL.copy(options);
	opts.responder = responder;
	if (typeof opts.ttl === "undefined") {
        opts.ttl = self.API.HELPERS.ttlForOptions(opts);
	}
    opts.loadBody = true;
	opts.logger.info("Fetching `" + uri + "` to latest info cache");
    return self.latestInfoCache.get(uri, opts, callback);
}
