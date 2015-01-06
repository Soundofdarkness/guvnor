var Autowire = require('wantsit').Autowire,
  EventEmitter = require('events').EventEmitter,
  util = require('util'),
  async = require('async')

/**
 * Creates a dnode instance that listens on a filesystem socket for
 * a message to stop this process.
 *
 * The socket's read/write access is controlled by filesystem permissions.
 */
var ProcessRPC = function() {
  EventEmitter.call(this)

  this._userInfo = Autowire
  this._parentProcess = Autowire
  this._dnode = Autowire
  this._fs = Autowire
  this._usage = Autowire
  this._heapdump = Autowire
  this._config = Autowire
  this._latencyMonitor = Autowire
}
util.inherits(ProcessRPC, EventEmitter)

ProcessRPC.prototype.startDnodeServer = function(callback) {
  this.socket = this._config.boss.rundir + '/processes/' + process.pid

  var api = {}

  var nonAPIMethods = [
    // ProcessRPC
    'afterPropertiesSet', 'getSocket',

    // EventEmitter
    'addListener', 'on', 'once', 'removeListener', 'removeAllListeners', 'setMaxListeners', 'listeners', 'emit'
  ]

  for(var method in this) {
    // ignore anything that isn't a function, is prefixed with '_' or is in the nonAPIMethods array
    if(typeof this[method] != 'function' ||
      method.substring(0, 1) == '_' ||
      nonAPIMethods.indexOf(method) != -1) {
      continue
    }

    api[method] = this[method].bind(this)
  }

  // publish RPC methods
  var dnode = this._dnode(api)

  async.series([
    dnode.listen.bind(dnode, this.socket),
    this._fs.chown.bind(this._fs, this.socket, this._userInfo.getUid(), this._userInfo.getGid()),
    this._fs.chmod.bind(this._fs, this.socket, 0770)
  ], function(error) {
    callback(error, this.socket)
  }.bind(this))
}

ProcessRPC.prototype.kill = function(callback) {
  this._parentProcess.send('process:stopping')

  this._fs.unlink(this.socket, function(error) {
    if(callback) callback(error)

    process.exit(error ? 1 : 0)
  }.bind(this))
}

ProcessRPC.prototype.restart = function(callback) {
  this._parentProcess.send('process:restarting')

  this._fs.unlink(this.socket, function(error) {
    if(callback) callback(error)

    process.exit(error ? 1 : 0)
  }.bind(this))
}

ProcessRPC.prototype.send = function() {
  process.emit.apply(process, arguments)
}

ProcessRPC.prototype.reportStatus = function(callback) {
  this._usage.lookup(process.pid, {
    keepHistory: true
  }, function(error, result) {
    var memory = process.memoryUsage()

    callback(error, {
        pid: process.pid,
        uid: process.getuid(),
        gid: process.getgid(),
        user: this._userInfo.getUserName(),
        group: this._userInfo.getGroupName(),
        name: process.title,
        uptime: process.uptime(),
        cpu: result ? result.cpu : 0,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        residentSize: memory.rss,
        time: Date.now(),
        cwd: process.cwd(),
        argv: process.argv,
        execArgv: process.execArgv,
        latency: this._latencyMonitor.latency
      }
    )
  }.bind(this))
}

ProcessRPC.prototype.dumpHeap = function(callback) {
  this._parentProcess.send('process:heapdump:start')
  var here = process.cwd()

  this._heapdump.writeSnapshot(function(error, fileName) {
    if(error) {
      this._parentProcess.send('process:heapdump:error')
    } else {
      this._parentProcess.send('process:heapdump:complete')
    }

    // only the filename is passed, not the whole path :(
    // https://github.com/bnoordhuis/node-heapdump/issues/42
    if(callback) process.nextTick(callback.bind(null, error, fileName ? here + '/' + fileName : undefined))
  }.bind(this))
}

ProcessRPC.prototype.forceGc = function(callback) {
  this._parentProcess.send('process:gc:start')

  if(global && typeof global.gc == 'function') {
    global.gc()
  }

  this._parentProcess.send('process:gc:complete')

  if(callback) process.nextTick(callback)
}

module.exports = ProcessRPC