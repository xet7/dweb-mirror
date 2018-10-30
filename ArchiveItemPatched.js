/*
This file is extensions to ArchiveItem that probably in some form could go back into dweb-archive

 */

//Standard repos
const fs = require('fs');   // See https://nodejs.org/api/fs.html
const path = require('path');
const debug = require('debug')('dweb-mirror:ArchiveItem');
const canonicaljson = require('@stratumn/canonicaljson');
// Other IA repos
const ArchiveItem = require('@internetarchive/dweb-archive/ArchiveItem');
// Other files from this repo
const MirrorFS = require('./MirrorFS');
const errors = require('./Errors');
const config = require('./config');


ArchiveItem.prototype._dirpath = function(directory) {
        return path.join(directory, this.itemid);
    };

ArchiveItem.prototype.save = function({cacheDirectory = undefined} = {}, cb) {
    /*
        Save _meta and _files and _reviews as JSON (_members will be saved by Subclassing in MirrorCollection)
        If not already done so, will fetch_metadata (but not query, as that may want to be precisely controlled)
    */
    console.assert(cacheDirectory, "ArchiveItem needs a directory in order to save");
    const itemid = this.itemid; // Its also in this.item.metadata.identifier but only if done a fetch_metadata
    const dirpath = this._dirpath(cacheDirectory);

    if (!this.item) {
        // noinspection JSUnusedLocalSymbols
        this.fetch_metadata((err, data) => {
           if (err) {
               _err("Cant save because couldnt fetch metadata", err, cb);
           } else {
               f.call(this); // Need the call because it loses track of "this"
           }
        });
    } else {
        f.call(this);
    }
    function _err(msg, err, cb) {
        console.error(msg, err);
        if (cb) {
            cb(err);
        } else {
            throw(err)
        }
    }
    function f() {
        MirrorFS._mkdir(dirpath, (err) => {
            if (err) {
                _err(`Cannot mkdir ${dirpath} so cant save item ${itemid}`, err, cb);
            } else {
                const filepath = path.join(dirpath, itemid + "_meta.json");
                fs.writeFile(filepath, canonicaljson.stringify(this.item.metadata), (err) => {
                    if (err) {
                        _err(`Unable to write metadata to ${itemid}`, err, cb);
                    } else {

                        const filepath = path.join(dirpath, itemid + "_files.json");
                        fs.writeFile(filepath, canonicaljson.stringify(this.item.files), (err) => {
                            if (err) {
                                _err(`Unable to write files to ${itemid}`, err, cb);
                            } else {
                                // Write any additional info we want that isn't derived from (meta|reviews|files)_xml etc or added by gateway
                                const filepath = path.join(dirpath, itemid + "_extra.json");
                                fs.writeFile(filepath, canonicaljson.stringify({collection_titles: this.item.collection_titles}), (err) => {
                                    if (err) {
                                        _err(`Unable to write extras to ${itemid}`, err, cb);
                                    } else {
                                        if (typeof this.item.reviews === "undefined") { // Reviews is optional - most things don't have any
                                            cb(null, this);
                                        } else {
                                            const filepath = path.join(dirpath, itemid + "_reviews.json");
                                            fs.writeFile(filepath, canonicaljson.stringify(this.item.reviews), (err) => {
                                                if (err) {
                                                    _err(`Unable to write reviews to ${itemid}`, err, cb);
                                                } else {
                                                    cb(null, this);
                                                }
                                            });
                                        }
                                    }
                                })
                            }
                        })
                    }
                });
            }
        });
    }
};
ArchiveItem.prototype.read = function({cacheDirectory = undefined} = {}, cb) {
    /*
        Read metadata, reviews, files and extra from corresponding files
        cacheDirectory: Top level of directory to look for data in
        TODO-CACHE allow cacheDirectory to be an array
        cb(err, {files, files_count, metadata, reviews, collection_titles})  data structure suitable for "item" field of ArchiveItem
    */
    const itemid = this.itemid;
    const res = {};
    function _parse(part, cb) {
        const filename = path.join(cacheDirectory, itemid, `${itemid}_${part}.json`);
        fs.readFile(filename, (err, jsonstring) => {
            if (err) {
                cb(err);    // Not logging as not really an err for there to be no file, as will read
            } else {
                let o;
                try {
                    o = canonicaljson.parse(jsonstring); // No reviver function, which would allow postprocessing
                } catch (err) {
                    // It is on the other hand an error for the JSON to be unreadable
                    debug("Failed to parse json at %s: %s", itemid, err.message);
                    cb(err);
                }
                cb(null, o);
            }
        })
    }

    _parse("meta", (err, o) => {
        if (err) {
            cb(new errors.NoLocalCopy());   // If can't read _meta then skip to reading from net rest are possibly optional though may be dependencies elsewhere.
        } else {
            res.metadata = o;
            _parse("files", (err, o) => {
                if (err) {
                    cb(new errors.NoLocalCopy());   // If can't read _meta then skip to reading from net rest are possibly optional though may be dependencies elsewhere.
                } else {
                    res.files = o;  // Undefined if failed which would be an error
                    res.files_count = res.files.length;
                    _parse("reviews", (err, o) => {
                        res.reviews = o; // Undefined if failed
                        _parse("extra", (err, o) => {
                            // Unavailable on archive.org but there on dweb.archive.org: collection_titles
                            // Not relevant on dweb.archive.org, d1, d2, dir, item_size, server, uniq, workable_servers
                            res.collection_titles = o.collection_titles;
                            cb(null, res);
                        });
                    });
                }
            });
        }
    });
};

ArchiveItem.prototype.fetch_metadata = function(opts={}, cb) {
    /*
    Fetch the metadata for this item if it hasn't already been.
    More flexible version than dweb-archive.ArchiveItem
    Monkey patched into dweb-archive.ArchiveItem so that it runs anywhere that dweb-archive attempts to fetch_metadata
    Alternatives:
    !cacheDirectory:    load from net
    cached:             return from cache
    !cached:            Load from net, save to cache

    cb(err, this) or if undefined, returns a promise resolving to 'this'
     */
    if (typeof opts === "function") { cb = opts; opts = {}; } // Allow opts parameter to be skipped
    const skipCache = opts.skipCache;           // If set will not try and read cache
    // noinspection JSUnresolvedVariable
    const cacheDirectory = config.directory;    // Cant pass as a parameter because things like "more" won't
    if (cb) { return f.call(this, cb) } else { return new Promise((resolve, reject) => f.call(this, (err, res) => { if (err) {reject(err)} else {resolve(res)} }))}        //NOTE this is PROMISIFY pattern used elsewhere
    function f(cb) {
        if (this.itemid && !this.item) { // Check haven't already loaded or fetched metadata
            if (cacheDirectory && !skipCache) { // We have a cache directory to look in
                //TODO-CACHE need timing of how long use old metadata
                this.read({cacheDirectory}, (err, metadata) => {
                    if (err) { // No cached version
                        console.assert(err.name === 'NoLocalCopy', "Havent thought about errors other than NoLocalCopy", this.itemid, err.message);
                        this._fetch_metadata((err, ai) => { // Process Fjords and _listload
                            if (err) {
                                cb(err); // Failed to read & failed to fetch
                            } else {
                                ai.save({cacheDirectory}, cb);  // Save data fetched (de-fjorded)
                            }
                        });    // resolves to this
                    } else {    // Local read succeeded.
                        this.item = metadata; // Saved Metadata will have processed Fjords and includes the reviews, files, and other fields of _fetch_metadata()
                        this._listLoad();
                        cb(null, this);
                    }
                })
            } else { // No cache Directory or skipCache telling us not to use it for read or save
                this._fetch_metadata(cb);
            }
        } else {
            cb(null, this);
        }
    }
};

ArchiveItem.prototype.fetch_query = function(opts={}, cb) {
    /*  Monkeypatch ArchiveItem.fetch_query to make it check the cache
     */
    if (typeof opts === "function") { cb = opts; opts = {}; } // Allow opts parameter to be skipped
    const skipCache = opts.skipCache; // Set if should ignore cache
    if (cb) { return f.call(this, cb) } else { return new Promise((resolve, reject) => f.call(this, (err, res) => { if (err) {reject(err)} else {resolve(res)} }))}

    function f(cb) {
        //TODO-CACHE-AGING
        // noinspection JSUnresolvedVariable
        const cacheDirectory = config.directory;    // Cant pass as a parameter because things like "more" won't
        if (cacheDirectory && !skipCache) {
            const filepath = path.join(cacheDirectory, this.itemid, this.itemid + "_members.json");
            fs.readFile(filepath, (err, jsonstring) => {
                if (!err)
                    this.items = canonicaljson.parse(jsonstring);  // Must be an array, will be undefined if parses wrong
                if (err || (typeof this.items === "undefined") || this.items.length < (Math.max(this.page,1)*this.limit)) { // Either cant read file (cos yet cached), or it has a smaller set of results
                    this._fetch_query(opts, (err, arr) => { // arr will be matching items (not ArchiveItems), fetch_query.items will have the full set to this point (note _list is the files for the item, not the ArchiveItems for the search)
                        if (err) {
                            debug("Failed to fetch_query for %s: %s", this.itemid, err.message); cb(err);
                        } else {
                            if (typeof arr === "undefined") {
                                // fetch_query returns undefined if not a collection
                                cb(null, undefined); // No results return undefined (which is what AI.fetch_query and AI._fetch_query do if no collection instead of empty array)
                            } else {
                                // TODO fix case where this will fail if search on page=1 then page=3 but will still right as 2 pages - just dont write in this case
                                fs.writeFile(filepath, canonicaljson.stringify(this.items), (err) => {
                                    if (err) {
                                        debug("Failed to write cached members at %s: %s", err.message); cb(err);
                                    } else {
                                        cb(null, arr); // Return just the new items found by the query
                                    }});
                            }
                        }});
                } else {
                    debug("Using cached version of query"); // TODO test this its not going to be a common case as should probably load the members when read metadata
                    let newitems = this.items.slice((this.page - 1) * this.limit, this.page * this.limit); // See copy of some of this logic in dweb-mirror.MirrorCollection.fetch_query
                    // Note that the info in _member.json is less than in Search, so may break some code unless turn into ArchiveItems
                    // Note this does NOT support sort, there isnt enough info in members.json to do that
                    cb(null, opts.wantFullResp ? this._wrapMembersInResponse(newitems) : newitems);
                }});
        } else {
            this._fetch_query(opts, cb); // Cache free fetch (like un-monkey-patched fetch_query
        }
    }
};


ArchiveItem.prototype.saveThumbnail = function({cacheDirectory = undefined,  skipfetchfile=false, wantStream=false} = {}, cb) {
    /*
    Save a thumbnail to the cache,
    wantStream      true if want stream instead of ArchiveItem returned
    skipfetchfile   true if should skip net retrieval - used for debugging
    cb(err, this)||cb(err, stream)  Callback on completion with self (mirroring), or on starting with stream (browser)
    */

    console.assert(cacheDirectory, "ArchiveItem needs a directory in order to save");
    const itemid = this.itemid; // Its also in this.item.metadata.identifier but only if done a fetch_metadata
    const dirpath = this._dirpath(cacheDirectory);

    function _err(msg, err, cb) {
        console.error(msg, err);
        if (cb) {   // cb will be undefined if cleared after calling with a stream
            cb(err);
        }
    }

    MirrorFS._mkdir(dirpath, (err) => { // Will almost certainly exist since typically comes after .save
        //TODO use new ArchiveItem.thumbnailFile that creates a AF for a pseudofile
        if (err) {
            _err(`Cannot mkdir ${dirpath} so cant save item ${itemid}`, err, cb);
        } else {
            const self = this; // this not available inside recursable or probably in writable('on)
            const thumbnailFiles = this._list.filter(af =>
                af.metadata.name === "__ia_thumb.jpg"
                || af.metadata.name.endsWith("_itemimage.jpg")
            );
            if (thumbnailFiles.length) {
                // noinspection JSUnusedLocalSymbols
                // Loop through files using recursion (list is always short)
                const recursable = function (err, streamOrUndefined) {
                    if (err) {
                        _err(`saveThumbnail: failed in cacheAndOrStream for ${itemid}`, err, cb)
                    } else {
                        if (wantStream && streamOrUndefined && cb) { // Passed back from first call to cacheOrStream if wantStream is set
                            cb(null, streamOrUndefined);
                            cb=undefined; } // Clear cb so not called when complete
                        let af;
                        if (typeof(af = thumbnailFiles.shift()) !== "undefined") {
                            af.cacheAndOrStream({cacheDirectory, skipfetchfile, wantStream}, recursable); // Recurse
                            // Exits, allowing recursable to recurse with next iteration
                        } else { // Completed loop
                            // cb will be set except in the case of wantStream in which case will have been called with first stream
                            if (cb) cb(null, self); // Important to cb only after saving, since other file saving might check its SHA and dont want a race condition
                        }
                    }
                };
                recursable(null, null);
            } else {  // No existing __ia_thumb.jpg or ITEMID_itemimage.jpg so get from services or thumbnail
                // noinspection JSUnresolvedVariable
                const servicesurl = config.archiveorg.servicesImg + this.itemid;
                // Include direct link to services
                if (!this.item.metadata.thumbnaillinks.includes(servicesurl)) this.item.metadata.thumbnaillinks.push(servicesurl);

                const filepath = path.join(cacheDirectory, itemid, "__ia_thumb.jpg"); // Assumes using __ia_thumb.jpg instead of ITEMID_itemimage.jpg
                const debugname = itemid+"/__ia_thumb.jpg";
                MirrorFS.cacheAndOrStream({cacheDirectory, filepath, skipfetchfile, wantStream, debugname,
                    urls: this.item.metadata.thumbnaillinks,
                    }, (err, streamOrUndefined) => {
                        if (err) {
                            debug("Unable to cacheOrStream %s",debugname); cb(err);
                        } else {
                            cb(null, wantStream ? streamOrUndefined : this);
                        }

                    });
            }
        }
    });
};
ArchiveItem.prototype.relatedItems = function({cacheDirectory = undefined, wantStream=false} = {}, cb) {
    /*
    Save the related items to the cache, TODO-CACHE-TIMING
    cb(err, obj)  Callback on completion with related items object
    */
    console.assert(cacheDirectory, "relatedItems needs a directory in order to save");
    const itemid = this.itemid; // Its also in this.item.metadata.identifier but only if done a fetch_metadata
    // noinspection JSUnresolvedVariable
    MirrorFS.cacheAndOrStream({cacheDirectory, wantStream,
        urls: config.archiveorg.related + "/" + itemid,
        filepath: path.join(cacheDirectory, itemid, itemid+"_related.json"),
        debugname: itemid + itemid + "_related.json"
    }, cb);
};

ArchiveItem.prototype.minimumForUI = function() {
    // This will be tuned for different mediatype etc}
    // Note mediatype will have been retrieved and may have been rewritten by processMetadataFjords from "education"
    console.assert(this._list, "minimumForUI assumes _list already set up");
    const minimumFiles = [];
    const thumbnailFiles = this._list.filter( af =>
        af.metadata.name === "__ia_thumb.jpg"
        || af.metadata.name.endsWith("_itemimage.jpg")
    );
    // Note thumbnail is also explicitly saved by saveThumbnail
    minimumFiles.push(...thumbnailFiles);
    switch (this.item.metadata.mediatype) {
        case "collection": //TODO-THUMBNAILS
            break;
        case "texts": //TODO-THUMBNAILS for text - texts use the Text Reader anyway so dont know which files needed
            break;
        case "image":
            minimumFiles.push(this._list.find(fi => fi.playable("image"))); // First playable image is all we need
            break;
        case "audio":  //TODO-THUMBNAILS check that it can find the image for the thumbnail with the way the UI is done. Maybe make ReactFake handle ArchiveItem as teh <img>
        case "etree":   // Generally treated same as audio, at least for now
            if (!this.playlist) this.setPlaylist();
            // Almost same logic for video & audio
            minimumFiles.push(...Object.values(this.playlist).map(track => track.sources[0].urls)); // First source from each (urls is a single ArchiveFile in this case)
            // Audio uses the thumbnail image, puts URLs direct in html, but that always includes http://dweb.me/thumbnail/itemid which should get canonicalized
            break;
        case "movies":
            if (!this.playlist) this.setPlaylist();
            // Almost same logic for video & audio
            minimumFiles.push(...Object.values(this.playlist).map(track => track.sources[0].urls)); // First source from each (urls is a single ArchiveFile in this case)
            minimumFiles.push(this.videoThumbnailFile());
            break;
        case "account":
            break;
        default:
            //TODO Not yet supporting software, zotero (0 items); data; web because rest of dweb-archive doesnt
    }
    return minimumFiles;
};

exports = module.exports = ArchiveItem;