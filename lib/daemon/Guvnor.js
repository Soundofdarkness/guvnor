var Autowire = require('wantsit').Autowire,
  path = require('path'),
  async = require('async'),
  EventEmitter = require('wildemitter'),
  util = require('util'),
  PersistentStore = require('./domain/PersistentStore'),
  semver = require('semver')

var Guvnor = function() {
  EventEmitter.call(this, {
    wildcard: true,
    delimiter: ':'
  })

  this._config = Autowire
  this._logger = Autowire
  this._processService = Autowire
  this._fs = Autowire
  this._usage = Autowire
  this._cpuStats = Autowire
  this._remoteUserService = Autowire
  this._nodeInspectorWrapper = Autowire
  this._os = Autowire
  this._appService = Autowire
  this._pem = Autowire
  this._ini = Autowire
  this._posix = Autowire
  this._etc_passwd = Autowire

  this._processInfoStore = Autowire
  this._processInfoStoreFactory = Autowire
}
util.inherits(Guvnor, EventEmitter)

Guvnor.prototype.afterPropertiesSet = function() {
  process.title = 'guvnor'

  if(this._config.guvnor.autoresume) {
    async.series(this._processInfoStore.all().map(function(processInfo) {
      return function(callback) {
        this._processService.startProcess(processInfo, function(error) {
          if(error) this._logger.error('Error resuming process', processInfo.name, error)

          // don't pass the error callback because if we do, we'll abort resuming the rest of the processes
          callback()
        }.bind(this))
      }.bind(this)
    }.bind(this)), function(error) {
      if(error) this._logger.error('Error resuming processes', error)
    }.bind(this))
  }
}

/**
 * Start a new NodeJS process
 *
 * @param {String} script The path to the NodeJS script to start
 * @param {Object} options
 * @param {Number} [options.instances] The number of instances to start (1)
 * @param {String} [options.name] Name to give the process (script filename)
 * @param {String|Number} [options.user] User name or uid to start the process as (current user)
 * @param {String|Number} [options.group] Group name or gid to start the process as (current group)
 * @param {Boolean} [options.restartOnError] Restart the process automatically when it exits abnormally (true)
 * @param {Number} [options.restartRetries] Number of times the process can be restarted when crashing (5)
 * @oaram {Number} [options.crashRecoveryPeriod] The time before the process is considered to not be crashing (5000ms)
 * @param {Object} [options.env] Process environment key/value pairs
 * @param {Function} callback Called on successful process start or on startup error
 * @returns {Number} PID of the process that was started
 */
Guvnor.prototype.startProcess = function(script, options, callback) {
  var appInfo = this._appService.findByName(script)

  if(appInfo) {
    options.script = appInfo.path
    options.app = appInfo.id
    options.name = appInfo.name
  }

  this._processService.startProcess(script, options, callback)
}

Guvnor.prototype.startProcessAsUser = function(script, options, callback) {
  this.startProcess(script, options, callback)
}

Guvnor.prototype.removeProcess = function(id, callback) {
  this._processService.removeProcess(id, callback)
}

Guvnor.prototype.getServerStatus = function(callback) {
  async.parallel([
    this._cpuStats.bind(this._cpuStats),
    this._etc_passwd.getGroups.bind(this._etc_passwd)
  ], function(error, results) {
    var status = {
      time: Date.now(),
      uptime: this._os.uptime(),
      freeMemory: this._os.freemem(),
      totalMemory: this._os.totalmem(),
      cpus: this._os.cpus(),
      debuggerPort: this._config.remote.inspector.enabled ? this._nodeInspectorWrapper.debuggerPort : undefined
    }

    if(!error) {
      results[0].forEach(function(load, index) {
        status.cpus[index].load = load
      })

      // only return groups without the _ prefix
      status.groups = results[1].filter(function(group) {
        return group.groupname.substring(0, 1) != '_'
      }).map(function(group) {
        return group.groupname
      })

      status.users = []

      status.groups.forEach(function(group) {
        this._posix.getgrnam(group).members.forEach(function(user) {
          if(user.substring(0, 1) == '_') {
            return
          }

          if(status.users.indexOf(user) == -1) {
            status.users.push(user)
          }
        })
      }.bind(this))
    }

    callback(error, status)
  }.bind(this))
}

Guvnor.prototype.listProcesses = function(callback) {
  async.parallel(this._processService.listProcesses().map(function(processInfo) {
    return function(callback) {
      var language = processInfo.script.substring(processInfo.script.length - '.coffee'.length) == '.coffee' ? 'coffee' : 'javascript'

      if(!processInfo.remote || processInfo.status != 'running') {
        // this process is not ready yet
        return callback(undefined, {
          id: processInfo.id,
          name: processInfo.name,
          restarts: processInfo.totalRestarts,
          status: processInfo.status,
          script: processInfo.script,
          debugPort: processInfo.debugPort,
          user: processInfo.user,
          group: processInfo.group,
          cwd: processInfo.cwd,
          argv: processInfo.argv,
          execArgv: processInfo.execArgv,
          pid: processInfo.pid,
          language: language
        })
      }

      processInfo.remote.reportStatus(function(error, status) {
        var processStatus = processInfo.status

        if(error && error.code == 'TIMEOUT') {
          processStatus = 'unresponsive'
        }

        status = status || {}
        status.restarts = processInfo.totalRestarts
        status.id = processInfo.id
        status.script = processInfo.script
        status.debugPort = processInfo.debugPort
        status.status = processStatus
        status.language = language

        callback(undefined, status)
      })
    }.bind(this)
  }.bind(this)), callback)
}

Guvnor.prototype.findProcessInfoById = function(id, callback) {
  callback(undefined, this._processService.findById(id))
}

Guvnor.prototype.findProcessInfoByPid = function(pid, callback) {
  callback(undefined, this._processService.findByPid(pid))
}

Guvnor.prototype.findProcessInfoByName = function(name, callback) {
  callback(undefined, this._processService.findByName(name))
}

Guvnor.prototype.dumpProcesses = function(callback) {
  this._processInfoStore.save(callback)
}

Guvnor.prototype.restoreProcesses = function(callback) {
  this._processInfoStoreFactory.create(['processInfoFactory', 'processes.json'], function(error, store) {
    if(error) return callback(error)

    async.series(store.all().map(function(processInfo) {
      return this._processService.startProcess.bind(this._processService, processInfo.script, processInfo)
    }.bind(this)), function(error, result) {
      callback(error, result)
    })
  }.bind(this))
}

Guvnor.prototype.kill = function(callback) {
  this._nodeInspectorWrapper.stopNodeInspector()
  this._processService.killAll()

  if(this._config.guvnor.autoresume) {
    this.dumpProcesses(function(error) {
      if(callback) {
        callback(error)
      }

      process.nextTick(process.exit.bind(process, 0))
    })
  } else {
    if(callback) {
      callback()
    }

    process.nextTick(process.exit.bind(process, 0))
  }
}

Guvnor.prototype.remoteHostConfig = function(callback) {
  this._remoteUserService.findOrCreateUser(this._config.guvnor.user, function(error, user) {
    callback(
      error,
      this._os.hostname(),
      this._config.remote.port,
      this._config.guvnor.user,
      user.secret
    )
  }.bind(this))
}

Guvnor.prototype.addRemoteUser = function(userName, callback) {
  this._remoteUserService.createUser(userName, callback)
}

Guvnor.prototype.removeRemoteUser = function(userName, callback) {
  if(userName == this._config.guvnor.user) {
    var error = new Error('Cowardly refusing to delete ' + this._config.guvnor.user)
    error.code = 'WILLNOTREMOVEGUVNORUSER'

    return callback(error)
  }

  this._remoteUserService.removeUser(userName, callback)
}


Guvnor.prototype.listRemoteUsers = function(callback) {
  this._remoteUserService.listUsers(callback)
}

Guvnor.prototype.rotateRemoteUserKeys = function(userName, callback) {
  this._remoteUserService.rotateKeys(userName, callback)
}

Guvnor.prototype.sendSignal = function(processId, signal, callback) {
  var process = this._processService.processes[processId]

  if(!process) {
    return callback(new Error('No process for id '+ processId))
  }

  var error

  try {
    // invalid signal names cause errors to be thrown
    process.process.kill(signal)
  } catch(e) {
    error = e
  }

  callback(error)
}

Guvnor.prototype.deployApplication = function(name, url, user, onOut, onErr, callback) {
  this._appService.deploy(name, url, user, onOut, onErr, callback)
}

Guvnor.prototype.removeApplication = function(name, callback) {
  this._appService.remove(name, callback)
}

Guvnor.prototype.listApplications = function(callback) {
  this._appService.list(callback)
}

Guvnor.prototype.switchApplicationRef = function(name, ref, onOut, onErr, callback) {
  this._appService.switchRef(name, ref, onOut, onErr, callback)
}

Guvnor.prototype.listApplicationRefs = function(name, callback) {
  this._appService.listRefs(name, callback)
}

Guvnor.prototype.updateApplicationRefs = function(name, onOut, onError, callback) {
  this._appService.updateRefs(name, onOut, onError, callback)
}

Guvnor.prototype.generateRemoteRpcCertificates = function(days, callback) {
  this._pem.createCertificate({
    days: days,
    selfSigned: true
  }, function(error, keys) {
    if(error) return callback(error)

    var keyPath = this._config.confdir + '/rpc.key'
    var certPath = this._config.confdir + '/rpc.cert'
    var configPath = this._config.confdir + '/guvnorrc'

    async.parallel([
      this._fs.writeFile.bind(this._fs, keyPath, keys.serviceKey, {
        mode: 0600
      }),
      this._fs.writeFile.bind(this._fs, certPath, keys.certificate, {
        mode: 0600
      })
    ], function(error) {
      if(error) return callback(error)

      this._fs.readFile(configPath, 'utf-8', function(error, result) {
        if(error && error.code != 'ENOENT') return callback(error)

        var config = {}

        if(result) {
          config = this._ini.parse(result)
        }

        config.remote = config.remote || {}
        config.remote.key = keyPath
        config.remote.certificate = certPath

        this._fs.writeFile(configPath, this._ini.stringify(config), {
          mode: 0600
        }, function(error) {
          callback(error, configPath)
        })
      }.bind(this))
    }.bind(this))
  }.bind(this))
}

module.exports = Guvnor