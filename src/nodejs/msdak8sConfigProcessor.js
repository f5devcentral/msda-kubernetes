/*
  Copyright (c) 2017, F5 Networks, Inc.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
  *
  http://www.apache.org/licenses/LICENSE-2.0
  *
  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
  either express or implied. See the License for the specific
  language governing permissions and limitations under the License.
  
  Updated by Ping Xiong on May/13/2022.
  Updated by Ping Xiong on Jun/24/2022 to modify the pool creation strategy.
  Updated by Ping Xiong on Jun/29/2022 to modify the pool creation strategy, create empty pool if service does not exist.
  Updated by Ping Xiong on Jun/30/2022 to fix the polling bug.
  Updated by Ping Xiong on Oct/04/2022, modify the polling signal into a json object to keep more information.
  let blockInstance = {
    name: "instanceName", // a block instance of the iapplx config
    state: "polling", // can be "polling" for normal running state; "update" to modify the iapplx config
    bigipPool: "/Common/samplePool"
  }
  Updated by Ping Xiong on Jan/08/2023, compare pool member list before update config.
  Mar/09/2023, updated by Ping Xiong, update delta of pool members instead of replace-all-with latest config.
*/

'use strict';

// Middleware. May not be installed.
var configTaskUtil = require("./configTaskUtil");
var blockUtil = require("./blockUtils");
var logger = require('f5-logger').getInstance();
var mytmsh = require('./TmshUtil');
var K8s = require('k8s');
//var fs = require('fs');

// Setup a pooling signal for audit.
//const msdak8sOnPollingSignal = '/var/tmp/msdak8sOnPolling';
global.msdak8sOnPolling = [];

//const pollInterval = 10000; // Interval for polling Registry registry.
//var stopPolling = false;

var poolMembers = '{100.100.100.100:8080 100.100.100.101:8080}';

/**
 * A dynamic config processor for managing LTM pools.
 * Note that the pool member name is not visible in the GUI. It is generated by MCP according to a pattern, we don't want
 * the user setting it
 *
 * @constructor
 */
function msdak8sConfigProcessor() {
}

msdak8sConfigProcessor.prototype.setModuleDependencies = function (options) {
    logger.info("setModuleDependencies called");
    configTaskUtil = options.configTaskUtil;
};

msdak8sConfigProcessor.prototype.WORKER_URI_PATH = "shared/iapp/processors/msdak8sConfig";

msdak8sConfigProcessor.prototype.onStart = function (success) {
    logger.fine("MSDAk8s: OnStart, msdak8sConfigProcessor.prototype.onStart");
    this.apiStatus = this.API_STATUS.INTERNAL_ONLY;
    this.isPublic = true;

    configTaskUtil.initialize({
        restOperationFactory: this.restOperationFactory,
        eventChannel: this.eventChannel,
        restHelper: this.restHelper
    });

    // Check the db key bigpipe.displayservicenames, modify it into false for comparing pool member list.
    mytmsh.executeCommand("tmsh -a list sys db bigpipe.displayservicenames")
    .then(function (result) {
        if (result.indexOf("true") > -1) {
            logger.fine(
                "MSDA: onStart, bigpipe.displayservicenames is true, will modify it into false."
            );
            return mytmsh
                .executeCommand(
                "tmsh -a modify sys db bigpipe.displayservicenames value false"
                )
                .then(function () {
                logger.fine(
                    "MSDA: onStart, updated bigpipe.displayservicenames into false."
                );
                });
        } else {
            return logger.fine(
              "MSDA: onStart, bigpipe.displayservicenames is false, no change needed."
            );
        }
    }, function () {
        return logger.fine(
            "MSDA: onStart, fail to list the db key bigpipe.displayservicenames."
        );
    })
    .catch(function (error) {
        logger.fine(
          "MSDA: onStart, fail to list the db key bigpipe.displayservicenames. ",
          error.message
        );
    });

    success();
};


/**
 * Handles initial configuration or changed configuration. Sets the block to 'BOUND' on success
 * or 'ERROR' on failure. The routine is resilient in that it will try its best and always go
 * for the 'replace' all attitude.
 *
 * @param restOperation - originating rest operation that triggered this processor
 */
msdak8sConfigProcessor.prototype.onPost = function (restOperation) {
    var configTaskState,
        blockState,
        oThis = this;
    logger.fine("MSDA: onPost, msdak8sConfigProcessor.prototype.onPost");

    var instanceName;
    var inputProperties;
    var dataProperties;
    
    try {
        configTaskState = configTaskUtil.getAndValidateConfigTaskState(restOperation);
        blockState = configTaskState.block;
        logger.fine("MSDA: onPost, inputProperties ", blockState.inputProperties);
        logger.fine("MSDA: onPost, dataProperties ", blockState.dataProperties);
        logger.fine("MSDA: onPost, instanceName ", blockState.name);
        inputProperties = blockUtil.getMapFromPropertiesAndValidate(
            blockState.inputProperties,
            ["k8sEndpoint", "authenticationCert", "nameSpace", "serviceName", "poolName", "poolType", "healthMonitor"]
        );
        dataProperties = blockUtil.getMapFromPropertiesAndValidate(
            blockState.dataProperties,
            ["pollInterval"]
        );
        instanceName = blockState.name;
    } catch (ex) {
        restOperation.fail(ex);
        return;
    }

    // Mark that the request meets all validity checks and tell the originator it was accepted.
    this.completeRequest(restOperation, this.wellKnownPorts.STATUS_ACCEPTED);

    // Generic URI components, minus the 'path'
    var uri = this.restHelper.buildUri({
        protocol: this.wellKnownPorts.DEFAULT_HTTP_SCHEME,
        port: this.wellKnownPorts.DEFAULT_JAVA_SERVER_PORT,
        hostname : "localhost"
    });

    //Accept input proterties, set the status to BOUND.

    const clientCrt64 = inputProperties.authenticationCert.value.clientCert;
    const clientKey64 = inputProperties.authenticationCert.value.clientKey;
    const ca64 = inputProperties.authenticationCert.value.caCert;

    var clientKeyBuffer = Buffer.from(clientKey64, 'base64');
    var f5ClientKey = clientKeyBuffer.toString();
    var clientCrtBuffer = Buffer.from(clientCrt64, 'base64');
    var f5ClientCrt = clientCrtBuffer.toString();
    var caBuffer = Buffer.from(ca64, 'base64');
    var k8scaCrt = caBuffer.toString();

    const inputEndPoint = inputProperties.k8sEndpoint.value;
    const inputNameSpace = inputProperties.nameSpace.value;
    const inputServiceName = inputProperties.serviceName.value;
    const inputPoolName = inputProperties.poolName.value;
    const inputPoolType = inputProperties.poolType.value;
    const inputMonitor = inputProperties.healthMonitor.value;
    var pollInterval = dataProperties.pollInterval.value * 1000;

    // Check the existence of the pool in BIG-IP, create an empty pool if the pool doesn't exist.
    mytmsh.executeCommand("tmsh -a list ltm pool " + inputPoolName)
    .then(function () {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " found the pool, no need to create an empty pool."
        );
        return;
    }, function (error) {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " GET of pool failed, adding an empty pool: " +
            inputPoolName
        );
        let inputEmptyPoolConfig = inputPoolName + ' monitor ' + inputMonitor + ' load-balancing-mode ' + inputPoolType + ' members none';
        let commandCreatePool = 'tmsh -a create ltm pool ' + inputEmptyPoolConfig;
        return mytmsh.executeCommand(commandCreatePool);
    })
    .catch(function (error) {
        logger.fine(
            "MSDA: onPost, " + instanceName + " list pool failed: ",
            error.message
        );
    });

    // Set the polling interval
    if (pollInterval) {
        if (pollInterval < 10000) {
            logger.fine(
                "MSDA: onPost, " +
                instanceName +
                " pollInternal is too short, will set it to 10s ",
                pollInterval
            );
            pollInterval = 10000;
        }
    } else {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " pollInternal is not set, will set it to 30s ",
            pollInterval
        );
        pollInterval = 30000;
    }
    
    // Setup the polling signal for audit and upate
    // update on Oct/04/2022, using json object for polling signal, by Ping Xiong.
    let blockInstance = {
        name: instanceName,
        bigipPool: inputPoolName,
        state: "polling"
    };

    let signalIndex = global.msdak8sOnPolling.findIndex(instance => instance.name === instanceName);
    if (signalIndex !== -1) {
        // Already has the instance, change the state into "update"
        global.msdak8sOnPolling.splice(signalIndex, 1);
        blockInstance.state = "update";
    }
    logger.fine("MSDA: onPost, blockInstance:", blockInstance);

    // Setup a signal to identify existing polling loop
    var existingPollingLoop = false;

    // Check if there is a conflict bigipPool in configuration

    if (global.msdak8sOnPolling.some(instance => instance.bigipPool === inputPoolName)) {
        logger.fine(
            "MSDA: onPost, " +
            instanceName +
            " already has an instance polling the same pool, change BLOCK to ERROR: ",
            inputPoolName
        );
        try { 
            throw new Error("onPost: poolName conflict: " + inputPoolName + " , will set the BLOCK to ERROR state");
        } catch (error) {
            configTaskUtil.sendPatchToErrorState(
              configTaskState,
              error,
              oThis.getUri().href,
              restOperation.getBasicAuthorization()
            );
        }
        return;
    } else {
        global.msdak8sOnPolling.push(blockInstance);
        logger.fine(
            "MSDA onPost: " + instanceName + " set msdak8sOnpolling signal: ",
            global.msdak8sOnPolling
        );
    }

    /*
    try {
        logger.fine("MSDAk8s: onPost, will set the polling signal. ");
        fs.writeFile(msdak8sOnPollingSignal, '');
    } catch (error) {
        logger.fine("MSDAk8s: onPost, hit error while set polling signal: ", error.message);
    }
    */

    logger.fine(
        "MSDA: onPost, " +
        instanceName +
        " Input properties accepted, change to BOUND status, start to poll Registry for: ",
        inputPoolName
    );

    configTaskUtil.sendPatchToBoundState(configTaskState, 
            oThis.getUri().href, restOperation.getBasicAuthorization());

    // A internal service to retrieve service member information from registry, and then update BIG-IP setting.

    // Define functions to compare pool members

    function getPoolMembers(result) {
        const lines = result.split("\n");
        let poolMembers = [];
        lines.forEach((line, i) => {
            if (line.indexOf("address") > -1) {
            let memberLine = lines[i - 1];
            memberLine = memberLine.trim();
            memberLine = memberLine.split(" ");
            poolMembers.push(memberLine[0]);
            }
        });
        return poolMembers;
    }

    function compareArray(array1, array2) {
        return (
            array1.length === array2.length &&
            array1.every((item) => array2.indexOf(item) > -1)
        );
    }

    //inputEndPoint = inputEndPoint.toString().split(","); 
    logger.fine(
        "MSDA: onPost, " + instanceName + " registry endpoints: ",
        inputEndPoint
    );

    // connect to k8s registry to retrieve end points.

    //use k8s restful api
    var kubeapi = K8s.api({
        endpoint: inputEndPoint,
        version: '/api/v1',
        auth: {
            clientKey: f5ClientKey,
            clientCert: f5ClientCrt,
            caCert: k8scaCrt
        }
    });

    const k8sApi = "namespaces/" + inputNameSpace + "/endpoints/" + inputServiceName;

    (function schedule() {
        var pollRegistry = setTimeout(function () {
            // If signal is "update", change it into "polling" for new polling loop
            if (global.msdak8sOnPolling.some(instance => instance.name === instanceName)) {
                let signalIndex = global.msdak8sOnPolling.findIndex(instance => instance.name === instanceName);
                if (global.msdak8sOnPolling[signalIndex].state === "update") {
                    if (existingPollingLoop) {
                        logger.fine(
                            "MSDA: onPost/polling, " +
                            instanceName +
                            " update config, existing polling loop."
                        );
                    } else {
                        //logger.fine("MSDA: onPost/polling, " + instanceName + " update config, a new polling loop.");
                        global.msdak8sOnPolling[signalIndex].state = "polling";
                        logger.fine(
                            "MSDA: onPost/polling, " +
                            instanceName +
                            " update the signal.state into polling for new polling loop: ",
                            global.msdak8sOnPolling[signalIndex]
                        );
                    }
                }
                // update the existingPollingLoop to true
                existingPollingLoop = true;
            } else {
                // Non-exist instance, will NOT proceed to poll the registry
                return logger.fine(
                    "MSDA: onPost/polling, " +
                    instanceName +
                    " Stop polling registry."
                );
            }

            // Polling the k8s ...
            kubeapi.get(k8sApi)
                .then(function (data) { 
                    let nodeAddress = [];
                    if (typeof (data.subsets) != "undefined") {
                        data.subsets.forEach(set => {
                            set.addresses.forEach(ipaddr => {
                                set.ports.forEach(portNum => {
                                    nodeAddress.push(ipaddr.ip + ":" + portNum.port);
                                });
                            });
                        });
                    }
                    logger.fine(
                        "MSDA: onPost,  " +
                        instanceName +
                        " service endpoint list: ",
                        nodeAddress
                    );
                    if (nodeAddress.length !== 0) {
                        
                        logger.fine(
                            "MSDA: onPost,  " +
                            instanceName +
                            " Will moving forward to setup BIG-IP"
                        );

                        //To configure the BIG-IP pool
                        poolMembers = "{" + nodeAddress.join(" ") + "}";
                        logger.fine(
                            "MSDA: onPost,  " +
                            instanceName +
                            " pool members: " +
                            poolMembers
                        );
                        let inputPoolConfig = inputPoolName + ' monitor ' + inputMonitor + ' load-balancing-mode ' + inputPoolType + ' members replace-all-with ' + poolMembers;

                        // Use tmsh to update BIG-IP configuration instead of restful API

                        // Start with check the exisitence of the given pool
                        mytmsh.executeCommand("tmsh -a list ltm pool " + inputPoolName).then(function (result) {
                            // Get pool members from list result
                            let poolMembersArray = getPoolMembers(result);
                            logger.fine(
                                "MSDA: onPost, " +
                                instanceName +
                                " Found a pre-existing pool: " +
                                inputPoolName + " has members: ",
                                poolMembersArray
                            );

                            if (compareArray(nodeAddress, poolMembersArray)) {
                                return logger.fine(
                                  "MSDA: onPost, " +
                                    instanceName +
                                    " Existing pool has the same member list as service registry, will not update the BIG-IP config. ",
                                    inputPoolName
                                );
                            } else {
                                logger.fine(
                                  "MSDA: onPost, " +
                                    instanceName +
                                    " Existing pool has the different member list compare to service registry, will update the BIG-IP config. ",
                                  inputPoolName
                                );

                                // Find the difference between registry and big-ip config, update on Mar/09/2023 by Ping Xiong
                                const toAdd = nodeAddress.filter(
                                  (x) => !poolMembersArray.includes(x)
                                );
                                const toDelete = poolMembersArray.filter(
                                  (x) => !nodeAddress.includes(x)
                                );

                                if (toAdd.length !== 0) { 
                                    // Add pool members
                                    const poolMembersToAdd = "{" + toAdd.join(" ") + "}";
                                    const commandAddPoolMember = "tmsh -a modify ltm pool " + inputPoolName + ' members add ' + poolMembersToAdd;
                                    return mytmsh.executeCommand(commandAddPoolMember);
                                };

                                if (toDelete.length !== 0) {
                                    // Delete pool members
                                    const poolMembersToDelete = "{" + toDelete.join(" ") + "}";
                                    const commandDeletePoolMember = "tmsh -a modify ltm pool " + inputPoolName + ' members delete ' + poolMembersToDelete;
                                    return mytmsh.executeCommand(commandDeletePoolMember);
                                };

                                //let commandUpdatePool = "tmsh -a modify ltm pool " + inputPoolConfig;
                                //return mytmsh.executeCommand(commandUpdatePool);
                            }
                        }, function (error) {
                            logger.fine(
                                "MSDA: onPost,  " +
                                instanceName +
                                " GET of pool failed, adding from scratch: ",
                                inputPoolName
                            );
                            let commandCreatePool = 'tmsh -a create ltm pool ' + inputPoolConfig;
                            return mytmsh.executeCommand(commandCreatePool);
                        })
                            // Error handling
                            .catch(function (error) {
                                logger.fine(
                                    "MSDA: onPost,  " +
                                    instanceName +
                                    " Add Failure: adding/modifying a pool: ",
                                    error.message
                                );
                            });
                    } else {
                        //To clear the pool
                        logger.fine("MSDA: onPost, endpoint list is empty, will clear the BIG-IP pool as well");
                        mytmsh.executeCommand("tmsh -a list ltm pool " + inputPoolName)
                            .then(function (result) {
                                // Get pool members from list result
                                let poolMembersArray = getPoolMembers(result);
                                logger.fine(
                                    "MSDA: onPost, " +
                                    instanceName +
                                    " found the pool, will delete all members as it's empty.",
                                    poolMembersArray
                                );

                                if (poolMembersArray.length == 0) {
                                    return logger.fine(
                                      "MSDA: onPost, " +
                                        instanceName +
                                        " Existing pool has the same member list as service registry, will not update the BIG-IP config. ",
                                      inputPoolName
                                    );
                                } else {
                                    logger.fine(
                                      "MSDA: onPost, " +
                                        instanceName +
                                        " Existing pool has the different member list compare to service registry, will update the BIG-IP config. ",
                                      inputPoolName
                                    );
                                    let commandUpdatePool = 'tmsh -a modify ltm pool ' + inputPoolName + ' members delete { all}';
                                    return mytmsh
                                      .executeCommand(commandUpdatePool)
                                      .then(function () {
                                        logger.fine(
                                          "MSDA: onPost, " +
                                            instanceName +
                                            " update the pool to delete all members as it's empty. "
                                        );
                                      });
                                }
                            }, function (error) {
                                logger.fine(
                                  "MSDA: onPost,  " +
                                    instanceName +
                                    " GET of pool failed, adding an empty pool: ",
                                    inputPoolName
                                );
                                let inputEmptyPoolConfig = inputPoolName + ' monitor ' + inputMonitor + ' load-balancing-mode ' + inputPoolType + ' members none';
                                let commandCreatePool = 'tmsh -a create ltm pool ' + inputEmptyPoolConfig;
                                return mytmsh.executeCommand(commandCreatePool);
                            })
                                // Error handling - Set the block as 'ERROR'
                            .catch(function (error) {
                                logger.fine(
                                    "MSDA: onPost,  " +
                                    instanceName +
                                    " clear pool failed: ",
                                    error.message
                                );
                            });
                    }
                }, function (err) {
                    logger.fine(
                        "MSDA: onPost,  " +
                        instanceName +
                        " Fail to retrieve to endpoint list due to: ",
                        err.message
                    );
                }).catch(function (error) {
                    logger.fine(
                        "MSDA: onPost,  " +
                        instanceName +
                        " Fail to retrieve to endpoint list due to: ",
                        error.message
                    );
                }).done(function () {
                    logger.fine(
                        "MSDA: onPost/polling, " +
                        instanceName +
                        " finish a polling action."
                    );
                    schedule();
                });
        }, pollInterval);

        // stop polling while undeployment or update the config
        let stopPolling = true;

        if (
            global.msdak8sOnPolling.some(
                (instance) => instance.name === instanceName
            )
        ) {
            let signalIndex = global.msdak8sOnPolling.findIndex(
                (instance) => instance.name === instanceName
            );
            if (global.msdak8sOnPolling[signalIndex].state === "polling") {
                logger.fine(
                    "MSDA: onPost, " +
                    instanceName + " keep polling registry for: ",
                    inputServiceName
                );
                stopPolling = false;
            } else {
                // state = "update", stop polling for existing loop; trigger a new loop for new one.
                if (existingPollingLoop) {
                    logger.fine(
                        "MSDA: onPost, " +
                        instanceName +
                        " update config, will terminate existing polling loop."
                    );
                } else {
                    logger.fine(
                        "MSDA: onPost, " +
                        instanceName +
                        " update config, will trigger a new polling loop."
                    );
                    stopPolling = false;
                }
            }
        }

        if (stopPolling) {
            process.nextTick(() => {
                clearTimeout(pollRegistry);
                logger.fine(
                    "MSDA: onPost/stopping, " +
                    instanceName +
                    " Stop polling registry for: ",
                    inputServiceName
                );
            });
            // Delete pool configuration in case it still there.
            setTimeout (function () {
                const commandDeletePool = 'tmsh -a delete ltm pool ' + inputPoolName;
                mytmsh.executeCommand(commandDeletePool)
                .then (function () {
                    logger.fine(
                        "MSDA: onPost/stopping, " +
                        instanceName +
                        " the pool removed: " +
                        inputPoolName
                    );
                })
                    // Error handling
                .catch(function (err) {
                    logger.fine(
                        "MSDA: onPost/stopping, " +
                        instanceName +
                        " Delete failed: " +
                        inputPoolName,
                        err.message
                    );
                }).done(function () {
                    return logger.fine(
                        "MSDA: onPost/stopping, " +
                        instanceName +
                        " exit loop."
                    );
                });
            }, 2000);
        }
    })();
};


/**
 * Handles DELETE. The configuration must be removed, if it exists. Patch the block to 'UNBOUND' or 'ERROR'
 *
 * @param restOperation - originating rest operation that triggered this processor
 */
msdak8sConfigProcessor.prototype.onDelete = function (restOperation) {
    var configTaskState, blockState;
    var oThis = this;

    logger.fine("MSDA: onDelete, msdak8sConfigProcessor.prototype.onDelete");

    var instanceName;
    var inputProperties;
    try {
        configTaskState =
        configTaskUtil.getAndValidateConfigTaskState(restOperation);
        blockState = configTaskState.block;
        inputProperties = blockUtil.getMapFromPropertiesAndValidate(
        blockState.inputProperties,
        ["poolName", "poolType"]
        );
        instanceName = blockState.name;
    } catch (ex) {
        restOperation.fail(ex);
        return;
    }
    this.completeRequest(restOperation, this.wellKnownPorts.STATUS_ACCEPTED);

    // Generic URI components, minus the 'path'
    var uri = this.restHelper.buildUri({
        protocol: this.wellKnownPorts.DEFAULT_HTTP_SCHEME,
        port: this.wellKnownPorts.DEFAULT_JAVA_SERVER_PORT,
        hostname: "localhost",
    });

    // In case user requested configuration to deployed to remote
    // device, setup remote hostname, HTTPS port and device group name
    // to be used for identified requests

    // Delete the polling signal first, then remove the pool in big-ip
    let signalIndex = global.msdak8sOnPolling.findIndex(
      (instance) => instance.name === instanceName
    );
    global.msdak8sOnPolling.splice(signalIndex, 1);
    logger.fine(
        "MSDA: onDelete, " +
        instanceName +
        " deleted polling signal!!! Continue to remove the pool in bigip."
    );
    // Use tmsh to update configuration

    mytmsh
        .executeCommand("tmsh -a list ltm pool " + inputProperties.poolName.value)
        .then(
        function () {
            logger.fine(
            "MSDA: onDelete, " +
                instanceName +
                " Found a pre-existing pool. Full Config Delete: ",
            inputProperties.poolName.value
            );
            const commandDeletePool =
            "tmsh -a delete ltm pool " + inputProperties.poolName.value;
            return mytmsh
            .executeCommand(commandDeletePool)
            .then(function (response) {
                logger.fine(
                "MSDA: onDelete, " + instanceName + " The pool is all removed: ",
                inputProperties.poolName.value
                );
                configTaskUtil.sendPatchToUnBoundState(
                configTaskState,
                oThis.getUri().href,
                restOperation.getBasicAuthorization()
                );
            });
        }, function (error) {
            // the configuration must be clean. Nothing to delete
            logger.fine(
            "MSDA: onDelete, " + instanceName + " pool does't exist: ",
            error.message
            );
            configTaskUtil.sendPatchToUnBoundState(
            configTaskState,
            oThis.getUri().href,
            restOperation.getBasicAuthorization()
            );
        })
        // Error handling - Set the block as 'ERROR'
        .catch(function (error) {
            logger.fine(
                "MSDA: onDelete, " +
                instanceName +
                " Delete failed, setting block to ERROR: ",
                error.message
            );
            configTaskUtil.sendPatchToErrorState(
                configTaskState,
                error,
                oThis.getUri().href,
                restOperation.getBasicAuthorization()
            );
        })
        // Always called, no matter the disposition. Also handles re-throwing internal exceptions.
        .done(function () {
            logger.fine(
                "MSDA: onDelete, " +
                instanceName +
                " Bigip configuration delete DONE!!!"
            ); // happens regardless of errors or no errors ....
            // Delete the polling signal
            //let signalIndex = global.msdak8sOnPolling.findIndex(
            //    (instance) => instance.name === instanceName
            //);
            //global.msdak8sOnPolling.splice(signalIndex, 1);
        });

        /*        // Stop polling registry while undeploy ??
        process.nextTick(() => {
            stopPolling = true;
            logger.fine("MSDA: onDelete/stopping, Stop polling registry ...");
        });
        //stopPollingEvent.emit('stopPollingRegistry');
        
        logger.fine(
            "MSDA: onDelete, DONE!!! " +
            instanceName +
            " Stop polling Registry while ondelete action."
        );
        */
};

module.exports = msdak8sConfigProcessor;
