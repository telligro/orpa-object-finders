/**
 *  Copyright Telligro Pte Ltd 2017
 *
 *  This file is part of OPAL.
 *
 *  OPAL is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU General Public License as published by
 *  the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  OPAL is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU General Public License for more details.
 *
 *  You should have received a copy of the GNU General Public License
 *  along with OPAL.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict';
const path = require('path');
const puppeteer = require('@telligro/puppeteer');
const check = require('check-types');
const VError = require('verror');
const nopt = require('nopt');
const fs = require('fs');
console.log('Setting Dispatcher ..........................................................................');
const Dispatcher = require('./dispatcher').Dispatcher;
const DispatcherInstance = new Dispatcher();
let knownOpts = {
    'help': Boolean,
    'port': Number,
    'settings': [path],
    'title': String,
    'userDir': [path],
    'verbose': Boolean,
};

let shortHands = {
    '?': ['--help'],
    'p': ['--port'],
    's': ['--settings'],
    // As we want to reserve -t for now, adding a shorthand to help so it
    // doesn't get treated as --title
    't': ['--help'],
    'u': ['--userDir'],
    'v': ['--verbose'],
};

nopt.invalidHandler = function(k, v, t) {
    console.log(k, v, t);
};

let parsedArgs = nopt(knownOpts, shortHands, process.argv, 2);

let sessions = {};
let jQueryContent = fs.readFileSync(path.join(__dirname, 'vendor', 'jquery-3.2.1.min.js'), 'utf8');
let finderContent = fs.readFileSync(path.join(__dirname, 'finder.min.js'), 'utf8');
const httpRxp = new RegExp('^(http|https)://', 'i');
function getUniqueId() {
    return (1 + Math.random() * 4294967295).toString(16);
}


let finderSvc = {};
let finderActive = false;
let Errors = {
    PUP_PAGE_EVAL_ERROR: 'there was an error in page.eval call made to upstream api: %s',
};
class FinderPluginSvc {
    constructor(notify, objId, objName) {
        console.log('Creating Finder Svc ', this);
        console.log('notify', notify);
        console.log('finderSvc', finderSvc);
        // if (!finderSvc) {
        //     finderSvc = this;
        // }
        console.log('Created::::::::::::::', objId, '::', objName);
        this.objId = objId;
        this.objName = objName;
        finderSvc[objName] = notify;
        // this.finderActive = false;

        return this;
    }

    async _handleFrameLoad(sessionId, jQueryContent, finderContent, frame, retry) {
        retry = (typeof retry !== 'number') ? 0 : retry;

        try {
            let frameUrl = frame.url().toLowerCase();
            if (frameUrl === '' || frameUrl === 'about:blank' || frameUrl === 'about:srcdoc') {
                // console.log('Skipping frame');
                return true;
            }
            console.log('Attached N [%s], [%s], [%s]', frame.isDetached(), frame.name(), frame.url());
            await frame.waitForFunction(() => {
                if (document.readyState === 'complete') {
                    console.log('%s readyState - %s', window.location.href, document.readyState);
                    return true;
                }
                return false;
            });
        } catch (ex) {
            // console.log('Something not readay error');
            // console.log(ex);
            let errEvalNotReady = new VError(ex, Errors.PUP_PAGE_EVAL_ERROR, 'waitForFunction');
            console.warn(errEvalNotReady.message);
            if (retry < 3) {
                retry++;
                console.log('Retrying %s %s', retry++, frame.url());
                await setTimeout(this._handleFrameLoad.bind(this), 1000, sessionId, jQueryContent, finderContent, frame, retry);
                return true;
            } else {
                console.warn('Retry Exhausted');
                console.warn(errEvalNotReady);
            }
        }

        // await frame.waitForNavigation({ waitUntil: 'load' });
        // console.log(frame._id);
        let frameUrl = frame.url().toLowerCase();
        if (frameUrl === '' || frameUrl === 'about:blank' || frameUrl === 'about:srcdoc') {
            // console.log('Skipping frame');
            return true;
        }

        const frameExCtxt = await frame.executionContext();
        const frameUrlGot = await frameExCtxt.evaluate(() => Promise.resolve(window.location.href));
        console.log('Attached: %s', frameUrlGot);

        await this._injectScriptToFrame(frame, jQueryContent, 'InjectJQ');
        await this._injectScriptToFrame(frame, finderContent, 'InjectFinder');
        console.log(`Activate Finder ${this.finderActive}`);
        if (this.finderActive) {
            this.startFinder({sessionId: sessionId});
        }

        return true;
    }

    async _injectScriptToFrame(frame, scriptContent, scriptId) {
        const frameExCtxt = await frame.executionContext();
        let scriptInjected = await frameExCtxt.evaluate((scrId) => {
            return document.querySelector(`#${scrId}`) != null;
        }, scriptId);
        if (!scriptInjected) {
            // console.log(`Injecting ${scriptId} for ${frame.url()}`);
            let scriptHandle = await frame.addScriptTag({content: scriptContent});
            const scriptExCtxt = await scriptHandle.executionContext();
            await scriptExCtxt.evaluate((scriptEl, scrId) => {
                let sid = scriptEl.getAttribute('id');
                // console.log(`Existing ${sid}`);
                scriptEl.setAttribute('id', scrId);
                sid = scriptEl.getAttribute('id');
                // console.log(`New ${sid}`);
                return Promise.resolve(sid);
            }, scriptHandle, scriptId);
            scriptHandle.dispose();
        } else {
            // console.log(`Skip Injecting ${scriptId} for ${frame.url()}`);
        }
        return Promise.resolve(!scriptInjected);
    }

    async _executeInAllFramesStop(parent, pageFn, pageFnArgs, pageFnThis, sessionId) {
        if (parent) {
            const parentExCtxt = await parent.executionContext();
            const finderStarted = await parentExCtxt.evaluate(() => !!window.finder);
            if (finderStarted) {
                try {
                    console.log('Stopping Finder here %s', parent.url());
                    await parentExCtxt.evaluate((oid, oname) => {
                        try {
                            if (!!window.finder) {
                                // console.log('Finder already initialized');
                            } else {
                                console.log('stopFinder: Initializing Finder');
                                window.finder = new Finder(document);
                            }
                            window.finderRequestOId = oid;
                            window.finderRequestOName = oname;
                            window.finder.stop();
                        } catch (ex) {
                            let errCreateFinder = new Error(ex.message + ': stopFinder: Could not create Finder ' + window.location.href);
                            console.error(errCreateFinder.message);
                            // throw errCreateFinder;
                        }
                    }, this.objId, this.objName);
                } catch (ex) {
                    let errStopFinder = new VError(ex, 'stopFinder: Failed stop');
                    console.error(errStopFinder.message);
                    // throw errCreateFinder;
                }
            }

            for (let child of parent.childFrames()) {
                this._executeInAllFramesStop(child, pageFn, pageFnArgs, pageFnThis, sessionId);
            }
        }
        return Promise.resolve();
    }

    async _executeInAllFramesStart(parent, pageFn, pageFnArgs, pageFnThis, sessionId) {
        if (parent) {
            const parentExCtxt = await parent.executionContext();
            const finderStarted = await parentExCtxt.evaluate(() => !!window.finder && !window.finderStopped);
            if (finderStarted) {
                console.log('Finder Already Started here %s', parent.url());
            } else {
                // console.log('Executing in Frame');
                // console.log(parent.url());
                // console.log('Typeof pageFn %s', typeof pageFn);
                // console.log('Typeof pageFnArgs %s %s %s %s', typeof pageFnArgs, Array.isArray(pageFnArgs), pageFnArgs.length, typeof pageFnArgs[0]);
                // pageFnThis ? pageFnThis : this; //TODO: Use the singleton instance of this class
                // pageFnArgs = Array.isArray(pageFnArgs) ? pageFnArgs : [pageFnArgs];
                try {
                    await parentExCtxt.evaluate((oid, oname) => {
                        // console.log('startFinder: Checking for Finder');
                        try {
                            if (!!window.finder) {
                                // console.log('Finder already initialized');
                            } else {
                                console.log('startFinder: Initializing Finder');
                                window.finder = new Finder(document);
                            }

                            window.finderRequestOId = oid;
                            window.finderRequestOName = oname;

                            if (window.finderStopped === undefined || window.finderStopped === true) {
                                window.finder.start((found) => {
                                    console.log('Found for ', window.finderRequestOId, ':::', window.finderRequestOName);
                                    console.log('Found a object %j', found);
                                    if (window.notifyObjectFound) {
                                        window.notifyObjectFound(found, window.location.href, window.finderRequestOId, window.finderRequestOName);
                                    } else {
                                        console.log('Cannot invoke from this context: window.notifyObjectFound(found, window.location.href);');
                                    }
                                });
                            }
                        } catch (ex) {
                            let errCreateFinder = new Error(ex.message + ': startFinder: Could not create Finder ' + window.location.href);
                            console.error(errCreateFinder.message);
                            // throw errCreateFinder;
                        }
                        // window.finder.start(onFound);
                    }, this.objId, this.objName);
                } catch (ex) {
                    let errStartFinder = new VError(ex, 'startFinder: Failed start');
                    console.error(errStartFinder.message);
                    // throw errCreateFinder;
                }
                // console.log('Before Typeof pageFnArgs', pageFnArgs);
                // console.log('After Typeof pageFnArgs', pageFnArgs);
            }

            for (let child of parent.childFrames()) {
                await this._executeInAllFramesStart(child, pageFn, pageFnArgs, pageFnThis, sessionId);
            }
        }
        return Promise.resolve();
    }
    async getBrowser(session, launchOpts, startNew) {
        console.log('getBrowser');
        let browser;
        // session = session ? session : {};
        startNew = startNew !== false;
        try {
            if (session && session.browserWSEndpoint) {
                console.log('Connecting %s', session.browserWSEndpoint);
                try {
                    browser = await puppeteer.connect({browserWSEndpoint: session.browserWSEndpoint});
                } catch (connectErr) {
                    console.log(connectErr);
                    if (connectErr.code === 'ECONNREFUSED' && startNew) {
                        delete sessions[session.id];
                        browser = await this.getBrowser(undefined, launchOpts, startNew);
                    }
                }
            } else if (startNew) {
                console.log('Starting New');
                browser = await puppeteer.launch(launchOpts);
                let browserWSEndpoint = browser.wsEndpoint();
                browser.on('targetdestroyed', (target) => {
                    try {
                        if (target && target._targetInfo && target._targetInfo.targetId) {
                            console.log('Target Destroyed %s', target._targetInfo.targetId);
                            // sessions = Object.keys(sessions).map((sid) => {
                            //     let sess = sessions[sid];
                            //     console.log('Finding to invalidate %s - %s', sess.targetId, target._targetInfo.targetId);
                            //     if (sess.targetId && sess.targetId === target._targetInfo.targetId) {
                            //         console.log('Invalidated %s', sess.targetId);
                            //         sess.targetId = 'Invalid';
                            //         // return false;
                            //     }
                            //     return sess;
                            // })
                        }
                    } catch (ex) {
                        console.log('Error removing destroyed target session');
                        console.log(ex);
                    }
                });
                console.log('Launching %s', browserWSEndpoint);
            } else {
                throw new VError('No existing session. Not starting a new one');
            }
        } catch (ex) {
            // TODO:This is not recoverable. Report error back to caller.
            console.log('Launch Failed');
            console.log(ex);
        }
        return browser;
    }

    async getPage(browser, session) {
        console.log('GetPages');
        const pages = await browser.pages();
        let page = session && session.targetId ? pages.find((page) => page._client._targetId && page._client._targetId === session.targetId) : undefined;
        if (page === undefined) {
            console.log('Page %s not found, creating new');
            page = browser.newPage();
        } else {
            console.log('Page %s found', session.targetId);
            // Page that is found is valid, as it was fetched from current instance.
        }
        return page;
    }


    // Public Members

    async connectToBrowser(params, url, opts) {
        finderActive = true;
        let sessionId = params.sessionId;
        console.log('connectToBrowser %j', params);
        opts = opts === undefined ? params.opts : opts;
        // sessionId = sessionId ? sessionId : getUniqueId();
        // let session = sessions[sessionId];
        let browser;
        let page;
        try {
            const launchOpts = Object.assign({headless: false}, opts && opts.launch ? opts.launch : {});
            if (!launchOpts.executablePath) {
                launchOpts.executablePath = process.env.FINDER_CHROME_PATH ? path.resolve(process.env.FINDER_CHROME_PATH) : puppeteer.executablePath();
            }

            browser = await this.getBrowser(sessions[sessionId], launchOpts);
            console.log('gotBrowser');
            // console.log(browser);
            page = await this.getPage(browser, sessions[sessionId]);
            console.log('gotPage');
            // console.log(page);
            let session = sessions[sessionId];
            if (session === undefined) {
                sessionId = getUniqueId();
            }
            session = {
                id: sessionId,
                browserWSEndpoint: browser.wsEndpoint(),
                targetId: page._client._targetId,
                launchOpts: launchOpts,
            };


            sessions[sessionId] = session;


            // if (session && session.browserWSEndpoint) {
            //     browser = getBrowser(session.browserWSEndpoint);
            //     page = getPage(browser, session.targetId);
            //     console.log('Using existing session %s', sessionId);
            // } else {


            //     console.log('Launching new session %s %j', sessionId, launchOpts);
            //     browser = await puppeteer.launch(launchOpts);

            //     page = await browser.newPage();
            //     session.browserWSEndpoint = browser.wsEndpoint();
            //     session.targetId = page._client._targetId;
            //     sessions[sessionId] = session;
            // }

            try {
                console.log('Now: %s', page.url().replace(httpRxp, ''));
                console.log('Required: %s', params.url);
                console.log(this.objId, '_-_', this.objName);
                let isInitialized = await page.evaluate((oid, oname) => {
                    console.log('Finder %s', typeof Finder);
                    console.log('notifyObjectFound %s', typeof notifyObjectFound);
                    console.log('window.Finder %s', typeof window.Finder);
                    console.log('window.Finder %s', typeof window.notifyObjectFound);
                    window.finderRequestOId = oid;
                    window.finderRequestOName = oname;
                    return Promise.resolve(window.notifyObjectFound && Finder);
                }, this.objId, this.objName);

                if (!isInitialized) {
                    // page.url().replace(httpRxp, '') !== params.url.replace(httpRxp, '')) {
                    console.log('Injecting All ExposeFunctions');
                    // await page.exposeFunction('InjectOrpaController', async (pmsg, url, doc, docParent, frEl) => {
                    //     console.log('Page says %s from %s - %s', pmsg, url, finderActive);
                    // });

                    await page.exposeFunction('notifyObjectFound', async (pmsg, url, oid, oname) => {
                        console.log(this);
                        console.log('Found object %j in %s', pmsg, url);
                        console.log('Request ', oid, ':', oname);
                        finderSvc[oname]('ObjectFound', {data: pmsg, reqOId: oid, reqOName: oname});
                        return true;
                    });

                    // await page.exposeFunction('isFinderActive', async (pmsg, url) => {
                    //     console.log('Finder Active: %s', finderActive);
                    //     return {active: finderActive};
                    // })
                    console.log('Module Directory : %s', __dirname);
                    // console.log('DirName :' + process.cwd());
                    page.on('framenavigated', this._handleFrameLoad.bind(this, sessionId, jQueryContent, finderContent));
                }
            } catch (ex) {
                let error = new VError(ex, 'Page already processed');
                console.log(error);
            }

            if (params.url && page.url().replace(httpRxp, '') !== params.url.replace(httpRxp, '')
                && page.url().replace(httpRxp, '').indexOf(params.url.replace(httpRxp, '')) == -1) {
                await page.goto(params.url, {waitUntil: 'domcontentloaded', timeout: 50000});
                console.log('Navigation Complete %s', page.url());
            } else {
                console.log('Nvigation Cancelled');
            }


            // console.log('Script Injected');

            // console.log('On Load Attached');
            return Promise.resolve({sessionId: sessionId});
        } catch (ex) {
            let error = new VError(ex, 'Could not Inject');
            console.log(error);
        }
    }

    async startFinder(params) {
        console.log('startFinder Params %j', params);
        this.finderActive = true;
        let sessionId = params.sessionId;
        let session = sessions[sessionId];
        console.log(session);
        if (!!session) {
            let browser = await this.getBrowser(session, session.launchOpts);
            let page = await this.getPage(browser, session);
            await this._executeInAllFramesStart(page.mainFrame(), null, null, null, sessionId);
        }
        return Promise.resolve(true);
    }

    async stopFinder(params) {
        console.log('stopFinder Params %j', params);
        this.finderActive = false;
        let sessionId = params.sessionId;
        let session = sessions[sessionId];
        console.log(session);
        if (!!session) {
            try {
                let browser = await this.getBrowser(session, session.launchOpts, false);
                let page = await this.getPage(browser, session);
                await this._executeInAllFramesStop(page.mainFrame(), null, null, null, sessionId);
            } catch (stopFinderErr) {
                // Ignore errors
                console.warn(stopFinderErr);
            }
        }
        return Promise.resolve(true);
    }
}

process.on('unhandledRejection', (reason, p) => {
    console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
    // application specific logging, throwing an error, or other logic here
});
module.exports = {
    FinderPluginSvc: FinderPluginSvc,
    Dispatcher: DispatcherInstance,
};
