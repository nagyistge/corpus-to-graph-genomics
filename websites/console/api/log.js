
var api = { console: { autoLoad: true} };

var express = require('express'),
    router = api.router = express.Router(),
    docRouter = require('docrouter').docRouter,
    logReader = require('azure-logging'),
    url = require('url'),
    sanitize = require('validator').sanitize,
    config = require('../config');

module.exports = api;

docRouter(router, "/api/log", function (router) {
    router.get('/', handleLogRequest, getDocRouterInfo());
});

function getDocRouterInfo() {

  // construct log params for docRouter, later to be used by devx console
  var logParams = {};
  for (var i = 0; i < logReader.params.length; i++) {
    var p = logReader.params[i];
    if (p.name == 'format' || p.name == 'nocolors')
      continue;

    var param = { style: 'query', type: p.type };

    if (p.desc) param.doc = p.desc;
    if (p.required) param.required = p.required;
    if (p.short) param.short = p.short;
    if (p.options) param.options = p.options;
    if (p.defaultValue) param.defaultValue = p.defaultValue;

    switch (p.name) {
      case 'app':
        param.defaultEnvVar = "app";
        break;
      case 'farm':
        param.defaultEnvVar = "farm";
        break;
      case 'instance':
        param.defaultEnvVar = "inst";
        break;
    }

    logParams[p.name] = param;
  }

  return {
    id: 'api_log_getLogs',
    name: 'log',
    usage: 'log [--top number] [-a app] [-l level] [-f farm] [-i instance] [-s since] [--message message] [--skip number] [--limit number]',
    example: 'log --top 10 -a console',
    doc: 'Get logs from anode logging system',
    params: logParams,
    response: { representations: ['application/json'] },
    controller: {
      url: '../../plugins/log/log.js', // relative to /api/log
      cssUrl: '../../plugins/log/log.css' // relative to /api/log
    }
  };
}

function handleLogRequest(req, res) {

  var options = {};

  for (var i = 0; i < logReader.params.length; i++) {
    var p = logReader.params[i];
    if (req.query[p.name]) options[p.name] = req.query[p.name];
  }
  options['format'] = 'text';
  options['nocolors'] = true;


  options.transporters = config.log.transporters;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  console.log('log options query', options);

  var results = [];
  logReader.reader(options, function(err, r) {
    if (err) {
      console.warn('Failed to obtain log reader', err);
      return res.end(JSON.stringify(err, null, 2));
    }
    //r.on('line', function (data) { results.push(sanitize(data).entityEncode()); });
    r.on('line', function (data) { results.push(data); });
    r.on('end', function () { res.end(JSON.stringify(results)); });
    r.on('error', function (err) { res.end(JSON.stringify(err, null, 2)); });
  });
}