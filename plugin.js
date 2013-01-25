
const PATH = require("path");
const FS = require("fs");
const URL = require("url");
const HTTP = require("http");
const HTTPS = require("https");


var externalProxies = {};

exports.for = function(API, core, node, pluginId) {
	try {
		var id = "sm-plugin-" + pluginId;
		// TODO: Use dynamic `node.core.require(id)` here.
		var pluginModule = require(id);
		if (typeof pluginModule.for !== "function") {
			throw new Error("Plugin '" + id + "' does not implement `exports.for = function(plugin)`.");
		}
		var PluginInstance = function() {}
		PluginInstance.prototype = new Plugin(API, core, node, pluginId);
		var pluginInstance = new PluginInstance();
		pluginModule.for(API, pluginInstance);
		return API.Q.resolve(pluginInstance);
	} catch(err) {
		return API.Q.reject(err);
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
Plugin.prototype.resolveLocator = function(locator, options) {
	return this.API.Q.reject(new Error("TODO: Implement `resolveLocator()` for pm '" + this.pluginId + "'."));
}

// Get the current status of the package in the working tree.
Plugin.prototype.status = function(options) {
	return this.API.Q.resolve(false);	
}

// Get the latest status of the package by contacting remote and storing in cache.
Plugin.prototype.latest = function(options) {
	return this.API.Q.resolve(false);	
}

Plugin.prototype.download = function(uri, options, callback) {
	return this.fetchExternalUri(uri, options, callback);
}

Plugin.prototype.install = function(packagePath, options) {
	return this.API.Q.resolve();
}

Plugin.prototype.bump = function(options) {
	return this.node.getPlugin("git").then(function(pm) {
		return pm.bump(options);
	});
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
	return self.API.Q.call(function() {
		if (!node.parent) return;
		var bin = {};
		// TODO: The descriptor should be merged by the time we use it here.
		if (node.descriptor.package && node.descriptor.package.bin) {
			bin = self.API.UTIL.copy(node.descriptor.package.bin);
		}
		if (node.descriptors.locator && node.descriptors.locator.descriptor && node.descriptors.locator.descriptor.bin) {
			self.API.UTIL.update(bin, node.descriptors.locator.descriptor.bin);
		}
		var done = self.API.Q.ref();
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
				if (PATH.existsSync(linkPath)) {
					var stat = FS.lstatSync(linkPath);
					if (!stat.isSymbolicLink()) {
						throw new Error("Cannot link '" + PATH.join(PATH.dirname(linkPath), sourcePath) + "' to '" + linkPath + "' as file exists at '" + linkPath + "'.");
					}
					var linkVal = FS.readlinkSync(linkPath);
					if (linkVal !== sourcePath) {
						throw new Error("Cannot link '" + PATH.join(PATH.dirname(linkPath), sourcePath) + "' to '" + linkPath + "' as link at '" + linkPath + "' already points to '" + linkVal + "'.");
					}
				} else {
					if (!PATH.existsSync(PATH.dirname(linkPath))) {
						self.API.FS_RECURSIVE.mkdirSyncRecursive(PATH.dirname(linkPath));
					}
					FS.symlinkSync(sourcePath, linkPath);
					FS.chmodSync(linkPath, 0755);
					if (node.level === 1) {
						FS.writeFileSync(PATH.join(node.top.path, ".sm-reload-shell"), "");
					}
				}
				if (plainBinName) {
					linkPath = PATH.join(node.parent.path, ".sm", "bin", plainBinName);
					if (!PATH.existsSync(linkPath)) {
						FS.symlinkSync(binName, linkPath);
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
	// TODO: Keep meta info about FS path and compare on subsequent calls so we can return 304 or 200.
	if (/^\//.test(uri)) {
		if (!PATH.existsSync(uri)) {
			return self.API.Q.resolve({
				status: 404,
				cachePath: uri
			});
		}
		return self.API.Q.resolve({
			status: 200,
			cachePath: uri
		});
	}
	var opts = self.API.UTIL.copy(options);
	if (typeof opts.ttl === "undefined") {
        opts.ttl = self.API.HELPERS.ttlForOptions(opts);
	}
	if (typeof opts.loadBody === "undefined") {
        opts.loadBody = false;
	}
	opts.logger.info("Fetching `" + uri + "` to external uri cache");
    return self.externalUriCache.get(uri, opts, callback);
}

// TODO: Relocate core logic to `sm-proxy`.
Plugin.prototype.getExternalProxy = function(options) {
	var self = this;
	function ensureProxy(host, port, callback) {
		var proxyId = host + ":" + port;		
		if (externalProxies[proxyId]) return callback(null, externalProxies[proxyId][1]);
	    var proxy = new self.API.HTTP_PROXY.HttpProxy({
	        target: {
	        	https: true,
	        	host: host,
	        	port: port
	        },
	        changeOrigin: true
	    });
	    externalProxies[proxyId] = [ HTTPS.createServer({
	        key: FS.readFileSync(PATH.join(self.API.HELPERS.getInternalConfigPath(), "proxy-ssl-private-key"), "utf8"),
	        cert: FS.readFileSync(PATH.join(self.API.HELPERS.getInternalConfigPath(), "proxy-ssl.crt"), "utf8")
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
		}) ];
	    self.API.OS.getTmpPort(function(err, port) {
	    	if (err) return callback(err);
	    	externalProxies[proxyId][1] = {
	    		host: "localhost",
	    		port: port
	    	};
		    externalProxies[proxyId][0].listen(externalProxies[proxyId][1].port, externalProxies[proxyId][1].host, function() {
		    	return callback(null, externalProxies[proxyId][1]);
		    });
	    });
	}
	var deferred = self.API.Q.defer();
	ensureProxy(options.host, options.port, function(err, proxy) {
		if (err) return deferred.reject(err);
		return deferred.resolve(proxy);
	});
	return deferred.promise;
}

Plugin.prototype.getLatestInfoCache = function(uri, responder, options) {
	var self = this;
	var opts = self.API.UTIL.copy(options);
	opts.responder = responder;
	if (typeof opts.ttl === "undefined") {
        opts.ttl = self.API.HELPERS.ttlForOptions(opts);
	}
    opts.loadBody = true;
	opts.logger.info("Fetching `" + uri + "` to latest info cache");
	var deferred = self.API.Q.defer();
    self.latestInfoCache.get(uri, opts, function(err, response) {
    	if (err) return deferred.reject(err);
    	return deferred.resolve(response);
    });
    return deferred.promise;
}
