import { ConnectorConfig, DataConnect, OperationOptions, ExecuteOperationResponse } from 'firebase-admin/data-connect';

export const connectorConfig: ConnectorConfig;

export type TimestampString = string;
export type UUIDString = string;
export type Int64String = string;
export type DateString = string;


export interface ConnectionCheck_Key {
  id: UUIDString;
  __typename?: 'ConnectionCheck_Key';
}

export interface ReadConnectionCheckData {
  connectionCheck?: {
    marker: string;
  };
}

export interface ReadConnectionCheckVariables {
  id: UUIDString;
}

export interface RemoveConnectionCheckData {
  connectionCheck_deleteMany: number;
}

export interface RemoveConnectionCheckVariables {
  id: UUIDString;
}

export interface WriteConnectionCheckData {
  connectionCheck_deleteMany: number;
  connectionCheck_upsert: ConnectionCheck_Key;
}

export interface WriteConnectionCheckVariables {
  id: UUIDString;
  marker: string;
}

/** Generated Node Admin SDK operation action function for the 'WriteConnectionCheck' Mutation. Allow users to execute without passing in DataConnect. */
export function writeConnectionCheck(dc: DataConnect, vars: WriteConnectionCheckVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<WriteConnectionCheckData>>;
/** Generated Node Admin SDK operation action function for the 'WriteConnectionCheck' Mutation. Allow users to pass in custom DataConnect instances. */
export function writeConnectionCheck(vars: WriteConnectionCheckVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<WriteConnectionCheckData>>;

/** Generated Node Admin SDK operation action function for the 'ReadConnectionCheck' Query. Allow users to execute without passing in DataConnect. */
export function readConnectionCheck(dc: DataConnect, vars: ReadConnectionCheckVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ReadConnectionCheckData>>;
/** Generated Node Admin SDK operation action function for the 'ReadConnectionCheck' Query. Allow users to pass in custom DataConnect instances. */
export function readConnectionCheck(vars: ReadConnectionCheckVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<ReadConnectionCheckData>>;

/** Generated Node Admin SDK operation action function for the 'RemoveConnectionCheck' Mutation. Allow users to execute without passing in DataConnect. */
export function removeConnectionCheck(dc: DataConnect, vars: RemoveConnectionCheckVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<RemoveConnectionCheckData>>;
/** Generated Node Admin SDK operation action function for the 'RemoveConnectionCheck' Mutation. Allow users to pass in custom DataConnect instances. */
export function removeConnectionCheck(vars: RemoveConnectionCheckVariables, options?: OperationOptions): Promise<ExecuteOperationResponse<RemoveConnectionCheckData>>;

