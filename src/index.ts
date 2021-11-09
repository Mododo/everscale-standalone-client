import init, * as nt from 'nekoton-wasm';
import safeStringify from 'fast-safe-stringify';

import ton from 'ton-inpage-provider';

import { convertVersionToInt32, SafeEventEmitter } from './utils';
import {
  createConnectionController,
  DEFAULT_NETWORK_GROUP,
  TonClientConnectionProperties,
  ConnectionController,
} from './connectionController';
import { SubscriptionController } from './subscriptionController';

export { GqlSocketParams } from './gql';
export { TonClientConnectionProperties, ConnectionData } from './connectionController';

let clientInitializationStarted: boolean = false;
let notifyClientInitialized: { resolve: () => void, reject: () => void };
let initializationPromise: Promise<void> = new Promise<void>((resolve, reject) => {
  notifyClientInitialized = { resolve, reject };
});

function ensureNekotonLoaded(): Promise<void> {
  if (!clientInitializationStarted) {
    clientInitializationStarted = true;
    init().then(notifyClientInitialized.resolve).catch(notifyClientInitialized.reject);
  }
  return initializationPromise;
}

/**
 * Standalone provider which is used as a fallback when browser extension is not installed
 *
 * @category Client
 */
export type TonClientProperties = {
  connection: TonClientConnectionProperties
};

/**
 * @category Client
 */
export const DEFAULT_TON_CLIENT_PROPERTIES: TonClientProperties = {
  connection: {
    networkGroup: DEFAULT_NETWORK_GROUP,
    additionalPresets: {},
  },
};

/**
 * @category Client
 */
export const TON_CLIENT_VERSION = '0.2.17';
/**
 * @category Client
 */
export const SUPPORTED_PERMISSIONS: ton.Permission[] = ['tonClient'];

/**
 * @category Client
 */
export class TonStandaloneClient extends SafeEventEmitter implements ton.Provider {
  private _context: Context;
  private _handlers: { [K in ton.ProviderMethod]?: ProviderHandler<K> } = {
    requestPermissions,
    disconnect,
    subscribe,
    unsubscribe,
    unsubscribeAll,
    getProviderState,
    getFullContractState,
    getTransactions,
    runLocal,
    getExpectedAddress,
    getBocHash,
    packIntoCell,
    unpackFromCell,
    extractPublicKey,
    codeToTvc,
    splitTvc,
    encodeInternalInput,
    decodeInput,
    decodeEvent,
    decodeOutput,
    decodeTransaction,
    decodeTransactionEvents,
    verifySignature,
  };

  public static async create(params: TonClientProperties): Promise<TonStandaloneClient> {
    await ensureNekotonLoaded();

    // NOTE: capture client inside notify using wrapper object
    let notificationContext: { client?: WeakRef<TonStandaloneClient> } = {};

    const notify = <T extends ton.ProviderEvent>(method: T, params: ton.RawProviderEventData<T>) => {
      notificationContext.client?.deref()?.emit(method, params);
    };

    const clock = new nt.ClockWithOffset();

    const connectionController = await createConnectionController(clock, params.connection);
    const subscriptionController = new SubscriptionController(connectionController, notify);

    const client = new TonStandaloneClient({
      clock,
      permissions: {},
      connectionController,
      subscriptionController,
      notify,
    });
    notificationContext.client = new WeakRef(client);
    return client;
  }

  private constructor(ctx: Context) {
    super();
    this._context = ctx;
  }

  request<T extends ton.ProviderMethod>(req: ton.RawProviderRequest<T>): Promise<ton.RawProviderApiResponse<T>> {
    const handler = this._handlers[req.method] as any as ProviderHandler<T> | undefined;
    if (handler == null) {
      throw invalidRequest(req, `Method '${req.method}' is not supported by standalone provider`);
    }
    return handler(this._context, req);
  }
}

type Context = {
  clock: nt.ClockWithOffset,
  permissions: Partial<ton.RawPermissions>,
  connectionController: ConnectionController,
  subscriptionController: SubscriptionController,
  notify: <T extends ton.ProviderEvent>(method: T, params: ton.RawProviderEventData<T>) => void
}

type ProviderHandler<T extends ton.ProviderMethod> = (ctx: Context, req: ton.RawProviderRequest<T>) => Promise<ton.RawProviderApiResponse<T>>;

const requestPermissions: ProviderHandler<'requestPermissions'> = async (ctx, req) => {
  requireParams(req);

  const { permissions } = req.params;
  requireArray(req, req.params, 'permissions');

  const newPermissions = { ...ctx.permissions };

  for (const permission of permissions) {
    if (permission === 'tonClient') {
      newPermissions.tonClient = true;
    } else {
      throw invalidRequest(req, `Permission '${permission}' is not supported by standalone provider`);
    }
  }

  ctx.permissions = newPermissions;

  // NOTE: be sure to return object copy to prevent adding new permissions
  ctx.notify('permissionsChanged', {
    permissions: { ...newPermissions },
  });
  return { ...newPermissions };
};

const disconnect: ProviderHandler<'disconnect'> = async (ctx, _req) => {
  ctx.permissions = {};
  await ctx.subscriptionController.unsubscribeFromAllContracts();
  ctx.notify('permissionsChanged', { permissions: {} });
  return undefined;
};

const subscribe: ProviderHandler<'subscribe'> = async (ctx, req) => {
  requireParams(req);

  const { address, subscriptions } = req.params;
  requireString(req, req.params, 'address');
  requireOptionalObject(req, req.params, 'subscriptions');

  if (!nt.checkAddress(address)) {
    throw invalidRequest(req, 'Invalid address');
  }

  try {
    return await ctx.subscriptionController.subscribeToContract(address, subscriptions);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unsubscribe: ProviderHandler<'unsubscribe'> = async (ctx, req) => {
  requireParams(req);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  if (!nt.checkAddress(address)) {
    throw invalidRequest(req, 'Invalid address');
  }

  await ctx.subscriptionController.unsubscribeFromContract(address);
  return undefined;
};

const unsubscribeAll: ProviderHandler<'unsubscribeAll'> = async (ctx, _req) => {
  await ctx.subscriptionController.unsubscribeFromAllContracts();
  return undefined;
};

const getProviderState: ProviderHandler<'getProviderState'> = async (ctx, req) => {
  const selectedConnection = ctx.connectionController.currentConnectionGroup;
  if (selectedConnection == null) {
    throw invalidRequest(req, 'Connection controller was not initialized');
  }

  const version = TON_CLIENT_VERSION;

  return {
    version,
    numericVersion: convertVersionToInt32(version),
    selectedConnection,
    supportedPermissions: [...SUPPORTED_PERMISSIONS],
    permissions: { ...ctx.permissions },
    subscriptions: ctx.subscriptionController.subscriptionStates,
  };
};

const getFullContractState: ProviderHandler<'getFullContractState'> = async (ctx, req) => {
  requireParams(req);

  const { address } = req.params;
  requireString(req, req.params, 'address');

  const { connectionController } = ctx;

  try {
    return connectionController.use(async ({ data: { transport } }) => ({
      state: await transport.getFullContractState(address),
    }));
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getTransactions: ProviderHandler<'getTransactions'> = async (ctx, req) => {
  requireParams(req);

  const { address, continuation, limit } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'continuation', requireTransactionId);
  requireOptionalNumber(req, req.params, 'limit');

  const { connectionController } = ctx;

  try {
    return connectionController.use(async ({ data: { transport } }) =>
      transport.getTransactions(address, continuation, limit || 50));
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const runLocal: ProviderHandler<'runLocal'> = async (ctx, req) => {
  requireParams(req);

  const { address, cachedState, functionCall } = req.params;
  requireString(req, req.params, 'address');
  requireOptional(req, req.params, 'cachedState', requireContractState);
  requireFunctionCall(req, req.params, 'functionCall');

  const { clock, connectionController } = ctx;

  let contractState = cachedState;
  if (contractState == null) {
    contractState = await connectionController.use(async ({ data: { transport } }) =>
      transport.getFullContractState(address));
  }

  if (contractState == null) {
    throw invalidRequest(req, 'Account not found');
  }
  if (!contractState.isDeployed || contractState.lastTransactionId == null) {
    throw invalidRequest(req, 'Account is not deployed');
  }

  try {
    const { output, code } = nt.runLocal(
      clock,
      contractState.lastTransactionId,
      contractState.boc,
      functionCall.abi,
      functionCall.method,
      functionCall.params,
    );
    return { output, code };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getExpectedAddress: ProviderHandler<'getExpectedAddress'> = async (_ctx, req) => {
  requireParams(req);

  const { tvc, abi, workchain, publicKey, initParams } = req.params;
  requireString(req, req.params, 'tvc');
  requireString(req, req.params, 'abi');
  requireOptionalNumber(req, req.params, 'workchain');
  requireOptionalString(req, req.params, 'publicKey');

  try {
    return { address: nt.getExpectedAddress(tvc, abi, workchain || 0, publicKey, initParams) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const getBocHash: ProviderHandler<'getBocHash'> = async (_ctx, req) => {
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    return { hash: nt.getBocHash(boc) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const packIntoCell: ProviderHandler<'packIntoCell'> = async (_ctx, req) => {
  requireParams(req);

  const { structure, data } = req.params;
  requireArray(req, req.params, 'structure');

  try {
    return { boc: nt.packIntoCell(structure as nt.AbiParam[], data) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const unpackFromCell: ProviderHandler<'unpackFromCell'> = async (_ctx, req) => {
  requireParams(req);

  const { structure, boc, allowPartial } = req.params;
  requireArray(req, req.params, 'structure');
  requireString(req, req.params, 'boc');
  requireBoolean(req, req.params, 'allowPartial');

  try {
    return { data: nt.unpackFromCell(structure as nt.AbiParam[], boc, allowPartial) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const extractPublicKey: ProviderHandler<'extractPublicKey'> = async (_ctx, req) => {
  requireParams(req);

  const { boc } = req.params;
  requireString(req, req.params, 'boc');

  try {
    return { publicKey: nt.extractPublicKey(boc) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const codeToTvc: ProviderHandler<'codeToTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { code } = req.params;
  requireString(req, req.params, 'code');

  try {
    return { tvc: nt.codeToTvc(code) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const splitTvc: ProviderHandler<'splitTvc'> = async (_ctx, req) => {
  requireParams(req);

  const { tvc } = req.params;
  requireString(req, req.params, 'tvc');

  try {
    return nt.splitTvc(tvc);
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const encodeInternalInput: ProviderHandler<'encodeInternalInput'> = async (_ctx, req) => {
  requireParams(req);

  requireFunctionCall(req, req, 'params');
  const { abi, method, params } = req.params;

  try {
    return { boc: nt.encodeInternalInput(abi, method, params) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeInput: ProviderHandler<'decodeInput'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, method, internal } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');
  requireBoolean(req, req.params, 'internal');

  try {
    return nt.decodeInput(body, abi, method, internal) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeEvent: ProviderHandler<'decodeEvent'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, event } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'event');

  try {
    return nt.decodeEvent(body, abi, event) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeOutput: ProviderHandler<'decodeOutput'> = async (_ctx, req) => {
  requireParams(req);

  const { body, abi, method } = req.params;
  requireString(req, req.params, 'body');
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    return nt.decodeOutput(body, abi, method) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransaction: ProviderHandler<'decodeTransaction'> = async (_ctx, req) => {
  requireParams(req);

  const { transaction, abi, method } = req.params;
  requireString(req, req.params, 'abi');
  requireMethodOrArray(req, req.params, 'method');

  try {
    return nt.decodeTransaction(transaction, abi, method) || null;
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const decodeTransactionEvents: ProviderHandler<'decodeTransactionEvents'> = async (_ctx, req) => {
  requireParams(req);

  const { transaction, abi } = req.params;
  requireString(req, req.params, 'abi');

  try {
    return { events: nt.decodeTransactionEvents(transaction, abi) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};

const verifySignature: ProviderHandler<'verifySignature'> = async (_ctx, req) => {
  requireParams(req);

  const { publicKey, dataHash, signature } = req.params;
  requireString(req, req.params, 'publicKey');
  requireString(req, req.params, 'dataHash');
  requireString(req, req.params, 'signature');

  try {
    return { isValid: nt.verifySignature(publicKey, dataHash, signature) };
  } catch (e: any) {
    throw invalidRequest(req, e.toString());
  }
};


function requireParams<T extends ton.ProviderMethod>(req: any): asserts req is ton.RawProviderRequest<T> {
  if (req.params == null || typeof req.params !== 'object') {
    throw invalidRequest(req, 'required params object');
  }
}

function requireObject<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'object') {
    throw invalidRequest(req, `'${key}' must be an object`);
  }
}

function requireOptionalObject<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && typeof property !== 'object') {
    throw invalidRequest(req, `'${key}' must be an object if specified`);
  }
}

function requireBoolean<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'boolean') {
    throw invalidRequest(req, `'${key}' must be a boolean`);
  }
}

function requireString<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'string' || property.length === 0) {
    throw invalidRequest(req, `'${key}' must be non-empty string`);
  }
}

function requireOptionalString<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && (typeof property !== 'string' || property.length === 0)) {
    throw invalidRequest(req, `'${key}' must be a non-empty string if provided`);
  }
}

function requireOptionalNumber<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (property != null && typeof property !== 'number') {
    throw invalidRequest(req, `'${key}' must be a number if provider`);
  }
}

function requireArray<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (!Array.isArray(property)) {
    throw invalidRequest(req, `'${key}' must be an array`);
  }
}

function requireOptional<O, P extends keyof O>(
  req: ton.RawProviderRequest<ton.ProviderMethod>,
  object: O,
  key: P,
  predicate: (req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) => void,
) {
  const property = object[key];
  if (property != null) {
    predicate(req, object, key);
  }
}

function requireTransactionId<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as nt.TransactionId;
  requireString(req, property, 'lt');
  requireString(req, property, 'hash');
}

function requireLastTransactionId<O, P extends keyof O>(
  req: ton.RawProviderRequest<ton.ProviderMethod>,
  object: O,
  key: P,
) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as nt.LastTransactionId;
  requireBoolean(req, property, 'isExact');
  requireString(req, property, 'lt');
  requireOptionalString(req, property, 'hash');
}

function requireContractState<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as ton.FullContractState;
  requireString(req, property, 'balance');
  requireOptional(req, property, 'lastTransactionId', requireLastTransactionId);
  requireBoolean(req, property, 'isDeployed');
}

function requireFunctionCall<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  requireObject(req, object, key);
  const property = (object[key] as unknown) as ton.RawFunctionCall;
  requireString(req, property, 'abi');
  requireString(req, property, 'method');
  requireObject(req, property, 'params');
}

function requireMethodOrArray<O, P extends keyof O>(req: ton.RawProviderRequest<ton.ProviderMethod>, object: O, key: P) {
  const property = object[key];
  if (typeof property !== 'string' && !Array.isArray(property)) {
    throw invalidRequest(req, `'${key}' must be a method name or an array of possible names`);
  }
}

const invalidRequest = (req: ton.RawProviderRequest<ton.ProviderMethod>, message: string, data?: unknown) =>
  new NekotonRpcError(2, `${req.method}: ${message}`, data);

class NekotonRpcError<T> extends Error {
  code: number;
  data?: T;

  constructor(code: number, message: string, data?: T) {
    if (!Number.isInteger(code)) {
      throw new Error('"code" must be an integer');
    }

    if (!message || (typeof message as any) !== 'string') {
      throw new Error('"message" must be a nonempty string');
    }

    super(message);

    this.code = code;
    this.data = data;
  }

  serialize(): JsonRpcError {
    const serialized: JsonRpcError = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      serialized.data = this.data;
    }
    if (this.stack) {
      serialized.stack = this.stack;
    }
    return serialized;
  }

  toString(): string {
    return safeStringify(this.serialize(), stringifyReplacer, 2);
  }
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
  stack?: string;
}

const stringifyReplacer = (_: unknown, value: unknown): unknown => {
  if (value === '[Circular]') {
    return undefined;
  }
  return value;
};
