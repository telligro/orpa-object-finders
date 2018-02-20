/**
 *  Copyright Telligro Pte Ltd 2017
 *  Copyright 2016 The Chromium Authors. All rights reserved.
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
let http = require('http');
let ws = require('ws');

function Dispatcher() {
    this._constructors = new Map();
    this._connections = new Set();
}

Dispatcher.prototype = {
    start: function(port) {
        let httpServer = http.createServer();
        httpServer.once('error', function(err) {
            if (err.code === 'EADDRINUSE') {
                console.warn('Dispatcher already started on', port);
            }
        });
        try {
            httpServer.listen(port);
        } catch (ex) {
            console.warn('[warn] Dispatcher Already Started');
            return;
        }
        let WebSocketServer = ws.Server;
        let options = {server: httpServer, path: '/svc'};
        let wss = new WebSocketServer(options);
        wss.on('connection', (socket) => {
            console.log('SRV :::: Connected');
            let connection = new Connection(this, socket);
            this._connections.add(connection);
        });
    },

    registerObject: function(name, constructor) {
        this._constructors.set(name, constructor);
    },

    _connectionClosed: function(connection) {
        this._connections.delete(connection);
    },
};

exports.Dispatcher = Dispatcher;

function Connection(dispatcher, socket) {
    this._dispatcher = dispatcher;
    this._objects = new Map();
    this._lastObjectId = 1;
    this._socket = socket;
    this._socket.on('message', this._dispatchMessageWrapped.bind(this));
    this._socket.on('close', this._connectionClosed.bind(this));
}

Connection.prototype = {
    _dispatchMessageWrapped: function(data) {
        console.log('SRV :::: Message %s', data);
        try {
            let message = JSON.parse(data);
            this._dispatchMessage(message);
        } catch (e) {
            this._sendErrorResponse(message.id, e.toString());
        }
    },

    _dispatchMessage: function(message) {
        let [objectName, method] = message.method.split('.');
        let result = JSON.stringify({id: message.id});
        let constructor = this._dispatcher._constructors.get(objectName);
        if (!constructor) {
            this._sendErrorResponse(message.id, 'Could not resolve service \'' + objectName + '\'');
            return;
        }
        if (method === 'create') {
            let id = String(this._lastObjectId++);
            let object = new constructor(this._notify.bind(this, id, objectName), id, objectName);
            this._objects.set(id, object);
            this._sendResponse(message.id, {id: id});
        } else if (method === 'dispose') {
            let object = this._objects.get(message.params.id);
            if (!object) {
                console.error(method + ': Could not look up object with id for ' + JSON.stringify(message));
                return;
            }
            this._objects.delete(message.params.id);
            object.dispose().then(() => this._sendResponse(message.id));
        } else {
            if (!message.params) {
                console.error(method + ': No params in the message: ' + JSON.stringify(message));
                return;
            }
            let object = this._objects.get(message.params.id);
            if (!object) {
                console.error(method + ': Could not look up object with id for ' + JSON.stringify(message));
                message.error = method + ': Could not look up object with id for ';
                this._sendErrorResponse(message.id, JSON.stringify(message));
                return;
            }
            let handler = object[method];
            if (!(handler instanceof Function)) {
                console.error('Handler for \'' + method + '\' is missing.');
                return;
            }
            object[method](message.params).then((result) => this._sendResponse(message.id, result));
        }
    },

    _connectionClosed: function() {
        for (let object of this._objects.values()) {
            try {
                object.dispose();
            } catch (ex) {
                console.error(ex);
            }
        }
        this._objects.clear();
        this._dispatcher._connectionClosed(this);
    },

    _notify: function(objectId, objectName, method, params) {
        params['id'] = objectId;
        let message = {method: objectName + '.' + method, params: params};
        this._socket.send(JSON.stringify(message));
    },

    _sendResponse: function(messageId, result) {
        let message = {id: messageId, result: result};
        this._socket.send(JSON.stringify(message));
    },

    _sendErrorResponse: function(messageId, error) {
        let message = {id: messageId, error: error};
        this._socket.send(JSON.stringify(message));
    },
};
