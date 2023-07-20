import z from 'zod';

import JsonRpcError from './JsonRpcError';
import assert from './helpers/assert';
import randomId from './helpers/randomId';
import { WaxStorage } from './WaxStorage';

const emptyParams = z.union([z.tuple([]), z.undefined()]);

const schema = {
  eth_requestAccounts: {
    params: emptyParams,
    output: z.array(z.string()).min(1),
  },
  eth_accounts: {
    params: emptyParams,
    output: z.array(z.string()),
  },
};

type Schema = typeof schema;

type RequestParams<M extends string> = M extends keyof Schema
  ? undefined extends z.infer<Schema[M]['params']>
    ? { params?: z.infer<Schema[M]['params']> }
    : { params: z.infer<Schema[M]['params']> }
  : { params?: unknown[] };

type Response<M extends string> = M extends keyof Schema
  ? z.infer<Schema[M]['output']>
  : unknown;

type SchemaHandlers = {
  [M in keyof Schema]: (
    ...params: Exclude<z.infer<Schema[M]['params']>, undefined>
  ) => Promise<Response<M>>;
};

export default class EthereumApi {
  #storage: WaxStorage;

  #networkUrl = 'http://127.0.0.1:8545';
  #testAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  #requestPermission: (message: string) => Promise<boolean>;

  constructor(
    requestPermission: (message: string) => Promise<boolean>,
    storage: WaxStorage,
  ) {
    this.#requestPermission = requestPermission;
    this.#storage = storage;
  }

  async request<M extends string>({
    method,
    params,
  }: {
    method: M;
  } & RequestParams<M>): Promise<Response<M>> {
    if (!(method in schema)) {
      return (await this.#requestImpl({ method, params })) as Response<M>;
    }

    const methodSchema = schema[method as keyof Schema];

    const parsedParams = methodSchema.params.parse(params);
    const response = await this.#requestImpl({ method, params: parsedParams });

    const parsedResponse = methodSchema.output.parse(response);
    return parsedResponse as Response<M>;
  }

  async #requestImpl({
    method,
    params,
  }: {
    method: string;
    params?: unknown[];
  }): Promise<unknown> {
    if (method in this.#customHandlers) {
      // eslint-disable-next-line
      return await (this.#customHandlers as any)[method](...(params ?? []));
    }

    return await this.#networkRequest({ method, params });
  }

  #customHandlers: Partial<SchemaHandlers> = {
    eth_requestAccounts: async () => {
      let connectedAccounts = await this.#storage.connectedAccounts.get();

      if (connectedAccounts.length > 0) {
        return connectedAccounts;
      }

      const granted = await this.#requestPermission(
        'Allow this page to see your account address?',
      );

      if (!granted) {
        throw new JsonRpcError({
          code: 4001,
          message: 'User rejected request',
        });
      }

      connectedAccounts = [this.#testAddress];

      await this.#storage.connectedAccounts.set(connectedAccounts);

      return connectedAccounts;
    },

    eth_accounts: async () => await this.#storage.connectedAccounts.get(),
  };

  async #networkRequest({
    method,
    params = [],
  }: {
    method: string;
    params?: unknown[];
  }) {
    const res = await fetch(this.#networkUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method,
        params,
        id: randomId(),
      }),
    });

    const json = z
      .union([
        z.object({ result: z.unknown() }),
        z.object({ error: z.unknown() }),
      ])
      .parse(await res.json());

    if ('result' in json) {
      return json.result;
    }

    assert('error' in json);
    throw JsonRpcError.parse(json.error);
  }
}
