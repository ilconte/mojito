/*
 * Copyright (c) 2011-2013, Yahoo! Inc.  All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */


/*jslint
    anon:true, sloppy:true, regexp: true, continue: true, nomen:true, node:true, stupid:true, plusplus: true
*/
/*global YUI*/

/**
 * The ResourceStore manages information about the "resources" in a Mojito
 * application.  These resources are things that have representation on the
 * filesystem.
 *
 * You generally don't need to worry about this class (and its addons) unless
 * you are extending Mojito.
 *
 * Each resource can have many different versions.  This is not talking about
 * revisions, which is how the resource changes over time.  It is instead
 * talking about how there can be a version of the resource just for iphones,
 * one just for android, a fallback, etc.
 *
 * The metadata kept about each resource is normalized to the follow keys:
 * <dl>
 *      <dt><code>source</code> (object)</dt>
 *      <dd>where the source came from.  (not shipped to the client.)
 *          <dl>
 *              <dt><code>fs</code> (object)</dt>
 *              <dd>filesystem details</dd>
 *              <dt><code>pkg</code> (object)</dt>
 *              <dd>packaging details</dd>
 *          </dl>
 *      </dd>
 *      <dt><code>mojit</code> (string)</dt>
 *      <dd>which mojit this applies to, if any. ("shared" means the resource is available to all mojits.)</dd>
 *      <dt><code>type</code> (string)</dt>
 *      <dd>resource type</dd>
 *      <dt><code>subtype</code> (string)</dt>
 *      <dd>not all types of subtypes</dd>
 *      <dt><code>name</code> (string)</dt>
 *      <dd>common to all versions of the resource</dd>
 *      <dt><code>id</code> (string)</dt>
 *      <dd>unique ID.  common to all versions of the resource. (typically <code>{type}-{subtype}-{name}</code>.)</dd>
 *      <dt><code>yui</code> (object)</dt>
 *      <dd>for resources that are YUI modules</dd>
 *  </dl>
 *
 *  The following are only used in the metadata for each resource <em>version</em>
 *  (The metadata for resolved resources won't have these, since they're intrinsically
 *  part of the resolved resource.)
 *  <dd>
 *      <dt><code>affinity</code> (string)</dt>
 *      <dd>runtime affinity.  either <code>server</code>, <code>client</code>, or <code>common</code></dd>
 *      <dt><code>selector</code> (string)</dt>
 *      <dd>version selector</dd>
 * </dl>
 *
 *
 * @module ResourceStore
 */
YUI.add('mojito-resource-store', function(Y, NAME) {

    'use strict';

    var libs = {},

        resourceSortByDepthTest = function (a, b) {
            return a.source.pkg.depth - b.source.pkg.depth;
        },

        isNotAlphaNum = /[^a-zA-Z0-9]/,

        mojitoVersion = '0.666.666',    // special case for weird packaging situations

        CONVENTION_SUBDIR_TYPES = {
            // subdir: resource type
            'actions':  'action',
            'binders':  'binder',
            'commands': 'command',
            'middleware': 'middleware',
            'models':   'model',
            'specs':    'spec',
            'views':    'view'
        },
        CONVENTION_SUBDIR_TYPE_IS_JS = {
            'action': true,
            'binder': true,
            'model': true
        },
        // which addon subtypes are app-level
        ADDON_SUBTYPES_APPLEVEL = {
            'rs': true
        },
        DEFAULT_AFFINITIES = {
            'action': 'server',
            'addon': 'server',
            'archetype': 'server',
            'asset': 'common',
            'binder': 'client',
            'command': 'server',
            'controller': 'server',
            'middleware': 'server',
            'model': 'server',
            'spec': 'common',
            'view': 'common'
        },
        PATH_SEP = require('path').sep;

    libs.fs = require('fs');
    libs.glob = require('glob');
    libs.path = require('path');
    libs.semver = require('semver');
    libs.walker = require('./package-walker.server');
    libs.util = require('../../util.js');

    // The Affinity object is to manage the use of the affinity string in
    // filenames.  Some files have affinities that have multiple parts
    // (e.g. "server-tests").
    function Affinity(affinity) {
        var parts;
        if (affinity.indexOf('-') === -1) {
            this.affinity = affinity;
        } else {
            parts = affinity.split('-');
            this.affinity = parts[0];
            this.type = parts[1];
        }
    }
    Affinity.prototype = {
        toString: function() {
            return this.affinity;
        }
    };



    /**
     * @class ResourceStore.server
     * @constructor
     * @requires addon-rs-config, addon-rs-selector
     * @param {object} config configuration for the store
     *      @param {string} config.root directory to manage (usually the application directory)
     *      @param {object} config.context static context
     *      @param {object} config.appConfig overrides for `application.json`
     */
    function ResourceStore(config) {
        ResourceStore.superclass.constructor.apply(this, arguments);
    }
    ResourceStore.NAME = 'ResourceStore';
    ResourceStore.ATTRS = {};


    Y.extend(ResourceStore, Y.Base, {

        /**
         * This methods is part of Y.Base.  See documentation for that for details.
         * @method initializer
         * @param {object} cfg Configuration object as per Y.Base
         * @return {nothing}
         */
        initializer: function(cfg) {
            var i;

            this._libs = {};
            for (i in libs) {
                if (libs.hasOwnProperty(i)) {
                    this._libs[i] = libs[i];
                }
            }

            this._config = cfg || {};
            this._config.context = this._config.context || {};
            this._config.appConfig = this._config.appConfig || {};
            this._config.dir = this._config.dir || process.cwd();
            this._config.root = this._config.root ||
                this._config.dir;
            this._config.mojitoRoot = this._config.mojitoRoot ||
                this._libs.path.join(__dirname, '../..');

            this._jsonCache = {};   // fullPath: contents as JSON object
            this._ycbCache = {};    // fullPath: context: YCB config object
            this._routesCache = {}; // serialized context: route
            this._appConfigCache = {}; //cache for the app config
            this._validateContextCache = {};    // ctx: error string or "VALID"
            this._getMojitTypeDetailsCache = {};    // env+posl+lang+mojitType: value
            this._expandSpecCache = {}; // env+ctx+spec: value

            this._packagesVisited = {}; // package@version: path
            this._appRVs    = [];   // array of resource versions
            this._mojitRVs  = {};   // mojitType: array of resource versions
            this._appPkg = null;    // metadata about the applicaions's NPM package
            this._specPaths = {};   // spec name: full path

            this._mojitDetails = {}; // mojitType: selector: affinity: non-stringified details
            this._mojitDetailsCache = {}; // mojitType+poslString+env: resolved resources

            /**
             * All selectors that are actually in the app.
             * Key is selector, value is just boolean `true`.
             * This won't be populated until `preloadResourceVersions()` is done.
             * @property selectors
             * @type Object
             */
            this.selectors = {};

            // Y.Plugin AOP doesn't allow afterHostMethod() callbacks to
            // modify the results, so we fire an event instead.
            this.publish('resolveMojitDetails', {emitFacade: true, preventable: false});
            this.publish('loadConfigs', {emitFacade: true, preventable: false});

            // We'll start with just our "config" addon. Note that since we're
            // forcing the load we have to also include mojito-util.
            this._yuiUseSync({
                'addon-rs-config': {
                    fullpath: this._libs.path.join(
                        this._config.mojitoRoot,
                        'app/addons/rs/config.js'
                    )
                }
            });
            this.plug(Y.mojito.addons.rs.config, { appRoot: this._config.root, mojitoRoot: this._config.mojitoRoot });

            this.loadConfigs();

            Y.log('Store initialized', 'info', NAME);
        },

        destructor: function() {},


        //====================================================================
        // PUBLIC METHODS

        /**
         * Loads the dimensions and configurations found in the app
         * @method loadConfigs
         */
        loadConfigs: function () {
            this._validDims = this._parseValidDims(this.config.getDimensions());
            this.validateContext(this._config.context);
            this._fwConfig = this.config.readConfigSimple(this._libs.path.join(this._config.mojitoRoot, 'config.json'));
            this._appConfigYCB = this.config.getAppConfigYCB();
            this._appConfigStatic = this.getAppConfig({});

            this.lazyResolve = this._appConfigStatic.resourceStore && this._appConfigStatic.resourceStore.lazyResolve;

            this.fire('loadConfigs');
        },

        /**
         * Validates the context, and throws an exception if it isn't.
         * @method validateContext
         * @param {object} ctx the context
         * @return {nothing} if this method returns at all then the context is valid
         */
        validateContext: function(ctx) {
            var cacheKey = JSON.stringify(ctx),
                cacheValue,
                k,
                parts,
                p,
                test,
                found;

            cacheValue = this._validateContextCache[cacheKey];
            if (cacheValue) {
                if (cacheValue === 'VALID') {
                    return;
                }
                throw new Error(cacheValue);
            }

            for (k in ctx) {
                if (ctx.hasOwnProperty(k)) {
                    if (!ctx[k]) {
                        continue;
                    }
                    if ('langs' === k) {
                        // pseudo-context variable created by our middleware
                        continue;
                    }
                    if (!this._validDims[k]) {
                        this._validateContextCache[cacheKey] = 'INVALID dimension key "' + k + '"';
                        throw new Error(this._validateContextCache[cacheKey]);
                    }
                    // we need to support language fallbacks
                    if ('lang' === k) {
                        found = false;
                        parts = ctx[k].split('-');
                        for (p = parts.length; p > 0; p -= 1) {
                            test = parts.slice(0, p).join('-');
                            if (this._validDims[k][test]) {
                                found = true;
                                break;
                            }
                        }
                        if (!found) {
                            this._validateContextCache[cacheKey] = 'INVALID dimension value "' + ctx[k] + '" for key "' + k + '"';
                            throw new Error(this._validateContextCache[cacheKey]);
                        }
                        continue;
                    }
                    if (!this._validDims[k][ctx[k]]) {
                        this._validateContextCache[cacheKey] = 'INVALID dimension value "' + ctx[k] + '" for key "' + k + '"';
                        throw new Error(this._validateContextCache[cacheKey]);
                    }
                }
            }
            this._validateContextCache[cacheKey] = 'VALID';
            return true;
        },


        /**
         * Returns the context provided blended with the static
         * (non-runtime-sensitive) context.
         * @method blendStaticContext
         * @param {object} ctx The context to blend.
         * @return {object} the context
         */
        blendStaticContext: function(ctx) {
            return Y.mojito.util.blend(this._config.context, ctx);
        },


        /**
         * Returns the static (non-runtime-sensitive) context
         * @method getStaticContext
         * @return {object} the context
         */
        getStaticContext: function() {
            return Y.mojito.util.copy(this._config.context);
        },


        /**
         * Returns the static (non-runtime-sensitive) version of the application.json.
         * @method getStaticAppConfig
         * @return {object} the configuration from applications.json
         */
        getStaticAppConfig: function() {
            return Y.mojito.util.copy(this._appConfigStatic);
        },


        /**
         * Returns Mojito's built-in configuration.
         * @method getFrameworkConfig
         * @return {object} the configuration for mojito
         */
        getFrameworkConfig: function() {
            return Y.mojito.util.copy(this._fwConfig);
        },

        /**
         * Returns a contextualized application configuration.
         * @method getAppConfig
         * @param {object} ctx the context
         * @return {object} the application configuration contextualized by the "ctx" argument.
         */
        getAppConfig: function(ctx) {
            var appConfig,
                key,
                ycb;

            ctx = this.blendStaticContext(ctx);
            key = JSON.stringify(ctx || {});

            if (this._appConfigCache[key]) {
                return JSON.parse(this._appConfigCache[key]);
            }

            ycb = this._appConfigYCB.read(ctx);

            appConfig = Y.mojito.util.blend(this._fwConfig.appConfigBase, this._config.appConfig);
            appConfig = Y.mojito.util.blend(appConfig, ycb);

            this._appConfigCache[key] = JSON.stringify(appConfig);

            return appConfig;
        },

        /**
         * Does initial preload of many parts of the application and framework.
         * The full preload is done by preload().
         *
         * @method preloadInitial
         * @return {nothing}
         */
        preloadInitial: function() {
            if (!this._initialPreloaded) {

                this.preloadResourceVersions();
                // binding the preload to avoid calling it twice.
                this._initialPreloaded = true;

                Y.log('Store initial preloaded', 'info', NAME);
            }
        },


        /**
         * Preloads everything in the app, and as well pertinent parts of
         * the framework.
         *
         * @method preload
         * @return {nothing}
         */
        preload: function() {
            // We need to do an initial sweep to find the resource store addons.
            this.preloadInitial();

            // And then use them.
            if (this.loadAddons()) {
                // If we loaded some addons, do another sweep so that the loaded addons can be used.
                this.preloadResourceVersions();

                // reload the configs so that the addons get a chance to mess with them
                this.loadConfigs();
            }

            this.makeResourceVersions();
            this.resolveResourceVersions();

            Y.log('Store fully preloaded', 'info', NAME);
        },


        /**
         * Optimizes this store for the specific runtime, or for "production" if none given in static context.
         * @method optimizeForEnvironment
         * @return {nothing}
         */
        optimizeForEnvironment: function() {
            this._packagesVisited = {};
            if (!this.lazyResolve) {
                this._appRVs = [];
                this._mojitRVs = {};
            }
        },

        /**
         * Returns a list of resource versions that match the filter.
         * (To get the list of resource versions from all mojits, you'll need
         * to call `listAllMojits()` and iterate over that list, calling this
         * method with `mojit:` in the filter.)
         *
         * @method getResourceVersions
         * @param {object} filter limit returned resource versions to only those whose keys/values match the filter
         * @return {array of objects} list of matching resource versions
         */
        getResourceVersions: function(filter) {
            var source = [],
                out = [],
                r,
                res,
                k,
                use;

            source = filter.mojit ? this._mojitRVs[filter.mojit] : this._appRVs;
            if (!source) {
                return [];
            }
            for (r = 0; r < source.length; r += 1) {
                res = source[r];
                use = true;
                for (k in filter) {
                    if (filter.hasOwnProperty(k)) {
                        if (res[k] !== filter[k]) {
                            use = false;
                            break;
                        }
                    }
                }
                if (use) {
                    out.push(res);
                }
            }
            return out;
        },


        /**
         * Returns a list of all mojits in the app, except for the "shared" mojit.
         * @method listAllMojits
         * @return {array} list of mojits
         */
        listAllMojits: function() {
            var mojitType,
                list = [];
            for (mojitType in this._mojitRVs) {
                if (this._mojitRVs.hasOwnProperty(mojitType)) {
                    if ('shared' !== mojitType) {
                        list.push(mojitType);
                    }
                }
            }
            return list;
        },


        /**
         * This just calls `expandInstanceForEnv()` with `env` set to `server`.
         *
         * @async
         * @method expandInstance
         * @param {map} instance partial instance to expand
         * @param {object} ctx the context
         * @param {function(err,instance)} cb callback used to return the results (or error)
         */
        expandInstance: function(instance, ctx, cb) {
            this.expandInstanceForEnv('server', instance, ctx, cb);
            return;
        },


        /**
         * Expands the instance into all details necessary to dispatch the mojit.
         *
         * @async
         * @method expandInstanceForEnv
         * @param {string} env the runtime environment (either `client` or `server`)
         * @param {object} instance
         * @param {object} ctx the context
         * @param {function(err,instance)} cb callback used to return the results (or error)
         */
        expandInstanceForEnv: function(env, instance, ctx, cb) {
            var spec,
                typeDetails,
                newInst,
                key;

            // TODO:  should this be done here, or somewhere else?
            ctx.runtime = env;

            if (!instance.instanceId) {
                instance.instanceId = Y.guid();
                //DEBUGGING:  instance.instanceId += '-instance-server-' + [instance.base||'', instance.type||''].join('-');
            }

            // spec
            try {
                spec = this._expandSpec(env, ctx, instance);
            } catch (err) {
                return cb(err);
            }
            if (!spec.config) {
                spec.config = {};
            }

            // type details
            try {
                typeDetails = this.getMojitTypeDetails(env, ctx, spec.type);
            } catch (err2) {
                return cb(err2);
            }

            // This approach gives a noticeable performance improvement when
            // typeDetails.config is empty.
            newInst = Y.mojito.util.copy(typeDetails);
            for (key in spec) {
                if (spec.hasOwnProperty(key)) {
                    if (('object' === typeof typeDetails[key]) && Object.keys(typeDetails[key]).length > 0) {
                        if (('object' === typeof spec[key]) && Object.keys(spec[key]).length > 0) {
                            newInst[key] = Y.mojito.util.blend(typeDetails[key], spec[key] || {});
                        }
                    } else {
                        newInst[key] = spec[key];
                    }
                }
            }
            // spec doesn't (appreciably) contain base
            newInst.base = instance.base;

            cb(null, newInst);
        },


        /**
         * Returns details about a mojit type.
         *
         * As the last step of execution, this fires the `getMojitTypeDetails`
         * event so that Resource Store addons can augment the returned structure.
         *
         * NOTE! This returns an object which is shared with similar calls to
         * this method.  If you intend to modify the object please make a deep
         * copy first and use that instead.
         *
         * @method getMojitTypeDetails
         * @param {string} env the runtime environment (either `client` or `server`)
         * @param {object} ctx the context
         * @param {string} mojitType mojit type
         * @param {object} dest DEPRECATED: object in which to place the results
         * @return {object} details about the mojit type
         */
        /**
         * Fired at the end of the `getMojitTypeDetails()` method to allow
         * modification of the results.
         * @event getMojitTypeDetails
         * @param {object} args input arguments
         *      @param {string} args.env the runtime environment (either `client` or `server`)
         *      @param {object} args.ctx runtime context
         *      @param {array} args.posl priority-ordered seletor list
         *      @param {string} args.mojitType name of mojit
         * @param {object} mojit the mojit type details
         */
        getMojitTypeDetails: function(env, ctx, mojitType, dest, DANGERDANGERreturnRawCacheValue) {
            //Y.log('getMojitTypeDetails('+env+', '+JSON.stringify(ctx)+', '+mojitType+')', 'debug', NAME);
            var posl = this.selector.getPOSLFromContext(ctx),
                poslKey = JSON.stringify(posl),
                // We need to include the lang, since it's a part of the context
                // that greatly affects each mojit, yet is not necessarily
                // captured in the POSL.
                cacheKey = JSON.stringify([env, posl, ctx.lang, mojitType]),
                cacheValue = this._getMojitTypeDetailsCache[cacheKey],
                details;

            if ('shared' === mojitType) {
                throw new Error('Mojit name "shared" is special and isn\'t a real mojit.');
            }

            if (!cacheValue) {

                details = this.resolveVersion(mojitType, env, posl);

                details.defaults = this.config.readConfigYCB(this._libs.path.join(details.fullPath, 'defaults.json'), ctx);
                details.definition = this.config.readConfigYCB(this._libs.path.join(details.fullPath, 'definition.json'), ctx);
                if (details.defaults && details.defaults.config) {
                    details.config = Y.mojito.util.blend(details.defaults.config, details.config);
                }
                // we shouldn't expose this
                if ('client' === env) {
                    details.fullPath = undefined;
                }

                cacheValue = details;
                this._getMojitTypeDetailsCache[cacheKey] = cacheValue;
            }

            if (dest) {
                Y.log('The "dest" parameter to store.getMojitTypeDetails() is deprecated.', 'warn', NAME);
                Y.mojito.util.mergeRecursive(dest, cacheValue);
            }
            return cacheValue;
        },


        /**
         * Cooks down the list of resolved mojit resources into a single structure.
         * @method resolveMojitDetails
         * @param {string} env the runtime environment (either `client` or `server`)
         * @param {object} posl priority-ordered seletor list
         * @param {string} type name of mojit
         * @param {array} ress array of resources for the mojit
         * @param {object} mojitRes resource for the mojit itself
         * @return {object} details for the mojit
         */
        /**
         * Fired at the end of the `resolveMojitDetails()` method to allow
         * modification of the results.
         * @event resolveMojitDetails
         * @param {object} args input arguments
         *      @param {string} args.env the runtime environment (either `client` or `server`)
         *      @param {array} args.posl priority-ordered seletor list
         *      @param {string} args.type name of mojit
         *      @param {array} args.ress array of resources for the mojit
         *      @param {object} args.mojitRes resource for the mojit itself
         * @param {object} details details for the mojit
         */
        resolveMojitDetails: function(env, posl, type, ress, mojitRes) {
            var poslKey = JSON.stringify(posl),
                r,
                res,
                clientDetails,
                details = {
                    fullPath: mojitRes.source.fs.fullPath,
                    //defaults       can only be evaluated at runtime
                    //definition     can only be evaluated at runtime
                    assets: {},
                    binders: {},
                    config: {},
                    langs: {},
                    models: {},
                    partials: {},
                    views: {}
                },
                template,
                specPath;

            for (r = 0; r < ress.length; r += 1) {
                res = ress[r];

                if (res.type === 'config') {
                    // these can only be determined using the runtime context
                    continue;
                }

                if (res.type === 'asset') {
                    if (env === 'client') {
                        details.assets[res.name + res.source.fs.ext] = res.url;
                    } else {
                        details.assets[res.name + res.source.fs.ext] = res.source.fs.fullPath;
                    }
                    continue;
                }

                if (res.type === 'controller') {
                    details.controller = res.yui.name;
                    continue;
                }

                if (res.type === 'yui-lang') {
                    details.langs[res.yui.lang] = true;
                    if (res.yui.isRootLang) {
                        details.defaultLang = res.yui.lang;
                    }
                    continue;
                }

                if (res.type === 'model') {
                    details.models[res.name] = res.yui.name;
                    continue;
                }

                if (res.type === 'binder') {
                    details.binders[res.name] = res.yui.name;
                    continue;
                }

                if (res.type === 'view') {
                    template = {
                        'content-path': (env === 'client' ?
                                this._libs.util.webpath(this._appConfigStatic.pathToRoot || '', res.url) :
                                res.source.fs.fullPath),
                        'content': res.content,
                        'engine': res.view.engine
                    };
                    // we want to separate partials from actual templates
                    // in case the engine supports partials
                    if (res.name.indexOf('partials/') === 0) {
                        // removing the "partials/" prefix
                        details.partials[this._libs.path.basename(res.name)] = template;
                    }
                    details.views[res.name] = template;
                    details.views[res.name].assets = res.view.assets;
                    details.views[res.name].engine = res.view.engine;

                    continue;
                }

                if (res.type === 'spec') {
                    // During runtime we only need to know a little bit about the specs.
                    specPath = res.mojit;
                    if (res.name !== 'default') {
                        specPath += ':' + res.name;
                    }
                    this._specPaths[specPath] = res.source.fs.fullPath;
                    continue;
                }

                if (res.type === 'addon') {
                    // No need to track either of these explicitly, since
                    // AC addons is handled by calculating dependencies of the
                    // controller, and view engines are handled by the view
                    // filenames.
                    continue;
                }
            }

            // Since the binders are not part of the server runtime, but are needed
            // to define the binders map, we need to synthetically build this.
            if (env !== 'client') {
                clientDetails = this.resolveVersion(type, 'client', posl);
                details.binders = clientDetails.binders;
            }

            this.fire('resolveMojitDetails', {
                args: {
                    env: env,
                    posl: posl,
                    type: type,
                    ress: ress,
                    mojitRes: mojitRes
                },
                mojitDetails: details
            });

            return details;
        },


        /**
         * Returns the routes configured in the application.
         * @method getRoutes
         * @param {object} ctx the context
         * @return {object} routes
         */
        getRoutes: function(ctx) {
            var appConfig,
                cachedValue,
                key = JSON.stringify(ctx || {}),
                routesFiles = [],
                p,
                path,
                out = {},
                routes;

            cachedValue = this._routesCache[key];
            if (cachedValue) {
                return JSON.parse(cachedValue);
            }

            appConfig = this.getAppConfig(ctx);
            if (appConfig) {
                routesFiles = appConfig.routesFiles;
            }

            for (p = 0; p < routesFiles.length; p += 1) {
                path = routesFiles[p];
                // relative paths are relative to the application
                path = this._libs.path.resolve(this._config.root, path);
                routes = this.config.readConfigYCB(path, ctx);
                Y.mix(out, routes, true);
            }

            if (!Object.keys(out).length) {
                Y.mix(out, this._fwConfig.defaultRoutes, true);
            }

            this._routesCache[key] = JSON.stringify(out);
            return out;
        },


        /**
         * Sugar method that returns all "url" metadata of all resources.
         * @method getAllURLs
         * @return {object} for all resources with a "url" metadatum, the key is
         *      that URL and the value the filesystem path
         */
        getAllURLs: function() {
            var r,
                res,
                ress,
                m,
                mojit,
                mojits,
                urls = {};
            mojits = this.listAllMojits();
            mojits.push('shared');
            for (m = 0; m < mojits.length; m += 1) {
                mojit = mojits[m];
                ress = this.getResourceVersions({mojit: mojit});
                for (r = 0; r < ress.length; r += 1) {
                    res = ress[r];
                    if (res.url) {
                        urls[res.url] = res.source.fs.fullPath;
                    }
                }
            }
            return urls;
        },


        /**
         * turns a resource into a datastructure for the static handler
         * @method makeStaticHandlerDetails
         * @param {object} res The resource.
         * @return {object} A concise version of the resource containing just the details necessary
         *      to serve the resource via the static handler.
         */
        makeStaticHandlerDetails: function(res) {
            var details = {
                type: res.type,
                subtype: res.subtype,
                name: res.name,
                path: res.source.fs.fullPath,
                url: res.url
            };
            if (res.mojit) {
                details.mojit = res.mojit;
            }
            if (res.mime) {
                details.mimetype = res.mime.type;
                details.charset = res.mime.charset;
            }
            return details;
        },


        /**
         * Sugar method that returns a hash table with the urls and the
         * resource objects.
         * @method getAllURLDetails
         * @return {object} for all resources with a "url" metadatum, the key is
         *      that URL and the value is the results of the makeStaticHandlerDetails() call
         */
        getAllURLDetails: function() {
            var r,
                res,
                ress,
                m,
                mojit,
                mojits,
                urls = {};
            ress = this.getResourceVersions({});
            for (r = 0; r < ress.length; r += 1) {
                res = ress[r];
                if (res.url && res.source.fs.isFile) {
                    urls[res.url] = this.makeStaticHandlerDetails(res);
                }
            }
            mojits = this.listAllMojits();
            mojits.push('shared');
            for (m = 0; m < mojits.length; m += 1) {
                mojit = mojits[m];
                ress = this.getResourceVersions({mojit: mojit});
                for (r = 0; r < ress.length; r += 1) {
                    res = ress[r];
                    if (res.url && res.source.fs.isFile) {
                        if (urls[res.url]) {
                            if (urls[res.url].path !== res.source.fs.fullPath) {
                                Y.log('Url collision for ' + res.url +
                                    '. Choosing:\n' + urls[res.url].path +
                                    ' over\n' + res.source.fs.fullPath, 'debug', NAME);
                            }
                        } else {
                            urls[res.url] = this.makeStaticHandlerDetails(res);
                        }
                    }
                }
            }
            return urls;
        },


        /**
         * Finds the file represented by the resource, and returns its contents and filesystem info.
         * @method getResourceContent
         * @param {object} details static handling details
         * @param {function} callback callback used to return the resource content (or error)
         * @param {Error|undefined} callback.err Error that occurred, if any.
         *      If an error is given that the other two arguments will be undefined.
         * @param {Buffer} callback.content the contents of the resource
         * @param {Stat||null} callback.stat Stat object with details about the file on the filesystem
         *          Can be null if the resource doesn't have a direct representation on the filesystem.
         * @return {undefined} nothing is returned, the results are returned via the callback
         */
        getResourceContent: function(details, callback) {
            var store = this,
                filename;

            if (details && details.path) {
                filename = details.path;

                // FUTURE [Issue 89] stat cache?
                store._libs.fs.stat(filename, function(err, stat) {
                    if (err) {
                        Y.log('failed to find: ' + filename, 'warn', NAME);
                        // TODO: [Issue 90] send next an error?
                        callback(err);
                        return;
                    }
                    // reading the file directly using buffers
                    store._libs.fs.readFile(filename, function (err, content) {
                        if (err) {
                            Y.log('NOT FOUND: ' + filename, 'warn', NAME);
                            callback(err);
                            return;
                        }
                        store.processResourceContent(details, content, stat, callback);
                    });

                });

            } else {
                // invalid res object
                callback(new Error('Invalid resource store reference'));
            }
        },


        /**
         * A method that transforms the content of a resource as it's being read
         * from the filesystem.  This method does nothing, but provides a hook
         * point for resource store addons to transform resource contents.
         * @method processResourceContent
         * @param {object} details static handling details
         * @param {Buffer} content the contents of the resource
         * @param {Stat||null} callback.stat Stat object with details about the file on the filesystem
         *          Can be null if the resource doesn't have a direct representation on the filesystem.
         * @param {function} callback callback passed to `getResourceContent()`.
         * @return {nothing} results returned via the callback
         */
        processResourceContent: function(details, content, stat, callback) {
            callback(undefined, content, stat);
        },


        /**
         * Recursively merge one object onto another.
         * [original implementation](http://stackoverflow.com/questions/171251/how-can-i-merge-properties-of-two-javascript-objects-dynamically/383245#383245)
         *
         * @method mergeRecursive
         * @param {object} dest object to merge into
         * @param {object} src object to merge onto "dest"
         * @param {boolean} typeMatch controls whether a non-object in the src is
         *          allowed to clobber a non-object in the dest (if a different type)
         * @return {object} the modified "dest" object is also returned directly
         */
        mergeRecursive: function(dest, src, typeMatch) {
            var p;
            for (p in src) {
                if (src.hasOwnProperty(p)) {
                    // Property in destination object set; update its value.
                    if (src[p] && src[p].constructor === Object) {
                        if (!dest[p]) {
                            dest[p] = {};
                        }
                        dest[p] = this.mergeRecursive(dest[p], src[p]);
                    } else {
                        if (dest[p] && typeMatch) {
                            if (typeof dest[p] === typeof src[p]) {
                                dest[p] = src[p];
                            }
                        } else {
                            dest[p] = src[p];
                        }
                    }
                }
            }
            return dest;
        },


        /**
         * Returns information about the application's NPM package.  This is
         * primarily useful when creating resources in `makeResourceVersions()`.
         * @method getAppPkgMeta
         * @return {object} metadata about the application's NPM package
         */
        getAppPkgMeta:  function() {
            return this._appPkg;
        },


        /**
         * Creates the filesystem metadata for a resource.  This is primarily
         * useful when creating resources in `makeResourceVersions()`.
         * @method makeResourceFSMeta
         * @param {string} dir directory path
         * @param {string} dirType type represented by the "dir" argument.  values are "app", "bundle", "pkg", or "mojit"
         * @param {string} subdir directory path within "dir".
         * @param {string} file name of the file or directory
         * @param {boolean} isFile indicates whether the path is a file (true) or diretory (false)
         * @return {object} filesystem metadata
         */
        makeResourceFSMeta: function(dir, dirType, subdir, file, isFile) {
            var fs = {
                fullPath: this._libs.path.join(dir, subdir, file),
                rootDir: dir,
                rootType: dirType,
                subDir: subdir,
                subDirArray: subdir.split(PATH_SEP),
                isFile: isFile,
                ext: this._libs.path.extname(file)
            };
            fs.basename = this._libs.path.basename(file, fs.ext);
            return fs;
        },


        //====================================================================
        // CALLBACK METHODS
        // These are called at various points in the algorithm of public
        // methods.  They are public so that they can be hooked into via AOP.


        /**
         * Augments this resource store with addons that we know about.
         * To find the addons, call `preloadResourceVersions()` first.
         *
         * You most often don't want to call this directly, but instead to hook
         * into it using the AOP mechanism of `Y.Plugin.Base`:
         *
         *     this.afterHostMethod('loadAddons', this._myLoadAddons, this);
         *
         * @method loadAddons
         * @return {Number} the number of loaded addons
         */
        loadAddons: function() {
            var modules = {},
                ress,
                r,
                res;

            ress = this.getResourceVersions({type: 'addon', subtype: 'rs'});
            for (r = 0; r < ress.length; r += 1) {
                res = ress[r];
                if ('rs' === res.subtype) {
                    // FUTURE:  ideally we shouldn't proscribe the YUI module name of RS addons
                    // (We can/should introspect the file for the YUI module name.)
                    modules['addon-rs-' + res.name] = {
                        fullpath: res.source.fs.fullPath
                    };
                }
            }
            this._yuiUseSync(modules);

            Y.Object.each(Y.mojito.addons.rs, function(fn, name) {
                // skipping any rs addon that was already plugged during the init phase (e.g.: config)
                if (fn.NS && !this[fn.NAME]) {
                    this.plug(fn, { appRoot: this._config.root, mojitoRoot: this._config.mojitoRoot });
                }
            }, this);
            return Object.keys(modules).length;
        },


        /**
         * Preload metadata about all resource versions in the application
         * (and Mojito framework).
         *
         * You most often don't want to call this directly, but instead to hook
         * into it using the AOP mechanism of `Y.Plugin.Base`:
         *
         *     this.afterHostMethod('preloadResourceVersions', this._myPreloadResourceVersions, this);
         *
         * @method preloadResourceVersions
         * @return {nothing}
         */
        preloadResourceVersions: function() {
            var me = this,
                walker,
                walkedMojito = false,
                dir,
                info;

            this.selectors = {};
            this._appRVs = [];
            this._mojitRVs = {};
            this._packagesVisited = {};

            walker = new this._libs.walker.BreadthFirst(this._config.root);
            walker.walk(function(err, info) {
                if (err) {
                    throw err;
                }
                if ('mojito' === info.pkg.name) {
                    walkedMojito = true;
                }
                me._preloadPackage(info);
            });

            // user might not have installed mojito as a dependency of their
            // application.  (they -should- have but might not have.)
            // FUTURE:  instead walk -all- global packages?
            if (!walkedMojito) {
                dir = this._libs.path.join(this._config.mojitoRoot, '..');
                info = {
                    depth: 999,
                    parents: [],
                    dir: dir
                };
                info.pkg = this.config.readConfigJSON(this._libs.path.join(dir, 'package.json'));

                if (Object.keys(info.pkg).length) {
                    mojitoVersion = info.pkg.version;
                } else {
                    // special case for weird packaging situations
                    info.dir = this._config.mojitoRoot;
                    info.pkg = {
                        name: 'mojito',
                        version: mojitoVersion,
                        yahoo: {
                            mojito: {
                                type: 'bundle',
                                location: 'app'
                            }
                        }
                    };
                }

                this._preloadPackage(info);
            }
        },


        /**
         * Called by the ResourceStore to decide if a file should be considered
         * a resource.  You most often don't want to call this directly, but
         * instead to hook into it using the AOP mechanism of `Y.Plugin.Base`:
         *
         *     this.afterHostMethod('findResourceVersionByConvention', this._myFindResourceByConvention, this);
         *
         * Generally `findResourceVersionByConvention()` and `parseResourceVersion()` are meant to work together.
         * This method figures out the type (and subtype) of a file, and `parseResourceVersion()` turns
         * the file into an actual resource.
         *
         * @method findResourceVersionByConvention
         * @param {object} source the same as the `source` part of a resource
         * @param {string} mojitType the name of the mojit
         * @return {boolean|object} If the source is a directory, a boolean can be returned.
         *      True indicates that the directory contents should be scanned, while false
         *      indicates that the directory should be skipped.
         *      If the source does represent a resource, then an object with the following
         *      fields should be returned:
         *      type {string} type of the resource,
         *      subtype {string} optional subtype of the resource,
         *      skipSubdirParts {integer} number of path parts of `source.fs.subDir` to skip
         */
        findResourceVersionByConvention: function(source, mojitType) {
            var fs = source.fs,
                baseParts = fs.basename.split('.'),
                type;

            if (!fs.isFile && '.' === fs.subDir && CONVENTION_SUBDIR_TYPES[fs.basename]) {
                return true;
            }
            type = CONVENTION_SUBDIR_TYPES[fs.subDirArray[0]];
            if (!fs.isFile && type) {
                return true;
            }
            if (fs.isFile && type && fs.subDirArray.length >= 1) {
                if (CONVENTION_SUBDIR_TYPE_IS_JS[type] && '.js' !== fs.ext) {
                    return false;
                }

                if ('spec' === type && ('.json' !== fs.ext && '.yaml' !== fs.ext && '.yml' !== fs.ext)) {
                    return false;
                }

                return {
                    type: type,
                    skipSubdirParts: 1
                };
            }

            // special case:  addons
            if (!fs.isFile && '.' === fs.subDir && 'addons' === fs.basename) {
                return true;
            }
            if (!fs.isFile && fs.subDirArray.length < 2 && 'addons' === fs.subDirArray[0]) {
                return true;
            }
            if (fs.isFile && fs.subDirArray.length >= 1 && 'addons' === fs.subDirArray[0]) {
                if ('.js' !== fs.ext) {
                    return false;
                }
                return {
                    type: 'addon',
                    subtype: fs.subDirArray[1],
                    skipSubdirParts: 2
                };
            }

            // special case:  archetypes
            if (!fs.isFile && '.' === fs.subDir && 'archetypes' === fs.basename) {
                return true;
            }
            if (!fs.isFile && fs.subDirArray.length < 2 && 'archetypes' === fs.subDirArray[0]) {
                return true;
            }
            if (!fs.isFile && fs.subDirArray.length === 2 && 'archetypes' === fs.subDirArray[0]) {
                return {
                    type: 'archetype',
                    subtype: fs.subDirArray[1],
                    skipSubdirParts: 2
                };
            }

            // special case:  assets
            if (!fs.isFile && '.' === fs.subDir && 'assets' === fs.basename) {
                return true;
            }
            if (!fs.isFile && 'assets' === fs.subDirArray[0]) {
                return true;
            }
            if (fs.isFile && 'assets' === fs.subDirArray[0] && fs.subDirArray.length >= 1) {
                return {
                    type: 'asset',
                    subtype: fs.ext.substr(1),
                    skipSubdirParts: 1
                };
            }

            // special case:  controller
            if (fs.isFile && '.' === fs.subDir && 'controller' === baseParts[0]) {
                if ('.js' !== fs.ext) {
                    return false;
                }
                return {
                    type: 'controller'
                };
            }

            // special case:  mojit
            if (!fs.isFile && '.' === fs.subDir && 'mojits' === fs.basename) {
                // don't bother finding mojits here, since they're loaded explicitly in
                // the app and bundle in different ways
                return false;
            }

            // unknown path
            return true;
        },


        /**
         * Called by the ResourceStore to turn a file into a resource.
         * You most often don't want to call this directly, but instead to hook
         * into it using the AOP mechanism of `Y.Plugin.Base`:
         *
         *     this.beforeHostMethod('parseResourceVersion', this._myParseResource, this);
         *
         * Generally `findResourceVersionByConvention()` and `parseResourceVersion()` are meant to work together.
         * `findResourceVersionByConvention()` figures out the type (and subtype) of a file, and
         * this method turns the file into an actual resource.
         *
         * @method parseResourceVersion
         * @param {object} source the same as the `source` part of a resource
         * @param {string} type the resource type of the file
         * @param {string} subtype the optional resource subtype of the file
         * @param {string} mojitType the name of the mojit
         * @return {object|undefined} the resource version
         */
        parseResourceVersion: function(source, type, subtype, mojitType) {
            var fs = source.fs,
                baseParts = fs.basename.split('.'),
                res;

            // app-level resources
            if ('archetype' === type || 'command' === type || 'middleware' === type) {
                if ('mojit' === fs.rootType) {
                    Y.log(type + ' cannot be defined in a mojit. skipping ' + fs.fullPath, 'warn', NAME);
                    return;
                }
                res = {
                    source: source,
                    mojit: null,
                    type: type,
                    subtype: subtype,
                    name: fs.basename,
                    affinity: DEFAULT_AFFINITIES[type],
                    selector: '*'
                };
                res.id = [res.type, res.subtype, res.name].join('-');
                return res;
            }

            // mojit parts with format {name}.{affinity}.{selector}
            if ('action' === type ||
                    'addon' === type ||
                    'controller' === type ||
                    'model' === type) {
                res = {
                    source: source,
                    mojit: mojitType,
                    type: type,
                    subtype: subtype,
                    affinity: DEFAULT_AFFINITIES[type],
                    selector: '*'
                };
                if (baseParts.length >= 3) {
                    res.selector = baseParts.pop();
                }
                if (baseParts.length >= 2) {
                    res.affinity = baseParts.pop();
                }
                if (baseParts.length !== 1) {
                    Y.log('invalid ' + type + ' filename. skipping ' + fs.fullPath, 'warn', NAME);
                    return;
                }
                res.name = this._libs.util.webpath(fs.subDirArray.join(PATH_SEP), baseParts.join('.'));
                res.id = [res.type, res.subtype, res.name].join('-');
                // special case
                if ('addon' === type && ADDON_SUBTYPES_APPLEVEL[res.subtype]) {
                    res.mojit = null;
                }
                return res;
            }

            // mojit parts with format {name}.{selector}
            if ('asset' === type || 'binder' === type) {
                res = {
                    source: source,
                    mojit: mojitType,
                    type: type,
                    subtype: subtype,
                    affinity: DEFAULT_AFFINITIES[type],
                    selector: '*'
                };
                if (baseParts.length >= 2) {
                    res.selector = baseParts.pop();
                }
                if (baseParts.length !== 1) {
                    Y.log('invalid ' + type + ' filename. skipping ' + fs.fullPath, 'warn', NAME);
                    return;
                }
                res.name = this._libs.util.webpath(fs.subDirArray.join(PATH_SEP), baseParts.join('.'));
                res.id = [res.type, res.subtype, res.name].join('-');
                return res;
            }

            // special case:  spec
            if ('spec' === type) {
                res = {
                    source: source,
                    mojit: mojitType,
                    type: 'spec',
                    affinity: DEFAULT_AFFINITIES[type],
                    selector: '*'
                };
                if (baseParts.length !== 1) {
                    Y.log('invalid spec filename. skipping ' + source.fs.fullPath, 'warn', NAME);
                    return;
                }
                res.name = this._libs.util.webpath(source.fs.subDir, baseParts.join('.'));
                res.id = [res.type, res.subtype, res.name].join('-');
                return res;
            }

            // special case:  view
            if ('view' === type) {
                res = {
                    source: source,
                    mojit: mojitType,
                    type: type,
                    subtype: subtype,
                    view: {
                        outputFormat: fs.ext.substr(1),
                        engine: baseParts.pop()
                    },
                    affinity: DEFAULT_AFFINITIES[type],
                    selector: '*'
                };
                if (baseParts.length >= 2) {
                    res.selector = baseParts.pop();
                }
                if (baseParts.length !== 1) {
                    Y.log('invalid view filename. skipping ' + fs.fullPath, 'warn', NAME);
                    return;
                }
                res.name = this._libs.util.webpath(fs.subDirArray.join(PATH_SEP), baseParts.join('.'));
                res.id = [res.type, res.subtype, res.name].join('-');
                // for performance reasons, we might want to preload all
                // views in memory.
                if (this._appConfigStatic.viewEngine && this._appConfigStatic.viewEngine.preloadTemplates) {
                    res.content = this._libs.fs.readFileSync(source.fs.fullPath, 'utf8');
                }
                return res;
            }

            // just ignore unknown types
            return;
        },


        /**
         * Called by the ResourceStore to register a resource version.
         * You most often don't want to call this directly, but instead to hook
         * into it using the AOP mechanism of `Y.Plugin.Base`:
         *
         *     this.beforeHostMethod('parseResourceVersion', this._myParseResource, this);
         *
         * @method addResourceVersion
         * @param {object} res the resource version
         * @return {nothing}
         */
        addResourceVersion: function(res) {
            res.affinity = new Affinity(res.affinity);

            if (res.selector) {
                this.selectors[res.selector] = true;
            }
            if (res.mojit) {
                if (!this._mojitRVs[res.mojit]) {
                    this._mojitRVs[res.mojit] = [];
                }
                this._mojitRVs[res.mojit].push(res);
            } else {
                // we use all app-level resource versions
                res.chosen = true;
                this._appRVs.push(res);
            }
        },


        /**
         * Called by the ResourceStore to allow RS addons to create resource
         * versions that don't otherwise have representation on dist.  You most
         * often don't want to call this directly, but instead to hook into it
         * using the AOP mechanism of `Y.Plugin.Base`:
         *
         *     this.afterHostMethod('makeResourceVersions', this._onMakeResourceVersions, this);
         *
         * @method makeResourceVersions
         * @return {nothing}
         */
        makeResourceVersions: function() {
            // nothing to do ourselves
        },



        /**
         * For each resource, stuff it in a map mojitType->selector->affinity
         * that will make it easy to retrieve it later. Then if the lazyResolve config
         * is not set, go through all the possible combinations and resolve all
         * resource versions.
         * @method resolveResourceVersions
         */
        resolveResourceVersions: function () {
            var crtType,
                resources,
                r,
                crtRes,
                e,
                env,
                envs = ['client', 'server'],
                p,
                posl,
                posls;

            // for each resource of each mojit, create the store data structure
            for (crtType in this._mojitRVs) {
                if (this._mojitRVs.hasOwnProperty(crtType)) {
                    resources = this._mojitRVs[crtType];

                    this._mojitDetails[crtType] = {};

                    for (r = 0; r < resources.length; r++) {
                        crtRes = resources[r];

                        // create the new selector->affinity map if it doesn't exist
                        if (!this._mojitDetails[crtType][crtRes.selector]) {
                            this._mojitDetails[crtType][crtRes.selector] = {};
                        }
                        if (!this._mojitDetails[crtType][crtRes.selector][crtRes.affinity]) {
                            this._mojitDetails[crtType][crtRes.selector][crtRes.affinity] = [];
                        }

                        this._mojitDetails[crtType][crtRes.selector][crtRes.affinity].push(crtRes);
                    }
                }
            }

            // if we don't want to lazy resolve, resolve for all posls
            if (!this.lazyResolve) {
                posls = this.selector.getAllPOSLs();

                for (e = 0; e < envs.length; e++) {

                    for (p = 0; p < posls.length; p++) {

                        for (crtType in this._mojitRVs) {
                            if (this._mojitRVs.hasOwnProperty(crtType)) {

                                if (crtType === 'shared') {
                                    continue;
                                }

                                this.resolveVersion(crtType, envs[e], posls[p]);
                            }
                        }
                    }
                }
            }

        },

        /**
         * Find a mojit details in the resource store at runtime
         * @param  {String} type the mojit type
         * @param  {String} env  the environment: {'client', 'server'}
         * @param  {Array} posl the ordered list of selectors to look resources with
         * @return {Object} a mojit details
         */
        resolveVersion: function (type, env, posl) {
            var s,
                currentSelector,
                r,
                currentResources,
                currentResourcesLen,
                t,
                currentType,
                types = [type, 'shared'],
                e,
                affinities = [env, 'common'],
                poslString = posl.toString(),
                resolvedResources = {},
                mojitRes,
                result;

            if (this._mojitDetailsCache[type + poslString + env]) {
                return JSON.parse(this._mojitDetailsCache[type + poslString + env]);
            }

            for (s = 0; s < posl.length; s++) { // ~3
                currentSelector = posl[s];

                for (t = 0; t < types.length; t++) { // 2
                    currentType = types[t];

                    for (e = 0; e < affinities.length; e++) { // 2
                        currentResources = (this._mojitDetails[currentType][currentSelector] &&
                            this._mojitDetails[currentType][currentSelector][affinities[e]]) || [];

                        // remember each resource we find for this posl, type and environment
                        // prioritize: we prefer shallower resources
                        currentResources.sort(resourceSortByDepthTest);
                        for (r = 0; r < currentResources.length; r++) { // ~3
                            // prioritize: we prefer shallower resources
                            resolvedResources[currentResources[r].id] = resolvedResources[currentResources[r].id] || currentResources[r];
                        }
                    }
                }
            }

            mojitRes = this.getResourceVersions({type: 'mojit', name: type, selector: '*'})[0];
            result = this.resolveMojitDetails(env, posl, type, Y.Object.values(resolvedResources), mojitRes);

            this._mojitDetailsCache[type + poslString + env] = JSON.stringify(result);
            return result;

        },

        //====================================================================
        // PRIVATE METHODS

        /**
         * Used for unit testing.
         * @private
         * @method _mockLib
         * @param {string} name name of library to mock out
         * @param {situation-dependent} lib library to mock out
         * @return {nothing}
         */
        _mockLib: function(name, lib) {
            this._libs[name] = lib;
        },


        /**
         * @private
         * @method @parseValidDims
         * @param {object} dims contents of dimensions.json
         * @return {object} lookup hash for dimension keys and values
         */
        _parseValidDims: function(dims) {
            var d,
                dim,
                dimName,
                out = {};
            function grabKeys(dimName, o) {
                var k;
                for (k in o) {
                    if (o.hasOwnProperty(k)) {
                        out[dimName][k] = true;
                        if (Y.Lang.isObject(o[k])) {
                            grabKeys(dimName, o[k]);
                        }
                    }
                }
            }
            for (d = 0; d < dims[0].dimensions.length; d += 1) {
                dim = dims[0].dimensions[d];
                for (dimName in dim) {
                    if (dim.hasOwnProperty(dimName)) {
                        out[dimName] = {};
                        grabKeys(dimName, dim[dimName]);
                    }
                }
            }
            return out;
        },


        /**
         * Applies spec inheritance by following the `base` and merging up the
         * results.
         * @private
         * @method _expandSpec
         * @param {string} env the runtime environment (either `client` or `server`)
         * @param {object} ctx runtime context
         * @param {object} spec spec to expand
         * @return {object} expanded sped
         */
        // FUTURE:  expose this to RS addons?
        _expandSpec: function(env, ctx, spec) {
            // We could add caching in here, but it turns out that it's faster
            // not to.  This algorithm is pretty simple and a lot of the heavy
            // lifting is being done inside the YCB library which has its own
            // caching.
            var appConfig,
                base,
                out;

            if (!spec.base) {
                return spec;
            }

            appConfig = this.getAppConfig(ctx);

            // appConfig.specs might be undefined, for example in newly created apps
            base = appConfig.specs && appConfig.specs[spec.base];

            if (!base && this._specPaths[spec.base]) {
                base = this.config.readConfigYCB(this._specPaths[spec.base], ctx);
            }
            if (!base) {
                throw new Error('Unknown base "' + spec.base + '". You should have configured "' + spec.base + '" in application.json under specs or used "@' + spec.base + '" if you wanted to specify a mojit name.');
            }

            out = Y.mojito.util.mergeRecursive(
                this._expandSpec(env, ctx, base),
                spec
            );
            // The base will need to carry its ID with it.
            out.id = spec.base;
            out.base = undefined;
            return out;
        },


        /**
         * preloads metadata about resources in a package
         * (but not subpackages in its `node_modules/`)
         *
         * @private
         * @method _preloadPackage
         * @param {object} info metadata about the package
         * @return {nothing}
         */
        _preloadPackage: function(info) {
            var dir,
                pkg,
                visitKey;
            /*
            console.log('--PACKAGE-- ' + info.depth + ' ' + info.pkg.name + '@' + info.pkg.version
                    + ' \t' + (info.pkg.yahoo && info.pkg.yahoo.mojito && info.pkg.yahoo.mojito.type)
                    + ' \t[' + info.parents.join(',') + ']'
            );
            */
            pkg = {
                name: info.pkg.name,
                version: info.pkg.version,
                depth: info.depth
            };
            if (0 === info.depth) {
                this._appPkg = pkg;
                // the actual application is handled specially
                this._preloadApp(pkg);
                return;
            }
            if (!info.pkg.yahoo || !info.pkg.yahoo.mojito) {
                return;
            }
            visitKey = info.pkg.name;
            if (this._packagesVisited[visitKey]) {
                Y.log('skipping duplicate package ' + visitKey + '\nskipping  ' +
                      info.dir + '\nprev used ' + this._packagesVisited[visitKey], 'debug', NAME);
                return;
            }

            switch (info.pkg.yahoo.mojito.type) {
            case 'bundle':
                dir = this._libs.path.join(info.dir, info.pkg.yahoo.mojito.location || '');
                this._preloadDirBundle(dir, pkg);
                break;
            case 'mojit':
                dir = this._libs.path.join(info.dir, info.pkg.yahoo.mojito.location || '');
                this._preloadDirMojit(dir, 'pkg', pkg);
                break;
            default:
                Y.log('Unknown package type "' + info.pkg.yahoo.mojito.type + '"', 'warn', NAME);
                break;
            }
            this._packagesVisited[visitKey] = info.dir;
        },


        /**
         * preloads metadata about resources in the application directory
         * (but not `node_modules/`)
         *
         * @private
         * @method _preloadApp
         * @param {object} pkg metadata (name and version) about the app's package
         * @return {nothing}
         */
        _preloadApp: function(pkg) {
            var ress,
                r,
                res,
                list,
                i;

            ress = this._findResourcesByConvention(this._config.root, 'app', pkg, 'shared');
            for (r = 0; r < ress.length; r += 1) {
                res = ress[r];
                if ('mojit' !== res.type) {
                    // ignore app-level mojits found by convention, since they'll be loaded below
                    this.addResourceVersion(ress[r]);
                }
            }

            // load mojitsDirs
            list = this._globList(this._config.root, this._appConfigStatic.mojitsDirs);
            for (i = 0; i < list.length; i += 1) {
                this._preloadDirMojits(list[i], 'app', pkg);
            }

            // load mojitDirs
            list = this._globList(this._config.root, this._appConfigStatic.mojitDirs || []);
            for (i = 0; i < list.length; i += 1) {
                this._preloadDirMojit(list[i], 'app', pkg);
            }
        },


        /**
         * preloads metadata about resources in a directory
         *
         * @private
         * @method _preloadDirBundle
         * @param {string} dir directory path
         * @param {object} pkg metadata (name and version) about the package
         * @return {nothing}
         */
        _preloadDirBundle: function(dir, pkg) {
            var ress,
                r,
                res;
            // FUTURE:  support configuration too

            ress = this._findResourcesByConvention(dir, 'bundle', pkg, 'shared');
            for (r = 0; r < ress.length; r += 1) {
                res = ress[r];
                this.addResourceVersion(res);
            }
            this._preloadDirMojits(this._libs.path.join(dir, 'mojits'), 'bundle', pkg);
        },


        /**
         * preloads a directory containing many mojits
         *
         * @private
         * @method _preloadDirMojits
         * @param {string} dir directory path
         * @param {string} dirType type represented by the "dir" argument.  values are "app", "bundle", "pkg", or "mojit"
         * @param {object} pkg metadata (name and version) about the package
         * @return {nothing}
         */
        _preloadDirMojits: function(dir, dirType, pkg) {
            var i,
                realDirs,
                children,
                childName,
                childPath;
            dir = this._libs.path.resolve(this._config.root, dir);
            if (!this._libs.fs.existsSync(dir)) {
                return;
            }

            children = this._sortedReaddirSync(dir);
            for (i = 0; i < children.length; i += 1) {
                childName = children[i];
                if ('.' === childName.substring(0, 1)) {
                    continue;
                }
                childPath = this._libs.path.join(dir, childName);
                this._preloadDirMojit(childPath, dirType, pkg);
            }
        },


        /**
         * preloads a directory that represents a single mojit
         *
         * @private
         * @method _preloadDirMojit
         * @param {string} dir directory path
         * @param {string} dirType type represented by the "dir" argument.  values are "app", "bundle", "pkg", or "mojit"
         * @param {object} pkg metadata (name and version) about the package
         * @return {nothing}
         */
        _preloadDirMojit: function(dir, dirType, pkg) {
            var mojitType,
                packageJson,
                definitionJson,
                ress,
                r,
                res;
            dir = this._libs.path.resolve(this._config.root, dir);

            if (!this._libs.fs.existsSync(dir)) {
                return;
            }

            if (!this._libs.fs.statSync(dir).isDirectory()) {
                return;
            }

            if ('pkg' === dirType) {
                mojitType = pkg.name;
            } else {
                mojitType = this._libs.path.basename(dir);
            }
            packageJson = this.config.readConfigJSON(this._libs.path.join(dir, 'package.json'));
            if (packageJson) {
                if (packageJson.name) {
                    mojitType = packageJson.name;
                }

                if (packageJson.engines && packageJson.engines.mojito) {
                    if (!this._libs.semver.satisfies(mojitoVersion, packageJson.engines.mojito)) {
                        Y.log('skipping mojit because of version check ' + dir, 'warn', NAME);
                        return;
                    }
                }

                // TODO:  register mojit's package.json as a static asset, in "static handler" plugin
            }

            definitionJson = this.config.readConfigYCB(this._libs.path.join(dir, 'definition.json'), {});
            if (definitionJson.appLevel) {
                mojitType = 'shared';
            }

            // the mojit itself is registered as an app-level resource
            res = {
                source: {
                    fs: this.makeResourceFSMeta(dir, dirType, '.', '', false),
                    pkg: pkg
                },
                type: 'mojit',
                name: mojitType,
                id: 'mojit--' + mojitType,
                affinity: 'common',
                selector: '*'
            };
            this.addResourceVersion(res);

            ress = this._findResourcesByConvention(dir, 'mojit', pkg, mojitType);
            for (r = 0; r < ress.length; r += 1) {
                res = ress[r];
                // just in case, only add those resources that really do belong to us
                if (res.mojit === mojitType) {
                    this.addResourceVersion(res);
                }
                // FUTURE:  else warn?
            }
        },

        /**
         * Finds resources based on our conventions.
         * -Doesn't- load mojits or their contents.  That's done elsewhere.
         *
         * @private
         * @method _findResourcesByConvention
         * @param {string} dir directory from which to find resources
         * @param {string} dirType type represented by the "dir" argument.  values are "app", "bundle", "pkg", or "mojit"
         * @param {object} pkg metadata (name and version) about the package
         * @param {string|null} mojitType name of mojit to which the resource belongs
         * @return {array} list of resources
         */
        _findResourcesByConvention: function(dir, dirType, pkg, mojitType) {
            var me = this,
                ress = [];
            //console.log('-- FIND RESOURCES BY CONVENTION -- ' + pkg.name + '@' + pkg.version + ' -- ' + mojitType);

            this._walkDirRecursive(dir, function(error, subdir, file, isFile) {
                var source, ret, res;

                if ('node_modules' === file) {
                    return false;
                }
                if ('libs' === file && 'test' !== me._appConfigStatic.env) {
                    return false;
                }
                if ('tests' === file && 'test' !== me._appConfigStatic.env) {
                    return false;
                }

                source = {
                    fs: me.makeResourceFSMeta(dir, dirType, subdir, file, isFile),
                    pkg: pkg
                };

                if (me._skipBadPath(source.fs)) {
                    return false;
                }

                ret = me.findResourceVersionByConvention(source, mojitType);
                if ('object' === typeof ret) {
                    if (ret.skipSubdirParts) {
                        source.fs.subDirArray = source.fs.subDirArray.slice(ret.skipSubdirParts);
                        source.fs.subDir = source.fs.subDirArray.join(PATH_SEP) || '.';
                    }
                    res = me.parseResourceVersion(source, ret.type, ret.subtype, mojitType);
                    if ('object' === typeof res) {
                        ress.push(res);
                    }
                    // don't recurse into resources that are directories
                    return false;
                }
                return ret;
            });

            return ress;
        },


        /**
         * Indicates whether file should be skipped based on its path
         *
         * @private
         * @method _skipBadPath
         * @param {object} pathParts the "source.fs" part of the resource
         * @return {boolean} true indicates that the file should be skipped
         */
        _skipBadPath: function(fs) {
            if (fs.isFile && fs.ext.substr(1).match(isNotAlphaNum)) {
                return true;
            }
            return false;
        },


        /**
         * A wrapper for `fs.readdirSync()` that guarantees ordering. The order
         * in which the file system is walked is significant within the resource
         * store, e.g., when looking up a matching context.
         *
         * @private
         * @method _sortedReaddirSync
         * @param {string} path directory to read
         * @return {array} files in the directory
         */
        _sortedReaddirSync: function(path) {
            var out = this._libs.fs.readdirSync(path);
            return out.sort();
        },


        /**
         * Recursively walks a directory
         * @private
         * @method _walkDirRecursive
         * @param {string} dir directory to start at
         * @param {function(error, subdir, name, isFile)} cb callback called for each file
         * @param {string} _subdir INTERNAL argument for recursion, please ignore
         */
        _walkDirRecursive: function(dir, cb, _subdir) {
            var subdir,
                fulldir,
                children,
                i,
                childName,
                childPath,
                childFullPath,
                childStat;

            subdir = _subdir || '.';
            fulldir = this._libs.path.join(dir, subdir);
            if (!this._libs.fs.existsSync(fulldir)) {
                return;
            }

            children = this._sortedReaddirSync(fulldir);
            for (i = 0; i < children.length; i += 1) {
                childName = children[i];
                if ('.' === childName.substring(0, 1)) {
                    continue;
                }
                if ('node_modules' === childName) {
                    continue;
                }
                childPath = this._libs.path.join(subdir, childName);
                childFullPath = this._libs.path.join(dir, childPath);
                try {
                    childStat = this._libs.fs.statSync(childFullPath);
                } catch (e) {
                    Y.log('invalid file. skipping ' + childFullPath, 'warn', NAME);
                    continue;
                }
                if (childStat.isFile()) {
                    cb(null, subdir, childName, true);
                } else if (childStat.isDirectory()) {
                    if (cb(null, subdir, childName, false)) {
                        this._walkDirRecursive(dir, cb, childPath);
                    }
                }
            }
        },


        /**
         * Takes a list of globs and turns it into a list of matching paths.
         * @private
         * @method _globList
         * @param {string} prefix prefix for every path in the list
         * @param {array} list list of globs
         * @return {array} list of paths matching the globs
         */
        _globList: function(prefix, list) {
            var found = [],
                i,
                glob;
            for (i = 0; i < list.length; i += 1) {
                glob = list[i];
                glob = this._libs.path.resolve(prefix, glob);
                found = found.concat(this._libs.glob.sync(glob, {}));
            }
            return found;
        },


        /**
         * Augments this resource store's Y object with the specified YUI modules.
         * @private
         * @method _yuiUseSync
         * @param {object} modules YUI module configuration information
         * @return {nothing}
         */
        _yuiUseSync: function(modules) {
            Y.applyConfig({
                useSync: true,
                modules: modules
            });
            Y.use.apply(Y, Object.keys(modules));
            Y.applyConfig({ useSync: false });
        }


    });

    Y.namespace('mojito');
    Y.mojito.ResourceStore = ResourceStore;


}, '0.0.1', { requires: [
    'base',
    'oop',
    'mojito-util'
]});
