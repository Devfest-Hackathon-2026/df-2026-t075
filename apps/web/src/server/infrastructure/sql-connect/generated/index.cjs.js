const { validateAdminArgs } = require('firebase-admin/data-connect');

const connectorConfig = {
  connector: 'app',
  serviceId: 'hackathon-7314b-service',
  location: 'asia-northeast1'
};
exports.connectorConfig = connectorConfig;

function writeConnectionCheck(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('WriteConnectionCheck', inputVars, inputOpts);
}
exports.writeConnectionCheck = writeConnectionCheck;

function readConnectionCheck(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeQuery('ReadConnectionCheck', inputVars, inputOpts);
}
exports.readConnectionCheck = readConnectionCheck;

function removeConnectionCheck(dcOrVarsOrOptions, varsOrOptions, options) {
  const { dc: dcInstance, vars: inputVars, options: inputOpts} = validateAdminArgs(connectorConfig, dcOrVarsOrOptions, varsOrOptions, options, true, true);
  dcInstance.useGen(true);
  return dcInstance.executeMutation('RemoveConnectionCheck', inputVars, inputOpts);
}
exports.removeConnectionCheck = removeConnectionCheck;

