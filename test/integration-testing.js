﻿
var path = require('path');

var loadModules = require(path.join('..', 'load-modules.js'));

var async = require('async');
var fs = require('fs');
var util = require('util');
var exec = require('child_process').exec;

var moment = require('moment');
var azure = require('azure-storage');

var corpusToGraphPipeline = require('corpus-to-graph-pipeline');
var constants = corpusToGraphPipeline.constants;
var log = require('../domain-logic/log');
var utils = require('./utils.js');

var TEST_PREFIX = 'TEST > ';
var DATE_TO_CHECK = '2007-10-10';
var DOCUMENT_SRC_TO_MONITOR = 2;
var DOCUMENT_ID_TO_MONITOR = '2000354';
var TEST_CONTAINER_NAME = 'test';
var modelFile1 = path.join(__dirname, 'data', 'scoring_model_1_1_1.pkl');
var modelFile2 = path.join(__dirname, 'data', 'scoring_model_1_1_2.pkl');
var modelUri1 = '';
var modelUri2 = '';

process.env.PIPELINE_ROLE = 'testing';

var config;
var queueService;
var blobService;
var workers = [];
var logMessages = [];

var startTime = moment();

// This method helps print any left over errors to the console before the process ends
function doneWithError(err, done) {
  console.error('The test failed with the following error:', err);
  
  return setTimeout(function () {
    return done(err);
  }, 1000);
}

// This method helps print any left over messages to the console before the process ends
function doneSuccessfully(done) {
  return setTimeout(function () {
    return done();
  }, 1000);
}

// Start a worker process and monitor its health 
function activateWorker(role, environmentSet, runAppJSPath) {
  var worker = exec('set PIPELINE_ROLE=' + role + '&&' + environmentSet + '&& node ' + runAppJSPath);
  workers.push(worker);
  worker.on('close', function (code) {
    console.error(role + ' worker closing code: ' + code);
  });
  worker.on("exit", function(exitCode) {
    console.log('process exited with code ' + exitCode);
  });

  worker.stdout.on("data", function(chunk) { /* Discard data from child processes - This is used to releive the stdout buffer */  });

  worker.stdout.on("end", function() {
    console.log("finished collecting data chunks from stdout");
  });
}

function killAllWorkers() {
  var worker = null;
  while (worker = workers.pop()) { worker.kill(); }
}

// Overriding log messags to hide log messages of azure-logging 
var unhook = (function hook_stdout() {
  var $old_write = process.stdout.write

  process.stdout.write = function() {
    if (arguments && arguments.length) {
      var msg = arguments[0];
      if (!msg.startsWith('[90mlog    ci-testing') || msg.indexOf(TEST_PREFIX) >= 0) {
        $old_write.apply(process.stdout, arguments);
      }
    }
  }

  return function() {
    process.stdout.write = $old_write;
  }
})();

describe('Whole Pipeline', function () {
  
  this.timeout(15 * 60 * 1000); // 15 minute timeout
  
  before(function (done) {
    
    console.info('Setting up environment...');
    async.series([

      // Setting environment variables
      function (cb) {
        
        var setEnvPath = path.join(__dirname, '..', 'setenv.private.cmd');
        
        // set env script should only appear in local environments (not in CI environments)
        if (!fs.existsSync(setEnvPath)) {
          // TODO:
          // Add to fix method for all environment variables
          console.warn('could not find set env file, if this is a ci environment, this message is irrelevant');
          process.env.DB_PASSWORD = process.env.DB_PASSWORD.replace(/_DOLLAR_/g, '$'); // travis jumbles up $ signs
          config = require('../domain-logic/config');
          return cb();
        }
        
        utils.setEnvironmentVariables(setEnvPath, function (error) {
          
          if (error) return cb(error);
          
          // Loading config now that the environment variables have been loaded
          config = require('../domain-logic/config');
          return cb();
        });
      },

      // Initialize log
      function (cb) {
        
        var domain = process.env.COMPUTERNAME || '';
        var instance = log.getInstanceId();
        console.info('Logging for domain', domain, 'on instance', instance);
        
        return log.init({
          domain: domain,
          instanceId: instance,
          app: 'ci-testing',
          level: config.log.level,
          transporters: config.log.transporters
        }, cb);
      },

      // Initializing queue service
      function (cb) {
        queueService = azure.createQueueService(config.storage.account, config.storage.key)
            .withFilter(new azure.ExponentialRetryPolicyFilter());
        return cb();
      },

      // Recreate database schema
      // 1 - Drop database from all existing objects
      // 2 - Execute the updated schema.sql file on the database
      // 3 - Initialize database with information for the test 
      function (cb) {
        var dropScript = path.join(__dirname, '..', 'deployment', 'sql', 'dropschema.sql');
        var schemaScript = path.join(__dirname, '..', 'deployment', 'sql', 'schema.sql');
        var setupScript = path.join(__dirname, '..', 'deployment', 'sql', 'testsetup.sql');
        
        if (!fs.existsSync(dropScript)) return cb(new Error('Drop DB schema script not found in', dropScript));
        if (!fs.existsSync(schemaScript)) return cb(new Error('Create DB schema script not found in', schemaScript));
        if (!fs.existsSync(setupScript)) return cb(new Error('Setup DB script not found in', setupScript));
        
        console.info('Setting up DB schema');
        return utils.runDBScript(dropScript, function (err) {
          if (err) {
            console.error('Error running empty db schema:', err);
            return cb(err);
          }
          
          return utils.runDBScript(schemaScript, function (err) {
            if (err) {
              console.error('Error running create db schema:', err);
              return cb(err);
            }
            
            return utils.runDBScript(setupScript, function (err, stdout) {
              if (err) {
                console.error('Error running setup db:', err);
                return cb(err);
              }
              
              if (stdout && stdout.indexOf('(1 rows affected)') < 0) {
                var scriptError = new Error('There seems to be a problem running the setup script');
                console.error(scriptError);
                return cb(scriptError);
              }
              
              console.info('DB schema was recreated successfully');
              return cb();
            });
          });

        });
      },

      // Recreate queues in pipeline - Ensures all queues are empty of messages
      function (cb) {
        return async.parallel([
          function (cb) {
            return utils.deleteCreateQueue(queueService, config.queues.trigger_query, cb);
          },
          function (cb) {
            return utils.deleteCreateQueue(queueService, config.queues.new_ids, cb);
          },
          function (cb) {
            return utils.deleteCreateQueue(queueService, config.queues.scoring, cb);
          }
        ], cb);
      },
      
      // Uploading the new model to blob storage
      function (cb) {
        blobService = azure.createBlobService(config.storage.account, config.storage.key)
            .withFilter(new azure.ExponentialRetryPolicyFilter());
            
        modelUri1 = 'http://' + config.storage.account + '.blob.core.windows.net/' + TEST_CONTAINER_NAME + '/';
        modelUri2 = 'http://' + config.storage.account + '.blob.core.windows.net/' + TEST_CONTAINER_NAME + '/';
            
        return blobService.createContainerIfNotExists(TEST_CONTAINER_NAME, { publicAccessLevel: 'blob' }, 
          function(err, result, response) {
            
            if (err) return cb(err);
            
            // Uploading both models into blob storage
            async.parallel([
              function (cb) {
                // the file will be over-written in case it exists
                var blobName1 = path.basename(modelFile1);
                return blobService.createBlockBlobFromLocalFile(TEST_CONTAINER_NAME, blobName1, modelFile1, 
                  function (err, result, response) {
                    if (err) return cb(err);
                    
                    modelUri1 += blobName1;
                    return cb();
                  });
              },
              
              function (cb) {
                var blobName2 = path.basename(modelFile2);
                return blobService.createBlockBlobFromLocalFile(TEST_CONTAINER_NAME, blobName2, modelFile2, 
                  function (err, result, response) {
                    if (err) return cb(err);
                    
                    modelUri2 += blobName2;
                    return cb();
                  });
              }
            ], cb);
            
          });
      },
      
      // Setting base model for scoring
      function (cb) {
        utils.updateModel(modelUri1, cb);
      },

      // Starting all three workers in pipeline
      // Each test will monitor it's own data through the pipeline.
      function (cb) {
        
        // If one of the workers throws an error, log the error message
        var runAppJSPath = path.join(__dirname, '..', 'webjob', 'continuous', 'app.js');
        var environmentSet = 'set WORKERS=1';
        var queryWorker = activateWorker('query', environmentSet, runAppJSPath);
        var parserWorker = activateWorker('parser', environmentSet, runAppJSPath);
        var scorerWorker = activateWorker('scoring', environmentSet, runAppJSPath);
        
        return cb();
      }
    ], function (err) {
      
      if (err) return doneWithError(err, done);
      
      console.info('Setup was completed successfully');
      return doneSuccessfully(done);
    });

  });
  
  // Testing happy flow
  it(TEST_PREFIX + 'Processing and Scoring', function (done) {

    // After recreating all queues, trigger a pipeline happy flow by 
    // pushing a message to the queue to query all documents for 2007-10-10.
    // There are 2381 documents that day.
    //
    // Scenario:
    // --------------
    // 2380 documents are marked as 'Processed' in the database setup.
    // 1 document is supposed to go through the pipeline and is monitored by the test.
    
    async.series([
      
      function (cb) {
        
        console.info('triggering a new process through queue', config.queues.trigger_query);
        
        var message = {
          "requestType": "trigger",
          "data": {
            "from": DATE_TO_CHECK,
            "to": DATE_TO_CHECK
          }
        };
        return queueService.createMessage(config.queues.trigger_query, JSON.stringify(message), function (error) {
          if (error) return cb(error);
          console.info('trigger message successfully on ' + DATE_TO_CHECK);
          return cb();
        });

      }
    ], 
        
    // When done queuing message => start monitoring log from all web jobs in the pipeline 
    function (err) {
      
      if (err) return doneWithError(err, done);
      
      // Periodic check for errors in the pipeline
      // The monitored errors will only be errors created by the testing process
      // which means any errors aggregated back from the processes of worker roles.
      // Errors like periodic SQL connection problems and network issues will not be aggregated.
      utils.checkForErrorsInLog(startTime, function (error) {
        
        if (error) {
          console.error('Error was found during the testing', error);
          return done(error);
        }
        
        return;
      });
      
      // Parallel check of all three web jobs.
      // If one role fails, this will fail the entire test immediately
      return async.parallel([
                
        // Periodic check that document was queried from service
        function (cb) {
          return utils.waitForLogMessage({
            message: constants.logMessages.query.doneQueuing, 
            app: 'query',
            since: startTime
          }, function (error) {
            if (error) return cb(error);
            
            // Check the specific document we expect in the pipeline was processed
            return utils.countLogMessages({
              message: util.format(constants.logMessages.query.queueDocFormat, DOCUMENT_ID_TO_MONITOR, DOCUMENT_SRC_TO_MONITOR),
              app: 'query',
              level: 'log',
              since: startTime
            }, function (error, count) {
              if (error) return cb(error);
              
              if (count == 0) {
                var docError = new Error('could not find document ' + DOCUMENT_ID_TO_MONITOR + ' in log');
                console.error(docError)
                return cb(docError);
              }
              
              console.info('Query ID worker test completed successfully');
              return cb();
            });
          });
        },

        // Periodic check that document was parsed for sentences
        function (cb) {
          
          return utils.waitForLogMessage({
            message: util.format(constants.logMessages.parser.doneQueuingFormat, DOCUMENT_ID_TO_MONITOR), 
            app: 'parser',
            since: startTime
          }, function (error) {
            if (error) return cb(error);
            
            // Check DB has appropriate document
            return utils.getTableRowCount('Documents', 'Id=' + DOCUMENT_ID_TO_MONITOR, function (error, count) {
              if (error) return cb(error);
              
              if (count == 0) {
                var countError = new Error('could not find document ' + DOCUMENT_ID_TO_MONITOR + ' in DB');
                console.error(countError);
                return cb(countError);
              }
              
              console.info('Paper parser worker test completed successfully');
              return cb();
            });
          });
        },

        // Periodic check that all sentences were scored
        function (cb) {
          
          // There are 37 sentences
          // Checking only for 3 since it makes the test run faster.
          return utils.waitForTableRowCount({
            tableName: 'Sentences', 
            where: 'DocId=' + DOCUMENT_ID_TO_MONITOR,
            expectedCount: 3
          }, function (err) {
            if (err) return cb(err);
            
            console.info('Scorer worker test completed successfully');
            return cb();
          });
        }
      ], function (err) {
        
        if (err) return doneWithError(err, done);
      
        console.info('Test completed successfully');
        return doneSuccessfully(done); 

      });

    });

  });
  
  it(TEST_PREFIX + 'Re-scoring and Remodeling', function (done) {
    
    // The previous test (Processing and Scoring) has braught the database to a 
    // state where it has 2381 documents; sentences\relations\entities  
    // pushing a message to the queue to query all documents for 2007-10-10.
    // There are 2381 documents that day.
    //
    // Scenario:
    // --------------
    // Send a request to rescore all sentences in the database
    // All sentences are supposed to double with a new version number
    
    // Setting up preliminary requirements for rescore test
    async.series([
      
      // Call api to update to second model
      function (cb) {
        utils.updateModel(modelUri2, cb);
      },

      // Triggering a rescore flow
      function (cb) {
        
        console.info('triggering rescore through queue', config.queues.scoring);
        
        var message = {
          "requestType": constants.queues.action.RESCORE,
          "data": { }
        };
        return queueService.createMessage(config.queues.scoring, JSON.stringify(message), function (error) {
          if (error) return cb(error);
          console.info('sent a request to rescore sentences in database');
          return cb();
        });

      }
    ], 
        
    // When done queuing message => start monitoring log from scoring web jobs in the pipeline 
    function (err) {
      
      if (err) return doneWithError(err, done);
      
      // Periodic check for errors in the pipeline
      // The monitored errors will only be errors created by the testing process
      // which means any errors aggregated back from the processes of worker roles.
      // Errors like periodic SQL connection problems and network issues will not be aggregated.
      utils.checkForErrorsInLog(startTime, function (error) {
        
        if (error) {
          console.error('Error was found during the testing', error);
          return done(error);
        }
        
        return;
      });
      
      // Parallel check of all three web jobs.
      // If one role fails, this will fail the entire test immediately
      return async.parallel([
                
        // Periodic check that all sentences were scored
        function (cb) {
          
          // There are 37 sentences
          // Checking only for 3 since it makes the test run faster.
          return utils.waitForTableRowCount({
            tableName: 'Relations', 
            where: 'DocId=' + DOCUMENT_ID_TO_MONITOR + ' AND ModelVersion=\'1.1.2\'',
            expectedCount: 3
          }, function (err) {
            if (err) return cb(err);
            
            console.info('Scorer worker test completed successfully');
            return cb();
          });
        }
      ], function (err) {
        
        if (err) return doneWithError(err, done);
      
        console.info('Test completed successfully');
        return doneSuccessfully(done);
      });

    });
    
  });
  
  // Cleanup
  after(function (done) {
    
    killAllWorkers();
    
    // Request deletion of all queues so the recreation of queues for 
    // the next test will take less time
    if (queueService) {
      queueService.deleteQueueIfExists(config.queues.trigger_query, function () { });
      queueService.deleteQueueIfExists(config.queues.new_ids, function () { });
      queueService.deleteQueueIfExists(config.queues.scoring, function () { });
    }
    
    return doneSuccessfully(done);
  });
})
