'use strict'

const winston = require('winston')

if (!process.env.QUIET) {
  winston.level = 'debug'
}

winston.cli()

const configureBrowser = require('../fixtures/browser')

module.exports = {
  before: (browser, done) => {
    configureBrowser(browser, done)
  },

  'Should list processes' : (browser) => {
    browser
      .url('http://localhost:8002')
      //.waitForElementVisible('body', 1000)
      .waitForElementVisible('a[href="/host/localhost:8001/processes"]', 1000)
      .click('a[href="/host/localhost:8001/processes"]')
      .pause(360000)
      //.assert.containsText('.page', 'Processes')
      .end()
  }
}
